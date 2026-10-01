// 测试入口：递归收集 tests/**/*.test.ts，用 Node 内置 test runner + tsx 执行。
// 不用 shell glob，保证在 Windows(cmd/powershell/git-bash) 与 POSIX 下行为一致。
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const files = collect(testsDir).sort();
if (files.length === 0) {
  console.error('未找到任何 *.test.ts 测试文件');
  process.exit(1);
}

console.log(`运行 ${files.length} 个测试文件：`);
for (const f of files) console.log(`  - ${relative(root, f)}`);
console.log('');

const result = spawnSync(
  process.execPath,
  [
    '--import', 'tsx',
    '--disable-warning=ExperimentalWarning',
    '--test',
    '--test-reporter=spec',
    ...files.map((f) => relative(root, f)),
  ],
  { cwd: root, stdio: 'inherit', env: process.env },
);

process.exit(result.status ?? 1);
