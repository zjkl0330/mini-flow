import { codeNode } from './src/nodes/code-node';
function ctxFor(code: string, items: Array<{ json: any }>) {
  const n = { parameters: { javascriptCode: code }, name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [0, 0] };
  return { workflow: { name: 'wf', nodes: [n], connections: {} }, executionId: 'e', node: n, inputData: { main: items }, env: {}, log: () => {} } as never;
}
async function run(code: string, jsons: any[]) {
  try { const out = await codeNode.execute(ctxFor(code, jsons.map((j) => ({ json: j })))); return { ok: true, count: out.main.length, main: out.main }; }
  catch (e) { return { ok: false, count: -1, err: e instanceof Error ? e.message : String(e) }; }
}
const three = [{ a: 1 }, { a: 2 }, { a: 3 }];
const itemsThree = [{ items: [1, 2] }, { items: [3, 4] }, { items: [5, 6] }];
(async () => {
  const cases: Array<[string, string, any[], string]> = [
    ['[1] json.items', 'return json.items;', itemsThree, 'per-item 3'],
    ['[2] $json.items', 'return $json.items;', itemsThree, 'per-item 3'],
    ['[3] json . items', 'return json . items;', itemsThree, 'per-item 3'],
    ['[4] objkey { items: 1 }', 'return { items: 1 };', three, 'per-item 3'],
    ['[5] string items', "return 'has items here';", three, 'per-item 3'],
    ['[6] spread ...$input', 'return [{ json: { ...$input.first().json, extra: true } }];', three, 'batch 1'],
    ['[7a] builtin items', 'return items;', three, 'batch 3'],
    ['[7b] builtin items.map', 'return items.map(i => i.json);', three, 'batch 3'],
    ['[7c] builtin items.length', 'return items.length;', three, 'batch 1'],
    ['N×M 3in×3data', 'return [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }];', three, 'expect 9'],
    ['[1,2] x3in', 'return [1, 2];', three, 'per-item 3, output:[1,2]'],
    ['EMPTY [] x3in', 'return [];', three, '???'],
  ];
  for (const [label, code, jsons, note] of cases) {
    const r: any = await run(code, jsons);
    const detail = r.ok ? 'count=' + r.count + ' | ' + JSON.stringify(r.main) : 'ERR=' + r.err;
    console.log(label.padEnd(26), 'in=' + jsons.length, '| note:', note.padEnd(22), '=>', detail);
  }
})();
