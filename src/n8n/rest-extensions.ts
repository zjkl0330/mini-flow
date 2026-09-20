// rest-extensions: 补齐 editor-ui 需要、但此前未注册的 /rest/* 端点。
//
// 分两类，**代码中显式区分**，避免把「降级」伪装成「已实现」：
//   A. realRoutes  —— 本移植版确实具备该能力，返回真实数据（许可证、时区、社区节点类型、
//                    当前用户、参数下拉占位、webhook 测试注销等）。
//   B. disabledFeatureMiddleware —— 本移植版**不实现**的企业/AI/云/遥测能力（SSO、LDAP、
//                    MFA、外部密钥、凭据解析器、外部密钥托管、Chat/Instance-AI、MCP、
//                    Event Bus、API Key、邀请、Base/Data Tables）。
//                    这些端点返回「未启用」的契约形状，使前端展示为「功能不可用」，
//                    而不是把 404 当作异常抛错。**它们不是实现，是显式降级。**
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { isAuthed, owner } from './auth';

// 社区版许可证：与前端 usage.store 的 UsageState['data'] 结构严格一致
// （前端直接 setData(data) 并读取 data.license.planName / data.usage.*）。
// limit: -1 表示不限量（社区版语义）。
export const communityLicense = (activeWorkflowTriggers: number) => ({
  usage: {
    activeWorkflowTriggers: { limit: -1, value: activeWorkflowTriggers, warningThreshold: 0.8 },
    workflowsHavingEvaluations: { value: 0, limit: 0 },
  },
  license: { planId: 'community', planName: 'Community' },
});

export const licenseRoutes = new Hono<{ Bindings: Env }>()
  // 前端每个页面（含编辑器）启动都会调用；此前 404 是唯一的「全站性」缺口。
  .get('/', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    let active = 0;
    try {
      const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM workflows WHERE active=1')
        .first<{ n: number }>();
      active = Number(row?.n ?? 0) || 0;
    } catch { /* 空库 / 未迁移时按 0 呈现，不让许可证端点变成 500 */ }
    return c.json({ data: communityLicense(active) });
  })
  // 社区版无法激活/续订商业许可：显式 400 + 说明，而不是假装成功。
  .post('/activate', (c) => c.json({
    code: 400,
    message: 'This deployment runs the community edition and cannot activate a license key.',
    data: undefined,
  }, 400))
  .post('/renew', (c) => c.json({
    code: 400,
    message: 'This deployment runs the community edition; there is no license to renew.',
    data: undefined,
  }, 400))
  .post('/enterprise/request_trial', (c) => c.json({
    code: 400,
    message: 'Enterprise trial is not available in this deployment.',
    data: undefined,
  }, 400))
  .post('/enterprise/community-registered', (c) => c.json({
    code: 400,
    message: 'Enterprise registration is not available in this deployment.',
    data: undefined,
  }, 400));

// IANA 时区列表（子集足够覆盖常见选择；含 UTC 与前端默认 locale 相关项）。
// 前端 GET /rest/options/timezones 用于「实例时区」下拉。
const TIMEZONES = [
  'UTC', 'Africa/Cairo', 'Africa/Johannesburg', 'America/Anchorage', 'America/Argentina/Buenos_Aires',
  'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Mexico_City',
  'America/New_York', 'America/Sao_Paulo', 'America/Toronto', 'Asia/Bangkok', 'Asia/Dubai',
  'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Kuala_Lumpur',
  'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Tokyo',
  'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/London',
  'Europe/Madrid', 'Europe/Moscow', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm',
  'Europe/Warsaw', 'Europe/Zurich', 'Pacific/Auckland', 'Pacific/Honolulu',
];

export const optionsRoutes = new Hono<{ Bindings: Env }>()
  .get('/timezones', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: TIMEZONES });
  });

// 社区节点类型：前端 users.store 用它派生「可安装但未安装」的建议列表。
// 本移植版不托管 n8n 社区 registry，故显式返回空集合 —— 这样节点搜索不会出现
// 「可搜到可添加但不在类型表」的幽灵条目（REQ-37）。
export const communityNodeTypeRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: [] });
  })
  .get('/:name', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: null });
  });

// 测试 webhook：编辑器在「监听测试事件」时会向 /rest/test-webhook/:id 登记/注销。
// 本移植版 webhook 走 /webhook-test/* 直接触发，无需登记表；返回成功即可。
export const testWebhookRoutes = new Hono<{ Bindings: Env }>()
  .post('/:id', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { success: true } });
  })
  .delete('/:id', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { success: true } });
  });

// 动态节点参数（loadOptions / resourceLocator）：
// 本移植版节点均为静态参数，不实现远端取数。返回**空结果**而非 404 ——
// 否则任何带 loadOptions 的节点在 NDV 里都会弹「无法加载选项」错误。
export const dynamicNodeParameterRoutes = new Hono<{ Bindings: Env }>()
  .post('/options', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: [] });
  })
  .post('/resource-locator-results', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { results: [], paginationToken: undefined } });
  })
  .post('/resource-mapper-fields', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: [] });
  })
  .post('/local-resource-mapper-fields', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: [] });
  })
  .post('/action-result', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { success: true } });
  });

// 当前用户自助端点：n8n 的 /rest/me、/rest/me/survey、/rest/me/password
// （单用户实例 = owner；口令由 Worker Secret 托管，故改密显式拒绝）。
export const meRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: owner() });
  })
  .post('/survey', async (c) => c.json({ data: { success: true } }))
  .patch('/', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<{ firstName?: string; lastName?: string }>()
      .catch(() => ({} as { firstName?: string; lastName?: string }));
    const me = owner();
    return c.json({ data: {
      ...me,
      firstName: typeof body?.firstName === 'string' && body.firstName.trim() ? body.firstName.trim() : me.firstName,
      lastName: typeof body?.lastName === 'string' ? body.lastName : me.lastName,
    } });
  })
  // 改密：本实例口令来自 Worker Secret（env.ADMIN_PASSWORD），运行时不可写。
  // 明确告知用户去改 Secret，而不是返回一个静默成功却什么都没变。
  .patch('/password', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'Password is managed by the ADMIN_PASSWORD Worker secret. Update it with `wrangler secret put ADMIN_PASSWORD`.',
      data: undefined,
    }, 400);
  });

// 其余零散端点：均为「前端会调用但本移植版无需持久化」的观测/遥测/占位类，
// 统一返回契约形状的空值，保证界面不因 404 报错。
export const miscRoutes = new Hono<{ Bindings: Env }>()
  .get('/dynamic-templates', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: [] });
  })
  .get('/events/session-started', async (c) => c.json({ data: { logged: false } }))
  .get('/consent/details', async (c) => c.json({ data: { consent: false } }))
  .post('/consent/approve', async (c) => c.json({ data: { consent: true } }))
  .patch('/user-settings/nps-survey', async (c) => c.json({ data: { success: true } }))
  .post('/owner/dismiss-banner', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { success: true } });
  })
  // 忘记密码 / 令牌解析：单用户实例无自助找回，返回明确的「不支持」。
  .post('/forgot-password', (c) => c.json({
    code: 400,
    message: 'Password recovery is not available on this single-user instance. Set the ADMIN_PASSWORD Worker secret instead.',
    data: undefined,
  }, 400))
  .get('/resolve-signup-token', (c) => c.json({ data: { inviteAcceptUrl: '' } }))
  .get('/resolve-password-token', (c) => c.json({ data: { resetPasswordUrl: '' } }))
  .post('/change-password', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({
      code: 400,
      message: 'Password is managed by the ADMIN_PASSWORD Worker secret.',
      data: undefined,
    }, 400);
  })
  // OAuth 回调入口（GET）：本移植版凭据不含 OAuth 流程，跳回凭据页并标记错误。
  .get('/oauth2-credential/auth', async (c) => c.redirect('/home/credentials?oauth=unsupported'))
  .get('/oauth1-credential/auth', async (c) => c.redirect('/home/credentials?oauth=unsupported'))
  // 全局数据表限额（企业版 Base）：未启用 → 0。
  .get('/data-tables-global/limits', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { maxDataTables: 0, maxRowsPerTable: 0 } });
  })
  .post('/data-tables/uploads', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: { success: false } });
  });

// 工作流版本历史：编辑器打开工作流时会请求
//   GET  /rest/workflow-history/workflow/:workflowId
//   GET  /rest/workflow-history/workflow/:workflowId/version/:versionId
//   POST /rest/workflow-history/workflow/:workflowId/versions
//   PATCH/DELETE .../versions/:versionId
// 本移植版不做版本快照存储，把**当前工作流**呈现为唯一可用版本，
// 使历史面板能正常打开并显示一条记录，而不是报错。
// 注意：这不是「版本历史实现」——只有一条记录，且 PATCH/DELETE 为幂等空操作。
const HISTORY_NAME = 'Current version';

async function loadWorkflow(env: Env, id: string) {
  try {
    const row = await env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<Record<string, unknown>>();
    return row ?? null;
  } catch { return null; }
}

function versionSummary(row: Record<string, unknown>) {
  return {
    versionId: String(row.id),
    workflowId: String(row.id),
    name: HISTORY_NAME,
    description: null as string | null,
    createdAt: String(row.updated_at ?? row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? row.created_at ?? ''),
    autosaved: false,
  };
}

export const workflowHistoryRoutes = new Hono<{ Bindings: Env }>()
  .get('/workflow/:workflowId', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const row = await loadWorkflow(c.env, c.req.param('workflowId'));
    if (!row) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
    return c.json({ data: [versionSummary(row)] });
  })
  .get('/workflow/:workflowId/version/:versionId', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const row = await loadWorkflow(c.env, c.req.param('workflowId'));
    if (!row) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
    const nodes = safeParse(row.nodes, []);
    const connections = safeParse(row.connections, {});
    return c.json({ data: { ...versionSummary(row), nodes, connections } });
  })
  .post('/workflow/:workflowId/versions', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const row = await loadWorkflow(c.env, c.req.param('workflowId'));
    if (!row) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
    return c.json({ data: [versionSummary(row)] });
  })
  .patch('/workflow/:workflowId/versions/:versionId', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const row = await loadWorkflow(c.env, c.req.param('workflowId'));
    if (!row) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
    return c.json({ data: versionSummary(row) });
  })
  .delete('/workflow/:workflowId/versions/:versionId', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    // 唯一版本不允许删除；幂等返回成功，避免面板报错。
    return c.json({ data: { success: true } });
  });

function safeParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// B. 显式降级层：本移植版不实现的企业/AI/云/遥测前缀。
// 命中前缀 → 返回「未启用」的契约形状（GET 列表型给 []，配置型给 {}，写操作给 {}）。
// 这样前端把这些能力展示为「不可用」，而不是把 404 当异常。
// ---------------------------------------------------------------------------
const DISABLED_PREFIXES: Array<{ prefix: string; list?: boolean }> = [
  { prefix: '/sso' },
  { prefix: '/ldap' },
  { prefix: '/mfa' },
  { prefix: '/secret-providers', list: true },
  { prefix: '/external-secrets', list: true },
  { prefix: '/credential-resolvers', list: true },
  { prefix: '/mcp', list: true },
  { prefix: '/eventbus', list: true },
  { prefix: '/api-keys', list: true },
  { prefix: '/invitations', list: true },
  { prefix: '/chat', list: true },
  { prefix: '/instance-ai', list: true },
  { prefix: '/ai', list: true },
];

// 项目下的企业子资源（Base/Data Tables、文件夹、项目成员）：单用户精简版不实现。
// 仅拦这条**子资源**路径，不影响已实现的 /projects 本体 CRUD。
const PROJECT_SUBRESOURCE_PREFIXES = ['/data-tables', '/folders', '/users'];

function disabledPayload(method: string, list: boolean) {
  if (method === 'GET' && list) return [] as unknown;
  return {} as unknown;
}

/**
 * 降级守卫：命中 DISABLED_PREFIXES（或项目的企业子资源）的请求直接返回「未启用」形状。
 * 必须在鉴权墙之后、具体路由**之前**调用，否则会抢走已实现路由。
 *
 * 例外：`/sso` 的**精确路径**已由路由实现（登录页需要 `{configured:false, action:'GET'}`），
 * 故只拦 `/sso/...` 之下的子路径（oidc/saml/provisioning 配置），不拦 `/sso` 本身。
 */
const GUARD_EXEMPT_EXACT = new Set<string>(['/sso']);

export async function featureDisabledGuard(c: Context<{ Bindings: Env }>, next: () => Promise<void>) {
  if (c.req.method === 'OPTIONS') return next();
  const full = new URL(c.req.url).pathname.replace(/\/+$/, '');
  const rel = full === '/rest' || full.startsWith('/rest/') ? (full.slice(5) || '/') : full;
  if (GUARD_EXEMPT_EXACT.has(rel)) return next();

  for (const { prefix, list } of DISABLED_PREFIXES) {
    if (rel === prefix || rel.startsWith(`${prefix}/`)) {
      return c.json({ data: disabledPayload(c.req.method, list === true) });
    }
  }

  // /projects/:id/<企业子资源>…
  const projMatch = /^\/projects\/[^/]+\/([^/]+)/.exec(rel);
  if (projMatch && PROJECT_SUBRESOURCE_PREFIXES.includes(`/${projMatch[1]}`)) {
    return c.json({ data: disabledPayload(c.req.method, true) });
  }

  return next();
}
