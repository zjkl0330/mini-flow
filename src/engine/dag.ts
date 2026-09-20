// dag: 把 n8n workflow JSON 编译为可执行的步骤序列（含条件分支）
// n8n connections 形态: { [from]: { main: [ [ {node: toName} ], [ ] ] } }
// main[0] = true/主线, main[1] = IF 的 false 分支
import type { N8nWorkflow, N8nNode } from '../types';

export interface Step {
  node: N8nNode;
  order: number;
}

export interface DagGraph {
  steps: Step[];
  // 从节点名 → 其下游 [(目标节点名, 分支index?)]
  edges: Map<string, Array<{ to: string; branch: number }>>;
  // 入口节点（无上游）
  entry: N8nNode | null;
  // 出边为条件分支的节点（其下游需要按分支 index 定向）
}

export function compileWorkflow(workflow: N8nWorkflow): DagGraph {
  // 归一化：缺失/空白 name 的节点用 type(位置索引) 兜底，避免整条链 key 变成 "undefined"。
  // 注意：旧写法 `n.name || n.name === '' ? n.name : fallback` 对空串恒为真，
  // 导致 name='' 的节点仍以空串入图（下游 connections 无法对齐、节点静默失联）。
  const fallbackName = (n: N8nNode, i: number) => `node_${i}_${String(n.type ?? 'n').split('.').pop() || 'n'}`;
  // 改名表：原始 name(可能为空串) → 兜底后的 name。必须同时重映射 connections 的引用键，
  // 否则被改名的节点会与引用它的边对不上（节点入度恒 >0，永远排不进拓扑序列）。
  const renamed = new Map<string, string>();
  const raw = workflow.nodes
    .filter((n) => !n.disabled)
    .map((n, i) => {
      const orig = typeof n.name === 'string' ? n.name : '';
      const name = orig.trim() !== '' ? orig : fallbackName(n, i);
      if (name !== orig) renamed.set(orig, name);
      return { ...n, name };
    });
  const nameById = new Map<string, string>();
  for (const n of raw) if (n.id) nameById.set(n.id, n.name);
  // 让 connections 里的目标（可能是 id / 原始 name）与节点 name 对齐
  const connKey = (key: string) => {
    if (nameById.has(key)) return nameById.get(key)!;
    if (renamed.has(key)) return renamed.get(key)!;
    return key;
  };
  const nodes = raw;
  const edges = new Map<string, Array<{ to: string; branch: number }>>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) inDegree.set(n.name, 0);

  for (const [from, conn] of Object.entries(workflow.connections || {})) {
    const mains = conn.main || [];
    for (let branchIdx = 0; branchIdx < mains.length; branchIdx++) {
      for (const target of mains[branchIdx] || []) {
        const f = connKey(from);
        const t = connKey(target.node);
        if (!inDegree.has(f)) inDegree.set(f, 0);
        const list = edges.get(f) ?? [];
        list.push({ to: t, branch: branchIdx });
        edges.set(f, list);
        inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
      }
    }
  }

  // 入口节点：入度 0 的节点（须在 Kahn 变异 inDegree 之前计算，否则不可靠）。
  //
  // 选择策略（顺序很重要）：入度 0 的节点可能有多个（多触发器、以及画布便签 StickyNote）。
  // 旧实现取「数组里第一个入度 0 的节点」，于是——若便签排在触发器之前（n8n 模板很常见），
  // 入口会被判成便签，computeReachable 只覆盖便签自身，导致**整条工作流一个节点都不执行**。
  // 因此：优先触发器 → 排除便签类纯装饰节点 → 最后才回落到任意入度 0 节点。
  const zeroInDegree = nodes.filter((n) => (inDegree.get(n.name) ?? 0) === 0);
  const isTriggerType = (n: N8nNode) => /trigger|webhook|cron|schedule/i.test(n.type ?? '');
  const isDecoration = (n: N8nNode) => /stickyNote|sticky_note/i.test(n.type ?? '');
  const entryNode: N8nNode | null =
    zeroInDegree.find(isTriggerType)
    ?? zeroInDegree.find((n) => !isDecoration(n))
    ?? zeroInDegree[0]
    ?? null;

  // Kahn 拓扑排序（稳定顺序：按原数组顺序出队）
  const queue = nodes.filter((n) => (inDegree.get(n.name) ?? 0) === 0);
  const steps: Step[] = [];
  const visited = new Set<string>();
  let order = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur.name)) continue;
    visited.add(cur.name);
    steps.push({ node: cur, order: order++ });
    for (const e of edges.get(cur.name) ?? []) {
      const deg = (inDegree.get(e.to) ?? 0) - 1;
      inDegree.set(e.to, deg);
      if (deg === 0) {
        const t = nodes.find((n) => n.name === e.to);
        if (t) queue.push(t);
      }
    }
  }

  return { steps, edges, entry: entryNode };
}