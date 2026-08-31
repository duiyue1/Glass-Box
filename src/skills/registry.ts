import fs from 'node:fs';
import path from 'node:path';
import { estimateText } from '../engine/tokens.ts';

/**
 * 技能的元信息——也就是"目录"里出现的那部分。
 * 正文**不在这里**：它按需才从磁盘读，这是渐进式加载的前提。
 */
export interface SkillSummary {
  name: string;
  description: string;
  /** 触发词。只用于 inject 模式（旧行为）与词边界匹配的对照实验 */
  triggers: string[];
  /** 这个技能的文件路径。给模型当"基准目录"的依据，也是截断后让它自己去读全文的去处 */
  file: string;
}

/** 加载后的技能：元信息 + 正文 */
export interface LoadedSkill extends SkillSummary {
  body: string;
  /** 正文超了 token 上限、被截过。必须如实报出去——模型只看到半篇指令是要记下来的事 */
  truncated: boolean;
  tokensEst: number;
}

/** 目录里单条描述的默认字符上限。抄 dsh 的 `catalogDescriptionMaxLength`（默认 500，下限 3 给省略号留位） */
export const DEFAULT_DESC_CHARS = 500;
/** 截断提示自己也要花 token，从正文预算里先扣出来 */
const TRUNCATE_RESERVE = 48;

/** 从一段 markdown 文本里解析出 frontmatter（--- 之间的 key: value）和正文 */
function parseSkill(raw: string): { name: string; description: string; triggers: string[]; body: string } {
  const meta: Record<string, string> = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    body = m[2];
  }
  return {
    name: meta.name ?? 'unnamed',
    description: meta.description ?? '',
    triggers: (meta.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    body: body.trim(),
  };
}

/** 描述压成一行并截到上限：目录是"每次请求都重发"的东西，长度必须可控 */
export function normalizeDesc(desc: string, maxChars = DEFAULT_DESC_CHARS): string {
  const one = desc.replace(/\s+/g, ' ').trim();
  const cap = Math.max(3, Math.floor(maxChars));
  return one.length > cap ? one.slice(0, cap - 1) + '…' : one;
}

/** XML 转义：目录和 `<skill_content>` 的 name 属性都要它，免得技能名里的引号把标记撑破 */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 正文按 token 上限截断。
 *
 * dsh 明确把"加载后的正文没有大小上限"列为已知限制（它只截目录描述），
 * 这里比它严：截断的同时告诉模型全文在哪个文件，它想看自己去 read_file。
 * 这是"资源是指引而非附件"那条原则的直接应用。
 */
function clipBody(body: string, file: string, maxTokens?: number): { body: string; truncated: boolean } {
  if (!maxTokens || maxTokens <= 0) return { body, truncated: false };
  if (estimateText(body) <= maxTokens) return { body, truncated: false };
  const budget = Math.max(1, maxTokens - TRUNCATE_RESERVE);
  const lines = body.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = estimateText(line + '\n');
    if (used + t > budget) break;
    kept.push(line);
    used += t;
  }
  const dropped = lines.length - kept.length;
  return {
    body:
      `${kept.join('\n')}\n\n[…正文超出 ${maxTokens} token 上限，后面 ${dropped} 行没给出。` +
      `需要全文就用 read_file 读 ${file}]`,
    truncated: true,
  };
}

/**
 * 把一个已加载的技能渲染成模型看到的形状。
 *
 * 两条加载路径（`skill` 工具 / 用户显式手势）**共用这一个函数**——不管谁发起的加载，
 * 模型看到的都得是同一种东西，否则回放时对不上账。这一点照抄 dsh 的 `renderSkillContent`。
 */
export function renderSkillContent(skill: LoadedSkill): string {
  const base = path.dirname(skill.file);
  return [
    `<skill_content name="${escapeText(skill.name)}">`,
    '<skill_resources>',
    `这个技能的基准目录：${base}`,
    '技能里提到的相对路径都相对它解析；只有真的引用到才去读，不要预读。',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');
}

/**
 * SkillRegistry：管 skills/ 目录下的 .md 技能包。
 *
 * **只在启动时把元信息（name / description / triggers）读进内存，正文一律按需加载。**
 * 这是 Claude Code / Codex / deepseek-harness 三家共有的做法（渐进式披露）：
 * 目录里只有摘要，模型判断相关了才调 `skill` 工具把整篇正文取回来。
 *
 * 正文**不缓存**——`get()` 每次重新读盘（同 dsh 的 `ctx.skills.get()`）。
 * 代价是多一次文件读，好处是会话中途改了技能文件立刻生效。
 */
export class SkillRegistry {
  private summaries: SkillSummary[] = [];
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  load(): void {
    this.summaries = [];
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f: string) => f.endsWith('.md'));
    } catch {
      return; // 没有 skills 目录就算了
    }
    for (const f of files.sort()) {
      const file = path.join(this.dir, f);
      try {
        const parsed = parseSkill(fs.readFileSync(file, 'utf8'));
        // 正文在这里就被丢掉：内存里留着它没用，真要用的时候也得重新读盘确认是最新的
        this.summaries.push({
          name: parsed.name,
          description: parsed.description,
          triggers: parsed.triggers,
          file,
        });
      } catch {
        // 跳过坏文件
      }
    }
  }

  list(): SkillSummary[] {
    return this.summaries;
  }

  /** 技能所在目录（面板/提示词里要显示它） */
  baseDir(): string {
    return this.dir;
  }

  /**
   * 渲染目录：只有 `name` 和截断后的 `description`。
   * 它会进 `skill` 工具的 description，也就是每次请求的固定开销之一，所以必须可控。
   */
  catalog(maxDescChars = DEFAULT_DESC_CHARS): string {
    return this.summaries
      .map((s) => `- \`${s.name}\`: ${normalizeDesc(s.description, maxDescChars)}`)
      .join('\n');
  }

  /**
   * 加载一个技能的完整正文。名字必须精确匹配（大小写不敏感兜一层，模型偶尔会大写开头）。
   * @param maxTokens 正文 token 上限，超了截断并如实标记
   */
  get(name: string, maxTokens?: number): LoadedSkill | undefined {
    const want = String(name ?? '').trim().toLowerCase();
    const found = this.summaries.find((s) => s.name.toLowerCase() === want);
    if (!found) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(found.file, 'utf8');
    } catch {
      return undefined; // 文件在这次会话里被删了
    }
    const parsed = parseSkill(raw);
    const clipped = clipBody(parsed.body, found.file, maxTokens);
    return {
      ...found,
      description: parsed.description || found.description,
      body: clipped.body,
      truncated: clipped.truncated,
      tokensEst: estimateText(clipped.body),
    };
  }

  /**
   * 用户显式手势：消息里出现 `/技能名`。
   * 对标 dsh 的 `/name` 入口——这是**用户点名要用**，不需要模型再判断一次，
   * 所以直接内联正文，省掉一个来回。
   *
   * 斜杠前必须是行首或空白（否则 `src/path/to` 这种也会命中），名字只吃 ASCII
   * （技能名是 kebab-case），这样中文里紧跟的标点和文字自然就是边界——
   * dsh 要求两侧都是空白，那条规则在中文输入里几乎永远不成立。
   */
  gestures(userText: string): SkillSummary[] {
    const names = new Set<string>();
    for (const m of String(userText ?? '').matchAll(/(?:^|\s)\/([A-Za-z0-9_.-]+)/g)) {
      names.add(m[1].toLowerCase());
    }
    if (!names.size) return [];
    return this.summaries.filter((s) => names.has(s.name.toLowerCase()));
  }

  /** 返回触发词命中用户输入的技能（不区分大小写） */
  match(userText: string): SkillSummary[] {
    const lower = userText.toLowerCase();
    return this.summaries.filter((s) => s.triggers.some((t) => this.hit(lower, t.toLowerCase())));
  }

  /**
   * 判断触发词是否命中：
   * - 纯英文/数字触发词 -> 按「词边界」匹配（避免 "cr" 命中 "script"）
   * - 含中文的触发词     -> 直接子串匹配
   */
  private hit(text: string, trigger: string): boolean {
    if (/^[a-z0-9 ]+$/.test(trigger)) {
      const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(text);
    }
    return text.includes(trigger);
  }
}
