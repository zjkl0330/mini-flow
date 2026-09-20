// workflows: n8n REST CRUD（D1 持久化 n8n 原生 workflow JSON）
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, N8nWorkflow } from '../types';
import { withRetry } from '../engine/retry';
import { parseWorkflowRow, type ExecutionRow, type WorkflowRow } from '../db/schema';
import { startExecution } from '../engine/executor';
import { sendPush } from './push';
import { OWNER_SCOPES } from './auth';
import { PERSONAL_PROJECT_ID } from './projects';

/**
 * 统一 projectId 语义（REQ-38 收口）。
 *
 * 问题：`workflows.project_id` 历史上以 NULL 表示「个人项目」，而 `/rest/projects`
 * 暴露的个人项目 id 是字符串 `'personal'`。前端按 projectId 过滤项目工作流时，
 * `null !== 'personal'` 会导致个人项目下看不到工作流（实机核验：`GET /rest/workflows`
 * 返回 `projectId: null`，与 `/rest/projects` 的 `'personal'` 不一致）。
 *
 * 收口：所有 REST 出参与写入统一归一化为 `'personal'`；查询时再兼容历史 NULL 行。
 */
export const normalizeProjectId = (v: unknown): string =>
  (typeof v === 'string' && v.trim() !== '' ? v : PERSONAL_PROJECT_ID);

// 安全整数解析：非法输入回落默认值，越界钳制到边界（避免 NaN 进入 SQL LIMIT）
function safeInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// LIKE 通配符转义：使用户输入里的 % _ \ 按字面量匹配（配合 ESCAPE '\'）
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export const workflowRoutes = new Hono<{ Bindings: Env }>()
  // GET /rest/workflows —— 列表。支持 n8n 前端的 filter / limit / cursor / projectId，
  // 非法参数不报错（回落到默认值），避免列表页整页失败。
  .get('/', async (c) => {
    const q = c.req.query();
    const limit = safeInt(q.limit, 100, 1, 250);
    const projectId = q.projectId;
    // n8n 前端的 filter 为 JSON 字符串：{ name, active, isArchived, projectId, tags }
    let filter: { name?: string; active?: boolean; isArchived?: boolean; projectId?: string } = {};
    if (q.filter) {
      try {
        const parsed = JSON.parse(q.filter);
        if (parsed && typeof parsed === 'object') filter = parsed as typeof filter;
      } catch { /* 忽略非法 filter */ }
    }

    const where: string[] = [];
    const binds: (string | number)[] = [];
    const proj = filter.projectId ?? projectId;
    if (proj) {
      // 'personal' 等价于「project_id = 'personal' 或历史 NULL」——避免个人项目下漏掉旧工作流
      if (proj === PERSONAL_PROJECT_ID) {
        where.push('(project_id IS NULL OR project_id=?)');
        binds.push(PERSONAL_PROJECT_ID);
      } else {
        where.push('project_id=?');
        binds.push(proj);
      }
    }
    if (typeof filter.name === 'string' && filter.name.trim() !== '') {
      where.push("name LIKE ? ESCAPE '\\'");
      binds.push(`%${escapeLike(filter.name.trim())}%`);
    }
    if (typeof filter.active === 'boolean') { where.push('active=?'); binds.push(filter.active ? 1 : 0); }
    if (typeof filter.isArchived === 'boolean') { where.push('COALESCE(archived,0)=?'); binds.push(filter.isArchived ? 1 : 0); }
    // keyset 分页：cursor 为上一页最后一个 workflow 的 id，取其 updated_at 作为水位
    if (q.cursor) {
      const cur = await c.env.DB.prepare('SELECT updated_at FROM workflows WHERE id=?').bind(q.cursor).first<{ updated_at: string }>();
      if (cur?.updated_at) { where.push('updated_at < ?'); binds.push(cur.updated_at); }
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const res = await withRetry(() => c.env.DB.prepare(
      `SELECT id, name, active, archived, project_id, updated_at, created_at FROM workflows${whereSql} ORDER BY updated_at DESC LIMIT ?`,
    ).bind(...binds, limit).all<WorkflowRow>());

    const rows = (res.results ?? []).map((r) => ({
      id: r.id, name: r.name, active: !!r.active, isArchived: !!((r as any).archived),
      projectId: normalizeProjectId((r as any).project_id), createdAt: r.created_at, updatedAt: r.updated_at, tags: [],
    }));
    // n8n 工作流列表消费 response.data（数组）；同时透出 count 便于前端显示总数
    return c.json({ data: rows, count: rows.length });
  })
  .get('/new', async (c) => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    return c.json({ data: { id, name: 'Untitled workflow', nodes: [], connections: {}, active: false, settings: {}, projectId: PERSONAL_PROJECT_ID, versionId: id, checksum: await computeChecksum({ id, name: 'Untitled workflow' }), isArchived: false, createdAt: now, updatedAt: now } });
  })
  // 前端在创建新工作流时 POST /workflows/new 取得默认工作流与 id（Vue route 预取）。
  // 与 GET 等价；enabled:true 标记该 id 可编辑，前端据此进入画布。
  .post('/new', (c) => newWorkflowHandler(c))
  .post('/', async (c) => {
    const body = await c.req.json<N8nWorkflow>();
    // 优先采用前端回传的 id（新建工作流 URL 用该 short-id，刷新时用同一 id 取回）；
    // 无 id 才生成 UUID，保证客户端/服务端 id 一致。
    const id = body.id ?? crypto.randomUUID();
    const projectId = normalizeProjectId((body as any).projectId);
    // 用 upsert（ON CONFLICT DO UPDATE）：模板导入/自动保存时 n8n 会用同一 id 再次 POST，
    // 若走纯 INSERT 会因 UNIQUE 约束返回 500。改为幂等写入，重复 POST 即更新，不再报错。
    await withRetry(() => c.env.DB.prepare(
      "INSERT INTO workflows (id, name, nodes, connections, settings, project_id) VALUES (?,?,?,?,?,?) "
      + "ON CONFLICT(id) DO UPDATE SET "
      + "name=excluded.name, nodes=excluded.nodes, connections=excluded.connections, "
      + "settings=excluded.settings, project_id=excluded.project_id, updated_at=datetime('now')",
    ).bind(id, body.name, JSON.stringify(body.nodes ?? []), JSON.stringify(body.connections ?? {}), body.settings ? JSON.stringify(body.settings) : null, projectId).run());
    return c.json({ data: { id, name: body.name, nodes: body.nodes ?? [], connections: body.connections ?? {}, settings: body.settings, projectId, active: false, versionId: id, checksum: await computeChecksum({ id, name: body.name, nodes: body.nodes ?? [], connections: body.connections ?? {}, settings: body.settings }), isArchived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }, 201);
  })
  // POST /rest/workflows/import —— 导入工作流（REQ-29）。
  // body 兼容三种形态：裸 workflow / { workflow } / { data }。
  // 若 id 缺失或已存在 → 重新分配 crypto.randomUUID()（避免误覆盖既有工作流）。
  .post('/import', async (c) => {
    const raw = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!raw || typeof raw !== 'object') return c.json({ code: 400, message: 'Invalid workflow payload', data: undefined }, 400);
    const inner = (raw.workflow ?? raw.data ?? raw) as Record<string, unknown>;
    if (!inner || typeof inner !== 'object') return c.json({ code: 400, message: 'Invalid workflow payload', data: undefined }, 400);

    let id = typeof inner.id === 'string' && inner.id ? (inner.id as string) : '';
    if (id) {
      const exists = await withRetry(() => c.env.DB.prepare('SELECT id FROM workflows WHERE id=?').bind(id).first<{ id: string }>());
      if (exists) id = '';
    }
    if (!id) id = crypto.randomUUID();

    const name = typeof inner.name === 'string' && inner.name ? (inner.name as string) : 'Imported workflow';
    const nodes = Array.isArray(inner.nodes) ? inner.nodes : [];
    const connections = inner.connections && typeof inner.connections === 'object' ? inner.connections : {};
    const settings = inner.settings && typeof inner.settings === 'object' ? inner.settings : {};
    const projectId = normalizeProjectId(inner.projectId);

    await withRetry(() => c.env.DB.prepare(
      "INSERT INTO workflows (id, name, nodes, connections, settings, project_id) VALUES (?,?,?,?,?,?) "
      + "ON CONFLICT(id) DO UPDATE SET name=excluded.name, nodes=excluded.nodes, connections=excluded.connections, settings=excluded.settings, project_id=excluded.project_id, updated_at=datetime('now')",
    ).bind(id, name, JSON.stringify(nodes), JSON.stringify(connections), JSON.stringify(settings), projectId).run());

    const merged: any = { id, name, nodes, connections, settings, active: false, projectId };
    return c.json({ data: await toResponse(merged) }, 201);
  })
  .get('/:id/exists', async (c) => {
    const id = c.req.param('id');
    const row = await withRetry(() => c.env.DB.prepare('SELECT id FROM workflows WHERE id=?').bind(id).first<WorkflowRow>());
    return c.json({ data: !!row });
  })
  // GET /rest/workflows/:id/export —— 导出 n8n 原生工作流 JSON（REQ-29）。
  // 需在 /:id 之前注册；返回附件下载（Content-Disposition）。
  .get('/:id/export', async (c) => withWorkflow(c.env, c.req.param('id'), async (wf) => {
    const obj = {
      id: wf.id,
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings ?? {},
      active: !!wf.active,
      versionId: wf.id,
    };
    const safeName = String(wf.name || 'workflow').replace(/[^\w.\-]+/g, '_') || 'workflow';
    return new Response(JSON.stringify(obj, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${safeName}.json"`,
      },
    });
  }, () => missingWorkflow(c.req.param('id'))))
  // 协作写锁查询：collaboration.store 打开工作流时调用 z()=GET /workflows/:id/collaboration/write-lock，
  // 返回值被赋值给"当前写者"E；若返回非空且无 clientId 的对象（此前未实现该路由→SPA 兜底返回 HTML），
  // 则 shouldBeReadOnly=(E≠null)&&!(E.clientId===pushRef)=true，导致整块画布只读、所有编辑操作置灰。
  // 无人持有写锁时应返回 null（→ E 保持 null → 可编辑）。
  .get('/:id/collaboration/write-lock', async (c) => c.json({ data: null }))
  // ---- 补齐：编辑器/列表页需要、此前缺失的工作流子资源端点 ----
  // GET /rest/workflows/from-url?url=... —— 从 URL 导入工作流 JSON。
  // 必须注册在 /:id 之前：否则会被 /:id 捕获成 "Workflow not found from-url"（实机复现过）。
  .get('/from-url', async (c) => {
    const parsed = await fetchWorkflowFromUrl(c.req.query('url') ?? '');
    if (!parsed.ok) return c.json({ code: 400, message: parsed.message, data: undefined }, 400);
    const wf = parsed.workflow as Record<string, unknown> | null;
    if (!wf || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object' || wf.connections === null) {
      return c.json({ code: 400, message: 'The URL did not return a valid n8n workflow JSON (missing nodes/connections).', data: undefined }, 400);
    }
    return c.json({ data: { ...wf, projectId: normalizeProjectId(wf.projectId) } });
  })
  // GET /rest/workflows/:id/executions/last-successful —— 工作流卡片/编辑器展示「上次成功执行」。
  .get('/:id/executions/last-successful', async (c) => {
    const id = c.req.param('id');
    try {
      const row = await c.env.DB.prepare(
        "SELECT id, workflow_id, status, mode, started_at, finished_at FROM executions "
        + "WHERE workflow_id=? AND status='completed' ORDER BY started_at DESC LIMIT 1",
      ).bind(id).first<ExecutionRow>();
      return c.json({ data: row ? toExecutionSummary(row) : null });
    } catch { return c.json({ data: null }); }
  })
  // GET /rest/workflows/:id/execution-status —— 编辑器据此决定是否显示「运行中」指示。
  .get('/:id/execution-status', async (c) => {
    const id = c.req.param('id');
    const idle = { running: false, executionId: null, mode: null, status: null };
    try {
      const row = await c.env.DB.prepare(
        "SELECT id, mode, status FROM executions WHERE workflow_id=? AND status IN ('running','pending') "
        + 'ORDER BY started_at DESC LIMIT 1',
      ).bind(id).first<ExecutionRow>();
      return c.json({ data: row ? { running: true, executionId: row.id, mode: row.mode, status: row.status } : idle });
    } catch { return c.json({ data: idle }); }
  })
  // PUT /rest/workflows/:id/share —— 单用户实例没有可分享的接收方；幂等返回当前共享状态，
  // 使「分享」弹窗能正常关闭而不是弹 404。
  .put('/:id/share', async (c) => withWorkflow(
    c.env, c.req.param('id'),
    async (wf) => c.json({ data: { ...(await toResponse(wf)), sharedWithProjects: [] } }),
    () => missingWorkflow(c.req.param('id')),
  ))
  // PUT /rest/workflows/:id/transfer —— 转移所有权：单用户实例只有一个 owner，显式拒绝。
  .put('/:id/transfer', (c) => c.json({
    code: 400,
    message: 'Workflow ownership cannot be transferred on a single-user instance.',
    data: undefined,
  }, 400))
  .get('/:id', async (c) => withWorkflow(c.env, c.req.param('id'), async (wf) => c.json({ data: await toResponse(wf) }), () => missingWorkflow(c.req.param('id'))))
  // PUT /:id：n8n 编辑器保存更新工作流常发 PUT（部分 Flow 走 PATCH）。语义与 PATCH 一致，做全量更新。
  .put('/:id', async (c) => updateWorkflowHandler(c, c.req.param('id')))
  .patch('/:id', async (c) => updateWorkflowHandler(c, c.req.param('id')))
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    // 先删依赖子表（node_executions 有 FK 指向 executions；executions/dead_letter 指向 workflows），
    // 否则 DELETE workflows 触发外键约束报 500。
    await withRetry(() => c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM node_executions WHERE execution_id IN (SELECT id FROM executions WHERE workflow_id=?)').bind(id),
      c.env.DB.prepare('DELETE FROM dead_letter_queue WHERE workflow_id=?').bind(id),
      c.env.DB.prepare('DELETE FROM executions WHERE workflow_id=?').bind(id),
      c.env.DB.prepare('DELETE FROM workflows WHERE id=?').bind(id),
    ]));
    return c.json({ data: { success: true } });
  })
  // 查询包含指定节点类型的工作流：POST /rest/workflows/with-node-types
  // 前端 getWorkflowsWithNodesIncluded 用 nodeTypes 过滤返回 WorkflowResource[]。
  // 必须注册在 /:id 之前，否则 with-node-types 会被当成 id 捕获。
  .post('/with-node-types', async (c) => {
    const body = await c.req.json<{ nodeTypes?: string[] }>().catch(() => ({ nodeTypes: [] }));
    const want = new Set<string>(body?.nodeTypes ?? []);
    const res = await withRetry(() => c.env.DB.prepare('SELECT id, name, nodes FROM workflows').all<WorkflowRow>());
    const matched = (res.results ?? []).filter((r) => {
      if (want.size === 0) return false;
      let nodes: unknown[] = [];
      try { nodes = JSON.parse(r.nodes ?? '[]'); } catch { /* ignore */ }
      return nodes.some((n: any) => n && typeof n.type === 'string' && want.has(n.type));
    }).map((r) => ({ id: r.id, name: r.name, nodes: safeParse(r.nodes) }));
    return c.json({ data: matched });
  })
  // 手动执行：POST /rest/workflows/:id/run
  .post('/:id/run', async (c) => withWorkflow(c.env, c.req.param('id'), async (wf) => {
    const body = await c.req.json<{ data?: unknown }>().catch(() => ({ data: undefined }));
    const outcome = await startExecution(c.env, wf, body?.data ?? body, 'manual', (e) => sendPush(c.env, e));
    if (!outcome.ok) return c.json({ data: undefined, code: 409, message: outcome.error }, 409);
    return c.json({ data: { executionId: outcome.executionId } });
  }, () => missingWorkflow(c.req.param('id'))))
  // 激活/停用（骨架：置 active 位）
  .post('/:id/activate', async (c) => setActive(c.env, c.req.param('id'), 1, c))
  .post('/:id/deactivate', async (c) => setActive(c.env, c.req.param('id'), 0, c))
  // 归档/取消归档（前端 archiveWorkflowInList / unarchiveWorkflowInList 会校验响应 checksum）
  .post('/:id/archive', async (c) => setArchived(c.env, c.req.param('id'), 1, c))
  .post('/:id/unarchive', async (c) => setArchived(c.env, c.req.param('id'), 0, c));

// setActive / setArchived：改动状态位后返回完整工作流（含 checksum/versionId），
// 前端 deactivate/archive 依赖响应 checksum 才会把界面置为成功。
async function workflowAfterState(env: Env, id: string): Promise<[any, WorkflowRow | null]> {
  const row = await withRetry(() => env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<WorkflowRow>());
  if (!row) return [null, null];
  const wf: any = { ...parseWorkflowRow(row), projectId: normalizeProjectId((row as any).project_id), isArchived: !!(row as any).archived };
  return [wf, row];
}

async function setActive(env: Env, id: string, active: number, c: { json: any }) {
  const [wf, row] = await workflowAfterState(env, id);
  if (!row) return missingWorkflow(id);
  await withRetry(() => env.DB.prepare("UPDATE workflows SET active=?, updated_at=datetime('now') WHERE id=?").bind(active, id).run());
  wf.active = !!active;
  return c.json({ data: await toResponse(wf) });
}

async function setArchived(env: Env, id: string, archived: number, c: { json: any }) {
  const [wf, row] = await workflowAfterState(env, id);
  if (!row) return missingWorkflow(id);
  await withRetry(() => env.DB.prepare("UPDATE workflows SET archived=?, updated_at=datetime('now') WHERE id=?").bind(archived, id).run());
  wf.isArchived = !!archived;
  return c.json({ data: await toResponse(wf) });
}

// 新建/默认工作流（POST /workflows/new）：返回带新 id 的空工作流。
// 前端在创建新工作流时 POST /workflows/new 预先取得 id，body 可携带 projectId。
export async function newWorkflowHandler(c: Context<{ Bindings: Env }>) {
  let projectId: string = PERSONAL_PROJECT_ID;
  try {
    const body = await c.req.json<{ projectId?: string | null }>();
    projectId = normalizeProjectId(body?.projectId);
  } catch { /* 空 body 或无 JSON → 忽略，用个人项目 */ }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return c.json({ data: { id, name: 'Untitled workflow', nodes: [], connections: {}, active: false, settings: {}, projectId, enabled: true, versionId: id, checksum: await computeChecksum({ id, name: 'Untitled workflow' }), isArchived: false, createdAt: now, updatedAt: now } });
}

async function withWorkflow(
  env: Env,
  id: string,
  handler: (wf: N8nWorkflow, row: WorkflowRow) => Promise<Response>,
  notFound: () => Response,
): Promise<Response> {
  const row = await withRetry(() => env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<WorkflowRow>());
  if (!row) return notFound();
  const wf = parseWorkflowRow(row);
  return handler(wf, row);
}

// 更新工作流（PUT 与 PATCH 共用）：按 body 全量/局部更新 name/nodes/connections/settings/project_id/active。
// 幂等 upsert：新建工作流的 id 由 POST /workflows/new 预取，前端会直接以该 id 发首次 PUT/PATCH；
// 若该行尚未入库而只做 UPDATE，会命中 withWorkflow 的 404 → 前端报 "Failed to update workflow"。
// 因此行不存在时改为 INSERT(upsert)，保证自动保存永不因首次保存而 404。
async function updateWorkflowHandler(c: Context<{ Bindings: Env }>, id: string) {
  const row = await withRetry(() => c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(id).first<WorkflowRow>());
  const body = await c.req.json<N8nWorkflow>().catch(() => ({} as N8nWorkflow));
  const nodesJson = JSON.stringify(body.nodes ?? (row ? JSON.parse(row.nodes ?? '[]') : []));
  const connsJson = JSON.stringify(body.connections ?? (row ? JSON.parse(row.connections ?? '{}') : {}));
  const name = body.name ?? row?.name ?? 'Untitled workflow';
  const settingsJson = body.settings ? JSON.stringify(body.settings) : (row?.settings ?? null);
  const rawProj = (body as any).projectId;
  // 归一化（REQ-38）：未显式指定 → 沿用已有值；显式 null/空 → 'personal'。
  // 注意：该比较同时起到「读到历史 NULL 行时顺带写回归一值」的迁移效果。
  const proj: string = normalizeProjectId(
    rawProj === undefined ? (row ? (row as any).project_id : undefined) : rawProj,
  );
  const active = body.active !== undefined ? (body.active ? 1 : 0) : (row?.active ?? 0);

  if (!row) {
    // 首次保存：插入（幂等，重复 PUT 即覆盖）
    await withRetry(() => c.env.DB.prepare(
      "INSERT INTO workflows (id, name, nodes, connections, settings, active, project_id) VALUES (?,?,?,?,?,?,?) "
      + "ON CONFLICT(id) DO UPDATE SET name=excluded.name, nodes=excluded.nodes, connections=excluded.connections, "
      + "settings=excluded.settings, active=excluded.active, project_id=excluded.project_id, updated_at=datetime('now')",
    ).bind(id, name, nodesJson, connsJson, settingsJson, active, proj).run());
  } else {
    let sql = "UPDATE workflows SET name=?, nodes=?, connections=?, settings=?, active=?, updated_at=datetime('now')";
    const vals: (string | number | null)[] = [name, nodesJson, connsJson, settingsJson, active];
    if (proj !== (row as any).project_id) { sql += ', project_id=?'; vals.push(proj); }
    sql += ' WHERE id=?'; vals.push(id);
    await withRetry(() => c.env.DB.prepare(sql).bind(...vals).run());
  }

  const merged: any = {
    id, name,
    nodes: body.nodes ?? (row ? JSON.parse(row.nodes ?? '[]') : []),
    connections: body.connections ?? (row ? JSON.parse(row.connections ?? '{}') : {}),
    settings: body.settings ?? (row?.settings ? JSON.parse(row.settings) : undefined),
    projectId: proj, active: !!active,
  };
  return c.json({ data: await toResponse(merged) });
}

function missingWorkflow(id: string): Response {
  return new Response(JSON.stringify({ code: 404, message: `Workflow not found ${id}`, data: undefined }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
}

// 执行摘要（供 last-successful / 卡片展示）：字段名对齐 n8n 前端读取习惯。
function toExecutionSummary(row: Pick<ExecutionRow, 'id' | 'workflow_id' | 'status' | 'mode' | 'started_at' | 'finished_at'>) {
  return {
    id: row.id, workflowId: row.workflow_id, status: row.status, mode: row.mode,
    startedAt: row.started_at, stoppedAt: row.finished_at, finished: row.status !== 'running' && row.status !== 'pending',
  };
}

// ---- /workflows/from-url 的 SSRF 防护 ----
// 该端点会让 Worker 主动请求用户提供的 URL。若不加限制，可用于探测内网与云元数据端点
// （169.254.169.254 等）。此处：仅 http(s) + 拒绝环回/私网/链路本地/内部域名 + 手动跟随最多 3 跳且每跳重新校验。
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '' ) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 云元数据（AWS/GCP/Azure）
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

async function fetchWorkflowFromUrl(raw: string): Promise<{ ok: true; workflow: unknown } | { ok: false; message: string }> {
  if (!raw.trim()) return { ok: false, message: 'Query parameter "url" is required.' };
  let target: URL;
  try { target = new URL(raw); } catch { return { ok: false, message: 'Query parameter "url" must be an absolute URL.' }; }

  for (let hop = 0; hop <= 3; hop++) {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, message: 'Only http(s) URLs can be imported.' };
    }
    if (isBlockedHost(target.hostname)) {
      return { ok: false, message: 'Importing from loopback or private network addresses is not allowed.' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(target.toString(), {
        signal: ctrl.signal, redirect: 'manual', headers: { accept: 'application/json' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, message: `Upstream responded ${res.status} without a Location header.` };
        target = new URL(loc, target);
        continue;
      }
      if (!res.ok) return { ok: false, message: `Upstream responded ${res.status}.` };
      const text = await res.text();
      if (text.length > 5 * 1024 * 1024) return { ok: false, message: 'Response too large (limit 5MB).' };
      try { return { ok: true, workflow: JSON.parse(text) }; }
      catch { return { ok: false, message: 'The URL did not return JSON.' }; }
    } catch (e) {
      return { ok: false, message: `Failed to fetch workflow: ${(e as Error).message}` };
    } finally { clearTimeout(timer); }
  }
  return { ok: false, message: 'Too many redirects.' };
}

// 前端（n8n nodesViews/Ndv）在保存后会校验响应的 checksum/versionId：
//   let a=await updateWorkflow(...); if(!a.checksum) throw('Failed to update workflow')
// 并读取 a.versionId / a.updatedAt 来同步工作流版本与"最近修改"时间。
// 缺少这些字段会令自动保存永远失败、改动不落库，进而节点无从产生输入/输出数据。
// 这里用内容 SHA-256 作为 checksum（幂等、内容变化才变），versionId 直接用工作流 id。
async function computeChecksum(wf: { id: string; name?: string; nodes?: unknown[]; connections?: unknown; settings?: unknown }): Promise<string> {
  const canonical = JSON.stringify({
    id: wf.id,
    name: wf.name ?? '',
    nodes: wf.nodes ?? [],
    connections: wf.connections ?? {},
    settings: wf.settings ?? null,
  });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function toResponse(wf: any) {
  return {
    id: wf.id, name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings,
    projectId: normalizeProjectId(wf.projectId),
    active: !!wf.active,
    isArchived: !!(wf as any).isArchived,
    versionId: wf.id,
    checksum: await computeChecksum(wf),
    // 前端按 workflow.scopes 判定该工作流的 workflowPermissions.update 等；
    // 单用户=owner 场景直接返回 owner 权限，否则节点编辑操作会被视作不可编辑而置灰。
    scopes: OWNER_SCOPES,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [],
  };
}

function safeParse(json: string | null): unknown[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}