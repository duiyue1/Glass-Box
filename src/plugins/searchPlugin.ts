import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from '../engine/plugin.ts';
import { safeAssess, type Tool } from '../engine/types.ts';

const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_HITS = 30;
const MAX_FILES = 5_000;
const MAX_GLOB_RESULTS = 60;

/** 收集工作区里的文件（相对路径），跳过隐藏文件与 node_modules/.git */
function walk(dir: string, root: string, acc: string[]): void {
  if (acc.length >= MAX_FILES) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, acc);
    // 统一成 `/`：这些相对路径要拿去和 globToRegExp 生成的正则比，而那些正则里的目录
    // 分隔符写死是 `/`（`(?:.*/)?`）。Windows 上 path.relative 给的是 `src\foo.ts`，
    // 于是 `glob **/*.ts` 一个都匹配不到。`/` 在 Windows 的 fs API 里照样能用，
    // 后面 path.join(root, f) 读文件不受影响。
    else acc.push(path.relative(root, full).split(path.sep).join('/'));
    if (acc.length >= MAX_FILES) return;
  }
}

/**
 * 把 glob 模式编译成正则。支持：
 *   **  跨目录任意层     *  同一层任意字符     ?  单个字符     {a,b}  多选
 * 不含 `/` 的模式（如 `*.ts`）自动按「任意目录下」理解，符合日常直觉。
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.includes('/') ? pattern : `**/${pattern}`;
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` 允许「零个目录」，所以 **/x 也能匹配根下的 x
        if (p[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else if (c === '{') out += '(?:';
    else if (c === '}') out += ')';
    else if (c === ',') out += '|';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** 按修改时间倒序（最近改的排前面），取不到时间的排最后 */
function byMtimeDesc(root: string, files: string[]): string[] {
  const stamped = files.map((f) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(root, f)).mtimeMs;
    } catch {
      // 取不到就当 0
    }
    return { f, mtime };
  });
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.map((s) => s.f);
}

/**
 * search 插件：两个只读检索工具（safe，无需审批）。
 * - glob：按文件名模式找文件（`**\/*.ts`、`src/*.md`）
 * - grep：按正则搜文件内容，可用 glob 限定范围、忽略大小写、切换输出模式
 */
export function searchPlugin(): Plugin {
  return {
    name: 'search',
    setup(ctx) {
      const { workspace } = ctx;

      const listFiles = (): string[] => {
        const files: string[] = [];
        walk(workspace, workspace, files);
        return files;
      };

      const glob: Tool = {
        name: 'glob',
        // 只读检索：本回合内同样的 pattern 再来一次直接复用结果（写文件后缓存会作废）
        cacheable: true,
        assess: safeAssess,
        description: '按文件名模式查找文件（支持 ** / * / ? / {a,b}），按最近修改排序',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string', description: '文件名模式，如 **/*.test.ts' } },
          required: ['pattern'],
        },
        run(args) {
          const pattern = String(args.pattern ?? '');
          if (!pattern) return { ok: false, content: 'glob 需要 pattern' };
          let re: RegExp;
          try {
            re = globToRegExp(pattern);
          } catch (e) {
            return { ok: false, content: `非法模式: ${pattern}（${(e as Error).message}）` };
          }

          let files: string[];
          try {
            files = listFiles();
          } catch (e) {
            return { ok: false, content: `遍历失败: ${(e as Error).message}` };
          }

          const hit = byMtimeDesc(workspace, files.filter((f) => re.test(f)));
          const shown = hit.slice(0, MAX_GLOB_RESULTS);
          const more = hit.length > shown.length ? `\n…还有 ${hit.length - shown.length} 个未显示` : '';
          return {
            ok: true,
            content: shown.length ? shown.join('\n') + more : '(无匹配文件)',
            meta: { action: 'searched', command: pattern, added: hit.length },
          };
        },
      };

      const grep: Tool = {
        name: 'grep',
        cacheable: true,
        assess: safeAssess,
        description:
          '按正则搜索文件内容；可选 glob 限定文件、ignoreCase 忽略大小写、mode=content|files|count',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: '正则表达式' },
            glob: { type: 'string', description: '限定搜索范围的文件名模式，如 *.ts' },
            ignoreCase: { type: 'boolean', description: '是否忽略大小写' },
            mode: {
              type: 'string',
              enum: ['content', 'files', 'count'],
              description: 'content=显示匹配行，files=只列文件，count=只统计条数',
            },
          },
          required: ['pattern'],
        },
        run(args) {
          const pattern = String(args.pattern ?? '');
          const globPattern = args.glob ? String(args.glob) : '';
          const mode = (args.mode === 'files' || args.mode === 'count' ? args.mode : 'content') as
            | 'content'
            | 'files'
            | 'count';
          let re: RegExp;
          try {
            re = new RegExp(pattern, args.ignoreCase ? 'i' : '');
          } catch {
            return { ok: false, content: `非法正则: ${pattern}` };
          }
          let fileRe: RegExp | null = null;
          if (globPattern) {
            try {
              fileRe = globToRegExp(globPattern);
            } catch {
              return { ok: false, content: `非法 glob: ${globPattern}` };
            }
          }

          let files: string[];
          try {
            files = listFiles();
          } catch (e) {
            return { ok: false, content: `遍历失败: ${(e as Error).message}` };
          }
          if (fileRe) files = files.filter((f) => fileRe!.test(f));

          const lines: string[] = [];
          const perFile = new Map<string, number>();
          let total = 0;
          let capped = false;
          outer: for (const rel of files) {
            let content: string;
            try {
              content = fs.readFileSync(path.join(workspace, rel), 'utf8');
            } catch {
              continue;
            }
            const rows = content.split('\n');
            for (let i = 0; i < rows.length; i++) {
              if (!re.test(rows[i])) continue;
              total++;
              perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
              if (mode === 'content') {
                lines.push(`${rel}:${i + 1}: ${rows[i].trim()}`);
                if (lines.length >= MAX_HITS) {
                  capped = true;
                  break outer;
                }
              }
            }
          }

          const meta = { action: 'searched' as const, command: pattern, added: total };
          if (mode === 'files') {
            const list = [...perFile.keys()];
            return { ok: true, content: list.length ? list.join('\n') : '(无匹配)', meta };
          }
          if (mode === 'count') {
            const rows = [...perFile.entries()].map(([f, n]) => `${f}: ${n}`);
            return {
              ok: true,
              content: rows.length ? `${rows.join('\n')}\n共 ${total} 处，${perFile.size} 个文件` : '(无匹配)',
              meta,
            };
          }
          const more = capped ? `\n…命中过多，仅显示前 ${lines.length} 条` : '';
          return { ok: true, content: lines.length ? lines.join('\n') + more : '(无匹配)', meta };
        },
      };

      ctx.tools.register(glob);
      ctx.tools.register(grep);
    },
  };
}
