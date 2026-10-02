// src/n8n/insights.ts
import { Hono } from 'hono';
import type { Env } from '../types';

export const insightsRoutes = new Hono<{ Bindings: Env }>()
  .get('/summary', async (c) => {
    const total = (await c.env.DB.prepare('SELECT COUNT(*) AS c FROM executions').first<{ c: number }>())?.c ?? 0;
    const failed = (await c.env.DB.prepare("SELECT COUNT(*) AS c FROM executions WHERE status = 'failed'").first<{ c: number }>())?.c ?? 0;
    const failureRate = total > 0 ? failed / total : 0;
    const rows = await c.env.DB.prepare('SELECT started_at, finished_at FROM executions WHERE finished_at IS NOT NULL').all();
    let totalRuntime = 0;
    for (const row of (rows.results ?? [])) {
      if (row.started_at && row.finished_at) {
        const s = new Date(String(row.started_at)).getTime();
        const f = new Date(String(row.finished_at)).getTime();
        totalRuntime += f - s;
      }
    }
    const averageRunTime = rows.results?.length ?? 0 > 0 ? totalRuntime / rows.results.length : 0;
    return c.json({ data: { total, failed, failureRate, averageRunTime, timeSaved: 0 } });
  })
  .get('/by-workflow', async (c) => {
    const rows = await c.env.DB.prepare(`
      SELECT w.id as workflowId, w.name as workflowName,
        COUNT(*) as total,
        SUM(CASE WHEN e.status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM workflows w
      LEFT JOIN executions e ON e.workflow_id = w.id
      GROUP BY w.id
    `).all();
    const data = (rows.results ?? []).map((r: any) => ({
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      total: r.total,
      failed: r.failed,
      failureRate: r.total > 0 ? r.failed / r.total : 0,
      averageRunTime: 0,
    }));
    return c.json({ data });
  })
  .get('/by-time', async (c) => {
    const granularity = c.req.query('granularity') ?? 'day';
    const fmt = granularity === 'hour' ? '%Y-%m-%d %H' : '%Y-%m-%d';
    const rows = await c.env.DB.prepare(`
      SELECT strftime('${fmt}', started_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM executions
      GROUP BY date
    `).all();
    return c.json({ data: (rows.results ?? []).map((r: any) => ({ date: r.date, total: r.total, failed: r.failed })) });
  })
  .get('/by-mode', async (c) => {
    const rows = await c.env.DB.prepare(`
      SELECT mode, COUNT(*) as total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM executions
      GROUP BY mode
    `).all();
    return c.json({ data: (rows.results ?? []).map((r: any) => ({ mode: r.mode, total: r.total, failed: r.failed })) });
  });