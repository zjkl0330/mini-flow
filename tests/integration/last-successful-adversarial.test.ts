// QA 独立对抗性回归（缺陷2：GET /rest/workflows/:id/executions/last-successful）。
//
// 证伪角度（不复跑工程师断言）：
//   * 存在「更晚的失败执行」时，必须仍返回较早的成功执行（按 status 过滤，而非按时间取最后一条）；
//   * 与 GET /rest/executions/:id 的载荷形状必须逐字段一致（同源复用、零漂移）；
//   * 未登录访问该端点仍 401。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { makeEnv, loginCookie } from '../helpers/env';

const req = (env: unknown, path: string, init: RequestInit = {}) =>
  restApi.request(path, init, env as never);

// 造一个「workflow + 一条 completed 执行 + 两条 node_executions」的完整执行
async function seedSuccess(env: unknown, db: any, wfId: string, execId: string, startedAt: string) {
  await db.prepare(
    "INSERT INTO workflows (id,name,nodes,connections) VALUES (?,?,?,?)",
  ).bind(wfId, 'WF', JSON.stringify([{ name: 'Trigger', type: 'n8n-nodes-base.manualTrigger' }]), '{}').run();
  await db.prepare(
    'INSERT INTO executions (id,workflow_id,status,mode,started_at,finished_at) VALUES (?,?,?,?,?,?)',
  ).bind(execId, wfId, 'completed', 'manual', startedAt, startedAt).run();
  await db.prepare(
    'INSERT INTO node_executions (execution_id,node_name,node_type,status,input_data,output_data,started_at,finished_at) '
    + 'VALUES (?,?,?,?,?,?,?,?)',
  ).bind(
    execId, 'Trigger', 'n8n-nodes-base.manualTrigger', 'completed',
    JSON.stringify({ main: [] }), JSON.stringify({ main: [{ json: { ok: 1 } }] }), startedAt, startedAt,
  ).run();
}

test('[QA-D10a] 无成功执行 → { data: null }', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare(
    "INSERT INTO executions (id,workflow_id,status,mode,started_at) VALUES ('e2','w1','failed','manual',datetime('now'))",
  ).run();

  const res = await req(env, '/workflows/w1/executions/last-successful', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json() as any).data, null);
});

test('[QA-D10b] 较晚的失败执行不影响：仍返回较早的成功执行且可取 runData 值', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedSuccess(env, db, 'w1', 'ok', '2026-01-01 00:00:00');
  // 更晚的失败执行（时间更靠后）——若实现按 StartedAt DESC 取最后一条会误返回它
  await db.prepare(
    "INSERT INTO executions (id,workflow_id,status,mode,started_at,finished_at) VALUES ('bad','w1','failed','manual','2026-06-06 00:00:00','2026-06-06 00:00:00')",
  ).run();

  const res = await req(env, '/workflows/w1/executions/last-successful', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const d = (await res.json() as any).data;
  assert.ok(d, '有成功执行时 data 不应为 null');
  assert.equal(d.id, 'ok', '必须返回成功的执行，而非更晚的失败执行');
  assert.equal(d.status, 'success');
  assert.equal(d.data.resultData.runData.Trigger[0].data.main[0][0].json.ok, 1,
    'runData[node][0].data.main[0][0].json 必须可取到值（前端 NDV 消费路径）');
});

test('[QA-D11] 与 GET /rest/executions/:id 载荷形状逐字段一致（同源复用、零漂移）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await seedSuccess(env, db, 'w1', 'e1', '2026-01-01 00:00:00');

  const detailRes = await req(env, '/executions/e1', { headers: { Cookie: cookie } });
  const lastRes = await req(env, '/workflows/w1/executions/last-successful', { headers: { Cookie: cookie } });
  assert.equal(detailRes.status, 200);
  assert.equal(lastRes.status, 200);

  const detail = (await detailRes.json() as any).data;
  const last = (await lastRes.json() as any).data;
  assert.deepEqual(last, detail, '两端点应对同一执行产出完全相同的载荷（复用 executionDetail）');

  // 关键前端路径（dr()）：不得为空数组
  const dr = last?.data?.resultData?.runData?.['Trigger']?.[0]?.data?.main?.[0];
  assert.ok(dr && dr[0]?.json?.ok === 1, 'dr() 路径必须返回非空数据');
});

test('[QA-D11b] 未登录访问 last-successful → 401', async () => {
  const { env, db } = makeEnv();
  await seedSuccess(env, db, 'w1', 'e1', '2026-01-01 00:00:00');
  const res = await req(env, '/workflows/w1/executions/last-successful');
  assert.equal(res.status, 401);
});
