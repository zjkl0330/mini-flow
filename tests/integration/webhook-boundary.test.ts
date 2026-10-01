// tests/integration/webhook-boundary.test.ts
// REQ-14 / REQ-31 对抗性边界：路径归一化 / 方法匹配 / active 与 test 语义 /
// disabled 节点 / 同名多流 / 中文与二进制 body / responseMode 回包。
// 这些是「验收字面通过、边界却翻车」的高发区。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import type { Env } from '../../src/types';
import { handleWebhookRequest, handleFormRequest } from '../../src/n8n/webhook';
import { makeEnv } from '../helpers/env';
import type { FakeD1 } from '../helpers/d1';

function makeApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all('/webhook', (c) => handleWebhookRequest(c, { test: false }));
  app.all('/webhook/*', (c) => handleWebhookRequest(c, { test: false }));
  app.all('/webhook-test', (c) => handleWebhookRequest(c, { test: true }));
  app.all('/webhook-test/*', (c) => handleWebhookRequest(c, { test: true }));
  app.all('/form/*', (c) => handleFormRequest(c));
  return app;
}

const hook = (name: string, parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ parameters, name, type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], ...extra });

async function insertWorkflow(db: FakeD1, id: string, nodes: unknown[], active: number): Promise<void> {
  await db.prepare('INSERT INTO workflows (id,name,nodes,connections,active) VALUES (?,?,?,?,?)')
    .bind(id, id, JSON.stringify(nodes), JSON.stringify({}), active).run();
}

// —— 路径归一化 ——

test('路径归一化：尾斜杠 / 双斜杠 / URL 编码 命中；大小写敏感（不命中）', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [hook('W', { path: 'e2e-hook', httpMethod: 'POST' })], 1);

  const cases: Array<[string, number]> = [
    ['/webhook/e2e-hook', 200],
    ['/webhook/e2e-hook/', 200],
    ['/webhook//e2e-hook', 200],
    ['/webhook/e2e%2Dhook', 200], // %2D = '-'
    ['/webhook/E2E-HOOK', 404],   // n8n webhook path 大小写敏感
  ];
  for (const [p, expected] of cases) {
    const res = await app.request(p, { method: 'POST' }, env as never);
    assert.equal(res.status, expected, `${p} 期望 ${expected}，实际 ${res.status}`);
  }
});

// —— httpMethod 匹配 ——

test('httpMethod：节点声明 POST 时 GET 视为未注册；GET 节点则反之', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [hook('W', { path: 'post-only', httpMethod: 'POST' })], 1);

  assert.equal((await app.request('/webhook/post-only', { method: 'POST' }, env as never)).status, 200);
  assert.equal((await app.request('/webhook/post-only', { method: 'GET' }, env as never)).status, 404);

  const { env: env2, db: db2 } = makeEnv();
  const app2 = makeApp();
  await insertWorkflow(db2, 'w1', [hook('W', { path: 'get-only', httpMethod: 'GET' })], 1);
  assert.equal((await app2.request('/webhook/get-only', { method: 'GET' }, env2 as never)).status, 200);
  assert.equal((await app2.request('/webhook/get-only', { method: 'POST' }, env2 as never)).status, 404);
});

// —— /webhook-test 只对未激活工作流生效 ——

test('/webhook-test 只匹配 active=0；生产 /webhook 只匹配 active=1（双向隔离）', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'on', [hook('W', { path: 'p' })], 1);
  await insertWorkflow(db, 'off', [hook('W', { path: 'q' })], 0);

  assert.equal((await app.request('/webhook-test/p', { method: 'POST' }, env as never)).status, 404, 'active=1 不应被 test URL 命中');
  assert.equal((await app.request('/webhook-test/q', { method: 'POST' }, env as never)).status, 200, 'active=0 应被 test URL 命中');
  assert.equal((await app.request('/webhook/q', { method: 'POST' }, env as never)).status, 404, 'active=0 不应被生产 URL 命中');
  assert.equal((await app.request('/webhook/p', { method: 'POST' }, env as never)).status, 200);

  const wfs = flowCreateCalls.map((c) => c.params.workflowId).sort();
  assert.deepEqual(wfs, ['off', 'on']);
});

// —— disabled 节点跳过 ——

test('disabled 的 webhook 节点被跳过（视为未注册 404）', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [hook('W', { path: 'disabled-hook' }, { disabled: true })], 1);
  const res = await app.request('/webhook/disabled-hook', { method: 'POST' }, env as never);
  assert.equal(res.status, 404);
});

// —— 同名 path 多流 ——

test('同名 path 出现在多个已激活工作流：行为确定（首个命中，仅触发一次）', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w-first', [hook('W', { path: 'dup' })], 1);
  await insertWorkflow(db, 'w-second', [hook('W', { path: 'dup' })], 1);

  const res = await app.request('/webhook/dup', { method: 'POST' }, env as never);
  assert.equal(res.status, 200);
  assert.equal(flowCreateCalls.length, 1, '只应触发一条工作流');
  assert.equal(flowCreateCalls[0].params.workflowId, 'w-first', '按 rowid 顺序取首个命中');
});

// —— body 采集：中文 / 二进制 ——

test('body 采集：JSON 中文与 application/octet-stream 原始字节均不得丢数据/500', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [hook('W', { path: 'body-hook' })], 1);

  // 中文 JSON
  const cn = await app.request('/webhook/body-hook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: '你好，世界' }),
  }, env as never);
  assert.equal(cn.status, 200);
  const row = await db.prepare("SELECT input_data FROM executions WHERE workflow_id='w1' ORDER BY rowid DESC LIMIT 1")
    .first<{ input_data: string }>();
  const parsed = JSON.parse(row!.input_data) as { body: { msg: string } };
  assert.equal(parsed.body.msg, '你好，世界', '中文 body 必须原样进入执行输入');

  // 二进制 body（octet-stream）→ 作为原始文本采集，不得 500
  const bin = await app.request('/webhook/body-hook', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array([0x00, 0x01, 0xff, 0xfe]).buffer,
  }, env as never);
  assert.equal(bin.status, 200, '二进制 body 不应 500');
});

// —— responseMode 回包（全 HTTP 链路） ——

function stubEngineToComplete(env: Record<string, unknown>, db: FakeD1, respondOutput: unknown, code: number) {
  (env as { FLOW_ENGINE: { create: unknown } }).FLOW_ENGINE.create = async (opts: { id: string }) => {
    await db.prepare("UPDATE executions SET status='completed', finished_at=datetime('now') WHERE id=?")
      .bind(opts.id).run();
    await db.prepare(
      'INSERT INTO node_executions (execution_id,node_name,node_type,status,output_data,started_at,finished_at) '
      + 'VALUES (?,?,?,?,?,datetime(\'now\'),datetime(\'now\'))',
    ).bind(opts.id, 'Respond', 'n8n-nodes-base.respondToWebhook', 'completed',
      JSON.stringify({ main: [{ json: respondOutput }] })).run();
    void code;
    return { id: opts.id };
  };
}

test('responseNode：POST /webhook 返回 respondToWebhook 输出 + responseCode，而非 started 占位', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [
    hook('W', { path: 'resp-hook' }),
    { parameters: { responseCode: 201 }, name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [0, 0] },
  ], 1);
  stubEngineToComplete(env, db, { ok: true, echo: 42 }, 201);

  const res = await app.request('/webhook/resp-hook', { method: 'POST' }, env as never);
  assert.equal(res.status, 201, 'responseCode 应取 respondToWebhook 的 201');
  assert.deepEqual(await res.json(), { ok: true, echo: 42 });
});

test('onReceived：显式 responseMode 不进等待，立即返回 started', async () => {
  const { env, db } = makeEnv();
  const app = makeApp();
  await insertWorkflow(db, 'w1', [hook('W', { path: 'onrecv', responseMode: 'onReceived' })], 1);
  const res = await app.request('/webhook/onrecv', { method: 'POST' }, env as never);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Workflow was started' });
});

// —— 未匹配响应体契约 ——

test('未注册 webhook 的 404 响应体含 code/message（对齐 n8n 契约）', async () => {
  const { env } = makeEnv();
  const app = makeApp();
  const res = await app.request('/webhook/never-registered', { method: 'POST' }, env as never);
  assert.equal(res.status, 404);
  const body = await res.json() as { code: number; message: string };
  assert.equal(body.code, 404);
  assert.match(body.message, /not registered/i);
});
