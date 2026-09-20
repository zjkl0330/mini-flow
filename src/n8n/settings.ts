// users, settings：前端初始化必调
import { Hono } from 'hono';
import type { Env } from '../types';
import { isAuthed, owner } from './auth';

// 用户偏好设置（n8n 前端 settings.store 持久化到 /rest/me/settings）。
// 工作流保存/禁用提示等操作会 PATCH 它；缺失时前端报 "Problem saving workflow" 404。
// 用 KV(CREDENTIALS) 持久化，跨 request 保持。
const SETTINGS_KEY = 'user-settings';
async function getStoredSettings(env: Env): Promise<Record<string, unknown>> {
  if (!env.CREDENTIALS) return {};
  const raw = await env.CREDENTIALS.get(SETTINGS_KEY, 'json').catch(() => null);
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

export const userRoutes = new Hono<{ Bindings: Env }>()
  .get('/me', async (c) => {
    // 未登录 → 401，editor-ui 据此导向登录页
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: owner() });
  })
  // GET /rest/me/settings：返回已保存的用户偏好
  .get('/me/settings', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: await getStoredSettings(c.env) });
  })
  // PATCH /rest/me/settings：合并写入用户偏好（前端保存流程会调用）
  .patch('/me/settings', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const cur = await getStoredSettings(c.env);
    const merged = { ...cur, ...body };
    await (c.env.CREDENTIALS?.put(SETTINGS_KEY, JSON.stringify(merged))).catch(() => undefined);
    return c.json({ data: merged });
  })
  .get('/', (c) => c.json({ data: [] }));

// n8n 用户列表：/rest/users（复数）返回 { data: { count, items } }，侧边栏/成员列表据此读取。
// 本实现为单用户实例，必须回传该唯一 owner —— 返回空列表会与 GET /rest/user/me（已登录 owner）
// 自相矛盾，导致「成员管理」页显示无成员。
export const userListRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const me = owner();
    return c.json({ data: { count: 1, items: [{ ...me, role: 'owner' }] } });
  })
  // GET /rest/users/:id/password-reset-link —— 单用户实例无邮件通道，返回空链接而非 404。
  .get('/:id/password-reset-link', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { link: '' } });
  })
  // POST /rest/users/:id/invite-link —— 同上：单用户实例没有可邀请的成员。
  .post('/:id/invite-link', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { link: '' } });
  })
  // PATCH /rest/users/:id/role —— 实例 owner 角色不可变更，显式拒绝。
  .patch('/:id/role', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'The instance owner role cannot be changed on a single-user instance.',
      data: undefined,
    }, 400);
  })
  // PATCH /rest/users/:id/settings —— 更新本人偏好（转发到用户设置存储）。
  .patch('/:id/settings', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const cur = await getStoredSettings(c.env);
    const merged = { ...cur, ...(body ?? {}) };
    await (c.env.CREDENTIALS?.put(SETTINGS_KEY, JSON.stringify(merged))).catch(() => undefined);
    return c.json({ data: { ...owner(), settings: merged } });
  })
  // DELETE /rest/users/:id —— 唯一 owner 不可删除，显式拒绝。
  .delete('/:id', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'The instance owner cannot be deleted.',
      data: undefined,
    }, 400);
  })
  .get('/:id', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const me = owner();
    if (c.req.param('id') !== me.id) return c.json({ code: 404, message: 'User not found', data: undefined }, 404);
    return c.json({ data: { ...me, role: 'owner' } });
  });

// /rest/module-settings：settings.store.getModuleSettings 直接 GET，返回模块级开关配置。
// quick-connect.options 为空数组，避免 useQuickConnect 读 moduleSettings['quick-connect'] 崩溃。
export const moduleSettingsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', (c) => c.json({ data: {
    'quick-connect': { enabled: false, options: [] },
    'external-secrets': { enabled: false, forProjects: false, multipleConnections: false },
    mcp: { enabled: false, mcpAccessEnabled: false },
    'chat-hub': { providers: {} },
  } }));

export const settingsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', (c) => {
    // 依据真实请求判定协议/源，避免安全 cookie 检查在本地 http 下误拦
    const url = new URL(c.req.url);
    const fwdProto = c.req.header('x-forwarded-proto');
    const proto = fwdProto || url.protocol.replace(':', '');
    const secure = proto === 'https'; // 生产 https → true；本地 http → false
    const origin = `${proto}://${url.host}`;
    const cb = (p: string) => `${origin}/rest/${p}`;
    return c.json({ data: {
      // 端到端闭环最小值：让 editor-ui 能进入编辑器并加载
      instanceId: 'mini-flow-instance',
      logo: { iconType: 'file' },
      oauthCallbackUrls: { oauth2: [cb('oauth2-credential/callback')], oauth1: [cb('oauth1-credential/callback')] },
      versionCli: '1.0.0',
      timezone: 'UTC',
      executionMode: 'queue', // 异步执行
      backendBaseUrl: '/rest',
      ssoMetadata: undefined,
      license: { active: true, planName: 'mini-flow', quota: 0, usage: 0, userQuota: 1, entitlements: { functions: 'trigger' } },
      features: { executionTimeout: { dangling: 0, last: 0 }, advancedTools: [], variables: true, aiAssist: false, projects: false, projectRole: '' },
      defaultUserIsOwner: true,
      userManagement: { showSetupOnFirstLoad: false, isInstanceOwner: true, isUserManagementEnabled: true },
      authCookie: { secure, cookieName: 'n8n-auth' },
      security: { blockFileAccessToN8nFiles: false },
      enterprise: {
        projects: { enabled: true, projectsEnabled: false, personal: true, team: { limit: -1 } },
        sharing: { enabled: true },
        advancedPermissions: { enabled: false },
        variables: { enabled: true },
        ldap: { enabled: false },
        saml: { enabled: false },
        logStreaming: { enabled: false },
      },
      banner: undefined,
      usage: 0,
      telemetry: { enabled: false },
      endpoint: { publicApi: '/api/v1', metrics: '/metrics' },
      planName: 'mini-flow',
      allowedModules: {},
      authenticationMethod: 'email',
      defaultLocale: 'zh',
      locale: 'zh',
      instance: { host: origin, baseUrl: origin, previewMode: false },
      urlBaseWebhook: `${origin}/webhook`,
      urlBaseEditor: origin,
      endpointForm: `${origin}/form`,
      endpointWebhook: `${origin}/webhook`,
      endpointWebhookTest: `${origin}/webhook-test`,
      binaryDataMode: 'default',
      n8nMetadata: {},
      concurrency: { productionLimit: 1, queueMode: false },
      maxExecutionTimeout: 3600,
      templatesHost: 'https://api.n8n.io/api/',
      // 模板市场开关：前端的 isTemplatesEnabled 读 settings.templates.enabled，
      // 模板请求 base 读 settings.templates.host。host 指向同源，使前端请求 /templates/*
      // 命中本域名的模板代理（index.ts 中 /templates/* 转发到 api.n8n.io），避免跨域 CORS。
      templates: { enabled: true, host: origin },
      sso: {
        saml: { loginEnabled: false, loginLabel: 'Sign in with SAML' },
        ldap: { loginEnabled: false, loginLabel: '' },
        oidc: { loginEnabled: false, loginUrl: '', providerName: '' },
      },
      sentry: { dsn: undefined },
      // 本部署为自托管型：type 用 'default'（非 'cloud'），
      // 使 isCloudDeployment=false，跳过 cloud store 初始化，消除
      // "Error checking for cloud plan data / Error fetching user cloud account" 告警。
      deployment: { type: 'default', dedicated: false },
      auth: { defaultMethod: 'email', epoch: '2026-01-01', isLdapEnabled: false, oauth: { google: { configured: false }, github: { configured: false } }, sso: { saml: { configured: false }, ldap: { configured: false } } },
      queuedExecutionTimeout: undefined,
      socket: { enabled: false },
      templateData: undefined,
      // 版本检查：versions.store 直接读取 settings.versionNotifications 并赋给 ref
      versionNotifications: { enabled: false, endpoint: '', infoUrl: '', whatsNewEndpoint: '' },
      // 埋点：users.store.login 后 init hook 读取 settings.posthog.enabled
      posthog: { enabled: false, proxy: '', autocapture: false, disableSessionRecording: true, debug: false },
      // 底部横幅：banners.store 读取 dynamicBanners.enabled/endpoint 与 banners.dismissed
      dynamicBanners: { enabled: false, endpoint: '' },
      banners: { dismissed: [] },
    } });
  })
  .get('/sso', (c) => c.json({ data: { configured: false }, action: 'GET' }))
  .get('/license', (c) => c.json({ data: { active: true, planName: 'mini-flow' } }))
  // GET /rest/settings/security —— 「个人 > 安全」页数据源。
  // 字段名严格对齐 SecuritySettings.vue 的读取键（实测自前端 dist）。
  .get('/security', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: {
      personalSpacePublishing: true,
      personalSpaceSharing: true,
      publishedPersonalWorkflowsCount: 0,
      sharedPersonalWorkflowsCount: 0,
      sharedPersonalCredentialsCount: 0,
    } });
  })
  .post('/security', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    return c.json({ data: {
      personalSpacePublishing: body?.personalSpacePublishing !== false,
      personalSpaceSharing: body?.personalSpaceSharing !== false,
      publishedPersonalWorkflowsCount: 0,
      sharedPersonalWorkflowsCount: 0,
      sharedPersonalCredentialsCount: 0,
    } });
  })
  .get('/logo', (c) => c.json({ data: { logo: null } }));