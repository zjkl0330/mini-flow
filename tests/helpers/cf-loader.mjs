// tests/helpers/cf-loader.mjs
// 测试专用 ESM loader：把 `cloudflare:workers` 重定向到本地桩模块，
// 让 tests 可以直接 import 真实 src/index.ts（避免 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers' || specifier.startsWith('cloudflare:')) {
    return { url: new URL('./cf-workers-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
