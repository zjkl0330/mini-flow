// 一次性取证脚本：清点节点参数 schema 空缺、REST 端点覆盖情况。
// 仅用于交付前摸底，不属于产品代码。
import { restApi } from '../../src/n8n/router';
import { makeEnv, loginCookie } from '../../tests/helpers/env';

const { env } = makeEnv();
const cookie = await loginCookie(restApi as never, env);

async function get(path: string) {
  const res = await restApi.request(path, { headers: { Cookie: cookie } }, env as never);
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 120); }
  return { status: res.status, body };
}

const nt = await get('/node-types');
const defs: any[] = nt.body?.data ?? [];
const empty = defs.filter((d) => !Array.isArray(d.properties) || d.properties.length === 0);
const hasProps = defs.filter((d) => Array.isArray(d.properties) && d.properties.length > 0);

console.log('=== node-types ===');
console.log('status', nt.status, 'total', defs.length);
console.log('有参数的节点:', hasProps.length, '/', defs.length);
console.log('无参数(properties 为空)的节点:', empty.length);
console.log('无参数节点清单:');
for (const d of empty) console.log('  -', d.name, '|', d.displayName);

console.log();
console.log('=== 端点覆盖探测（带 cookie）===');
const probes = [
  'GET /insights/summary',
  'GET /insights/by-workflow',
  'GET /tags',
  'POST /tags',
  'GET /variables',
  'GET /community-nodes',
  'GET /executions',
  'GET /workflows',
  'GET /active-workflows',
  'GET /users',
  'GET /projects',
];
for (const p of probes) {
  const [m, path] = p.split(' ');
  const res = await restApi.request(path, { method: m, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined }, env as never);
  console.log(`  ${p.padEnd(28)} -> ${res.status}`);
}

console.log();
console.log('=== 未认证访问（无 cookie）===');
for (const p of ['/settings', '/sso', '/module-settings', '/workflows', '/executions', '/credentials', '/users', '/node-types', '/insights/summary']) {
  const res = await restApi.request(p, {}, env as never);
  console.log(`  ${p.padEnd(24)} -> ${res.status}`);
}
