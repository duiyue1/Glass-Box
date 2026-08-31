import { safeAssess, type Tool } from '../engine/types.ts';

/**
 * echo 工具：把输入原样返回。
 * 它存在的意义不是“有用”，而是用最简单的方式验证：
 * 模型 -> 引擎 -> 工具 -> 结果 -> 再回模型 这条完整链路是通的。
 */
export const echoTool: Tool = {
  name: 'echo',
  description: '原样返回输入文本，用于验证工具调用链路是否打通',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: '要原样返回的文本' } },
    required: ['text'],
  },
  assess: safeAssess,
  run(args) {
    const text = String(args.text ?? '');
    return { ok: true, content: text };
  },
};
