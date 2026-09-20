// flow-engine: extends WorkflowEntrypoint —— 断点续跑执行底座
// 把 n8n workflow（nodes + connections）编译为 DAG，逐节点经 step.do 执行，
// 获得持久化 + 自动重试 + 平台级中断恢复。
// 严格对齐设计 5 条底线：写检查点 → 重试包装 → 重试耗尽进 DLQ → 锁 → 先写后执行。
//
// 拓扑与分支路由语义已抽离到 engine/route.ts（纯函数、可独立单测）；
// 本文件只负责「平台侧」职责：payload 归一化、step.do 包装、Push 投递、DLQ、状态落库、锁释放。
import { WorkflowEntrypoint, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import type { Env, PushEvent, RunExecutionResult, NodeExecutor, N8nNode } from '../types';
import { resolveExecutor } from '../nodes';
import { withRetry } from '../engine/retry';
import * as checkpoint from '../engine/checkpoint';
import { enqueueDeadLetter } from '../engine/dead-letter';
import { compileWorkflow } from '../engine/dag';
import { executeGraph, type Item, type NodeOutput } from '../engine/route';
import { sendPush } from '../n8n/push';

export interface FlowPayload {
  workflowId: string;
  workflowName: string;
  nodes: N8nNode[];
  connections: any;
  executionId: string;
  mode: string;
  input: unknown;
  completedNodes: string[];
  // 断点续跑：已完成节点的历史输出（回填给下游，否则续跑链路会断）
  completedData?: Record<string, NodeOutput>;
}

export class FlowEngine extends WorkflowEntrypoint<Env, FlowPayload> {
  async run(event: WorkflowEvent<FlowPayload>, step: WorkflowStep) {
    // 归一化 event.payload：兼容三种触发形态
    //  A) 内部绑定 FLOW_ENGINE.create({ params }) —— payload 即 params 对象（平铺）
    //  B) REST API create 带 params(JSON 字符串) —— payload={params:'...'}（需解码）
    //  C) REST API 带 input —— payload={input:{...}}
    const env = this.env;
    const raw = (event as unknown as { payload?: any }).payload ?? {};
    let decoded: any = null;
    if (typeof raw.params === 'string') {
      try { decoded = JSON.parse(raw.params); } catch { /* keep null */ }
    } else if (raw.params && typeof raw.params === 'object') {
      decoded = raw.params;
    }
    if (!decoded && raw.input && typeof raw.input === 'object') {
      decoded = raw.input;
    }
    const base = decoded ?? raw;
    const p: FlowPayload = {
      workflowId: base.workflowId ?? raw.workflowId ?? 'unknown',
      workflowName: base.workflowName ?? raw.workflowName ?? 'unknown',
      nodes: base.nodes ?? raw.nodes ?? [],
      connections: base.connections ?? raw.connections ?? {},
      executionId: base.executionId ?? raw.executionId ?? 'exec-' + crypto.randomUUID(),
      mode: base.mode ?? raw.mode ?? 'manual',
      input: base.input ?? raw.input ?? {},
      completedNodes: base.completedNodes ?? raw.completedNodes ?? [],
      completedData: base.completedData ?? raw.completedData ?? undefined,
    };

    // emit: 把 push 事件可靠投递到 DO。Workflows 环境中 fire-and-forget 的异步
    // fetch 可能在 isolate 被回收前未完成而丢失，故收集所有待发 promise，
    // 在 run 的 finally 中统一 await（sendPush 自身带 try/catch，不影响主流程）。
    const flush: Promise<void>[] = [];
    const emit: (e: PushEvent) => void = (e) => { flush.push(sendPush(env, e)); };

    emit({ type: 'executionStarted', executionId: p.executionId });

    const graph = compileWorkflow({ name: p.workflowName, nodes: p.nodes, connections: p.connections });
    // 节点名 → 输出（写检查点用）
    const nodeResults = new Map<string, NodeOutput>();

    // 底线2+3: 用 withRetry 包裹节点执行，并在 step.do 内完成全部重试。
    // 关键（P1-4 修复）：节点失败绝不能从 step.do 逃逸抛异常 —— 否则 Cloudflare Workflows
    // 会对该 step 自动无限重放，导致 failed 日志无限累积、执行永久卡在 running。
    // 故把"重试耗尽后的失败"编码为 step.do 的返回值，由 executeGraph 统一标记终态并终止。
    const runNode = async (node: N8nNode, inputData: { main: Item[] }): Promise<{ ok: boolean; output?: NodeOutput; error?: string }> => {
      const executor = resolveExecutor(node.type);
      if (!executor) {
        return { ok: false, error: `未实现节点类型: ${node.type}` };
      }
      return step.do(`exec:${node.name}`, async () => {
        try {
          const output = await withRetry(
            () => this.runNode(node, executor, inputData, env, p, emit),
            { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 },
            (att, err) => {
              void checkpoint.logNodeExecution(env, {
                executionId: p.executionId, nodeName: node.name, nodeType: node.type,
                status: 'failed', retryAttempt: att,
                errorMessage: err instanceof Error ? err.message : String(err),
              });
              emit({ type: 'nodeExecuteBefore', executionId: p.executionId, nodeName: node.name });
            },
          );
          return { ok: true, output } as const;
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) } as const;
        }
      });
    };

    try {
      const outcome = await executeGraph({
        graph,
        initialInput: p.input ?? {},
        completedNodes: p.completedNodes ?? [],
        seedResults: p.completedData,
        runNode,
        onNodeStart: async (node) => {
          emit({ type: 'nodeExecuteBefore', executionId: p.executionId, nodeName: node.name });
        },
        // 底线1+5: 执行前记录 currentNode、成功后写 completedNodes + 中间数据（先写后执行）
        onCheckpoint: async (completedNodes, currentNode) => {
          await checkpoint.writeCheckpoint(env, p.executionId, {
            workflowId: p.workflowId, executionId: p.executionId,
            completedNodes, currentNode,
            data: Object.fromEntries(nodeResults) as any,
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
        },
        onNodeSuccess: async (node, output, inputData, completedNodes) => {
          nodeResults.set(node.name, output);
          await checkpoint.logNodeExecution(env, {
            executionId: p.executionId, nodeName: node.name, nodeType: node.type,
            status: 'completed', inputData, outputData: output,
          }).catch(() => {});
          emit({ type: 'nodeExecuteAfter', executionId: p.executionId, nodeName: node.name });
        },
        // 底线3: 重试耗尽 → 投入死信队列 → failed（并已写检查点）。
        // P1-4: 节点抛错必须显式暴露 —— 推节点级 error（前端标红）+ 执行终态标 failed(error)，
        // 而不再把执行吞成 paused/静态 success。检查点保留，供死信补偿续跑。
        onNodeFailure: async (node, error) => {
          await enqueueDeadLetter(env, {
            executionId: p.executionId, workflowId: p.workflowId,
            nodeName: node.name, nodeType: node.type, nodeParameters: node.parameters,
            lastInputData: nodeResults.get(node.name) ?? p.input, lastError: error,
          });
          await checkpoint.markFailed(env, p.executionId, `节点 ${node.name} 失败: ${error}`);
          await checkpoint.logNodeExecution(env, {
            executionId: p.executionId, nodeName: node.name, nodeType: node.type,
            status: 'failed', errorMessage: error,
          }).catch(() => {});
          emit({ type: 'nodeExecuteError', executionId: p.executionId, nodeName: node.name, error });
          emit({ type: 'executionFailed', executionId: p.executionId, error });
        },
      });

      if (!outcome.ok) {
        return {
          executionId: p.executionId, data: {}, lastNodeExecuted: outcome.failedNode,
          error: { message: outcome.error ?? 'unknown error' },
        };
      }

      // 全部完成
      const allOutput = Object.fromEntries(nodeResults) as any;
      await checkpoint.markCompleted(env, p.executionId, { name: p.workflowName } as any, allOutput).catch(() => {});
      const result: RunExecutionResult = {
        executionId: p.executionId, data: allOutput, lastNodeExecuted: outcome.lastExecuted,
      };
      emit({ type: 'executionFinished', executionId: p.executionId, data: result });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await checkpoint.markFailed(env, p.executionId, msg).catch(() => {});
      emit({ type: 'executionFailed', executionId: p.executionId, error: msg });
      return { executionId: p.executionId, data: {}, lastNodeExecuted: undefined, error: { message: msg } };
    } finally {
      // 释放锁（正常/失败都释放）
      await this.release(env, p.executionId).catch(() => {});
      // 可靠投递所有已 emit 的 push 事件（Workflows 中避免异步丢失）
      await Promise.all(flush).catch(() => {});
    }
  }

  private async runNode(
    node: N8nNode,
    executor: NonNullable<NodeExecutor>,
    inputData: { main: Item[] },
    env: Env,
    p: FlowPayload,
    emit: (e: PushEvent) => void,
  ): Promise<NodeOutput> {
    const out = await executor.execute({
      workflow: { name: p.workflowName, nodes: p.nodes, connections: p.connections } as any,
      executionId: p.executionId,
      node,
      inputData: inputData as any,
      env,
      log: emit,
    });
    return out && out.main ? (out as NodeOutput) : { main: [{ json: { __result: out } as any }] };
  }

  private async release(env: Env, executionId: string): Promise<void> {
    await env.DB.prepare('UPDATE executions SET locked_at=NULL WHERE id=?').bind(executionId).run();
  }
}
