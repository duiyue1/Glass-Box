import type { Fetcher } from './http.ts';
import { inlineText } from './html.ts';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  name: string;
  search(query: string, limit: number, fetcher: Fetcher): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; error: string }>;
}

/** 结果页太大，给搜索单独放宽字节上限（正文抓取仍用 GB_WEB_MAX_KB） */
const SERP_MAX_BYTES = 512 * 1024;

/** 从 Bing 的 <li class="b_algo"> 块里抽标题/URL/摘要 */
export function parseBing(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  for (const b of blocks) {
    const link = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const snippet = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    hits.push({
      title: inlineText(link[2]),
      url: link[1],
      snippet: snippet ? inlineText(snippet[1]) : '',
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 从 DuckDuckGo HTML 版结果页里抽标题/URL/摘要（真实链接藏在 uddg 参数里） */
export function parseDdg(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    inlineText(m[1]),
  );
  let i = 0;
  for (const m of html.matchAll(re)) {
    let url = m[1];
    if (url.startsWith('//')) url = `https:${url}`;
    // DDG 用 /l/?uddg=<encoded> 做跳转，真实地址在参数里
    try {
      const real = new URL(url).searchParams.get('uddg');
      if (real) url = real;
    } catch {
      // 解不出来就用原样
    }
    hits.push({ title: inlineText(m[2]), url, snippet: snippets[i] ?? '' });
    i++;
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 结果页疑似被反爬拦下（验证码/异常提示），单独识别出来提示用户 */
function looksBlocked(html: string): boolean {
  return /captcha|verify you are human|anomaly|unusual traffic|访问异常|人机验证/i.test(html.slice(0, 4000));
}

const bing: SearchBackend = {
  name: 'bing',
  async search(query, limit, fetcher) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(limit, 10)}`;
    const res = await fetcher(url, { maxBytes: SERP_MAX_BYTES });
    if (!res.ok) return { ok: false, error: res.error };
    const hits = parseBing(res.text, limit);
    if (!hits.length) {
      return { ok: false, error: looksBlocked(res.text) ? '搜索引擎返回了人机验证页面' : '没有解析到结果（页面结构可能已变）' };
    }
    return { ok: true, hits };
  },
};

const ddg: SearchBackend = {
  name: 'duckduckgo',
  async search(query, limit, fetcher) {
    const res = await fetcher('https://html.duckduckgo.com/html/', {
      form: { q: query },
      maxBytes: SERP_MAX_BYTES,
    });
    if (!res.ok) return { ok: false, error: res.error };
    const hits = parseDdg(res.text, limit);
    if (!hits.length) {
      return { ok: false, error: looksBlocked(res.text) ? '搜索引擎返回了人机验证页面' : '没有解析到结果（页面结构可能已变）' };
    }
    return { ok: true, hits };
  },
};

export const BACKENDS: Record<string, SearchBackend> = { bing, ddg, duckduckgo: ddg };

/**
 * 选后端：默认 bing（在国内网络可直连），GB_SEARCH_PROVIDER=ddg 换 DuckDuckGo。
 * 两者都不需要 key——代价是依赖 HTML 结构，所以解析失败要说清"可能是结构变了"。
 */
export function pickBackend(): SearchBackend {
  const want = (process.env.GB_SEARCH_PROVIDER ?? 'bing').toLowerCase();
  return BACKENDS[want] ?? bing;
}
