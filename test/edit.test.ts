import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wire } from '../src/engine/wire.ts';
import { ToolRegistry } from '../src/engine/toolRegistry.ts';
import { fsPlugin } from '../src/plugins/fsPlugin.ts';

function setup(readOnly = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-edit-'));
  const tools = new ToolRegistry();
  fsPlugin({ readOnly }).setup({ tools, wire: new Wire(), workspace: dir });
  return { dir, tools };
}

test('edit_file 精确替换唯一匹配', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\nbye\n');
    const edit = tools.get('edit_file')!;
    const r = await edit.run({ path: 'a.txt', old: 'world', new: 'there' });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'hello\nthere\nbye\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file 对多处匹配拒绝执行', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'x\nx\n');
    const edit = tools.get('edit_file')!;
    const r = await edit.run({ path: 'b.txt', old: 'x', new: 'y' });
    assert.equal(r.ok, false);
    assert.match(r.content, /出现 2 次/);
    assert.match(r.content, /all: true/, '要告诉它有批量替换这条路，否则它只会反复试更长的上下文');
    // 文件未被改动
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'x\nx\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file all:true 一次改掉所有出现处', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'c.ts'), 'getCwd()\nconst a = getCwd\n// getCwd\n');
    const edit = tools.get('edit_file')!;
    const r = await edit.run({ path: 'c.ts', old: 'getCwd', new: 'getCurrentWorkingDirectory', all: true });
    assert.ok(r.ok);
    assert.match(r.content, /3 处/);
    assert.equal(
      fs.readFileSync(path.join(dir, 'c.ts'), 'utf8'),
      'getCurrentWorkingDirectory()\nconst a = getCurrentWorkingDirectory\n// getCurrentWorkingDirectory\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file 按字面替换：old 里的正则元字符不当模式解释', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'd.ts'), 'a.b(x)\na.b(x)\n');
    const edit = tools.get('edit_file')!;
    const r = await edit.run({ path: 'd.ts', old: 'a.b(x)', new: 'ok', all: true });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(path.join(dir, 'd.ts'), 'utf8'), 'ok\nok\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file 的 new 里带 $& 之类也照字面写入，不做替换模式展开', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'e.ts'), 'PLACEHOLDER\n');
    const edit = tools.get('edit_file')!;
    const r = await edit.run({ path: 'e.ts', old: 'PLACEHOLDER', new: 'cost: $& and $1' });
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(path.join(dir, 'e.ts'), 'utf8'), 'cost: $& and $1\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('批量替换的审批摘要要写清要动几处', () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'f.ts'), 'q\nq\nq\n');
    const a = tools.get('edit_file')!.assess!({ path: 'f.ts', old: 'q', new: 'r', all: true });
    assert.match(a.summary, /3 处/, '改 3 处和改 1 处风险不同，摘要上必须看得出来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file 的 assess 生成 diff 预览', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
    const edit = tools.get('edit_file')!;
    const a = edit.assess?.({ path: 'a.txt', old: 'beta', new: 'gamma' });
    assert.ok(a?.preview?.includes('- beta'));
    assert.ok(a?.preview?.includes('+ gamma'));
    assert.equal(a?.level, 'confirm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('只读模式不提供 edit_file / write_file', () => {
  const { dir, tools } = setup(true);
  try {
    assert.equal(tools.get('edit_file'), undefined);
    assert.equal(tools.get('write_file'), undefined);
    assert.ok(tools.get('read_file'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file 不许覆盖没读过的已存在文件', async () => {
  const { dir, tools } = setup();
  try {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, '原有内容\n');
    const write = tools.get('write_file')!;

    const r = await write.run({ path: 'a.txt', content: '新内容' });
    assert.equal(r.ok, false);
    assert.match(r.content, /还没读过/);
    assert.match(r.content, /edit_file/, '要给出可操作的出路');
    assert.equal(fs.readFileSync(p, 'utf8'), '原有内容\n', '拒绝就是一个字节都不能动');

    // assess 也要如实标成 dangerous：审批弹窗上必须看得见"这会被拒"
    const a = write.assess?.({ path: 'a.txt', content: '新内容' });
    assert.equal(a?.level, 'dangerous');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file 读过之后可以覆盖，并且能连着写第二次', async () => {
  const { dir, tools } = setup();
  try {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, '原有内容\n');
    await tools.get('read_file')!.run({ path: 'a.txt' });
    const write = tools.get('write_file')!;

    assert.equal((await write.run({ path: 'a.txt', content: '第一版' })).ok, true);
    // 自己刚写下的版本也算"见过"，否则连续两次写会被误判成外部改动
    assert.equal((await write.run({ path: 'a.txt', content: '第二版' })).ok, true);
    assert.equal(fs.readFileSync(p, 'utf8'), '第二版');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file 拒绝覆盖读过之后又被外部改动的文件', async () => {
  const { dir, tools } = setup();
  try {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, '第一版\n');
    await tools.get('read_file')!.run({ path: 'a.txt' });
    // 模拟别人改了这个文件（mtime 精度有限，往后推一点确保能被看见）
    fs.writeFileSync(p, '别人的改动\n');
    fs.utimesSync(p, new Date(), new Date(Date.now() + 2000));

    const r = await tools.get('write_file')!.run({ path: 'a.txt', content: '我的改动' });
    assert.equal(r.ok, false);
    assert.match(r.content, /被改动过/);
    assert.equal(fs.readFileSync(p, 'utf8'), '别人的改动\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file 写新文件不受限制，也没有预览可给', async () => {
  const { dir, tools } = setup();
  try {
    const write = tools.get('write_file')!;
    const a = write.assess?.({ path: 'new.txt', content: 'x' });
    assert.equal(a?.level, 'confirm');
    assert.equal(a?.preview, undefined);
    assert.equal((await write.run({ path: 'new.txt', content: 'x' })).ok, true);
    assert.equal(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write_file 的预览只显示改动的那一段，两头不变的行折叠掉', async () => {
  const { dir, tools } = setup();
  try {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), before);
    await tools.get('read_file')!.run({ path: 'a.txt' });

    const preview = tools.get('write_file')!.assess?.({
      path: 'a.txt',
      content: ['a', 'b', 'X', 'd', 'e'].join('\n'),
    })?.preview;

    assert.ok(preview, '已存在的文件必须给预览');
    assert.match(preview, /- c/);
    assert.match(preview, /\+ X/);
    assert.match(preview, /前 2 行未变/);
    assert.match(preview, /后 2 行未变/);
    assert.ok(!preview.includes('- a'), '没变的行不该出现在 diff 里');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('edit_file 改完之后 write_file 不会把它当成外部改动', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
    await tools.get('read_file')!.run({ path: 'a.txt' });
    assert.equal((await tools.get('edit_file')!.run({ path: 'a.txt', old: 'world', new: 'there' })).ok, true);
    assert.equal((await tools.get('write_file')!.run({ path: 'a.txt', content: '全换掉' })).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── read_file 分段读 ────────────────────────────────────────────

const many = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join('\n') + '\n';

test('read_file 带行号返回，方便 edit_file 有的放矢', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\n');
    const r = await tools.get('read_file')!.run({ path: 'a.txt' });
    assert.match(r.content, /1→alpha/);
    assert.match(r.content, /2→beta/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read_file 的 offset/limit 取窗口，并在截断处说明怎么读下一段', async () => {
  const { dir, tools } = setup();
  try {
    fs.writeFileSync(path.join(dir, 'big.txt'), many(100));
    const r = await tools.get('read_file')!.run({ path: 'big.txt', offset: 10, limit: 3 });
    assert.match(r.content, /10→line10/);
    assert.match(r.content, /12→line12/);
    assert.ok(!r.content.includes('line13'), '窗口外的不给');
    assert.match(r.content, /共 100 行/, '要让它知道全文有多长');
    assert.match(r.content, /offset: 13/, '要给出下一段怎么读，不然它不知道还能分段');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('超长文件默认截断，而不是整篇灌进上下文', async () => {
  const { dir, tools } = setup();
  const saved = process.env.GB_READ_MAX_LINES;
  try {
    process.env.GB_READ_MAX_LINES = '5';
    fs.writeFileSync(path.join(dir, 'big.txt'), many(50));
    const r = await tools.get('read_file')!.run({ path: 'big.txt' });
    assert.match(r.content, /5→line5/);
    assert.ok(!r.content.includes('line6'));
    assert.match(r.content, /共 50 行/);
  } finally {
    if (saved === undefined) delete process.env.GB_READ_MAX_LINES;
    else process.env.GB_READ_MAX_LINES = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('只读了一段不算"读过"——否则等于拿三分之一的内容去覆盖整个文件', async () => {
  const { dir, tools } = setup();
  try {
    const p = path.join(dir, 'big.txt');
    fs.writeFileSync(p, many(100));

    // 只读前 3 行
    await tools.get('read_file')!.run({ path: 'big.txt', limit: 3 });
    const r = await tools.get('write_file')!.run({ path: 'big.txt', content: '全换掉' });
    assert.equal(r.ok, false, '部分读之后不该放行覆盖式写入');
    assert.match(r.content, /还没读过/);
    assert.equal(fs.readFileSync(p, 'utf8'), many(100), '一个字节都不能动');

    // 整篇读过之后就可以了
    await tools.get('read_file')!.run({ path: 'big.txt', limit: 1000 });
    assert.equal((await tools.get('write_file')!.run({ path: 'big.txt', content: '全换掉' })).ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
