// QA 实机探测：REST 边界（对 127.0.0.1:8787）
const B = 'http://127.0.0.1:8787';
let cookie = '';
async function raw(method, path, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookie && !opts.noAuth) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.ct || 'application/json'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(B + path, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, ct: res.headers.get('content-type') || '', text };
}
(async () => {
  const login = await fetch(B + '/rest/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'mini-flow-demo-password' }) });
  cookie = 'n8n-auth=' + /n8n-auth=([^;]+)/.exec(login.headers.get('set-cookie'))[1];

  const cases = [];
  cases.push(['retry 不存在', await raw('POST', '/rest/executions/nope-xyz/retry', {})]);
  cases.push(['export 不存在', await raw('GET', '/rest/workflows/nope-xyz/export')]);
  cases.push(['import 空 body', await raw('POST', '/rest/workflows/import', '')]);
  cases.push(['import 非法 JSON', await raw('POST', '/rest/workflows/import', '{bad')]);
  cases.push(['tags 空 name', await raw('POST', '/rest/tags', { name: '   ' })]);
  cases.push(['tags PATCH 不存在', await raw('PATCH', '/rest/tags/nope-xyz', { name: 'x' })]);
  cases.push(['tags DELETE 不存在', await raw('DELETE', '/rest/tags/nope-xyz')]);
  cases.push(['community 空 name', await raw('POST', '/rest/community-nodes', { name: '' })]);
  cases.push(['community uninstall 不存在', await raw('POST', '/rest/community-nodes/ghost-pkg/uninstall', {})]);
  cases.push(['insights 非法日期', await raw('GET', '/rest/insights/summary?startDate=abc&endDate=xxx')]);
  cases.push(['未知 /rest/*', await raw('GET', '/rest/no-such-zzz')]);
  cases.push(['匿名 /workflows', await raw('GET', '/rest/workflows', undefined, { noAuth: true })]);

  for (const [label, r] of cases) {
    console.log(`${label.padEnd(24)} -> ${r.status}  ${r.ct.includes('json') ? r.text.slice(0, 90) : '(non-json)'}`);
  }
})();
