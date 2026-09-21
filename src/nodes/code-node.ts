// code-node: Code / Function 节点执行器（受限求值）
// Workers CSP 禁用 new Function，故把 n8n Code 节点的任意 JS 降级为受限表达式求值器
// (safeEvaluate)：以「表达式 + 受限语句」的方式安全执行用户提供的代码。
//
// 语义对齐 n8n：
//   - 暴露 n8n 输入语义：items（全部输入项）、$json、$input.all()/first()/last()、$now、env。
//   - 代码引用 items / $input 时，按「整批输入」执行一次（n8n 语义）；否则按每项执行
//     （兼容历史「逐项变换」行为，如 `upper(name)`）。
//   - 返回数组 → 作为输出项集合（元素形如 { json }）；返回标量 → 作为当前项的 output。
//
// 关键约束（P0 修复）：**失败必须显式**。任何语法/求值错误一律抛出，由引擎将节点标 failed、
// 执行整体标 error。绝不再把错误包装成数据（历史上 `__codeError` 被改写为 `output`，
// 导致节点报成功、执行报成功，而用户拿到的是垃圾数据——静默的数据正确性失败）。
import type { NodeExecutionContext, EvalContext } from '../types';
import { safeEvaluate } from '../engine/evaluator';

type Item = { json: Record<string, any> };

// 提取 Code 节点实际源码：兼容 n8n code/function 常见参数形态
function sourceOf(p: Record<string, any>): string {
  return String(
    p.javascriptCode ?? p.jsCode ?? p.code ?? p.functionCode ?? p.function ?? '',
  );
}

// 判定代码是否真正引用了内置变量 `items` / `$input`（用于决定「整批执行」还是「逐项变换」）。
//
// 反例（都不是内置引用，必须判为 false，否则会静默丢项）：
//   - 成员访问：`json.items` / `foo.$input`
//   - 字符串内容：`'has items here'`
//   - 对象键位置：`{ items: 1 }` / `{ a: 1, items: 2 }`
// 正例：`items`、`items.map(...)`、`$input.all()`、`{ v: items }`
//
// 实现：逐字符扫描（跳过字符串字面量），识别标识符 token，再按前一个有效字符排除成员访问，
// 按「键位置（前为 { 或 , 且后为 :）」排除对象键。
function usesBuiltinItems(code: string): boolean {
  const n = code.length;
  let i = 0;
  let prevSig = '';
  while (i < n) {
    const ch = code[i];
    // 跳过字符串字面量（整体视作一个值，内部文本不参与标识符判定）
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') i++;
        i++;
      }
      i++; // 跳过结尾引号
      prevSig = q;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(code[j])) j++;
      const ident = code.slice(i, j);
      if (ident === 'items' || ident === '$input') {
        const isMember = prevSig === '.'; // json.items / foo.$input
        const isObjKey = (prevSig === '{' || prevSig === ',') && nextSignificant(code, j) === ':';
        if (!isMember && !isObjKey) return true;
      }
      prevSig = ident;
      i = j;
      continue;
    }
    // 展开运算符 `...` 不是成员访问：显式消费，避免紧随其后的标识符被误判为成员访问
    // （否则 `{ ...$input.first().json }`、`{ ...items }` 会被误判为非内置引用）。
    if (ch === '.' && code.startsWith('...', i)) { prevSig = '...'; i += 3; continue; }
    prevSig = ch;
    i++;
  }
  return false;
}

// 从 from 起跳过空白，返回下一个有效字符（无则空串）
function nextSignificant(s: string, from: number): string {
  let k = from;
  while (k < s.length && /\s/.test(s[k])) k++;
  return s[k] ?? '';
}

export const codeNode = {
  async execute(ctx: NodeExecutionContext) {
    const code = sourceOf(ctx.node.parameters).trim();

    // 无源码 → 原样透传（作为 no-op）
    if (!code) {
      return { main: [...(ctx.inputData?.main ?? [])] };
    }

    const inputs: Item[] = ctx.inputData?.main ?? [];
    const env = (ctx.env ?? {}) as Record<string, any>;
    const nowIso = new Date().toISOString();

    const makeCtx = (json: Record<string, any>): EvalContext => ({
      json,
      env,
      $now: nowIso,
      items: inputs,
    });

    // n8n 输入语义：仅在代码**真正引用内置变量** `items` / `$input` 时按「整批输入」执行一次。
    // 注意：不能用裸子串/宽正则判定——`json.items`（成员访问）、`'...items...'`（字符串）、
    // `{ items: 1 }`（对象键）都不是对内置变量的引用；误判会切到整批模式而**静默丢项**
    // （N 个输入只保留 1 项 / 只按首项处理）。
    if (usesBuiltinItems(code)) {
      const result = runCode(code, makeCtx(inputs[0]?.json ?? {}));
      return { main: normalizeBatchResult(result, inputs) };
    }

    // 无输入项：仍按单次执行（如纯构造类代码）
    if (inputs.length === 0) {
      const result = runCode(code, makeCtx({}));
      return { main: normalizeBatchResult(result, []) };
    }

    // 历史「逐项变换」语义：对每个输入项独立求值；若返回「数据项数组」则展开为多个 item。
    const outputs = inputs.flatMap(({ json }) => applyToItem(code, makeCtx(json)));
    return { main: outputs };
  },
};

// 处理单个输入项（逐项变换语义），可产出 0..N 个输出项：
//  - 返回「数据项数组」(元素形如 { json }) → 展开为多个 item（n8n 语义）：
//      `return [{json:{a:1}},{json:{a:2}}]` → 2 项
//  - 返回普通值数组（如 [1,2]）→ 维持历史：并入当前项的 output
//  - 返回对象（非数组）：并入当前项（若为 n8n item 形态 { json } 则直接取 json）
//  - 返回标量：并入当前项，值置于 output 键
//  - 未返回（undefined）：原样透传当前项
//
// 注意：只对「数据项数组」展开，是为了兼顾两点——(a) n8n 语义「返回 items 数组即多项输出」；
// (b) 不破坏既有「字段数组值」用例（如 `return json.items;` 得到 [1,2] 时仍并入 output）。
function applyToItem(code: string, ctx: EvalContext): Item[] {
  const item = ctx.json ?? {};
  const result = runCode(code, ctx);
  if (result === undefined) return [{ json: item }];

  if (Array.isArray(result)) {
    // 空数组 [] 的 every() 恒为 true（vacuous truth），必须显式排除：否则会被误判为
    // 「数据项数组」→ 展开为 0 项、**丢失全部输入**。空数组按普通值数组处理（并入 output）。
    if (result.length > 0 && result.every(isItemShape)) return result.map(toItem);
    return [{ json: { ...item, output: result } }];
  }

  if (isPlainObject(result)) {
    if (isItemShape(result)) return [{ json: result.json as Record<string, any> }];
    return [{ json: { ...item, ...(result as Record<string, any>) } }];
  }

  return [{ json: { ...item, output: result } }];
}

// n8n 数据项形态：对象且含 json 子对象（{ json: {...} }）
function isItemShape(v: unknown): v is { json: Record<string, any> } {
  return isPlainObject(v) && 'json' in v && isPlainObject((v as Record<string, unknown>).json);
}

// 整批执行结果归一化（n8n 语义）：
//  - 数组 → 输出项集合（元素为 { json } 直接用，否则包裹）
//  - { json } → 单输出项
//  - undefined/null（如仅 forEach） → 透传输入
//  - 其余标量/对象 → 单输出项 { json: { output: 值 } }
function normalizeBatchResult(result: unknown, fallback: Item[]): Item[] {
  if (Array.isArray(result)) return result.map(toItem);
  if (result === undefined || result === null) return fallback;
  if (isPlainObject(result) && 'json' in (result as Record<string, unknown>)) {
    return [{ json: (result as { json: Record<string, any> }).json }];
  }
  return [{ json: { output: result } }];
}

function toItem(el: unknown): Item {
  if (isPlainObject(el) && 'json' in (el as Record<string, unknown>)) {
    return { json: (el as { json: Record<string, any> }).json };
  }
  if (isPlainObject(el)) return { json: el as Record<string, any> };
  return { json: { output: el } };
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// 受限语句执行：支持 `const/let/var x = expr` 声明、`return expr` 与独立表达式，
// 语句以「顶层 ;」分隔（括号/引号内的 ; 不分割）。
// 声明的变量注入后续语句的求值上下文（与既有实现一致：以字段方式可见）。
function runCode(code: string, ctx: EvalContext): unknown {
  const statements = splitTopLevel(code);
  const isSingleExpr = statements.length === 1
    && !/^\s*(?:return|const|let|var)\b/.test(statements[0]);

  if (isSingleExpr) return evalOrThrow(statements[0], ctx);

  const scope: Record<string, unknown> = {};
  let last: unknown = undefined;
  for (const raw of statements) {
    const s = raw.trim();
    if (!s) continue;
    if (/^return\b/.test(s)) {
      const expr = s.replace(/^return\b/, '').trim();
      return expr ? evalOrThrow(expr, withScope(ctx, scope)) : undefined;
    }
    const m = /^(?:const|let|var)\s+([\w$]+)\s*=\s*([\s\S]+)$/.exec(s);
    if (m) {
      const v = evalOrThrow(m[2], withScope(ctx, scope));
      scope[m[1]] = v;
      last = v;
      continue;
    }
    last = evalOrThrow(s, withScope(ctx, scope));
  }
  return last;
}

// 把声明的变量并入求值上下文（作为 json 上的字段），使后续语句可引用它们
function withScope(ctx: EvalContext, scope: Record<string, unknown>): EvalContext {
  if (Object.keys(scope).length === 0) return ctx;
  return { ...ctx, json: { ...(ctx.json ?? {}), ...scope } };
}

// 顶层分号切分：忽略字符串字面量与 (), [], {} 内的分号
function splitTopLevel(code: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { out.push(code.slice(start, i)); start = i + 1; }
  }
  out.push(code.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// 求值并「显式失败」：错误不再是数据，而是向上抛出（→ 节点 failed → 执行 error）
function evalOrThrow(expr: string, ctx: EvalContext): unknown {
  const r = safeEvaluate(expr, ctx);
  if (r.ok) return r.value;
  throw new CodeEvaluationError(r.error);
}

// 可读、可行动的求值错误：指出失败原因 + 本受限求值器支持的能力边界
class CodeEvaluationError extends Error {
  constructor(reason: string) {
    super(
      `Code 节点求值失败：${reason}。`
      + '本实现为受限求值器（Cloudflare Workers 禁用 eval/new Function），不支持任意 JS 语句（如 for/while/function/块体箭头）。'
      + '支持：字段引用（json.x / $json.x）、算术/比较/逻辑/三目/括号、数组与对象字面量（含 ...展开）、'
      + '箭头函数 x => expr、items / $input.all()|first()|last() / $now / env，'
      + '以及 .map|.filter|.reduce|.forEach|.find|.join|.slice|.length。'
      + '注意：不支持对象简写属性（如 { idx }），请写成 { idx: idx }。',
    );
    this.name = 'CodeEvaluationError';
  }
}
