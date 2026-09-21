// 受限表达式求值器（替代 n8n Function 节点的 new Function）
// Cloudflare Workers 由 CSP 硬性禁用 eval() / new Function，因此用
// 白名单 token 分词器 + 递归下降求值器 实现安全表达式求值。
//
// 支持:
//   - 字面量：数字 / 字符串 / 布尔 / null / 数组 / 对象（含展开 ...obj）
//   - 引用：json.foo / $json.foo / env / 裸字段名 / 任意点链 (a.b.c)
//   - 运算：算术 / 比较(== != > >= < <=) / 逻辑(&& || !) / 三目 / 括号
//   - n8n 输入语义：items、$input.all()/first()/last()、$now、env
//   - 箭头函数：x => expr、(...args) => expr（表达式体；用于 .map/.filter/...）
//   - 成员方法（白名单）：map / filter / reduce / forEach / find / join / slice 等
// 内置函数库见 BUILTIN_FUNCTIONS（均为可恢复 / 确定性实现）。

import type { EvalContext } from '../types';

export class EvalSyntaxError extends Error {
  constructor(msg: string) {
    super(`[eval] ${msg}`);
    this.name = 'EvalSyntaxError';
  }
}

// ---------- 分词器 ----------
type TokenType =
  | 'number' | 'string' | 'ident' | 'op' | 'lparen' | 'rparen'
  | 'comma' | 'lbrace' | 'rbrace' | 'lbracket' | 'rbracket' | 'dot';

interface Token {
  type: TokenType;
  value: string;
}

// 三目/二元运算符 + 箭头(=>) + 展开(...)
const SYMBOLS = new Set([
  '...', '===', '!==', '==', '!=', '>=', '<=', '&&', '||', '=>',
  '>', '<', '+', '-', '*', '/', '!', '?', ':',
]);
const SINGLE = new Set(['(', ')', ',', '{', '}', '[', ']', '.']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch; let j = i + 1; let out = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) { out += src[j + 1]; j += 2; continue; }
        out += src[j]; j++;
      }
      if (j >= n) throw new EvalSyntaxError('未闭合的字符串');
      tokens.push({ type: 'string', value: out });
      i = j + 1; continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[\d.]/.test(src[j])) j++;
      tokens.push({ type: 'number', value: src.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      tokens.push({ type: 'ident', value: src.slice(i, j) });
      i = j; continue;
    }
    const three = src.slice(i, i + 3);
    if (SYMBOLS.has(three)) { tokens.push({ type: 'op', value: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (SYMBOLS.has(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if (SYMBOLS.has(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (SINGLE.has(ch)) {
      const map: Record<string, TokenType> = { '(': 'lparen', ')': 'rparen', ',': 'comma', '{': 'lbrace', '}': 'rbrace', '[': 'lbracket', ']': 'rbracket', '.': 'dot' };
      tokens.push({ type: map[ch], value: ch });
      i++; continue;
    }
    throw new EvalSyntaxError(`无法识别的字符: ${ch}`);
  }
  return tokens;
}

// 成员方法白名单：仅这些数组/字符串/内置对象方法可被调用。
// 逐字节的 token 化 + 白名单，确保无法通过方法访问原型链逃逸（如 .constructor）。
const SAFE_METHODS = new Set<string>([
  'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
  'join', 'slice', 'includes', 'indexOf', 'concat', 'split',
  'toUpperCase', 'toLowerCase', 'trim', 'toString',
  // $input 门面方法
  'all', 'first', 'last',
]);

// ---------- 递归下降解析器 / 求值器 ----------
class Parser {
  private pos = 0;
  constructor(
    private tokens: Token[],
    private ctx: EvalContext,
    // 作用域栈：箭头函数参数绑定（从内到外查找，最后一项最内层）
    private scopes: Array<Record<string, unknown>> = [],
  ) {}

  parse(): unknown {
    const v = this.ternary();
    if (this.pos < this.tokens.length) throw new EvalSyntaxError('意外的多余输入');
    return v;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new EvalSyntaxError(`期望 ${type}，得到 ${t.type}(${t.value})`);
    return t;
  }
  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return !!t && t.type === 'op' && ops.includes(t.value);
  }

  // a ? b : c  （条件三元）
  private ternary(): unknown {
    const cond = this.logicalOr();
    if (this.peek()?.type === 'op' && this.peek()?.value === '?') {
      this.next();
      const a = this.ternary();
      const t = this.next();
      if (t.type !== 'op' || t.value !== ':') throw new EvalSyntaxError('三元表达式缺少冒号');
      const b = this.ternary();
      return cond ? a : b;
    }
    return cond;
  }

  private logicalOr(): unknown {
    let l = this.logicalAnd();
    while (this.isOp('||')) { this.next(); const r = this.logicalAnd(); l = Boolean(l) || Boolean(r); }
    return l;
  }
  private logicalAnd(): unknown {
    let l = this.equality();
    while (this.isOp('&&')) { this.next(); const r = this.equality(); l = Boolean(l) && Boolean(r); }
    return l;
  }
  private equality(): unknown {
    let l = this.comparison();
    while (this.isOp('==', '!=', '===', '!==')) {
      const op = this.next().value;
      const r = this.comparison();
      // === / !== 视作与 == / != 相同的宽松等价（数字与数字字符串互通）
      l = op === '===' || op === '==' ? looseEq(l, r) : !looseEq(l, r);
    }
    return l;
  }
  private comparison(): unknown {
    let l = this.additive();
    while (this.isOp('>', '>=', '<', '<=')) {
      const op = this.next().value;
      const r = this.additive();
      const a = Number(l), b = Number(r);
      l = op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : a <= b;
    }
    return l;
  }
  private additive(): unknown {
    let l = this.multiplicative();
    while (this.isOp('+', '-')) {
      const op = this.next().value;
      const r = this.multiplicative();
      l = applyAdditive(op, l, r);
    }
    return l;
  }
  private multiplicative(): unknown {
    let l = this.unary();
    while (this.isOp('*', '/')) {
      const op = this.next().value;
      const r = this.unary();
      l = op === '*' ? Number(l) * Number(r) : Number(l) / Number(r);
    }
    return l;
  }
  private unary(): unknown {
    if (this.isOp('!')) { this.next(); return !this.unary(); }
    if (this.isOp('-')) { this.next(); return -Number(this.unary()); }
    return this.primary();
  }
  private primary(): unknown {
    const t = this.next();
    switch (t.type) {
      case 'number': return Number(t.value);
      case 'string': return t.value;
      case 'ident':
        // 单参箭头： x => expr
        if (this.isOp('=>')) return this.arrow([t.value]);
        if (this.peek()?.type === 'lparen') return this.call(t.value);
        return this.primaryIdent(t.value);
      case 'lparen': {
        // (a, b) => expr 或多参/零参箭头
        const params = this.matchArrowParams();
        if (params) return this.arrow(params);
        const v = this.ternary(); this.expect('rparen'); return this.chain(v);
      }
      case 'lbracket': {
        const arr: unknown[] = [];
        if (this.peek()?.type !== 'rbracket') {
          arr.push(this.ternary());
          while (this.peek()?.type === 'comma') { this.next(); arr.push(this.ternary()); }
        }
        this.expect('rbracket');
        return this.chain(arr);
      }
      case 'lbrace': return this.objectLiteral();
      case 'dot': { const prop = this.next(); if (prop.type !== 'ident') throw new EvalSyntaxError('点号后需为字段名'); return getPath(this.ctx, [prop.value]); }
      default: throw new EvalSyntaxError(`意外的 token: ${t.value}`);
    }
  }

  // 对象字面量：{ a: 1, b: 2, ...spread }
  private objectLiteral(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    if (this.peek()?.type !== 'rbrace') {
      while (true) {
        const t = this.peek();
        if (t?.type === 'op' && t.value === '...') {
          // 展开：把来源对象的可枚举属性浅拷贝进本次对象
          this.next();
          const src = this.ternary();
          if (src && typeof src === 'object' && !Array.isArray(src)) Object.assign(obj, src);
          else if (Array.isArray(src)) Object.assign(obj, { ...src });
        } else {
          const k = this.next();
          const key = k.type === 'string' ? k.value : k.type === 'ident' ? k.value : '';
          if (!key) throw new EvalSyntaxError('非法的对象键');
          const colon = this.next();
          if (colon.type !== 'op' || colon.value !== ':') throw new EvalSyntaxError('对象缺少冒号');
          obj[key] = this.ternary();
        }
        if (this.peek()?.type === 'comma') { this.next(); continue; }
        break;
      }
    }
    this.expect('rbrace');
    return obj;
  }

  // 函数调用：name(arg, ...)，name 来自内置函数白名单
  private call(name: string): unknown {
    const args = this.parseArgs();
    const fn = lookupFunction(name);
    if (!fn) throw new EvalSyntaxError(`未知函数: ${name}`);
    return fn(args, this.ctx);
  }

  private parseArgs(): unknown[] {
    this.expect('lparen');
    const args: unknown[] = [];
    if (this.peek()?.type !== 'rparen') {
      args.push(this.ternary());
      while (this.peek()?.type === 'comma') { this.next(); args.push(this.ternary()); }
    }
    this.expect('rparen');
    return args;
  }

  // 判定从当前 pos 起是否构成箭头函数的参数表 `( (ident,)* ) =>`；
  // 是则消费到 `=>` 之后并返回参数名，否则不移动 pos 并返回 null。
  private matchArrowParams(): string[] | null {
    const start = this.pos;
    const params: string[] = [];
    let i = start;
    // 零参：() =>
    if (this.tokens[i]?.type === 'rparen'
      && this.tokens[i + 1]?.type === 'op' && this.tokens[i + 1].value === '=>') {
      this.pos = i + 2;
      return params;
    }
    for (;;) {
      const tok = this.tokens[i];
      if (!tok || tok.type !== 'ident') { this.pos = start; return null; }
      params.push(tok.value);
      i++;
      const sep = this.tokens[i];
      if (sep?.type === 'comma') { i++; continue; }
      if (sep?.type === 'rparen'
        && this.tokens[i + 1]?.type === 'op' && this.tokens[i + 1].value === '=>') {
        this.pos = i + 2;
        return params;
      }
      this.pos = start;
      return null;
    }
  }

  // 箭头函数：捕获函数体 token 范围，延迟到调用时以「参数作用域」重新解析。
  // 仅支持表达式体（含 `( { ... } )` 形式的对象体）。函数体形如 `{ stmt; }` 的块体
  // 不会被 `;` 分词，会在解析时报「意外的 token」，从而显式失败（不静默）。
  private arrow(params: string[]): (...args: unknown[]) => unknown {
    // 单参形态 `x =>`：此处尚未消费箭头符号；多参形态已由 matchArrowParams 消费。
    if (this.isOp('=>')) this.next();
    const end = this.scanBodyEnd();
    const bodyTokens = this.tokens.slice(this.pos, end);
    this.pos = end;
    if (bodyTokens.length === 0) throw new EvalSyntaxError('箭头函数缺少函数体');
    const capturedCtx = this.ctx;
    const capturedScopes = this.scopes.slice();
    return (...args: unknown[]) => {
      const binding: Record<string, unknown> = {};
      params.forEach((p, idx) => { binding[p] = args[idx]; });
      const sub = new Parser(bodyTokens, capturedCtx, [...capturedScopes, binding]);
      return sub.parse();
    };
  }

  // 扫描函数体结束位置（相对 token 深度）：遇到深度 0 的 , ) ] } 即结束。
  private scanBodyEnd(): number {
    let depth = 0;
    let i = this.pos;
    while (i < this.tokens.length) {
      const t = this.tokens[i];
      if (t.type === 'lparen' || t.type === 'lbracket' || t.type === 'lbrace') depth++;
      else if (t.type === 'rparen' || t.type === 'rbracket' || t.type === 'rbrace') {
        if (depth === 0) break;
        depth--;
      } else if (t.type === 'comma' && depth === 0) break;
      i++;
    }
    return i;
  }

  // 从上下文取值：作用域（箭头参数）→ 内置变量 → 裸字段名（支持点链访问）
  private lookup(name: string): unknown {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (Object.prototype.hasOwnProperty.call(this.scopes[i], name)) return this.scopes[i][name];
    }
    if (name === 'json' || name === '$json') return this.ctx.json;
    if (name === 'env' || name === '$env') return this.ctx.env;
    // items / $input 仅在调用方显式提供 items 时暴露，避免遮蔽同名用户字段（回归防护）
    if (name === 'items' && this.ctx.items !== undefined) return this.ctx.items;
    if (name === '$input' && this.ctx.items !== undefined) return this.inputFacade();
    if (name === '$now') return this.ctx.$now ?? new Date().toISOString();
    // 字面量关键字：不支持会把 `true` 当成字段名取到 undefined，
    // 直接导致 IF 的 `conditionSt: "true"` 恒为假（条件分支失效）。
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    if (name === 'undefined') return undefined;
    // 裸字段名 → 从当前 json 项取
    return getNested(this.ctx.json, name.split('.'));
  }

  // n8n $input 门面：$input.all() / first() / last() / item
  private inputFacade(): Record<string, unknown> {
    const items = this.ctx.items ?? [];
    return {
      all: () => items,
      first: () => items[0] ?? null,
      last: () => items[items.length - 1] ?? null,
      item: items[0] ?? null,
      json: this.ctx.json,
    };
  }

  // 支持属性链的 primary：$json.args.x / json.a.b / env.k / 裸字段 x.y.z
  private primaryIdent(name: string): unknown {
    return this.chain(this.lookup(name));
  }

  // 链式成员访问与方法调用：x.a.b / arr.map(fn) / $input.first().json / [arr].length
  private chain(base: unknown): unknown {
    let val = base;
    while (this.peek()?.type === 'dot') {
      this.next();
      const prop = this.next();
      if (prop.type !== 'ident') throw new EvalSyntaxError('点号后需为字段名');
      if (this.peek()?.type === 'lparen') {
        val = this.methodCall(val, prop.value);
        continue;
      }
      val = val == null || (typeof val !== 'object' && typeof val !== 'function')
        ? undefined
        : (val as Record<string, unknown>)[prop.value];
    }
    return val;
  }

  private methodCall(receiver: unknown, name: string): unknown {
    const args = this.parseArgs();
    if (!SAFE_METHODS.has(name)) {
      throw new EvalSyntaxError(`不支持的成员方法: .${name}()`);
    }
    // null/undefined 上调用：安全返回 undefined（等价可选链，避免中途抛错污染流程）
    if (receiver == null) return undefined;
    const fn = (receiver as Record<string, unknown>)[name];
    if (typeof fn !== 'function') {
      throw new EvalSyntaxError(`值上不存在方法 .${name}()`);
    }
    return (fn as (...a: unknown[]) => unknown).apply(receiver, args);
  }
}

function oneToken(t: Token): string { return t.type === 'string' ? `'${t.value}'` : t.value; }

function getPath(ctx: EvalContext, parts: string[]): unknown {
  return getNested(ctx.json, parts);
}

function getNested(base: unknown, parts: string[]): unknown {
  let cur = base;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'string' && b !== '' && !isNaN(Number(b))) return a === Number(b);
  return String(a) === String(b);
}

// 真 JS 语义（修复 1+1="11"）：number+number 数值相加；任一操作数为字符串则拼接；
// 其余(null/boolean 等)与减法一致走数值运算，符合 JS ToPrimitive 回落。
function applyAdditive(op: string, l: unknown, r: unknown): unknown {
  if (op === '-') return Number(l) - Number(r);
  if (typeof l === 'number' && typeof r === 'number') return l + r;
  if (typeof l === 'string' || typeof r === 'string') return String(l) + String(r);
  return Number(l) + Number(r);
}

// ---------- 内置函数库（白名单，禁止任意代码） ----------
const BUILTIN_FUNCTIONS: Record<string, (args: unknown[], ctx: EvalContext) => unknown> = {
  round: (a) => Math.round(Number(a[0]) * (10 ** Number(a[1] ?? 0))) / (10 ** Number(a[1] ?? 0)),
  floor: (a) => Math.floor(Number(a[0])),
  ceil: (a) => Math.ceil(Number(a[0])),
  abs: (a) => Math.abs(Number(a[0])),
  max: (a) => Math.max(...a.map(Number)),
  min: (a) => Math.min(...a.map(Number)),
  length: (a) => {
    const v = a[0];
    if (typeof v === 'string') return v.length;
    if (Array.isArray(v)) return v.length;
    return 0;
  },
  upper: (a) => String(a[0]).toUpperCase(),
  lower: (a) => String(a[0]).toLowerCase(),
  trim: (a) => String(a[0]).trim(),
  concat: (a) => a.map(String).join(''),
  toInt: (a) => parseInt(String(a[0]), 10),
  toFloat: (a) => parseFloat(String(a[0])),
  substr: (a) => String(a[0]).substr?.(Number(a[1]), Number(a[2] ?? undefined)),
  dateFormat: (a) => {
    const d = a[0] ? new Date(String(a[0])) : new Date();
    return d.toISOString();
  },
  uppercase: (a) => String(a[0]).toUpperCase(),
};

function lookupFunction(name: string) {
  return BUILTIN_FUNCTIONS[name];
}

// ---------- 公开入口 ----------
export function evaluate(expression: string, ctx: EvalContext): unknown {
  const tokens = tokenize(expression);
  if (tokens.length === 0) return undefined;
  return new Parser(tokens, ctx).parse();
}

export { BUILTIN_FUNCTIONS };

// 捕获一次求值中出现的语法/求值错误，便于节点层统一处理
export function safeEvaluate(expression: string, ctx: EvalContext): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: evaluate(expression, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
