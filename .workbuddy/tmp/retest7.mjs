// 第7轮：实机确认 P0 缺陷 2 —— last-successful 返回完整执行详情（前端 NDV 预览可用）
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
console.log('login:', login.status);

const id = 'p7-' + Date.now();
await req('POST', '/rest/workflows', {
  cookie,
  body: {
    id, name: 'p7', settings: {},
    nodes: [
      { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: 'return items.length >= 0 ? [{ json: { ok: true, tag: "ls-probe" } }] : []' } },
    ],
    connections: { Start: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] } },
  },
});

console.log('\n=== 场景 A：无成功执行时 last-successful 应返回 null ===');
{
  const r = await req('GET', `/rest/workflows/${id}/executions/last-successful`, { cookie });
  console.log('http:', r.status, '| header X-N8N-API-KEY-PRESENT-ish:', r.headers.get('x-instance-request-id') || '-');
  console.log('body:', JSON.stringify(r.json).slice(0, 300));
  console.log('期望: 200 且 data === null');
}

const run = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: { seed: 1 } } });
const eid = run.json?.data?.executionId;
let detail;
const t0 = Date.now();
while (Date.now() - t0 < 12000) {
  const d = await req('GET', `/rest/executions/${eid}`, { cookie });
  detail = d.json?.data;
  if (detail?.finished) break;
  await sleep(600);
}
console.log('\n执行完成:', eid, 'status=', detail?.status);

console.log('\n=== 场景 B：有成功执行时 last-successful 应返回完整详情（data.resultData.runData） ===');
{
  const r = await req('GET', `/rest/workflows/${id}/executions/last-successful`, { cookie });
  const d = r.json?.data;
  const runData = d?.data?.resultData?.runData;
  console.log('http:', r.status);
  console.log('顶层键:', d ? Object.keys(d).join(',') : '(null)');
  console.log('有 data.resultData.runData ?', !!runData);
  console.log('runData 节点:', runData ? Object.keys(runData).join(',') : '-');
  const db = runData?.CodeB?.[0];
  console.log('CodeB runData 键:', db ? Object.keys(db).join(',') : '-');
  console.log('CodeB 输出:', JSON.stringify(db?.data?.main?.[0]).slice(0, 200));
  console.log('有 workflowData ?', !!d?.workflowData, '| 节点数:', d?.workflowData?.nodes?.length);
  console.log('期望: runData 含 CodeB 且其 data.main 有 tag=ls-probe 的项；workflowData.nodes 非空');
}

await req('DELETE', `/rest/workflows/${id}`, { cookie });
console.log('\n清理完成');
