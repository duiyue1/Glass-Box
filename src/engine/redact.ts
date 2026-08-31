import type { Msg, ToolResult } from './types.ts';
import { blobRefOf, type BlobStore } from './blobs.ts';

/**
 * 脱敏：把图片的 base64 数据换成一句描述（可选带上 blob 引用）。
 *
 * 为什么必须有这一层：wire 是「黑匣子」，每个事件都会被记进 history、落进会话日志，
 * 而 Web UI 的每个新连接都会重放整段 history。一张 3MB 的图片进了事件流，
 * 就会在 llm.request / tool.result 里各存一份，并且发给每个新打开的浏览器。
 * 所以：真数据只走「模型请求」这条路，事件流里只留占位描述。
 *
 * 配了 BlobStore 时，占位描述里额外带上 `blob:<sha256>`，原图按内容哈希单独落盘。
 * 这样事件流依然很小，但回放时能把图片无损还原回来。
 */
export function redactImages(images: string[] | undefined, blobs?: BlobStore): string[] | undefined {
  if (!images?.length) return images;
  return images.map((d) => {
    const m = d.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return '[image]';
    // base64 长度 ≈ 原始字节 * 4/3
    const kb = Math.round((m[2].length * 3) / 4 / 1024);
    const ref = blobs ? ` blob:${blobs.put(d)}` : '';
    return `[image ${m[1]} ~${kb}KB${ref}]`;
  });
}

export function redactMsg(m: Msg, blobs?: BlobStore): Msg {
  return m.images?.length ? { ...m, images: redactImages(m.images, blobs) } : m;
}

export function redactMsgs(msgs: Msg[], blobs?: BlobStore): Msg[] {
  return msgs.map((m) => redactMsg(m, blobs));
}

export function redactResult(r: ToolResult, blobs?: BlobStore): ToolResult {
  return r.images?.length ? { ...r, images: redactImages(r.images, blobs) } : r;
}

/** 脱敏的逆操作：把占位串里的 blob 引用还原成原始 data URL（取不到就原样留着） */
export function restoreImages(images: string[] | undefined, blobs?: BlobStore): string[] | undefined {
  if (!images?.length || !blobs) return images;
  return images.map((s) => {
    const sha = blobRefOf(s);
    return (sha && blobs.get(sha)) || s;
  });
}

export function restoreMsgs(msgs: Msg[], blobs?: BlobStore): Msg[] {
  return msgs.map((m) => (m.images?.length ? { ...m, images: restoreImages(m.images, blobs) } : m));
}
