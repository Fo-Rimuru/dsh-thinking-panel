/**
 * 自更新模块的单元测试：不联网、不碰真实插件目录，全部在临时目录里跑。
 *
 *   node tools/test-self-update.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  applyPayload, compareSemver, createSelfUpdater, extractPackageFiles, isAllowedPayloadPath,
  parseSemver, parseTar, resolveSafePath, rollbackPayload,
} from '../self-update.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* ---------- 构造 tar（ustar，单文件 ≤ 8GB，够用） ---------- */
function tarHeader(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  h.write('00000000000\0', 136, 12);
  h.write('        ', 148, 8);
  h.write('0', 156, 1);                 // typeflag: 普通文件
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
function makeTar(entries) {
  const parts = [];
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    parts.push(tarHeader(name, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));       // 归档结束
  return Buffer.concat(parts);
}

console.log('\n[1] semver 比较');
check('parseSemver 解析普通版本', JSON.stringify(parseSemver('1.2.3')) === JSON.stringify({ major: 1, minor: 2, patch: 3, pre: null }));
check('parseSemver 解析 prerelease', parseSemver('0.2.0-rc.2')?.pre === 'rc.2');
check('parseSemver 拒绝非法输入', parseSemver('abc') === null && parseSemver('') === null);
check('1.0.0 > 0.9.9', compareSemver('1.0.0', '0.9.9') === 1);
check('0.2.0-rc.2 > 0.2.0-rc.1', compareSemver('0.2.0-rc.2', '0.2.0-rc.1') === 1);
check('0.2.0 > 0.2.0-rc.2（正式版大于预发布）', compareSemver('0.2.0', '0.2.0-rc.2') === 1);
check('相同版本相等', compareSemver('1.2.3', '1.2.3') === 0);
check('v 前缀可接受', compareSemver('v1.2.3', '1.2.3') === 0);
check('无法解析时返回 0（不误判为更新）', compareSemver('garbage', '1.0.0') === 0);

console.log('\n[2] 路径白名单');
for (const ok of ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json']) {
  check(`放行 ${ok}`, isAllowedPayloadPath(ok) === true);
}
for (const bad of ['../evil.js', '/etc/passwd', 'C:/windows/x', 'a/../../b', 'lib/x.js',
  'locale/../index.js', '', 'index.js\0.png', './index.js', 'locale/']) {
  check(`拒绝 ${JSON.stringify(bad)}`, isAllowedPayloadPath(bad) === false);
}

console.log('\n[3] resolveSafePath 越界防护');
{
  const base = join(tmpdir(), 'dst-test-base');
  check('白名单内解析到 base 之下', resolveSafePath(base, 'client.js')?.startsWith(base) === true);
  check('越界返回 null', resolveSafePath(base, '../x.js') === null);
  check('绝对路径返回 null', resolveSafePath(base, '/tmp/x.js') === null);
}

console.log('\n[4] tar 解析');
{
  const tar = makeTar([
    ['package/index.js', 'HOST'],
    ['package/client.js', 'CLIENT'],
    ['package/locale/zh.json', '{"a":1}'],
    ['package/evil/../../outside.js', 'NOPE'],
    ['package/README.md', 'not in whitelist'],
  ]);
  const entries = parseTar(tar);
  check('parseTar 读出全部条目', entries.length === 5, `got ${entries.length}`);
  const files = extractPackageFiles(gzipSync(tar));
  const paths = files.map((f) => f.path).sort();
  check('extractPackageFiles 剥掉 package/ 前缀', paths.includes('index.js') && paths.includes('client.js'));
  check('extractPackageFiles 只留白名单内的文件',
    !paths.includes('README.md') && paths.every((p) => isAllowedPayloadPath(p)), JSON.stringify(paths));
  check('extractPackageFiles 丢弃穿越路径', !paths.some((p) => p.includes('..')));
  check('文件内容正确', files.find((f) => f.path === 'client.js')?.data.toString('utf8') === 'CLIENT');
}

console.log('\n[5] applyPayload / rollbackPayload（临时目录）');
{
  const root = mkdtempSync(join(tmpdir(), 'dst-update-'));
  const pkg = join(root, 'pkg');
  const backup = join(root, 'backup');
  mkdirSync(join(pkg, 'locale'), { recursive: true });
  writeFileSync(join(pkg, 'client.js'), 'OLD-CLIENT');
  writeFileSync(join(pkg, 'index.js'), 'OLD-HOST');
  writeFileSync(join(pkg, 'locale', 'zh.json'), '{"old":1}');

  const files = [
    { path: 'client.js', data: Buffer.from('NEW-CLIENT') },
    { path: 'index.js', data: Buffer.from('NEW-HOST') },
    { path: 'locale/en.json', data: Buffer.from('{"new":1}') },
  ];
  const result = applyPayload(files, { packageDir: pkg, backupDir: backup });
  check('applyPayload 成功', result.ok === true, JSON.stringify(result));
  check('client.js 已替换', readFileSync(join(pkg, 'client.js'), 'utf8') === 'NEW-CLIENT');
  check('index.js 已替换', readFileSync(join(pkg, 'index.js'), 'utf8') === 'NEW-HOST');
  check('新增文件已写入', readFileSync(join(pkg, 'locale', 'en.json'), 'utf8') === '{"new":1}');
  check('未在 payload 里的文件保持不动', readFileSync(join(pkg, 'locale', 'zh.json'), 'utf8') === '{"old":1}');
  check('改到 index.js → 标记需要重启', result.restartRequired === true);

  const rb = rollbackPayload({ packageDir: pkg, backupDir: backup, before: result.before, written: result.written });
  check('回滚恢复了 client.js', readFileSync(join(pkg, 'client.js'), 'utf8') === 'OLD-CLIENT');
  check('回滚恢复了 index.js', readFileSync(join(pkg, 'index.js'), 'utf8') === 'OLD-HOST');
  check('回滚删掉了新增文件', !existsSync(join(pkg, 'locale', 'en.json')));
  check('回滚记录非空', rb.restored.length >= 2, JSON.stringify(rb));

  // 只改 client.js 时不应要求重启
  const r2 = applyPayload([{ path: 'client.js', data: Buffer.from('NEWER') }], { packageDir: pkg, backupDir: backup });
  check('只改 client.js → 不要求重启', r2.ok === true && r2.restartRequired === false);

  // 非法路径必须在写入前整体拒绝
  let threw = false;
  try {
    applyPayload([{ path: 'client.js', data: Buffer.from('X') }, { path: '../escape.js', data: Buffer.from('Y') }],
      { packageDir: pkg, backupDir: backup });
  } catch { threw = true; }
  check('payload 含越界路径时整体抛错', threw === true);
  check('抛错后 client.js 未被改动（预检生效）', readFileSync(join(pkg, 'client.js'), 'utf8') === 'NEWER');

  rmSync(root, { recursive: true, force: true });
}

console.log('\n[6] createSelfUpdater：回滚目标 / 并发互斥 / 自动更新');
{
  const root = mkdtempSync(join(tmpdir(), 'dst-engine-'));
  const pkg = join(root, 'pkg');
  const dataDir = join(root, 'data');
  mkdirSync(pkg, { recursive: true });
  const writePkg = (version) => writeFileSync(join(pkg, 'package.json'),
    JSON.stringify({ name: 'dsh-thinking-panel', version }));
  writePkg('0.1.0');
  writeFileSync(join(pkg, 'client.js'), 'CLIENT-0.1.0');

  const tarballOf = (version) => gzipSync(makeTar([
    ['package/package.json', JSON.stringify({ name: 'dsh-thinking-panel', version })],
    ['package/client.js', `CLIENT-${version}`],
  ]));
  let release = '0.2.0';
  const fetchStub = async (url) => {
    if (String(url).endsWith('/latest')) {
      return { ok: true, arrayBuffer: async () => Buffer.from(JSON.stringify({ version: release }), 'utf8') };
    }
    const version = String(url).split('/').pop().replace('dsh-thinking-panel-', '').replace('.tgz', '');
    return { ok: true, arrayBuffer: async () => tarballOf(version) };
  };
  const make = (running) => createSelfUpdater({ packageDir: pkg, dataDir, runningVersion: running, fetch: fetchStub });

  const updater = make('0.1.0');
  const checked = await updater.check();
  check('check 读到 registry 上的最新版',
    checked.ok === true && checked.latestVersion === '0.2.0' && checked.hasUpdate === true, JSON.stringify(checked));

  const installed = await updater.install();
  check('install 装上了最新版', installed.ok === true && installed.version === '0.2.0', JSON.stringify(installed));
  check('install 后磁盘版本已变', JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version === '0.2.0');
  check('install 记下了 previousVersion',
    updater.status().previousVersion === '0.1.0', String(updater.status().previousVersion));

  /* 并发互斥：第二个操作必须在第一个完成前被拒（桌面端 + Web GUI 会同时点）。
   * 这里用两次 check —— 它同样上锁，又不会改动 previousVersion。 */
  const [a, b] = await Promise.all([updater.check(), updater.check()]);
  check('并发操作被互斥挡掉一个（不会交错写文件）',
    (a.ok === false && String(a.error).includes('正在进行')) || (b.ok === false && String(b.error).includes('正在进行')),
    `${JSON.stringify(a)} / ${JSON.stringify(b)}`);

  /* 模拟重启：新引擎 + 同一数据目录。runningVersion 变成 0.2.0 ——
   * 此时「回滚」必须回到 previousVersion(0.1.0)，而不是把 0.2.0 再装一遍。 */
  const afterRestart = make('0.2.0');
  const rolled = await afterRestart.rollback();
  check('重启后回滚回到上一个装过的版本（不是当前版本）',
    rolled.ok === true && rolled.version === '0.1.0', JSON.stringify(rolled));
  check('回滚后磁盘版本是 0.1.0', JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version === '0.1.0');
  check('回滚把目标记进 holdVersion', afterRestart.status().holdVersion === '0.1.0');

  release = '0.3.0';
  const auto = await afterRestart.autoUpdate();
  check('autoUpdate 查到新版就直接装', auto.ok === true && auto.version === '0.3.0', JSON.stringify(auto));

  const off = afterRestart.setAutoUpdate(false);
  const skipped = await afterRestart.autoUpdate();
  check('关掉自动更新后 autoUpdate 直接拒绝', off.ok === true && skipped.ok === false, JSON.stringify(skipped));

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
