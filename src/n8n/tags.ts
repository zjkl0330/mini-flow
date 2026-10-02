// src/n8n/tags.ts
import { Hono } from 'hono';
import type { Env } from '../types';

export const tagRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM tags ORDER BY name').all();
    return c.json({ data: rows.results ?? [] });
  })
  .post('/', async (c) => {
    const body = await c.req.json<{ name: string }>().catch(() => ({} as any));
    if (!body.name || body.name.trim() === '') return c.json({ code: 400, message: 'name required', data: undefined }, 400);
    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').bind(id, body.name).run();
      return c.json({ data: { id, name: body.name } }, 201);
    } catch (e: any) {
      if (e.message?.includes('UNIQUE')) return c.json({ code: 409, message: 'Tag already exists', data: undefined }, 409);
      throw e;
    }
  })
  .patch('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare('SELECT * FROM tags WHERE id=?').bind(id).first();
    if (!existing) return c.json({ code: 404, message: 'Tag not found', data: undefined }, 404);
    const body = await c.req.json<{ name: string }>().catch(() => ({} as any));
    if (!body.name) return c.json({ code: 400, message: 'name required', data: undefined }, 400);
    await c.env.DB.prepare('UPDATE tags SET name=?, updated_at=datetime(\'now\') WHERE id=?').bind(body.name, id).run();
    return c.json({ data: { id, name: body.name } });
  })
  .delete('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare('SELECT 1 FROM tags WHERE id=?').bind(id).first();
    if (!existing) return c.json({ code: 404, message: 'Tag not found', data: undefined }, 404);
    await c.env.DB.prepare('DELETE FROM workflow_tags WHERE tag_id=?').bind(id).run();
    await c.env.DB.prepare('DELETE FROM tags WHERE id=?').bind(id).run();
    return c.json({ data: true });
  });
