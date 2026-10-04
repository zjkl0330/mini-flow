// 端到端复测探针：安全面 / REST 契约面 / 执行引擎
// 用法：node .workbuddy/tmp/retest.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const PWD = process.env.PWD_ || 'mini-flow-local-dev-password';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  FAIL  ${name}  ${detail}`); }
}

async function req(method, path, { cookie, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html/other */ }
  return { status: res.status, text, json, headers: res.headers, raw };
}

function section(t) { console.log(`\n=== ${t} ===`); }

async function main() {
  // ---------- 1. 登录 ----------
  section('1. 登录契约');
  const bad = await req('POST', '/rest/login', { body: { emailOrLdapLoginId: 'admin@example.com', password: 'wrong-password-123' } });
  ok('错误口令 → 401', bad.status === 401, `got ${bad.status}`);

  const noUser = await req('POST', '/rest/login', { body: { emailOrLdapLoginId: 'nobody@example.com', password: PWD } });
  ok('未知账号 → 401（不泄露账号枚举）', noUser.status === 401, `got ${noUser.status}`);

  const login = await req('POST', '/rest/login', { body: { emailOrLdapLoginId: 'admin@example.com', password: PWD } });
  ok('emailOrLdapLoginId 登录 → 200', login.status === 200, `got ${login.status} ${login.text.slice(0, 160)}`);
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  ok('下发 HttpOnly 会话 Cookie', /HttpOnly/i.test(setCookie), setCookie.slice(0, 80));
  ok('Cookie 名 n8n-auth', /^n8n-auth=/.test(cookie), cookie.slice(0, 40));

  const legacy = await req('POST', '/rest/login', { body: { email: 'admin@example.com', password: PWD } });
  ok('email（兼容旧字段）登录 → 200', legacy.status === 200, `got ${legacy.status}`);

  // ---------- 2. 鉴权墙 ----------
  section('2. 鉴权墙（未登录一律 401）');
  const protectedGet = [
    '/rest/workflows', '/rest/credentials', '/rest/executions', '/rest/users', '/rest/user/me',
    '/rest/license', '/rest/me', '/rest/options/timezones', '/rest/community-node-types',
    '/rest/roles', '/rest/tags', '/rest/projects', '/rest/node-types', '/rest/active-workflows',
    '/rest/variables', '/rest/plugins', '/rest/insights/summary', '/rest/home/project',
    '/rest/workflow-history/workflow/x', '/rest/credential-types', '/rest/me/settings',
  ];
  for (const p of protectedGet) {
    const r = await req('GET', p);
    ok(`未登录 GET ${p} → 401`, r.status === 401, `got ${r.status}`);
  }
  const protectedWrite = [
    ['POST', '/rest/workflows', {}], ['PATCH', '/rest/workflows/x', {}], ['DELETE', '/rest/workflows/x'],
    ['POST', '/rest/credentials', {}], ['PATCH', '/rest/me/settings', {}],
    ['POST', '/rest/test-webhook/x'], ['DELETE', '/rest/test-webhook/x'],
    ['POST', '/rest/dynamic-node-parameters/options', {}], ['PUT', '/rest/workflows/x/share', {}],
    ['PUT', '/rest/workflows/x/transfer', {}], ['POST', '/rest/mcp/servers', {}],
  ];
  for (const [m, p, b] of protectedWrite) {
    const r = await req(m, p, { body: b });
    ok(`未登录 ${m} ${p} → 401`, r.status === 401, `got ${r.status}`);
  }

  // 伪造/篡改 Cookie
  const forged = 'n8n-auth=' + encodeURIComponent(Buffer.from('admin@example.com').toString('base64url').replace(/=+$/, '') + '.99999999999999.deadbeef');
  const f1 = await req('GET', '/rest/workflows', { cookie: forged });
  ok('伪造签名 Cookie → 401', f1.status === 401, `got ${f1.status}`);
  const tampered = cookie.replace(/.$/, (ch) => (ch === 'a' ? 'b' : 'a'));
  const f2 = await req('GET', '/rest/workflows', { cookie: tampered });
  ok('篡改末位签名 Cookie → 401', f2.status === 401, `got ${f2.status}`);

  // 公开端点
  section('2b. 公开端点（登录页必需）');
  for (const p of ['/rest/settings', '/rest/meta', '/rest/sso']) {
    const r = await req('GET', p);
    ok(`公开 GET ${p} → 200`, r.status === 200, `got ${r.status}`);
  }

  // ---------- 3. 已登录核心读 ----------
  section('3. 已登录核心端点');
  for (const p of protectedGet) {
    const r = await req('GET', p, { cookie });
    ok(`已登录 GET ${p} → 2xx`, r.status >= 200 && r.status < 300, `got ${r.status} ${r.text.slice(0, 120)}`);
  }

  // ---------- 4. 契约：分页/筛选/错误码 ----------
  section('4. REST 契约');
  const lic = await req('GET', '/rest/license', { cookie });
  ok('/license 结构含 usage.activeWorkflowTriggers', lic.json?.data?.usage?.activeWorkflowTriggers !== undefined, JSON.stringify(lic.json).slice(0, 160));
  ok('/license limit = -1（社区版不限量）', lic.json?.data?.usage?.activeWorkflowTriggers?.limit === -1, JSON.stringify(lic.json?.data?.usage));

  const bogus = await req('GET', '/rest/definitely-not-a-real-endpoint-xyz', { cookie });
  ok('未知路径 → 404 且为 JSON 兜底文案', bogus.status === 404 && /Not found:/.test(bogus.json?.message || ''), `got ${bogus.status} ${bogus.text.slice(0, 120)}`);
  ok('未知路径不返回 HTML（不落 SPA fallback）', !/^\s*</.test(bogus.text), bogus.text.slice(0, 60));

  // 降级层：企业端点应返回「未启用」形状而非 404
  const mcp = await req('GET', '/rest/mcp/servers', { cookie });
  ok('降级层 GET /rest/mcp/servers → 2xx（非 404）', mcp.status >= 200 && mcp.status < 300, `got ${mcp.status}`);
  const ldap = await req('GET', '/rest/ldap/sync', { cookie });
  ok('降级层 GET /rest/ldap/sync → 2xx（非 404）', ldap.status >= 200 && ldap.status < 300, `got ${ldap.status}`);
  const ssoExact = await req('GET', '/rest/sso', {});
  ok('/sso 精确路径未被降级守卫抢占（公开 200）', ssoExact.status === 200 && ssoExact.json?.data?.configured === false, `got ${ssoExact.status}`);

  // 分页与非法参数容错
  const wfList = await req('GET', '/rest/workflows?limit=abc&filter=%7Bbad-json', { cookie });
  ok('workflows 列表：非法 limit/filter 不报错', wfList.status === 200 && Array.isArray(wfList.json?.data), `got ${wfList.status}`);

  // ---------- 5. 执行引擎端到端 ----------
  section('5. 执行引擎（创建→激活→手动执行）');
  const wfId = 'retest-' + Date.now();
  const wf = {
    id: wfId,
    name: 'retest workflow',
    nodes: [
      { id: 'n1', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'n2', name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { jsCode: 'return items.map(i => ({ json: { value: (i.json.n || 1) + 1 } }));' } },
    ],
    connections: { Start: { main: [[{ node: 'Code', type: 'main', index: 0 }]] } },
    settings: {},
  };
  const created = await req('POST', '/rest/workflows', { cookie, body: wf });
  ok('创建 workflow → 201', created.status === 201, `got ${created.status} ${created.text.slice(0, 120)}`);
  ok('创建响应含 checksum（前端保存校验依赖）', typeof created.json?.data?.checksum === 'string' && created.json.data.checksum.length > 0, JSON.stringify(created.json?.data).slice(0, 120));
  ok('创建响应 projectId 归一为 personal', created.json?.data?.projectId === 'personal', String(created.json?.data?.projectId));

  const readBack = await req('GET', `/rest/workflows/${wfId}`, { cookie });
  ok('读回 workflow → 200 且节点数正确', readBack.status === 200 && readBack.json?.data?.nodes?.length === 2, `got ${readBack.status} nodes=${readBack.json?.data?.nodes?.length}`);

  const run = await req('POST', `/rest/workflows/${wfId}/run`, { cookie, body: { data: { n: 41 } } });
  ok('手动执行 → 200 且返回 executionId', run.status === 200 && !!run.json?.data?.executionId, `got ${run.status} ${run.text.slice(0, 160)}`);
  const execId = run.json?.data?.executionId;

  if (execId) {
    const exec = await req('GET', `/rest/executions/${execId}`, { cookie });
    const status = exec.json?.data?.status;
    ok('执行状态为 completed', status === 'completed', `status=${status} ${exec.text.slice(0, 200)}`);
    const runData = exec.json?.data?.data ?? exec.json?.data?.resultData;
    const outVal = runData?.resultData?.runData?.Code?.[0]?.data?.main?.[0]?.[0]?.json?.value
      ?? runData?.runData?.Code?.[0]?.data?.main?.[0]?.[0]?.json?.value;
    ok('Code 节点产出 value = 42（引擎语义正确）', outVal === 42, `value=${outVal} keys=${Object.keys(runData || {}).slice(0, 8)}`);
  }

  // 执行列表分页
  const execList = await req('GET', '/rest/executions?limit=5', { cookie });
  ok('executions 列表 → 200', execList.status === 200, `got ${execList.status}`);

  // 清理
  await req('DELETE', `/rest/workflows/${wfId}`, { cookie });

  // ---------- 汇总 ----------
  console.log(`\n=== 汇总: ${pass} pass / ${fail} fail ===`);
  if (failures.length) { console.log('失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('探针异常:', e); process.exit(2); });
