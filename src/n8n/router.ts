// n8n REST 适配层 —— /rest/* 路由聚合
// 前端 editor-ui 通过 VUE_APP_URL_BASE_API 指向这里。
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { authRoutes, isAuthed } from './auth';
import { settingsRoutes, userRoutes, userListRoutes, moduleSettingsRoutes } from './settings';
import { rolesRoutes, variablesRoutes } from './auxiliary';
import { projectRoutes, createProject } from './projects';
import { credentialRoutes, credentialTypesHandler } from './credentials';
import { nodeTypeRoutes, nodeTypeDefs } from './node-types';
import { listPlugins } from '../plugins';
import { workflowRoutes } from './workflows';
import { executionRoutes } from './executions';
import { dlqRoutes } from './dead-letter';
import { templatesRoutes } from './templates';
import { insightsRoutes } from './insights';
import { tagRoutes } from './tags';
import { communityNodeRoutes, listCommunityPackagePlugins } from './community-nodes';
import {
  licenseRoutes, optionsRoutes, communityNodeTypeRoutes, testWebhookRoutes,
  dynamicNodeParameterRoutes, meRoutes, miscRoutes, workflowHistoryRoutes, featureDisabledGuard,
} from './rest-extensions';

const SETTINGS_KEY = 'user-settings';
async function readSettings(c: Context): Promise<Record<string, unknown>> {
  const env = c.env as Env;
  if (!env.CREDENTIALS) return {};
  const raw = await env.CREDENTIALS.get(SETTINGS_KEY, 'json').catch(() => null);
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

// strict: false —— 忽略路径尾部斜杠，确保前端访问 /rest/projects/ 与 /rest/projects
// 均命中同一 handler（Hono 默认 strict:true 会区分尾部斜杠，导致 POST /projects/ 404）
export const restApi = new Hono<{ Bindings: Env }>({ strict: false })

// --- 全局鉴权墙（P0-3）：除公开端点外，/rest/* 一律要求合法会话，否则 401。
// 公开白名单只含「登录页渲染 + 登录/登出」所必需的端点（与上游 n8n 的公开面一致）：
// 这些端点要么不含实例数据（settings 为静态配置），要么本身就是登录入口。
// 其余所有读写在未登录时一律拒绝。
const OPEN_PATHS = new Set<string>([
  '/login',          // POST 登录 / GET 登录态探测
  '/logout',         // POST 注销（幂等，无副作用泄露）
  '/owner/setup',    // 首次初始化（本实现单用户，直接返回 owner）
  '/meta',           // 实例元信息（无敏感数据）
  '/settings',       // 登录页需要读取 instance/auth/locale 等静态配置
  '/sso',            // 登录页 SSO 按钮
  '/module-settings',// 登录页 quick-connect / MFA 等模块开关
  '/forgot-password',
  '/resolve-signup-token',
]);
restApi.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next();
  // restApi 挂载在 /rest 下；c.req.url 是完整 URL(含 /rest)，而白名单按 n8n 契约(无前缀)。
  // Hono 子应用内 c.req.path 通常已相对 /rest，这里双保险：剥掉可选的 /rest 前缀再匹配。
  const full = new URL(c.req.url).pathname.replace(/\/+$/, '');
  const rel = full === '/rest' || full.startsWith('/rest/') ? (full.slice(5) || '/') : full;
  if (OPEN_PATHS.has(rel)) return next();
  if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
  await next();
});

// 降级守卫：把本移植版**不实现**的企业/AI/云/遥测端点统一返回「未启用」契约形状，
// 避免前端把 404 当异常。必须在鉴权墙之后、具体路由之前（见 rest-extensions.ts 说明）。
restApi.use('*', featureDisabledGuard);

// 用户偏好设置：n8n 前端 settings.store 直接 PATCH /rest/me/settings（无 /user 段）。
// 缺失时工作流保存报 "Problem saving workflow" 404，故在此根挂载。
restApi
  .get('/me/settings', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    return c.json({ data: await readSettings(c) });
  })
  .patch('/me/settings', async (c) => {
    if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const merged = { ...(await readSettings(c)), ...body };
    await (c.env.CREDENTIALS?.put(SETTINGS_KEY, JSON.stringify(merged))).catch(() => undefined);
    return c.json({ data: merged });
  });

// 会话列表 + 节点目录：独立子应用（Hono .route() 必须接收子应用而非函数）
const sessionsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', (c) => c.json({ data: [] }));
const nodesRoutes = new Hono<{ Bindings: Env }>()
  .get('/', (c) => c.json({ data: nodeTypeDefs() }));
// 依赖计数/详情：前端 DependencyPill 用于展示工作流被多少对象引用。
// 本精简版无第三方依赖，返回空映射即可（避免 404 引发 console 报错）。
const workflowDependencyRoutes = new Hono<{ Bindings: Env }>()
  .post('/counts', async (c) => {
    const body = await c.req.json<{ resourceIds?: string[] }>().catch(() => ({ resourceIds: [] as string[] }));
    const out: Record<string, Record<string, number>> = {};
    for (const id of body.resourceIds ?? []) out[id] = {};
    return c.json(out);
  })
  .post('/details', async (c) => {
    const body = await c.req.json<{ resourceIds?: string[] }>().catch(() => ({ resourceIds: [] as string[] }));
    const out: Record<string, { dependencies: unknown[]; inaccessibleCount: number }> = {};
    for (const id of body.resourceIds ?? []) out[id] = { dependencies: [], inaccessibleCount: 0 };
    return c.json(out);
  });

// 模板导入/编辑器会 POST /rest/webhooks/find 检索匹配的既有 webhook 以便复用。
// 本精简版无独立 webhook CRUD，返回空数组即可，避免 404。
restApi.post('/webhooks/find', async (c) => {
  if (!(await isAuthed(c))) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
  return c.json({ data: [] });
});

restApi
  .route('/settings', settingsRoutes)
  .route('/', authRoutes)      // login / owner/setup（挂根即可，路径内再判）
  .route('/module-settings', moduleSettingsRoutes)
  .route('/user', userRoutes)   // n8n 用单数：/rest/user/me
  .route('/users', userListRoutes) // 复数：/rest/users（用户列表，侧边栏）
  .route('/sessions', sessionsRoutes)
  .route('/nodes', nodesRoutes)
  .route('/node-types', nodeTypeRoutes)
  // 插件目录：/rest/plugins —— 内置插件 + 社区节点包（REQ-32）合并展示
  .get('/plugins', async (c) => {
    const builtin = listPlugins();
    const community = await listCommunityPackagePlugins(c.env).catch(() => []);
    return c.json({ data: [...builtin, ...community] });
  })
  .route('/workflow-dependencies', workflowDependencyRoutes)
  .route('/projects', projectRoutes)
  // 创建项目：前端 POST /rest/projects 或 /rest/projects/ 均需命中。
  // Hono 的 .route(prefix, subapp) 挂载对空路径 POST 不归一化尾部斜杠，
  // 故在根 restApi 显式注册两种形态，统一走 createProject。
  .post('/projects', (c) => createProject(c))
  .post('/projects/', (c) => createProject(c))
  .route('/workflows', workflowRoutes)
  .route('/executions', executionRoutes)
  .route('/dead-letter', dlqRoutes)
  .route('/templates', templatesRoutes)
  .route('/roles', rolesRoutes)
  .route('/variables', variablesRoutes)
  // 凭据：/credentials CRUD + /credential-types。原 /credentials 只有空的 for-workflow/types，
  // 现由凭据子系统统一承载，避免编辑器凭据面板空/灰。
  .route('/credentials', credentialRoutes)
  // 凭据类型：editor 初始化 fetchCredentialTypes GET /rest/credential-types（单数，独立路由）
  .get('/credential-types', credentialTypesHandler)
  // home project：editor projects.store 启动时读取，提供个人项目
  .get('/home/project', async (c) => {
    try {
      const p = await c.env.DB.prepare("SELECT id,name,type,created_at FROM projects WHERE id='personal'").first<{ id: string }>();
      return c.json({ data: p ? { id: p.id, name: 'Personal', icon: null } : null });
    } catch { return c.json({ data: null }); }
  })
  // meta：实例元信息
  .get('/meta', (c) => c.json({ data: { instanceId: 'mini-flow-instance', instanceMeta: {} } }))
  // sso：n8n 契约 GET /rest/sso（登录页据此渲染 SSO 入口，属公开端点）
  .get('/sso', (c) => c.json({ data: { configured: false }, action: 'GET' }))
  // insights：实例洞察聚合（REQ-26，墙内）
  .route('/insights', insightsRoutes)
  // tags：工作流标签 CRUD（REQ-27，墙内；替换原空占位）
  .route('/tags', tagRoutes)
  // 社区节点：安装/卸载/目录（REQ-32，墙内；替换原空占位）
  .route('/community-nodes', communityNodeRoutes)
  // 社区节点**类型**目录：/rest/community-node-types（前端 users.store 据此派生
  // 「可安装但未安装」的建议列表；返回空集合 → 节点搜索无幽灵条目，REQ-37）
  .route('/community-node-types', communityNodeTypeRoutes)
  // 社区版许可证：/rest/license（前端每个页面 + 编辑器启动都会请求）
  .route('/license', licenseRoutes)
  // 实例选项：/rest/options/timezones（实例时区下拉）
  .route('/options', optionsRoutes)
  // 测试 webhook 登记/注销：/rest/test-webhook/:id
  .route('/test-webhook', testWebhookRoutes)
  // 动态节点参数（loadOptions / resourceLocator）：返回空结果而非 404
  .route('/dynamic-node-parameters', dynamicNodeParameterRoutes)
  // 当前用户自助：/rest/me、/rest/me/survey、/rest/me/password
  .route('/me', meRoutes)
  // 工作流版本历史：把当前工作流呈现为唯一版本（打开编辑器即请求）
  .route('/workflow-history', workflowHistoryRoutes)
  // 其余零散端点：动态模板 / 遥测会话 / 同意 / NPS / 横幅 / 口令找回 / OAuth 回调 / 数据表限额
  .route('/', miscRoutes)
  // 节点翻译头：defaultLocale 非 en 时路由守卫调用 getNodeTranslationHeaders
  // （GET /rest/node-translation-headers）。本精简版无节点翻译，返回空映射即可，
  // 缺失时前端 localizeNodeName 回退英文节点名。
  .get('/node-translation-headers', (c) => c.json({ data: {} }))
  // 凭据翻译：defaultLocale 非 en 时凭据面板按类型请求翻译。返回 null 表示无翻译。
  .get('/credential-translation', (c) => c.json({ data: null }))
  // 动态端点：角色/项目等信息由上面提供
  // 仪表盘展示激活状态：GET /rest/active-workflows
  .get('/active-workflows', async (c) => {
    try {
      const res = await c.env.DB.prepare('SELECT id, name, active FROM workflows WHERE active=1')
        .all<{ id: string; name: string; active: number }>();
      return c.json({ data: (res.results ?? []).map((r) => ({ id: r.id, name: r.name, active: !!r.active })) });
    } catch {
      return c.json({ data: [] });
    }
  })
  // 激活失败详情：GET /rest/active-workflows/error/:id —— 前端在激活报错时读取具体原因。
  .get('/active-workflows/error/:id', async (c) => {
    try {
      const row = await c.env.DB.prepare(
        "SELECT id, name, active FROM workflows WHERE id=?",
      ).bind(c.req.param('id')).first<{ id: string; name: string; active: number }>();
      if (!row) return c.json({ code: 404, message: 'Workflow not found', data: undefined }, 404);
      return c.json({ data: { workflowId: row.id, name: row.name, active: !!row.active, error: null } });
    } catch {
      return c.json({ data: { workflowId: c.req.param('id'), active: false, error: null } });
    }
  })
  // 兜底：未匹配的 /rest/* 路径统一返回 404 JSON。
  // 历史缺陷：未注册的 /rest/* 会穿透到 index.ts 的 SPA fallback，返回 200 + HTML，
  // 前端把 HTML 当 JSON 解析而报错，同时掩盖「端点不存在」这一事实。
  // 必须注册在所有具体路由之后，否则会抢占它们。
  .all('*', (c) => c.json({
    code: 404,
    message: `Not found: ${c.req.method} ${new URL(c.req.url).pathname}`,
    data: undefined,
  }, 404));

// n8n 返回统一包裹 { data, ... }，错误用 HTTP 状态 + { code, message }
export function wrap(data: unknown) {
  return { data };
}

export function error(status: number, message: string, code = status) {
  return { status, json: { code, message } };
}