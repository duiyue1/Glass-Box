import fs from 'node:fs';
import path from 'node:path';

/**
 * 路径区判定：所有文件工具判"能不能碰"的唯一入口。
 *
 * 为什么不能只做字符串运算（这是这个模块存在的全部理由）：
 * 以前的实现是 `path.resolve` + `path.relative`，纯词法。于是工作区里放一个
 * 软链 `notes.txt -> ~/.ssh/id_rsa`，词法上它「在工作区内」，read_file 连审批都不问
 * （实测过：assess 返回 undefined，直接读出了私钥内容）。凭证黑名单也是拿路径**字符串**
 * 做正则匹配的，软链名字随便起就绕过了——**声称拦住却没拦住，比明确不拦更危险**。
 *
 * 所以判定必须落在 realpath 解析后的**真身**上。三种结果：
 * - `inside`    区根之内，正常操作
 * - `outside`   越出区根（含软链穿出去的），高风险
 * - `protected` 区内但属于 git 元数据（`.git/**`），无条件拒绝——写 `.git/hooks/pre-commit`
 *               等于给下一次 `git commit` 埋一段自动执行的脚本
 *
 * 三个必须处理的细节：
 * 1. **写目标常常还不存在**，`realpathSync` 整串会失败。所以走「最深已存在祖先 + 字面后缀」，
 *    对已存在的那部分（含软链、Windows 实际大小写）仍然解析到真实路径。
 * 2. **末尾悬空软链**（链接在、目标不在）realpath 解析不到，但写操作会穿过去创建目标文件，
 *    所以要按链接目标重新判一次区。
 * 3. Windows 文件系统大小写不敏感（含 junction），比较前折叠大小写。
 *
 * 刻意不做：worktree 里 `.git` 是 `gitdir: <主仓库 git 目录>` 指针文件。段名命中 `.git`
 * 已经把指针文件本身拦住了；它指向的真实 git 目录在工作区外，落在 `outside`，够用。
 * 完整的指针解析要读文件内容，收益不抵复杂度。
 */

export type PathZone = 'inside' | 'outside' | 'protected';

/** 保护段：区内的 git 元数据一律不可写。段名比较大小写不敏感 */
const PROTECTED_SEGMENTS = ['.git'];

/**
 * 只在 Windows 上折叠大小写。
 * macOS 的 APFS 默认也大小写不敏感，但 `realpathSync` 会返回磁盘上的真实大小写，
 * 所以两个大小写变体解析后本来就一致，不需要额外折叠。
 */
const CASE_INSENSITIVE = process.platform === 'win32';

function fold(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** target 是否位于 root 之下（含 root 自身） */
function pathHasPrefix(root: string, target: string): boolean {
  const a = fold(root);
  const b = fold(target);
  if (a === b) return true;
  return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * realpath「最深已存在祖先 + 剩余字面后缀」。
 * 全都不存在（比如测试里的虚构路径）时退回词法 resolve。
 */
export function realpathDeep(input: string): string {
  const abs = path.resolve(input);
  try {
    return fs.realpathSync(abs);
  } catch {
    // 目标本身不存在——写新文件的常态，继续向上找
  }
  let current = abs;
  const suffix: string[] = [];
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return abs; // 一直到文件系统根都不存在：词法兜底
    suffix.unshift(path.basename(current));
    current = parent;
    try {
      return path.join(fs.realpathSync(current), ...suffix);
    } catch {
      // 继续向上
    }
  }
}

/**
 * 末尾悬空软链的链接目标；能正常 realpath（目标存在）或根本不是软链时返回 null。
 * 悬空链接 realpath 会失败，但写操作会穿到链接目标去创建文件——必须按目标重判区。
 */
function danglingLinkTarget(p: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) return null;
  try {
    fs.realpathSync(p);
    return null; // 目标存在，走正常 realpath 分支就行
  } catch {
    try {
      return path.resolve(path.dirname(p), fs.readlinkSync(p));
    } catch {
      return null;
    }
  }
}

/** target 的任一路径段命中保护段，且 target 在 root 之下（嵌套的 vendor/x/.git/ 也算） */
function hitsProtected(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  return rel.split(path.sep).some((seg) => PROTECTED_SEGMENTS.includes(seg.toLowerCase()));
}

/** 规范化区根（realpath 后的绝对路径） */
export function canonicalRoot(workspace: string): string {
  return realpathDeep(path.resolve(workspace));
}

/**
 * 核心判定。悬空软链可以成链，用 seen 防环——每轮要么返回、要么新增一个已解析路径，必然终止。
 */
function classifyRooted(rootReal: string, p: string): PathZone {
  let current = p;
  const seen = new Set<string>();
  for (;;) {
    const raw = path.resolve(rootReal, current);

    // 悬空软链：写操作会穿到链接目标（可能指向 .git 或工作区外），按目标重判
    const dangling = danglingLinkTarget(raw);
    if (dangling !== null && !seen.has(fold(dangling))) {
      seen.add(fold(dangling));
      current = dangling;
      continue;
    }

    const real = realpathDeep(raw);
    // 词法命中保护段：.git 目录本身或 worktree 的 .git 指针文件
    if (hitsProtected(rootReal, raw)) return 'protected';
    // realpath 后命中保护段：区内软链指进 .git 的绕过
    if (hitsProtected(rootReal, real)) return 'protected';
    return pathHasPrefix(rootReal, real) ? 'inside' : 'outside';
  }
}

/** 唯一的路径区判定入口 */
export function classifyPathZone(workspace: string, p: string): PathZone {
  return classifyRooted(canonicalRoot(workspace), p);
}

/**
 * 把用户给的路径解析成绝对路径，并判断它落在哪个区。
 *
 * - `abs`：**词法**解析的绝对路径。实际读写与显示都用它——保持软链语义（写软链就是写它的目标），
 *   也让审批摘要里显示的还是用户/模型给的那个路径。
 * - `real`：realpath 解析后的真身。凭证黑名单这类「这到底是什么文件」的判断必须用它。
 * - `zone` / `inside`：区判定结果。`inside` 保留旧字段名，等价于 `zone === 'inside'`。
 */
export function resolveInWorkspace(
  workspace: string,
  p: string,
): { abs: string; real: string; inside: boolean; zone: PathZone } {
  const abs = path.resolve(workspace, p);
  const zone = classifyPathZone(workspace, p);
  return { abs, real: realpathDeep(abs), inside: zone === 'inside', zone };
}
