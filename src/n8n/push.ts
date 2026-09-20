// push: Worker 侧向 Durable Object 投递执行事件的辅助
// 前端通过 /push SSE 订阅；此处负责把 engine 产生的事件 POST 到 DO 广播。
import type { Context } from 'hono';
import type { Env, PushEvent } from '../types';
import { isAuthed } from './auth';

// names: 每个执行可绑定到固定 id 以区分；骨架用单一 'main' 通道
const ROUTE = 'main';

export async function sendPush(env: Env, event: PushEvent): Promise<void> {
  try {
    const id = env.PUSH.idFromName(ROUTE);
    const stub = env.PUSH.get(id);
    await stub.fetch('https://do/push', { method: 'POST', body: JSON.stringify(event) });
  } catch {
    // push 失败不影响主流程：前端回落 REST 轮询
  }
}

// SSE 订阅端点（GET /rest/push 与 GET /push 共用）：
// 因该路径注册在 restApi 之外，不经过 /rest 的全局鉴权墙，必须在此显式鉴权 ——
// 否则任意匿名客户端都能订阅全实例的执行事件流（跨工作流数据泄露）。
export async function pushSubscribeHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!(await isAuthed(c))) {
    return c.json({ code: 401, message: 'Unauthorized', data: undefined }, 401);
  }
  const id = c.env.PUSH.idFromName(ROUTE);
  const stub = c.env.PUSH.get(id);
  return stub.fetch(new Request('https://do/push', { headers: c.req.raw.headers }));
}