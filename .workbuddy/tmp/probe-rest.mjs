// 实机探测：把前端 dist 抽取出的 方法+路径 逐条打到本地 workerd，
// 用状态码区分「已实现」（400/401/403/422/200/500）与「缺口」（404）。
// 只读探测：跳过登录/初始化等会改变实例状态的端点。
import { readFileSync } from 'node:fs';

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.PROBE_PWD || 'mini-flow-local-dev-password';

const SKIP = new Set([
  'POST /login', 'POST /logout', 'POST /owner/setup', 'GET /login',
  'POST /projects', 'POST /workflows', 'POST /credentials', 'POST /users',
  'POST /roles', 'POST /variables', 'POST /api-keys', 'POST /invitations',
  'POST /mfa/enable', 'POST /mfa/disable', 'POST /mfa/enforce-mfa',
  'POST /ldap/sync', 'POST /ldap/test-connection', 'PUT /ldap/config',
  'POST /license/activate', 'POST /quick-connect',
  'DELETE /community-packages', 'PATCH /community-packages',
  'POST /executions/delete', 'POST /executions/stopMany',
  'POST /secret-providers/connections', 'POST /external-secrets/settings',
  'POST /node-types', 'POST /node-types/by-identifier',
]);

const raw = readFileSync(new URL('./fe-api.txt', import.meta.url), 'utf8');
const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);

function normalize(spec) {
  let [method, ...rest] = spec.split(' ');
  let path = rest.join(' ');
  path = path.replace(/\$\{[^}]*\}?/g, 'probe123');   // 参数占位（含不闭合）
  path = path.split('?')[0];                          // 去查询串
  path = path.replace(/\/+$/, '') || '/';
  return `${method} ${path}`;
}

const items = [...new Set(lines.map(normalize))]
  .filter((s) => !SKIP.has(s) && !SKIP.has(s.replace(/\/probe123.*/, '')))
  .sort();

const login = await fetch(`${BASE}/rest/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: PASSWORD }),
});
if (!login.ok) { console.error('login failed', login.status); process.exit(1); }
const cookie = (login.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
console.log(`登录成功，探测 ${items.length} 条\n`);

const gaps = [], ok = [];
for (const spec of items) {
  const [method, path] = spec.split(' ');
  const hasBody = method === 'POST' || method === 'PATCH' || method === 'PUT';
  let status = 0, body = '';
  try {
    const res = await fetch(BASE + '/rest' + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: hasBody ? '{}' : undefined,
    });
    status = res.status;
    body = (await res.text()).slice(0, 200);
  } catch (e) { status = -1; body = String(e).slice(0, 80); }
  // 真缺口判据：命中 router 兜底 —— 响应体形如 "Not found: <METHOD> /rest/..."
  // 「已实现但资源不存在」的 404 文案是 "Workflow not found xxx" 之类，需排除。
  const isFallback404 = status === 404 && /^Not found: [A-Z]+ \/rest\//.test((() => {
    try { return String(JSON.parse(body).message ?? ''); } catch { return ''; }
  })());
  if (isFallback404) gaps.push({ spec, body });
  else ok.push({ spec, status });
}

console.log(`=== 缺口（404，${gaps.length} 条）===`);
for (const g of gaps) {
  const msg = (() => { try { return JSON.parse(g.body).message ?? ''; } catch { return ''; } })();
  console.log(`  ${g.spec}${msg ? '   // ' + msg.slice(0, 70) : ''}`);
}
console.log(`\n=== 已实现/其它（${ok.length} 条，按状态汇总）===`);
const byStatus = {};
for (const o of ok) (byStatus[o.status] ??= []).push(o.spec);
for (const [s, arr] of Object.entries(byStatus).sort()) console.log(`  [${s}] ${arr.length} 条`);
