/**
 * 自更新（Host 半部）：查 npm registry → 下载 tarball → 校验 → 原子替换 → 失败回滚。
 *
 * 为什么放在 Host 半部：整个过程要读写文件系统，浏览器侧做不到。
 * Client 半部通过 `index.js` 注册的 HTTP 端点读状态、触发动作。
 *
 * 设计参考了 dsh-bottom-info-bar 的 lib/self-update.js（MIT，作者 songoao25），
 * 按本插件的结构做了精简：只保留必需能力，并把「是否需要重启」判断显式化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync, readdirSync, lstatSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const PACKAGE_NAME = 'dsh-thinking-panel';
export const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
export const tarballUrl = (version) => `https://registry.npmjs.org/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${version}.tgz`;

/**
 * 允许被更新覆盖的路径白名单。
 * 其余一律拒绝 —— 这既防目录穿越，也防上游包结构变化时误删本地文件。
 */
const PAYLOAD_ROOTS = ['locale/'];
const PAYLOAD_FILES = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml'];

/** 需要重启 DSH 才会生效的文件（Host 半部不热加载）。 */
const RESTART_REQUIRED = ['index.js', 'package.json', 'cordis.patch.yml'];

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/* ================================================================== *
 * semver：只做比较，不引依赖
 * ================================================================== */

/** @returns {{major:number,minor:number,patch:number,pre:string|null}|null} */
export function parseSemver(value) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim());
  if (m === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

/** 比较两个 prerelease 串；返回 -1 / 0 / 1。无 prerelease 的版本更大。 */
function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;      // 正式版 > 预发布版
  if (b === null) return -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;        // 数字标识符 < 字母标识符
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** @returns {number} a<b 返回 -1，a>b 返回 1，相等返回 0；无法解析时返回 0。 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePre(pa.pre, pb.pre);
}

/* ================================================================== *
 * 路径安全
 * ================================================================== */

/** 该相对路径是否在白名单内（且形态干净）。 */
export function isAllowedPayloadPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (PAYLOAD_FILES.includes(rel)) return true;
  return PAYLOAD_ROOTS.some((root) => rel.startsWith(root) && rel.length > root.length);
}

/**
 * 把白名单内的相对路径解析成 baseDir 下的绝对路径。
 *
 * 拒绝两种情况：① 越出 baseDir（`..` 穿越）；② baseDir 之下的路径段是符号链接
 * （防止上游包塞一个软链，把写入引到别处）。
 *
 * 注意 baseDir 本身**允许**是符号链接 —— 本插件常以 `link:` 方式安装，
 * `node_modules/<pkg>` 就是指向工作区的软链，一刀切拒绝会让自更新完全不可用。
 */
export function resolveSafePath(baseDir, rel) {
  if (!isAllowedPayloadPath(rel)) return null;
  const base = resolve(baseDir);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) return null;

  let cursor = target;
  while (cursor.length > base.length && cursor.startsWith(base)) {
    if (existsSync(cursor)) {
      try {
        if (lstatSync(cursor).isSymbolicLink()) return null;
      } catch { return null; }
    }
    cursor = dirname(cursor);
  }
  return target;
}

/* ================================================================== *
 * tar 解析（npm tarball 是 gzip + tar，条目前缀 package/）
 * ================================================================== */

function readTarText(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8');
}

/** PAX 扩展头（typeflag 'x'）里可能带真实路径，这里只取 path 记录。 */
function readPaxPath(buf) {
  let offset = 0;
  let path = null;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) break;
    const len = parseInt(buf.subarray(offset, space).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > buf.length) break;
    const record = buf.subarray(space + 1, offset + len).toString('utf8').replace(/\n$/, '');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    offset += len;
  }
  return path;
}

/** @returns {Array<{path:string,data:Buffer}>} */
export function parseTar(buffer) {
  const entries = [];
  let offset = 0;
  let paxPath = null;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    let allZero = true;
    for (let i = 0; i < header.length; i++) if (header[i] !== 0) { allZero = false; break; }
    if (allZero) break;

    const rawName = readTarText(header, 0, 100);
    const size = parseInt(readTarText(header, 124, 12).replace(/[^0-7]/g, ''), 8);
    if (!Number.isFinite(size) || size < 0) break;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = readTarText(header, 345, 155);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > buffer.length) break;

    if (typeflag === 'x') { paxPath = readPaxPath(buffer.subarray(dataStart, dataEnd)); offset = next; continue; }
    const name = paxPath || (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    paxPath = null;
    if (typeflag === '0' || typeflag === '\0') entries.push({ path: name, data: buffer.subarray(dataStart, dataEnd) });
    offset = next > dataStart ? next : dataStart + 512;
  }
  return entries;
}

/** 解开 tarball，只保留白名单内、且在 package/ 前缀下的条目（前缀会被剥掉）。 */
export function extractPackageFiles(tarballBuffer) {
  const files = [];
  for (const entry of parseTar(gunzipSync(tarballBuffer))) {
    const rel = entry.path.startsWith('package/') ? entry.path.slice('package/'.length) : entry.path;
    if (!isAllowedPayloadPath(rel)) continue;
    files.push({ path: rel, data: entry.data });
  }
  return files;
}

/* ================================================================== *
 * 应用 / 回滚
 * ================================================================== */

/** 列出当前包目录里所有受管文件（相对路径）。 */
function listPayloadFiles(packageDir) {
  const out = [];
  for (const rel of PAYLOAD_FILES) if (existsSync(join(packageDir, rel))) out.push(rel);
  for (const root of PAYLOAD_ROOTS) {
    const dir = join(packageDir, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSyncSafe(dir)) {
      const rel = `${root}${name}`;
      if (isAllowedPayloadPath(rel) && existsSync(join(packageDir, rel))) out.push(rel);
    }
  }
  return out;
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * 应用更新：先整体预检 → 备份 → 逐个原子写入；任何一步失败都回滚到备份。
 * @returns {{ok:boolean, written?:string[], before?:string[], restartRequired?:boolean, error?:string}}
 */
export function applyPayload(files, context) {
  const { packageDir, backupDir } = context ?? {};
  if (!packageDir || !backupDir) throw new Error('applyPayload 需要 packageDir 与 backupDir');
  if (!Array.isArray(files) || files.length === 0) throw new Error('applyPayload 收到空的文件列表');

  // 预检：任何路径不安全就直接失败，避免写了一半才发现
  const targets = files.map((file) => {
    const target = resolveSafePath(packageDir, file.path);
    if (!target) throw new Error(`拒绝写入白名单外或穿越符号链接的路径：${String(file.path)}`);
    return { file, target };
  });

  const before = listPayloadFiles(packageDir);
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true });
  for (const rel of before) {
    const source = join(packageDir, rel);
    const dest = join(backupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  }

  const written = [];
  try {
    for (const { file, target } of targets) {
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.update-tmp`;
      writeFileSync(temp, file.data);
      renameSync(temp, target);              // 同目录 rename：要么旧内容、要么新内容
      written.push(file.path);
    }
  } catch (error) {
    rollbackPayload({ packageDir, backupDir, before, written });
    return { ok: false, error: `写入失败，已回滚：${error.message}` };
  }

  const restartRequired = written.some((rel) => RESTART_REQUIRED.includes(rel));
  return { ok: true, written, before, restartRequired };
}

/** 回滚：删掉新增的文件，把备份里的原有文件恢复回去。 */
export function rollbackPayload(context) {
  const { packageDir, backupDir, before, written } = context ?? {};
  if (!packageDir || !backupDir || !existsSync(backupDir)) return { restored: [], removed: [] };
  const keep = new Set(Array.isArray(before) ? before : []);
  const removed = [];
  for (const rel of Array.isArray(written) ? written : []) {
    if (keep.has(rel)) continue;
    const target = resolveSafePath(packageDir, rel);
    if (!target) continue;
    rmSync(target, { force: true });
    removed.push(rel);
  }
  const restored = [];
  for (const rel of keep) {
    const source = join(backupDir, rel);
    const target = join(packageDir, rel);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    restored.push(rel);
  }
  return { restored, removed };
}

/* ================================================================== *
 * 引擎
 * ================================================================== */

/**
 * @param {object} options
 * @param {string} options.packageDir  插件安装目录
 * @param {string} options.dataDir     状态与备份目录
 * @param {string} options.runningVersion 当前版本（来自 package.json）
 * @param {Function} [options.fetch]   注入的 fetch（便于测试）
 * @param {Function} [options.log]
 */
export function createSelfUpdater(options) {
  const {
    packageDir, dataDir, runningVersion,
    fetch: fetchImpl = (...args) => fetch(...args),
    log = () => {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = options ?? {};

  const stateFile = join(dataDir, 'update-state.json');
  const backupDir = join(dataDir, 'update-backup');

  /**
   * holdVersion：用户主动回滚过的版本。
   * 回滚是「新版有问题」时的逃生门 —— 若自动检查又把它装回来，等于逃生门自己关上。
   * 所以只压制「正好等于该版本」的更新，更高的版本照常提示。
   */
  let state = { autoUpdate: true, latestVersion: null, holdVersion: null, lastError: null, lastCheckAt: null, lastAppliedAt: null };

  function loadState() {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (parsed && typeof parsed === 'object') state = { ...state, ...parsed };
    } catch { /* 首次运行或文件损坏：用默认值 */ }
    return state;
  }
  function saveState() {
    try {
      mkdirSync(dataDir, { recursive: true });
      const temp = `${stateFile}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(temp, stateFile);
    } catch (error) { log(`状态写入失败：${error.message}`); }
  }

  /**
   * 同一时刻只允许一个会写文件系统（或状态文件）的操作。
   *
   * 为什么需要：桌面端与 Web GUI 是两条彼此独立的客户端，可以同时开着同一个插件目录 ——
   * 两边同时点「更新」时 `applyPayload` 会交错执行（备份目录被前一个删掉、文件写一半）。
   * 客户端那层的 `disabled` 只能挡住同一个页面里的双击，挡不住第二个窗口。
   */
  let busy = null;
  async function locked(label, fn) {
    if (busy !== null) return { ok: false, error: `另一个更新操作正在进行（${busy}），请稍后重试` };
    busy = label;
    try { return await fn(); } finally { busy = null; }
  }

  async function fetchWithLimit(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const tooBig = () => new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      /* ⚠️ 不能先 arrayBuffer() 再判大小 —— 那等于把整个响应读进内存之后才拦，上限形同虚设。
       * 这里流式累计，一超限就取消读取。 */
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw tooBig();
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks, total);
      }
      // 没有流式 body（旧运行时或测试替身）：退回一次性读取，但仍然判大小。
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw tooBig();
      return buf;
    } finally { clearTimeout(timer); }
  }

  /** 查询 npm registry 上的最新版本。 */
  async function checkImpl() {
    try {
      const buf = await fetchWithLimit(REGISTRY_LATEST_URL);
      const meta = JSON.parse(buf.toString('utf8'));
      const latest = typeof meta.version === 'string' ? meta.version : null;
      if (latest === null) throw new Error('registry 返回里没有 version 字段');
      state.latestVersion = latest;
      state.lastCheckAt = Date.now();
      state.lastError = null;
      saveState();
      const held = state.holdVersion === latest;
      return {
        ok: true,
        runningVersion,
        latestVersion: latest,
        hasUpdate: compareSemver(runningVersion, latest) < 0 && !held,
        held,
      };
    } catch (error) {
      state.lastError = `检查更新失败：${error.message}`;
      state.lastCheckAt = Date.now();
      saveState();
      return { ok: false, error: state.lastError };
    }
  }

  /** 下载并应用指定版本（默认最新版）。 */
  async function installImpl(version) {
    const target = typeof version === 'string' && version.length > 0 ? version : state.latestVersion;
    if (!target) return { ok: false, error: '还没有已知的目标版本，请先检查更新' };
    if (compareSemver(runningVersion, target) >= 0) {
      return { ok: false, error: `当前版本 ${runningVersion} 不低于 ${target}，无需更新` };
    }
    try {
      const tarball = await fetchWithLimit(tarballUrl(target));
      const files = extractPackageFiles(tarball);
      if (files.length === 0) throw new Error('tarball 里没有白名单内的文件（包结构可能变了）');
      const result = applyPayload(files, { packageDir, backupDir });
      if (!result.ok) throw new Error(result.error);
      state.latestVersion = target;
      state.lastAppliedAt = Date.now();
      state.lastError = null;
      state.holdVersion = null;
      saveState();
      log(`已更新到 ${target}，写入 ${result.written.length} 个文件`);
      return { ok: true, version: target, restartRequired: result.restartRequired === true, files: result.written };
    } catch (error) {
      state.lastError = `更新失败：${error.message}`;
      saveState();
      return { ok: false, error: state.lastError };
    }
  }

  /** 回滚到指定版本（默认「当前运行版本」），并把它记进 holdVersion。 */
  async function rollbackImpl(version) {
    const target = typeof version === 'string' && version.length > 0 ? version : runningVersion;
    try {
      const tarball = await fetchWithLimit(tarballUrl(target));
      const files = extractPackageFiles(tarball);
      if (files.length === 0) throw new Error('tarball 里没有白名单内的文件');
      const result = applyPayload(files, { packageDir, backupDir });
      if (!result.ok) throw new Error(result.error);
      state.holdVersion = target;
      state.lastError = null;
      saveState();
      log(`已回滚到 ${target}，并暂停对该版本的自动更新提示`);
      return { ok: true, version: target, restartRequired: result.restartRequired === true, held: target };
    } catch (error) {
      state.lastError = `回滚失败：${error.message}`;
      saveState();
      return { ok: false, error: state.lastError };
    }
  }

  function setAutoUpdate(enabled) {
    state.autoUpdate = enabled !== false;
    saveState();
    return { ok: true, autoUpdate: state.autoUpdate };
  }

  function status() {
    return {
      ok: true,
      packageName: PACKAGE_NAME,
      runningVersion,
      latestVersion: state.latestVersion,
      hasUpdate: typeof state.latestVersion === 'string' && compareSemver(runningVersion, state.latestVersion) < 0,
      autoUpdate: state.autoUpdate !== false,
      holdVersion: state.holdVersion,
      lastError: state.lastError,
      lastCheckAt: state.lastCheckAt,
      lastAppliedAt: state.lastAppliedAt,
    };
  }

  loadState();
  return {
    // check 也要上锁：它会写状态文件，与 install/rollback 交错会互相覆盖字段
    check: () => locked('check', checkImpl),
    install: (version) => locked('install', () => installImpl(version)),
    rollback: (version) => locked('rollback', () => rollbackImpl(version)),
    setAutoUpdate,
    status,
  };
}
