// tests/integration/rest-increment.test.ts
// 本轮增量 REST 端点集成测试：
//   REQ-15 执行 retry / REQ-26 insights / REQ-27 tags / REQ-29 import-export /
//   REQ-32 community-nodes / REQ-16 节点 properties 非空 / REQ-17 credentials 可解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { nodeTypeDefs } from '../../src/n8n/node-types';
import { makeEnv, loginCookie, jsonRequest } from '../helpers/env';

const req = (env: unknown, path: string, init: RequestInit = {}) =>
  restApi.request(path, init, env as never);

// 便捷：PATCH/DELETE 带 Cookie
const withCookie = (cookie: string) => ({ Cookie: cookie });

// —— REQ-16 / REQ-17：节点元数据闭环 ——

test('REQ-16/17：节点 properties 全部非空，credentials 均可在 credentialTypes 解析', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  const defs = nodeTypeDefs();
  assert.equal(defs.length, 68, '本轮不新增节点，应仍为 68 个');
  const empty = defs.filter((d) => !Array.isArray(d.properties) || d.properties.length === 0);
  assert.equal(empty.length, 0, `不允许存在 properties 为空的节点：${empty.map((d) => d.type).join(', ')}`);

  // /rest/node-types 输出同样非空
  const ntRes = await req(env, '/node-types', { headers: withCookie(cookie) });
  assert.equal(ntRes.status, 200);
  const nt = (await ntRes.json() as { data: Array<{ properties: unknown[] }> }).data;
  assert.ok(nt.every((d) => Array.isArray(d.properties) && d.properties.length > 0));

  // 所有声明的凭据名必须存在于 credentialTypes()
  const credRes = await req(env, '/credential-types', { headers: withCookie(cookie) });
  assert.equal(credRes.status, 200);
  const names = new Set((await credRes.json() as { data: Array<{ name: string }> }).data.map((t) => t.name));
  let declared = 0;
  for (const d of defs) {
    for (const cred of d.credentials ?? []) {
      declared++;
      assert.ok(names.has(cred.name), `${d.type} 声明的凭据 ${cred.name} 不在 credentialTypes()`);
    }
  }
  assert.ok(declared > 0, '至少应有需鉴权节点声明 credentials');
});

// —— REQ-15：执行 retry ——

test('REQ-15：POST /executions/:id/retry 新建执行并写 retry_of', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare(
    "INSERT INTO executions (id,workflow_id,status,mode,input_data,finished_at) VALUES ('e1','w1','failed','manual',?,datetime('now'))",
  ).bind(JSON.stringify({ x: 1 })).run();

  const res = await req(env, '/executions/e1/retry', jsonRequest({}, withCookie(cookie)));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { executionId: string; retryOf: string; status: string } };
  assert.ok(body.data.executionId);
  assert.equal(body.data.retryOf, 'e1');
  assert.equal(body.data.status, 'running');
  assert.equal(flowCreateCalls.length, 1, '应提交一次执行到 FlowEngine');

  const row = await db.prepare('SELECT retry_of, mode, status FROM executions WHERE id=?')
    .bind(body.data.executionId).first<{ retry_of: string; mode: string; status: string }>();
  assert.ok(row);
  assert.equal(row!.retry_of, 'e1');
  assert.equal(row!.status, 'running');

  // 详情 retryOf 从列读取（不再硬编码 null）
  const detail = await req(env, `/executions/${body.data.executionId}`, { headers: withCookie(cookie) });
  assert.equal((await detail.json() as { data: { retryOf: string } }).data.retryOf, 'e1');

  // 不存在的执行 → 404
  assert.equal((await req(env, '/executions/nope/retry', jsonRequest({}, withCookie(cookie)))).status, 404);
});

// —— REQ-26：insights ——

test('REQ-26：/rest/insights/* 聚合端点返回合理结构与数值', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,started_at,finished_at) VALUES ('e1','w1','completed','manual',datetime('now'),datetime('now','+2 seconds'))").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,started_at,finished_at) VALUES ('e2','w1','failed','manual',datetime('now'),datetime('now','+1 seconds'))").run();

  const summary = await req(env, '/insights/summary', { headers: withCookie(cookie) });
  assert.equal(summary.status, 200);
  const s = (await summary.json() as { data: { total: number; failed: number; failureRate: number; averageRunTime: number; timeSaved: number } }).data;
  assert.equal(s.total, 2);
  assert.equal(s.failed, 1);
  assert.ok(Math.abs(s.failureRate - 0.5) < 1e-9);
  assert.ok(typeof s.averageRunTime === 'number' && s.averageRunTime >= 0);
  assert.equal(s.timeSaved, 0);

  const byWf = await req(env, '/insights/by-workflow', { headers: withCookie(cookie) });
  const wfData = (await byWf.json() as { data: Array<{ workflowId: string; total: number; failed: number; failureRate: number }> }).data;
  assert.ok(Array.isArray(wfData));
  assert.equal(wfData[0].workflowId, 'w1');
  assert.equal(wfData[0].total, 2);
  assert.equal(wfData[0].failed, 1);

  const byTime = await req(env, '/insights/by-time?granularity=day', { headers: withCookie(cookie) });
  assert.ok(Array.isArray((await byTime.json() as { data: unknown[] }).data));

  const byMode = await req(env, '/insights/by-mode', { headers: withCookie(cookie) });
  const modeData = (await byMode.json() as { data: Array<{ mode: string; total: number }> }).data;
  assert.ok(Array.isArray(modeData));
  assert.ok(modeData.some((m) => m.mode === 'manual'));

  // 非法参数不 500；未登录 401
  assert.equal((await req(env, '/insights/summary?startDate=not-a-date&endDate=oops', { headers: withCookie(cookie) })).status, 200);
  assert.equal((await req(env, '/insights/summary')).status, 401);
});

// —— REQ-27：tags CRUD ——

test('REQ-27：/rest/tags 创建 / 列表 / 重命名 / 删除 / 重名冲突', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  const created = await req(env, '/tags', jsonRequest({ name: 'prod' }, withCookie(cookie)));
  assert.equal(created.status, 201);
  const tag = (await created.json() as { data: { id: string; name: string } }).data;
  assert.ok(tag.id);
  assert.equal(tag.name, 'prod');

  assert.equal((await req(env, '/tags', jsonRequest({ name: 'prod' }, withCookie(cookie)))).status, 409);
  assert.equal((await req(env, '/tags', jsonRequest({ name: '' }, withCookie(cookie)))).status, 400);

  const list = await req(env, '/tags', { headers: withCookie(cookie) });
  assert.equal((await list.json() as { data: unknown[] }).data.length, 1);

  const patched = await req(env, `/tags/${tag.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withCookie(cookie) },
    body: JSON.stringify({ name: 'production' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json() as { data: { name: string } }).data.name, 'production');

  const patchMissing = await req(env, '/tags/does-not-exist', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...withCookie(cookie) },
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(patchMissing.status, 404);

  const del = await req(env, `/tags/${tag.id}`, { method: 'DELETE', headers: withCookie(cookie) });
  assert.equal(del.status, 200);
  assert.equal((await del.json() as { data: boolean }).data, true);

  const list2 = await req(env, '/tags', { headers: withCookie(cookie) });
  assert.equal((await list2.json() as { data: unknown[] }).data.length, 0);
});

// —— REQ-29：import / export ——

test('REQ-29：工作流导出（附件）+ 导入（id 冲突重分配）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','Export Me','[]','{}')").run();

  const exp = await req(env, '/workflows/w1/export', { headers: withCookie(cookie) });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get('content-disposition') ?? '', /attachment/);
  const expBody = await exp.json() as { id: string; name: string; nodes: unknown[] };
  assert.equal(expBody.id, 'w1');
  assert.equal(expBody.name, 'Export Me');
  assert.ok(Array.isArray(expBody.nodes));

  assert.equal((await req(env, '/workflows/nope/export', { headers: withCookie(cookie) })).status, 404);

  // 带新 id 导入 → 保留 id
  const imp = await req(env, '/workflows/import', jsonRequest({ workflow: { id: 'w2', name: 'Imported', nodes: [], connections: {} } }, withCookie(cookie)));
  assert.equal(imp.status, 201);
  assert.equal((await imp.json() as { data: { id: string } }).data.id, 'w2');

  // 同 id 再次导入 → 重新分配（不覆盖）
  const imp2 = await req(env, '/workflows/import', jsonRequest({ data: { id: 'w2', name: 'Again', nodes: [], connections: {} } }, withCookie(cookie)));
  const id2 = (await imp2.json() as { data: { id: string } }).data.id;
  assert.notEqual(id2, 'w2');

  // 无 id → 生成
  const imp3 = await req(env, '/workflows/import', jsonRequest({ name: 'Bare', nodes: [], connections: {} }, withCookie(cookie)));
  assert.equal(imp3.status, 201);
  assert.ok((await imp3.json() as { data: { id: string } }).data.id);

  const row = await db.prepare("SELECT name FROM workflows WHERE id='w2'").first<{ name: string }>();
  assert.equal(row!.name, 'Imported');
});

// —— REQ-32：community nodes ——

test('REQ-32：社区节点安装 / 目录 / /plugins 合并 / 卸载', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  const install = await req(env, '/community-nodes', jsonRequest(
    { name: 'n8n-nodes-hello', displayName: 'Hello Nodes', nodes: [{ type: 'x' }, { type: 'y' }] },
    withCookie(cookie),
  ));
  assert.equal(install.status, 201);
  const pkg = (await install.json() as { data: { name: string; nodeCount: number; isCommunity: boolean } }).data;
  assert.equal(pkg.name, 'n8n-nodes-hello');
  assert.equal(pkg.nodeCount, 2);
  assert.equal(pkg.isCommunity, true);

  assert.equal((await req(env, '/community-nodes', jsonRequest({ name: '' }, withCookie(cookie)))).status, 400);
  assert.equal((await req(env, '/community-nodes', jsonRequest({ name: 'n8n-nodes-hello' }, withCookie(cookie)))).status, 409);

  const list = await req(env, '/community-nodes', { headers: withCookie(cookie) });
  assert.equal((await list.json() as { data: unknown[] }).data.length, 1);

  const plugins = await req(env, '/plugins', { headers: withCookie(cookie) });
  const pluginData = (await plugins.json() as { data: Array<{ id: string; isCommunity: boolean; nodeCount: number }> }).data;
  const community = pluginData.find((p) => p.id === 'n8n-nodes-hello');
  assert.ok(community, '/rest/plugins 应能看到已安装的社区包');
  assert.equal(community!.isCommunity, true);
  assert.equal(community!.nodeCount, 2);

  const un = await req(env, '/community-nodes/n8n-nodes-hello/uninstall', jsonRequest({}, withCookie(cookie)));
  assert.equal(un.status, 200);
  assert.equal((await un.json() as { data: boolean }).data, true);
  assert.equal((await req(env, '/community-nodes/n8n-nodes-hello/uninstall', jsonRequest({}, withCookie(cookie)))).status, 404);
});

// —— 回归 REQ-22 ——

test('回归 REQ-22：未知 /rest/* 仍返回 404 JSON', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/definitely-not-real', { headers: withCookie(cookie) });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});
