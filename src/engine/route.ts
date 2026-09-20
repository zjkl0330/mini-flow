// engine/route: 执行图路由 —— 纯函数、无平台依赖
// 目的：把「按 DAG 拓扑决定每个节点是否执行 / 输入是什么 / 结果流向哪个分支」这套语义
// 从 runtime/flow-engine（依赖 cloudflare:workers 的 WorkflowEntrypoint）中抽离为纯函数，
// 使执行语义可在普通 Node 环境下被确定性测试覆盖（不依赖 workerd / Cloudflare Workflows）。
//
// 语义要点（与 n8n 对齐，且为既往缺陷修复的固化点）：
//  1. 仅执行「从入口节点可达」的节点：断开/孤立的子图不执行。
//  2. 非入口节点必须拿到「活跃分支」的实际 items 才执行；分支未命中 → 跳过（不执行）。
//  3. IF 输出 branch=true → 走 main[0]；branch=false → 走 main[1]；只登记命中分支。
//  4. Switch 等多分支节点用 main_N 键声明命中分支；普通节点用 main → index 0。
import type { N8nNode } from '../types';
import type { DagGraph } from './dag';

export type Item = { json: any };
export type NodeOutput = { main?: Item[]; branch?: boolean; [key: string]: any };
export type BranchOutputs = Map<number, Item[]>;

// 从入口可达的节点集合（仅按图连通性，不考虑分支活跃性）
export function computeReachable(graph: Pick<DagGraph, 'edges' | 'entry'>): Set<string> {
  const reach = new Set<string>();
  const entry = graph.entry?.name;
  if (!entry) return reach;
  const queue = [entry];
  reach.add(entry);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of graph.edges.get(cur) ?? []) {
      if (!reach.has(e.to)) {
        reach.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return reach;
}

// 把一个节点的执行结果归一化为「输出分支 → items」。
//  IF ：branch=true→index 0，branch=false→index 1
//  Switch/多分支：按 main_N 键取活跃分支（index = N）
//  单输出节点：非空 main → index 0
export function branchOutputs(_nodeType: string, out: unknown): BranchOutputs {
  const map: BranchOutputs = new Map();
  if (!out || typeof out !== 'object') return map;
  const o = out as Record<string, any>;
  // IF：用 branch 布尔决定 0/1
  if ('branch' in o) {
    const idx = o.branch === true ? 0 : o.branch === false ? 1 : -1;
    if (idx >= 0 && Array.isArray(o.main) && o.main.length) map.set(idx, o.main as Item[]);
    return map;
  }
  // Switch / 多分支：main_N 键为命中分支
  let hasExplicit = false;
  for (const k of Object.keys(o)) {
    const m = /^main_(\d+)$/.exec(k);
    if (m && Array.isArray(o[k]) && o[k].length) {
      map.set(Number(m[1]), o[k] as Item[]);
      hasExplicit = true;
    }
  }
  if (!hasExplicit && Array.isArray(o.main) && o.main.length) map.set(0, o.main as Item[]);
  return map;
}

// 收集流向 node 的所有活跃入边数据（仅当上游对应分支确实产出了 items）
export function collectIncoming(
  edges: Map<string, Array<{ to: string; branch: number }>>,
  nodeName: string,
  produced: Map<string, BranchOutputs>,
): Item[] {
  const items: Item[] = [];
  for (const [from, list] of edges) {
    for (const e of list) {
      if (e.to !== nodeName) continue;
      const arr = produced.get(from)?.get(e.branch);
      if (arr && arr.length) items.push(...arr);
    }
  }
  return items;
}

// 单节点执行节点决策：是否执行 + 为什么。纯函数，便于单测直接断言语义。
export function decideNode(args: {
  nodeName: string;
  entryName: string | null;
  reachable: Set<string>;
  completed: Set<string>;
  incoming: Item[];
}): { run: boolean; reason: 'run' | 'not-reachable' | 'already-completed' | 'no-active-branch' | 'entry' } {
  const { nodeName, entryName, reachable, completed, incoming } = args;
  if (!reachable.has(nodeName)) return { run: false, reason: 'not-reachable' };
  if (completed.has(nodeName)) return { run: false, reason: 'already-completed' };
  const isEntry = entryName === nodeName;
  if (!isEntry && incoming.length === 0) return { run: false, reason: 'no-active-branch' };
  return { run: true, reason: isEntry ? 'entry' : 'run' };
}

export interface RunNodeResult {
  ok: boolean;
  output?: NodeOutput;
  error?: string;
}

export interface ExecuteGraphOptions {
  graph: DagGraph;
  initialInput: unknown;
  // 断点续跑：已完成的节点名
  completedNodes?: readonly string[];
  // 断点续跑：已完成节点的历史输出。必须回填，否则已跳过节点的下游拿不到
  // 「活跃入边」，会被误判为 no-active-branch 而整条链路不再执行（续跑失效）。
  seedResults?: Record<string, NodeOutput>;
  // 节点执行器（由调用方注入；flow-engine 用 step.do 包装，测试直接调用节点执行器）
  runNode: (node: N8nNode, inputData: { main: Item[] }) => Promise<RunNodeResult>;
  onNodeStart?: (node: N8nNode, inputData: { main: Item[] }) => void | Promise<void>;
  onNodeSuccess?: (node: N8nNode, output: NodeOutput, inputData: { main: Item[] }, completed: string[]) => void | Promise<void>;
  onNodeFailure?: (node: N8nNode, error: string) => void | Promise<void>;
  // 每步之后回调（用于写检查点 / 释放锁等）
  onCheckpoint?: (completed: string[], currentNode: string | null) => void | Promise<void>;
}

export interface ExecuteGraphResult {
  ok: boolean;
  executed: string[];
  skipped: Array<{ node: string; reason: string }>;
  results: Map<string, NodeOutput>;
  lastExecuted?: string;
  failedNode?: string;
  error?: string;
}

// 按 DAG 拓扑顺序执行整张图。
// 设计约束：runNode 永不抛异常（失败编码为 {ok:false}），从而保证调用方的 step 不会被无限重放。
export async function executeGraph(opts: ExecuteGraphOptions): Promise<ExecuteGraphResult> {
  const { graph, runNode } = opts;
  const reachable = computeReachable(graph);
  const produced = new Map<string, BranchOutputs>();
  const results = new Map<string, NodeOutput>();
  const completed = new Set<string>(opts.completedNodes ?? []);
  const executed: string[] = [];
  const skipped: ExecuteGraphResult['skipped'] = [];
  const entryName = graph.entry?.name ?? null;
  let lastExecuted: string | undefined;

  // 续跑回填：把已完成的节点输出重新注入 results / produced，
  // 使它们的下游能正常判定「有活跃入边」并继续执行。
  if (opts.seedResults) {
    const nodeByName = new Map(graph.steps.map((s) => [s.node.name, s.node]));
    for (const [name, output] of Object.entries(opts.seedResults)) {
      results.set(name, output);
      produced.set(name, branchOutputs(nodeByName.get(name)?.type ?? '', output));
    }
  }

  for (const s of graph.steps) {
    const node = s.node;
    const incoming = collectIncoming(graph.edges, node.name, produced);
    const decision = decideNode({
      nodeName: node.name,
      entryName,
      reachable,
      completed,
      incoming,
    });
    if (!decision.run) {
      skipped.push({ node: node.name, reason: decision.reason });
      continue;
    }

    const inputData: { main: Item[] } = incoming.length > 0
      ? { main: incoming }
      : { main: [{ json: (opts.initialInput ?? {}) as any }] };

    await opts.onNodeStart?.(node, inputData);
    await opts.onCheckpoint?.([...completed], node.name);

    const outcome = await runNode(node, inputData);

    if (!outcome.ok) {
      const error = outcome.error ?? 'unknown error';
      await opts.onNodeFailure?.(node, error);
      return {
        ok: false,
        executed,
        skipped,
        results,
        lastExecuted,
        failedNode: node.name,
        error,
      };
    }

    const output = outcome.output ?? { main: [] };
    completed.add(node.name);
    results.set(node.name, output);
    produced.set(node.name, branchOutputs(node.type, output));
    lastExecuted = node.name;
    executed.push(node.name);

    await opts.onNodeSuccess?.(node, output, inputData, [...completed]);
    await opts.onCheckpoint?.([...completed], null);
  }

  return { ok: true, executed, skipped, results, lastExecuted };
}
