// 逐条核验剩余 404 的语义（区分「端点缺失」与「资源不存在」）
import http from 'node:http';

const BASE = 'http://127.0.0.1:8788';
const PWD = 'mini-flow-local-dev-password';

function req(method, path, cookie, body) {
  return new Promise((resolve) => {
    const u = new URL(BASE + path);
    const r = http.request({
      host: u.hostname, port: u.port, method, path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    }, (res) => {
      let s = ''; res.on('data', (c) => s += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s }));
    });
    r.on('error', (e) => resolve({ status: -1, body: String(e) }));
    if (body) r.write(body);
    r.end();
  });
}

const login = await req('POST', '/rest/login', '', JSON.stringify({ emailOrLdapLoginId: 'admin@example.com', password: PWD }));
const cookie = (login.headers['set-cookie']?.[0] ?? '').split(';')[0];

const specs = ['GET /workflows/probe123', 'GET /credentials/probe123', 'GET /projects/probe123', 'GET /roles/probe123',
  'PATCH /credentials/probe123', 'PATCH /variables/probe123', 'PATCH /executions/probe123',
  'POST /executions/probe123/stop', 'POST /executions/probe123/retry', 'GET /users/probe123',
  'GET /workflows/probe123', 'GET /executions/probe123'];

for (const spec of specs) {
  const i = spec.indexOf(' ');
  const method = spec.slice(0, i), path = spec.slice(i + 1);
  const r = await req(method, '/rest' + path, cookie, method === 'GET' || method === 'DELETE' ? undefined : '{}');
  let msg = '';
  try { msg = JSON.parse(r.body).message ?? ''; } catch { msg = r.body.slice(0, 60); }
  const isFallback = /^Not found: [A-Z]+ \/rest\//.test(msg);
  console.log(`${r.status}  ${spec.padEnd(38)} ${isFallback ? '❌ 端点缺失' : '✅ 资源级'}  ${msg.slice(0, 70)}`);
}
