// tests/integration/webhook-determinism.test.ts
// SEC-2：外部触发入口的**确定性选取**。
//
// 背景：matchWebhookWorkflow / matchFormWorkflow 原先的 SQL 无 ORDER BY，
// 命中顺序取决于 SQLite 的实现细节（rowid 扫描 / 索引选择），
// 于是「同名 path 的多个已激活工作流」谁被触发是不确定的 —— 改一条无关数据就可能换绑。
// 本文件锁定：按 created_at 升序（最早创建者胜出），created_at 相同则按 rowid 稳定兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchWebhookWorkflow, matchFormWorkflow } from '../../src/n8n/webhook';
import { makeEnv } from '../helpers/env';

type Db = ReturnType<typeof makeEnv>['db'];

const webhookNodes = (path: string) => JSON.stringify([{
  parameters: { path, httpMethod: 'GET' },
  name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
}]);

const formNodes = (path: string) => JSON.stringify([{
  parameters: { path },
  name: 'Form', type: 'n8n-nodes-base.formTrigger', typeVersion: 1, position: [0, 0],
}]);

async function insert(
  db: Db, id: string, name: string, nodes: string, createdAt: string, active = 1,
): Promise<void> {
  await db.prepare(
    'INSERT INTO workflows (id,name,nodes,connections,active,created_at) VALUES (?,?,?,?,?,?)',
  ).bind(id, name, nodes, '{}', active, createdAt).run();
}

test('SEC-2：webhook 同名 path 取最早创建者，与插入顺序无关', async () => {
  const { env, db } = makeEnv();
  // 故意先插入「更晚创建」的，再插入「更早创建」的 —— 若按插入/rowid 顺序就会取错
  await insert(db, 'w-late', 'Late', webhookNodes('hook'), '2026-02-01 00:00:00');
  await insert(db, 'w-early', 'Early', webhookNodes('hook'), '2026-01-01 00:00:00');

  const m = await matchWebhookWorkflow(env as never, 'hook', 'GET', { test: false });
  assert.ok(m, '应能匹配到工作流');
  assert.equal(m!.workflow.id, 'w-early', '同名 path 必须稳定取最早创建者');
});

test('SEC-2：created_at 相同时按 rowid 稳定兜底（秒级精度同类场景）', async () => {
  const { env, db } = makeEnv();
  const sameSecond = '2026-03-01 12:00:00';
  await insert(db, 'w-first', 'First', webhookNodes('dup'), sameSecond);
  await insert(db, 'w-second', 'Second', webhookNodes('dup'), sameSecond);

  const a = await matchWebhookWorkflow(env as never, 'dup', 'GET', { test: false });
  const b = await matchWebhookWorkflow(env as never, 'dup', 'GET', { test: false });
  assert.equal(a!.workflow.id, 'w-first');
  assert.equal(b!.workflow.id, a!.workflow.id, '多次匹配结果必须一致（可重复）');
});

test('SEC-2：未激活工作流不参与生产匹配；test 模式只匹配未激活者', async () => {
  const { env, db } = makeEnv();
  await insert(db, 'w-active', 'Active', webhookNodes('mix'), '2026-01-01 00:00:00', 1);
  await insert(db, 'w-inactive', 'Inactive', webhookNodes('mix'), '2025-01-01 00:00:00', 0);

  const prod = await matchWebhookWorkflow(env as never, 'mix', 'GET', { test: false });
  assert.equal(prod!.workflow.id, 'w-active', '生产只匹配 active=1');

  const testMode = await matchWebhookWorkflow(env as never, 'mix', 'GET', { test: true });
  assert.equal(testMode!.workflow.id, 'w-inactive', '测试模式只匹配 active=0');
});

test('SEC-2：httpMethod 不匹配的节点被跳过，回落到方法匹配的候选', async () => {
  const { env, db } = makeEnv();
  await db.prepare(
    'INSERT INTO workflows (id,name,nodes,connections,active,created_at) VALUES (?,?,?,?,1,?)',
  ).bind('w-post', 'PostOnly', JSON.stringify([{
    parameters: { path: 'm', httpMethod: 'POST' },
    name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
  }]), '{}', '2026-01-01 00:00:00').run();
  await insert(db, 'w-get', 'GetOk', webhookNodes('m'), '2026-02-01 00:00:00');

  const m = await matchWebhookWorkflow(env as never, 'm', 'GET', { test: false });
  assert.equal(m!.workflow.id, 'w-get', 'POST-only 节点不应拦下 GET 请求');
});

test('SEC-2：form 入口同样具备确定性（最早创建者胜出）', async () => {
  const { env, db } = makeEnv();
  await insert(db, 'f-late', 'FLate', formNodes('apply'), '2026-02-01 00:00:00');
  await insert(db, 'f-early', 'FEarly', formNodes('apply'), '2026-01-01 00:00:00');

  const m = await matchFormWorkflow(env as never, 'apply');
  assert.equal(m!.workflow.id, 'f-early');
});

test('SEC-2：path 归一化（首尾斜杠 / URL 编码）后仍稳定命中', async () => {
  const { env, db } = makeEnv();
  await insert(db, 'w-norm', 'Norm', webhookNodes('my/hook'), '2026-01-01 00:00:00');

  for (const p of ['my/hook', '/my/hook', 'my/hook/', '/my/hook/']) {
    const m = await matchWebhookWorkflow(env as never, p, 'GET', { test: false });
    assert.equal(m?.workflow.id, 'w-norm', `${p} 应归一化后命中`);
  }
});
