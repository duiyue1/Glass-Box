import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCommandZone, classifyPathZone, commandPaths, isSecret, realpathDeep, resolveInWorkspace } from '../src/plugins/paths.ts';

const ws = '/tmp/glassbox-ws';

/**
 * Windows 上建符号链接需要开发者模式/管理员权限，没开就 EPERM。
 * 这些测试验证的是 realpath 判定本身，跳过不等于放行：
 * classifyPathZone 在 Windows 上照样走同一条代码路径，只是软链造不出来而已。
 */
const canSymlink = (() => {
  try {
    const probe = path.join(os.tmpdir(), `gb-symprobe-${process.pid}`);
    fs.symlinkSync('.', probe);
    // 必须用 unlinkSync：rmSync 会顺着软链看到目标是目录，抛 EISDIR，
    // 于是"能不能建软链"被误判成"不能"——下面这些安全用例就在 macOS/Linux 上全被静默跳过了
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();
const symlinkTest = canSymlink ? test : test.skip;

function tmpWs(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-zone-')));
}

test('工作区内路径 inside=true', () => {
  assert.equal(resolveInWorkspace(ws, 'a.txt').inside, true);
  assert.equal(resolveInWorkspace(ws, 'sub/dir/b.txt').inside, true);
  assert.equal(resolveInWorkspace(ws, './c.txt').inside, true);
});

test('越界路径 inside=false', () => {
  assert.equal(resolveInWorkspace(ws, '../x.txt').inside, false);
  assert.equal(resolveInWorkspace(ws, '/etc/passwd').inside, false);
});

test('realpathDeep：文件还不存在时，解析最深的已存在祖先再拼字面后缀', () => {
  const dir = tmpWs();
  try {
    const real = realpathDeep(path.join(dir, 'not/created/yet.txt'));
    assert.equal(real, path.join(dir, 'not/created/yet.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

symlinkTest('软链指向工作区外 → zone=outside（纯字面判断会误判成 inside）', () => {
  const dir = tmpWs();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.writeFileSync(path.join(outside, 'secret.pem'), 'KEY\n');
    fs.symlinkSync(path.join(outside, 'secret.pem'), path.join(dir, 'link.pem'));
    // 字面上 link.pem 就在工作区里
    assert.equal(path.relative(dir, path.resolve(dir, 'link.pem')).startsWith('..'), false);
    // 真实路径不在
    assert.equal(classifyPathZone(dir, 'link.pem'), 'outside');
    const r = resolveInWorkspace(dir, 'link.pem');
    assert.equal(r.inside, false);
    assert.equal(r.real, path.join(outside, 'secret.pem'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

symlinkTest('目录软链出去后，其下的子路径同样算 outside', () => {
  const dir = tmpWs();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.symlinkSync(outside, path.join(dir, 'esc'));
    assert.equal(classifyPathZone(dir, 'esc/deep/a.txt'), 'outside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

symlinkTest('悬空软链按它指向的目标判断，不因为读不到就当 inside', () => {
  const dir = tmpWs();
  try {
    fs.symlinkSync('/tmp/gb-does-not-exist-xyz/a.txt', path.join(dir, 'dangling'));
    assert.equal(classifyPathZone(dir, 'dangling'), 'outside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.git 下的路径是独立的 protected 区，不与 inside 混同', () => {
  const dir = tmpWs();
  try {
    fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
    assert.equal(classifyPathZone(dir, '.git/config'), 'protected');
    assert.equal(classifyPathZone(dir, '.git/hooks/pre-commit'), 'protected');
    assert.equal(classifyPathZone(dir, 'src/.git/x'), 'protected');
    assert.equal(classifyPathZone(dir, 'src/git/x'), 'inside');
    // .gitignore 只是前缀相同，不该被误伤
    assert.equal(classifyPathZone(dir, '.gitignore'), 'inside');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

symlinkTest('工作区本身是软链时，其下的普通文件仍是 inside', () => {
  const real = tmpWs();
  const linkDir = path.join(os.tmpdir(), `gb-link-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(real, linkDir);
    assert.equal(classifyPathZone(linkDir, 'a/b.txt'), 'inside');
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

// ── 命令里的路径归属 ────────────────────────────────────────────

test('commandPaths 只挑出像本地路径的词：选项、URL、带变量的都跳过', () => {
  assert.deepEqual(commandPaths('echo hello'), [], '普通词一个都不算');
  assert.deepEqual(commandPaths('npm test'), []);
  assert.deepEqual(commandPaths('grep -rn TODO src/'), ['src/'], '-rn 是选项不是路径');
  assert.deepEqual(commandPaths('curl https://example.com/a'), [], 'URL 交给 web 工具管');
  assert.deepEqual(commandPaths('cat $HOME/x'), [], '展开不了就不猜');
  // 引号剥掉，整段仍算一个路径（带空格的文件名）；同时按空白切出的碎片也一并进候选，
  // 否则 `sh -c "cat /etc/passwd"` 整段会被当成工作区内的一个相对路径而不升级
  assert.deepEqual(commandPaths('cat "a b/c.txt"'), ['a b/c.txt', 'b/c.txt']);
  assert.deepEqual(commandPaths('x;cat /etc/hosts'), ['/etc/hosts'], '贴着分隔符也要切出来');
  assert.deepEqual(commandPaths('cat .env'), ['.env'], '同目录裸文件名也算');
  assert.deepEqual(commandPaths('cd ..'), ['..']);
});

test('引号包住的嵌套命令里的路径也要挑出来——加个引号不该降一档', () => {
  // 实测的降级漏洞：`cat /etc/passwd` 判 dangerous，而同一件事写成
  // `sh -c "cat /etc/passwd"` 只判 confirm，因为引号段是一个词、含 `/`、
  // 被当成工作区内的相对路径 `<ws>/cat /etc/passwd`
  assert.ok(commandPaths('sh -c "cat /etc/passwd"').includes('/etc/passwd'));
  assert.ok(commandPaths("bash -c 'cp ../outside/x .'").includes('../outside/x'));
  assert.ok(commandPaths('sh -c "cat .git/config"').includes('.git/config'));
});

test('classifyCommandZone：区内命令不升级，越界/凭证/.git 各归各类', () => {
  const dir = tmpWs();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-out-')));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const zone = (cmd: string) => classifyCommandZone(dir, cmd);

    for (const c of ['echo hello', 'npm test', 'ls src', 'grep -rn TODO src/', 'git status']) {
      assert.equal(zone(c), null, c);
    }

    assert.equal(zone(`cat ${path.join(outside, 'a.txt')}`)?.kind, 'outside');
    assert.equal(zone('cd ../.. && ls')?.kind, 'outside');
    assert.equal(zone('echo x > .git/config')?.kind, 'protected');
    assert.equal(zone('cat .env')?.kind, 'secret');
    assert.equal(zone('cat ~/.ssh/id_rsa')?.kind, 'secret');

    // 越界比 .git 更严重：两个都碰到时报越界
    assert.equal(zone(`cp .git/config ${outside}/`)?.kind, 'outside');
    // 凭证盖过一切
    assert.equal(zone('cp .env /tmp/')?.kind, 'secret');

    // 套在引号里的嵌套命令，判定结果必须和不加引号时一致
    assert.equal(zone(`sh -c "cat ${path.join(outside, 'a.txt')}"`)?.kind, 'outside');
    assert.equal(zone('sh -c "echo x > .git/config"')?.kind, 'protected');
    assert.equal(zone("bash -lc 'cat .env'")?.kind, 'secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('带变量展开不了的词，拿字面比凭证名单——$HOME/.ssh 也拦得住', () => {
  const dir = tmpWs();
  try {
    const hit = classifyCommandZone(dir, 'cat $HOME/.ssh/id_rsa');
    assert.equal(hit?.kind, 'secret');
    assert.equal(hit?.matchedBy, 'literal', '要标明是字面命中，别把它当成真实路径写进理由里');

    const resolved = classifyCommandZone(dir, 'cat ~/.ssh/id_rsa');
    assert.equal(resolved?.matchedBy, 'literal', '~ 展开前字面里就有 .ssh/');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isSecret 判的是真实路径的形状', () => {
  assert.equal(isSecret('/home/u/.ssh/id_rsa'), true);
  assert.equal(isSecret('/a/b/deploy.pem'), true);
  assert.equal(isSecret('/a/.env.local'), true);
  assert.equal(isSecret('/a/b/README.md'), false);
  assert.equal(isSecret('/a/b/environment.ts'), false, '不能因为含 env 就误判');
});

test('isSecret 也认 Windows 的反斜杠路径（否则那边整份黑名单形同不存在）', () => {
  // 名单里的分隔符全是 `/`，而 Windows 的 realpath 给的是 `\`。不归一化的话
  // `(^|\/)\.ssh\//` 这类规则一条都命中不了，凭证闸门在 Windows 上直接消失。
  // CI 第一次跑 windows-latest 就是在这里挂的（vision.test.ts 那条读 .ssh\id_rsa 的）。
  // 这条测试在任何平台都跑，所以不用真有 Windows 也能守住。
  assert.equal(isSecret('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ws\\.ssh\\id_rsa'), true);
  assert.equal(isSecret('C:\\ws\\.env'), true);
  assert.equal(isSecret('C:\\ws\\sub\\.env.local'), true);
  assert.equal(isSecret('C:\\Users\\u\\.aws\\credentials'), true);
  assert.equal(isSecret('C:\\ws\\deploy.pem'), true);
  // 大小写：Windows 上 .SSH 和 .ssh 是同一个目录，realpath 可能把原始大小写带回来
  if (process.platform === 'win32') {
    assert.equal(isSecret('C:\\ws\\.SSH\\id_rsa'), true);
  }
  // 归一化不能把正常文件误判成凭证
  assert.equal(isSecret('C:\\ws\\src\\README.md'), false);
  assert.equal(isSecret('C:\\ws\\src\\environment.ts'), false);
});
