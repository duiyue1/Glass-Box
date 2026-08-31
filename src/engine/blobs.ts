import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * BlobStore：按内容哈希存放大块二进制（目前只有图片的 data URL）。
 *
 * 为什么要它：wire 是黑匣子，每个事件都会落盘、还会重放给每个新连接的浏览器。
 * 一张 3MB 的图直接进事件流，会在 llm.request / tool.result / turn.end 里各存一份。
 * 所以事件流里只留一个 blob 引用，原图单独存——事件流保持小，回放又能拿回原图（无损）。
 * 按内容哈希命名顺带解决去重：同一张图反复出现只占一份磁盘。
 */
export interface BlobStore {
  /** 存入并返回 sha256（十六进制） */
  put(dataUrl: string): string;
  /** 按 sha256 取回原始 data URL；取不到返回 undefined */
  get(sha: string): string | undefined;
}

export class FileBlobStore implements BlobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  put(dataUrl: string): string {
    const sha = crypto.createHash('sha256').update(dataUrl).digest('hex');
    const file = path.join(this.dir, `${sha}.b64`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // 同样的内容只写一次
      if (!fs.existsSync(file)) fs.writeFileSync(file, dataUrl);
    } catch {
      // 落盘失败不影响本次运行，只是这张图之后回放不出来
    }
    return sha;
  }

  get(sha: string): string | undefined {
    try {
      return fs.readFileSync(path.join(this.dir, `${sha}.b64`), 'utf8');
    } catch {
      return undefined;
    }
  }
}

/** 内存实现，供测试用 */
export class MemoryBlobStore implements BlobStore {
  private map = new Map<string, string>();

  put(dataUrl: string): string {
    const sha = crypto.createHash('sha256').update(dataUrl).digest('hex');
    this.map.set(sha, dataUrl);
    return sha;
  }

  get(sha: string): string | undefined {
    return this.map.get(sha);
  }
}

/** 从占位串 `[image image/png ~3KB blob:<sha>]` 里取出 sha */
export function blobRefOf(placeholder: string): string | undefined {
  return placeholder.match(/blob:([0-9a-f]{64})/)?.[1];
}
