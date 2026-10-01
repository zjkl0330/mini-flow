// REST 契约集成测试：真实 Hono 应用 + 真实 SQLite（node:sqlite 支撑的 D1 垫片）+ 内存 KV。
// 覆盖：鉴权墙、公开端点、凭据脱敏、列表筛选/分页健壮性、执行详情 n8n 形状、未知路径 404。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { restApi } from '../../src/n8n/router';
import { pushSubscribeHandler } from '../../src/n8n/push';
import { makeEnv, loginCookie, jsonRequest, TEST_EMAIL, TEST_PASSWORD } from '../helpers/env';
import type { Env } from '../../src/types';

const req = (env: unknown, path: string, init: RequestInit = {}) =>
  restApi.request(path, init, env as never);

// —— 鉴权 ——

test('登录：错误密码与不存在用户统一 401，正确密码 200 并下发会话 Cookie', async () => {
  const { env } = makeEnv();

  const wrong = await req(env, '/login', jsonRequest({ email: TEST_EMAIL, password: 'wrong-password' }));
  assert.equal(wrong.status, 401);

  const nobody = await req(env, '/login', jsonRequest({ email: 'nobody@nowhere.test', password: 'x' }));
  assert.equal(nobody.status, 401);

  const ok = await req(env, '/login', jsonRequest({ email: TEST_EMAIL, password: TEST_PASSWORD }));
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /n8n-auth=/);
  assert.match(setCookie, /HttpOnly/i);
  // 令牌必须是签名令牌（含两段分隔符），而非固定明文常量
  const token = /n8n-auth=([^;]+)/.exec(setCookie)![1];
  assert.ok(token.split('.').length === 3, `期望签名令牌，实际: ${token}`);
  assert.notEqual(token, 'mini-flow-demo-secret');
});

test('未登录：所有受保护端点一律 401', async () => {
  const { env } = makeEnv();
  const protectedPaths = [
    '/workflows', '/executions', '/credentials', '/variables', '/users',
    '/projects', '/roles', '/node-types', '/settings/x-not-real',
  ];
  for (const p of protectedPaths) {
    const res = await req(env, p);
    assert.equal(res.status, 401, `${p} 应对未登录返回 401，实际 ${res.status}`);
    const body = await res.json() as { code?: number };
    assert.equal(body.code, 401, `${p} 应返回 401 JSON 包裹`);
  }
});

test('未登录不得写入：创建工作流 / 执行工作流 / 创建凭据 全部 401', async () => {
  const { env, db } = makeEnv();
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','wf','[]','{}')").run();

  assert.equal((await req(env, '/workflows', jsonRequest({ name: 'x', nodes: [], connections: {} }))).status, 401);
  assert.equal((await req(env, '/workflows/w1/run', jsonRequest({}))).status, 401);
  assert.equal((await req(env, '/credentials', jsonRequest({ name: 'c', type: 'openAiApi', data: {} }))).status, 401);
});

test('公开端点未登录可访问：settings / module-settings / sso / meta', async () => {
  const { env } = makeEnv();
  const settings = await req(env, '/settings');
  assert.equal(settings.status, 200);
  assert.equal(((await settings.json()) as any).data.versionCli, '1.0.0');

  for (const p of ['/module-settings', '/sso', '/meta']) {
    assert.equal((await req(env, p)).status, 200, `${p} 应公开可读`);
  }
});

// —— 凭据脱敏 ——

test('凭据：写入明文入库，但任何出站响应都不含明文密钥', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  const created = await req(env, '/credentials', jsonRequest(
    { name: 'my-openai', type: 'openAiApi', data: { apiKey: 'sk-super-secret-value' } },
    { Cookie: cookie },
  ));
  assert.equal(created.status, 201);
  const createdBody = await created.json() as any;
  assert.equal(createdBody.data.data.apiKey, '****');
  assert.ok(!JSON.stringify(createdBody).includes('sk-super-secret-value'), '响应不得出现明文密钥');

  const list = await req(env, '/credentials', { headers: { Cookie: cookie } });
  const listBody = await list.json() as any;
  assert.equal(listBody.data[0].data.apiKey, '****');
  assert.ok(!JSON.stringify(listBody).includes('sk-super-secret-value'), '列表不得出现明文密钥');

  const detail = await req(env, `/credentials/${createdBody.data.id}`, { headers: { Cookie: cookie } });
  assert.ok(!JSON.stringify(await detail.json()).includes('sk-super-secret-value'), '详情不得出现明文密钥');

  // 证明确实"存了明文但只在内网"：KV 原始值里应有明文
  const raw = await (env as unknown as { CREDENTIALS: KVNamespace }).CREDENTIALS.get('credentials:list');
  assert.ok(String(raw).includes('sk-super-secret-value'), 'KV 原始存储应保留密钥（脱敏只作用于出站）');
});

// —— 用户列表自洽 ——

test('用户列表与当前登录用户自洽（不再返回空成员列表）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/users', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.data.count, 1);
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].id, 'owner');
  assert.equal(body.data.items[0].isOwner, true);
});

// —— 工作流列表：筛选 / 分页 / 健壮性 ——

test('工作流列表：filter 名称 / active / limit，非法 limit 不报 500', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections,active) VALUES ('a','Alpha','[]','{}',1)").run();
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections,active) VALUES ('b','Beta','[]','{}',0)").run();
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections,active) VALUES ('c','Alphabet','[]','{}',0)").run();

  const all = await req(env, '/workflows', { headers: { Cookie: cookie } });
  assert.equal((await all.json() as any).data.length, 3);

  const byName = await req(env, `/workflows?filter=${encodeURIComponent(JSON.stringify({ name: 'Alpha' }))}`, { headers: { Cookie: cookie } });
  const byNameBody = await byName.json() as any;
  assert.equal(byNameBody.data.length, 2);
  assert.deepEqual(byNameBody.data.map((w: any) => w.id).sort(), ['a', 'c']);

  const active = await req(env, `/workflows?filter=${encodeURIComponent(JSON.stringify({ active: true }))}`, { headers: { Cookie: cookie } });
  assert.deepEqual((await active.json() as any).data.map((w: any) => w.id), ['a']);

  assert.equal((await req(env, '/workflows?limit=2', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await req(env, '/workflows?limit=abc', { headers: { Cookie: cookie } })).status, 200);

  // LIKE 通配符必须按字面量处理：搜索 '%' 不应命中全部
  const literal = await req(env, `/workflows?filter=${encodeURIComponent(JSON.stringify({ name: '%' }))}`, { headers: { Cookie: cookie } });
  assert.equal((await literal.json() as any).data.length, 0);
});

test('工作流详情：不存在返回 404 JSON（而非 SPA HTML）', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/workflows/does-not-exist', { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json() as any;
  assert.equal(body.code, 404);
});

test('工作流详情：返回前端保存流程依赖的 checksum / versionId / scopes', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  const body = await (await req(env, '/workflows/w1', { headers: { Cookie: cookie } })).json() as any;
  assert.equal(body.data.id, 'w1');
  assert.ok(typeof body.data.checksum === 'string' && body.data.checksum.length > 0);
  assert.equal(body.data.versionId, 'w1');
  assert.ok(Array.isArray(body.data.scopes) && body.data.scopes.includes('workflow:update'));
});

// —— 执行列表：参数健壮性 + 筛选 ——

test('执行列表：limit=abc / limit=-1 不再 500（回归：NaN 直接进 SQL LIMIT）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode) VALUES ('e1','w1','completed','manual')").run();

  for (const q of ['?limit=abc', '?limit=-1', '?offset=abc', '?limit=999999', '?limit=']) {
    const res = await req(env, `/executions${q}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200, `执行列表 ${q} 应返回 200，实际 ${res.status}`);
  }
});

test('执行列表：status / filter 筛选生效，count 反映整个筛选集', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,finished_at) VALUES ('e1','w1','completed','manual',datetime('now'))").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,finished_at) VALUES ('e2','w1','failed','manual',datetime('now'))").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode) VALUES ('e3','w1','running','manual')").run();

  const all = await req(env, '/executions', { headers: { Cookie: cookie } });
  const allBody = await all.json() as any;
  assert.equal(allBody.data.count, 3);
  assert.equal(allBody.data.finished, 2);
  assert.equal(allBody.data.running, 1);

  const success = await req(env, '/executions?status=success', { headers: { Cookie: cookie } });
  const successBody = await success.json() as any;
  assert.equal(successBody.data.count, 1);
  assert.equal(successBody.data.results[0].id, 'e1');
  assert.equal(successBody.data.results[0].status, 'success');

  const filtered = await req(env, `/executions?filter=${encodeURIComponent(JSON.stringify({ status: ['error'] }))}`, { headers: { Cookie: cookie } });
  const filteredBody = await filtered.json() as any;
  assert.equal(filteredBody.data.count, 1);
  assert.equal(filteredBody.data.results[0].id, 'e2');

  // 未识别的状态 → 命中空集（而不是退化成"不过滤"）
  const bogus = await req(env, '/executions?status=not-a-real-status', { headers: { Cookie: cookie } });
  assert.equal((await bogus.json() as any).data.count, 0);

  const byWf = await req(env, '/executions?workflowId=w1&limit=2', { headers: { Cookie: cookie } });
  assert.equal((await byWf.json() as any).data.results.length, 2);
});

test('执行详情：返回 n8n 兼容的 resultData.runData（main 为「数组的数组」）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,finished_at) VALUES ('e1','w1','completed','manual',datetime('now'))").run();
  await db.prepare(
    "INSERT INTO node_executions (execution_id,node_name,node_type,status,input_data,output_data,started_at,finished_at) "
    + "VALUES ('e1','Trigger','n8n-nodes-base.manualTrigger','completed',?,?,datetime('now'),datetime('now'))",
  ).bind(JSON.stringify({ main: [] }), JSON.stringify({ main: [{ json: { ok: 1 } }] })).run();
  await db.prepare(
    "INSERT INTO node_executions (execution_id,node_name,node_type,status,input_data,output_data,started_at,finished_at) "
    + "VALUES ('e1','IF','n8n-nodes-base.if','completed',?,?,datetime('now'),datetime('now'))",
  ).bind(
    JSON.stringify({ main: [{ json: { ok: 1 } }] }),
    JSON.stringify({ main: [{ json: { v: 1 } }], branch: true }),
  ).run();

  const res = await req(env, '/executions/e1', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  const d = body.data;

  assert.equal(d.status, 'success');
  assert.ok(d.workflowData, '执行详情必须内嵌 workflowData（前端执行预览依赖它）');
  assert.equal(d.workflowData.id, 'w1');
  assert.ok(d.data.resultData, '必须提供 resultData');
  assert.equal(d.data.resultData.lastNodeExecuted, 'IF');

  const runData = d.data.resultData.runData;
  assert.ok(runData.Trigger, 'runData 应包含每个已执行节点');
  assert.equal(runData.Trigger[0].data.main[0][0].json.ok, 1);
  assert.equal(typeof runData.Trigger[0].startTime, 'number');

  // IF 的 true 分支必须落在 main[0]，false 分支为空数组
  assert.equal(runData.IF[0].data.main[0][0].json.v, 1);
  assert.deepEqual(runData.IF[0].data.main[1], []);
});

test('执行详情：不存在的执行返回 404 JSON', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/executions/nope', { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

// —— 运行工作流 ——

test('运行工作流：提交引擎并返回 executionId；不存在的 workflow 返回 404', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();

  const res = await req(env, '/workflows/w1/run', jsonRequest({ data: { hello: 'world' } }, { Cookie: cookie }));
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.ok(body.data.executionId, '应返回 executionId');
  assert.equal(flowCreateCalls.length, 1);
  assert.equal(flowCreateCalls[0].params.workflowId, 'w1');

  // 执行记录应已落库
  const row = await db.prepare('SELECT status FROM executions WHERE id=?').bind(body.data.executionId).first<{ status: string }>();
  assert.ok(row, '执行记录必须已写入 D1');
  assert.equal(row!.status, 'running');

  const missing = await req(env, '/workflows/nope/run', jsonRequest({}, { Cookie: cookie }));
  assert.equal(missing.status, 404);
});

// —— 未知路径 ——

test('未知 /rest/* 路径返回 404 JSON，而不是 200 + SPA HTML', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/definitely-not-a-route', { headers: { Cookie: cookie } });
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json() as any;
  assert.equal(body.code, 404);
});

// —— Push 订阅鉴权 ——

test('Push 订阅端点：未登录 401，已登录转发到 Durable Object', async () => {
  const { env, pushEvents } = makeEnv();
  const app = new Hono<{ Bindings: Env }>().get('/rest/push', pushSubscribeHandler);

  const anon = await app.request('/rest/push', {}, env as never);
  assert.equal(anon.status, 401, '匿名客户端不得订阅全实例执行事件流');

  const cookie = await loginCookie(restApi, env);
  const authed = await app.request('/rest/push', { headers: { Cookie: cookie } }, env as never);
  assert.equal(authed.status, 200);
  assert.equal(pushEvents.length, 0); // 只是订阅，不应产生事件
});
