// tests/helpers/env.ts
// 构造测试用 Env：真实 SQLite 支撑的 D1 + 内存 KV + 可观测的 PUSH/FLOW_ENGINE 桩。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createD1, type FakeD1 } from './d1';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const SCHEMA_SQL = readFileSync(resolve(REPO_ROOT, 'schema.sql'), 'utf8');

export const TEST_PASSWORD = 'test-admin-password';
export const TEST_SECRET = 'test-session-secret';
export const TEST_EMAIL = 'admin@example.com';

// 内存 KV：实现项目用到的 get(key[, type]) / put / delete
class MemoryKV {
  private readonly map = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    if (type === 'json') {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(): Promise<{ keys: { name: string }[] }> {
    return { keys: [...this.map.keys()].map((name) => ({ name })) };
  }
}

export interface TestEnv {
  db: FakeD1;
  env: Record<string, unknown>;
  // 记录引擎侧调用，便于断言「是否真的提交了执行」
  flowCreateCalls: Array<{ id: string; params: Record<string, unknown> }>;
  pushEvents: Array<Record<string, unknown>>;
}

export function makeEnv(): TestEnv {
  const db = createD1(SCHEMA_SQL);
  const flowCreateCalls: TestEnv['flowCreateCalls'] = [];
  const pushEvents: TestEnv['pushEvents'] = [];

  const pushStub = {
    fetch: async (_url: string, init?: { body?: string }) => {
      if (init?.body) {
        try {
          pushEvents.push(JSON.parse(init.body));
        } catch {
          /* ignore */
        }
      }
      return new Response('ok');
    },
  };

  const env = {
    DB: db as unknown as D1Database,
    CREDENTIALS: new MemoryKV() as unknown as KVNamespace,
    FLOW_ENGINE: {
      create: async (opts: { id: string; params: Record<string, unknown> }) => {
        flowCreateCalls.push(opts);
        return { id: opts.id };
      },
    } as unknown as Workflow,
    PUSH: {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => pushStub,
    } as unknown as DurableObjectNamespace,
    SESSION_SECRET: TEST_SECRET,
    ADMIN_PASSWORD: TEST_PASSWORD,
  };

  return { db, env, flowCreateCalls, pushEvents };
}

// 登录并返回可复用的 Cookie 头（走真实 /rest/login，从而同时覆盖登录逻辑本身）
export async function loginCookie(
  app: { request: (p: string, i?: RequestInit, env?: unknown) => Promise<Response> },
  env: unknown,
): Promise<string> {
  const res = await app.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  }, env);
  if (res.status !== 200) throw new Error(`login failed in test setup: HTTP ${res.status}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = /n8n-auth=([^;]+)/.exec(setCookie);
  if (!m) throw new Error('login did not return n8n-auth cookie');
  return `n8n-auth=${m[1]}`;
}

export function jsonRequest(body: unknown, extra: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  };
}
