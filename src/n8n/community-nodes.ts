// src/n8n/community-nodes.ts
import { Hono } from 'hono';
import type { Env } from '../types';

export const communityNodeRoutes = new Hono<{ Bindings: Env }>()
  .get('/', async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM community_nodes ORDER BY installed_at DESC').all();
    const data = (rows.results ?? []).map((r: any) => ({
      ...r,
      nodeCount: r.nodes_json ? JSON.parse(r.nodes_json).length : 0,
      isCommunity: true,
    }));
    return c.json({ data });
  })
  .post('/', async (c) => {
    const body = await c.req.json().catch(() => ({} as any));
    if (!body.name || body.name.trim() === '') return c.json({ code: 400, message: 'name required', data: undefined }, 400);
    const id = crypto.randomUUID();
    try {
      await c.env.DB.prepare('INSERT INTO community_nodes (id, name, display_name, version, description, nodes_json) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, body.name, body.displayName ?? null, body.version ?? null, body.description ?? null, JSON.stringify(body.nodes ?? [])).run();
      return c.json({ data: { id, name: body.name, nodeCount: Array.isArray(body.nodes) ? body.nodes.length : 0, isCommunity: true } }, 201);
    } catch (e: any) {
      if (e.message?.includes('UNIQUE')) return c.json({ code: 409, message: 'Node package already installed', data: undefined }, 409);
      throw e;
    }
  })
  .post('/:name/uninstall', async (c) => {
    const name = c.req.param('name');
    const existing = await c.env.DB.prepare('SELECT 1 FROM community_nodes WHERE name=?').bind(name).first();
    if (!existing) return c.json({ code: 404, message: 'Not found', data: undefined }, 404);
    await c.env.DB.prepare('DELETE FROM community_nodes WHERE name=?').bind(name).run();
    return c.json({ data: true });
  });
