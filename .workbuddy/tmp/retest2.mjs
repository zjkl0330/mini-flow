// 复测第二轮：Code 节点静默失败 / IF 分支 / 节点失败传播 / last-successful 载荷
const BASE = 'http://127.0.0.1:8787';
const PWD = 'mini-flow-local-dev-password';
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

async function runWf(name, nodes, connections, input) {
  const id = 'p2-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const c = await req('POST', '/rest/workflows', { cookie, body: { id, name, nodes, connections, settings: {} } });
  if (c.status !== 201) return { err: 'create ' + c.status + ' ' + c.text.slice(0, 120) };
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: input } });
  if (r.status !== 200) return { err: 'run ' + r.status + ' ' + r.text.slice(0, 160) };
  const eid = r.json.data.executionId;
  const raw = await req('GET', `/rest/executions/_debug/${eid}/raw`, { cookie });
  const detail = await req('GET', `/rest/executions/${eid}`, { cookie });
  const ls = await req('GET', `/rest/workflows/${id}/executions/last-successful`, { cookie });
  await req('DELETE', `/rest/workflows/${id}`, { cookie });
  return { id, eid, logs: raw.json?.data?.nodeLogs, execStatus: detail.json?.data?.status, detail: detail.json?.data, lastSuccessful: ls.json?.data };
}

console.log('=== A. Code 节点：不支持的语法（箭头函数）===');
{
  const r = await runWf('code-arrow', [
    { id: 'a1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'a2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { jsCode: 'return items.map(i => ({ json: { v: i.json.n + 1 } }));' } },
  ], { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } }, { n: 1 });
  console.log('execStatus:', r.execStatus);
  console.log('node logs:', JSON.stringify(r.logs?.map(l => ({ n: l.node_name, s: l.status, out: l.output_data })), null, 1));
}

console.log('\n=== A2. Code 节点：受支持的表达式（应正常）===');
{
  const r = await runWf('code-ok', [
    { id: 'b1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { jsCode: 'return n + 1' } },
  ], { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } }, { n: 41 });
  console.log('execStatus:', r.execStatus);
  console.log('node logs:', JSON.stringify(r.logs?.map(l => ({ n: l.node_name, s: l.status, out: l.output_data })), null, 1));
}

console.log('\n=== C. last-successful 载荷是否含 data.resultData.runData ===');
{
  const r = await runWf('ls-shape', [
    { id: 'c1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
  ], {}, { hello: 'world' });
  console.log('lastSuccessful:', JSON.stringify(r.lastSuccessful));
  console.log('含 data.resultData.runData ?', !!(r.lastSuccessful && r.lastSuccessful.data && r.lastSuccessful.data.resultData && r.lastSuccessful.data.resultData.runData));
}

console.log('\n=== D. IF 节点分支 ===');
{
  const r = await runWf('if-branch', [
    { id: 'd1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'd2', name: 'If', type: 'n8n-nodes-base.if', typeVersion: 1, position: [200, 0], parameters: { conditions: { string: [{ value1: '={{ $json.n }}', operation: 'equal', value2: '5' }] } } },
    { id: 'd3', name: 'TrueBranch', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, -100], parameters: { values: [{ name: 'hit', value: 'yes' }] } },
    { id: 'd4', name: 'FalseBranch', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, 100], parameters: { values: [{ name: 'hit', value: 'no' }] } },
  ], {
    Start: { main: [[{ node: 'If', type: 'main', index: 0 }]] },
    If: { main: [[{ node: 'TrueBranch', type: 'main', index: 0 }], [{ node: 'FalseBranch', type: 'main', index: 0 }]] },
  }, { n: 5 });
  console.log('execStatus:', r.execStatus);
  console.log('node logs:', JSON.stringify(r.logs?.map(l => ({ n: l.node_name, s: l.status, out: l.output_data })), null, 1));
}

console.log('\n=== E. 节点失败传播（HTTP 请求非法 URL）===');
{
  const r = await runWf('fail-prop', [
    { id: 'e1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'e2', name: 'Http', type: 'n8n-nodes-base.httpRequest', typeVersion: 1, position: [200, 0], parameters: { url: 'http://127.0.0.1:1/nope', method: 'GET' } },
    { id: 'e3', name: 'After', type: 'n8n-nodes-base.set', typeVersion: 1, position: [400, 0], parameters: { values: [{ name: 'x', value: '1' }] } },
  ], {
    Start: { main: [[{ node: 'Http', type: 'main', index: 0 }]] },
    Http: { main: [[{ node: 'After', type: 'main', index: 0 }]] },
  }, {});
  console.log('execStatus:', r.execStatus);
  console.log('node logs:', JSON.stringify(r.logs?.map(l => ({ n: l.node_name, s: l.status, err: l.error_message })), null, 1));
  console.log('detail.error:', JSON.stringify(r.detail?.error));
}
