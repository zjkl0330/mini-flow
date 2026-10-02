// http-request 节点执行器
import type { NodeExecutionContext } from '../types';
import { safeEvaluate } from '../engine/evaluator';

export const httpRequestNode = {
  async execute(ctx: NodeExecutionContext) {
    const p = ctx.node.parameters;
    const method = (p.method ?? 'GET') as string;
    const urlTemplate = String(p.url ?? '');

    // 取当前输入项（n8n: items 数组首个 json）
    const item = ctx.inputData?.main?.[0]?.json ?? {};

    // 支持 {{ $json.foo }} / {{ foo }} 插值
    const url = interpolate(urlTemplate, item);
    const headers: Record<string, string> = {};
    if (p.headerParameters) {
      for (const h of p.headerParameters.parameters ?? []) {
        headers[String(h.name)] = interpValue(h.value, item);
      }
    }

    const body = p.sendBody === true || (p.method && p.method !== 'GET') ? JSON.stringify(fillBody(p, item)) : undefined;

    // P1-5: 网络层错误必须显式抛错（DNS 失败/连接被拒/超时）
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`HTTP 请求失败: ${method} ${url} → ${msg}`);
    }

    // REQ-11: 非 2xx 默认抛错（对齐 n8n）。
    // 逃生开关: ignoreHttpStatusErrors=true 或 alwaysFailOnError=false
    const ignoreErrors = p.ignoreHttpStatusErrors === true || p.options?.ignoreHttpStatusErrors === true;
    const alwaysFail = p.options?.alwaysFailOnError === true || p.alwaysFailOnError === true;
    
    // 默认行为翻转：默认对非 2xx 抛错，除非显式开启 ignore 或明确关闭 alwaysFail
    const shouldFailOnError = !ignoreErrors && !res.ok;
    if (shouldFailOnError) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${res.statusText || ''}: ${text.slice(0, 400)}`);
    }

    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }

    // n8n 兼容输出
    const base = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
    return {
      main: [{
        json: {
          ...base,
          statusCode: res.status,
          body: parsed,
          json: parsed,
          headers: Object.fromEntries(res.headers.entries()),
        },
      }],
    };
  },
};

export function interpValue(value: unknown, item: Record<string, any>): string {
  if (typeof value !== 'string') return String(value ?? '');
  return interpolate(value, item);
}

export function interpolate(template: string, item: Record<string, any>): string {
  return template.replace(/\{\{\s*\$?json\.([\w.]+)\s*\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_m, a: string, b: string) => {
    const path = (a ?? b).split('.');
    const v = path.reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), item);
    return v === undefined || v === null ? '' : String(v);
  });
}

function fillBody(p: Record<string, any>, item: Record<string, any>): unknown {
  if (p.jsonBody !== undefined) {
    return JSON.parse(interpolate(JSON.stringify(p.jsonBody), item));
  }
  if (p.bodyParameters) {
    const out: Record<string, string> = {};
    for (const b of p.bodyParameters.parameters ?? []) out[String(b.name)] = interpValue(b.value, item);
    return out;
  }
  return {};
}
