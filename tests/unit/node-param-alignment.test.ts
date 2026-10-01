// tests/unit/node-param-alignment.test.ts
// REQ-16「参数名 ↔ 执行器读取键」对齐审计的可执行版本。
//
// 背景（设计 §5 第 7 条）：节点 properties[].name 必须与执行器实际读取的 p.<key> 对齐，
// 否则「面板能填但不生效」。这里按「编辑器真实写入的参数形态」驱动执行器：
//   * fixedCollection 的编辑器值形如 { <optionName>: [ {...} ] }
//   * json 型参数的编辑器值是「字符串」（需执行器 JSON.parse）
//
// 前半部分锁定已对齐节点（应通过）；后半部分锁定本轮发现的真实缺陷（当前会失败，
// 属「测试正确、实现有 bug」，路由给 Engineer 修复——不要为迁就实现而改断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setNode } from '../../src/nodes/if-condition';
import { switchNode, removeDuplicatesNode } from '../../src/nodes/logic';
import { sortNode, filterNode, aggregateNode, editFieldsNode, dateTimeNode } from '../../src/nodes/transform';
import { renameKeysNode, assignNode } from '../../src/nodes/util';
import type { NodeExecutionContext } from '../../src/types';

function ctx(type: string, parameters: Record<string, unknown>, main: Array<{ json: Record<string, unknown> }>): NodeExecutionContext {
  return {
    workflow: { name: 'w', nodes: [], connections: {} },
    executionId: 'e1',
    node: { type, name: 'n', parameters, typeVersion: 1, position: [0, 0] },
    inputData: { main },
    env: {} as never,
    log: () => {},
  } as unknown as NodeExecutionContext;
}

const rows = () => [
  { json: { a: 2 as number, x: 'b' } },
  { json: { a: 1 as number, x: 'a' } },
  { json: { a: 2 as number, x: 'b' } },
];

// ————————————————————————————————————————————————
// A. 已对齐节点（fixedCollection / 扁平键）：应通过
// ————————————————————————————————————————————————

test('对齐：set.assignments(fixedCollection) 生效', async () => {
  const out = await setNode.execute(ctx('n8n-nodes-base.set', { assignments: { assignments: [{ name: 'k', value: 'v' }] } }, rows()));
  assert.equal(out.main[0].json.k, 'v');
});

test('对齐：sort.rules(fixedCollection) 生效', async () => {
  const out = await sortNode.execute(ctx('n8n-nodes-base.sort', { rules: { rules: [{ field: 'a', type: 'ascending' }] } }, rows()));
  assert.deepEqual(out.main.map((r) => r.json.a), [1, 2, 2]);
});

test('对齐：filter.conditions(fixedCollection) + combinator 生效', async () => {
  const out = await filterNode.execute(ctx('n8n-nodes-base.filter', {
    conditions: { conditions: [{ leftValue: '{{ $json.a }}', operator: 'equals', rightValue: '1' }] }, combinator: 'and',
  }, rows()));
  assert.equal(out.main.length, 1);
  assert.equal(out.main[0].json.a, 1);
});

test('对齐：removeDuplicates.options.pairing(collection.fixedCollection) 生效', async () => {
  const out = await removeDuplicatesNode.execute(ctx('n8n-nodes-base.removeDuplicates', {
    options: { pairing: { pairing: [{ field1: 'a', field2: 'x' }] } },
  }, rows()));
  assert.equal(out.main.length, 2, '按 (a,x) 去重后应剩 2 条');
});

test('对齐：switch.rules.values(fixedCollection) 生效', async () => {
  const out = await switchNode.execute(ctx('n8n-nodes-base.switch', {
    mode: 'rules',
    rules: { values: [{ conditions: { conditions: [{ leftValue: '{{ $json.a }}', operator: 'equals', rightValue: '1' }] } }] },
  }, rows()));
  assert.equal(out.main.length, 1);
});

// ————————————————————————————————————————————————
// B. 本轮发现的真实缺陷（json 型参数未解析 / 读取键错位）：当前应失败
// ————————————————————————————————————————————————

test('[DEFECT-A1] aggregate.fields 为 json 型（字符串）：面板填写后应聚合生效', async () => {
  // 编辑器 json 型参数的值为字符串，执行器必须解析后再当数组用。
  const out = await aggregateNode.execute(ctx('n8n-nodes-base.aggregate', {
    fields: JSON.stringify([{ field: 'b', aggregation: 'sum' }]),
  }, [{ json: { b: 10 } }, { json: { b: 20 } }]));
  assert.equal(out.main[0].json.b, 30, 'json 型 fields 字符串应被解析并聚合为 30');
});

test('[DEFECT-A2] editFields.fields 为 json 型（字符串）：面板填写后应写入字段', async () => {
  const out = await editFieldsNode.execute(ctx('n8n-nodes-base.editFields', {
    fields: JSON.stringify([{ name: 'x', value: '1' }]),
  }, rows()));
  assert.equal(out.main[0].json.x, '1', 'json 型 fields 字符串应被解析并写入 x');
});

test('[DEFECT-A3] assign.assignments 为 json 型（字符串）：面板填写后应赋值', async () => {
  const out = await assignNode.execute(ctx('n8n-nodes-base.assign', {
    assignments: JSON.stringify([{ name: 'y', value: 9 }]),
  }, rows()));
  assert.equal(out.main[0].json.y, 9, 'json 型 assignments 字符串应被解析并赋值 y');
});

test('[DEFECT-A4] dateTime.additionalFields.add 为 json 型（字符串）：应做日期加减', async () => {
  const base = new Date('2020-01-01T00:00:00.000Z');
  const out = await dateTimeNode.execute(ctx('n8n-nodes-base.dateTime', {
    dateProperty: 'd',
    additionalFields: { add: JSON.stringify({ value: 1, unit: 'days' }) },
  }, [{ json: { d: base.toISOString() } }]));
  const result = new Date(String(out.main[0].json.result));
  assert.equal(result.toISOString(), '2020-01-02T00:00:00.000Z', 'json 型 add 字符串应被解析并 +1 天');
});

test('[DEFECT-A5] renameKeys.renaming(fixedCollection)：面板填写后不应抛错且应重命名', async () => {
  // fixedCollection 编辑器值为 { renaming: [ {fromKey,toKey} ] }；
  // 执行器当前把 p.renaming 当数组迭代 → "renames is not iterable" 崩溃。
  const out = await renameKeysNode.execute(ctx('n8n-nodes-base.renameKeys', {
    renaming: { renaming: [{ fromKey: 'a', toKey: 'z' }] },
  }, rows()));
  assert.ok('z' in out.main[0].json && !('a' in out.main[0].json), '应把字段 a 重命名为 z 且不抛错');
});
