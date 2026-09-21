// last-successful 端点回归测试（缺陷2）。
// 前端（RunData 面板）用 `lastSuccessfulExecution` 直接喂给
//   dr(e, t, n) = e?.data?.resultData?.runData?.[t?.name]?.[n]?.data?.main?.[0]
// 来渲染 NDV「输出」面板的「上次成功执行」数据。若响应体缺少 data.resultData.runData，
// 该函数恒返回 [] —— 端点虽 200，功能却不生效（R4「端点级对账」漏掉的「载荷不足」类缺陷）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { makeEnv, loginCookie } from '../helpers/env';

const req = (env: unknown, path: string, init: RequestInit = {}) =>
  restApi.request(path, init, env as never);

test('last-successful：返回完整执行详情（含 data.resultData.runData），满足前端消费路径', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare(
    "INSERT INTO executions (id,workflow_id,status,mode,started_at,finished_at) "
    + "VALUES ('e1','w1','completed','manual',datetime('now'),datetime('now'))",
  ).run();
  await db.prepare(
    "INSERT INTO node_executions (execution_id,node_name,node_type,status,input_data,output_data,started_at,finished_at) "
    + "VALUES ('e1','Trigger','n8n-nodes-base.manualTrigger','completed',?,?,datetime('now'),datetime('now'))",
  ).bind(JSON.stringify({ main: [] }), JSON.stringify({ main: [{ json: { ok: 1 } }] })).run();

  const res = await req(env, '/workflows/w1/executions/last-successful', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  const d = body.data;
  assert.ok(d, '有成功执行时 data 不应为 null');

  // 状态与 GET /rest/executions/:id 一致：completed → success
  assert.equal(d.status, 'success');
  // 内嵌 workflowData（前端执行预览依赖）
  assert.ok(d.workflowData, '必须内嵌 workflowData');
  assert.equal(d.workflowData.id, 'w1');
  // 关键：data.resultData.runData 存在且路径正确（前端 dr() 正是读该路径）
  assert.ok(d.data && d.data.resultData, '必须提供 resultData');
  const runData = d.data.resultData.runData;
  assert.ok(runData.Trigger, 'runData 应包含已执行节点');
  assert.equal(runData.Trigger[0].data.main[0][0].json.ok, 1, 'runData[node][0].data.main[0][0].json 必须可取到值');
  assert.equal(typeof runData.Trigger[0].startTime, 'number');
});

test('last-successful：无成功执行时仍返回 { data: null }（保持前端 falsy 语义）', async () => {
  const { env, db } = makeEnv();
  const cookie = await loginCookie(restApi, env);
  await db.prepare("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')").run();
  await db.prepare(
    "INSERT INTO executions (id,workflow_id,status,mode,finished_at) "
    + "VALUES ('e2','w1','failed','manual',datetime('now'))",
  ).run();

  const res = await req(env, '/workflows/w1/executions/last-successful', { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.data, null);
});
