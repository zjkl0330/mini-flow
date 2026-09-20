// tests/integration/app-wiring.test.ts
// 回归 REQ-14 / REQ-31 的「注册顺序」真实守卫：
// 现有 webhook.test.ts 自己复刻了 makeApp()（自带正确顺序），因此无法发现
// src/index.ts 里 /webhook、/form 被误挪到 SPA fallback 之后 —— 本文件通过测试用
// ESM loader 把 `cloudflare:workers` 重定向到桩模块，直接装配**真实 src/index.ts**
// 的 Worker default export，锁定 index.ts 的装配顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { makeEnv } from '../helpers/env';
import type { Env } from '../../src/types';

// 必须在动态 import src/index.ts 之前注册 loader。
register('../helpers/cf-loader.mjs', import.meta.url);
const worker = (await import('../../src/index')).default as unknown as {
  fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
};

function call(path: string, init: RequestInit, env: unknown): Promise<Response> {
  const req = new Request(`http://localhost${path}`, init);
  return worker.fetch(req, env, { waitUntil: () => {}, passThroughOnException: () => {} });
}

test('真实 index.ts 装配：未注册的 /webhook 返回 404 JSON（不得落 SPA fallback）', async () => {
  const { env } = makeEnv();
  // POST：fallback 是 app.get('*')，不拦 POST —— 用于覆盖「非 GET」路径
  const post = await call('/webhook/nope', { method: 'POST' }, env as Env);
  assert.equal(post.status, 404, '/webhook/nope (POST) 必须是 404（若 200 说明被 SPA fallback 拦截）');
  assert.match(post.headers.get('content-type') ?? '', /application\/json/);
  assert.equal((await post.json() as { code: number }).code, 404);
  // GET：正是会被 app.get('*') 抢先拦截的方法 —— 注册顺序错误必然在此暴露
  const get = await call('/webhook/nope', { method: 'GET' }, env as Env);
  assert.equal(get.status, 404, '/webhook/nope (GET) 必须是 404（GET 会被 SPA fallback 抢先）');
  assert.match(get.headers.get('content-type') ?? '', /application\/json/);
});

test('真实 index.ts 装配：未注册的 /form 返回 404 JSON（REQ-31）', async () => {
  const { env } = makeEnv();
  const res = await call('/form/nope', { method: 'GET' }, env as Env);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});

test('真实 index.ts 装配：/webhook-test 未注册同样 404 JSON', async () => {
  const { env } = makeEnv();
  for (const method of ['POST', 'GET']) {
    const res = await call('/webhook-test/nope', { method }, env as Env);
    assert.equal(res.status, 404, `/webhook-test/nope (${method}) 应 404`);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  }
});

test('真实 index.ts 装配：普通未知路径仍走 SPA fallback（对照组）', async () => {
  const { env } = makeEnv();
  const res = await call('/some-editor-page', { method: 'GET' }, env as Env);
  // 测试环境无 ASSETS 绑定 → fallback 返回提示文本（200），而非 404 JSON。
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /application\/json/);
});

test('真实 index.ts 装配：命中已激活的 /webhook 会真正触发执行', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  await db.prepare('INSERT INTO workflows (id,name,nodes,connections,active) VALUES (?,?,?,?,?)')
    .bind('w1', 'Hook', JSON.stringify([
      { parameters: { path: 'real-hook', httpMethod: 'POST' }, name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0] },
    ]), '{}', 1).run();

  const res = await call('/webhook/real-hook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
  }, env as Env);
  assert.equal(res.status, 200);
  assert.equal((await res.json() as { message: string }).message, 'Workflow was started');
  assert.equal(flowCreateCalls.length, 1);
});
