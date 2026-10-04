// 临时复现 2：按「编辑器实际写入的参数形态」喂给执行器，验证是否生效/是否崩溃
import { sortNode, filterNode, aggregateNode } from '../../src/nodes/transform';
import { setNode } from '../../src/nodes/if-condition';
import { switchNode, removeDuplicatesNode } from '../../src/nodes/logic';
import { renameKeysNode } from '../../src/nodes/util';
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

async function run(label: string, fn: () => Promise<any>) {
  try {
    const out = await fn();
    console.log(label, '-> OK', JSON.stringify(out.main));
  } catch (e) {
    console.log(label, '-> THROW', (e as Error).message);
  }
}

async function main() {
  const rows = [{ json: { a: 2, x: 'b' } }, { json: { a: 1, x: 'a' } }, { json: { a: 2, x: 'b' } }];
  await run('set(fixedCollection)', () => setNode.execute(ctx('n8n-nodes-base.set',
    { assignments: { assignments: [{ name: 'k', value: 'v' }] }, keepOnlySet: true }, rows)));
  await run('sort(fixedCollection)', () => sortNode.execute(ctx('n8n-nodes-base.sort',
    { rules: { rules: [{ field: 'a', type: 'ascending' }] } }, rows)));
  await run('filter(fixedCollection)', () => filterNode.execute(ctx('n8n-nodes-base.filter',
    { conditions: { conditions: [{ leftValue: '{{ $json.a }}', operator: 'equals', rightValue: '1' }] }, combinator: 'and' }, rows)));
  await run('removeDuplicates(collection.fixedCollection)', () => removeDuplicatesNode.execute(ctx('n8n-nodes-base.removeDuplicates',
    { options: { pairing: { pairing: [{ field1: 'a', field2: 'x' }] } } }, rows)));
  await run('switch(fixedCollection)', () => switchNode.execute(ctx('n8n-nodes-base.switch',
    { mode: 'rules', rules: { values: [{ conditions: { conditions: [{ leftValue: '{{ $json.a }}', operator: 'equals', rightValue: '1' }] } }] } }, rows)));
  await run('renameKeys(fixedCollection)', () => renameKeysNode.execute(ctx('n8n-nodes-base.renameKeys',
    { renaming: { renaming: [{ fromKey: 'a', toKey: 'z' }] } }, rows)));
}

main();
