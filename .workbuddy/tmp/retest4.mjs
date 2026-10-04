// 第4轮：实证 QA 发现的 F1（items 检测正则过宽 → 静默丢项）+ 多输入项 live E2E
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

async function run(nodes, connections, input) {
  const id = 'p4-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await req('POST', '/rest/workflows', { cookie, body: { id, name: 'p4', nodes, connections, settings: {} } });
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: input } });
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
  return { logs: raw?.json?.data?.nodeLogs, status: detail?.status };
}

function parse(logs, name) {
  const l = (logs || []).find((x) => x.node_name === name);
  if (!l) return null;
  try { return JSON.parse(l.output_data); } catch { return l.output_data; }
}

console.log('=== F1 复现：上游产出 3 项 → CodeB `return json.items;`（字段访问，非内置）===');
{
  const r = await run([
    { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: 'return [1,2,3].map(x => ({ json: { items: [x, x] } }))' } },
    { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 0], parameters: { javascriptCode: 'return json.items;' } },
  ], {
    Start: { main: [[{ node: 'CodeA', type: 'main', index: 0 }]] },
    CodeA: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] },
  }, { seed: 0 });
  console.log('execStatus:', r.status);
  const a = parse(r.logs, 'CodeA');
  const b = parse(r.logs, 'CodeB');
  console.log('CodeA 项数:', a?.main?.length, JSON.stringify(a?.main));
  console.log('CodeB 项数:', b?.main?.length, JSON.stringify(b?.main));
  console.log('期望 CodeB 项数 = 3；若为 2 → F1 成立（静默丢项）');
}

console.log('\n=== 对照：CodeB `return n * 2;`（代码不含 items 字样）===');
{
  const r = await run([
    { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: 'return [1,2,3].map(x => ({ json: { n: x } }))' } },
    { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 0], parameters: { javascriptCode: 'return n * 2;' } },
  ], {
    Start: { main: [[{ node: 'CodeA', type: 'main', index: 0 }]] },
    CodeA: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] },
  }, { seed: 0 });
  console.log('execStatus:', r.status);
  console.log('CodeB 项数:', parse(r.logs, 'CodeB')?.main?.length, JSON.stringify(parse(r.logs, 'CodeB')?.main));
}

console.log('\n=== 多输入项 live E2E（QA 存疑点 2）：CodeA 3 项 → 内置 items.map ===');
{
  const r = await run([
    { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: 'return [1,2,3].map(x => ({ json: { n: x } }))' } },
    { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 0], parameters: { javascriptCode: 'return items.map(i => ({ json: { v: i.json.n * 10 } }))' } },
  ], {
    Start: { main: [[{ node: 'CodeA', type: 'main', index: 0 }]] },
    CodeA: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] },
  }, { seed: 0 });
  console.log('execStatus:', r.status);
  console.log('CodeB 项数:', parse(r.logs, 'CodeB')?.main?.length, JSON.stringify(parse(r.logs, 'CodeB')?.main));
  console.log('期望 3 项 v=10/20/30');
}
