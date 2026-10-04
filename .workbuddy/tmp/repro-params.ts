// 临时复现：验证 json 型参数（字符串值）在对应执行器中是否生效
import { aggregateNode, editFieldsNode, dateTimeNode } from '../../src/nodes/transform';
import { assignNode } from '../../src/nodes/util';
import type { NodeExecutionContext } from '../../src/types';

function ctx(type: string, parameters: Record<string, unknown>, main: any[]): NodeExecutionContext {
  return {
    workflow: { name: 'w', nodes: [], connections: {} },
    executionId: 'e1',
    node: { type, name: 'n', parameters, typeVersion: 1, position: [0, 0] },
    inputData: { main },
    env: {} as never,
    log: () => {},
  } as unknown as NodeExecutionContext;
}

const items = [{ json: { a: 1, b: 10 } }, { json: { a: 2, b: 20 } }];

async function main() {
  // 1) aggregate：面板 json 型给出的是字符串 '[...]'
  const aggStr = await aggregateNode.execute(ctx('n8n-nodes-base.aggregate', { fields: '[{"field":"b","aggregation":"sum"}]' }, items));
  console.log('aggregate(json-string) ->', JSON.stringify(aggStr.main));
  const aggArr = await aggregateNode.execute(ctx('n8n-nodes-base.aggregate', { fields: [{ field: 'b', aggregation: 'sum' }] }, items));
  console.log('aggregate(array)       ->', JSON.stringify(aggArr.main));

  // 2) editFields：json 型字符串
  const edStr = await editFieldsNode.execute(ctx('n8n-nodes-base.editFields', { fields: '[{"name":"x","value":"1"}]' }, items));
  console.log('editFields(json-string)->', JSON.stringify(edStr.main));
  const edArr = await editFieldsNode.execute(ctx('n8n-nodes-base.editFields', { fields: [{ name: 'x', value: '1' }] }, items));
  console.log('editFields(array)      ->', JSON.stringify(edArr.main));

  // 3) assign：json 型字符串
  const asStr = await assignNode.execute(ctx('n8n-nodes-base.assign', { assignments: '[{"name":"y","value":9}]' }, items));
  console.log('assign(json-string)    ->', JSON.stringify(asStr.main));
  const asArr = await assignNode.execute(ctx('n8n-nodes-base.assign', { assignments: [{ name: 'y', value: 9 }] }, items));
  console.log('assign(array)          ->', JSON.stringify(asArr.main));

  // 4) dateTime：additionalFields.add 为 json 型字符串
  const dtStr = await dateTimeNode.execute(ctx('n8n-nodes-base.dateTime', {
    dateProperty: '', additionalFields: { add: '{"value":1,"unit":"days"}' },
  }, [{ json: {} as Record<string, unknown> }]));
  console.log('dateTime(json-string)  ->', JSON.stringify(dtStr.main));
  const dtObj = await dateTimeNode.execute(ctx('n8n-nodes-base.dateTime', {
    dateProperty: '', additionalFields: { add: { value: 1, unit: 'days' } },
  }, [{ json: {} as Record<string, unknown> }]));
  console.log('dateTime(object)       ->', JSON.stringify(dtObj.main));
}

main();
