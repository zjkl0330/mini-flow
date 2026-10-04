// QA 实机验证：responseMode=responseNode 的 HTTP 回包（真实 wrangler dev + 真实 flow engine）
const B = 'http://127.0.0.1:8787';
let cookie = '';
const log = (...a) => console.log(...a);

async function req(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.noAuth) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.ct || 'application/x-www-form-urlencoded'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(B + path, { method, headers, body: payload, redirect: 'manual' });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let data; try { data = ct.includes('json') ? JSON.parse(text) : text.slice(0, 200); } catch { data = text.slice(0, 200); }
  return { status: res.status, ct, data, raw: text };
}

const suffix = Date.now().toString(36);
const path = `qa-resp-${suffix}`;

// login
{
  const r = await req('POST', '/rest/login', { email: 'admin@example.com', password: 'mini-flow-demo-password' }, { noAuth: true });
  const sc = r.headers ? r : null;
  const setc = r.res?.headers?.get('set-cookie');
  // fallback: 重新读取
  let cookieStr = setc;
  if (!cookieStr) {
    const raw = await fetch(B + '/rest/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'mini-flow-demo-password' }) });
    cookieStr = raw.headers.get('set-cookie');
  }
  const m = /n8n-auth=([^;]+)/.exec(cookieStr || '');
  cookie = m ? `n8n-auth=${m[1]}` : '';
  log(`[login] status=${r.status} cookie=${cookie ? 'OK' : 'FAIL'}`);
  void sc;
}

let wfId;
{
  const wf = {
    name: `qa-responseNode-${suffix}`,
    nodes: [
      { parameters: { path, httpMethod: 'POST', responseMode: 'responseNode' }, type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], id: 'wh', name: 'Webhook' },
      { parameters: { respondWith: 'allIncomingItems', responseCode: 202 }, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [240, 0], id: 'rs', name: 'Respond to Webhook' },
    ],
    connections: { Webhook: { main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]] } },
    settings: {},
  };
  const c = await req('POST', '/rest/workflows', wf);
  wfId = c.data?.data?.id;
  const act = wfId ? await req('POST', `/rest/workflows/${wfId}/activate`, {}) : {};
  log(`[create+activate] create=${c.status} id=${wfId} active=${act.data?.data?.active}`);
}

if (wfId) {
  const t0 = Date.now();
  const res = await req('POST', `/webhook/${path}`, { ping: '你好', n: 7 }, { noAuth: true });
  const dt = Date.now() - t0;
  log(`[responseNode] POST /webhook/${path} -> status=${res.status} ct=${res.ct} dt=${dt}ms`);
  log(`   body(前200)=${JSON.stringify(res.data).slice(0, 200)}`);
  const isStartedPlaceholder = typeof res.data === 'object' && res.data && res.data.message === 'Workflow was started';
  log(`   回包是 started 占位? ${isStartedPlaceholder}  | 遥测目标状态码 202? ${res.status === 202}`);

  // 等待执行落库 & 查看状态
  await new Promise((r) => setTimeout(r, 3000));
  const det = await req('GET', `/rest/executions?workflowId=${wfId}&limit=3`);
  const rows = det.data?.data?.results ?? [];
  log(`[execution] 该流执行数=${rows.length} 最新 status=${rows[0]?.status} mode=${rows[0]?.mode}`);

  // cleanup
  const del = await req('DELETE', `/rest/workflows/${wfId}`);
  log(`[cleanup] DELETE workflow -> ${del.status}`);
}
