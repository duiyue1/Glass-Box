import fs from 'node:fs';
import os from 'node:os';
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
 * 永久黑名单：无论是否审批放行，这些文件一律不读不写。
 * 审批能挡住"误操作"，挡不住"看起来合理但其实在偷密钥"的请求——
 * 凭证文件必须有一条不经过人类判断的硬边界。
 *
 * 放在这里而不是 fsPlugin 里，是因为 shell 命令也要用同一份名单：
 * `read_file .env` 被拒而 `run_command "cat .env"` 放行，等于这条边界不存在。
 * 一份名单，两个入口共用。
 */
const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh\//,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.kube\/config$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.gnupg\//,
  /\/Library\/Keychains\//,
  /\.(pem|key|p12|pfx|keystore)$/,
];

/** 传**真实路径**（realpath 后），不要传词法路径——软链名字随便起就绕过了 */
export function isSecret(real: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(real));
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

// ── shell 命令的路径归属 ────────────────────────────────────────────

/**
 * 命令行里被 shell 用来分隔/重定向的字符，切词时当成断点。
 * `cat <a.txt >b.txt` / `x;cat /etc/hosts` 里的路径不能因为贴着符号就漏掉。
 */
const SHELL_SEPARATORS = /[|;&<>()]/;
/** 协议前缀（URL 不是本地路径，交给 web 工具去管） */
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * 这个词值得拿去做路径判定吗？
 *
 * 判据：不是选项、不是 URL、不带无法展开的元字符，并且**看起来指向某个文件**——
 * 带 `/`、`~` 开头、就是 `..`、或者含 `.`（`.env` / `x.ts` 这种同目录下的裸文件名）。
 *
 * 为什么裸文件名也要收：`cat .env` 里的 `.env` 一个斜杠都没有，
 * 但它正是最该拦的那一类。含 `.` 这个判据让 `npm` / `test` / `hello` 这些普通词落选，
 * 而它们即使落选也无所谓——落在区内本来就不升级。
 */
function looksLikePath(token: string): boolean {
  if (token === '' || token.startsWith('-')) return false; // 选项不是路径
  if (SCHEME.test(token)) return false;
  if (token.includes('$') || token.includes('*') || token.includes('?')) return false; // 展开不了，别猜
  return (
    token.startsWith('/') ||
    token.startsWith('~') ||
    token === '..' ||
    token.includes('/') ||
    token.includes('.')
  );
}

/** 切词：认引号，所以带空格的路径不会被劈成两半 */
function tokenize(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const push = (): void => {
    if (cur !== '') out.push(cur);
    cur = '';
  };
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // 空白和 shell 的分隔/重定向符号都断词：`x;cat /etc/hosts`、`cat <a >b` 都要切开
    if (/\s/.test(ch) || SHELL_SEPARATORS.test(ch)) push();
    else cur += ch;
  }
  push();
  return out;
}

/** 抽出命令里所有值得判定的本地路径，`~` 已展开 */
export function commandPaths(command: string): string[] {
  const home = os.homedir();
  const out: string[] = [];
  for (const t of tokenize(command)) {
    if (!looksLikePath(t)) continue;
    out.push(t === '~' || t.startsWith('~/') ? path.join(home, t.slice(1)) : t);
  }
  return out;
}

/**
 * shell 命令碰到了什么区。
 *
 * 为什么需要这个（这是安全模型上的一个真窟窿）：文件工具已经按真实路径判归属了，
 * 但 `run_command` 只看命令**长什么样**——于是 `cat ~/.ssh/id_rsa`、`cp /etc/hosts .`、
 * `cd ../.. && ls` 和 `echo hello` 是同一个风险等级 `confirm`。
 * 也就是说 `read_file` 那边所有的硬边界，换成 `run_command` 就全部失效。
 *
 * 返回最严重的那一档：`secret` > `outside` > `protected` > `null`（没碰到可疑路径）。
 *
 * **这是启发式，不是沙箱。** 它按空白切词、认出路径形状的词，再用同一套 realpath 判定去判；
 * 带 `$` / `*` 的词展开不了，所以不做路径解析，只拿字面去比凭证名单
 * （`cat $HOME/.ssh/id_rsa` 因此还是能拦住）。但 `$(echo LnNzaA== | base64 -d)`
 * 这类刻意混淆它拦不住。
 * 它的作用是把"一眼就该拦的命令"从 confirm 抬到 dangerous/deny，让审批弹窗上的等级
 * 对得上命令实际要做的事；真正的隔离要靠容器或 seccomp。
 */
export interface CommandZoneHit {
  kind: 'secret' | 'outside' | 'protected';
  /** 命令里原样的那个词 */
  path: string;
  /** realpath 解析后的真身；`literal` 命中时没解析过，等于 path */
  real: string;
  /**
   * 怎么命中的：`realpath` = 解析后判定；`literal` = 词里带 `$`/`*` 解析不了，
   * 拿字面比中了凭证名单。给审批弹窗写理由时要分开说，别把字面当成真实路径。
   */
  matchedBy: 'realpath' | 'literal';
}

export function classifyCommandZone(workspace: string, command: string): CommandZoneHit | null {
  const rootReal = canonicalRoot(workspace);
  let weaker: CommandZoneHit | null = null;

  // 第一轮：所有词的**字面**都比一遍凭证名单。这样 `$HOME/.ssh/id_rsa`、
  // `"$PWD/../.ssh/id_rsa"` 这些解析不了的写法也拦得住
  for (const t of tokenize(command)) {
    if (t.startsWith('-') || SCHEME.test(t)) continue;
    const literal = t.replace(/\\/g, '/');
    if (isSecret(literal)) return { kind: 'secret', path: t, real: t, matchedBy: 'literal' };
  }

  for (const p of commandPaths(command)) {
    const real = realpathDeep(path.resolve(rootReal, p));
    // 凭证最严重，一命中就短路
    if (isSecret(real)) return { kind: 'secret', path: p, real, matchedBy: 'realpath' };

    const zone = classifyRooted(rootReal, p);
    if (zone === 'inside') continue;
    // outside 比 protected 严重：前者整个越出了边界，后者还在区内
    if (zone === 'outside' && weaker?.kind !== 'outside') {
      weaker = { kind: 'outside', path: p, real, matchedBy: 'realpath' };
    } else if (zone === 'protected' && weaker === null) {
      weaker = { kind: 'protected', path: p, real, matchedBy: 'realpath' };
    }
  }
  return weaker;
}
