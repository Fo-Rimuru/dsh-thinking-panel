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
import { readFileSync } from 'node:fs';
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
  const mode = MODES.includes(rawMode) ? rawMode : 'auto';
  const text = reasoningLanguageRule(mode);
  if (text === null) return;

  // 兼容性自检：两个注入通道分别判断，缺一个就降级一个
  const hasSection = typeof ctx.systemPrompt?.section === 'function';
  const hasContext = typeof ctx.systemPrompt?.context === 'function';
  if (!hasSection && !hasContext) {
    compatReport(
      'systemPrompt.section 与 systemPrompt.context 都不可用',
      'Host 半部无法注入任何规则，语言跟随不会生效（样式部分不受影响）。',
    );
    return;
  }
  if (!hasContext) {
    compatReport(
      'systemPrompt.context 不可用',
      '只能注入系统提示词段落。实测仅靠段落时语言跟随会明显变弱（CJK 0.096 量级）。',
    );
  }

  // ① 系统提示词段落：排在最末（order 10300 > DEPLOYMENT_PERSONA_SUFFIX 10200）
  if (hasSection) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text,
      }),
      'dsh-thinking-panel: reasoning-language section',
    );
  }

  // ② 运行时上下文：既进日志、又紧贴用户回合，离生成点最近（实测更有效）
  const context = reasoningLanguageContext(mode);
  if (context !== null && hasContext) {
    ctx.effect(
      () => ctx.systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: context,
      }),
      'dsh-thinking-panel: reasoning-language context',
    );
  }

  // ③ 自更新端点（可选：没有 webServer 就静默跳过，不影响上面的功能）
  registerUpdateRoutes(ctx);
}

/* ================================================================== *
 * 自更新：HTTP 端点
 *
 * Client 半部读状态、触发动作都走这里。端点只挂在本插件自己的前缀下，
 * 并复用 DSH 的 connection.requestRejection 做鉴权；变更类方法一律要求 POST。
 * ================================================================== */

const ROUTE_PREFIX = '/dsh-thinking-panel/update';

/** 会改动文件系统或状态的方法，必须走 POST（GET 只用于读状态，可被缓存/预取）。 */
const MUTATING = new Set(['check', 'install', 'rollback', 'auto-update']);

function registerUpdateRoutes(ctx) {
  if (typeof ctx.inject !== 'function') return;
  ctx.inject(['connection', 'webServer'], (webCtx) => {
    let updater = null;
    try {
      const packageDir = dirname(fileURLToPath(import.meta.url));
      const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh');
      const dataDir = join(dshHome, 'plugin-data', 'dsh-thinking-panel');
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
      updater = createSelfUpdater({
        packageDir,
        dataDir,
        runningVersion: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
        log: (message) => { try { console.log(`[dsh-thinking-panel] ${message}`); } catch { /* ignore */ } },
      });
    } catch (error) {
      // 自更新不可用不应该影响插件本身
      compatReport('自更新初始化失败（插件功能不受影响）', String(error && error.message ? error.message : error));
      return;
    }

    const routes = {
      status: () => updater.status(),
      check: () => updater.check(),
      install: (args) => updater.install(args.version),
      rollback: (args) => updater.rollback(args.version),
      'auto-update': (args) => updater.setAutoUpdate(args.enabled),
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
  });
}
