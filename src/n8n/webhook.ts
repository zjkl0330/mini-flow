// n8n/webhook.ts —— 外部触发（Webhook + Form）匹配 / 触发 / 响应收集（REQ-14 / REQ-31）
//
// 背景：`/webhook/:path`、`/form/:path` 此前落 index.ts 的 SPA fallback，返回 index.html（200 text/html），
// 外部调用方无法真正触发已激活的工作流。本模块在 SPA fallback 之前注册（见 src/index.ts 装配顺序），
// 由它负责「按 path 找到工作流 → 提交执行 → 按响应模式返回」。
//
// 关键约束：
//   * 公开外部入口，不经 /rest 鉴权墙（符合外部触发语义）。
//   * 生成/回包不做任意 JS 求值，不引入 eval / new Function（Workers CSP）。
import type { Context } from 'hono';
import type { Env, N8nWorkflow, N8nNode } from '../types';
import { parseWorkflowRow, type WorkflowRow } from '../db/schema';
import { startExecution } from '../engine/executor';
import { sendPush } from './push';

// 等待工作流回包的轮询参数（Workers 支持 setTimeout）
const POLL_MS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ResponseMode = 'onReceived' | 'lastNode' | 'responseNode';

// path 归一化：去首尾斜杠 + URL 解码，保证两侧可比。
export function normalizePath(raw: unknown): string {
  let p = raw === undefined || raw === null ? '' : String(raw);
  try { p = decodeURIComponent(p); } catch { /* 保留原值 */ }
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

// 判断节点 type 是否为「接收型 webhook 触发节点」——排除回包/发送类节点。
function isWebhookTriggerType(type: string): boolean {
  if (!/webhook/i.test(type)) return false;
  if (/respondToWebhook|webhookSend/i.test(type)) return false;
  return true;
}

function isRespondToWebhookType(type: string): boolean {
  return /respondToWebhook/i.test(type);
}

function parseNodes(row: WorkflowRow): N8nNode[] {
  try {
    const nodes = JSON.parse(row.nodes ?? '[]');
    return Array.isArray(nodes) ? (nodes as N8nNode[]) : [];
  } catch {
    return [];
  }
}

// 匹配已激活（test=false）或未激活（test=true）工作流中的 webhook 触发节点。
export async function matchWebhookWorkflow(
  env: Env,
  path: string,
  method: string,
  opts: { test: boolean },
): Promise<{ workflow: N8nWorkflow; webhookNode: N8nNode } | null> {
  const rows = await env.DB.prepare('SELECT * FROM workflows WHERE active=?')
    .bind(opts.test ? 0 : 1).all<WorkflowRow>();
  const target = normalizePath(path);
  const wantedMethod = String(method ?? 'GET').toUpperCase();

  for (const row of rows.results ?? []) {
    for (const node of parseNodes(row)) {
      if (node.disabled) continue;
      if (!isWebhookTriggerType(node.type ?? '')) continue;
      if (normalizePath(node.parameters?.path) !== target) continue;
      const nodeMethod = node.parameters?.httpMethod;
      if (nodeMethod && String(nodeMethod).toUpperCase() !== wantedMethod) continue;
      return { workflow: parseWorkflowRow(row), webhookNode: node };
    }
  }
  return null;
}

// 匹配已激活工作流中的 formTrigger 节点（REQ-31）。
export async function matchFormWorkflow(
  env: Env,
  path: string,
): Promise<{ workflow: N8nWorkflow; formNode: N8nNode } | null> {
  const rows = await env.DB.prepare('SELECT * FROM workflows WHERE active=1').all<WorkflowRow>();
  const target = normalizePath(path);
  for (const row of rows.results ?? []) {
    for (const node of parseNodes(row)) {
      if (node.disabled) continue;
      if (!/formTrigger|form_trigger|node\.form/i.test(node.type ?? '')) continue;
      if (normalizePath(node.parameters?.path) !== target) continue;
      return { workflow: parseWorkflowRow(row), formNode: node };
    }
  }
  return null;
}

// 依据 webhook 节点参数 / 工作流拓扑决定回包语义。
export function determineResponseMode(workflow: N8nWorkflow, webhookNode: N8nNode): ResponseMode {
  const rm = webhookNode.parameters?.responseMode ?? webhookNode.parameters?.options?.responseMode;
  if (rm === 'lastNode') return 'lastNode';
  if (rm === 'responseNode') return 'responseNode';
  if (rm === 'onReceived') return 'onReceived';
  const hasRespondNode = (workflow.nodes ?? []).some(
    (n) => !n.disabled && isRespondToWebhookType(n.type ?? ''),
  );
  if (hasRespondNode) return 'responseNode';
  return 'onReceived';
}

// 把节点输出（node_executions.output_data，形如 { main: [{ json }] }）摊平成对外回包体。
export function flattenNodeOutput(outputData: string | null): unknown {
  if (!outputData) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(outputData); } catch { return outputData; }
  if (!parsed || typeof parsed !== 'object') return parsed;
  const main = (parsed as { main?: unknown }).main;
  if (Array.isArray(main)) {
    const items = main.map((it) => {
      const o = it as { json?: unknown };
      return o && typeof o === 'object' && 'json' in o ? o.json : it;
    });
    if (items.length === 0) return {};
    if (items.length === 1) return items[0];
    return items;
  }
  return parsed;
}

// 轮询执行终态，取回包节点输出与状态码（responseNode / lastNode）。
// 超时或无法取到 → 返回 null（调用方回退 200 {"message":"Workflow was started"}）。
export async function waitForExecutionResponse(
  env: Env,
  executionId: string,
  mode: ResponseMode,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ statusCode: number; body: unknown } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(
      'SELECT status, finished_at, workflow_id FROM executions WHERE id=?',
    ).bind(executionId).first<{ status: string; finished_at: string | null; workflow_id: string }>();

    if (row?.finished_at) {
      const logs = await env.DB.prepare(
        'SELECT node_name, node_type, output_data FROM node_executions WHERE execution_id=? ORDER BY rowid ASC',
      ).bind(executionId).all<{ node_name: string; node_type: string; output_data: string | null }>();
      const results = logs.results ?? [];
      const chosen = mode === 'responseNode'
        ? ([...results].reverse().find((r) => isRespondToWebhookType(r.node_type)) ?? results[results.length - 1])
        : results[results.length - 1];
      const statusCode = await resolveResponseCode(env, row.workflow_id, chosen?.node_name);
      const body = flattenNodeOutput(chosen?.output_data ?? null);
      return { statusCode, body };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

// 状态码来源：respondToWebhook 节点的 parameters.responseCode，缺省 200。
async function resolveResponseCode(env: Env, workflowId: string, nodeName: string | undefined): Promise<number> {
  if (!nodeName) return 200;
  try {
    const row = await env.DB.prepare('SELECT nodes FROM workflows WHERE id=?')
      .bind(workflowId).first<{ nodes: string }>();
    if (!row?.nodes) return 200;
    const nodes = JSON.parse(row.nodes) as N8nNode[];
    const node = nodes.find((n) => n.name === nodeName && isRespondToWebhookType(n.type ?? ''));
    const code = Number(node?.parameters?.responseCode);
    return Number.isFinite(code) && code >= 100 && code <= 599 ? code : 200;
  } catch {
    return 200;
  }
}

// 收集请求的 headers（小写键，与 n8n 一致）。
function collectHeaders(c: Context<{ Bindings: Env }>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return headers;
}

// 组装 n8n 风格触发输入 { body, headers, query, params, method }。
async function assembleInput(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  const method = c.req.method.toUpperCase();
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const text = await c.req.text().catch(() => '');
    if (text) {
      if (contentType.includes('application/json')) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(text));
      } else {
        body = text;
      }
    }
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) query[k] = v;
  return { body, headers: collectHeaders(c), query, params: {}, method };
}

// —— 对外入口：Webhook ——
export async function handleWebhookRequest(
  c: Context<{ Bindings: Env }>,
  opts: { test: boolean },
): Promise<Response> {
  const url = new URL(c.req.url);
  const prefix = opts.test ? '/webhook-test' : '/webhook';
  const rawPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  const path = normalizePath(rawPath);
  const method = c.req.method.toUpperCase();

  const match = await matchWebhookWorkflow(c.env, path, method, opts).catch(() => null);
  if (!match) {
    // 未匹配 → 404 JSON（不得落 SPA fallback 返回 HTML）
    return c.json({
      code: 404,
      message: `The requested webhook "${method} ${path}" is not registered.`,
      data: undefined,
    }, 404);
  }

  const input = await assembleInput(c);
  const mode = determineResponseMode(match.workflow, match.webhookNode);
  const outcome = await startExecution(c.env, match.workflow, input, 'webhook', (e) => void sendPush(c.env, e));
  if (!outcome.ok) {
    return c.json({ code: 409, message: outcome.error ?? 'execution failed to start', data: undefined }, 409);
  }

  if (mode === 'onReceived') {
    return c.json({ message: 'Workflow was started' }, 200);
  }

  const resp = await waitForExecutionResponse(c.env, outcome.executionId, mode, DEFAULT_TIMEOUT_MS);
  if (!resp) {
    // 超时/未完成 → 回落 onReceived（不返回 504，避免外部调用方把「已触发」误判为失败）
    return c.json({ message: 'Workflow was started' }, 200);
  }
  return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
    status: resp.statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

// —— 对外入口：Form ——
export async function handleFormRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  const path = normalizePath(url.pathname.startsWith('/form') ? url.pathname.slice('/form'.length) : url.pathname);

  const match = await matchFormWorkflow(c.env, path).catch(() => null);
  if (!match) {
    return c.json({
      code: 404,
      message: `The requested form "${path}" is not registered.`,
      data: undefined,
    }, 404);
  }

  if (c.req.method.toUpperCase() === 'GET') {
    return new Response(renderForm(match.formNode, path), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return handleFormSubmit(c, match);
}

async function handleFormSubmit(
  c: Context<{ Bindings: Env }>,
  match: { workflow: N8nWorkflow; formNode: N8nNode },
): Promise<Response> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  const text = await c.req.text().catch(() => '');
  let data: Record<string, unknown> = {};
  if (contentType.includes('application/json')) {
    try { data = JSON.parse(text) as Record<string, unknown>; } catch { data = {}; }
  } else if (text) {
    data = Object.fromEntries(new URLSearchParams(text));
  }

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) query[k] = v;
  const input = { body: data, headers: collectHeaders(c), query, params: {}, method: 'POST', form: data };

  const outcome = await startExecution(c.env, match.workflow, input, 'webhook', (e) => void sendPush(c.env, e));
  if (!outcome.ok) {
    return c.json({ code: 409, message: outcome.error ?? 'execution failed to start', data: undefined }, 409);
  }

  if ((c.req.header('accept') ?? '').includes('application/json')) {
    return c.json({ data: { executionId: outcome.executionId } }, 200);
  }
  return new Response(renderSubmitted(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// —— Form 渲染（极简，不引入任意 JS） ——

interface FormField {
  name: string;
  label: string;
  type: string;
}

function parseFormFields(node: N8nNode): FormField[] {
  const raw = node.parameters?.formFields;
  let list: unknown[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* ignore */ }
  } else if (raw && Array.isArray((raw as { values?: unknown[] }).values)) {
    list = (raw as { values: unknown[] }).values;
  }
  return list.map((f, i) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return {
      name: String(o.fieldName ?? o.name ?? o.field ?? `field${i}`),
      label: String(o.fieldLabel ?? o.label ?? o.name ?? `字段${i + 1}`),
      type: String(o.fieldType ?? o.type ?? 'text'),
    };
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch] as string));
}

function renderForm(node: N8nNode, path: string): string {
  const title = String(node.parameters?.formTitle ?? `${path} form`);
  const fields = parseFormFields(node);
  const inputs = (fields.length ? fields : [{ name: 'data', label: 'data', type: 'text' }])
    .map((f) => {
      const inputType = f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text';
      return `<label>${escapeHtml(f.label)}<br><input name="${escapeHtml(f.name)}" type="${inputType}"></label>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(title)}</h1>
<form method="POST" action="/form/${escapeHtml(normalizePath(path))}">
${inputs}
<p><button type="submit">Submit</button></p>
</form></body></html>`;
}

function renderSubmitted(): string {
  return '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8"><title>Form submitted</title></head>'
    + '<body><h1>Form submitted</h1><p>Workflow was started.</p></body></html>';
}
