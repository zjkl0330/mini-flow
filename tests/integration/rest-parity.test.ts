// tests/integration/rest-parity.test.ts
// 「前端所需后端」补齐的契约回归。
//
// 本文件锁定的都是**实机采集/复现**得到的真实差异，而非推测：
//   1) 前端登录表单提交 `emailOrLdapLoginId`，后端若只读 `email` → 界面登录恒 401；
//   2) `GET /rest/license` 在每个页面（含编辑器）启动时被调用，此前 404；
//   3) `GET /rest/workflows/from-url`、`GET /rest/credentials/new` 被 `/:id` 抢占，
//      返回 "Workflow/Credential not found <literal>" 而非各自语义；
//   4) `GET /rest/executions/versions/:workflowId` 同理被 `executions/:id` 抢占；
//   5) 批量删除/停止、执行标注、安全设置、角色列表、当前用户等端点此前缺失；
//   6) 企业/AI 端点此前一律 404 → 统一降级为「未启用」契约形状。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { makeEnv, loginCookie, TEST_EMAIL, TEST_PASSWORD } from '../helpers/env';

type Db = ReturnType<typeof makeEnv>['db'];

const hdr = (cookie: string) => ({ 'Content-Type': 'application/json', Cookie: cookie });

async function seedWorkflow(db: Db, id = 'wf-1'): Promise<void> {
  await db.prepare(
    'INSERT INTO workflows (id,name,nodes,connections,project_id,active) VALUES (?,?,?,?,?,?)',
  ).bind(id, `WF ${id}`, '[]', '{}', 'personal', 1).run();
}

async function seedExecution(db: Db, execId: string, wfId: string, status = 'completed'): Promise<void> {
  await db.prepare(
    'INSERT INTO executions (id, workflow_id, status, trigger_type, mode, started_at, finished_at) '
    + 'VALUES (?,?,?,?,?,datetime(\'now\'),datetime(\'now\'))',
  ).bind(execId, wfId, status, 'manual', 'manual').run();
}

// ---------------------------------------------------------------------------
// 1) 登录契约
// ---------------------------------------------------------------------------
test('登录契约：前端提交 emailOrLdapLoginId 时必须能登录（否则界面无法进入）', async () => {
  const { env } = makeEnv();
  const res = await restApi.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: TEST_EMAIL, password: TEST_PASSWORD }),
  }, env as never);
  assert.equal(res.status, 200, '前端字段名必须被接受，否则真实用户经界面登录恒 401');
  assert.match(res.headers.get('set-cookie') ?? '', /n8n-auth=/);
});

test('登录契约：兼容旧字段 email，且错误口令仍 401', async () => {
  const { env } = makeEnv();
  const ok = await restApi.request('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  }, env as never);
  assert.equal(ok.status, 200, 'email 字段需保持向后兼容');

  const bad = await restApi.request('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrLdapLoginId: TEST_EMAIL, password: 'not-the-password' }),
  }, env as never);
  assert.equal(bad.status, 401, '错误口令必须仍被拒绝');
});

// ---------------------------------------------------------------------------
// 2) 许可证（全站启动调用）
// ---------------------------------------------------------------------------
test('/license 返回前端 usage.store 期望的形状，且 activeWorkflowTriggers 为真实计数', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedWorkflow(db, 'wf-a');
  await seedWorkflow(db, 'wf-b');
  await db.prepare('UPDATE workflows SET active=0 WHERE id=?').bind('wf-b').run();

  const res = await restApi.request('/license', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 200);
  const { data } = await res.json() as {
    data: { usage: { activeWorkflowTriggers: { limit: number; value: number } }; license: { planId: string; planName: string } };
  };
  assert.equal(data.usage.activeWorkflowTriggers.value, 1, '应统计实际激活的工作流数');
  assert.equal(data.usage.activeWorkflowTriggers.limit, -1, '社区版为不限量(-1)');
  assert.equal(typeof data.license.planName, 'string');
});

// ---------------------------------------------------------------------------
// 3) 路由抢占修复
// ---------------------------------------------------------------------------
test('GET /workflows/from-url 不再被 /:id 抢占（无 url 参数应是 400 而非 "not found from-url"）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await restApi.request('/workflows/from-url', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 400, '缺 url 参数属于参数错误');
  const body = await res.json() as { message: string };
  assert.doesNotMatch(body.message, /Workflow not found/i, '不得落回 /:id 的资源不存在分支');
});

test('GET /credentials/new 不再被 /:id 抢占（应返回空白凭据脚手架）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await restApi.request('/credentials/new?type=httpHeaderAuth', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { type: string; schema: unknown[] } };
  assert.equal(body.data.type, 'httpHeaderAuth');
  assert.ok(Array.isArray(body.data.schema) && body.data.schema.length > 0, '应带出该类型的表单字段');
});

test('GET /executions/versions/:workflowId 返回数组（不得被 executions/:id 抢占）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedWorkflow(db, 'wf-v');
  const res = await restApi.request('/executions/versions/wf-v', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Array<{ versionId: string }> };
  assert.ok(Array.isArray(body.data), '前端直接把返回值当数组使用');
  assert.equal(body.data[0]?.versionId, 'wf-v');

  const missing = await restApi.request('/executions/versions/nope', { headers: { Cookie: cookie } }, env as never);
  assert.deepEqual((await missing.json() as { data: unknown[] }).data, []);
});

// ---------------------------------------------------------------------------
// 4) 执行批量与标注
// ---------------------------------------------------------------------------
test('POST /executions/delete 与 /stopMany 生效，且不影响未列出的执行', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedWorkflow(db, 'wf-x');
  await seedExecution(db, 'e-1', 'wf-x');
  await seedExecution(db, 'e-2', 'wf-x', 'running');
  await seedExecution(db, 'e-3', 'wf-x', 'running');

  const stopped = await restApi.request('/executions/stopMany', {
    ...{ method: 'POST', headers: hdr(cookie), body: JSON.stringify({ ids: ['e-2', 'e-3'] }) },
  }, env as never);
  assert.equal(stopped.status, 200);
  assert.deepEqual((await stopped.json() as { data: { stopped: string[] } }).data.stopped.sort(), ['e-2', 'e-3']);

  const del = await restApi.request('/executions/delete', {
    method: 'POST', headers: hdr(cookie), body: JSON.stringify({ ids: ['e-1'] }),
  }, env as never);
  assert.deepEqual((await del.json() as { data: { deleted: string[] } }).data.deleted, ['e-1']);

  const left = await db.prepare('SELECT id FROM executions ORDER BY id').all<{ id: string }>();
  assert.deepEqual((left.results ?? []).map((r) => r.id), ['e-2', 'e-3'], '删除是精确命中，不误删');
});

test('PATCH /executions/:id 可写入标注，并在响应中回读', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedWorkflow(db, 'wf-y');
  await seedExecution(db, 'e-anno', 'wf-y');

  const res = await restApi.request('/executions/e-anno', {
    method: 'PATCH', headers: hdr(cookie),
    body: JSON.stringify({ annotation: { tags: ['important'], vote: 'up' } }),
  }, env as never);
  assert.equal(res.status, 200);
  const { data } = await res.json() as { data: { annotation: { tags: string[]; vote?: string } } };
  assert.deepEqual(data.annotation.tags, ['important']);
  assert.equal(data.annotation.vote, 'up');

  const missing = await restApi.request('/executions/nope', {
    method: 'PATCH', headers: hdr(cookie), body: JSON.stringify({ annotation: { tags: [] } }),
  }, env as never);
  assert.equal(missing.status, 404, '不存在的执行不得被伪造成成功');
});

// ---------------------------------------------------------------------------
// 5) 安全设置 / 角色 / 当前用户
// ---------------------------------------------------------------------------
test('/settings/security 返回 SecuritySettings 读取的字段', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await restApi.request('/settings/security', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 200);
  const { data } = await res.json() as { data: Record<string, unknown> };
  for (const k of ['personalSpacePublishing', 'personalSpaceSharing', 'publishedPersonalWorkflowsCount']) {
    assert.ok(k in data, `缺少前端读取的字段 ${k}`);
  }
});

test('/roles 返回内置角色（此前恒为空数组，导致角色选择器为空）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await restApi.request('/roles?withUsageCount=true', { headers: { Cookie: cookie } }, env as never);
  const { data } = await res.json() as { data: { roles: Array<{ slug: string; scopes: string[] }>; count: number } };
  const slugs = data.roles.map((r) => r.slug);
  assert.ok(slugs.includes('owner') && slugs.includes('member'), '应包含内置全局角色');
  assert.equal(data.count, data.roles.length);
  assert.ok(data.roles.every((r) => Array.isArray(r.scopes)), '角色必须带 scopes');
});

test('/me 可读，/me/password 明确拒绝（口令由 Worker Secret 托管）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const me = await restApi.request('/me', { headers: { Cookie: cookie } }, env as never);
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { data: { role: string } }).data.role, 'owner');

  const pwd = await restApi.request('/me/password', {
    method: 'PATCH', headers: hdr(cookie), body: JSON.stringify({ currentPassword: 'x', newPassword: 'y' }),
  }, env as never);
  assert.equal(pwd.status, 400, '必须显式拒绝，而不是静默成功却什么都没改');
});

test('/options/timezones 返回时区数组', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await restApi.request('/options/timezones', { headers: { Cookie: cookie } }, env as never);
  const { data } = await res.json() as { data: string[] };
  assert.ok(Array.isArray(data) && data.includes('UTC'));
});

test('工作流版本历史端点可用（编辑器打开工作流时会请求，缺则历史面板报错）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedWorkflow(db, 'wf-hist');
  const get = async (p: string) => restApi.request(p, { headers: { Cookie: cookie } }, env as never);

  const list = await get('/workflow-history/workflow/wf-hist');
  assert.equal(list.status, 200);
  const versions = (await list.json() as { data: Array<{ versionId: string }> }).data;
  assert.ok(Array.isArray(versions) && versions.length === 1, '应至少呈现一条可用版本记录');

  const detail = await get('/workflow-history/workflow/wf-hist/version/wf-hist');
  assert.equal(detail.status, 200);
  const d = (await detail.json() as { data: { nodes: unknown[]; connections: unknown } }).data;
  assert.ok(Array.isArray(d.nodes), '版本详情必须带 nodes（前端据此渲染）');
  assert.equal(typeof d.connections, 'object');

  const missing = await get('/workflow-history/workflow/nope');
  assert.equal(missing.status, 404, '不存在的工作流仍应 404，不得被伪造成空历史');
});

// ---------------------------------------------------------------------------
// 6) 降级层
// ---------------------------------------------------------------------------
test('企业/AI 端点降级为「未启用」形状（不再 404），且不吞掉未实现的普通路径', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const get = async (p: string) => restApi.request(p, { headers: { Cookie: cookie } }, env as never);

  // 列表型 → []
  for (const p of ['/api-keys', '/mfa/qr', '/chat/settings', '/secret-providers/connections']) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} 应为降级 200，而不是 404`);
  }
  assert.deepEqual((await (await get('/api-keys')).json() as { data: unknown[] }).data, []);

  // /sso 精确路径仍走真实实现（登录页需要 action 字段）
  const sso = await get('/sso');
  const ssoBody = await sso.json() as { data: { configured: boolean }; action?: string };
  assert.equal(ssoBody.data.configured, false);
  assert.equal(ssoBody.action, 'GET', '/sso 精确路径不得被降级层抢走');

  // 项目本体的 CRUD 不受降级层影响
  const personal = await get('/projects/personal');
  assert.equal(personal.status, 200, '/projects/:id 本体必须仍然可达');
  assert.equal((await personal.json() as { data: { id: string } }).data.id, 'personal');

  // 完全未知的路径仍应是 404（降级层不能把兜底变成 200）
  const unknown = await get('/definitely-not-a-real-endpoint');
  assert.equal(unknown.status, 404);
});
