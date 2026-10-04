// 第 2 轮独立复现：5 缺陷修复 + 边界 + 死控件行为回归（不依赖测试套件，直接驱动执行器）
import { renameKeysNode, assignNode } from '../../src/nodes/util';
import { aggregateNode, editFieldsNode, dateTimeNode } from '../../src/nodes/transform';
import { setNode } from '../../src/nodes/if-condition';
import { respondToWebhookNode } from '../../src/nodes/logic';
import { asJsonArray, asJsonRecord } from '../../src/nodes/common';
import type { NodeExecutionContext } from '../../src/types';

let pass = 0; let fail = 0;
function check(label: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
}

function ctx(type: string, parameters: Record<string, unknown>, main: any[]): NodeExecutionContext {
  return {
    workflow: { name: 'w', nodes: [], connections: {} },
    executionId: 'e1',
    node: { type, name: 'n', parameters, typeVersion: 1, position: [0, 0] },
    inputData: { main }, env: {} as never, log: () => {},
  } as unknown as NodeExecutionContext;
}
async function safe(fn: () => Promise<any>): Promise<{ ok: boolean; out?: any; err?: string }> {
  try { return { ok: true, out: await fn() }; } catch (e) { return { ok: false, err: (e as Error).message }; }
}
const rows = () => [{ json: { a: 2, x: 'b' } }, { json: { a: 1, x: 'a' } }, { json: { a: 2, x: 'b' } }];

async function main() {
  console.log('== DEF-1 renameKeys ==');
  for (const [label, params] of [
    ['fixedCollection', { renaming: { renaming: [{ fromKey: 'a', toKey: 'z' }] } }],
    ['legacy renaming[]', { renaming: [{ fromKey: 'a', toKey: 'z' }] }],
    ['legacy renameKeys[]', { renameKeys: [{ fromKey: 'a', toKey: 'z' }] }],
  ] as Array<[string, any]>) {
    const r = await safe(() => renameKeysNode.execute(ctx('n8n-nodes-base.renameKeys', params, rows())));
    check(`${label} 不抛错且改名`, r.ok && r.out.main[0].json.z === 2 && !('a' in r.out.main[0].json), JSON.stringify(r));
  }
  for (const [label, params] of [
    ['renaming:"abc"(畸形)', { renaming: 'abc' }],
    ['renaming:null(畸形)', { renaming: null }],
    ['renaming:123(畸形)', { renaming: 123 }],
  ] as Array<[string, any]>) {
    const r = await safe(() => renameKeysNode.execute(ctx('n8n-nodes-base.renameKeys', params, rows())));
    check(`${label} 不崩溃且原样透传`, r.ok && r.out.main.length === 3, JSON.stringify(r));
  }

  console.log('== DEF-2 aggregate.fields ==');
  {
    const str = await safe(() => aggregateNode.execute(ctx('n8n-nodes-base.aggregate', { fields: '[{"field":"b","aggregation":"sum"}]' }, [{ json: { b: 10 } }, { json: { b: 20 } }])));
    check('json 字符串生效(sum=30)', str.ok && str.out.main[0].json.b === 30, JSON.stringify(str));
    const arr = await safe(() => aggregateNode.execute(ctx('n8n-nodes-base.aggregate', { fields: [{ field: 'b', aggregation: 'sum' }] }, [{ json: { b: 10 } }, { json: { b: 20 } }])));
    check('已解析数组仍生效(不回归)', arr.ok && arr.out.main[0].json.b === 30, JSON.stringify(arr));
    const bad = await safe(() => aggregateNode.execute(ctx('n8n-nodes-base.aggregate', { fields: '{oops' }, [{ json: { b: 10 } }])));
    check('非法 JSON 不崩溃(安全降级)', bad.ok, JSON.stringify(bad));
  }

  console.log('== DEF-3 editFields.fields ==');
  {
    const str = await safe(() => editFieldsNode.execute(ctx('n8n-nodes-base.editFields', { fields: '[{"name":"x","value":"1"}]' }, rows())));
    check('json 字符串生效(x=1)', str.ok && str.out.main[0].json.x === '1', JSON.stringify(str));
    const arr = await safe(() => editFieldsNode.execute(ctx('n8n-nodes-base.editFields', { fields: [{ name: 'x', value: '1' }] }, rows())));
    check('已解析数组仍生效', arr.ok && arr.out.main[0].json.x === '1', JSON.stringify(arr));
    const bad = await safe(() => editFieldsNode.execute(ctx('n8n-nodes-base.editFields', { fields: '{oops' }, rows())));
    check('非法 JSON 不崩溃', bad.ok, JSON.stringify(bad));
  }

  console.log('== DEF-4 assign.assignments ==');
  {
    const str = await safe(() => assignNode.execute(ctx('n8n-nodes-base.assign', { assignments: '[{"name":"y","value":9}]' }, rows())));
    check('json 字符串生效(y=9)', str.ok && str.out.main[0].json.y === 9, JSON.stringify(str));
    const arr = await safe(() => assignNode.execute(ctx('n8n-nodes-base.assign', { assignments: [{ name: 'y', value: 9 }] }, rows())));
    check('已解析数组仍生效', arr.ok && arr.out.main[0].json.y === 9, JSON.stringify(arr));
    const bad = await safe(() => assignNode.execute(ctx('n8n-nodes-base.assign', { assignments: '{oops' }, rows())));
    check('非法 JSON 不崩溃', bad.ok, JSON.stringify(bad));
  }

  console.log('== DEF-5 dateTime.additionalFields.add ==');
  {
    const base = '2020-01-01T00:00:00.000Z';
    const mk = (add: unknown) => dateTimeNode.execute(ctx('n8n-nodes-base.dateTime', { dateProperty: 'd', additionalFields: { add } }, [{ json: { d: base } }]));
    const str = await safe(() => mk('{"value":1,"unit":"days"}'));
    check('json 字符串生效(+1天)', str.ok && new Date(str.out.main[0].json.result).toISOString() === '2020-01-02T00:00:00.000Z', JSON.stringify(str));
    const obj = await safe(() => mk({ value: 1, unit: 'days' }));
    check('已解析对象仍生效', obj.ok && new Date(obj.out.main[0].json.result).toISOString() === '2020-01-02T00:00:00.000Z', JSON.stringify(obj));
    const bad = await safe(() => mk('{oops'));
    check('非法 JSON 不崩溃(不减)', bad.ok, JSON.stringify(bad));
    // additionalFields 整体为 json 字符串（防御）
    const whole = await safe(() => dateTimeNode.execute(ctx('n8n-nodes-base.dateTime', { dateProperty: 'd', additionalFields: '{"add":{"value":2,"unit":"days"}}' }, [{ json: { d: base } }])));
    check('additionalFields 整体字符串也可解析(+2天)', whole.ok && new Date(whole.out.main[0].json.result).toISOString() === '2020-01-03T00:00:00.000Z', JSON.stringify(whole));
  }

  console.log('== asJsonArray / asJsonRecord 边界 ==');
  const aa: Array<[unknown, unknown[] | null]> = [
    [[1, 2], [1, 2]], ['[1,2]', [1, 2]], ['', null], ['   ', null], ['{oops', null],
    ['1', null], ['"s"', null], ['true', null], ['null', null], ['null', null],
    [null, null], [undefined, null], [123, null], [{}, null], ['{"a":1}', null], ['[[1],[2]]', [[1], [2]]],
  ];
  for (const [input, expected] of aa) {
    const got = asJsonArray(input);
    check(`asJsonArray(${JSON.stringify(input)})`, JSON.stringify(got) === JSON.stringify(expected), `got=${JSON.stringify(got)}`);
  }
  const ar: Array<[unknown, Record<string, unknown> | null]> = [
    [{ a: 1 }, { a: 1 }], ['{"a":1}', { a: 1 }], ['[1,2]', null], ['1', null], ['', null],
    ['{oops', null], ['null', null], [null, null], [undefined, null], ['true', null], [[1], null],
  ];
  for (const [input, expected] of ar) {
    const got = asJsonRecord(input);
    check(`asJsonRecord(${JSON.stringify(input)})`, JSON.stringify(got) === JSON.stringify(expected), `got=${JSON.stringify(got)}`);
  }

  console.log('== L-1 set.keepOnlySet 行为回归 ==');
  {
    const input = [{ json: { a: 2, x: 'b' } }];
    const on = await setNode.execute(ctx('n8n-nodes-base.set', { assignments: { assignments: [{ name: 'k', value: 'v' }] }, keepOnlySet: true }, input));
    check('keepOnlySet:true 仅保留写入字段', on.main[0].json.k === 'v' && !('a' in on.main[0].json) && !('x' in on.main[0].json), JSON.stringify(on));
    const dflt = await setNode.execute(ctx('n8n-nodes-base.set', { assignments: { assignments: [{ name: 'k', value: 'v' }] } }, input));
    check('默认(false) 等价于修复前：保留原字段并合并写入', dflt.main[0].json.a === 2 && dflt.main[0].json.x === 'b' && dflt.main[0].json.k === 'v', JSON.stringify(dflt));
    const off = await setNode.execute(ctx('n8n-nodes-base.set', { assignments: { assignments: [{ name: 'k', value: 'v' }] }, keepOnlySet: false }, input));
    check('keepOnlySet:false 同默认', JSON.stringify(off.main) === JSON.stringify(dflt.main), JSON.stringify(off));
  }

  console.log('== L-2 respondToWebhook.respondWith ==');
  {
    const input = [{ json: { text: '你好', n: 1 } }, { json: { text: 'x' } }];
    const text = await respondToWebhookNode.execute(ctx('n8n-nodes-base.respondToWebhook', { respondWith: 'text' }, input));
    check('text 模式 → {text:首个输入项.text}', text.main.length === 1 && text.main[0].json.text === '你好', JSON.stringify(text));
    const dflt = await respondToWebhookNode.execute(ctx('n8n-nodes-base.respondToWebhook', {}, input));
    check('默认(allIncomingItems) → 原样透传（与修复前一致）', JSON.stringify(dflt.main) === JSON.stringify(input), JSON.stringify(dflt));
    const json = await respondToWebhookNode.execute(ctx('n8n-nodes-base.respondToWebhook', { respondWith: 'json' }, input));
    check('json 模式 → 原样透传（与修复前一致）', JSON.stringify(json.main) === JSON.stringify(input), JSON.stringify(json));
  }

  console.log(`\nSUMMARY pass=${pass} fail=${fail}`);
}

main();
