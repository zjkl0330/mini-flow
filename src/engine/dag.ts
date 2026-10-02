// dag: compile n8n workflow JSON into executable step sequence (with conditional branches)
import type { N8nWorkflow, N8nNode } from '../types';

export interface Step {
  node: N8nNode;
  order: number;
}

export interface DagGraph {
  steps: Step[];
  edges: Map<string, Array<{ to: string; branch: number }>>;
  entry: N8nNode | null;
}

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.intervalTrigger',
]);

const STICKY_TYPES = new Set(['n8n-nodes-base.stickyNote']);

export function compileWorkflow(workflow: N8nWorkflow): DagGraph {
  // Normalize: empty/missing names get index+type fallback
  const origNodes = workflow.nodes.filter((n) => !n.disabled);
  const raw: N8nNode[] = origNodes.map((n, i) => ({
    ...n,
    name: n.name ? n.name : `node_${i}_${n.type.split('.').pop() ?? 'n'}`,
  }));

  // id -> name mapping (connections may reference by id)
  const nameById = new Map<string, string>();
  for (const n of raw) {
    if (n.id) nameById.set(n.id, n.name);
  }
  // original empty-name -> fallback name (connections may use '' as ref)
  const emptyToFallback = new Map<string, string>();
  for (let i = 0; i < origNodes.length; i++) {
    const orig = origNodes[i];
    if (!orig.name || orig.name === '') {
      emptyToFallback.set('', raw[i].name);
    }
  }

  const connKey = (key: string) => {
    if (nameById.has(key)) return nameById.get(key)!;
    if (emptyToFallback.has(key)) return emptyToFallback.get(key)!;
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

  // Entry: in-degree 0, prefer trigger types, skip sticky notes
  let entryNode: N8nNode | null = null;
  for (const n of nodes) {
    if ((inDegree.get(n.name) ?? 0) === 0 && TRIGGER_TYPES.has(n.type)) {
      entryNode = n; break;
    }
  }
  if (!entryNode) {
    for (const n of nodes) {
      if ((inDegree.get(n.name) ?? 0) === 0 && !STICKY_TYPES.has(n.type)) {
        entryNode = n; break;
      }
    }
  }

  // Kahn topological sort, skip sticky notes
  const queue = nodes.filter((n) => (inDegree.get(n.name) ?? 0) === 0 && !STICKY_TYPES.has(n.type));
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
        if (t && !STICKY_TYPES.has(t.type)) queue.push(t);
      }
    }
  }

  return { steps, edges, entry: entryNode };
}
