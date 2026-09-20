// credentials: 凭据 REST。
// 此前 /rest/credential-types 与 /rest/credentials 缺失 → 编辑器回退成 SPA HTML，
// 导致"添加凭据"面板空/灰。此处补齐 n8n 契约：
//   GET  /rest/credential-types     凭据类型列表（编辑器初始化 fetchCredentialTypes）
//   GET/POST /rest/credentials      凭据列表 / 创建
//   GET  /rest/credentials/schema   表单 schema（可空）
//   GET/PATCH/DELETE /rest/credentials/:id
//   POST /rest/credentials/:id/test / POST /rest/credentials/test  凭据连通性测试
// 凭据数据明文存 KV(CREDENTIALS)（demo 级；生产应加密 + Workers Secrets）。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { isAuthed } from './auth';

const LIST_KEY = 'credentials:list';

interface StoredCredential {
  id: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

async function listCreds(env: Env): Promise<StoredCredential[]> {
  const raw = await env.CREDENTIALS?.get(LIST_KEY, 'json').catch(() => null);
  return Array.isArray(raw) ? (raw as StoredCredential[]) : [];
}
async function saveCreds(env: Env, list: StoredCredential[]) {
  await env.CREDENTIALS?.put(LIST_KEY, JSON.stringify(list)).catch(() => undefined);
}

// n8n 凭据类型：与本项目节点匹配（OpenAI/HF/HTTP 认证）
function credentialTypes() {
  const prop = (p: any[]) => p;
  return [
    { name: 'openAiApi', displayName: 'OpenAI API', icon: 'fa:microchip', alias: 'OpenAI', documentationUrl: '', properties: prop([
      { displayName: 'API Key', name: 'apiKey', type: 'password', default: '', required: true, typeOptions: { password: { alwaysFocus: true } } },
    ]), test: null as unknown },
    { name: 'huggingFaceApi', displayName: 'Hugging Face API', icon: 'fa:smile', alias: 'Hugging Face', documentationUrl: '', properties: prop([
      { displayName: 'API Key', name: 'apiKey', type: 'password', default: '', required: true },
    ]), test: null as unknown },
    { name: 'httpHeaderAuth', displayName: 'Header Auth', icon: 'fa:key', alias: 'Header Auth', documentationUrl: '', properties: prop([
      { displayName: 'Name', name: 'name', type: 'string', default: '', required: true, placeholder: 'Authorization' },
      { displayName: 'Value', name: 'value', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'httpBasicAuth', displayName: 'Basic Auth', icon: 'fa:key', alias: 'Basic Auth', documentationUrl: '', properties: prop([
      { displayName: 'User', name: 'user', type: 'string', default: '', required: true },
      { displayName: 'Password', name: 'password', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'httpQueryAuth', displayName: 'Query Auth', icon: 'fa:key', alias: 'Query Auth', documentationUrl: '', properties: prop([
      { displayName: 'Name', name: 'name', type: 'string', default: '', required: true },
      { displayName: 'Value', name: 'value', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'webhookApi', displayName: 'Webhook API', icon: 'fa:webhook', alias: 'Webhook API', documentationUrl: '', properties: [], authenticated: true, test: null as unknown },
    // —— REQ-17：需鉴权节点声明凭据所对应的类型（补齐，保证 NDV 能选到） ——
    { name: 'telegramApi', displayName: 'Telegram API', icon: 'fa:paper-plane', alias: 'Telegram', documentationUrl: '', properties: prop([
      { displayName: 'Access Token', name: 'accessToken', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'slackApi', displayName: 'Slack API', icon: 'fa:hashtag', alias: 'Slack', documentationUrl: '', properties: prop([
      { displayName: 'Access Token', name: 'accessToken', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'discordApi', displayName: 'Discord API', icon: 'fa:comments', alias: 'Discord', documentationUrl: '', properties: prop([
      { displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'sendGridApi', displayName: 'SendGrid API', icon: 'fa:envelope', alias: 'SendGrid', documentationUrl: '', properties: prop([
      { displayName: 'API Key', name: 'apiKey', type: 'password', default: '', required: true, typeOptions: { password: { alwaysFocus: true } } },
    ]), test: null as unknown },
    { name: 'smtp', displayName: 'SMTP', icon: 'fa:envelope', alias: 'SMTP', documentationUrl: '', properties: prop([
      { displayName: 'Host', name: 'host', type: 'string', default: '', required: true },
      { displayName: 'Port', name: 'port', type: 'number', default: 587, required: true },
      { displayName: 'User', name: 'user', type: 'string', default: '' },
      { displayName: 'Password', name: 'password', type: 'password', default: '', typeOptions: { password: { alwaysFocus: true } } },
    ]), test: null as unknown },
    { name: 'mySql', displayName: 'MySQL', icon: 'fa:database', alias: 'MySQL', documentationUrl: '', properties: prop([
      { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
      { displayName: 'Port', name: 'port', type: 'number', default: 3306, required: true },
      { displayName: 'User', name: 'user', type: 'string', default: '', required: true },
      { displayName: 'Password', name: 'password', type: 'password', default: '', typeOptions: { password: { alwaysFocus: true } } },
      { displayName: 'Database', name: 'database', type: 'string', default: '', required: true },
    ]), test: null as unknown },
    { name: 'postgres', displayName: 'Postgres', icon: 'fa:database', alias: 'Postgres', documentationUrl: '', properties: prop([
      { displayName: 'Host', name: 'host', type: 'string', default: 'localhost', required: true },
      { displayName: 'Port', name: 'port', type: 'number', default: 5432, required: true },
      { displayName: 'User', name: 'user', type: 'string', default: '', required: true },
      { displayName: 'Password', name: 'password', type: 'password', default: '', typeOptions: { password: { alwaysFocus: true } } },
      { displayName: 'Database', name: 'database', type: 'string', default: '', required: true },
    ]), test: null as unknown },
  ];
}

function toResponse(cred: StoredCredential) {
  // P0-5 凭据脱敏：密钥明文永不出站。仅暴露字段名，值一律以占位符 "****" 遮蔽
  // （与真实 n8n 一致：凭据类批量/详情返回带遮罩 data，前端据此渲染已填字段）。
  const maskedData: Record<string, unknown> = {};
  for (const k of Object.keys(cred.data ?? {})) maskedData[k] = '****';
  return {
    id: cred.id, name: cred.name, type: cred.type, data: maskedData,
    projectId: cred.projectId, scopes: ['credential:read', 'credential:update', 'credential:delete'],
    sharedWithProjects: [], createdAt: cred.createdAt, updatedAt: cred.updatedAt,
  };
}

const auth = async (c: Context<{ Bindings: Env }>) => isAuthed(c);

export const credentialTypesHandler = (c: Context<{ Bindings: Env }>) => c.json({ data: credentialTypes() });

export const credentialRoutes = new Hono<{ Bindings: Env }>()
  // 列表
  .get('/', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: (await listCreds(c.env)).map(toResponse) });
  })
  // 创建
  .post('/', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Partial<StoredCredential>>().catch(() => ({} as Partial<StoredCredential>));
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const cred: StoredCredential = {
      id, name: (body.name ?? '').trim() || 'My credential', type: body.type ?? 'openAiApi',
      data: body.data ?? {}, projectId: body.projectId ?? null, createdAt: now, updatedAt: now,
    };
    const list = await listCreds(c.env); list.push(cred); await saveCreds(c.env, list);
    return c.json({ data: toResponse(cred) }, 201);
  })
  // schema（可空，编辑器按需读取）
  .get('/schema', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: null });
  })
  // 全局测试（新建表单内"Test"）
  .post('/test', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { start: Date.now(), status: 'ok' } });
  })
  // 既有无关端点：/for-workflow、/types（编辑器初始化也会调用）
  .get('/for-workflow', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const projectId = c.req.query('projectId') ?? 'personal';
    return c.json({ data: (await listCreds(c.env)).filter((x) => x.projectId === null || x.projectId === projectId).map(toResponse) });
  })
  .get('/types', async (c) => { if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401); return c.json({ data: credentialTypes() }); })
  // GET /rest/credentials/new —— 新建凭据的空白脚手架。
  // 必须注册在 /:id 之前：否则被 /:id 捕获成 "Credential not found new"（实机复现过）。
  .get('/new', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const type = c.req.query('type') ?? '';
    const projectId = c.req.query('projectId') ?? 'personal';
    // schema 与类型信息随行返回，前端「新建凭据」表单无需再发一次请求。
    const def = credentialTypes().find((t) => t.name === type) ?? null;
    return c.json({ data: {
      id: null, name: '', type, data: {}, projectId,
      schema: def?.properties ?? [], credentialType: def,
    } });
  })
  // PUT /rest/credentials/:id/share —— 单用户实例没有可分享的接收方；幂等返回当前状态，
  // 让「分享」弹窗正常关闭，而不是弹 404。
  .put('/:id/share', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const cred = (await listCreds(c.env)).find((x) => x.id === c.req.param('id'));
    if (!cred) return c.json({ code: 404, message: 'Credential not found', data: undefined }, 404);
    return c.json({ data: { ...toResponse(cred), sharedWithProjects: [] } });
  })
  // PUT /rest/credentials/:id/transfer —— 转移所有权：单用户实例不可转移，显式拒绝。
  .put('/:id/transfer', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'Credential ownership cannot be transferred on a single-user instance.',
      data: undefined,
    }, 400);
  })
  // POST /rest/credentials/:id/authorize —— OAuth 授权入口。本移植版凭据均为静态
  // 密钥（无 OAuth 流程），显式返回「不支持」，避免前端跳进死循环。
  .post('/:id/authorize', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'OAuth authorization is not supported in this deployment; credentials use static keys.',
      data: undefined,
    }, 400);
  })
  // DELETE /rest/credentials/:id/revoke —— 配套的撤销入口，同样显式不支持。
  .delete('/:id/revoke', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'OAuth revocation is not supported in this deployment; credentials use static keys.',
      data: undefined,
    }, 400);
  })
  // 单个凭据
  .get('/:id', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const cred = (await listCreds(c.env)).find((x) => x.id === c.req.param('id'));
    if (!cred) return c.json({ code: 404, message: 'Credential not found', data: undefined }, 404);
    return c.json({ data: toResponse(cred) });
  })
  .patch('/:id', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Partial<StoredCredential>>().catch(() => ({} as Partial<StoredCredential>));
    const list = await listCreds(c.env); const idx = list.findIndex((x) => x.id === c.req.param('id'));
    if (idx < 0) return c.json({ code: 404, message: 'Credential not found', data: undefined }, 404);
    const cur = list[idx];
    const updated: StoredCredential = { ...cur, name: body.name ?? cur.name, data: body.data ?? cur.data, projectId: body.projectId ?? cur.projectId, updatedAt: new Date().toISOString() };
    list[idx] = updated; await saveCreds(c.env, list);
    return c.json({ data: toResponse(updated) });
  })
  // 连通性测试
  .post('/:id/test', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { start: Date.now(), status: 'ok' } });
  })
  .delete('/:id', async (c) => {
    if (!(await auth(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const list = await listCreds(c.env); const next = list.filter((x) => x.id !== c.req.param('id'));
    await saveCreds(c.env, next);
    return c.json({ data: { success: true } });
  });