/** A-003 C4 隔离变异测试：在 scoring 内植入违规引用，depcruise 与 eslint 必须报错（测试结束删除探针文件） */
import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const PROBE = join(import.meta.dirname, '../src/__isolation_probe__.ts');
beforeAll(() => rmSync(PROBE, { force: true }));
afterEach(() => rmSync(PROBE, { force: true }));

function run(cmd: string) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
    return { ok: true, out: '' };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}` };
  }
}

describe('scoring 隔离（三层之 ②：静态依赖）', () => {
  // 自检 I5：必须命中具体规则名，不接受"解析不到"之类的顺带失败
  it.each([
    ["import '../../core/src/commerce/index';", /scoring-no-commerce-core/],
    ["import '../../core/src/index';", /scoring-no-commerce-reachable/], // 经桶文件传递触达商业域
    ["import '../../db/src/index';", /scoring-no-db-or-core/],
    // A-007：tracking 已有真实源码（此前以 README 代替）
    ["import '../../tracking/src/index';", /scoring-no-tracking/],
    ["import '../../tracking/src/commission';", /scoring-no-tracking/],
  ])('depcruise 拦截：%s', (line, rule) => {
    writeFileSync(PROBE, `${line}\nexport {};\n`);
    const r = run('pnpm -s exec depcruise --config .dependency-cruiser.cjs packages/scoring');
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(rule);
  });

  it.each(["import '@bydp/core/commerce';", "import '@bydp/db';", "import '@bydp/tracking';"])('eslint 拦截：%s', (line) => {
    writeFileSync(PROBE, `${line}\nexport {};\n`);
    const r = run(`pnpm -s exec eslint ${PROBE}`);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/no-restricted-imports/);
  });
});
