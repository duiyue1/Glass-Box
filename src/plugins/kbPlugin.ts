import type { Plugin } from '../engine/plugin.ts';
import type { Llm } from '../engine/loop.ts';
import { safeAssess, type Tool } from '../engine/types.ts';
import { formatHits, type KbBudget, type KbStore } from '../kb/store.ts';
import type { WikiStore } from '../kb/wikiStore.ts';

/**
 * kb 插件：把资料库变成模型可以主动调用的工具。
 *
 * 之前资料库只有「被动注入」——每回合按提问检索几段塞进上下文。够用，但模型没法：
 *   换个关键词再查一次、翻到某一章看全文、明确说"资料库里没有这个"。
 *
 * 对齐 AI-Ku MCP 那组文档工具的最小集合：
 *   kb_search ≈ doc_search（检索片段）
 *   kb_read   ≈ doc_content（读指定文档/章节的完整内容）
 *   kb_answer ≈ doc_rag（检索 + 只按资料作答，附来源）
 *
 * 三个都是只读的 safe 工具，不需要审批。
 */

/** 单次工具返回的正文上限：够读，又不至于一次把上下文吃光 */
const MAX_TOOL_CHARS = 6000;

function clip(s: string, n = MAX_TOOL_CHARS): string {
  return s.length > n ? s.slice(0, n) + `\n…（截断，还有 ${s.length - n} 字，可用 part 参数继续读）` : s;
}

export function kbPlugin(store: KbStore, budget: KbBudget, llm?: Llm, wiki?: WikiStore): Plugin {
  return {
    name: 'kb',
    setup(ctx) {
      const kbSearch: Tool = {
        name: 'kb_search',
        assess: safeAssess,
        description:
          '在用户导入的资料库里检索片段。适合"文档里怎么说的"这类问题；查不到会明确告诉你查不到，不要凭印象编。可用 doc / section 把范围限定到某一篇或某一章。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '检索关键词，用文档里可能出现的术语，别用口语句子' },
            doc: { type: 'string', description: '只在这篇文档里搜（标题或 id，支持部分匹配）' },
            section: { type: 'string', description: '只在标题路径含这个词的章节里搜，如 "分布式锁"' },
            topK: { type: 'number', description: '最多返回几段，默认 5，上限 10' },
          },
          required: ['query'],
        },
        run(args) {
          const query = String(args.query ?? '').trim();
          if (!query) return { ok: false, content: 'kb_search 需要 query' };
          const topK = Math.min(10, Math.max(1, Number(args.topK) || 5));
          const filter = {
            ...(args.doc ? { doc: String(args.doc) } : {}),
            ...(args.section ? { section: String(args.section) } : {}),
          };
          // 明确限定了范围就不再用相对阈值和每篇上限卡——调用方已经说清要在哪找了
          const scoped = Boolean(filter.doc || filter.section);
          const res = store.search(
            query,
            { ...budget, maxItems: topK, maxTokens: 4000, ...(scoped ? { minScoreRatio: 0, perDoc: topK } : {}) },
            filter,
          );
          if (!res.items.length) {
            const total = store.docCount();
            if (!total) return { ok: true, content: '资料库是空的，用户还没导入任何资料。' };
            const where = [filter.doc && `《${filter.doc}》`, filter.section && `章节含「${filter.section}」`]
              .filter(Boolean)
              .join(' · ');
            return {
              ok: true,
              content: where
                ? `${where} 里没有和「${query}」相关的内容。换个术语，或者去掉范围限制再试。`
                : `资料库里没有和「${query}」相关的内容（共 ${total} 篇资料）。换个术语再试，或者告诉用户资料里没有。`,
              meta: { action: 'searched', command: query, added: 0 },
            };
          }
          return {
            ok: true,
            content: clip(formatHits(res.items)),
            meta: { action: 'searched', command: query, added: res.items.length },
          };
        },
      };

      const kbRead: Tool = {
        name: 'kb_read',
        assess: safeAssess,
        description:
          '读资料库的内容。page=<ref> 读一条已整理好的 wiki 条目（知识目录里列的那些，最省 token）；' +
          'doc=<标题> 读原文，可用 section 限定章节、part 翻页；两个都不给就列出所有文档和章节。',
        parameters: {
          type: 'object',
          properties: {
            page: { type: 'string', description: 'wiki 条目的 ref，如 "concept/分布式锁"（知识目录里列的那个）' },
            doc: { type: 'string', description: '文档标题或 id，支持部分匹配；省略则列出全部文档' },
            section: { type: 'string', description: '章节标题的一部分，如 "分布式锁"' },
            part: { type: 'number', description: '内容很长时翻页，从 1 开始' },
          },
        },
        run(args) {
          const pageArg = String(args.page ?? '').trim();
          const docArg = String(args.doc ?? '').trim();

          // 读 wiki 条目：目录里给的是 ref，模型顺着 ref 拉正文，这是"给指针"的另一半。
          // 没启用 wiki 时说清楚原因，不要静默退化成读原文——那会让模型以为条目不存在。
          if (pageArg) {
            if (!wiki) return { ok: false, content: '当前没有启用知识目录（GB_WIKI=0），改用 doc 读原文。' };
            const page = wiki.read(pageArg);
            if (!page) {
              const refs = wiki.list().map((p) => p.ref).join('、') || '(空)';
              return { ok: false, content: `没有条目 ${pageArg}。现有条目：${refs}` };
            }
            const head = [
              `【条目】${page.ref}${page.verified ? '' : '（⚠未通过溯源校验，正文里的数字不可信）'}`,
              page.summary ? `【摘要】${page.summary}` : '',
              `【依据原文块】${page.sources.join('、') || '（未记录）'}`,
            ]
              .filter(Boolean)
              .join('\n');
            return {
              ok: true,
              content: clip(`${head}\n${page.body}`),
              meta: { action: 'read', path: page.ref, added: page.sources.length },
            };
          }

          // 不给 doc：列清单（模型先看有什么，再决定读哪篇）
          if (!docArg) {
            const docs = store.list().filter((d) => d.status === 'active');
            if (!docs.length) return { ok: true, content: '资料库是空的。' };
            const lines = docs.map((d) => {
              const sections = [...new Set(store.chunksOf(d.id).map((c) => c.headingPath))]
                .filter(Boolean)
                .slice(0, 12);
              return `《${d.title}》v${d.version} · ${d.chunks} 块 · ${d.chars} 字\n  章节: ${sections.join(' | ') || '(无小标题)'}`;
            });
            return { ok: true, content: clip(lines.join('\n')), meta: { action: 'searched', command: 'kb_read', added: docs.length } };
          }

          const doc = store.find(docArg);
          if (!doc) {
            const names = store.list().map((d) => d.title).join('、') || '(空)';
            return { ok: false, content: `资料库里没有《${docArg}》。现有：${names}` };
          }
          const section = args.section ? String(args.section) : undefined;
          const chunks = store.chunksOf(doc.id, section);
          if (!chunks.length) {
            const all = [...new Set(store.chunksOf(doc.id).map((c) => c.headingPath))].filter(Boolean);
            return { ok: false, content: `《${doc.title}》里没有匹配「${section}」的章节。现有章节：${all.join(' | ')}` };
          }

          const body = chunks.map((c) => `--- ${c.headingPath || doc.title} ---\n${c.text}`).join('\n');
          // 翻页：按字符切，边界不追求好看，够用就行
          const part = Math.max(1, Number(args.part) || 1);
          const start = (part - 1) * MAX_TOOL_CHARS;
          if (start >= body.length && part > 1) {
            return { ok: true, content: `《${doc.title}》没有第 ${part} 页了（共 ${Math.ceil(body.length / MAX_TOOL_CHARS)} 页）。` };
          }
          const slice = body.slice(start, start + MAX_TOOL_CHARS);
          const pages = Math.ceil(body.length / MAX_TOOL_CHARS);
          const tail = pages > 1 ? `\n（第 ${part}/${pages} 页${part < pages ? `，继续读传 part=${part + 1}` : ''}）` : '';
          return {
            ok: true,
            content: `《${doc.title}》v${doc.version}${section ? ` · 章节匹配「${section}」` : ''}\n${slice}${tail}`,
            meta: { action: 'read', path: doc.title, added: chunks.length },
          };
        },
      };

      ctx.tools.register(kbSearch);
      ctx.tools.register(kbRead);

      // kb_answer 需要再问一次模型，没有 llm 就不注册这个工具
      if (!llm) return;

      const kbAnswer: Tool = {
        name: 'kb_answer',
        assess: safeAssess,
        description:
          '只根据资料库内容回答一个具体问题，返回答案和来源。适合"严格按文档回答、不要掺入常识"的场合；资料里没有会直说。',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要回答的问题' } },
          required: ['question'],
        },
        async run(args) {
          const question = String(args.question ?? '').trim();
          if (!question) return { ok: false, content: 'kb_answer 需要 question' };
          const res = store.search(question, { ...budget, maxItems: 8, maxTokens: 3000 });
          if (!res.items.length) return { ok: true, content: `资料库里找不到回答「${question}」所需的内容。` };

          const sources = [...new Set(res.items.map((i) => i.chunk.headingPath || i.chunk.title))];
          const out = await llm.complete([
            {
              role: 'system',
              content:
                '你是资料库问答器。只根据【资料】回答，不要用资料之外的知识，不要猜。' +
                '资料没提到就回答"资料里没有写"。回答简短、直给结论，并在末尾用「来源：」列出用到的章节标题。',
            },
            { role: 'user', content: `【资料】\n${formatHits(res.items)}\n\n【问题】${question}` },
          ]);
          const text = (out.text ?? '').trim();
          if (!text) return { ok: false, content: '资料库问答没拿到回复（模型返回为空）' };
          return {
            ok: true,
            content: `${text}\n\n（检索到 ${res.items.length} 段，来源：${sources.join(' | ')}）`,
            meta: { action: 'searched', command: question, added: res.items.length },
          };
        },
      };

      ctx.tools.register(kbAnswer);
    },
  };
}
