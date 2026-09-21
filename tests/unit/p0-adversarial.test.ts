// QA 独立对抗性回归（缺陷1：Code 节点求值失败静默 + n8n 输入语义）。
//
// 目的：不复跑工程师的断言，而是从「证伪」角度设计用例——
//   * 多输入（≥3）下 items.map 不得产生 N×N 重复或丢项；
//   * 非法构造必须让节点显式失败（绝不「执行 success + 输出错误文本」）；
//   * items/$input 不得遮蔽用户在 {{ }} 路径下的同名字段；
//   * 求值器新增 lambda/成员方法白名单不得改变既有 {{ }} 行为。
//
// 夹具走真实节点执行器（codeNode / setNode / ifNode），与生产同一入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeNode } from '../../src/nodes/code-node';
import { setNode, ifNode } from '../../src/nodes/if-condition';
import { evaluate } from '../../src/engine/evaluator';
import { compileWorkflow } from '../../src/engine/dag';
import { executeGraph } from '../../src/engine/route';
import { resolveExecutor } from '../../src/nodes';
import type { N8nNode, N8nWorkflow } from '../../src/types';

type Item = { json: Record<string, any> };

function node(name: string, type: string, parameters: Record<string, any> = {}): N8nNode {
  return { parameters, name, type, typeVersion: 1, position: [0, 0] };
}

function ctxFor(code: string, items: Item[], key = 'javascriptCode') {
  const n = node('Code', 'n8n-nodes-base.code', { [key]: code });
  return {
    workflow: { name: 'wf', nodes: [n], connections: {} },
    executionId: 'exec-qa',
    node: n,
    inputData: { main: items },
    env: {},
    log: () => {},
  } as never;
}

// 运行 Code 节点：捕获异常，显式区分 ok / 失败
async function run(code: string, jsons: Array<Record<string, unknown>> = [{}]) {
  try {
    const out = await codeNode.execute(ctxFor(code, jsons.map((json) => ({ json }))));
    return { ok: true as const, main: out.main as Item[] };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// ========================================================================
// A. 缺陷1 正向能力
// ========================================================================

test('[QA-A1] 多输入(3项) items.map + 展开 → 恰好 3 项且逐项值正确（防 N×N）', async () => {
  const r = await run('return items.map(i => ({ json: { ...i.json, v: i.json.n + 1 } }))', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(r.main.length, 3, '必须恰好 3 项（防 N×N=9 或坍缩为 1 项）');
  assert.deepEqual(r.main, [
    { json: { n: 1, v: 2 } },
    { json: { n: 2, v: 3 } },
    { json: { n: 3, v: 4 } },
  ]);
});

test('[QA-A1b] 多输入(5项) items.map 不展开 → 恰好 5 项', async () => {
  const r = await run('return items.map(i => ({ json: { v: i.json.n * 10 } }))', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(r.main.length, 5, '5 输入 → 5 输出，不得 N×N');
  assert.deepEqual(r.main, [{ json: { v: 10 } }, { json: { v: 20 } }, { json: { v: 30 } }, { json: { v: 40 } }, { json: { v: 50 } }]);
});

test('[QA-A1c] 输入项本身含 items 字段时，items.map 仍映射引擎全集而非字段', async () => {
  // 对抗：每个 json 里放一个 items 字段，确认引擎的 items 未被字段遮蔽
  const r = await run('return items.map(i => ({ json: { tag: i.json.tag } }))', [
    { tag: 'a', items: 'x' }, { tag: 'b', items: 'y' }, { tag: 'c', items: 'z' },
  ]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.equal(r.main.length, 3);
  assert.deepEqual(r.main, [{ json: { tag: 'a' } }, { json: { tag: 'b' } }, { json: { tag: 'c' } }]);
});

test('[QA-A2] return items 原样透传（3 项）', async () => {
  const r = await run('return items;', [{ a: 1 }, { b: 2 }, { c: 3 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { a: 1 } }, { json: { b: 2 } }, { json: { c: 3 } }]);
});

test('[QA-A2b] return $json（面板默认值）逐项可用', async () => {
  const r = await run('return $json;', [{ n: 7 }, { n: 8 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { n: 7 } }, { json: { n: 8 } }]);
});

test('[QA-A3] items.filter / items.reduce / $input.first().json.x 真实可用', async () => {
  const filtered = await run('return items.filter(i => i.json.n > 1)', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(filtered.ok, true, filtered.ok ? '' : filtered.error);
  assert.deepEqual(filtered.main, [{ json: { n: 2 } }, { json: { n: 3 } }]);

  const reduced = await run('return [{ json: { sum: items.reduce((a, i) => a + i.json.n, 0) } }]', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(reduced.ok, true, reduced.ok ? '' : reduced.error);
  assert.deepEqual(reduced.main, [{ json: { sum: 6 } }]);

  const first = await run('return [{ json: { x: $input.first().json.x } }]', [{ x: 100 }, { x: 200 }]);
  assert.equal(first.ok, true, first.ok ? '' : first.error);
  assert.deepEqual(first.main, [{ json: { x: 100 } }]);
});

test('[QA-A4] 多参 lambda (i, idx) => ... 传入序号正确', async () => {
  // 注：受限求值器不支持对象简写属性 { idx }，故显式写 idx: idx（属能力边界，非本缺陷）
  const r = await run('return items.map((i, idx) => ({ json: { idx: idx, n: i.json.n } }))', [{ n: 5 }, { n: 6 }, { n: 7 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { idx: 0, n: 5 } }, { json: { idx: 1, n: 6 } }, { json: { idx: 2, n: 7 } }]);
});

test('[QA-A4b] 对象展开 ... 合并字段', async () => {
  const r = await run('return [{ json: { ...$input.first().json, extra: true } }]', [{ n: 1, a: 2 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { n: 1, a: 2, extra: true } }]);
});

// ========================================================================
// B. 缺陷1 失败必须显式（防静默回归）
// ========================================================================

test('[QA-B5] 6 类非法/不支持构造一律显式失败（节点 failed、错误非空、绝不返回数据）', async () => {
  const cases: Array<[string, string]> = [
    ['未支持语句 for-of', 'for (const x of items) {}'],
    ['未支持声明 function', 'function f() { return 1; }'],
    ['未闭合括号', 'return items.map(i => ({ json: { v: i.json.n + 1 } }'],
    ['未知函数调用', 'return totallyUnknownFn(1)'],
    ['块体箭头（不支持）', 'return items.map(i => { return i.json; })'],
    ['未支持语句 while', 'while (n < 3) { }'],
  ];
  for (const [label, code] of cases) {
    const r = await run(code, [{ n: 1 }]);
    assert.equal(r.ok, false, `[${label}] 必须显式失败（节点 failed），绝不能返回数据`);
    assert.ok(!('main' in r), `[${label}] 失败时不得返回 main 数据`);
    assert.ok((r.error ?? '').length > 0, `[${label}] error_message 必须非空且可读`);
    assert.match(r.error!, /Code 节点求值失败/, `[${label}] 错误信息应说明是受限求值失败`);
  }
});

test('[QA-B5-route] 端到端：Code 抛错 → executeGraph 标 failedNode / ok=false（执行 error）', async () => {
  const wf: N8nWorkflow = {
    name: 'qa-fail',
    nodes: [
      node('Trigger', 'n8n-nodes-base.manualTrigger'),
      node('Code', 'n8n-nodes-base.code', { javascriptCode: 'for (const x of items) {}' }),
    ],
    connections: { Trigger: { main: [[{ node: 'Code' }]] } },
  };
  const res = await executeGraph({
    graph: compileWorkflow(wf),
    initialInput: { n: 1 },
    runNode: async (n, inputData) => {
      const ex = resolveExecutor(n.type);
      if (!ex) return { ok: false, error: `no executor: ${n.type}` };
      try {
        const out = await ex.execute({ workflow: wf, executionId: 'e', node: n, inputData, env: {} as never, log: () => {} } as never);
        return { ok: true, output: out as never };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
  assert.equal(res.ok, false, '执行必须标 error（ok=false），而非 success');
  assert.equal(res.failedNode, 'Code');
  assert.match(res.error ?? '', /Code 节点求值失败/);
});

// ========================================================================
// C. 兼容与回归（共享求值器风险面）
// ========================================================================

test('[QA-C7] items/$input 在「无 ctx.items」时解析为用户同名字段，不遮蔽', async () => {
  // 直接求值（等价 {{ }} 路径：只传 { json }）
  assert.equal(evaluate('items', { json: { items: 'USER' } }), 'USER');
  assert.equal(evaluate('$input', { json: { $input: 'USER' } }), 'USER');
  // 反证：仅当调用方显式提供 ctx.items 时，裸 items 才解析为引擎数组
  const arr = [{ json: { n: 1 } }];
  assert.deepEqual(evaluate('items', { json: { items: 'USER' }, items: arr }), arr);
});

test('[QA-C7b] Set 节点 {{ }} 路径取用户字段而非引擎注入（={{ items }} / ={{ $json.items }}）', async () => {
  const mk = (value: string): never => ({
    workflow: { name: 'wf', nodes: [], connections: {} },
    executionId: 'e',
    node: node('Set', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'x', value }] } }),
    inputData: { main: [{ json: { items: 'USER', n: 10 } }] },
    env: {},
    log: () => {},
  } as never);

  const bare = await setNode.execute(mk('={{ items }}'));
  assert.equal((bare.main[0].json as any).x, 'USER', '裸 items 应取用户字段，不得取到引擎数组/undefined');

  const dotted = await setNode.execute(mk('={{ $json.items }}'));
  assert.equal((dotted.main[0].json as any).x, 'USER');
});

test('[QA-C7c] IF conditionSt 中 items 字段参与判定（取用户字段）', async () => {
  const mk = (conditionSt: string): never => ({
    workflow: { name: 'wf', nodes: [], connections: {} },
    executionId: 'e',
    node: node('IF', 'n8n-nodes-base.if', { conditionSt }),
    inputData: { main: [{ json: { items: 10 } }] },
    env: {},
    log: () => {},
  } as never);

  // 用户字段 items=10 → 10 > 5 为真；若被引擎数组遮蔽则 false
  // 注：IF 的 conditionSt 只剥离 `{{ ... }}`（不剥离 `={{ ... }}`）；后者为既有能力边界（if-condition.ts 未被本次提交改动）
  const a = await ifNode.execute(mk('{{ items > 5 }}'));
  assert.equal(a.branch, true, 'items 应解析为用户字段 10（>5 为真）');

  const b = await ifNode.execute(mk('{{ $json.items > 5 }}'));
  assert.equal(b.branch, true);

  const c = await ifNode.execute(mk('{{ items > 50 }}'));
  assert.equal(c.branch, false, '10 > 50 应为假（确认确实读到了 10）');
});

test('[QA-C8] 既有 Code 语义不变（1+1→2；const+return→10；upper(name)→ALICE）', async () => {
  const a = await run('1 + 1', [{ n: 1 }]);
  assert.equal(a.main[0].json.output, 2);

  const b = await run('const x = 2 + 3; return x * 2', [{ n: 1 }]);
  assert.equal(b.main[0].json.output, 10);

  const c = await run('upper(name)', [{ name: 'alice' }]);
  assert.equal(c.main[0].json.output, 'ALICE');
  assert.equal(c.main[0].json.name, 'alice');
});

test('[QA-C9] {{ }} 表达式路径既有行为不变（算术/字段/三目/内置函数）', async () => {
  assert.equal(evaluate('1 + 1', { json: {} }), 2);
  assert.equal(evaluate("'1' + 1", { json: {} }), '11');
  assert.equal(evaluate('$json.name', { json: { name: 'x' } }), 'x');
  assert.equal(evaluate("1 > 0 ? 'yes' : 'no'", { json: {} }), 'yes');
  assert.equal(evaluate('true', { json: {} }), true);
  // 既有内置函数仍可用（不应被新白名单误伤）
  assert.equal(evaluate('length([1, 2, 3])', { json: {} }), 3);
  assert.equal(evaluate('round(1.2345, 2)', { json: {} }), 1.23);
  assert.equal(evaluate("upper('ab')", { json: {} }), 'AB');
});

test('[QA-C9b] IF conditionSt true/false 字面量判定不变', async () => {
  const mk = (conditionSt: string): never => ({
    workflow: { name: 'wf', nodes: [], connections: {} },
    executionId: 'e',
    node: node('IF', 'n8n-nodes-base.if', { conditionSt }),
    inputData: { main: [{ json: {} }] },
    env: {},
    log: () => {},
  } as never);
  assert.equal((await ifNode.execute(mk('true'))).branch, true);
  assert.equal((await ifNode.execute(mk('false'))).branch, false);
});
