// 第9轮：F3 终验补充 —— ① 逆向护栏（守卫不得泄露到整批模式）② 边界对抗
const BASE = 'http://127.0.0.1:8787';
const PWD = 'mini-flow-local-dev-password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
}
const login = await req('POST', '/rest/login', { body: { emailOrLdapLoginId: 'admin@example.com', password: PWD } });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

async function run(nInputs, bCode) {
  const id = 'p9-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const mk = Array.from({ length: nInputs }, (_, i) => `{ json: { n: ${i + 1} } }`).join(',');
  await req('POST', '/rest/workflows', {
    cookie,
    body: {
      id, name: 'p9', settings: {},
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: `return items.length >= 0 ? [${mk}] : [];` } },
        { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 0], parameters: { javascriptCode: bCode } },
      ],
      connections: {
        Start: { main: [[{ node: 'CodeA', type: 'main', index: 0 }]] },
        CodeA: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] },
      },
    },
  });
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: {} } });
  const eid = r.json?.data?.executionId;
  let raw, detail;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    raw = await req('GET', `/rest/executions/_debug/${eid}/raw`, { cookie });
    const d = await req('GET', `/rest/executions/${eid}`, { cookie });
    detail = d.json?.data;
    if (detail?.finished) break;
    await sleep(600);
  }
  await req('DELETE', `/rest/workflows/${id}`, { cookie });
  const logs = raw?.json?.data?.nodeLogs || [];
  const a = logs.find((x) => x.node_name === 'CodeA');
  const b = logs.find((x) => x.node_name === 'CodeB');
  const p = (v) => { try { return JSON.parse(v); } catch { return v; } };
  return { execStatus: detail?.status, aOut: p(a?.output_data)?.main?.length, bStatus: b?.status, bErr: b?.error_message, bOut: p(b?.output_data)?.main };
}

async function check(label, nInputs, bCode, expect) {
  const r = await run(nInputs, bCode);
  const n = r.bOut?.length;
  const ok = expect(r, n);
  console.log(
    `${ok ? '✅' : '❌'} ${label}\n   输入 ${nInputs} 项 | CodeB status=${r.bStatus} | CodeB 项数=${n} | exec=${r.execStatus}` +
    `\n   输出=${JSON.stringify(r.bOut)}${r.bErr ? '\n   err=' + r.bErr.slice(0, 120) : ''}`,
  );
}

console.log('=== ① 逆向护栏：整批模式下 `return []` 应仍为 0 项（守卫不得泄露）===');
await check('整批模式 (含内置 items) return [] ，3 输入', 3, 'return items.length >= 0 ? [] : [];', (r, n) => n === 0);
await check('整批模式 (含内置 items) return [] ，1 输入', 1, 'return items.length >= 0 ? [] : [];', (r, n) => n === 0);
await check('整批对照：整批模式 return items（3 输入）→ 3 项', 3, 'return items;', (r, n) => n === 3);

console.log('\n=== ② 逐项模式空数组：项数必须等于输入数 ===');
await check('逐项 `return [];`，1 输入 → 1 项', 1, 'return [];', (r, n) => n === 1 && JSON.stringify(r.bOut?.[0]) === JSON.stringify({ json: { n: 1, output: [] } }));
await check('逐项 `return [];`，3 输入 → 3 项', 3, 'return [];', (r, n) => n === 3);
await check('逐项 `return [];`，5 输入 → 5 项', 5, 'return [];', (r, n) => n === 5);

console.log('\n=== ③ 其它边界（逐项、3 输入）===');
await check('`return [{ json: { a: 1 } }];` → N×1 = 3 项', 3, 'return [{ json: { a: 1 } }];', (r, n) => n === 3);
await check('`return { json: {} };`（item 形态空 json）→ 3 项', 3, 'return { json: {} };', (r, n) => n === 3);
await check("`return 'x';`（标量）→ 3 项 output:'x'", 3, "return 'x';", (r, n) => n === 3);
await check('`return 0;`（假值标量）→ 3 项', 3, 'return 0;', (r, n) => n === 3);
await check('`return null;`（null）→ 透传 3 项', 3, 'return null;', (r, n) => n === 3);
await check('`return;`（undefined）→ 透传 3 项', 3, 'return;', (r, n) => n === 3);
