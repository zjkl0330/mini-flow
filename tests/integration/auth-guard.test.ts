// tests/integration/auth-guard.test.ts
// SEC-1：生产默认拒绝（fail-closed）的凭据守卫。
//
// 背景（审计 P0）：收口前 src/n8n/auth.ts 用 `env.ADMIN_PASSWORD || DEV_FALLBACK_PWD`
// 无条件回退，导致「公开的默认口令即可登录 owner」——线上实例实测默认口令可登。
// 本文件锁定收口后的行为：
//   * 回退口令只在 ENVIRONMENT 显式为 development/dev/local 时生效；
//   * 其余情况一律失败关闭（/rest/login 503、受保护路由 401）；
//   * 判定只看环境变量，不看请求 Host，伪造 `Host: localhost` 不能绕过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restApi } from '../../src/n8n/router';
import { resolveCredentials } from '../../src/n8n/auth';
import { makeEnv, TEST_EMAIL, TEST_PASSWORD } from '../helpers/env';

const DEV_PWD = 'mini-flow-demo-password';
const PROD_URL = 'https://n8n.example.org/login';

type EnvLike = Record<string, unknown>;

// 派生「未配置任何凭据」的环境
function unconfigured(base: EnvLike, environment?: string): EnvLike {
  const env: EnvLike = { ...base };
  delete env.ADMIN_PASSWORD;
  delete env.SESSION_SECRET;
  if (environment !== undefined) env.ENVIRONMENT = environment;
  return env;
}

const postLogin = (
  env: EnvLike,
  password: string,
  url = '/login',
  extra: Record<string, string> = {},
) => restApi.request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify({ email: TEST_EMAIL, password }),
}, env as never);

const cookieOf = (res: Response): string => {
  const m = /n8n-auth=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  assert.ok(m, '登录响应应带 n8n-auth Cookie');
  return `n8n-auth=${m![1]}`;
};

test('SEC-1：生产（未声明 ENVIRONMENT）未配 Secret → 503，默认口令绝不能登入', async () => {
  const { env } = makeEnv();
  const e = unconfigured(env);

  const res = await postLogin(e, DEV_PWD, PROD_URL);
  assert.equal(res.status, 503, '公开的默认口令不得在生产登入');
  const body = await res.json() as { code: number; message: string };
  assert.equal(body.code, 503);
  assert.match(body.message, /ADMIN_PASSWORD/, '503 应给出可执行的修复指引');
  assert.equal(res.headers.get('set-cookie'), null, '未配置时不得下发会话 Cookie');
});

test('SEC-1：未配置凭据时受保护路由一律 401（失败关闭）', async () => {
  const { env } = makeEnv();
  const e = unconfigured(env);
  for (const p of ['/owner', '/workflows', '/credentials', '/tags']) {
    const res = await restApi.request(p, {}, e as never);
    assert.equal(res.status, 401, `${p} 在未配置凭据时应 401`);
  }
});

test('SEC-1：伪造 Host: localhost 不能绕过（判定只看环境变量）', async () => {
  const { env } = makeEnv();
  const e = unconfigured(env);

  // 绝对生产 URL + 伪造 Host 头
  assert.equal((await postLogin(e, DEV_PWD, PROD_URL, { Host: 'localhost' })).status, 503);
  // 直接用回环地址请求，但未声明开发环境 → 同样不得回退
  assert.equal((await postLogin(e, DEV_PWD, 'http://localhost/login')).status, 503);
});

test('SEC-1：ENVIRONMENT=development 时回退口令生效，且签发的会话可用', async () => {
  const { env } = makeEnv();
  const e = unconfigured(env, 'development');

  const res = await postLogin(e, DEV_PWD, 'http://localhost/login');
  assert.equal(res.status, 200, '本地调试路径必须仍然可用');
  const cookie = cookieOf(res);

  const authed = await restApi.request('/owner', { headers: { Cookie: cookie } }, e as never);
  assert.equal(authed.status, 200);
  const owner = await authed.json() as { data: { email: string } };
  assert.equal(owner.data.email, TEST_EMAIL);
});

test('SEC-1：显式 ENVIRONMENT=production 即便在开发环境也不回退', async () => {
  const { env } = makeEnv();
  const e = unconfigured(env, 'production');
  assert.equal((await postLogin(e, DEV_PWD, 'http://localhost/login')).status, 503);
});

test('SEC-1：配置达标凭据后 production 正常登录（唯一正确路径）', async () => {
  const { env } = makeEnv(); // 已配 TEST_PASSWORD(19 位) / TEST_SECRET(19 位)
  const e: EnvLike = { ...env, ENVIRONMENT: 'production' };

  const res = await postLogin(e, TEST_PASSWORD, PROD_URL);
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  assert.equal(
    (await restApi.request('/owner', { headers: { Cookie: cookie } }, e as never)).status,
    200,
  );
  // 错误口令仍 401（不泄露账号是否存在）
  assert.equal((await postLogin(e, 'wrong-password-xyz', PROD_URL)).status, 401);
});

test('SEC-1：弱凭据（口令<8 或 密钥<16）视为未配置 → 503，不得放行', async () => {
  const { env } = makeEnv();

  const weakPwd: EnvLike = { ...env, ADMIN_PASSWORD: 'short', SESSION_SECRET: 'x'.repeat(24) };
  assert.equal((await postLogin(weakPwd, 'short', PROD_URL)).status, 503);

  const weakSecret: EnvLike = { ...env, ADMIN_PASSWORD: 'long-enough-password', SESSION_SECRET: 'short' };
  assert.equal((await postLogin(weakSecret, 'long-enough-password', PROD_URL)).status, 503);
});

test('SEC-1：resolveCredentials 判定矩阵（守卫本身的反向验证）', () => {
  assert.equal(resolveCredentials({} as never), null, '无任何配置 → 拒绝');
  assert.equal(resolveCredentials({ ENVIRONMENT: 'production' } as never), null);
  assert.equal(resolveCredentials({ ENVIRONMENT: 'staging' } as never), null, '未知环境 → 拒绝');

  const dev = resolveCredentials({ ENVIRONMENT: 'development' } as never);
  assert.equal(dev?.usingFallback, true);
  assert.equal(dev?.password, DEV_PWD);

  const prod = resolveCredentials({
    ADMIN_PASSWORD: 'a'.repeat(8), SESSION_SECRET: 'b'.repeat(16),
  } as never);
  assert.equal(prod?.usingFallback, false);
  assert.equal(prod?.password, 'a'.repeat(8));
});
