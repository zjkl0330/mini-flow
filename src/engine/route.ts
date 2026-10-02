// route: 执行图路由 —— 拓扑遍历 + IF/Switch 分支决策 + 断点续跑
import type { DagGraph } from './dag';
import type { N8nNode } from '../types';

export interface Item {
  json: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NodeOutput {
  main: Item[];
  branch?: boolean;
  [key: string]: Item[] | boolean | undefined;
}

export interface NodeResult {
  ok: boolean;
  output?: NodeOutput;
  error?: string;
}

export interface GraphResult {
  ok: boolean;
  executed: string[];
  skipped: Array<{ node: string; reason: string }>;
  results: Map<string, NodeOutput>;
  failedNode?: string;
  error?: string;
}

/** 根据节点类型与输出决定哪些分支活跃 */
export function branchOutputs(nodeType: string, output: NodeOutput | null): Map<number, Item[]> {
  if (!output) return new Map();
  const result = new Map<number, Item[]>();
  if (nodeType.includes('.if') || nodeType.includes('.switch')) {
    // 优先检查 branch 标记（IF/Switch 的标准输出形态）
    if (output.branch === true && output.main && output.main.length > 0) {
      result.set(0, output.main);
    } else if (output.branch === false && output.main && output.main.length > 0) {
      result.set(1, output.main);
    }
    // 兜底：检查 main_N 键（如 switch 的 main_2）
    if (result.size === 0) {
      for (const [key, val] of Object.entries(output)) {
        if (key.startsWith('main_') && Array.isArray(val) && val.length > 0) {
          result.set(parseInt(key.slice(5), 10), val as Item[]);
        }
      }
    }
    return result;
  }
  for (const [key, val] of Object.entries(output)) {
    if (key === 'main' && Array.isArray(val) && val.length > 0) {
      result.set(0, val as Item[]);
    } else if (key.startsWith('main_') && Array.isArray(val) && val.length > 0) {
      const idx = parseInt(key.slice(5), 10);
      result.set(idx, val as Item[]);
    }
  }
  return result;
}

/** 判定节点是否应执行 */
export function decideNode(opts: {
  nodeName: string;
  entryName: string | null;
  reachable: Set<string>;
  completed: Set<string>;
  incoming: Item[];
}): { run: boolean; reason: string } {
  const { nodeName, entryName, reachable, completed, incoming } = opts;
  if (!reachable.has(nodeName)) return { run: false, reason: 'not-reachable' };
  if (completed.has(nodeName)) return { run: false, reason: 'already-completed' };
  if (entryName !== null && nodeName === entryName && incoming.length === 0) {
    return { run: true, reason: 'entry' };
  }
  if (incoming.length === 0) return { run: false, reason: 'no-active-branch' };
  return { run: true, reason: 'run' };
}

/** 计算从入口可达的节点集合 */
export function computeReachable(g: DagGraph): Set<string> {
  const reachable = new Set<string>();
  if (!g.entry) return reachable;
  const queue: string[] = [g.entry.name];
  reachable.add(g.entry.name);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of g.edges.get(cur) ?? []) {
      if (!reachable.has(e.to)) {
        reachable.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return reachable;
}

/** 从已完成的节点收集输入（只收集活跃分支的输出） */
function collectIncoming(
  nodeName: string,
  edges: Map<string, Array<{ to: string; branch: number }>>,
  results: Map<string, NodeOutput>,
  activeBranches: Map<string, Set<number>>,
): Item[] {
  const items: Item[] = [];
  for (const [fromName, edgeList] of edges) {
    for (const edge of edgeList) {
      if (edge.to === nodeName) {
        const active = activeBranches.get(fromName);
        // 如果是分支节点，只收集活跃分支的输出
        if (active && !active.has(edge.branch)) continue;
        const out = results.get(fromName);
        if (out?.main) items.push(...out.main);
      }
    }
  }
  return items;
}

/** 执行整个工作流图 */
export async function executeGraph(opts: {
  graph: DagGraph;
  initialInput: unknown;
  completedNodes?: string[];
  seedResults?: Record<string, NodeOutput>;
  runNode: (node: N8nNode, inputData: { main: Item[] }) => Promise<NodeResult>;
  onNodeStart?: (node: N8nNode) => void;
  onCheckpoint?: (completed: string[], currentNode: string | null) => void;
  onNodeSuccess?: (node: N8nNode) => void;
}): Promise<GraphResult> {
  const { graph, initialInput, completedNodes = [], seedResults = {}, runNode, onNodeStart, onCheckpoint, onNodeSuccess } = opts;
  const reachable = computeReachable(graph);
  const results = new Map<string, NodeOutput>();
  const executed: string[] = [];
  const skipped: GraphResult['skipped'] = [];
  const completed = new Set<string>(completedNodes);
  const activeBranches = new Map<string, Set<number>>();

  for (const [name, out] of Object.entries(seedResults)) {
    results.set(name, out);
    completed.add(name);
  }

  const entryName = graph.entry?.name ?? null;

  for (const step of graph.steps) {
    const nodeName = step.node.name;

    if (completed.has(nodeName)) {
      skipped.push({ node: nodeName, reason: 'already-completed' });
      continue;
    }

    const incoming = collectIncoming(nodeName, graph.edges, results, activeBranches);

    const decision = decideNode({
      nodeName,
      entryName,
      reachable,
      completed,
      incoming,
    });

    if (!decision.run) {
      skipped.push({ node: nodeName, reason: decision.reason });
      continue;
    }

    onNodeStart?.(step.node);
    onCheckpoint?.([...completed], nodeName);

    const runResult = await runNode(step.node, { main: incoming });
    if (!runResult.ok) {
      return { ok: false, executed, skipped, results, failedNode: nodeName, error: runResult.error };
    }

    onNodeSuccess?.(step.node);
    executed.push(nodeName);
    completed.add(nodeName);

    const out = runResult.output ?? { main: [] as Item[] };
    results.set(nodeName, out);

    const branches = branchOutputs(step.node.type, out);
    if (branches.size > 0) {
      activeBranches.set(nodeName, new Set(branches.keys()));
    } else {
      activeBranches.set(nodeName, new Set([0]));
    }

    onCheckpoint?.([...completed], null);
  }

  return { ok: true, executed, skipped, results };
}
