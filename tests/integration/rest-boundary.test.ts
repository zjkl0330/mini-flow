// tests/integration/rest-boundary.test.ts
// 本轮增量 REST 端点的对抗性边界：retry / export / import / tags / community / insights。
// 目标：确认「不存在的资源 → 404（非 500）」「非法 body → 4xx（非 500）」
//       「导入 id 冲突 → 重新分配，不覆盖」等异常路径都被正确收口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { makeEnv, loginCookie, jsonRequest } from '../helpers/env';

const req = (env: unknown, path: string, init: RequestInit = {}) => restApi.request(path, init, env as never);
const cookieHdr = (cookie: string) => ({ headers: { Cookie: cookie } });
const jsonWithCookie = (body: unknown, cookie: string) =>
  ({ method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }) as RequestInit;

// —— retry 边界 ——

test('retry：不存在的执行 404；执行存在但工作流缺失 404（均不得 500）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);

  assert.equal((await req(env, '/executions/nope/retry', jsonWithCookie({}, cookie))).status, 404);

  // 造一个「孤立执行」（其 workflow 不存在）——临时关闭 FK 约束
  db.exec('PRAGMA foreign_keys = OFF');
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode) VALUES ('orphan','ghost','failed','manual')").run();
  const res = await req(env, '/executions/orphan/retry', jsonWithCookie({}, cookie));
  assert.equal(res.status, 404, '工作流缺失应 404，而非 500');
  db.exec('PRAGMA foreign_keys = ON');
});

test('retry：对 completed 执行也可重跑（设计允许重跑既有执行）', async () => {
  const { env, db, flowCreateCalls } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare("INSERT INTO executions (id,workflow_id,status,mode,finished_at) VALUES ('e1','w1','completed','manual',datetime('now'))").run();

  const res = await req(env, '/executions/e1/retry', jsonWithCookie({}, cookie));
  assert.equal(res.status, 200);
  const body = await res.json() as { data: { retryOf: string } };
  assert.equal(body.data.retryOf, 'e1');
  assert.equal(flowCreateCalls.length, 1);
});

// —— export 边界 ——

test('export：不存在 404；文件名特殊字符被安全化', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  assert.equal((await req(env, '/workflows/nope/export', cookieHdr(cookie))).status, 404);

  await db.prepare('INSERT INTO workflows (id,name,nodes,connections) VALUES (?,?,?,?)')
    .bind('w1', 'a/b c*', '[]', '{}').run();
  const res = await req(env, '/workflows/w1/export', cookieHdr(cookie));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /filename="a_b_c_\.json"/);
});

// —— import 边界 ——

test('import：空 body / 非法 JSON / null 均 400（不得 500）；不覆盖既有 id', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','Original','[]','{}')").run();

  // 空 body
  const empty = await req(env, '/workflows/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '',
  });
  assert.equal(empty.status, 400);

  // 非法 JSON
  const bad = await req(env, '/workflows/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{bad json',
  });
  assert.equal(bad.status, 400);

  // 字面量 null
  const nul = await req(env, '/workflows/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: 'null',
  });
  assert.equal(nul.status, 400);

  // 复用已存在的 id → 重新分配，不覆盖原工作流
  const dup = await req(env, '/workflows/import', jsonWithCookie({ id: 'w1', name: 'Hijack', nodes: [], connections: {} }, cookie));
  assert.equal(dup.status, 201);
  const newId = (await dup.json() as { data: { id: string } }).data.id;
  assert.notEqual(newId, 'w1');
  const row = await db.prepare("SELECT name FROM workflows WHERE id='w1'").first<{ name: string }>();
  assert.equal(row!.name, 'Original', '原工作流不得被覆盖');
});

// —— tags 边界 ——

test('tags：PATCH 空 name 400；DELETE 不存在 404（与 community uninstall 语义统一）；DELETE 存在 → 200', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const created = await req(env, '/tags', jsonRequest({ name: 'prod' }, { Cookie: cookie }));
  const id = (await created.json() as { data: { id: string } }).data.id;

  const emptyPatch = await req(env, `/tags/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: '   ' }),
  });
  assert.equal(emptyPatch.status, 400, '空 name 应 400');

  // 语义统一（本轮收口）：DELETE 不存在 → 404，与 community-nodes/:name/uninstall 一致（此前为 200 幂等）
  const delMissing = await req(env, '/tags/does-not-exist', { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(delMissing.status, 404);

  // DELETE 存在的 id → 200 {data:true}
  const delExisting = await req(env, `/tags/${id}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(delExisting.status, 200);
  assert.equal((await delExisting.json() as { data: boolean }).data, true);
});

// —— community-nodes 边界 ——

test('community：空 name 400、重复 409、卸载不存在 404', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  assert.equal((await req(env, '/community-nodes', jsonWithCookie({ name: '   ' }, cookie))).status, 400);
  assert.equal((await req(env, '/community-nodes', jsonWithCookie({ name: 'p' }, cookie))).status, 201);
  assert.equal((await req(env, '/community-nodes', jsonWithCookie({ name: 'p' }, cookie))).status, 409);
  assert.equal((await req(env, '/community-nodes/ghost/uninstall', jsonWithCookie({}, cookie))).status, 404);
});

// —— insights 边界 ——

test('insights：非法/半截日期参数不 500', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  for (const q of ['?startDate=abc&endDate=xxx', '?startDate=2020-01-01', '?endDate=zzz', '?granularity=bogus']) {
    const res = await req(env, `/insights/summary${q}`, cookieHdr(cookie));
    assert.equal(res.status, 200, `insights summary ${q} 应 200`);
  }
  assert.equal((await req(env, '/insights/by-time?granularity=bogus', cookieHdr(cookie))).status, 200);
});

// —— 回归 REQ-22 ——

test('回归 REQ-22：未知 /rest/* 仍 404 JSON', async () => {
  const { env } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  const res = await req(env, '/no-such-endpoint-xyz', cookieHdr(cookie));
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
});
