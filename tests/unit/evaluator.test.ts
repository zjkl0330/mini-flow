// 受限表达式求值器测试。
// 这些用例锁定既往缺陷：`1 + 1` 曾因一律字符串拼接返回 "11"；对象字面量冒号解析失败；
// 以及 `true` / `false` / `null` 未作字面量处理（导致 IF 的 conditionSt: "true" 恒为假）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, safeEvaluate } from '../../src/engine/evaluator';

const ev = (expr: string, json: Record<string, unknown> = {}) => evaluate(expr, { json });

test('算术：+ 对两个数字做数值相加（回归：曾返回字符串 "11"）', () => {
  assert.equal(ev('1 + 1'), 2);
  assert.equal(ev('2 * 3 + 1'), 7);
  assert.equal(ev('10 / 4'), 2.5);
  assert.equal(ev('1 - 2'), -1);
  assert.equal(ev('2 + 3 * 4'), 14);
});

test('加法：任一操作数为字符串时按 JS 语义拼接', () => {
  assert.equal(ev("'1' + 1"), '11');
  assert.equal(ev("1 + '1'"), '11');
  assert.equal(ev("'a' + 'b'"), 'ab');
});

test('比较与相等：数字与数字字符串互通', () => {
  assert.equal(ev('1 < 2'), true);
  assert.equal(ev("'2' > 1"), true);
  assert.equal(ev('2 >= 2'), true);
  assert.equal(ev("1 == '1'"), true);
  assert.equal(ev('1 != 2'), true);
  assert.equal(ev("'a' === 'a'"), true);
  assert.equal(ev("'a' == 'b'"), false);
});

test('逻辑运算与优先级', () => {
  assert.equal(ev('true && false'), false);
  assert.equal(ev('true || false'), true);
  assert.equal(ev('!true'), false);
  assert.equal(ev('1 > 0 && 2 > 1'), true);
  assert.equal(ev('1 > 2 || 2 > 1'), true);
});

test('三目表达式', () => {
  assert.equal(ev("1 > 0 ? 'yes' : 'no'"), 'yes');
  assert.equal(ev("1 < 0 ? 'yes' : 'no'"), 'no');
});

test('字面量关键字 true / false / null（回归：曾当字段名取到 undefined）', () => {
  assert.equal(ev('true'), true);
  assert.equal(ev('false'), false);
  assert.equal(ev('null'), null);
  // IF 的真实用法：conditionSt 为字符串 "true" 时必须求值为布尔真
  assert.equal(Boolean(ev('true')), true);
});

test('对象与数组字面量', () => {
  assert.deepEqual(ev('{ a: 1, b: 2 }'), { a: 1, b: 2 });
  assert.deepEqual(ev("{ name: 'x' }"), { name: 'x' });
  assert.deepEqual(ev('[1, 2, 3]'), [1, 2, 3]);
});

test('字段引用：json.x / $json.x / 裸字段名 与点链', () => {
  const json = { a: 1, b: { c: 2 }, args: { q: 'hi' } };
  assert.equal(ev('json.a', json), 1);
  assert.equal(ev('$json.b.c', json), 2);
  assert.equal(ev('json.args.q', json), 'hi');
  assert.equal(ev('a', json), 1);
  assert.equal(ev('b.c', json), 2);
  assert.equal(ev('json.missing', json), undefined);
  assert.equal(ev('json.b.missing.deep', json), undefined);
});

test('内置函数白名单', () => {
  assert.equal(ev('round(1.2345, 2)'), 1.23);
  assert.equal(ev('floor(1.9)'), 1);
  assert.equal(ev('ceil(1.1)'), 2);
  assert.equal(ev('abs(-3)'), 3);
  assert.equal(ev('max(1, 5, 3)'), 5);
  assert.equal(ev('min(4, 2, 9)'), 2);
  assert.equal(ev('length([1, 2, 3])'), 3);
  assert.equal(ev("length('abcd')"), 4);
  assert.equal(ev("upper('ab')"), 'AB');
  assert.equal(ev("lower('AB')"), 'ab');
  assert.equal(ev("trim('  x  ')"), 'x');
  assert.equal(ev("concat('a', 'b', 'c')"), 'abc');
  assert.equal(ev("toInt('42px')"), 42);
  assert.equal(ev("toFloat('3.5rem')"), 3.5);
});

test('错误路径：语法错误 / 未知函数 / 非法字符 都必须显式失败而非静默返回空', () => {
  assert.equal(safeEvaluate('1 +', { json: {} }).ok, false);
  assert.equal(safeEvaluate("'abc", { json: {} }).ok, false);
  assert.equal(safeEvaluate('foo(1)', { json: {} }).ok, false);
  assert.equal(safeEvaluate('1 @ 2', { json: {} }).ok, false);
  assert.equal(safeEvaluate('{ a 1 }', { json: {} }).ok, false);
});

test('空表达式返回 undefined', () => {
  assert.equal(ev(''), undefined);
  assert.equal(ev('   '), undefined);
});
