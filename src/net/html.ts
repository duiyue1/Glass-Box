/** HTML → 纯文本。零依赖手写，不引 jsdom/readability。 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const direct = ENTITIES[name];
    if (direct) return direct;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** 去掉标签，保留段落感：块级标签换成换行，连续空行压成一个 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // 这些标签连内容一起丢掉
      .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // 块级边界变成换行
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, '\n')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '· ')
      // 其余标签直接剥掉
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 剥掉标签但不加换行（用于标题、摘要这类单行文本） */
export function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
