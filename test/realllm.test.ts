import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractActionCommand } from '../src/llm/realLlm.ts';
import { parseCommand } from '../src/llm/commandGrammar.ts';

test('抽取普通 ACTION 行', () => {
  assert.equal(extractActionCommand('ACTION: grep TurnState'), 'grep TurnState');
});

test('容忍代码块包裹', () => {
  assert.equal(extractActionCommand('```\nACTION: read package.json\n```'), 'read package.json');
  assert.equal(extractActionCommand('```text\nACTION: grep Wire\n```'), 'grep Wire');
});

test('容忍前置解释文字与中文冒号', () => {
  assert.equal(extractActionCommand('好的，我来搜索一下。\nACTION：grep foo'), 'grep foo');
});

test('纯文本回复返回 null', () => {
  assert.equal(extractActionCommand('这是对你问题的普通回答，没有工具调用。'), null);
});

test('抽取结果能被指令解析器识别', () => {
  const line = extractActionCommand('```\nACTION: edit a.txt ||| x ||| y\n```');
  assert.ok(line);
  const cmd = parseCommand(line!);
  assert.equal(cmd?.name, 'edit_file');
});

test('同一行粘了第二条 ACTION 时只取第一条', () => {
  // 实测过的脏输出：模型自我纠正，把两条指令挤在一行，整行当参数会污染工具
  assert.equal(
    extractActionCommand('ACTION: glob **/*StreamGate*ACTION: glob **/*streamgate*'),
    'glob **/*StreamGate*',
  );
});

test('模型自己编造【工具结果】续写时，参数被截断到干净处', () => {
  // 实测过的脏输出：path 里带着模型预测的下一轮内容
  assert.equal(
    extractActionCommand('ACTION: read src/engine/types.ts【工具结果】`src/engine/types.ts` 内容如下：'),
    'read src/engine/types.ts',
  );
  // 变体：模型不带方括号，直接写「工具结果：」
  assert.equal(
    extractActionCommand('ACTION: grep TurnState in *工具结果：src/engine/types.ts:12: export type TurnState'),
    'grep TurnState in *',
  );
});

test('正常搜索“工具结果”四个字不会被误截', () => {
  assert.equal(extractActionCommand('ACTION: grep 工具结果'), 'grep 工具结果');
});

test('去掉指令尾部残留的反引号与空白', () => {
  assert.equal(extractActionCommand('ACTION: read src/llm/streamGate.ts` '), 'read src/llm/streamGate.ts');
});
