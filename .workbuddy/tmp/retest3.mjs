// 复测第三轮：IF(conditionSt) 正确形态 + 节点失败传播（轮询至终态）
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

async function runWf(name, nodes, connections, input, waitMs = 8000) {
  const id = 'p3-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const c = await req('POST', '/rest/workflows', { cookie, body: { id, name, nodes, connections, settings: {} } });
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: input } });
  const eid = r.json?.data?.executionId;
  let detail, logs;
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const raw = await req('GET', `/rest/executions/_debug/${eid}/raw`, { cookie });
    const d = await req('GET', `/rest/executions/${eid}`, { cookie });
    detail = d.json?.data; logs = raw.json?.data?.nodeLogs;
    if (detail?.finished) break;
    await sleep(700);
  }
  await req('DELETE', `/rest/workflows/${id}`, { cookie });
  return { id, eid, logs, detail, waited: Date.now() - t0 };
}

console.log('=== D2. IF node (conditionSt) n=5 期望走 true 分支 ===');
{
  const r = await runWf('if2', [
    { id: 'd1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'd2', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 1, position: [200, 0], parameters: { conditionSt: 'n == 5' } },
    { id: 'd3', name: 'TrueB', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, -100], parameters: { values: [{ name: 'hit', value: 'yes' }] } },
    { id: 'd4', name: 'FalseB', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, 100], parameters: { values: [{ name: 'hit', value: 'no' }] } },
  ], {
    Start: { main: [[{ node: 'If', type: 'main', index: 0 }]] },
    If: { main: [[{ node: 'TrueB', type: 'main', index: 0 }], [{ node: 'FalseB', type: 'main', index: 0 }]] },
  }, { n: 5 });
  console.log('status:', r.detail?.status, 'finished:', r.detail?.finished, 'waited:', r.waited + 'ms');
  console.log('logs:', JSON.stringify(r.logs?.map((l) => ({ n: l.node_name, s: l.status, out: l.output_data })), null, 1));
}

console.log('\n=== E2. 节点失败传播（HTTP 非法地址，轮询至终态）===');
{
  const r = await runWf('fail2', [
    { id: 'e1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'e2', name: 'Http', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [200, 0], parameters: { url: 'http://127.0.0.1:1/nope', method: 'GET' } },
    { id: 'e3', name: 'After', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, 0], parameters: { values: [{ name: 'x', value: '1' }] } },
  ], {
    Start: { main: [[{ node: 'Http', type: 'main', index: 0 }]] },
    Http: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
  }, {}, 15000);
  console.log('status:', r.detail?.status, 'finished:', r.detail?.finished, 'waited:', r.waited + 'ms');
  console.log('logs:', JSON.stringify(r.logs?.map((l) => ({ n: l.node_name, s: l.status, err: l.error_message })), null, 1));
  console.log('detail.error:', JSON.stringify(r.detail?.error));
}
