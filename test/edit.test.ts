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
    assert.match(r.content, /多次/);
    // 文件未被改动
    assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'x\nx\n');
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
