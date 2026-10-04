#!/usr/bin/env python3
# 反向验证：故意把已修复的缺陷重新注入，确认测试能捕获（否则测试是"假绿"）。
# 运行后自动从备份还原。任何一步失败都会在最后统一报告。
import io, os, shutil, subprocess, sys, re

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
BAK = os.path.join(ROOT, '.workbuddy', 'tmp', 'bak')
NODE = r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

TARGETS = ['src/engine/evaluator.ts', 'src/nodes/index.ts', 'src/nodes/code-node.ts']

def read(p): return io.open(os.path.join(ROOT, p), encoding='utf-8').read()
def write(p, s): io.open(os.path.join(ROOT, p), 'w', encoding='utf-8', newline='').write(s)

os.makedirs(BAK, exist_ok=True)
for t in TARGETS:
    shutil.copy2(os.path.join(ROOT, t), os.path.join(BAK, os.path.basename(t)))

results = []
try:
    # --- 破坏 1: 求值器去掉 true/false/null 字面量 ---
    s = read('src/engine/evaluator.ts')
    broken1 = s.replace(
        "    if (name === 'true') return true;\n"
        "    if (name === 'false') return false;\n"
        "    if (name === 'null') return null;\n"
        "    if (name === 'undefined') return undefined;\n", "")
    assert broken1 != s, '破坏1 未生效'
    write('src/engine/evaluator.ts', broken1)

    # --- 破坏 2: 把 respondToWebhook 挪到泛化 webhook 之后 ---
    s = read('src/nodes/index.ts')
    specific = "  { match: /respondToWebhook|respond_to_webhook/i, executor: respondToWebhookNode },\n"
    generic = "  { match: /webhook/i, executor: webhookNode },\n"
    assert specific in s and generic in s, '破坏2 定位失败'
    broken2 = s.replace(specific, '').replace(generic, generic + specific)
    write('src/nodes/index.ts', broken2)

    # --- 破坏 3: Code 节点多语句路径回退成 EvalContext 包裹体 ---
    s = read('src/nodes/code-node.ts')
    broken3 = s.replace('evalSafe(ret, { ...item, ...scope })', 'evalSafe(ret, { json: { ...item, ...scope }, env: {} })')
    assert broken3 != s, '破坏3 未生效'
    write('src/nodes/code-node.ts', broken3)

    # 跑测试
    proc = subprocess.run([NODE, 'scripts/run-tests.mjs'], cwd=ROOT,
                          capture_output=True, text=True, encoding='utf-8', errors='replace')
    out = (proc.stdout or '') + (proc.stderr or '')

    checks = [
        ('未注入:true/false 字面量', '字面量关键字'),
        ('IF 条件为 true 时只执行 true 分支', None),
        ('respondToWebhook 必须解析为 respondToWebhookNode', None),
        ('Code 节点支持 const + return 多语句', None),
    ]
    print('=== 反向验证：注入缺陷后测试输出摘要 ===')
    for line in out.splitlines():
        if re.match(r'^\s*[✔✖]', line) or 'ℹ pass' in line or 'ℹ fail' in line:
            print(line)
    print()
    print('=== 判定 ===')
    for name, _ in checks:
        failed = any(name in l and l.strip().startswith('✖') for l in out.splitlines())
        print(f'{"捕获" if failed else "未捕获"}  期望失败：{name}')
        results.append(failed)

finally:
    for t in TARGETS:
        shutil.copy2(os.path.join(BAK, os.path.basename(t)), os.path.join(ROOT, t))
    print()
    print('已从备份还原全部源文件：', ', '.join(TARGETS))

print('反向验证结论：', '全部被捕获' if all(results) else '存在未捕获项，测试覆盖不足')
