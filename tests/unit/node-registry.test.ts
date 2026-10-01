// 节点注册表解析测试。
// 锁定既往缺陷：泛化 /webhook/i 排在特化规则之前，导致
//   n8n-nodes-base.respondToWebhook → webhookNode（错）
//   n8n-nodes-base.webhookSend      → webhookNode（错）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutor, passthroughNode } from '../../src/nodes';
import { webhookNode, manualTriggerNode } from '../../src/nodes/webhook';
import { respondToWebhookNode, switchNode, noOpNode } from '../../src/nodes/logic';
import { webhookSendNode } from '../../src/nodes/notify';
import { ifNode, setNode } from '../../src/nodes/if-condition';
import { codeNode } from '../../src/nodes/code-node';
import { httpRequestNode } from '../../src/nodes/http-request';

test('respondToWebhook 必须解析为 respondToWebhookNode（回归：曾被 webhookNode 抢占）', () => {
  assert.equal(resolveExecutor('n8n-nodes-base.respondToWebhook'), respondToWebhookNode);
});

test('webhookSend 必须解析为 webhookSendNode（回归：曾被 webhookNode 抢占）', () => {
  assert.equal(resolveExecutor('n8n-nodes-base.webhookSend'), webhookSendNode);
});

test('通用 webhook 仍解析为 webhookNode', () => {
  assert.equal(resolveExecutor('n8n-nodes-base.webhook'), webhookNode);
});

test('其它核心节点类型映射正确', () => {
  assert.equal(resolveExecutor('n8n-nodes-base.manualTrigger'), manualTriggerNode);
  assert.equal(resolveExecutor('n8n-nodes-base.if'), ifNode);
  assert.equal(resolveExecutor('n8n-nodes-base.set'), setNode);
  assert.equal(resolveExecutor('n8n-nodes-base.code'), codeNode);
  assert.equal(resolveExecutor('n8n-nodes-base.switch'), switchNode);
  assert.equal(resolveExecutor('n8n-nodes-base.noOp'), noOpNode);
  assert.equal(resolveExecutor('n8n-nodes-base.httpRequest'), httpRequestNode);
  assert.equal(resolveExecutor('n8n-nodes-base.function'), codeNode);
});

test('未知节点类型回落透传（不中断模板执行）', () => {
  assert.equal(resolveExecutor('n8n-nodes-community.someUnknownThing'), passthroughNode);
});
