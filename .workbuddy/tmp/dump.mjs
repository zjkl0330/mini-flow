// 深挖：执行详情结构 + workflow-history 真实工作流行为
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
console.log('login:', login.status, 'cookie?', !!cookie);

const wfId = 'dump-' + Date.now();
const wf = {
  id: wfId, name: 'dump wf',
  nodes: [
    { id: 'n1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'n2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { jsCode: 'return items.map(i => ({ json: { value: (i.json.n || 1) + 1 } }));' } },
  ],
  connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
  settings: {},
};
await req('POST', '/rest/workflows', { cookie, body: wf });
const run = await req('POST', `/rest/workflows/${wfId}/run`, { cookie, body: { data: { n: 41 } } });
const execId = run.json?.data?.executionId;
console.log('run:', run.status, 'execId:', execId);

const raw = await req('GET', `/rest/executions/_debug/${execId}/raw`, { cookie });
console.log('\n--- node_executions ---');
console.log(JSON.stringify(raw.json?.data?.nodeLogs, null, 2));

const detail = await req('GET', `/rest/executions/${execId}`, { cookie });
console.log('\n--- detail: runData keys ---');
console.log(Object.keys(detail.json?.data?.data?.resultData?.runData || {}));
console.log('\n--- detail runData full ---');
console.log(JSON.stringify(detail.json?.data?.data?.resultData?.runData, null, 2).slice(0, 2500));

console.log('\n--- workflow-history (真实存在的 workflow) ---');
const wh = await req('GET', `/rest/workflow-history/workflow/${wfId}`, { cookie });
console.log('status:', wh.status, JSON.stringify(wh.json).slice(0, 400));
const whv = await req('GET', `/rest/workflow-history/workflow/${wfId}/versions`, { cookie });
console.log('versions status:', whv.status, JSON.stringify(whv.json).slice(0, 400));

console.log('\n--- last-successful ---');
const ls = await req('GET', `/rest/workflows/${wfId}/executions/last-successful`, { cookie });
console.log('status:', ls.status, JSON.stringify(ls.json).slice(0, 300));

await req('DELETE', `/rest/workflows/${wfId}`, { cookie });
