// 从 sourcemap 中提取原始源码片段（sourcemap 是超大单行 JSON，直接 grep 会卡）。
// 用法: node mapctx.mjs <mapFile> <pattern> [windowChars]
import { readFileSync } from 'node:fs';

const [, , file, pattern, winArg] = process.argv;
const win = Number(winArg || 400);
const text = readFileSync(file, 'utf8').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
const re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
let m, n = 0;
while ((m = re.exec(text)) && n < 4) {
  const s = Math.max(0, m.index - win);
  console.log(`--- match ${++n} ---`);
  console.log(text.slice(s, m.index + win));
}
if (n === 0) console.log('(no match)');
