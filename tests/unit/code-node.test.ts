// Code 节点回归测试。
// 锁定「今日复测」实机确认的 P0 缺陷：Code 节点求值失败被静默伪装成「成功」——
// 节点报 completed、执行报 success，而输出是一段错误文本（用户以为脚本生效，实际是垃圾数据）。
//
// 修复后必须满足：
//  1) 失败显式：任何语法/求值错误 → execute() 抛错（→ 节点 failed → 执行 error），绝不转成数据。
//  2) n8n 输入语义：items / $json / $input.all()|first()|last() / $now / env。
//  3) 支持常见写法：箭头函数 + items.map、return items、return $json、.filter/.reduce/.forEach。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeNode } from '../../src/nodes/code-node';
import type { N8nNode } from '../../src/types';

type Item = { json: Record<string, any> };

function ctxFor(code: string, items: Item[], paramKey = 'javascriptCode') {
  const node: N8nNode = {
    parameters: { [paramKey]: code },
    name: 'Code',
    type: 'n8n-nodes-base.code',
    typeVersion: 1,
    position: [0, 0],
  };
  return {
    workflow: { name: 'wf', nodes: [node], connections: {} },
    executionId: 'exec-test',
    node,
    inputData: { main: items },
    env: {},
    log: () => {},
  } as never;
}

async function run(code: string, jsons: Array<Record<string, unknown>> = [{}]) {
  try {
    const out = await codeNode.execute(ctxFor(code, jsons.map((json) => ({ json }))));
    return { ok: true as const, main: out.main as Item[] };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
}

// —— 核心正例：修复后应得到正确数据（修复前得到的是错误文本） ——

test('Code：箭头函数 + items.map + 对象展开 → 产出正确值（P0 缺陷1 核心回归）', async () => {
  const r = await run('return items.map(i => ({ json: { ...i.json, v: i.json.n + 1 } }))', [{ n: 1 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { n: 1, v: 2 } }]);
});

test('Code：items.map 不展开也应产出正确值（复测脚本 A 段写法）', async () => {
  const r = await run('return items.map(i => ({ json: { v: i.json.n + 1 } }))', [{ n: 1 }]);
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  assert.deepEqual(r.main, [{ json: { v: 2 } }]);
});

test('Code：return items 原样透传', async () => {
  const r = await run('return items;', [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(r.main, [{ json: { a: 1 } }, { json: { b: 2 } }]);
});

test('Code：return $json（面板默认值）保持可用', async () => {
  const r = await run('return $json;', [{ n: 7 }]);
  assert.deepEqual(r.main, [{ json: { n: 7 } }]);
});

test('Code：$input.all() / first() / last() 语义正确', async () => {
  const all = await run('return $input.all()', [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(all.main, [{ json: { n: 1 } }, { json: { n: 2 } }]);

  const first = await run('return [{ json: $input.first().json }]', [{ n: 9 }, { n: 8 }]);
  assert.deepEqual(first.main, [{ json: { n: 9 } }]);

  const last = await run('return [{ json: $input.last().json }]', [{ n: 9 }, { n: 8 }]);
  assert.deepEqual(last.main, [{ json: { n: 8 } }]);
});

test('Code：.filter / .reduce / .forEach / .length 与两种 lambda 写法', async () => {
  const filtered = await run('return items.filter(i => i.json.n > 1)', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(filtered.main, [{ json: { n: 2 } }, { json: { n: 3 } }]);

  const reduced = await run('return [{ json: { sum: items.reduce((acc, i) => acc + i.json.n, 0) } }]', [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.deepEqual(reduced.main, [{ json: { sum: 6 } }]);

  // forEach 无返回 → 透传输入
  const each = await run('items.forEach(i => i.json.n)', [{ n: 5 }]);
  assert.deepEqual(each.main, [{ json: { n: 5 } }]);

  const len = await run('return [{ json: { count: items.length } }]', [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(len.main, [{ json: { count: 2 } }]);

  // 括号包裹的单参 lambda：(i) => ...
  const paren = await run('return items.map((i) => ({ json: { v: i.json.n * 2 } }))', [{ n: 4 }]);
  assert.deepEqual(paren.main, [{ json: { v: 8 } }]);
});

test('Code：常量声明 + return（保持既有能力）', async () => {
  const r = await run('const x = 2 + 3; return x * 2', [{ n: 1 }]);
  assert.equal(r.ok, true);
  assert.equal((r.main[0].json as any).output, 10);
});

// —— 核心反例：失败必须显式，绝不能转成数据 ——

test('Code：不支持的语法（块体箭头）→ 节点 failed 且 error_message 非空', async () => {
  const r = await run('return items.map(i => { return i.json; })', [{ n: 1 }]);
  assert.equal(r.ok, false, '必须抛错（节点 failed），绝不能返回数据');
  assert.ok((r.error ?? '').length > 0, 'error_message 不能为空');
  assert.match(r.error!, /Code 节点求值失败/);
});

test('Code：不支持的语句（for 循环）→ 节点 failed 且错误可读', async () => {
  const r = await run('for (const x of items) { }', [{ n: 1 }]);
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').length > 0);
});

test('Code：未闭合括号等语法错误 → 显式失败', async () => {
  const r = await run('return items.map(i => ({ json: { v: i.json.n + 1 } }', [{ n: 1 }]);
  assert.equal(r.ok, false);
  assert.ok((r.error ?? '').length > 0);
});

test('Code：未知函数调用 → 显式失败（回归：__codeError 曾被改写为 output 数据）', async () => {
  const r = await run('return totallyUnknownFn(1)', [{ n: 1 }]);
  assert.equal(r.ok, false);
  assert.ok(!('main' in r), '失败时不得返回任何节点数据');
  assert.match(r.error!, /Code 节点求值失败/);
});

test('Code：错误信息指出受限求值器的能力边界（可行动）', async () => {
  const r = await run('while (n < 3) { }', [{ n: 1 }]);
  assert.equal(r.ok, false);
  assert.match(r.error!, /受限求值器/);
  assert.ok(/map/.test(r.error!) && /filter/.test(r.error!) && /reduce/.test(r.error!), '错误信息应列出支持的成员方法');
});
