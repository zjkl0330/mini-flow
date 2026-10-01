// tests/integration/webhook.test.ts
// REQ-14 / REQ-31：外部触发（Webhook / Webhook-Test / Form）集成测试。
// 关键回归：/webhook、/form 必须早于 SPA fallback，未匹配返回 404 JSON（而非 200 HTML）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Env } from '../../src/types';
import {
  handleWebhookRequest, handleFormRequest,
  determineResponseMode, flattenNodeOutput, waitForExecutionResponse,
} from '../../src/n8n/webhook';
import { makeEnv } from '../helpers/env';
import type { FakeD1 } from '../helpers/d1';

// 复刻 src/index.ts 的注册顺序：webhook/form 在 SPA fallback 之前注册。
function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all('/webhook', (c) => handleWebhookRequest(c, { test: false }));
  app.all('/webhook/*', (c) => handleWebhookRequest(c, { test: false }));
  app.all('/webhook-test', (c) => handleWebhookRequest(c, { test: true }));
  app.all('/webhook-test/*', (c) => handleWebhookRequest(c, { test: true }));
  app.all('/form', (c) => handleFormRequest(c));
  app.all('/form/*', (c) => handleFormRequest(c));
  app.get('*', (c) => c.text('SPA_FALLBACK', 200));
  return app;
}

interface NodeSpec { parameters: Record<string, unknown>; name: string; type: string }

function node(name: string, type: string, parameters: Record<string, unknown>): Record<string, unknown> {
  return { parameters, name, type, typeVersion: 1, position: [0, 0] };
}

async function insertWorkflow(db: FakeD1, id: string, name: string, nodes: unknown[], active: number): Promise<void> {
  await db.prepare('INSERT INTO workflows (id,name,nodes,connections,active) VALUES (?,?,?,?,?)')
    .bind(id, name, JSON.stringify(nodes), JSON.stringify({}), active).run();
}

test('未注册的 /webhook 返回 404 JSON（不再落 SPA fallback 的 200 HTML）', async () => {
  const { env } = makeEnv();
  const app = makeApp();
  const res = await app.request('/webhook/nope', {}, env as never);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const text = await res.text();
  assert.notEqual(text, 'SPA_FALLBACK', '不得落 SPA fallback');
  const body = JSON.parse(text) as { code: number };
  assert.equal(body.code, 404);
});

test('命中已激活 webhook 工作流：触发执行 + 返回 started 且 D1 落 mode=webhook', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', 'Hook WF', [
    node('Webhook', 'n8n-nodes-base.webhook', { path: 'foo', httpMethod: 'POST' }),
  ], 1);

  const res = await app.request('/webhook/foo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  }, env as never);
  assert.equal(res.status, 200);
  const body = await res.json() as { message: string };
  assert.equal(body.message, 'Workflow was started');

  assert.equal(flowCreateCalls.length, 1, '应提交一次执行到 FlowEngine');
  assert.equal(flowCreateCalls[0].params.workflowId, 'w1');

  const row = await db.prepare('SELECT mode, status FROM executions WHERE workflow_id=?').bind('w1').first<{ mode: string; status: string }>();
  assert.ok(row, '应写入 execution 行');
  assert.equal(row!.mode, 'webhook');
});

test('HTTP 方法不匹配的 webhook 视为未注册（404）', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', 'Hook WF', [
    node('Webhook', 'n8n-nodes-base.webhook', { path: 'foo', httpMethod: 'POST' }),
  ], 1);

  const res = await app.request('/webhook/foo', { method: 'GET' }, env as never);
  assert.equal(res.status, 404);
});

test('/webhook-test 仅匹配未激活工作流；生产 /webhook 不匹配 active=0', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w0', 'Inactive WF', [
    node('Webhook', 'n8n-nodes-base.webhook', { path: 'bar' }),
  ], 0);

  const prod = await app.request('/webhook/bar', {}, env as never);
  assert.equal(prod.status, 404, 'active=0 不应被生产 /webhook 命中');

  const testUrl = await app.request('/webhook-test/bar', {}, env as never);
  assert.equal(testUrl.status, 200);
  assert.equal(flowCreateCalls.length, 1);
  assert.equal(flowCreateCalls[0].params.workflowId, 'w0');
});

test('determineResponseMode：responseNode / lastNode / onReceived 三态', () => {
  const respondNode = node('Respond', 'n8n-nodes-base.respondToWebhook', {});
  const plainHook = node('Webhook', 'n8n-nodes-base.webhook', {});

  assert.equal(
    determineResponseMode({ name: 'w', nodes: [respondNode as never], connections: {} }, plainHook as never),
    'responseNode',
    '含启用 respondToWebhook 的工作流 → responseNode',
  );
  assert.equal(
    determineResponseMode({ name: 'w', nodes: [], connections: {} }, node('Webhook', 'n8n-nodes-base.webhook', { responseMode: 'lastNode' }) as never),
    'lastNode',
  );
  assert.equal(
    determineResponseMode({ name: 'w', nodes: [], connections: {} }, plainHook as never),
    'onReceived',
  );
});

test('flattenNodeOutput：单条取对象，多条取数组，空取 {}，null 原样', () => {
  assert.deepEqual(flattenNodeOutput(JSON.stringify({ main: [{ json: { a: 1 } }] })), { a: 1 });
  assert.deepEqual(flattenNodeOutput(JSON.stringify({ main: [{ json: { a: 1 } }, { json: { a: 2 } }] })), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(flattenNodeOutput(JSON.stringify({ main: [] })), {});
  assert.equal(flattenNodeOutput(null), null);
});

test('waitForExecutionResponse：responseNode 模式取回包体与 responseCode', async () => {
  const { env, db } = makeEnv();
  await insertWorkflow(db, 'w1', 'WF', [
    node('Webhook', 'n8n-nodes-base.webhook', { path: 'foo' }),
    node('Respond', 'n8n-nodes-base.respondToWebhook', { responseCode: 201 }),
  ], 1);
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,finished_at) VALUES ('e1','w1','completed','webhook',datetime('now'))").run();
  await db.prepare(
    "INSERT INTO node_executions (execution_id,node_name,node_type,status,output_data,started_at,finished_at) "
    + "VALUES ('e1','Respond','n8n-nodes-base.respondToWebhook','completed',?,datetime('now'),datetime('now'))",
  ).bind(JSON.stringify({ main: [{ json: { ok: true, id: 7 } }] })).run();

  const resp = await waitForExecutionResponse(env as never, 'e1', 'responseNode');
  assert.ok(resp, '已完成执行应取到回包');
  assert.equal(resp!.statusCode, 201);
  assert.deepEqual(resp!.body, { ok: true, id: 7 });
});

test('waitForExecutionResponse：未完成执行超时返回 null（可回退 onReceived）', async () => {
  const { env, db } = makeEnv();
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode) VALUES ('e2','w1','running','webhook')").run();
  const resp = await waitForExecutionResponse(env as never, 'e2', 'onReceived', 50);
  assert.equal(resp, null);
});

test('Form：GET 渲染 HTML、POST 触发执行（urlencoded / JSON accept）、未知 404 JSON', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', 'Form WF', [
    node('Form', 'n8n-nodes-base.formTrigger', {
      path: 'my-form', formTitle: '订阅', formFields: [{ fieldName: 'email', fieldLabel: '邮箱', fieldType: 'email' }],
    }),
  ], 1);

  const get = await app.request('/form/my-form', {}, env as never);
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type') ?? '', /text\/html/);
  const html = await get.text();
  assert.match(html, /邮箱/);
  assert.match(html, /name="email"/);

  const post = await app.request('/form/my-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=a%40b.com',
  }, env as never);
  assert.equal(post.status, 200);
  assert.equal(flowCreateCalls.length, 1);

  const postJson = await app.request('/form/my-form', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: 'x@y.com' }),
  }, env as never);
  assert.equal(postJson.status, 200);
  const jsonBody = await postJson.json() as { data: { executionId: string } };
  assert.ok(jsonBody.data.executionId);
  assert.equal(flowCreateCalls.length, 2);

  const missing = await app.request('/form/nope', {}, env as never);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/);
});
