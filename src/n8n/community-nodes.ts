// n8n/community-nodes.ts —— 社区节点安装 / 卸载登记（REQ-32）
//
// 重要边界：Workers 无法真正加载/执行任意 npm 包，本模块为**元数据级安装登记**：
// 只把「包名 + 版本 + 声明的节点元数据」落 D1 `community_nodes`，供 `/rest/plugins` 合并展示，
// 不执行任何外部代码（与既有占位节点语义一致）。
import { Hono } from 'hono';
import type { Env } from '../types';
import { withRetry } from '../engine/retry';
import type { CommunityNodeRow } from '../db/schema';

interface InstallBody {
  name?: unknown;
  version?: unknown;
  displayName?: unknown;
  description?: unknown;
  nodes?: unknown;
}

function countNodes(nodesJson: string | null): number {
  try {
    const parsed = JSON.parse(nodesJson ?? '[]');
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function parseNodes(nodeValue: string | null): unknown[] {
  try {
    const parsed = JSON.parse(nodeValue ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toCommunity(r: CommunityNodeRow) {
  const nodes = parseNodes(r.nodes_json);
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name ?? r.name,
    version: r.version ?? '0.0.0',
    description: r.description ?? '',
    nodes,
    nodeCount: nodes.length,
    installedAt: r.installed_at,
    isCommunity: true,
  };
}

// 供 router.ts 的 GET /rest/plugins 合并展示（内置 + 社区）。
export async function listCommunityPackagePlugins(
  env: Env,
): Promise<Array<{ id: string; label: string; description: string; isCommunity: boolean; nodeCount: number }>> {
  const res = await env.DB.prepare(
    'SELECT name, display_name, description, nodes_json FROM community_nodes ORDER BY installed_at DESC',
  ).all<Pick<CommunityNodeRow, 'name' | 'display_name' | 'description' | 'nodes_json'>>()
    .catch(() => ({ results: [] as Array<Pick<CommunityNodeRow, 'name' | 'display_name' | 'description' | 'nodes_json'>> }));
  return (res.results ?? []).map((r) => ({
    id: r.name,
    label: r.display_name ?? r.name,
    description: r.description ?? '',
    isCommunity: true,
    nodeCount: countNodes(r.nodes_json),
  }));
}

export const communityNodeRoutes = new Hono<{ Bindings: Env }>()
  // 已安装清单
  .get('/', async (c) => {
    const res = await withRetry(() => c.env.DB.prepare('SELECT * FROM community_nodes ORDER BY installed_at DESC').all<CommunityNodeRow>());
    return c.json({ data: (res.results ?? []).map(toCommunity) });
  })
  // 安装（登记）
  .post('/', async (c) => {
    const body = await c.req.json<InstallBody>().catch(() => ({} as InstallBody));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ code: 400, message: 'name is required', data: undefined }, 400);

    const existing = await withRetry(() => c.env.DB.prepare('SELECT * FROM community_nodes WHERE name=?').bind(name).first<CommunityNodeRow>());
    if (existing) return c.json({ code: 409, message: 'Community node already installed', data: undefined }, 409);

    const id = crypto.randomUUID();
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    const version = typeof body.version === 'string' ? body.version : null;
    const displayName = typeof body.displayName === 'string' ? body.displayName : null;
    const description = typeof body.description === 'string' ? body.description : null;

    await withRetry(() => c.env.DB.prepare(
      'INSERT INTO community_nodes (id, name, display_name, version, description, nodes_json) VALUES (?,?,?,?,?,?)',
    ).bind(id, name, displayName, version, description, JSON.stringify(nodes)).run());

    const row = await withRetry(() => c.env.DB.prepare('SELECT * FROM community_nodes WHERE id=?').bind(id).first<CommunityNodeRow>());
    return c.json({ data: toCommunity(row as CommunityNodeRow) }, 201);
  })
  // 卸载（按包名）
  .post('/:name/uninstall', async (c) => {
    const name = c.req.param('name');
    const row = await withRetry(() => c.env.DB.prepare('SELECT * FROM community_nodes WHERE name=?').bind(name).first<CommunityNodeRow>());
    if (!row) return c.json({ code: 404, message: 'Community node not found', data: undefined }, 404);
    await withRetry(() => c.env.DB.prepare('DELETE FROM community_nodes WHERE name=?').bind(name).run());
    return c.json({ data: true });
  });
