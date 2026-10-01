import { Hono } from 'hono';
import type { Env } from './types';
import { restApi } from './n8n/router';
import { templateProxyHandler } from './n8n/templates';
import { sendPush } from './n8n/push';
import { cleanupStaleLocks } from './engine/lock';
import { listPending, purgeDeadLetter, rebuildFromDlq } from './engine/dead-letter';
import { runScheduledWorkflows } from './engine/scheduler';
import { consoleRoute } from './n8n/console';
import { handleWebhookRequest, handleFormRequest } from './n8n/webhook';

const app = new Hono<{ Bindings: Env }>();

const mountPush = (app: any) => {
  const forward = (c: any) => {
    const id = c.env.PUSH.idFromName('main');
    const stub = c.env.PUSH.get(id);
    return stub.fetch(new Request('https://do/push', { headers: c.req.raw.headers }));
  };
  app.get('/rest/push', forward);
  app.get('/push', forward);
};
mountPush(app);

app.route('/rest', restApi);

app.get('/templates/categories', (c) => templateProxyHandler(c));
app.get('/templates/search', (c) => templateProxyHandler(c));
app.get('/templates/collections', (c) => templateProxyHandler(c));
app.get('/templates/workflows/:id', (c) => templateProxyHandler(c));
app.get('/workflows/templates/:id', (c) => templateProxyHandler(c));

app.get('/console', (c) => consoleRoute(c));
app.get('/console/', (c) => consoleRoute(c));

app.all('/webhook', (c) => handleWebhookRequest(c, { test: false }));
app.all('/webhook/*', (c) => handleWebhookRequest(c, { test: false }));
app.all('/webhook-test', (c) => handleWebhookRequest(c, { test: true }));
app.all('/webhook-test/*', (c) => handleWebhookRequest(c, { test: true }));
app.all('/form', (c) => handleFormRequest(c));
app.all('/form/*', (c) => handleFormRequest(c));

app.get('*', async (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.replace(/^\/+/, '');
  if (path === '' || !c.env.ASSETS) {
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.text('mini-flow worker: 未配置 ASSETS');
  }
  const asset = await c.env.ASSETS.fetch(new Request(new URL(c.req.url).origin + '/' + path, c.req.raw));
  if (asset && !asset.status.toString().startsWith('4')) return asset;
  const idx = await c.env.ASSETS.fetch(new Request(new URL(c.req.url).origin + '/index.html'));
  if (idx) return new Response(idx.body, { status: 200, headers: { 'Content-Type': 'text/html' } });
  return c.text('mini-flow worker: 未找到 index.html');
});

const CLEANUP_CRON = async (env: any) => {
  await cleanupStaleLocks(env).catch(() => 0);
  const pending = await listPending(env, 20).catch(() => []);
  for (const dlq of pending) {
    const r = await rebuildFromDlq(env, dlq).catch(() => ({ ok: false, newExecutionId: undefined, error: 'rebuild failed' }));
    if (r.ok && r.newExecutionId) {
      await sendPush(env, { type: 'executionStarted', executionId: r.newExecutionId });
    } else {
      await sendPush(env, { type: 'executionWaiting', executionId: dlq.execution_id });
    }
  }
  await purgeDeadLetter(env).catch(() => 0);
  await runScheduledWorkflows(env).catch(() => 0);
};

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    if (controller.cron === '*/15 * * * *') {
      await CLEANUP_CRON(env);
    }
  },
};

export { PushConnection } from './runtime/push';
export { FlowEngine } from './runtime/flow-engine';