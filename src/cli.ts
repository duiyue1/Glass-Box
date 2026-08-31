import fs from 'node:fs';
import path from 'node:path';

/**
 * 命令行入口共用的一点参数解析。
 *
 * 单独抽出来只为一件事：**工作区不能再写死 `process.cwd()`**。
 * 写死的代价是真实的——工作区就是所有安全边界的原点（`inside` / `outside` /
 * `protected` 全都相对它来算），而"想在别的目录上跑一下"是最常见的需求。
 * 结果只能 `cd` 过去再启动，一不小心就在自己的仓库里跑出一堆测试产物。
 */

/** 取 `--flag value` 里的 value；没有这个 flag 或它后面没值就返回 undefined */
export function flagValue(argv: readonly string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) return v;
    }
  }
  return undefined;
}

export function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return names.some((n) => argv.includes(n));
}

/**
 * 决定工作区：`--workspace <dir>`（别名 `-C`，跟 `git -C` 一个意思）
 * > `GB_WORKSPACE` 环境变量 > 当前目录。
 *
 * 目录必须已存在：不自动创建。工作区是安全边界的原点，让一个打错的路径
 * 凭空变成一个新工作区，等于把边界画到了任何地方。
 */
export function resolveWorkspace(argv: readonly string[] = process.argv.slice(2)): string {
  const raw = flagValue(argv, '--workspace', '-C') ?? process.env.GB_WORKSPACE?.trim();
  if (!raw) return process.cwd();

  const abs = path.resolve(raw);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    console.error(`工作区不存在: ${abs}（--workspace 不会自动建目录）`);
    process.exit(2);
  }
  if (!st.isDirectory()) {
    console.error(`工作区不是目录: ${abs}`);
    process.exit(2);
  }
  return abs;
}

/** 去掉已经被消费掉的 flag 及其值，剩下的才是"用户真正想说的话" */
export function stripFlags(
  argv: readonly string[],
  withValue: readonly string[],
  boolean_: readonly string[] = [],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (withValue.includes(a)) {
      i += 1; // 连它的值一起跳过
      continue;
    }
    if (boolean_.includes(a)) continue;
    out.push(a);
  }
  return out;
}
