/**
 * StreamGate：流式输出的"闸门"。
 *
 * 问题：模型流式返回时，我们事先不知道这轮是「要调工具（ACTION: ...）」还是「给用户的文本」。
 * 如果无脑把每个 token 都打给用户，`ACTION: grep xxx` 这种内部指令就会漏到屏幕上。
 *
 * 做法：先攒一小段再决定——
 *   - 攒到换行、或攒够 DECIDE_AT 个字符、或流结束时做判定；
 *   - 判定为 ACTION（内部指令）-> 整轮都不显示；
 *   - 判定为普通文本 -> 把攒的内容一次吐出，之后的 token 直接放行。
 */
const DECIDE_AT = 64;

export class StreamGate {
  private buf = '';
  private decided = false;
  private suppress = false;

  /** 喂入一段增量，返回"应当显示给用户"的文本（可能为空字符串） */
  push(chunk: string): string {
    if (this.decided) return this.suppress ? '' : chunk;

    this.buf += chunk;
    if (this.buf.includes('\n') || this.buf.length >= DECIDE_AT) return this.decide();
    return '';
  }

  /** 流结束时调用：如果还没判定，就在这里判定并吐出剩余内容 */
  flush(): string {
    if (this.decided) return '';
    return this.decide();
  }

  private decide(): string {
    this.decided = true;
    const probe = this.buf.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trimStart();
    if (/^action\s*[:：]/i.test(probe)) {
      this.suppress = true;
      this.buf = '';
      return '';
    }
    const out = this.buf;
    this.buf = '';
    return out;
  }

  /** 本轮是否判定为内部指令（不显示） */
  isSuppressed(): boolean {
    return this.suppress;
  }
}
