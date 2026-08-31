/**
 * 检索查询的构造。
 *
 * 之前是把用户原话整句丢给 BM25，两个问题：
 * 1. 口语词（"帮我""看看""是什么"）也参与打分，把真正的关键词稀释了
 * 2. 指代完全失效——第二轮问「它的重试策略呢」，句子里没有任何实词能命中
 *
 * 这里做两件事：去停用词、必要时借上一轮的关键词兜底。
 * 都是纯字符串处理，不需要模型参与。
 */

/**
 * 中文口语/功能词。只在构造查询时去掉，原文和索引不动。
 *
 * 单字词这里只留「的/了/吗/呢/吧/啊/呀」和单字代词。原来还有「过/地/得/着」，
 * 但停用词是按正则直接抹的、不认词边界，于是把实词切坏了：
 *   「跳过率」→「跳 率」、「租约过期」→「租约 期」、「地址」→「址」。
 * 中文索引是 2-gram，被抹掉一个字的词连一个 bigram 都对不上，关键词等于从查询里消失。
 *
 * 「的/了」为什么留在表里：实测（npm run eval:kb）去掉它们对召回更好——
 * 连接词会带出「的重」「了之」这类到处都能对上的 bigram，把 IDF 稀释掉。
 * 这类判断不再靠直觉，改一次就跑一次检索层评测。
 */
const STOP =
  /(帮我|帮忙|请问|请|麻烦|一下|看一看|看看|查一下|告诉我|我想|我要|我需要|能不能|可不可以|可以|是什么|什么是|有什么|怎么样|怎么办|怎么|如何|为什么|为啥|哪些|哪个|哪里|多少|几点|是否|吗|呢|吧|啊|呀|的|了|这个|那个|这些|那些|然后|以及|还有|目前|现在|我们|你们|他们|它们|我|你|他|她|它)/g;


/** 英文停用词，同理 */
const STOP_EN = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'what', 'which', 'how',
  'why', 'when', 'where', 'who', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'me', 'my', 'i', 'you',
  'it', 'this', 'that', 'please', 'tell', 'show', 'can', 'could', 'would', 'should', 'about',
]);

/** 去停用词，不做兜底——可能返回空串 */
function stripStop(text: string): string {
  return text
    .replace(STOP, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_EN.has(w.toLowerCase()))
    .join(' ')
    .trim();
}

/** 去掉停用词后的查询文本。全被去掉时退回原文（宁可噪音，也别得到空查询）。 */
export function normalizeQuery(text: string): string {
  return stripStop(text) || text.trim();
}

/**
 * 提取「有信息量的词」，用来在下一轮做指代兜底。
 * 中文取去停用词后长度 >= 2 的连续串，英文取长度 >= 2 的词。最多留 8 个。
 *
 * 这里用不兜底的 stripStop：整句都是停用词时就该返回空，
 * 否则「它呢」会被当成关键词传给下一轮，把话题链带偏。
 */
export function keywordsOf(text: string): string[] {
  const norm = stripStop(text);
  const out: string[] = [];
  for (const run of norm.match(/[\u4e00-\u9fff]{2,}/g) ?? []) out.push(run);
  for (const w of norm.toLowerCase().match(/[a-z0-9_.-]{2,}/g) ?? []) {
    if (!STOP_EN.has(w)) out.push(w);
  }
  return [...new Set(out)].slice(0, 8);
}

/** 判断这句话自己够不够检索：实词太少就说明它在指代前文 */
function informative(text: string): number {
  const norm = stripStop(text);
  const zh = (norm.match(/[\u4e00-\u9fff]{2,}/g) ?? []).join('').length;
  const en = (norm.match(/[a-z0-9_.-]{2,}/gi) ?? []).length;
  return zh + en * 2;
}

/**
 * 指代标记。
 * 「它的重试策略呢」去掉停用词后剩「重试策略」，字数上够检索了，
 * 但主语在上一轮——所以光看实词多少不够，还要看有没有指代词。
 */
const ANAPHORA = /(它|他|她|它们|他们|她们|这个|那个|这些|那些|上面|上述|前面|刚才|刚说|之前|同样|继续)/;

export interface BuiltQuery {
  /** 真正拿去检索的字符串 */
  query: string;
  /** 这一轮抽出来的关键词，调用方存着给下一轮兜底 */
  keywords: string[];
  /** 是否借用了上一轮的关键词 */
  usedPrev: boolean;
}

/**
 * 构造检索查询。
 * prev 是上一轮的关键词；本轮实词过少、或者句子里有指代词时，把它拼进来。
 */
export function buildQuery(userText: string, prev: readonly string[] = []): BuiltQuery {
  const keywords = keywordsOf(userText);
  const base = normalizeQuery(userText);
  const needsContext = informative(userText) < 4 || ANAPHORA.test(userText);
  const usedPrev = needsContext && prev.length > 0;
  return {
    query: usedPrev ? `${base} ${prev.join(' ')}`.trim() : base,
    // 本轮没有实词时，把上一轮的关键词继续传下去，免得话题链断掉
    keywords: keywords.length ? keywords : [...prev],
    usedPrev,
  };
}
