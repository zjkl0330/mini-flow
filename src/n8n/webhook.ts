// src/n8n/webhook.ts
import type { Context } from 'hono';
import type { Env, N8nWorkflow, N8nNode, N8nConnections } from '../types';
import { startExecution, type ExecutionMode } from '../engine/executor';
import { sendPush } from '../n8n/push';

export type ResponseMode = 'onReceived' | 'lastNode' | 'responseNode';

function normalizePath(path: string): string {
  return path.replace(/^\/+/g, '').replace(/\/+$/g, '');
}

export async function matchWebhookWorkflow(env: Env, path: string, method: string, opts: { test: boolean }): Promise<{ workflow: N8nWorkflow; webhookNode: N8nNode } | null> {
  const normPath = normalizePath(path);
  const active = opts.test ? 0 : 1;
  const rows = await env.DB.prepare('SELECT id, name, nodes, connections FROM workflows WHERE active=?').bind(active).all();
  
  for (const row of (rows.results ?? [])) {
    let nodes: N8nNode[] = [];
    let connections: N8nConnections = {};
    try {
      nodes = JSON.parse(row.nodes as string);
      connections = JSON.parse(row.connections as string);
    } catch { continue; }
    
    const webhookNode = nodes.find((n) => {
      if (n.disabled) return false;
      if (!/webhook/i.test(n.type)) return false;
      if (/respondToWebhook|webhookSend/i.test(n.type)) return false;
      const p = n.parameters ?? {};
      const nodePath = normalizePath(String(p.path ?? p.webhookUrl ?? p.url ?? ''));
      if (nodePath !== normPath) return false;
      if (p.httpMethod && String(p.httpMethod).toUpperCase() !== method.toUpperCase()) return false;
      return true;
    });
    
    if (webhookNode) return { workflow: { id: row.id as string, name: row.name as string, nodes, connections }, webhookNode };
  }
  return null;
}

export async function matchFormWorkflow(env: Env, path: string): Promise<{ workflow: N8nWorkflow; formNode: N8nNode } | null> {
  const normPath = normalizePath(path);
  const rows = await env.DB.prepare('SELECT id, name, nodes, connections FROM workflows WHERE active=1').all();
  
  for (const row of (rows.results ?? [])) {
    let nodes: N8nNode[] = [];
    try { nodes = JSON.parse(row.nodes as string); } catch { continue; }
    
    const formNode = nodes.find((n) => {
      if (n.disabled) return false;
      if (!/formTrigger|form_trigger|node\.form/i.test(n.type)) return false;
      const p = n.parameters ?? {};
      return normalizePath(String(p.path ?? '')) === normPath;
    });
    
    if (formNode) return { workflow: { id: row.id as string, name: row.name as string, nodes: [], connections: {} }, formNode };
  }
  return null;
}

export function determineResponseMode(workflow: N8nWorkflow, webhookNode: N8nNode): ResponseMode {
  const p = webhookNode.parameters ?? {};
  if (p.responseMode) return p.responseMode as ResponseMode;
  if (p.options?.responseMode) return p.options.responseMode as ResponseMode;
  const hasRespond = workflow.nodes?.some((n) => n.type === 'n8n-nodes-base.respondToWebhook' && !n.disabled);
  if (hasRespond) return 'responseNode';
  return 'onReceived';
}

export function flattenNodeOutput(outputData: string | null): unknown {
  if (outputData === null) return null;
  if (!outputData) return {};
  try {
    const parsed = JSON.parse(outputData);
    if (!parsed.main || !Array.isArray(parsed.main)) return {};
    const items = parsed.main;
    if (items.length === 0) return {};
    if (items.length === 1) return items[0].json ?? {};
    return items.map((i: any) => i.json);
  } catch { return outputData; }
}

export async function waitForExecutionResponse(env: Env, executionId: string, mode: ResponseMode, timeoutMs = 30000, webhookNode?: N8nNode, workflow?: N8nWorkflow): Promise<{ statusCode: number; body: unknown } | null> {
  if (mode === 'onReceived') return null;
  
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await env.DB.prepare('SELECT status, finished_at FROM executions WHERE id=?').bind(executionId).first();
    if (row?.finished_at) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  
  const row = await env.DB.prepare('SELECT status, finished_at FROM executions WHERE id=?').bind(executionId).first();
  if (!row?.finished_at) return null;
  
  let code = 200;
  if (webhookNode?.parameters?.responseCode !== undefined) code = webhookNode.parameters.responseCode as number;
  else if (workflow) {
    const respNode = workflow.nodes?.find((n) => n.type === 'n8n-nodes-base.respondToWebhook' && !n.disabled);
    if (respNode?.parameters?.responseCode !== undefined) code = respNode.parameters.responseCode as number;
  }
  else {
    try {
      const execRow = await env.DB.prepare('SELECT workflow_id FROM executions WHERE id=?').bind(executionId).first();
      if (execRow) {
        const wfRow = await env.DB.prepare('SELECT nodes FROM workflows WHERE id=?').bind(execRow.workflow_id as string).first();
        if (wfRow) {
          const wfNodes = JSON.parse(wfRow.nodes as string);
          const respNode = wfNodes.find((n: any) => n.type === 'n8n-nodes-base.respondToWebhook' && !n.disabled);
          if (respNode?.parameters?.responseCode !== undefined) code = respNode.parameters.responseCode as number;
        }
      }
    } catch {}
  }
  
  if (mode === 'responseNode') {
    const neRows = await env.DB.prepare("SELECT output_data FROM node_executions WHERE execution_id=? AND node_type='n8n-nodes-base.respondToWebhook' ORDER BY finished_at DESC LIMIT 1").bind(executionId).all();
    for (const ne of (neRows.results ?? [])) {
      const out = flattenNodeOutput(ne.output_data as string);
      if (out && typeof out === 'object') return { statusCode: code, body: out };
    }
  }
  
  const lastRow = await env.DB.prepare("SELECT output_data FROM node_executions WHERE execution_id=? AND node_type NOT IN ('n8n-nodes-base.webhook','n8n-nodes-base.respondToWebhook') ORDER BY finished_at DESC LIMIT 1").bind(executionId).first();
  if (lastRow) return { statusCode: 200, body: flattenNodeOutput(lastRow.output_data as string) };
  
  return { statusCode: 200, body: { message: 'Workflow was started' } };
}

export async function handleWebhookRequest(c: Context<{ Bindings: Env }>, opts: { test: boolean }): Promise<Response> {
  const reqPath = c.req.path;
  const prefix = opts.test ? '/webhook-test/' : '/webhook/';
  let path = reqPath.startsWith(prefix) ? reqPath.substring(prefix.length) : (reqPath === '/webhook-test' || reqPath === '/webhook' ? '' : reqPath);
  const normPath = normalizePath(path);
  const method = c.req.method;
  
  const match = await matchWebhookWorkflow(c.env, normPath, method, { test: opts.test });
  if (!match) return c.json({ code: 404, message: `The requested webhook "${method} ${normPath}" is not registered.`, data: undefined }, 404);
  
  const { workflow, webhookNode } = match;
  let input: unknown = {};
  try {
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      const ct = c.req.header('content-type') ?? '';
      if (ct.includes('application/json')) input = await c.req.json();
      else if (ct.includes('application/x-www-form-urlencoded')) input = Object.fromEntries(await c.req.formData());
      else input = await c.req.text();
    }
    input = { body: input, headers: {} as Record<string, string>, query: c.req.query() as Record<string, string>, params: {}, method: c.req.method };
  } catch { input = { body: undefined, headers: {}, query: {}, params: {}, method: c.req.method }; }
  
  let execId: string;
  try {
    const run = await startExecution(c.env, { ...workflow, id: workflow.id }, input, 'webhook' as ExecutionMode, (e: any) => sendPush(c.env, e));
    if (!run.ok) throw new Error(run.error ?? 'start failed');
    execId = run.executionId;
  } catch (e) {
    console.error('[webhook] startExecution failed:', e);
    return c.json({ code: 500, message: 'Failed to start workflow', data: undefined }, 500);
  }
  
  const respMode = determineResponseMode(workflow, webhookNode);
  if (respMode === 'onReceived') return c.json({ message: 'Workflow was started' });
  
  const resp = await waitForExecutionResponse(c.env, execId, respMode, 30000, webhookNode, workflow);
  if (!resp) return c.json({ message: 'Workflow was started' });
  return new Response(JSON.stringify(resp.body), { status: resp.statusCode, headers: { 'Content-Type': 'application/json' } });
}

export async function handleFormRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const reqPath = c.req.path;
  let path = reqPath.startsWith('/form/') ? reqPath.substring('/form/'.length) : (reqPath === '/form' ? '' : reqPath);
  const normPath = normalizePath(path);
  
  const match = await matchFormWorkflow(c.env, normPath);
  if (!match) return c.json({ code: 404, message: 'Form not found', data: undefined }, 404);
  
  const { workflow, formNode } = match;
  
  if (c.req.method === 'GET') {
    const p = formNode.parameters ?? {};
    const fields = Array.isArray(p.formFields) ? p.formFields : [];
    let html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + (p.formTitle || 'Form') + '</title></head><body>';
    html += '<h1>' + (p.formTitle || 'Form') + '</h1>';
    html += '<form method="POST">';
    for (const f of fields) {
      const label = f.fieldLabel || f.fieldName || 'Field';
      const name = f.fieldName || 'field';
      const type = f.fieldType || 'text';
      html += '<div style="margin:0.5rem 0"><label>' + label + '</label><input type="' + type + '" name="' + name + '" required></div>';
    }
    html += '<button type="submit">Submit</button></form></body></html>';
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  
  let input: unknown = {};
  try {
    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('application/x-www-form-urlencoded')) input = Object.fromEntries(await c.req.formData());
    else if (ct.includes('application/json')) input = await c.req.json();
    else input = await c.req.text();
  } catch { input = { body: undefined }; }
  
  let execId: string;
  try {
    const run = await startExecution(c.env, { ...workflow, id: workflow.id }, input, 'webhook' as ExecutionMode, (e: any) => sendPush(c.env, e));
    if (!run.ok) throw new Error(run.error ?? 'start failed');
    execId = run.executionId;
  } catch (e) {
    console.error('[form] startExecution failed:', e);
    return c.json({ code: 500, message: 'Failed to start workflow', data: undefined }, 500);
  }
  
  const accept = c.req.header('accept') ?? '';
  if (accept.includes('application/json')) return c.json({ data: { executionId: execId } });
  return new Response('Form submitted', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}