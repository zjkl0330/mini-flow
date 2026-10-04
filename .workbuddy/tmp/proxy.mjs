// 无侵入采集代理：8789 -> 8788，记录所有 /rest 请求的方法/路径/状态。
// 只读观测，不改任何被跟踪文件。
import http from 'node:http';

const TARGET_PORT = Number(process.env.TARGET_PORT || 8788);
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8789);
const TARGET_HOST = '127.0.0.1';
const log = [];

function handle(req, res) {
  if (req.url === '/__log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(log));
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` };
    const up = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers }, (upRes) => {
      const isRest = (req.url || '').startsWith('/rest');
      const resChunks = [];
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.on('data', (c) => { resChunks.push(c); res.write(c); });
      upRes.on('end', () => {
        res.end();
        if (isRest) {
          const code = upRes.statusCode || 0;
          const preview = code >= 400
            ? ' :: ' + Buffer.concat(resChunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 150)
            : '';
          log.push(`${code} ${req.method} ${req.url}${preview}`);
        }
      });
    });
    up.on('error', (e) => { try { res.writeHead(502); res.end('proxy error: ' + e.message); } catch {} });
    if (body.length) up.write(body);
    up.end();
  });
}

http.createServer(handle).listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`proxy ${LISTEN_PORT} -> ${TARGET_PORT} ready`);
});
