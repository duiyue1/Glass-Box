import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from '../engine/plugin.ts';
import type { RiskAssessment, Tool } from '../engine/types.ts';
import { safeAssess } from '../engine/types.ts';
import { isSecret, resolveInWorkspace, type PathZone } from './paths.ts';

/** 图片扩展名 → MIME。只认这几种主流格式，其余当二进制拒读。 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * 凭证黑名单已经搬到 `paths.ts`——因为 shell 命令也要用同一份。
 * `read_file .env` 被拒而 `run_command "cat .env"` 放行，等于这条边界不存在。
 */

/**
 * 关键配置文件：写它们要每次单独确认，答过「始终允许」也不入记忆。
 *
 * 判断标准是「改了会不会改变构建/测试的门槛，或者改变 agent 自己的行为」：
 * - `package.json`：**自动验证的命令就是从它的 scripts 里探测的**（见 verify/verifier.ts）。
 *   一旦被记进"始终允许"，模型改掉 `scripts.test` 就等于拿到一条免审批执行任意命令的通道。
 * - `tsconfig.json` / `package-lock.json`：类型检查门槛与依赖树。
 * - `AGENTS.md` / `skills/`：agent 自己的工作指令——自举时自我改写指令的风险。
 * - `.github/`：CI 配置。
 * - `.glassbox/`：`verify.json`（验证命令）、`mcp.json`（能拉起任意外部进程）、
 *   会话日志与记忆。改它们等于改掉这个项目赖以自证的那套记录。
 */
const CRITICAL_BASENAMES = ['package.json', 'package-lock.json', 'tsconfig.json', 'AGENTS.md'];
const CRITICAL_SEGMENTS = ['.github', '.glassbox', 'skills'];

/** abs 是否是关键配置文件。只对工作区内路径有意义 */
function isCriticalPath(workspace: string, abs: string): boolean {
  const rel = path.relative(workspace, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const segments = rel.split(path.sep);
  const base = segments[segments.length - 1] ?? '';
  const first = segments[0] ?? '';
  return CRITICAL_BASENAMES.includes(base) || CRITICAL_SEGMENTS.includes(first);
}

/** 关键配置文件的审批附加项：说清为什么，并旁路会话记忆 */
function criticalNote(): { reason: string; noMemory: true } {
  return {
    reason: '关键配置文件：改它会动构建/测试门槛或 agent 自身行为，每次都要单独确认',
    noMemory: true,
  };
}

/**
 * 写类操作的硬边界。命中就是 deny——不问人，`GB_APPROVE=all` 也过不去。
 * 返回 undefined 表示这一关放行。
 */
function writeBarrier(p: string, zone: PathZone, real: string): RiskAssessment | undefined {
  if (zone === 'protected') {
    return {
      level: 'deny',
      summary: `写入 git 元数据: ${p}`,
      reason: '.git 下的文件一律不可写——写 hooks 等于给下一次 git commit 埋一段自动执行的脚本',
    };
  }
  if (zone === 'outside') {
    return { level: 'deny', summary: `写入工作区外的文件: ${p}`, reason: `真实路径 ${real} 在工作区之外` };
  }
  if (isSecret(real)) {
    return { level: 'deny', summary: `写入凭证类文件: ${p}`, reason: `真实路径 ${real} 命中凭证黑名单` };
  }
  return undefined;
}

/** 图片体积上限（MB）。base64 后体积再涨 1/3，且要进对话历史，必须封顶。 */
function maxImageBytes(): number {
  return Number(process.env.GB_MAX_IMAGE_MB ?? 4) * 1024 * 1024;
}

function humanSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 数一段文本有多少行（末尾单个换行不算新的一行） */
function countLines(text: string): number {
  if (text === '') return 0;
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').length;
}

/** 生成一段简单的变更预览：旧文本按行标 -，新文本按行标 + */
function diffPreview(oldText: string, newText: string): string {
  const rm = oldText.split('\n').map((l) => `- ${l}`);
  const add = newText.split('\n').map((l) => `+ ${l}`);
  return [...rm, ...add].join('\n');
}

/** old 在 content 里出现几次（按字面，不走正则） */
function countOccurrences(content: string, old: string): number {
  if (old === '') return 0;
  let n = 0;
  let i = content.indexOf(old);
  while (i >= 0) {
    n += 1;
    i = content.indexOf(old, i + old.length);
  }
  return n;
}

/** 行太多就头尾各留一半，中间说明省了多少 */
function clipLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  const head = Math.floor(max / 2);
  return [...lines.slice(0, head), `  … 省略 ${lines.length - max} 行 …`, ...lines.slice(-(max - head))];
}

/**
 * 一次 read_file 最多返回多少行。
 *
 * 为什么要有上限：以前 `read_file` 无条件返回整篇。两千行的文件一次就能把上下文预算
 * 吃掉一大块，而模型往往只需要其中一个函数；更糟的是**它无从知道该分段**——
 * 工具没有 offset/limit，也没有任何"还有多少没读"的提示，只能整篇要或者不要。
 * 给上限 + 给参数 + 在截断处告诉它怎么读下一段，三件事必须一起做才有用。
 */
const DEFAULT_MAX_LINES = 2000;
/** 单行字符上限。压缩过的 js/json 常常整个文件就是一行，按行数限根本限不住 */
const MAX_LINE_CHARS = 2000;

function maxLines(): number {
  const n = Number(process.env.GB_READ_MAX_LINES?.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_LINES;
}

function clampInt(raw: unknown, min: number, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/**
 * 取文件的一个行窗口，带行号。
 *
 * 带行号是为了让 `edit_file` 有的放矢，也让"读了第 200-400 行"这件事在对话里可追溯。
 * `complete` 表示这次是否把整篇都给出去了——`write_file` 的"必须先读过"要靠它判断。
 */
export function readWindow(
  text: string,
  offsetArg: unknown,
  limitArg: unknown,
): { text: string; shown: number; complete: boolean } {
  const lines = text.split('\n');
  // 末尾换行会切出一个空串，它不是"一行"
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();

  const total = lines.length;
  const offset = Math.min(clampInt(offsetArg, 1, 1), Math.max(total, 1));
  const limit = clampInt(limitArg, 1, maxLines());
  const start = offset - 1;
  const end = Math.min(start + limit, total);
  const width = String(end).length;

  const body = lines.slice(start, end).map((l, i) => {
    const no = String(start + i + 1).padStart(width);
    const clipped = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… (本行还有 ${l.length - MAX_LINE_CHARS} 字符)` : l;
    return `${no}→${clipped}`;
  });

  const complete = start === 0 && end === total;
  if (complete) return { text: body.join('\n'), shown: total, complete };

  // 截断时必须明说：省了哪一段、共多少行、下一段怎么读。
  // 只截不说会让模型以为自己看到了全文，然后基于半个文件下判断
  const note =
    end < total
      ? `\n… 只显示了第 ${offset}-${end} 行，共 ${total} 行。继续读：read_file({ path, offset: ${end + 1} })`
      : `\n… 只显示了第 ${offset}-${end} 行，共 ${total} 行。`;
  return { text: body.join('\n') + note, shown: end - start, complete };
}

/**
 * 覆盖式写入的预览：掐掉两头没变的行，只显示真正改动的那一段。
 *
 * `write_file` 以前完全没有 preview——审批弹窗上只有一句"写入文件: x.ts"，
 * 人根本不知道自己在批准什么。而整文件 diff 对几百行的文件同样没有可读性，
 * 要判断的恰恰只是"改了哪儿"。
 */
export function overwritePreview(oldText: string, newText: string, maxLines = 60): string {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const rm = a.slice(head, a.length - tail);
  const add = b.slice(head, b.length - tail);
  if (!rm.length && !add.length) return '（内容与原文件完全一致）';
  const half = Math.max(1, Math.floor(maxLines / 2));
  return [
    ...(head ? [`  … 前 ${head} 行未变 …`] : []),
    ...clipLines(rm.map((l) => `- ${l}`), half),
    ...clipLines(add.map((l) => `+ ${l}`), half),
    ...(tail ? [`  … 后 ${tail} 行未变 …`] : []),
  ].join('\n');
}

/**
 * fs 插件：给 agent 读写文件的能力。
 * - read_file：读工作区内文件（safe，无需审批）
 * - write_file：写文件（confirm；若越出工作区则升级为 dangerous）
 *
 * readOnly=true 时只提供 read_file（用于受限的只读子 agent）。
 */
export function fsPlugin(opts: { readOnly?: boolean } = {}): Plugin {
  return {
    name: 'fs',
    setup(ctx) {
      const { workspace } = ctx;

      /**
       * 本会话见过的文件版本：绝对路径 → 我们最后一次读到/写下时的 mtime。
       *
       * 为什么需要：`write_file` 是覆盖式的，而以前它对一个**从没读过**的文件也照写不误——
       * 模型只要猜对路径就能把整个文件换掉，审批弹窗上还只有一句"写入文件: x.ts"。
       * 对一个同时能执行 shell 的 agent 来说这是真实的数据丢失路径。
       * Claude Code 的做法是强制"先 Read 再 Edit"，并在文件读取后被外部改动时拒绝写；
       * 这个 Map 就是那条规则的最小实现。
       */
      const seen = new Map<string, number>();
      const remember = (abs: string): void => {
        try {
          seen.set(abs, fs.statSync(abs).mtimeMs);
        } catch {
          seen.delete(abs);
        }
      };
      /** 覆盖这个文件安全吗？返回不安全的原因，undefined = 可以写 */
      const staleReason = (abs: string): string | undefined => {
        let mtime: number;
        try {
          mtime = fs.statSync(abs).mtimeMs;
        } catch {
          return undefined; // 文件不存在 = 新建，没有可丢的东西
        }
        const known = seen.get(abs);
        if (known === undefined) return '本会话还没读过它';
        if (known !== mtime) return '你读过之后它被改动过（外部修改或另一个进程）';
        return undefined;
      };

      const readFile: Tool = {
        name: 'read_file',
        // 只读：本回合内重复读同一个文件直接复用。任何写操作会让缓存整体作废，
        // 所以"改完再读一遍确认"仍然会真的重新读盘。
        cacheable: true,
        description:
          '读取文件内容（带行号）；图片（png/jpg/gif/webp）会作为图像交给模型。工作区外需审批。' +
          `默认最多返回 ${DEFAULT_MAX_LINES} 行，长文件用 offset/limit 分段读`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，相对工作区或绝对路径' },
            offset: { type: 'number', description: '从第几行开始读（1 起，默认 1）' },
            limit: { type: 'number', description: `最多读几行（默认 ${DEFAULT_MAX_LINES}）` },
          },
          required: ['path'],
        },
        assess(args) {
          const p = String(args.path ?? '');
          const { real, zone } = resolveInWorkspace(workspace, p);
          // 凭证类文件按**真身**判定。以前拿词法路径做正则匹配，工作区里放一个
          // 软链 notes.txt -> ~/.ssh/id_rsa 就整条黑名单失效（实测能零审批读出私钥）
          if (isSecret(real)) {
            return {
              level: 'deny',
              summary: `读取凭证类文件: ${p}`,
              reason: `真实路径 ${real} 命中凭证黑名单，永不读取`,
            };
          }
          if (zone === 'outside') {
            return { level: 'dangerous', summary: `读取工作区外的文件: ${real}`, reason: '越出工作区边界' };
          }
          // 区内普通读取（含 .git 里的仓库内容）= safe，不打扰人。只保护写，不保护读。
          // 这里必须显式返回 safe：`return undefined` 在"安全缺省"下等于 confirm，
          // 会让每一次读文件都弹一次审批。
          return safeAssess();
        },
        run(args) {
          const p = String(args.path ?? '');
          const { abs, real } = resolveInWorkspace(workspace, p);
          // 黑名单在 run 里再挡一次：即使有人手滑点了“允许”，也读不到密钥
          if (isSecret(real)) {
            return { ok: false, content: `拒绝：${p} 的真实路径是 ${real}，属于凭证类文件，永不读取` };
          }

          const ext = path.extname(abs).toLowerCase();
          const mime = IMAGE_MIME[ext];
          if (mime) {
            let buf: Buffer;
            try {
              buf = fs.readFileSync(abs);
            } catch (e) {
              return { ok: false, content: `读取失败: ${(e as Error).message}` };
            }
            const limit = maxImageBytes();
            if (buf.byteLength > limit) {
              return {
                ok: false,
                content: `图片过大（${humanSize(buf.byteLength)} > ${humanSize(limit)}），请压缩后再试（或调大 GB_MAX_IMAGE_MB）`,
              };
            }
            return {
              ok: true,
              content: `已读取图片 ${path.basename(abs)}（${mime}，${humanSize(buf.byteLength)}），已作为图像附给模型`,
              images: [`data:${mime};base64,${buf.toString('base64')}`],
              meta: { action: 'read', path: abs, images: 1 },
            };
          }

          let text: string;
          try {
            text = fs.readFileSync(abs, 'utf8');
          } catch (e) {
            return { ok: false, content: `读取失败: ${(e as Error).message}` };
          }

          const win = readWindow(text, args.offset, args.limit);
          // **只有整篇都读到了才记版本**。write_file 的"必须先读过"是为了防覆盖式写入
          // 丢内容；如果这次只读了其中一段，把它记成"读过了"就等于允许模型
          // 拿着三分之一的内容去覆盖整个文件——那道门就白设了
          if (win.complete) remember(abs);
          return {
            ok: true,
            content: win.text,
            meta: { action: 'read', path: abs, added: win.shown },
          };
        },
      };

      const writeFile: Tool = {
        name: 'write_file',
        description:
          '把内容写入工作区内的文件（覆盖式）。新文件可以直接写；' +
          '要覆盖一个已存在的文件，必须先 read_file 看过它——否则会被拒绝。局部改动请优先用 edit_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，必须在工作区内' },
            content: { type: 'string', description: '完整的文件内容（会覆盖原文件）' },
          },
          required: ['path', 'content'],
        },
        assess(args) {
          const p = String(args.path ?? '');
          const { abs, real, zone } = resolveInWorkspace(workspace, p);
          const barrier = writeBarrier(p, zone, real);
          if (barrier) return barrier;
          const stale = staleReason(abs);
          if (stale) {
            return {
              level: 'dangerous',
              summary: `覆盖没读过的文件: ${p}`,
              reason: `${stale}，将被直接拒绝——覆盖式写入会丢掉原有内容`,
            };
          }
          // 已存在的文件给出改动预览：人要批准的是"改了哪儿"，不是"写了某个文件"
          let preview: string | undefined;
          try {
            preview = overwritePreview(fs.readFileSync(abs, 'utf8'), String(args.content ?? ''));
          } catch {
            // 新建文件没有原文可比，不给预览
          }
          return {
            level: 'confirm',
            summary: `写入文件: ${p}`,
            ...(isCriticalPath(workspace, abs) ? criticalNote() : {}),
            ...(preview ? { preview } : {}),
          };
        },
        run(args) {
          const p = String(args.path ?? '');
          const content = String(args.content ?? '');
          const { abs, real, zone } = resolveInWorkspace(workspace, p);
          if (writeBarrier(p, zone, real)) {
            return { ok: false, content: `拒绝：${p}（真实路径 ${real}）不在可写范围内` };
          }
          // 黑名单式的硬边界：即使有人点了"允许"，也不许覆盖没看过的文件。
          // 出路给得很明确，否则模型只会原封不动地重试
          const stale = staleReason(abs);
          if (stale) {
            return {
              ok: false,
              content:
                `拒绝覆盖 ${p}：${stale}。\n` +
                `覆盖式写入会丢掉原有内容。请先 read_file 看一遍再写，` +
                `或者用 edit_file 只替换要改的那一段。`,
            };
          }
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            // 写之前先看文件在不在：决定这次算“创建”还是“修改”，以及删掉了几行
            let existed = false;
            let oldLines = 0;
            try {
              oldLines = countLines(fs.readFileSync(abs, 'utf8'));
              existed = true;
            } catch {
              // 文件不存在 → 本次是创建
            }
            fs.writeFileSync(abs, content, 'utf8');
            // 自己写下的版本也要记住，否则同一回合里连着写两次会被当成"外部改动"
            remember(abs);
            return {
              ok: true,
              content: `已写入 ${p}（${content.length} 字符）`,
              meta: {
                action: existed ? 'edited' : 'created',
                path: p,
                added: countLines(content),
                removed: oldLines,
              },
            };
          } catch (e) {
            return { ok: false, content: `写入失败: ${(e as Error).message}` };
          }
        },
      };

      const editFile: Tool = {
        name: 'edit_file',
        description:
          '对工作区内文件做精确的 search/replace 编辑。默认要求 old 在文件中唯一出现；' +
          '要把所有出现处一起改（比如改一个变量名），传 all: true',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '要编辑的文件路径' },
            old: { type: 'string', description: '要被替换的原文片段' },
            new: { type: 'string', description: '替换成的新内容' },
            all: {
              type: 'boolean',
              description: '替换所有出现处（默认 false，即要求 old 唯一，出现多次会被拒绝）',
            },
          },
          required: ['path', 'old', 'new'],
        },
        assess(args) {
          const p = String(args.path ?? '');
          const { abs, real, zone } = resolveInWorkspace(workspace, p);
          const barrier = writeBarrier(p, zone, real);
          if (barrier) return barrier;
          let preview: string | undefined;
          let hits = 0;
          try {
            const content = fs.readFileSync(abs, 'utf8');
            const oldText = String(args.old ?? '');
            if (oldText) {
              hits = countOccurrences(content, oldText);
              if (hits > 0) preview = diffPreview(oldText, String(args.new ?? ''));
            }
          } catch {
            // 读不到就不给预览，run 时会报错
          }
          // 批量替换要在审批摘要里写清"要动几处"。`all: true` 改 40 处和改 1 处
          // 风险完全不同，而摘要上如果只写"编辑文件: x.ts"，人是看不出来的
          const scope = args.all === true ? `批量编辑文件（${hits} 处）: ${p}` : `编辑文件: ${p}`;
          return {
            level: 'confirm',
            summary: scope,
            ...(isCriticalPath(workspace, abs) ? criticalNote() : {}),
            ...(preview ? { preview } : {}),
          };
        },
        run(args) {
          const p = String(args.path ?? '');
          const oldText = String(args.old ?? '');
          const newText = String(args.new ?? '');
          const all = args.all === true;
          const { abs, real, zone } = resolveInWorkspace(workspace, p);
          if (writeBarrier(p, zone, real)) {
            return { ok: false, content: `拒绝：${p}（真实路径 ${real}）不在可写范围内` };
          }
          if (!oldText) return { ok: false, content: 'edit_file 需要 old 文本' };
          let content: string;
          try {
            content = fs.readFileSync(abs, 'utf8');
          } catch (e) {
            return { ok: false, content: `读取失败: ${(e as Error).message}` };
          }
          const hits = countOccurrences(content, oldText);
          if (hits === 0) return { ok: false, content: '未找到要替换的文本（old 不匹配）' };
          if (hits > 1 && !all) {
            return {
              ok: false,
              content: `old 文本在文件中出现 ${hits} 次。请补更多上下文让它唯一，或传 all: true 一起替换`,
            };
          }
          // 用 split/join 而不是正则：old 是原文片段，里头的 . * ( ) 必须按字面处理
          const updated = all
            ? content.split(oldText).join(newText)
            : content.replace(oldText, () => newText);
          try {
            fs.writeFileSync(abs, updated, 'utf8');
          } catch (e) {
            return { ok: false, content: `写入失败: ${(e as Error).message}` };
          }
          // edit_file 不需要"先读过"这道门：old 必须原文匹配，本身就是一次内容校验。
          // 但改完的版本要记下来，否则紧接着的 write_file 会把它当成外部改动
          remember(abs);
          const where = hits > 1 ? `${hits} 处，` : '';
          return {
            ok: true,
            content: `已编辑 ${p}（${where}-${countLines(oldText) * hits} / +${countLines(newText) * hits} 行）`,
            meta: {
              action: 'edited',
              path: p,
              added: countLines(newText) * hits,
              removed: countLines(oldText) * hits,
            },
          };
        },
      };

      ctx.tools.register(readFile);
      if (!opts.readOnly) {
        ctx.tools.register(writeFile);
        ctx.tools.register(editFile);
      }
    },
  };
}
