// executions: 执行列表/详情/停止/恢复（n8n REST）
//
// 契约要点（对齐 editor-ui 实际读取路径）：
//  列表 GET /rest/executions → { data: { count, finished, running, results: [...] } }
//  详情 GET /rest/executions/:id → { data: { ..., workflowData, data: { resultData: { runData, lastNodeExecuted, error } } } }
//  其中 runData[nodeName] 为 ITaskData 数组，data.main / source.main 必须是
//  「数组的数组」（OutgoingConnections），否则 NDV / 表达式编辑器取不到数据。
import { Hono } from 'hono';
import type { Env } from '../types';
import { withRetry } from '../engine/retry';
import { parseWorkflowRow, type ExecutionRow, type NodeExecutionRow, type WorkflowRow } from '../db/schema';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// 安全整数解析：非法/越界输入一律回落到默认值或边界值。
// 历史缺陷：Number('abc') → NaN 直接进入 SQL `LIMIT ?`，D1 报错 → 整个端点 500。
function safeInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// n8n 状态语义 → 本库存储状态
const N8N_TO_DB_STATUS: Record<string, string[]> = {
  success: ['completed'],
  error: ['failed'],
  crashed: ['failed'],
  waiting: ['paused'],
  running: ['running'],
  queued: ['pending'],
  new: ['pending'],
  unknown: ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'],
  canceled: ['cancelled'],
  cancelled: ['cancelled'],
};

interface ExecListFilter {
  workflowId?: string;
  projectId?: string;
  statuses?: string[];
}

// 解析列表筛选：n8n 前端用 `filter`（JSON 字符串）；同时兼容扁平查询参数。
// 非法 JSON 一律忽略（不报错），避免破坏列表页。
function parseListFilter(q: Record<string, string | undefined>): ExecListFilter {
  const f: ExecListFilter = {};
  if (q.workflowId) f.workflowId = q.workflowId;
  if (q.projectId) f.projectId = q.projectId;
  if (q.filter) {
    try {
      const parsed = JSON.parse(q.filter) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.workflowId === 'string') f.workflowId = parsed.workflowId;
        if (typeof parsed.projectId === 'string') f.projectId = parsed.projectId;
        if (Array.isArray(parsed.status)) f.statuses = parsed.status.map(String);
      }
    } catch { /* 忽略非法 filter */ }
  }
  if (q.status) f.statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean);
  return f;
}

// 未识别的状态值 → 空数组，语义为「命中不了任何记录」（而非「不过滤」）
function dbStatusesFor(n8nStatuses?: string[]): string[] | undefined {
  if (!n8nStatuses || n8nStatuses.length === 0) return undefined;
  const out = new Set<string>();
  for (const s of n8nStatuses) for (const d of N8N_TO_DB_STATUS[s] ?? []) out.add(d);
  return [...out];
}

// SQLite datetime('now') 产出 'YYYY-MM-DD HH:MM:SS'（UTC）；转成 epoch ms
function sqlTimeToMs(s: string | null | undefined): number {
  if (!s) return 0;
  const iso = s.includes('T') ? s : `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function safeJson<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

type Item = { json: Record<string, unknown> };

// 把节点输出归一化为 n8n 的 connections 形态：Array<分支> each Array<item>
//  - IF：按 branch 落到 main[0] / main[1]
//  - 其余：单一分支 main[0]
function toConnections(raw: unknown): Item[][] {
  if (!raw || typeof raw !== 'object') return [[]];
  const o = raw as Record<string, unknown>;
  const main = Array.isArray(o.main) ? (o.main as Item[]) : [];
  if ('branch' in o) return o.branch === true ? [main, []] : [[], main];
  // 多分支节点：main_N 键
  const keys = Object.keys(o).filter((k) => /^main_\d+$/.test(k));
  if (keys.length) {
    const maxIdx = Math.max(...keys.map((k) => Number(k.slice(5))));
    const branches: Item[][] = Array.from({ length: maxIdx + 1 }, () => []);
    for (const k of keys) {
      const idx = Number(k.slice(5));
      const arr = o[k];
      if (Array.isArray(arr)) branches[idx] = arr as Item[];
    }
    return branches;
  }
  return [main];
}

export const executionRoutes = new Hono<{ Bindings: Env }>()
  // DEBUG: 仅本地诊断 —— 返回原始执行行 + 节点执行日志
  .get('/_debug/:id/raw', async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT * FROM executions WHERE id=?').bind(id).first<ExecutionRow>().catch(() => null);
    const logs = await c.env.DB.prepare('SELECT node_name, node_type, status, retry_attempt, error_message, output_data, started_at, finished_at FROM node_executions WHERE execution_id=?').bind(id).all().catch(() => ({ results: [] }));
    return c.json({ data: { row, nodeLogs: logs.results } });
  })
  // POST /rest/executions/:id/stop —— 停止运行中的执行（前端 Execute 界面 Stop 按钮）
  .post('/:id/stop', async (c) => {
    const id = c.req.param('id');
    const r = await withRetry(() => c.env.DB.prepare('SELECT * FROM executions WHERE id=?').bind(id).first<ExecutionRow>());
    if (!r) return c.json({ code: 404, message: 'Execution not found', data: undefined }, 404);
    // 仅 running/pending 可停止
    if (r.status !== 'running' && r.status !== 'pending') {
      return c.json({ data: { id, stopped: false, status: rst(r.status) } });
    }
    await withRetry(() => c.env.DB.prepare(
      "UPDATE executions SET status='cancelled', finished_at=datetime('now'), error_message=? WHERE id=?",
    ).bind('Execution stopped by user', id).run());
    return c.json({ data: { id, stopped: true, status: 'cancelled' } });
  })
  // GET /rest/executions —— 列表（支持 limit/offset/filter/status/workflowId，非法参数不 500）
  .get('/', async (c) => {
    const q = c.req.query();
    const limit = safeInt(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = safeInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const filter = parseListFilter(q);
    const dbStatuses = dbStatusesFor(filter.statuses);

    const where: string[] = [];
    const binds: (string | number)[] = [];
    if (filter.workflowId) { where.push('workflow_id=?'); binds.push(filter.workflowId); }
    if (filter.projectId) { where.push("workflow_id IN (SELECT id FROM workflows WHERE project_id=?)"); binds.push(filter.projectId); }
    if (dbStatuses) {
      if (dbStatuses.length === 0) where.push('0'); // 未识别状态 → 命中空集
      else { where.push(`status IN (${dbStatuses.map(() => '?').join(',')})`); binds.push(...dbStatuses); }
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    // count/finished/running 针对「整个筛选集」，而非当前页（n8n 的语义）
    const agg = await withRetry(() => c.env.DB.prepare(
      `SELECT COUNT(*) AS c, SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS f FROM executions${whereSql}`,
    ).bind(...binds).first<{ c: number; f: number | null }>());
    const total = agg?.c ?? 0;
    const finished = agg?.f ?? 0;

    const qRes = await withRetry(() => c.env.DB.prepare(
      `SELECT * FROM executions${whereSql} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all<ExecutionRow>());

    // 一次性取本页涉及的工作流名，避免 N+1
    const wfIds = [...new Set(qRes.results.map((r) => r.workflow_id))];
    const nameById = new Map<string, string>();
    if (wfIds.length) {
      const placeholders = wfIds.map(() => '?').join(',');
      const wres = await c.env.DB.prepare(`SELECT id, name FROM workflows WHERE id IN (${placeholders})`)
        .bind(...wfIds).all<{ id: string; name: string }>();
      for (const w of wres.results ?? []) nameById.set(w.id, w.name);
    }

    const data = qRes.results.map((r) => ({
      id: r.id,
      workflowId: r.workflow_id,
      workflowName: nameById.get(r.workflow_id) ?? r.workflow_id,
      status: rst(r.status),
      mode: r.mode ?? 'manual',
      finished: !!r.finished_at,
      startedAt: r.started_at,
      stoppedAt: r.finished_at,
      retryCount: r.retry_count,
      retryOf: null,
      retrySuccessId: null,
      waitTill: null,
      deletedAt: null,
    }));

    return c.json({ data: { count: total, finished, running: total - finished, results: data } });
  })
  // GET /rest/executions/:id —— 详情（含 workflowData + resultData.runData）
  .get('/:id', async (c) => {
    const r = await withRetry(() => c.env.DB.prepare('SELECT * FROM executions WHERE id=?').bind(c.req.param('id')).first<ExecutionRow>());
    if (!r) return c.json({ code: 404, message: 'Execution not found', data: undefined }, 404);
    const wfRow = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(r.workflow_id).first<WorkflowRow>();
    const logs = await c.env.DB.prepare(
      'SELECT node_name, node_type, status, retry_attempt, input_data, output_data, error_message, started_at, finished_at '
      + 'FROM node_executions WHERE execution_id=? ORDER BY rowid ASC',
    ).bind(r.id).all<NodeExecutionRow>();

    return c.json({ data: executionDetail(r, wfRow ?? null, logs.results ?? []) });
  })
  // POST /rest/executions/:id/resume —— 从检查点恢复一个 paused 的执行
  .post('/:id/resume', async (c) => {
    const id = c.req.param('id');
    const r = await withRetry(() => c.env.DB.prepare('SELECT * FROM executions WHERE id=?').bind(id).first<ExecutionRow>());
    if (!r) return c.json({ code: 404, message: 'Execution not found', data: undefined }, 404);
    if (r.status !== 'paused') {
      return c.json({ code: 409, message: `execution is ${r.status}, only paused can be resumed`, data: undefined }, 409);
    }
    const wf = await withRetry(() => c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(r.workflow_id).first<WorkflowRow>());
    if (!wf) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
    const workflow = parseWorkflowRow(wf);

    // 从检查点抽取已完成节点 + 中间数据，作为续跑输入
    let completedNodes: string[] = [];
    let data: Record<string, unknown> = {};
    const cp = safeJson<{ completedNodes?: string[]; data?: Record<string, unknown> }>(r.checkpoint);
    if (cp) {
      completedNodes = cp.completedNodes ?? [];
      data = cp.data ?? {};
    }

    // 复用原 execution id 重新提交 Workflows（原实例已终态，同 id 幂等）
    // completedData 必须回填：否则已跳过节点的下游拿不到活跃入边，续跑会在断点处静默停止。
    void c.env.FLOW_ENGINE.create({
      id,
      params: {
        workflowId: workflow.id as string,
        workflowName: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
        executionId: id,
        mode: r.mode ?? 'manual',
        input: data,
        completedNodes,
        completedData: data,
      },
    });
    await withRetry(() => c.env.DB.prepare("UPDATE executions SET status='running' WHERE id=?").bind(id).run());
    return c.json({ data: { executionId: id, status: 'running', resumed: true } });
  });

function rst(s: ExecutionRow['status']): string {
  // n8n 状态语义
  const map: Record<string, string> = { pending: 'queued', running: 'running', paused: 'waiting', completed: 'success', failed: 'error', cancelled: 'cancelled' };
  return map[s] ?? s;
}

// 构造 n8n 兼容的执行详情。
// runData：按节点聚合 node_executions（同名节点取最后一条为最终状态），
// 使 NDV「输出/输入」面板、表达式编辑器 $input / $(node) 都能取到数据。
function executionDetail(r: ExecutionRow, wfRow: WorkflowRow | null, logs: NodeExecutionRow[]) {
  const lastByNode = new Map<string, NodeExecutionRow>();
  for (const row of logs) lastByNode.set(row.node_name, row);

  const runData: Record<string, unknown[]> = {};
  for (const [nodeName, row] of lastByNode) {
    const output = safeJson(row.output_data);
    const input = safeJson(row.input_data);
    const startTime = sqlTimeToMs(row.started_at);
    const endTime = sqlTimeToMs(row.finished_at) || startTime;
    runData[nodeName] = [{
      startTime,
      executionTime: Math.max(0, endTime - startTime),
      source: { main: toConnections(input) },
      data: { main: toConnections(output) },
      ...(row.error_message ? { error: { message: row.error_message, name: 'NodeOperationError' } } : {}),
    }];
  }

  let workflowData: unknown = undefined;
  if (wfRow) {
    try {
      const wf = parseWorkflowRow(wfRow);
      workflowData = { id: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {}, active: !!wf.active };
    } catch { workflowData = undefined; }
  }

  const lastNodeExecuted = [...lastByNode.keys()].pop();
  const error = r.error_message ? { message: r.error_message, name: 'ExecutionError' } : undefined;

  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: wfRow?.name ?? r.workflow_id,
    status: rst(r.status),
    mode: r.mode ?? 'manual',
    startedAt: r.started_at,
    stoppedAt: r.finished_at,
    finished: !!r.finished_at,
    retryOf: null,
    retrySuccessId: null,
    waitTill: null,
    workflowData,
    data: {
      startData: {},
      resultData: {
        runData,
        lastNodeExecuted: lastNodeExecuted ?? null,
        ...(error ? { error } : {}),
      },
      pinData: {},
      executionData: r.status === 'completed' || r.status === 'failed' ? { contextData: {}, nodeExecutionStack: [], waitingForExecution: {}, metadata: {} } : undefined,
    },
    // 保留旧的扁平字段，兼容既有调用方
    outputData: r.status === 'completed' ? safeJson(r.output_data) : undefined,
    error: r.error_message ? { message: r.error_message } : undefined,
    retryCount: r.retry_count,
  };
}
