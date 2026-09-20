// n8n/insights.ts —— 实例洞察聚合端点（REQ-26）
//
// 全部只读、在 /rest 全局鉴权墙内（router.ts 挂载于墙后）。
// 数据源：D1 `executions`（COUNT / SUM(failed) / AVG(finished-started)）。
// 非法/缺失参数一律回落默认值，不 500。
import { Hono } from 'hono';
import type { Env } from '../types';
import { withRetry } from '../engine/retry';

// 每毫秒对应天数（julianday 差 × 该常数 = 毫秒）
const MS_PER_DAY = 86_400_000;

// 解析 startDate/endDate（ISO 字符串或 YYYY-MM-DD）；非法则忽略。
// colPrefix 允许在 join 查询里限定列（如 'e.'）。
function dateWhere(query: Record<string, string | undefined>, colPrefix = ''): { sql: string; binds: string[] } {
  const clauses: string[] = [];
  const binds: string[] = [];
  const start = normalizeDate(query.startDate);
  const end = normalizeDate(query.endDate);
  if (start) { clauses.push(`${colPrefix}started_at >= ?`); binds.push(start); }
  if (end) { clauses.push(`${colPrefix}started_at <= ?`); binds.push(end); }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', binds };
}

function normalizeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// AVG 运行时长（毫秒）表达式；仅统计已有 finished_at 的执行。
const avgMs = (prefix = '') => `AVG(CASE WHEN ${prefix}finished_at IS NOT NULL THEN (julianday(${prefix}finished_at) - julianday(${prefix}started_at)) * ${MS_PER_DAY} END)`;
const failedSum = (prefix = '') => `SUM(CASE WHEN ${prefix}status='failed' THEN 1 ELSE 0 END)`;

function rate(failed: number, total: number): number {
  return total > 0 ? failed / total : 0;
}

export const insightsRoutes = new Hono<{ Bindings: Env }>()
  // GET /rest/insights/summary
  .get('/summary', async (c) => {
    const f = dateWhere(c.req.query());
    const agg = await withRetry(() => c.env.DB.prepare(
      `SELECT COUNT(*) AS total, ${failedSum()} AS failed, ${avgMs()} AS avg_ms FROM executions${f.sql}`,
    ).bind(...f.binds).first<{ total: number; failed: number | null; avg_ms: number | null }>());
    const total = Number(agg?.total ?? 0);
    const failed = Number(agg?.failed ?? 0);
    return c.json({ data: {
      total,
      failed,
      failureRate: rate(failed, total),
      averageRunTime: Math.round(Number(agg?.avg_ms ?? 0)),
      timeSaved: 0,
    } });
  })
  // GET /rest/insights/by-workflow
  .get('/by-workflow', async (c) => {
    const f = dateWhere(c.req.query(), 'e.');
    const res = await withRetry(() => c.env.DB.prepare(
      `SELECT e.workflow_id AS workflow_id, w.name AS workflow_name, COUNT(*) AS total, `
      + `${failedSum('e.')} AS failed, ${avgMs('e.')} AS avg_ms `
      + `FROM executions e LEFT JOIN workflows w ON w.id = e.workflow_id${f.sql} `
      + 'GROUP BY e.workflow_id ORDER BY total DESC',
    ).bind(...f.binds).all<{ workflow_id: string; workflow_name: string | null; total: number; failed: number | null; avg_ms: number | null }>());
    const data = (res.results ?? []).map((r) => {
      const total = Number(r.total ?? 0);
      const failed = Number(r.failed ?? 0);
      return {
        workflowId: r.workflow_id,
        workflowName: r.workflow_name ?? r.workflow_id,
        total,
        failed,
        failureRate: rate(failed, total),
        averageRunTime: Math.round(Number(r.avg_ms ?? 0)),
      };
    });
    return c.json({ data });
  })
  // GET /rest/insights/by-time?granularity=day|hour
  .get('/by-time', async (c) => {
    const granularity = c.req.query('granularity') === 'hour' ? 'hour' : 'day';
    const fmt = granularity === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
    const f = dateWhere(c.req.query());
    const res = await withRetry(() => c.env.DB.prepare(
      `SELECT strftime('${fmt}', started_at) AS date, COUNT(*) AS total, ${failedSum()} AS failed `
      + `FROM executions${f.sql} GROUP BY date ORDER BY date ASC`,
    ).bind(...f.binds).all<{ date: string; total: number; failed: number | null }>());
    const data = (res.results ?? []).map((r) => ({
      date: r.date,
      total: Number(r.total ?? 0),
      failed: Number(r.failed ?? 0),
    }));
    return c.json({ data });
  })
  // GET /rest/insights/by-time/time-saved —— 洞察页「节省时间」卡片。
  // 本移植版不采集人工耗时基线，采用**显式声明的估算口径**：
  // 每次成功执行按 1 分钟人工成本折算，并在响应中回传估算参数，避免把估算伪装成实测。
  .get('/by-time/time-saved', async (c) => {
    const f = dateWhere(c.req.query());
    const res = await withRetry(() => c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM executions${f.sql}`
      + (f.sql ? ' AND' : ' WHERE') + " status='completed'",
    ).bind(...f.binds).all<{ total: number }>());
    const succeeded = Number((res.results ?? [])[0]?.total ?? 0);
    const minutesPerRun = 1;
    return c.json({ data: {
      timeSaved: succeeded * minutesPerRun * 60_000, // 毫秒，与前端时长格式一致
      totalTimeSaved: succeeded * minutesPerRun * 60_000,
      succeededExecutions: succeeded,
      estimatedMinutesPerWorkflow: minutesPerRun,
      estimated: true,
    } });
  })
  // GET /rest/insights/by-mode
  .get('/by-mode', async (c) => {
    const f = dateWhere(c.req.query());
    const res = await withRetry(() => c.env.DB.prepare(
      `SELECT COALESCE(mode, 'manual') AS mode, COUNT(*) AS total, ${failedSum()} AS failed `
      + `FROM executions${f.sql} GROUP BY mode ORDER BY total DESC`,
    ).bind(...f.binds).all<{ mode: string; total: number; failed: number | null }>());
    const data = (res.results ?? []).map((r) => ({
      mode: r.mode,
      total: Number(r.total ?? 0),
      failed: Number(r.failed ?? 0),
    }));
    return c.json({ data });
  });
