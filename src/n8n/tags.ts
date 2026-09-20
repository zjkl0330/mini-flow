// n8n/tags.ts —— 工作流标签 CRUD（REQ-27）
//
// 契约：GET /rest/tags → { data: Tag[] }；POST → 201；PATCH/DELETE。
// 迁移期空表仍返回 []，不破坏前端初始化。
import { Hono } from 'hono';
import type { Env } from '../types';
import { withRetry } from '../engine/retry';
import type { TagRow } from '../db/schema';

function toTag(r: TagRow) {
  return { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
}

// 从请求体提取 name（字符串化 + 去空白）
function pickName(body: { name?: unknown }): string {
  return typeof body.name === 'string' ? body.name.trim() : '';
}

export const tagRoutes = new Hono<{ Bindings: Env }>()
  // 列表
  .get('/', async (c) => {
    const res = await withRetry(() => c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<TagRow>());
    return c.json({ data: (res.results ?? []).map(toTag) });
  })
  // 创建
  .post('/', async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const name = pickName(body);
    if (!name) return c.json({ code: 400, message: 'name is required', data: undefined }, 400);
    const existing = await withRetry(() => c.env.DB.prepare('SELECT * FROM tags WHERE name=?').bind(name).first<TagRow>());
    if (existing) return c.json({ code: 409, message: 'Tag already exists', data: undefined }, 409);
    const id = crypto.randomUUID();
    await withRetry(() => c.env.DB.prepare('INSERT INTO tags (id, name) VALUES (?,?)').bind(id, name).run());
    const row = await withRetry(() => c.env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first<TagRow>());
    return c.json({ data: toTag(row as TagRow) }, 201);
  })
  // 重命名
  .patch('/:id', async (c) => {
    const id = c.req.param('id');
    const row = await withRetry(() => c.env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first<TagRow>());
    if (!row) return c.json({ code: 404, message: 'Tag not found', data: undefined }, 404);
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({} as { name?: unknown }));
    const name = pickName(body);
    if (!name) return c.json({ code: 400, message: 'name is required', data: undefined }, 400);
    const dup = await withRetry(() => c.env.DB.prepare('SELECT id FROM tags WHERE name=? AND id<>?').bind(name, id).first<{ id: string }>());
    if (dup) return c.json({ code: 409, message: 'Tag already exists', data: undefined }, 409);
    await withRetry(() => c.env.DB.prepare("UPDATE tags SET name=?, updated_at=datetime('now') WHERE id=?").bind(name, id).run());
    const updated = await withRetry(() => c.env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first<TagRow>());
    return c.json({ data: toTag(updated as TagRow) });
  })
  // 删除（级联删关联）；不存在的 id → 404，与 community-nodes/:name/uninstall 语义统一
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const row = await withRetry(() => c.env.DB.prepare('SELECT id FROM tags WHERE id=?').bind(id).first<{ id: string }>());
    if (!row) return c.json({ code: 404, message: 'Tag not found', data: undefined }, 404);
    await withRetry(() => c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM workflow_tags WHERE tag_id=?').bind(id),
      c.env.DB.prepare('DELETE FROM tags WHERE id=?').bind(id),
    ]));
    return c.json({ data: true });
  });
