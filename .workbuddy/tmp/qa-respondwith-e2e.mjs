// 第 2 轮实机（127.0.0.1:8787）：L-2 respondWith=text 真实回包 + 对照(默认 json) + L-3 tags DELETE
const B = 'http://127.0.0.1:8787';
let cookie = '';
async function req(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.noAuth) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.ct || 'application/x-www-form-urlencoded'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(B + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, ct: res.headers.get('content-type') || '', text };
}
const sfx = Date.now().toString(36);
async function buildFlow(name, path, respondParams) {
  const wf = {
    name, nodes: [
      { parameters: { path, httpMethod: 'POST', responseMode: 'responseNode' }, type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], id: 'wh', name: 'Webhook' },
      { parameters: { assignments: { assignments: [{ name: 'text', value: '你好世界-hello' }] } }, type: 'n8n-nodes-base.set', typeVersion: 1, position: [200, 0], id: 'st', name: 'Set' },
      { parameters: respondParams, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [400, 0], id: 'rs', name: 'Respond to Webhook' },
    ],
    connections: { Webhook: { main: [[{ node: 'Set', type: 'main', index: 0 }]] }, Set: { main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]] } },
    settings: {},
  };
  const c = await req('POST', '/rest/workflows', wf);
  console.log(`  [buildFlow ${name}] create=${c.status} body=${c.text.slice(0, 120)}`);
  let id = null;
  try { id = JSON.parse(c.text)?.data?.id; } catch { /* ignore */ }
  if (id) { const a = await req('POST', `/rest/workflows/${id}/activate`, {}); console.log(`  [buildFlow ${name}] activate=${a.status}`); }
  return id;
}
(async () => {
  const login = await fetch(B + '/rest/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'mini-flow-demo-password' }) });
  cookie = 'n8n-auth=' + /n8n-auth=([^;]+)/.exec(login.headers.get('set-cookie'))[1];

  const pText = `qa-text-${sfx}`;
  const idText = await buildFlow('qa-respondWith-text-' + sfx, pText, { respondWith: 'text', responseCode: 200 });
  const rText = await req('POST', `/webhook/${pText}`, { ping: 1 }, { noAuth: true });
  console.log(`[L-2 text] status=${rText.status} ct=${rText.ct} body=${JSON.stringify(rText.text).slice(0, 80)}`);
  console.log(`  => text/plain? ${/text\/plain/.test(rText.ct)}  体为纯文本(非JSON包裹)? ${rText.text === '你好世界-hello'}`);

  const pJson = `qa-json-${sfx}`;
  const idJson = await buildFlow('qa-respondWith-default-' + sfx, pJson, { responseCode: 201 });
  const rJson = await req('POST', `/webhook/${pJson}`, { ping: 1 }, { noAuth: true });
  console.log(`[L-2 默认json] status=${rJson.status} ct=${rJson.ct} body=${JSON.stringify(rJson.text).slice(0, 80)}`);
  console.log(`  => application/json? ${/application\/json/.test(rJson.ct)}  状态码=201? ${rJson.status === 201}`);

  // cleanup workflows
  for (const id of [idText, idJson]) if (id) await req('DELETE', `/rest/workflows/${id}`);

  // L-3 tags DELETE
  const delMissing = await req('DELETE', `/rest/tags/ghost-${sfx}`);
  const created = await req('POST', '/rest/tags', { name: `qa-tag-${sfx}` });
  console.log(`  [tags create] status=${created.status} body=${created.text.slice(0, 120)}`);
  let tid = null;
  try { tid = JSON.parse(created.text)?.data?.id; } catch { /* ignore */ }
  const delExisting = tid ? await req('DELETE', `/rest/tags/${tid}`) : { status: 'skip', ct: '', text: '' };
  console.log(`[L-3 tags] DELETE 不存在=${delMissing.status} (期望404)  ct=${delMissing.ct}`);
  console.log(`[L-3 tags] DELETE 存在=${delExisting.status} (期望200) body=${delExisting.text.slice(0, 40)}`);
})();
