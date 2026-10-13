/**
 * 深度思考面板 · Host 半部
 *
 * 作用：在每一步模型请求前，向系统提示词注入一条「推理语言规则」，
 * 使模型的思考过程（reasoning）使用与用户提问相同的语言。
 *
 * 依据（实测）：
 *  - DSH 系统提示词为英文（7.8k 字符，中文占比 0.9%–3.1%），导致中文提问时
 *    思考内容仍为英文（本机 3353 个推理步中，中文提问→英文思考占 91%）。
 *  - A/B 对照实验：加入语言指令后，思考内容中文占比 0.072 → 0.627。
 *  - 思考语言由模型侧决定，客户端不提供语言控制字段；因此正确的做法是在
 *    提示词层面施加约束，而不是在渲染层做翻译。
 *
 * 扩展点：ctx.systemPrompt.section(PromptSection) —— 官方契约原文：
 *  "Register an ordered prompt section in the calling context's scope.
 *   A scoped section shadows a global section with the same name; duplicates
 *   within one layer and non-finite orders throw."
 *
 * 另外本文件还负责注册**自更新**的 HTTP 端点（见文件末尾）：更新要读写文件系统，
 * 只能跑在 Host 侧；Client 半部通过这几个端点读状态、触发动作。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSelfUpdater } from './self-update.js';

export const name = 'dsh-thinking-panel';

/** 只在 systemPrompt 服务存在时激活。 */
export const inject = ['systemPrompt'];

/** 段落名（同一层内必须唯一）。 */
export const SECTION_NAME = 'thinking-panel-language';

/** 运行时上下文名（与段落名分开，两者是不同注册表）。 */
export const CONTEXT_NAME = 'thinking-panel-language-context';

/**
 * 系统提示词段落的排序值。
 *
 * 取自 `@deepseek-ai/dsh-system-prompt` 的 SECTION_ORDERS 表：
 *   HARNESS_IDENTITY:-1000 … FILE_REFERENCE:900 … TOOL_*:1000-3100 …
 *   DELIVERABLE_FILE_REFERENCES:9000, STRUCTURED_OUTPUT:9900,
 *   HARNESS_SOURCE:10000, WEB_SURFACE:10100, DEPLOYMENT_PERSONA_SUFFIX:10200
 * 取 10300 以确保排在整个系统提示词的**最末**（原先误用 900，与 FILE_REFERENCE 撞位）。
 */
export const SECTION_ORDER = 10300;

/**
 * 运行时上下文的排序值。
 *
 * CONTEXT_ORDERS 只有三项（SANDBOX_POLICY:110 / APPROVAL_POLICY:115 /
 * SUBAGENT_DELEGATION:120）。运行时上下文是 DSH 里**唯一既进日志、又紧贴用户回合**
 * 的注入通道（就是日志里 "Time sampled while preparing turn 1…" 那一块），
 * 因此它离生成点最近、约束力最强。取 130 排在既有三项之后。
 */
export const CONTEXT_ORDER = 130;

/** 支持的模式。 */
export const MODES = ['auto', 'zh', 'en', 'off'];

const AUTO_RULE = [
  '【推理语言规则 · 优先级最高】',
  '你的思考过程（reasoning）必须使用与用户最近一条消息相同的语言：',
  '- 用户用中文提问 → 思考内容全部用中文书写；',
  '- 用户用英文提问 → 思考内容用英文书写；',
  '- 用户使用其它语言 → 思考内容使用该语言。',
  '代码、文件路径、命令、标识符、专有名词与数学公式保持原样，不要翻译。',
  '该规则只约束思考过程本身；最终回答的语言仍按用户的要求或默认习惯组织。',
].join('\n');

/** 运行时上下文里的精简版：更短、更贴近生成点。 */
const AUTO_CONTEXT = [
  '【推理语言规则 · 立即生效】',
  '本步的思考过程（reasoning）必须使用与用户最近一条消息相同的语言：',
  '用户用中文就全程用中文思考，用户用英文就全程用英文思考。',
  '代码、路径、命令、标识符、专有名词保持原样。',
].join('\n');

const ZH_RULE = [
  '【推理语言规则 · 优先级最高】',
  '你的思考过程（reasoning）必须全部使用中文书写，无论用户使用什么语言提问。',
  '代码、文件路径、命令、标识符、专有名词与数学公式保持原样，不要翻译。',
  '该规则只约束思考过程本身；最终回答的语言仍按用户的要求或默认习惯组织。',
].join('\n');

const EN_RULE = [
  '[Reasoning language rule - highest priority]',
  'Your reasoning (thinking) must be written entirely in English, regardless of the language the user writes in.',
  'Keep code, file paths, commands, identifiers, proper nouns and formulas verbatim; do not translate them.',
  'This rule constrains only the reasoning process; the final answer still follows the user request.',
].join('\n');

/**
 * 构造注入的系统提示词段落文本。
 * @param {'auto'|'zh'|'en'|'off'} mode
 * @returns {string|null} 段落文本；`off` 时返回 null（不注册任何段落）。
 */
export function reasoningLanguageRule(mode = 'auto') {
  switch (mode) {
    case 'zh': return ZH_RULE;
    case 'en': return EN_RULE;
    case 'off': return null;
    case 'auto':
    default: return AUTO_RULE;
  }
}

/**
 * 构造注入的**运行时上下文**文本（精简版，紧贴用户回合）。
 * @param {'auto'|'zh'|'en'|'off'} mode
 * @returns {string|null}
 */
export function reasoningLanguageContext(mode = 'auto') {
  switch (mode) {
    case 'zh':
      return '【推理语言规则 · 立即生效】本步的思考过程（reasoning）必须全部使用中文书写，无论用户用什么语言提问。';
    case 'en':
      return '[Reasoning language rule - effective now] Write your reasoning entirely in English for this step, regardless of the language the user writes in.';
    case 'off': return null;
    case 'auto':
    default: return AUTO_CONTEXT;
  }
}

/**
 * 兼容性提示：DSH 升级后注入接口可能改名或改签名。
 *
 * 原则是**尽量不阻断** —— 能注入多少就先注入多少，但要把问题说清楚，
 * 否则用户只会发现「语言跟随失效」却毫无头绪。
 * @param {string} problem 一句话描述问题
 * @param {string} [detail] 影响与建议
 */
function compatReport(problem, detail) {
  try {
    const lines = [
      `[dsh-thinking-panel] 兼容性提示：${problem}`,
      detail ? `  ${detail}` : null,
      '  插件会尽量继续以降级方式运行。',
      '  反馈：https://github.com/Fo-Rimuru/dsh-thinking-panel/issues',
    ].filter(Boolean);
    console.warn(lines.join('\n'));
  } catch { /* ignore */ }
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {{ mode?: 'auto'|'zh'|'en'|'off' }} [config] 来自 cordis.patch.yml 的行配置
 */
export function apply(ctx, config) {
  const rawMode = config && typeof config.mode === 'string' ? config.mode : 'auto';
  const configured = MODES.includes(rawMode) ? rawMode : 'auto';

  /* `cordis.patch.yml` 里的 mode 只是**默认值**：用户在设置页改过之后以状态文件为准 ——
   * 否则「改配置」和「改设置」会互相覆盖。 */
  const store = createModeStore(configured);
  const injection = createInjection(ctx);

  // 兼容性自检：两个注入通道分别判断，缺一个就降级一个
  if (!injection.hasSection && !injection.hasContext) {
    compatReport(
      'systemPrompt.section 与 systemPrompt.context 都不可用',
      'Host 半部无法注入任何规则，语言跟随不会生效（样式部分不受影响）。',
    );
  } else if (!injection.hasContext) {
    compatReport(
      'systemPrompt.context 不可用',
      '只能注入系统提示词段落。实测仅靠段落时语言跟随会明显变弱（CJK 0.096 量级）。',
    );
  }
  injection.applyMode(store.get());

  /* 自更新端点与语言注入**完全独立**：即使用户把 mode 设成 off（只想关掉注入），
   * 也照样要注册。⚠️ 早先这一句写在函数末尾、且在 off 短路之后 ——
   * 于是 mode=off 的用户会发现 /update/status 变成 404，整个自更新面板凭空消失。 */
  registerUpdateRoutes(ctx, {
    getMode: () => store.get(),
    setMode: (next) => {
      const result = store.set(next);
      if (result.ok) injection.applyMode(result.mode);
      return result;
    },
  });
}

/* ================================================================== *
 * 注入模式：持久化 + 可运行时开关的语言注入
 * ================================================================== */

/** 插件数据目录（与自更新共用）。 */
function pluginDataDir() {
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(dshHome, 'plugin-data', 'dsh-thinking-panel');
}

/**
 * packageDir 是不是「开发目录」（`link:` 安装到工作区源码，通常带 `.git`）。
 *
 * ⚠️ 这个判断必须有：本机就是 `link:` 安装，`import.meta.url` 解析出来的 `packageDir`
 * **就是工作区源码目录**。默认开启的自动更新会在启动 8 秒后把 registry 上的版本
 * **直接写进源码目录**，把未提交的改动覆盖掉（代码审查发现）。
 * 手动点「更新」不拦 —— 那是用户的明确动作。
 */
function isDevelopmentDir(packageDir) {
  try { return existsSync(join(packageDir, '.git')); } catch { return false; }
}

/** 把 mode 存在插件数据目录里；`cordis.patch.yml` 只提供首次运行的默认值。 */
function createModeStore(fallback) {
  const file = join(pluginDataDir(), 'settings.json');
  let value = fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.mode === 'string' && MODES.includes(parsed.mode)) value = parsed.mode;
  } catch { /* 首次运行或文件损坏：用配置里的默认值 */ }
  return {
    get: () => value,
    /** @returns {{ok:boolean, mode?:string, error?:string}} */
    set: (mode) => {
      if (!MODES.includes(mode)) return { ok: false, error: `unknown mode: ${String(mode)}` };
      const previous = value;
      value = mode;
      try {
        /* 原子写（tmp + rename），与 self-update.js 的 saveState 一致：
         * 裸 writeFileSync 被中断会留下截断的 JSON，下次解析失败被静默吞掉 ——
         * 表现是「用户明确关掉的注入，重启后被悄悄打开」，而且坏文件永不自愈。 */
        mkdirSync(dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        writeFileSync(temp, `${JSON.stringify({ mode }, null, 2)}\n`);
        renameSync(temp, file);
        return { ok: true, mode, persisted: true };
      } catch (error) {
        // 落盘失败：内存值仍然生效（本次会话有效），但必须如实告诉客户端「没存住」
        value = previous;
        try { console.warn(`[dsh-thinking-panel] 设置落盘失败：${error.message}`); } catch { /* ignore */ }
        return { ok: false, mode: previous, persisted: false, error: `设置落盘失败：${error.message}` };
      }
    },
  };
}

/**
 * 语言注入 —— **可运行时开关**。
 *
 * 段落/上下文的文本注册后不能原地改，所以切换模式的做法是
 * 「先全部注销 → 再按新模式注册」。顺序不能反：同层同名重复注册会抛错。
 */
function createInjection(ctx) {
  const hasSection = typeof ctx.systemPrompt?.section === 'function';
  const hasContext = typeof ctx.systemPrompt?.context === 'function';
  let disposers = [];

  function disposeAll() {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ }
    }
    disposers = [];
  }

  function applyMode(mode) {
    disposeAll();
    const text = reasoningLanguageRule(mode);
    if (text === null) return { ok: true, mode, active: false };   // off：什么都不注册
    if (hasSection) {
      disposers.push(ctx.effect(
        () => ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text }),
        'dsh-thinking-panel: reasoning-language section',
      ));
    }
    const context = reasoningLanguageContext(mode);
    if (context !== null && hasContext) {
      disposers.push(ctx.effect(
        () => ctx.systemPrompt.context({ name: CONTEXT_NAME, order: CONTEXT_ORDER, text: context }),
        'dsh-thinking-panel: reasoning-language context',
      ));
    }
    return { ok: true, mode, active: true };
  }

  return { applyMode, hasSection, hasContext };
}

/* ================================================================== *
 * 自更新：HTTP 端点
 *
 * Client 半部读状态、触发动作都走这里。端点只挂在本插件自己的前缀下，
 * 并复用 DSH 的 connection.requestRejection 做鉴权；变更类方法一律要求 POST。
 * ================================================================== */

const ROUTE_PREFIX = '/dsh-thinking-panel/update';

/** 会改动文件系统或状态的方法，必须走 POST（GET 只用于读状态，可被缓存/预取）。 */
const MUTATING = new Set(['check', 'install', 'rollback', 'auto-update', 'mode']);

/** 启动后多久做一次自动更新检查（不阻塞启动）。 */
const AUTO_UPDATE_DELAY_MS = 8000;

function registerUpdateRoutes(ctx, settings = {}) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    let updater = null;
    try {
      const packageDir = dirname(fileURLToPath(import.meta.url));
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      updater = createSelfUpdater({
        packageDir,
        dataDir: pluginDataDir(),
        runningVersion: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        log: (message) => { try { console.log(`[dsh-thinking-panel] ${message}`); } catch { /* ignore */ } },
      });
    } catch (error) {
      // 自更新不可用不应该影响插件本身
      compatReport('自更新初始化失败（插件功能不受影响）', String(error && error.message ? error.message : error));
      return;
    }

    const routes = {
      // status 顺带把「语言注入模式」带上，设置页一次请求就能渲染完整
      status: () => ({
        ...updater.status(),
        mode: typeof settings.getMode === 'function' ? settings.getMode() : null,
      }),
      check: () => updater.check(),
      install: (args) => updater.install(args && args.version),
      rollback: (args) => updater.rollback(args && args.version),
      'auto-update': (args) => updater.setAutoUpdate(args && args.enabled),
      mode: (args) => (typeof settings.setMode === 'function'
        ? settings.setMode(args && args.mode)
        : { ok: false, error: 'mode 未接线' }),
    };

    const handler = async (req, res) => {
      const send = (status, payload) => {
        let body = '';
        try { body = JSON.stringify(payload); } catch { body = '{"error":"serialize failed"}'; }
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        res.end(body);
      };
      try {
        // 复用 DSH 的鉴权边界：未授权请求直接拒绝
        const rejection = webCtx.connection.requestRejection(req);
        if (rejection !== undefined) { send(rejection, { error: 'request rejected' }); return; }

        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) { send(404, { error: 'not found' }); return; }
        const method = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
        const fn = Object.hasOwn(routes, method) ? routes[method] : null;
        if (typeof fn !== 'function') { send(404, { error: `unknown method: ${method}` }); return; }
        if (MUTATING.has(method) && req.method !== 'POST') {
          send(405, { error: 'mutating methods require POST' });
          return;
        }

        let args = {};
        if (req.method === 'POST') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.length > 0) {
            try { args = JSON.parse(raw); } catch { send(400, { error: 'invalid JSON body' }); return; }
          }
        }
        send(200, await fn(args));
      } catch (error) {
        send(500, { error: error && error.message ? error.message : String(error) });
      }
    };

    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
      'dsh-thinking-panel: self-update routes',
    );

    /* 自动更新：启动后延迟跑一次，用户不用点任何东西。
     * 关掉开关的人在 autoUpdate() 里会直接短路；失败也不打扰用户 —— 状态里能看到 lastError。
     * ⚠️ 但**开发目录绝不自动更新**：那会把 registry 上的版本写进工作区源码（见 isDevelopmentDir）。 */
    const development = isDevelopmentDir(packageDir);
    try {
      if (development) {
        console.log('[dsh-thinking-panel] 检测到开发目录（link: 安装），已跳过自动更新；'
          + '要升级请手动点设置页里的「更新」');
      } else if (updater.status().autoUpdate) {
        const timer = setTimeout(() => {
          updater.autoUpdate().then((result) => {
            if (result && result.ok && result.version) {
              console.log(`[dsh-thinking-panel] 已自动更新到 ${result.version}，重启 DSH 后生效`);
            }
          }, () => { /* ignore */ });
        }, AUTO_UPDATE_DELAY_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    } catch { /* ignore */ }
  });
}
