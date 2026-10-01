// tests/helpers/cf-workers-stub.mjs
// 测试专用：node:test 环境无法解析 `cloudflare:workers`，用最小桩替代，
// 使 tests 能 import 真实 src/index.ts 以校验 Worker 装配（注册顺序等）。
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class WorkflowEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export class WorkflowStep {}
export class WorkerEntrypoint {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export default {};
