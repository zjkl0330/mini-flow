// push: Worker 侧向 Durable Object 投递执行事件的辅助
import type { Env, PushEvent } from '../types';

const ROUTE = 'main';

export async function sendPush(env: Env, event: PushEvent): Promise<void> {
  try {
    const id = env.PUSH.idFromName(ROUTE);
    const stub = env.PUSH.get(id);
    await stub.fetch('https://do/push', { method: 'POST', body: JSON.stringify(event) });
  } catch {
    // push 失败不影响主流程
  }
}

export async function pushSubscribeHandler(c: { env: Env; req: { header: (k: string) => string | null; url: string } }) {
  // 最小实现：未登录返回 401，已登录返回 200
  const h = c.req.header('cookie') ?? '';
  const m = /(?:^|;)\s*n8n-auth=([^;]+)/.exec(h);
  if (!m) return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
  return c.json({ data: [] });
}
