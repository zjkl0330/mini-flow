// tests/integration/project-id.test.ts
// REQ-38 收口：`projectId` 的 null 与 'personal' 语义歧义。
//
// 实机核验发现（本地 workerd + 真实 D1）：`GET /rest/projects` 暴露的个人项目 id 是
// 字符串 `'personal'`，但 `GET /rest/workflows` 对历史行返回 `projectId: null`。
// 前端按 projectId 过滤项目工作流时 `null !== 'personal'` → 个人项目下看不到工作流。
// 本文件锁定收口后的契约：REST 出参一律归一化为 `'personal'`，过滤时兼容历史 NULL 行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { PERSONAL_PROJECT_ID } from '../../src/n8n/projects';
import { normalizeProjectId } from '../../src/n8n/workflows';
import { makeEnv, loginCookie } from '../helpers/env';

type Db = ReturnType<typeof makeEnv>['db'];

const jsonHdr = (cookie: string) => ({
  'Content-Type': 'application/json',
  Cookie: cookie,
});

async function seedLegacyRow(db: Db, id: string, projectId: string | null): Promise<void> {
  // 刻意写入 NULL：等价于收口前遗留的「未归一个人项目」行
  await db.prepare(
    'INSERT INTO workflows (id,name,nodes,connections,project_id) VALUES (?,?,?,?,?)',
  ).bind(id, `WF-${id}`, '[]', '{}', projectId).run();
}

test('REQ-38：列表把历史 NULL 行的 projectId 归一化为 personal（与 /rest/projects 一致）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedLegacyRow(db, 'w-null', null);
  await seedLegacyRow(db, 'w-team', 'team-1');

  const res = await restApi.request('/workflows', { headers: { Cookie: cookie } }, env as never);
  assert.equal(res.status, 200);
  const rows = (await res.json() as { data: Array<{ id: string; projectId: unknown }> }).data;

  const byId = new Map(rows.map((r) => [r.id, r.projectId]));
  assert.equal(byId.get('w-null'), PERSONAL_PROJECT_ID, 'NULL 应归一化为 personal，而不是 null');
  assert.equal(byId.get('w-team'), 'team-1', '团队项目 id 原样保留');

  // 交叉验证：/rest/projects 的个人项目 id 必须是同一个值
  const projRes = await restApi.request('/projects', { headers: { Cookie: cookie } }, env as never);
  const projects = (await projRes.json() as { data: Array<{ id: string; type: string }> }).data;
  const personal = projects.find((p) => p.type === 'personal');
  assert.equal(personal?.id, PERSONAL_PROJECT_ID, '个人项目 id 与工作流出参语义必须一致');
});

test('REQ-38：按 projectId=personal 过滤时同时命中 NULL 行与 personal 行', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedLegacyRow(db, 'w-null', null);
  await seedLegacyRow(db, 'w-personal', PERSONAL_PROJECT_ID);
  await seedLegacyRow(db, 'w-team', 'team-1');

  const res = await restApi.request(
    `/workflows?filter=${encodeURIComponent(JSON.stringify({ projectId: PERSONAL_PROJECT_ID }))}`,
    { headers: { Cookie: cookie } },
    env as never,
  );
  const ids = (await res.json() as { data: Array<{ id: string }> }).data.map((r) => r.id).sort();
  assert.deepEqual(ids, ['w-null', 'w-personal'], '个人项目过滤必须包含历史 NULL 行');

  // 团队项目过滤不受影响
  const team = await restApi.request(
    `/workflows?filter=${encodeURIComponent(JSON.stringify({ projectId: 'team-1' }))}`,
    { headers: { Cookie: cookie } },
    env as never,
  );
  assert.deepEqual((await team.json() as { data: Array<{ id: string }> }).data.map((r) => r.id), ['w-team']);
});

test('REQ-38：新建 / 导入 / 详情 的出参均带 personal 兜底，不再返回 null', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  const created = await restApi.request('/workflows/new', {
    method: 'POST', headers: jsonHdr(cookie), body: JSON.stringify({}),
  }, env as never);
  const createdData = (await created.json() as { data: { id: string; projectId: unknown } }).data;
  assert.equal(createdData.projectId, PERSONAL_PROJECT_ID, 'POST /workflows/new 不得返回 null');

  const body = { id: 'w-new', name: 'New', nodes: [], connections: {} };
  const posted = await restApi.request('/workflows', {
    method: 'POST', headers: jsonHdr(cookie), body: JSON.stringify(body),
  }, env as never);
  assert.equal(posted.status, 201);
  assert.equal(
    (await posted.json() as { data: { projectId: unknown } }).data.projectId,
    PERSONAL_PROJECT_ID,
  );

  const detail = await restApi.request('/workflows/w-new', { headers: { Cookie: cookie } }, env as never);
  assert.equal(
    (await detail.json() as { data: { projectId: unknown } }).data.projectId,
    PERSONAL_PROJECT_ID,
  );

  const imported = await restApi.request('/workflows/import', {
    method: 'POST', headers: jsonHdr(cookie), body: JSON.stringify({ name: 'Imp', nodes: [], connections: {} }),
  }, env as never);
  assert.equal(
    (await imported.json() as { data: { projectId: unknown } }).data.projectId,
    PERSONAL_PROJECT_ID,
  );
});

test('REQ-38：normalizeProjectId 判定矩阵', () => {
  assert.equal(normalizeProjectId(null), PERSONAL_PROJECT_ID);
  assert.equal(normalizeProjectId(undefined), PERSONAL_PROJECT_ID);
  assert.equal(normalizeProjectId(''), PERSONAL_PROJECT_ID);
  assert.equal(normalizeProjectId('   '), PERSONAL_PROJECT_ID);
  assert.equal(normalizeProjectId('personal'), PERSONAL_PROJECT_ID);
  assert.equal(normalizeProjectId('team-9'), 'team-9');
});
