import type { Plugin } from '../engine/plugin.ts';
import type { Tool, ToolOutput } from '../engine/types.ts';
import { fetchText, extractUrl, urlIssue, type Fetcher } from '../net/http.ts';
import { htmlToText } from '../net/html.ts';
import { pickBackend } from '../net/search.ts';

export interface WebPluginOptions {
  /** 注入的取页函数（测试用，默认走真实网络） */
  fetcher?: Fetcher;
  /** 只给 web_fetch，不给 web_search（受限子 agent 用） */
  fetchOnly?: boolean;
}

function limitFromEnv(): number {
  return Math.max(1, Number(process.env.GB_SEARCH_RESULTS ?? 5));
}

function maxTextChars(): number {
  return Number(process.env.GB_WEB_MAX_KB ?? 40) * 1024;
}

/**
 * 清洗查询词。模型经常把自己的解释/道歉直接粘进 query：
 *   "北京 天气 实时 中国天气网 2026年8月15日目前搜索结果仍没有返回可用的…建议你直接查看…"
 * 这种长句喂给搜索引擎会把结果带偏（实测把"北京天气"带成了"北京市_百度百科"）。
 * 规则很朴素：只要第一行、遇到句末标点就停、丢掉超过 20 字的"词"（那是散文不是关键词）、最多 8 个词。
 */
export function cleanQuery(raw: string): string {
  let q = raw.split('\n')[0].trim();
  const stop = q.search(/[。！？；]/);
  if (stop > 0) q = q.slice(0, stop);
  const tokens: string[] = [];
  for (const t of q.split(/\s+/)) {
    if (!t) continue;
    if (t.length > 20) break; // 一个超长“词”= 模型的解释文字粘上来了
    tokens.push(t);
    if (tokens.length >= 8) break;
  }
  return tokens.join(' ').slice(0, 80);
}

/** 归一化用于判重：忽略空格与常见标点 */
function normQuery(q: string): string {
  return q.toLowerCase().replace(/[\s，,。.、:：!！?？"'“”()（）\-_]/g, '');
}

/**
 * web 插件：给 agent 联网能力。
 * - web_search：爬搜索引擎结果页（零 key），返回 标题/URL/摘要
 * - web_fetch：抓单个网页正文（HTML → 纯文本）
 *
 * 两者都是 confirm 级：查询词和访问行为都会流向第三方，不该静默发生。
 * 内网/本机地址是硬边界，审批也放不过去（见 net/http.ts 的 urlIssue）。
 * GB_WEB=0 可整体关闭联网能力。
 */
export function webPlugin(opts: WebPluginOptions = {}): Plugin {
  const fetcher = opts.fetcher ?? fetchText;

  return {
    name: 'web',
    setup(ctx) {
      if (process.env.GB_WEB === '0') return; // 一键断网

      const wire = ctx.wire;
      // 同一会话内同一个 URL 只抓一次：省步数、省 token，也少打扰对方站点
      const cache = new Map<string, ToolOutput>();
      // 本回合搜过的查询（归一化）与搜索次数。换措辞重搜同一件事不会有新结果，只会烧步数。
      let searched = new Set<string>();
      let searchCount = 0;
      const searchBudget = Math.max(1, Number(process.env.GB_SEARCH_MAX_PER_TURN ?? 2));
      // 按回合重置：跨回合当然允许重新搜（用户可能真的在问新问题）
      wire.subscribe((ev) => {
        if (ev.type === 'turn.start') {
          searched = new Set();
          searchCount = 0;
        }
      });

      const report = (url: string, ok: boolean, ms: number, extra: { status?: number; bytes?: number; note?: string }) => {
        wire.emit({ type: 'web.request', url, ok, ms, ...extra, ts: Date.now() });
      };

      const backend = pickBackend();

      const webSearch: Tool = {
        name: 'web_search',
        description: '用搜索引擎搜全网，返回若干条 标题/链接/摘要（需要联网，会把查询词发给搜索引擎）',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词，3~8 个词，不要带解释文字' },
            limit: { type: 'number', description: '返回条数上限' },
          },
          required: ['query'],
        },
        assess(args) {
          const q = cleanQuery(String(args.query ?? ''));
          return {
            level: 'confirm',
            summary: `联网搜索: ${q}`,
            reason: `查询词会发送到 ${backend.name}`,
          };
        },
        async run(args) {
          const query = cleanQuery(String(args.query ?? ''));
          if (!query) return { ok: false, content: 'web_search 需要 query' };
          const limit = Number(args.limit ?? limitFromEnv());

          const key = normQuery(query);
          if (searched.has(key)) {
            return {
              ok: false,
              content:
                `未执行：本回合已经搜过「${query}」了，换关键词也是同样的结果。` +
                `如果需要具体数值/事实，请用 fetch 打开上一批结果里的某个链接读正文。`,
            };
          }
          if (searchCount >= searchBudget) {
            return {
              ok: false,
              content:
                `未执行：本回合搜索次数已用完（上限 ${searchBudget} 次）。` +
                `搜索只能给标题和摘要，现在请用 fetch 打开前面结果里最相关的链接读正文，再据此回答。`,
            };
          }
          searched.add(key);
          searchCount++;

          const started = Date.now();
          const res = await backend.search(query, limit, fetcher);
          const ms = Date.now() - started;

          if (!res.ok) {
            report(`search:${backend.name}?q=${query}`, false, ms, { note: res.error });
            return { ok: false, content: `搜索失败（${backend.name}）：${res.error}` };
          }
          report(`search:${backend.name}?q=${query}`, true, ms, { note: `${res.hits.length} 条` });

          const lines = res.hits.map(
            (h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`,
          );
          return {
            ok: true,
            content:
              `搜索「${query}」（来源 ${backend.name}）：\n${lines.join('\n')}\n\n` +
              `以上只是标题和摘要。要给出具体数值/事实，请用 fetch 打开对应链接读正文，不要凭摘要推测。`,
            meta: { action: 'searched', command: query, added: res.hits.length },
          };
        },
      };

      const webFetch: Tool = {
        name: 'web_fetch',
        description: '抓取一个网页并转成纯文本（需要联网）',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '纯 URL，不要跟任何说明文字' } },
          required: ['url'],
        },
        assess(args) {
          const raw = String(args.url ?? '');
          const url = extractUrl(raw) ?? raw;
          const issue = urlIssue(url);
          if (issue) {
            return { level: 'dangerous', summary: `抓取网页: ${url}`, reason: `${issue}（将被直接拒绝）` };
          }
          return { level: 'confirm', summary: `抓取网页: ${url}`, reason: '会向该站点发起请求' };
        },
        async run(args) {
          const raw = String(args.url ?? '');
          // 严格只取 ASCII URL 字符集：模型常把中文说明粘在 URL 后面
          const url = extractUrl(raw);
          if (!url) return { ok: false, content: `没能从参数里找到合法 URL: ${raw}` };

          // 硬边界在工具层也查一次：fetchText 内部虽然会逐跳复查，
          // 但注入别的 fetcher（测试/将来替换）时那道锁就没了。
          const issue = urlIssue(url);
          if (issue) {
            report(url, false, 0, { note: issue });
            return { ok: false, content: `拒绝：${issue}` };
          }

          const cached = cache.get(url);
          if (cached) {
            report(url, true, 0, { note: '命中会话缓存' });
            return cached;
          }

          const res = await fetcher(url, { maxBytes: maxTextChars() });
          if (!res.ok) {
            report(url, false, res.ms, { status: res.status, note: res.error });
            return { ok: false, content: `抓取失败 ${url}：${res.error}` };
          }
          report(url, true, res.ms, { status: res.status, bytes: res.bytes });

          let text = htmlToText(res.text);
          const limit = maxTextChars();
          let note = '';
          if (res.truncated) note = `\n\n（注意：已达 ${Math.round(limit / 1024)}KB 下载上限，页面未取完）`;
          if (text.length > limit) {
            text = text.slice(0, limit);
            note = `\n\n（注意：正文超过 ${Math.round(limit / 1024)}KB，以上为截断内容）`;
          }

          const out: ToolOutput = {
            ok: true,
            content: `${res.url}\n\n${text}${note}`,
            meta: { action: 'fetched', url: res.url, added: Math.round(res.bytes / 1024) },
          };
          cache.set(url, out);
          return out;
        },
      };

      if (!opts.fetchOnly) ctx.tools.register(webSearch);
      ctx.tools.register(webFetch);
    },
  };
}
