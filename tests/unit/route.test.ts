// 执行图路由语义测试（引擎的「拓扑 + 分支」行为）。
// 直接驱动 engine/route.executeGraph + 真实节点执行器，无需 workerd。
// 锁定既往缺陷：
//  - 未连线的孤立节点也被执行（应跳过）
//  - IF 两个分支都被执行（应只跑命中分支）
//  - IF 条件写 true 不生效（求值器缺字面量）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from '../../src/engine/dag';
import { executeGraph, branchOutputs, decideNode, type Item } from '../../src/engine/route';
import { resolveExecutor } from '../../src/nodes';
import type { N8nNode, N8nWorkflow } from '../../src/types';

const MT = 'n8n-nodes-base.manualTrigger';
const NOOP = 'n8n-nodes-base.noOp';
const IF = 'n8n-nodes-base.if';
const SET = 'n8n-nodes-base.set';
const CODE = 'n8n-nodes-base.code';

const item = (json: Record<string, unknown>): Item => ({ json });

function node(name: string, type: string, parameters: Record<string, unknown> = {}): N8nNode {
  return { parameters, name, type, typeVersion: 1, position: [0, 0] };
}

function wf(nodes: N8nNode[], connections: N8nWorkflow['connections']): N8nWorkflow {
  return { name: 'test', nodes, connections };
}

// 用真实节点执行器跑一遍整图
async function runWorkflow(workflow: N8nWorkflow, initialInput: unknown = {}) {
  const graph = compileWorkflow(workflow);
  return executeGraph({
    graph,
    initialInput,
    runNode: async (n, inputData) => {
      const ex = resolveExecutor(n.type);
      if (!ex) return { ok: false, error: `no executor: ${n.type}` };
      try {
        const out = await ex.execute({
          workflow, executionId: 'exec-test', node: n, inputData, env: {} as never, log: () => {},
        } as never);
        return { ok: true, output: out as never };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}

test('未连线的孤立节点不执行（回归：曾被执行）', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('Connected', NOOP), node('Isolated', NOOP)],
    { Trigger: { main: [[{ node: 'Connected' }]] } },
  ));
  assert.deepEqual(res.executed, ['Trigger', 'Connected']);
  assert.deepEqual(res.skipped, [{ node: 'Isolated', reason: 'not-reachable' }]);
  assert.equal(res.results.has('Isolated'), false);
});

test('IF 条件为 true 时只执行 true 分支（回归：曾两个分支都跑）', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('IF', IF, { conditionSt: 'true' }), node('TrueBranch', NOOP), node('FalseBranch', NOOP)],
    {
      Trigger: { main: [[{ node: 'IF' }]] },
      IF: { main: [[{ node: 'TrueBranch' }], [{ node: 'FalseBranch' }]] },
    },
  ));
  assert.equal(res.ok, true);
  assert.deepEqual(res.executed, ['Trigger', 'IF', 'TrueBranch']);
  assert.deepEqual(res.skipped, [{ node: 'FalseBranch', reason: 'no-active-branch' }]);
});

test('IF 条件为 false 时只执行 false 分支', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('IF', IF, { conditionSt: 'false' }), node('TrueBranch', NOOP), node('FalseBranch', NOOP)],
    {
      Trigger: { main: [[{ node: 'IF' }]] },
      IF: { main: [[{ node: 'TrueBranch' }], [{ node: 'FalseBranch' }]] },
    },
  ));
  assert.equal(res.ok, true);
  assert.deepEqual(res.executed, ['Trigger', 'IF', 'FalseBranch']);
  assert.deepEqual(res.skipped, [{ node: 'TrueBranch', reason: 'no-active-branch' }]);
});

test('IF 基于字段比较的分支路由', async () => {
  const res = await runWorkflow(
    wf(
      [node('Trigger', MT), node('IF', IF, { conditions: { conditions: [{ leftValue: '={{ $json.n }}', operator: 'gt', rightValue: 10 }] } }), node('Big', NOOP), node('Small', NOOP)],
      {
        Trigger: { main: [[{ node: 'IF' }]] },
        IF: { main: [[{ node: 'Big' }], [{ node: 'Small' }]] },
      },
    ),
    { n: 42 },
  );
  assert.deepEqual(res.executed, ['Trigger', 'IF', 'Big']);
});

test('Code 节点执行真算术（回归：1+1 曾得字符串 "11"）', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('Code', CODE, { javascriptCode: '1 + 1' })],
    { Trigger: { main: [[{ node: 'Code' }]] } },
  ));
  const out = res.results.get('Code') as { main: Item[] };
  assert.equal(out.main[0].json.output, 2);
});

test('Code 节点支持 const + return 多语句', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('Code', CODE, { javascriptCode: 'const x = 2 + 3; return x * 2' })],
    { Trigger: { main: [[{ node: 'Code' }]] } },
  ));
  const out = res.results.get('Code') as { main: Item[] };
  assert.equal(out.main[0].json.output, 10);
});

test('Set 节点对 {{ }} 表达式求值并保留类型', async () => {
  const res = await runWorkflow(wf(
    [node('Trigger', MT), node('Set', SET, { assignments: { assignments: [{ name: 'total', value: '={{ 1 + 1 }}' }] } })],
    { Trigger: { main: [[{ node: 'Set' }]] } },
  ));
  const out = res.results.get('Set') as { main: Item[] };
  assert.equal(out.main[0].json.total, 2);
});

test('数据沿链路正确传递：Trigger 输入 → Set → Code', async () => {
  const res = await runWorkflow(
    wf(
      [node('Trigger', MT), node('Set', SET, { assignments: { assignments: [{ name: 'name', value: '={{ $json.user }}' }] } }), node('Code', CODE, { javascriptCode: 'upper(name)' })],
      {
        Trigger: { main: [[{ node: 'Set' }]] },
        Set: { main: [[{ node: 'Code' }]] },
      },
    ),
    { user: 'alice' },
  );
  const out = res.results.get('Code') as { main: Item[] };
  assert.equal(out.main[0].json.name, 'alice');
  assert.equal(out.main[0].json.output, 'ALICE');
});

// —— 分支归一化（纯函数） ——

test('branchOutputs：IF true → index 0，false → index 1', () => {
  const a = item({ v: 1 });
  assert.deepEqual([...branchOutputs(IF, { main: [a], branch: true }).entries()], [[0, [a]]]);
  assert.deepEqual([...branchOutputs(IF, { main: [a], branch: false }).entries()], [[1, [a]]]);
});

test('branchOutputs：普通节点落到 index 0，空输出不登记分支', () => {
  const a = item({ v: 1 });
  assert.deepEqual([...branchOutputs(NOOP, { main: [a] }).entries()], [[0, [a]]]);
  assert.equal(branchOutputs(NOOP, { main: [] }).size, 0);
  assert.equal(branchOutputs(NOOP, null).size, 0);
});

test('branchOutputs：多分支节点按 main_N 键登记', () => {
  const a = item({ v: 1 });
  assert.deepEqual([...branchOutputs('n8n-nodes-base.switch', { main_2: [a] }).entries()], [[2, [a]]]);
});

// —— 执行决策（纯函数） ——

test('decideNode：不可达 / 已完成 / 无活跃分支 的判定', () => {
  const reachable = new Set(['A', 'B']);
  assert.deepEqual(
    decideNode({ nodeName: 'X', entryName: 'A', reachable, completed: new Set(), incoming: [] }),
    { run: false, reason: 'not-reachable' },
  );
  assert.deepEqual(
    decideNode({ nodeName: 'B', entryName: 'A', reachable, completed: new Set(['B']), incoming: [item({})] }),
    { run: false, reason: 'already-completed' },
  );
  assert.deepEqual(
    decideNode({ nodeName: 'B', entryName: 'A', reachable, completed: new Set(), incoming: [] }),
    { run: false, reason: 'no-active-branch' },
  );
  assert.deepEqual(
    decideNode({ nodeName: 'A', entryName: 'A', reachable, completed: new Set(), incoming: [] }),
    { run: true, reason: 'entry' },
  );
  assert.deepEqual(
    decideNode({ nodeName: 'B', entryName: 'A', reachable, completed: new Set(), incoming: [item({})] }),
    { run: true, reason: 'run' },
  );
});

// —— 失败与回调（注入式 runNode，验证 run 永不从节点失败逃逸） ——

test('节点失败：run 不抛异常，标 failedNode 并停止后续节点', async () => {
  const workflow = wf(
    [node('Trigger', MT), node('Boom', NOOP), node('After', NOOP)],
    { Trigger: { main: [[{ node: 'Boom' }]] }, Boom: { main: [[{ node: 'After' }]] } },
  );
  const res = await executeGraph({
    graph: compileWorkflow(workflow),
    initialInput: {},
    runNode: async (n) => (n.name === 'Boom'
      ? { ok: false, error: '节点爆炸' }
      : { ok: true, output: { main: [item({ ok: 1 })] } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.failedNode, 'Boom');
  assert.equal(res.error, '节点爆炸');
  assert.deepEqual(res.executed, ['Trigger']);
});

test('回调顺序：启动 → 检查点(currentNode=node) → 成功 → 检查点(currentNode=null)', async () => {
  const workflow = wf([node('Trigger', MT), node('A', NOOP)], { Trigger: { main: [[{ node: 'A' }]] } });
  const events: string[] = [];
  await executeGraph({
    graph: compileWorkflow(workflow),
    initialInput: {},
    runNode: async () => ({ ok: true, output: { main: [item({})] } }),
    onNodeStart: (n) => { events.push(`start:${n.name}`); },
    onCheckpoint: (completed, currentNode) => { events.push(`ckpt:${completed.join('+')}|${currentNode ?? 'null'}`); },
    onNodeSuccess: (n) => { events.push(`ok:${n.name}`); },
  });
  assert.deepEqual(events, [
    'start:Trigger',
    'ckpt:|Trigger',
    'ok:Trigger',
    'ckpt:Trigger|null',
    'start:A',
    'ckpt:Trigger|A',
    'ok:A',
    'ckpt:Trigger+A|null',
  ]);
});

test('断点续跑：必须回填 seedResults，下游才能继续执行（否则续跑链路静默中断）', async () => {
  const workflow = wf([node('Trigger', MT), node('A', NOOP), node('B', NOOP)], {
    Trigger: { main: [[{ node: 'A' }]] },
    A: { main: [[{ node: 'B' }]] },
  });
  const graph = compileWorkflow(workflow);
  const executed: string[] = [];

  // 未回填历史输出：B 拿不到活跃入边 → 被跳过
  const withoutSeed = await executeGraph({
    graph,
    initialInput: {},
    completedNodes: ['Trigger', 'A'],
    runNode: async () => ({ ok: true, output: { main: [item({})] } }),
  });
  assert.deepEqual(withoutSeed.executed, []);
  assert.deepEqual(withoutSeed.skipped, [
    { node: 'Trigger', reason: 'already-completed' },
    { node: 'A', reason: 'already-completed' },
    { node: 'B', reason: 'no-active-branch' },
  ]);

  // 回填历史输出后：B 正常继续执行
  const withSeed = await executeGraph({
    graph,
    initialInput: {},
    completedNodes: ['Trigger', 'A'],
    seedResults: {
      Trigger: { main: [item({})] },
      A: { main: [item({ fromA: 1 })] },
    },
    runNode: async (n, inputData) => {
      executed.push(n.name);
      return { ok: true, output: { main: inputData.main } };
    },
  });
  assert.deepEqual(withSeed.executed, ['B']);
  assert.deepEqual(executed, ['B']);
  // 续跑结果应包含历史节点的输出（供最终 markCompleted 汇总）
  assert.deepEqual(Object.keys(Object.fromEntries(withSeed.results)).sort(), ['A', 'B', 'Trigger']);
});
