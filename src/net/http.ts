/**
 * 极简 HTTP 取文本：零依赖（Node 内置 fetch），但把 agent 联网必须有的几道闸门都装上：
 * 超时、字节上限、手动跟随重定向、以及每一跳都复查的内网/本机地址拦截（SSRF）。
 */

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** 表单式 POST 的 body（用于某些搜索端点） */
  form?: Record<string, string>;
}

export interface FetchOk {
  ok: true;
  status: number;
  /** 最终 URL（跟随重定向后） */
  url: string;
  text: string;
  bytes: number;
  truncated: boolean;
  ms: number;
}

export interface FetchErr {
  ok: false;
  error: string;
  status?: number;
  url: string;
  ms: number;
}

export type FetchResult = FetchOk | FetchErr;
export type Fetcher = (url: string, opts?: FetchOptions) => Promise<FetchResult>;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * 内网 / 本机 / 云元数据地址。命中就直接拒绝——不经过人类审批。
 * 理由和凭证黑名单一样：「让 agent 帮我看下这个内网地址」听起来永远是合理的。
 */
const BLOCKED_HOST: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // 云元数据 169.254.169.254
  /^::1$/,
  /^\[::1\]$/,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.corp$/i,
  /(^|\.)baidu-int\.com$/i, // 公司内网域名
];

export function hostBlocked(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return BLOCKED_HOST.some((r) => r.test(h));
}

/** URL 可访问性检查。返回 null 表示可以访问，否则返回拒绝原因。 */
export function urlIssue(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `不是合法的 URL: ${raw}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `只允许 http/https，拒绝 ${u.protocol}`;
  if (hostBlocked(u.hostname)) return `拒绝访问内网/本机地址: ${u.hostname}`;
  return null;
}

/** 常见网页后缀，按长度倒序——判断"后缀是否被散文粘住"时必须先试长的（.html 优先于 .htm） */
const PAGE_EXT = ['.html', '.xhtml', '.aspx', '.yaml', '.json', '.htm', '.php', '.asp', '.jsp', '.md', '.txt', '.xml', '.pdf', '.yml'].sort(
  (a, b) => b.length - a.length,
);

/**
 * 从一段可能带解释文字的文本里抽出第一个 URL。
 * 只吃 URL 合法字符集（纯 ASCII），所以模型把中文说明粘在 URL 后面也能切干净。
 * 但纯 ASCII 的散文（"…typescript.htmlNode.js 的…"）靠字符集切不掉，
 * 再补一条：路径以常见网页后缀结尾、后面却紧跟字母时，就在后缀处断开。
 */
export function extractUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/);
  if (!m) return null;
  let url = m[0];
  const lower = url.toLowerCase();
  for (const ext of PAGE_EXT) {
    const i = lower.indexOf(ext);
    if (i <= 0) continue;
    // 同一位置若能匹配更长的后缀（.html 之于 .htm），说明这个短后缀只是它的前缀，跳过
    if (PAGE_EXT.some((e) => e.length > ext.length && lower.startsWith(e, i))) continue;
    const end = i + ext.length;
    // 后面还有字母 -> 散文粘上来了。（先试长后缀，避免把 .html 砍成 .htm）
    if (end < url.length && /[A-Za-z]/.test(url[end])) {
      url = url.slice(0, end);
      break;
    }
  }
  // 结尾的标点通常是句子的一部分，不属于 URL
  return url.replace(/[.,;:!?)'"]+$/, '');
}

/** 按字节上限读取响应体（超出即停，不把整个大文件拉下来） */
async function readCapped(resp: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!resp.body) return { text: await resp.text(), bytes: 0, truncated: false };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      const keep = value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes)));
      text += decoder.decode(keep);
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text, bytes, truncated };
}

/**
 * 取一个网页的文本内容。失败不抛异常，统一返回 FetchErr——
 * 工具层要把失败原样告诉模型，而不是让整个回合炸掉。
 */
export const fetchText: Fetcher = async (url, opts = {}) => {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? Number(process.env.GB_WEB_TIMEOUT_MS ?? 15000);
  const maxBytes = opts.maxBytes ?? Number(process.env.GB_WEB_MAX_KB ?? 40) * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // 每一跳都查：302 跳到 169.254.169.254 是最经典的绕过方式
    const issue = urlIssue(current);
    if (issue) return { ok: false, error: issue, url: current, ms: Date.now() - started };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(current, {
        method: opts.form ? 'POST' : 'GET',
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(opts.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
        redirect: 'manual',
        signal: ctrl.signal,
      });

      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        clearTimeout(timer);
        if (!loc) return { ok: false, error: `${resp.status} 重定向但没有 Location`, status: resp.status, url: current, ms: Date.now() - started };
        current = new URL(loc, current).toString();
        continue;
      }

      const { text, bytes, truncated } = await readCapped(resp, maxBytes);
      clearTimeout(timer);
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}`, status: resp.status, url: current, ms: Date.now() - started };
      }
      return { ok: true, status: resp.status, url: current, text, bytes, truncated, ms: Date.now() - started };
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e as Error).message;
      return { ok: false, error: msg, url: current, ms: Date.now() - started };
    }
  }
  return { ok: false, error: `重定向超过 ${maxRedirects} 次`, url: current, ms: Date.now() - started };
};
