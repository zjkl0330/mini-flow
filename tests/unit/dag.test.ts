// DAG 编译测试：拓扑序、入口识别、分支边、禁用节点、空名兜底、孤立子图。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from '../../src/engine/dag';
import { computeReachable } from '../../src/engine/route';
import type { N8nNode, N8nWorkflow } from '../../src/types';

function node(name: string, type: string, extra: Partial<N8nNode> = {}): N8nNode {
  return { parameters: {}, name, type, typeVersion: 1, position: [0, 0], ...extra };
}

function wf(nodes: N8nNode[], connections: N8nWorkflow['connections']): N8nWorkflow {
  return { name: 'test', nodes, connections };
}

const MT = 'n8n-nodes-base.manualTrigger';
const NOOP = 'n8n-nodes-base.noOp';
const IF = 'n8n-nodes-base.if';
const STICKY = 'n8n-nodes-base.stickyNote';

test('线性链：拓扑序与入口正确', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('A', NOOP), node('B', NOOP)],
    {
      Trigger: { main: [[{ node: 'A' }]] },
      A: { main: [[{ node: 'B' }]] },
    },
  ));
  assert.deepEqual(g.steps.map((s) => s.node.name), ['Trigger', 'A', 'B']);
  assert.equal(g.entry?.name, 'Trigger');
  assert.deepEqual(g.edges.get('Trigger'), [{ to: 'A', branch: 0 }]);
  assert.deepEqual(g.edges.get('A'), [{ to: 'B', branch: 0 }]);
});

test('connections 用节点 id 引用时也能对齐到 name', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT, { id: 'n1' }), node('A', NOOP, { id: 'n2' })],
    { n1: { main: [[{ node: 'n2' } as never]] } },
  ));
  assert.deepEqual(g.steps.map((s) => s.node.name), ['Trigger', 'A']);
  assert.deepEqual(g.edges.get('Trigger'), [{ to: 'A', branch: 0 }]);
});

test('禁用节点被排除出步骤序列', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('A', NOOP), node('B', NOOP, { disabled: true })],
    { Trigger: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'B' }]] } },
  ));
  assert.deepEqual(g.steps.map((s) => s.node.name), ['Trigger', 'A']);
});

test('禁用中间节点后，其下游不进入拓扑序列（记录既有语义）', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('A', NOOP, { disabled: true }), node('B', NOOP)],
    { Trigger: { main: [[{ node: 'A' }]] }, A: { main: [[{ node: 'B' }]] } },
  ));
  // A 被移除后 B 的入度仍为 1（边还在），故 B 无法进入拓扑序列
  assert.deepEqual(g.steps.map((s) => s.node.name), ['Trigger']);
});

test('空字符串 name 的节点必须被兜底命名（回归：曾以空串入图导致失联）', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('', NOOP)],
    { Trigger: { main: [[{ node: '' }]] } },
  ));
  const blank = g.steps.find((s) => s.node.type === NOOP)!;
  assert.equal(blank.node.name, 'node_1_noOp');
  assert.deepEqual(g.edges.get('Trigger'), [{ to: 'node_1_noOp', branch: 0 }]);
  // 关键：改名后的节点必须能被拓扑排序（入度归零）
  assert.deepEqual(g.steps.map((s) => s.node.name), ['Trigger', 'node_1_noOp']);
});

test('IF 的两条分支分别记为 branch 0 / 1', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('IF', IF), node('T', NOOP), node('F', NOOP)],
    {
      Trigger: { main: [[{ node: 'IF' }]] },
      IF: { main: [[{ node: 'T' }], [{ node: 'F' }]] },
    },
  ));
  assert.deepEqual(g.edges.get('IF'), [
    { to: 'T', branch: 0 },
    { to: 'F', branch: 1 },
  ]);
});

test('孤立子图：节点进入 steps 但不可达', () => {
  const g = compileWorkflow(wf(
    [node('Trigger', MT), node('Connected', NOOP), node('Isolated', NOOP)],
    { Trigger: { main: [[{ node: 'Connected' }]] } },
  ));
  const reach = computeReachable(g);
  assert.equal(reach.has('Trigger'), true);
  assert.equal(reach.has('Connected'), true);
  assert.equal(reach.has('Isolated'), false);
});

test('画布便签排在触发器之前时入口仍为触发器（回归：曾整条工作流不执行）', () => {
  const g = compileWorkflow(wf(
    [node('Note', STICKY), node('Trigger', MT), node('A', NOOP)],
    { Trigger: { main: [[{ node: 'A' }]] } },
  ));
  assert.equal(g.entry?.name, 'Trigger');
  const reach = computeReachable(g);
  assert.equal(reach.has('Trigger'), true);
  assert.equal(reach.has('A'), true);
});

test('多个入度 0 节点并存时优先选择触发器类型作为入口', () => {
  const g = compileWorkflow(wf([node('Lonely', NOOP), node('Trigger', MT)], {}));
  assert.equal(g.entry?.name, 'Trigger');
});

test('无可达入口（无入度 0 节点）时 entry 为 null', () => {
  const g = compileWorkflow(wf(
    [node('A', NOOP), node('B', NOOP)],
    { A: { main: [[{ node: 'B' }]] }, B: { main: [[{ node: 'A' }]] } },
  ));
  assert.equal(g.entry, null);
  assert.equal(computeReachable(g).size, 0);
});
