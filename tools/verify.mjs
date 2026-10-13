/**
 * 原型自检：不安装插件即可验证两半部的正确性。
 *
 *  1. Host 半部：ESM 导入 → mock ctx 调用 apply → 校验注册的 PromptSection 合法。
 *  2. Client 半部：VM 沙箱执行 client.js → 取 factory → mock React/ctx → 校验
 *     locale 注册、三个 slot 注册，并**真实渲染 assistant-step 组件树**断言：
 *       · reasoning 块渲染成思考面板（dst-think / 标题 / 图标）
 *       · text 块渲染成 Markdown
 *       · groupPart 过滤规则与出厂 AssistantMarkdown 一致
 *       · tool-call 块被跳过（它是独立节点）
 *       · 图片块走 renderMessageImages 且连续图片合并成一组
 *       · ui-primitives 取不到时降级为纯文本，不抛错
 *  3. 规格交叉比对：把组件里实现的规则回查出厂源码，确认不是臆造。
 *
 * 用法： node tools/verify.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');

/**
 * DSH 出厂源码目录 —— **可选**。
 *
 * 第 [3] 节的「规格交叉比对」需要一份 DSH 解包源码副本，用来确认组件里实现的规则
 * 是逐条对应出厂实现、而不是臆造。该源码不属于本项目，仓库里不包含它，
 * 因此未提供时这些断言记为 **SKIP**：既不算通过，也不算失败。
 *
 *   DSH_SRC_DIR=<含 ui-chat-client.js / ui-theme-client.js 的目录> node tools/verify.mjs
 *   或  node tools/verify.mjs <该目录>
 *
 * 另有 3 项依赖槽目录导出（`Slots.listSubTree` 的文本结果），用
 * `DSH_SLOT_CATALOG=<文件路径>` 提供；未提供时同样 SKIP。
 */
const srcDir = (process.env.DSH_SRC_DIR ?? process.argv[2] ?? '').trim();
const catalogPath = (process.env.DSH_SLOT_CATALOG ?? '').trim();
const haveSrc = srcDir !== '' && fs.existsSync(srcDir);
const haveCatalog = catalogPath !== '' && fs.existsSync(catalogPath);

let pass = 0;
let fail = 0;
let skipped = 0;
const failures = [];
const skips = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 材料缺失（不是断言不成立）时记 SKIP，避免在别人的机器上制造假失败。 */
function skip(name, reason) {
  skipped++;
  skips.push(name);
  console.log(`  SKIP  ${name}${reason ? ` — ${reason}` : ''}`);
}

/* ================================================================== *
 * 1. Host half
 * ================================================================== */
console.log('\n[1] Host 半部 (index.js)');
const host = await import(path.join(pkgDir, 'index.js').replace(/\\/g, '/').replace(/^/, 'file:///'));

check('导出 apply 函数', typeof host.apply === 'function');
/* 反向断言：**不要**用静态 inject 做硬门禁 —— 服务不满足时插件会「静默不激活」
 *（apply 根本不被调用，只在 web boot 里留一句 `1 entry did not activate`）。
 * 对照 @copylee/dsh-computer-use：它用运行时 ctx.inject(["systemPrompt"], …)。 */
check('不用静态 inject 硬门禁（改成运行时可选获取）', host.inject === undefined);
check('SECTION_ORDER 是有限数', Number.isFinite(host.SECTION_ORDER));
check('SECTION_ORDER 排在系统提示词最末（> DEPLOYMENT_PERSONA_SUFFIX 10200）',
  host.SECTION_ORDER > 10200, `order=${host.SECTION_ORDER}`);
check('CONTEXT_ORDER 排在既有上下文之后（> SUBAGENT_DELEGATION 120）',
  host.CONTEXT_ORDER > 120, `order=${host.CONTEXT_ORDER}`);

const sections = [];
const contexts = [];
const effects = [];
const mockHostCtx = {
  effect(fn, label) { effects.push({ fn, label }); return fn(); },
  systemPrompt: {
    section(section) { sections.push(section); return () => {}; },
    context(context) { contexts.push(context); return () => {}; },
  },
};

host.apply(mockHostCtx, { mode: 'auto' });

check('apply 通过 ctx.effect 注册资源', effects.length === 2, `effects=${effects.length}`);
check('每个 ctx.effect 都带诊断 label',
  effects.every((e) => typeof e.label === 'string' && e.label.length > 0));
check('注册了恰好 1 个 PromptSection', sections.length === 1, `got ${sections.length}`);
check('注册了恰好 1 个运行时上下文', contexts.length === 1, `got ${contexts.length}`);

const sec = sections[0] ?? {};
check('PromptSection.name 为非空字符串', typeof sec.name === 'string' && sec.name.length > 0);
check('PromptSection.order 有限（非有限值会 throw）', Number.isFinite(sec.order));
check('PromptSection.text 为非空字符串', typeof sec.text === 'string' && sec.text.length > 20);
check('规则文本要求「与用户最近一条消息相同的语言」', /相同的语言/.test(sec.text ?? ''));
check('规则文本声明只约束思考过程', /只约束思考过程/.test(sec.text ?? ''));
check('SECTION_NAME 与 PromptSection.name 一致', sec.name === host.SECTION_NAME);
check('SECTION_NAME 与 CONTEXT_NAME 不同（两个注册表）', host.SECTION_NAME !== host.CONTEXT_NAME);

const ctx0 = contexts[0] ?? {};
check('PromptContext.name 正确', ctx0.name === host.CONTEXT_NAME);
check('PromptContext.order 有限', Number.isFinite(ctx0.order));
check('运行时上下文要求「立即生效」', /立即生效/.test(String(ctx0.text ?? '')));
check('运行时上下文比段落更短（更贴近生成点）',
  String(ctx0.text ?? '').length < String(sec.text ?? '').length);

for (const [mode, expectNull, needle] of [
  ['auto', false, '相同的语言'],
  ['zh', false, '全部使用中文书写'],
  ['en', false, 'entirely in English'],
  ['off', true, null],
]) {
  const s = [];
  const c = [];
  const ctx = {
    effect: (fn) => fn(),
    systemPrompt: { section: (x) => { s.push(x); return () => {}; }, context: (x) => { c.push(x); return () => {}; } },
  };
  host.apply(ctx, { mode });
  if (expectNull) {
    check(`mode=${mode} 不注册段落`, s.length === 0, `got ${s.length}`);
    check(`mode=${mode} 不注册上下文`, c.length === 0, `got ${c.length}`);
  } else {
    check(`mode=${mode} 注册段落且文本命中关键词`, s.length === 1 && s[0].text.includes(needle));
    check(`mode=${mode} 注册上下文`, c.length === 1, `got ${c.length}`);
  }
}

{
  const s = [];
  const c = [];
  const ctx = {
    effect: (fn) => fn(),
    systemPrompt: { section: (x) => { s.push(x); return () => {}; }, context: (x) => { c.push(x); return () => {}; } },
  };
  host.apply(ctx, { mode: 'bogus' });
  check('未知 mode 回落到 auto', s.length === 1 && s[0].text === host.reasoningLanguageRule('auto'));
}

/* ================================================================== *
 * 2. Client half
 * ================================================================== */
console.log('\n[2] Client 半部 (client.js)');

const clientSrc = fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8');
const loaded = [];
const sandbox = {
  window: {
    __ModuleLoader__: { load: (m) => loaded.push(m) },
    localStorage: {
      _v: {},
      getItem(k) { return this._v[k] ?? null; },
      setItem(k, v) { this._v[k] = String(v); },
    },
  },
  console,
  document: { baseURI: 'http://localhost/' },
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  /* 「首次失败要重试」的路径需要 setTimeout，但不能真拖住测试进程 → 收进队列手动 flush。 */
  setTimeout: (fn) => { timerQueue.push(fn); return timerQueue.length; },
  clearTimeout: () => {},
  /* 自动展开走的是官方 useSearchableHidden 的 beforematch 揭示通道，沙箱里要有 Event。 */
  Event: class Event { constructor(type) { this.type = String(type); } },
};
vm.createContext(sandbox);
vm.runInContext(clientSrc, sandbox, { filename: 'client.js' });

check('模块加载时恰好注册 1 个 factory', loaded.length === 1, `got ${loaded.length}`);
const mod = loaded[0] ?? {};
check('模块 id 等于包名', mod.id === 'dsh-thinking-panel', String(mod.id));
check('factory 是函数', typeof mod.factory === 'function');

/* --- minimal React stub ------------------------------------------------ */
/** 假的滚动元素：用于验证「跟随最新内容」的滚动逻辑。默认是一个溢出的滚动盒。 */
function makeFakeElement(init = {}) {
  return {
    scrollTop: 0,
    scrollHeight: init.scrollHeight ?? 1000,
    clientHeight: init.clientHeight ?? 100,
    attrs: {},
    listeners: {},
    ownerDocument: { activeElement: null },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); },
    removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter((f) => f !== fn); },
    contains() { return false; },
    /* 默认「不在任何过程组里」；自动展开的测试会覆写这两个方法挂一棵假 DOM 树。 */
    closest() { return null; },
    querySelector() { return null; },
    dispatchEvent(event) { (this.dispatched ||= []).push(event?.type); return true; },
  };
}
/** 可控的 requestAnimationFrame：手动 flush，模拟「scroll 事件先于下一帧」的时序。 */
const rafQueue = [];
const flushRaf = () => { const q = rafQueue.splice(0); for (const fn of q) fn(); };
/** 可控的 setTimeout（同上：先收起来，由测试手动触发）。 */
const timerQueue = [];
const flushTimers = () => { const q = timerQueue.splice(0); for (const fn of q) fn(); };
/**
 * 自动展开过程组的测试要往组件里塞一棵可控的假 DOM 树（面板 → 组体 → 组头）。
 * 非 null 时，React.useRef(null) 会把它当成「真实挂载后的 DOM 节点」返回。
 */
let fakeRoot = null;

class ReactComponent {
  constructor(props) { this.props = props ?? {}; this.state = {}; }
  setState(next) { this.state = { ...this.state, ...next }; }
}
const React = {
  Component: ReactComponent,
  createElement(type, props, ...children) {
    const kids = children.flat().filter((c) => c !== undefined && c !== null);
    // React 语义：children 同时出现在 props.children（类组件依赖它）
    return { type, props: { ...(props ?? {}), children: kids.length === 1 ? kids[0] : kids }, children: kids };
  },
  Fragment: '@fragment',
  useReducer(_r, init) { return [init, () => {}]; },
  useState(init) { return [init, () => {}]; },
  useEffect(fn) { return fn(); },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  // null 初始化的 ref 给一个假 DOM 元素（可用 fakeRoot 注入测试用的 DOM 树）；
  // 其余（true/false）原样返回
  useRef(init) { return { current: init === null ? (fakeRoot ?? makeFakeElement()) : init }; },
};
const primitives = {
  MarkdownText: function MarkdownText(p) { return React.createElement('markdown', p); },
  JsonBlock: function JsonBlock(p) { return React.createElement('json', p); },
  IconThinkOutlineRegular: function IconThinkOutlineRegular(p) { return React.createElement('think-icon', p); },
  Switch: function Switch(p) { return React.createElement('switch', p); },
};
let primitivesAvailable = true;
const requireStub = (name) => {
  if (name === 'react') return React;
  if (name === '@deepseek-ai/dsh-client-ui-primitives') {
    if (!primitivesAvailable) throw new Error('not available');
    return primitives;
  }
  throw new Error(`unexpected require('${name}')`);
};

const client = mod.factory(requireStub);
check('factory 返回 inject 列表', Array.isArray(client.inject));
check('inject 含 slots 与 locale', client.inject.includes('slots') && client.inject.includes('locale'));

/* --- mock ctx --------------------------------------------------------- */
const localeRegs = [];
const slotInjects = [];
const slotRegs = [];
const clientEffects = [];
const dictsFor = (ns) => localeRegs.find((r) => r.ns === ns)?.dicts?.zh;
const t = (key, params) => {
  let s = dictsFor('thinking-panel')?.[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
  return s;
};
const mockClientCtx = {
  effect(fn, label) { clientEffects.push(label); return fn(); },
  locale: {
    register(ns, dicts) { localeRegs.push({ ns, dicts }); return () => {}; },
    bind() { return t; },
  },
  slots: {
    inject(key, cb) { slotInjects.push(key); return cb(); },
    register(options, component) { slotRegs.push({ options, component }); return () => {}; },
  },
};

client.apply(mockClientCtx);

check('注册了 locale 字典（新命名空间）', localeRegs.length === 1 && localeRegs[0].ns === 'thinking-panel');
check('字典含 zh 与 en 两套', !!localeRegs[0]?.dicts?.zh && !!localeRegs[0]?.dicts?.en);
check('locale 注册走 ctx.effect', clientEffects.some((l) => String(l).includes('dictionaries')));

check('slots.inject 了 shell.overlay', slotInjects.includes('shell.overlay'));
check('slots.inject 了 settings.section（设置左侧导航独立一栏）', slotInjects.includes('settings.section'));
check('slots.inject 了 conversation.chat.node', slotInjects.includes('conversation.chat.node'));
check('恰好注册 3 个 slot 条目', slotRegs.length === 3, `got ${slotRegs.length}`);

const styleReg = slotRegs.find((r) => r.options.name === 'shell.overlay');
const settingsReg = slotRegs.find((r) => r.options.name === 'settings.section');
const nodeReg = slotRegs.find((r) => r.options.name === 'conversation.chat.node');
check('shell.overlay 条目 id 正确', styleReg?.options.id === 'thinking-panel-style');
check('settings.section 条目 id 正确', settingsReg?.options.id === 'thinking-panel');
check('settings.section 带 label thunk（跟随语言切换）',
  typeof settingsReg?.options.label === 'function' && String(settingsReg.options.label()).length > 0);
check('settings.section 的 order 是数字（与电脑控制 61 / 壁纸引擎 500 不撞）',
  typeof settingsReg?.options.order === 'number');
check('conversation.chat.node 条目 key = assistant-step', nodeReg?.options.key === 'assistant-step');
check('conversation.chat.node 条目用更低优先级遮蔽（运行时要求 lowest renders）',
  nodeReg?.options.priority === -1, `priority=${nodeReg?.options.priority}`);
check('注册失败时不抛出（出厂渲染器保持可用）',
  /try \{[\s\S]{0,200}ctx\.slots\.register\(\{[\s\S]{0,300}\} catch \(error\)/.test(clientSrc));
check('三个条目组件都是函数',
  typeof styleReg?.component === 'function'
  && typeof settingsReg?.component === 'function'
  && typeof nodeReg?.component === 'function');

/* --- 渲染 <style> ------------------------------------------------------ */
/* StyleSeat 现在返回 Fragment：<style> + 一个隐藏的图标样板（设置导航项的 DOM 补丁克隆它）。 */
const styleSeatTree = styleReg.component();
const styleSeatNodes = styleSeatTree && Array.isArray(styleSeatTree.children)
  ? styleSeatTree.children
  : [styleSeatTree];
const styleEl = styleSeatNodes.find((node) => node && node.type === 'style');
check('StyleSeat 渲染出 <style> 元素', !!styleEl, `type=${typeof styleSeatTree?.type}`);
check('style 带 data-plugin 标记', styleEl?.props?.['data-plugin'] === 'dsh-thinking-panel');
check('StyleSeat 同时给出图标样板（导航项图标从它克隆）',
  /className: 'dst-icon-sample'/.test(clientSrc));
const css = typeof styleEl?.children?.[0] === 'string' ? styleEl.children[0] : String(styleEl?.children ?? '');
check('CSS 非空', css.length > 300, `${css.length} chars`);

for (const [label, needle] of [
  ['自有命名空间 dst-think', '.dst-think{'],
  ['左侧竖线', 'border-left:1px solid var(--dsw-alias-label-dimmed)'],
  ['竖线定位 left:7.5px', 'left:7.5px'],
  ['官方容器内边距', 'padding:5px 0 5px 22px'],
  ['图标品牌色', 'color:var(--dsw-alias-brand-primary)'],
  ['标题常态色', 'color:var(--dsw-alias-label-secondary)'],
  ['标题悬停色', 'color:var(--dsw-alias-label-primary)'],
  ['正文官方字体令牌', 'font:var(--dsw-font-markdown-small)'],
  ['预览高度上限 = 行数变量 × 行高 + 10dp', 'max-height:calc(var(--dst-preview-lines,5) * 20px + 10px'],
  ['预览可滚动', 'overflow-y:auto'],
  ['滚动淡出遮罩', 'mask-image:linear-gradient(180deg'],
  ['折叠推理块间距（出厂同构）', '[data-turn-process-inline][hidden]{margin-bottom:-16px}'],
  ['展开态有高度上限', 'max-height:min(60vh, 640px)'],
  ['展开态可内部滚动', '.dst-think-body{margin-top:4px;color:var(--dsw-alias-label-secondary);'],
  ['展开态显式绘制滚动条', '.dst-think-body::-webkit-scrollbar{width:8px'],
  ['滚动条滑块可拖动样式', '.dst-think-body::-webkit-scrollbar-thumb'],
]) {
  check(`CSS 含${label}`, css.includes(needle), needle);
}
check('CSS 不再针对出厂类名做覆盖',
  !/\[class\*="_/.test(css) && !/_thinkBody|_summaryText|_3GBCTG/.test(css));

/* --- 错误边界（源码级断言：槽条目失败模式是整行空白，必须有兜底） --- */
check('存在错误边界类组件', /class ThinkingBoundary extends React\.Component/.test(clientSrc));
check('错误边界实现 getDerivedStateFromError', /static getDerivedStateFromError\(\)/.test(clientSrc));
check('错误边界实现 componentDidCatch 记录日志', /componentDidCatch\(error\)/.test(clientSrc));
check('assistant-step 输出被错误边界包裹', /h\(ThinkingBoundary, \{ blocks \}/.test(clientSrc));
check('存在不依赖任何客户端包的纯文本兜底', /function plainFallback\(blocks\)/.test(clientSrc));

/* --- 出厂 DOM 契约：折叠推理块必须保留可查找性 --- */
check('复刻 useSearchableHidden', /function useSearchableHidden\(hidden, reveal\)/.test(clientSrc));
check('折叠态使用 hidden="until-found"（保留页内查找）', /setAttribute\('hidden', 'until-found'\)/.test(clientSrc));
check('监听 beforematch 以支持页内查找揭示', /addEventListener\('beforematch'/.test(clientSrc));
check('推理块外层带 data-turn-process-inline 锚点', /'data-turn-process-inline': hidden \|\| undefined/.test(clientSrc));

/* --- 出厂 Markdown 装饰契约：labels 形状不完整会在渲染代码块时抛错 --- */
check('复刻 markdownLabels 工厂', /function markdownLabels\(tr\)/.test(clientSrc));
check('labels 含 code.toolbarLabels 完整形状',
  /codeLabel: tr\('md\.codeBlock\.title'\)/.test(clientSrc)
  && /wrapLabel: tr\('md\.codeBlock\.wrap'\)/.test(clientSrc)
  && /unwrapLabel: tr\('md\.codeBlock\.unwrap'\)/.test(clientSrc));
check('labels 含 footnotes', /footnotes: tr\('md\.footnotes'\)/.test(clientSrc));
check('每处 MarkdownText 都传 labels',
  (clientSrc.match(/MarkdownText, \{[^}]*\}/g) || []).every((m) => m.includes('labels'))
  && (clientSrc.match(/MarkdownText, \{/g) || []).length === 2,
  `MarkdownText 用法数=${(clientSrc.match(/MarkdownText, \{/g) || []).length}`);

/* --- 递归渲染助手 ------------------------------------------------------ */
function render(node, depth = 0) {
  if (depth > 30 || node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((n) => render(n, depth + 1));
  if (typeof node === 'function') return render(node(), depth + 1);
  if (typeof node === 'object' && typeof node.type === 'function') {
    const T = node.type;
    // 类组件（错误边界）用 new 实例化后调 render()
    if (T.prototype && typeof T.prototype.render === 'function') {
      const inst = new T(node.props);
      inst.state = inst.state ?? {};
      return render(inst.render(), depth + 1);
    }
    return render(T(node.props), depth + 1);
  }
  if (typeof node === 'object' && node.children) {
    return { ...node, children: node.children.map((c) => render(c, depth + 1)) };
  }
  return node;
}
const flatten = (n, out = []) => {
  if (n === null || n === undefined) return out;
  if (Array.isArray(n)) { n.forEach((x) => flatten(x, out)); return out; }
  if (typeof n === 'object') {
    out.push(n);
    if (n.children) flatten(n.children, out);
  }
  return out;
};

const imageCalls = [];
const baseProps = (over = {}) => ({
  node: {
    key: 'assistant-step:1:1',
    data: {
      status: 'running', turn: 1, step: 1,
      blocks: [
        { kind: 'reasoning', text: '第一步：确认官方实现。\n第二步：评估可行性。' },
        { kind: 'text', text: '这是最终回答。' },
      ],
    },
    location: { kind: 'step', turn: { status: 'open' } },
  },
  groupPart: undefined,
  renderMessageImages: (owner) => { imageCalls.push(owner); return React.createElement('images', owner); },
  fileMentions: () => undefined,
  turnProcess: undefined,
  useDisclosure: () => ({ expanded: false, toggle: () => {} }),
  t,
  ...over,
});

// (a) 思考中（reasoning 是最后一块 = 流式尾部）→ 面板处于 running
{
  const tree = render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'assistant-step:1:1',
      data: { status: 'running', turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: '第一步：确认官方实现。' }] },
      location: { kind: 'step', turn: { status: 'open' } },
    },
  })));
  const nodes = flatten(tree);
  check('默认渲染出思考面板', nodes.some((n) => n.props?.className === 'dst-think'));
  const head = nodes.find((n) => n.props?.className === 'dst-think-head');
  check('思考面板含标题行', !!head);
  check('标题行含思考图标', nodes.some((n) => n.type === 'think-icon'));
  check('思考中标题为「深度思考中」', JSON.stringify(head?.children ?? '').includes('深度思考中'));
  check('思考面板带 data-state="running"', nodes.some((n) => n.props?.['data-state'] === 'running'));
  check('折叠态带 data-collapsed（可展开）', nodes.some((n) => n.props?.['data-collapsed'] === true));
  check('折叠态渲染预览容器', nodes.some((n) => n.props?.className === 'dst-think-preview'));
  check('预览容器渲染完整推理文本', JSON.stringify(nodes.find((n) => n.props?.className === 'dst-think-preview')?.children ?? '').includes('确认官方实现'));
}

// (a2) reasoning 之后已有正文 → reasoning 不再是流式尾部，标题转为「已思考」
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps())));
  check('默认用例同时渲染思考与正文',
    nodes.some((n) => n.props?.className === 'dst-think') && nodes.some((n) => n.type === 'markdown'));
  const head = nodes.find((n) => n.props?.className === 'dst-think-head');
  check('reasoning 非尾部时不再显示「深度思考中」', !JSON.stringify(head?.children ?? '').includes('深度思考中'));
}

// (b) groupPart = 'reasoning'：只留 reasoning
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({ groupPart: 'reasoning' }))));
  check('groupPart=reasoning 保留思考面板', nodes.some((n) => n.props?.className === 'dst-think'));
  const texts = nodes.filter((n) => n.type === 'markdown').map((n) => n.props?.text);
  check('groupPart=reasoning 过滤掉正文块',
    !texts.some((x) => typeof x === 'string' && x.includes('这是最终回答')), JSON.stringify(texts));
}

// (c) groupPart = 'response'：跳过 reasoning
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({ groupPart: 'response' }))));
  check('groupPart=response 跳过思考面板', !nodes.some((n) => n.props?.className === 'dst-think'));
  check('groupPart=response 保留正文', nodes.some((n) => n.type === 'markdown'));
}

// (d) tool-call 跳过；连续图片合并
{
  imageCalls.length = 0;
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'k2',
      data: {
        status: 'ok', turn: 2, step: 1,
        blocks: [
          { kind: 'tool-call', callId: 'c1' },
          { kind: 'image', attachment: { id: 'a' } },
          { kind: 'image', attachment: { id: 'b' } },
          { kind: 'text', text: 'done' },
        ],
      },
      location: { kind: 'step', turn: { status: 'open' } },
    },
  }))));
  check('tool-call 块不在本节点渲染', !JSON.stringify(nodes).includes('c1'));
  check('图片块调用 renderMessageImages', imageCalls.length === 1, `calls=${imageCalls.length}`);
  check('连续图片合并为一组（2 张）', imageCalls[0]?.images?.length === 2, JSON.stringify(imageCalls[0]?.images));
  check('图片组 align=start', imageCalls[0]?.align === 'start');
}

// (e) 思考结束：标题变「已思考」
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'k3',
      data: { status: 'ok', turn: 3, step: 1, blocks: [{ kind: 'reasoning', text: '推理内容' }] },
      location: { kind: 'step', turn: { status: 'open' } },
    },
  }))));
  const head = nodes.find((n) => n.props?.className === 'dst-think-head');
  check('思考结束标题为「已思考」', JSON.stringify(head?.children ?? '').includes('已思考'));
  check('思考结束 data-state="ok"', nodes.some((n) => n.props?.['data-state'] === 'ok'));
}

// (f) 展开态
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({
    useDisclosure: () => ({ expanded: true, toggle: () => {} }),
  }))));
  const body = nodes.find((n) => n.props?.className === 'dst-think-body');
  check('展开态渲染 dst-think-body', !!body);
  check('展开态不渲染预览容器', !nodes.some((n) => n.props?.className === 'dst-think-preview'));
  // 回归：展开态早先既没挂 scrollRef、effect 里又 `|| expanded` 提前返回，
  // 导致流式推理展开后停在中途、用户得手动往下拖（用户实测反馈）。
  check('展开态滚动容器挂了滚动 ref',
    !!body?.props?.ref?.current && typeof body.props.ref.current.scrollTop === 'number');
  check('展开态注册了 onScroll', typeof body?.props?.onScroll === 'function');
  check('展开态也自动滚到底部（跟随最新内容）',
    body?.props?.ref?.current?.scrollTop === body?.props?.ref?.current?.scrollHeight,
    `scrollTop=${body?.props?.ref?.current?.scrollTop}`);
}

// (g) 空 blocks → null
{
  const tree = render(React.createElement(nodeReg.component, baseProps({
    node: { key: 'k4', data: { status: 'ok', turn: 4, step: 1, blocks: [] }, location: { kind: 'step', turn: { status: 'open' } } },
  })));
  check('空 blocks 返回 null', tree === null || tree === undefined);
}

// (g2) MarkdownText 必须拿到完整的 labels（缺 code.toolbarLabels 会抛错）
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'k5',
      data: { status: 'ok', turn: 5, step: 1, blocks: [{ kind: 'text', text: '```js\nconst a = 1;\n```' }] },
      location: { kind: 'step', turn: { status: 'open' } },
    },
  }))));
  const md = nodes.filter((n) => n.type === 'markdown');
  check('正文 Markdown 收到 labels', md.length === 1 && !!md[0].props?.labels);
  check('labels.code.toolbarLabels 完整',
    !!md[0]?.props?.labels?.code?.toolbarLabels?.codeLabel
    && !!md[0]?.props?.labels?.code?.toolbarLabels?.wrapLabel
    && !!md[0]?.props?.labels?.code?.toolbarLabels?.unwrapLabel);
  check('labels.code.copyLabel / copiedLabel 存在',
    !!md[0]?.props?.labels?.code?.copyLabel && !!md[0]?.props?.labels?.code?.copiedLabel);
  check('labels.footnotes 存在', 'footnotes' in (md[0]?.props?.labels ?? {}));

  const think = nodes.filter((n) => n.type === 'markdown' && n.props?.variant === 'compact');
  check('思考面板 Markdown 也收到 labels', think.length === 0 || !!think[0].props?.labels);
}

// (i) 思考中预览必须自动跟随最新内容（回归：程序化滚动曾被误判为用户拖动）
{
  const nodes = flatten(render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'k6',
      data: { status: 'running', turn: 6, step: 1, blocks: [{ kind: 'reasoning', text: '很长的推理内容'.repeat(200) }] },
      location: { kind: 'step', turn: { status: 'open' } },
    },
  }))));
  const preview = nodes.find((n) => n.props?.className === 'dst-think-preview');
  check('运行中渲染出预览容器', !!preview);
  const el = preview?.props?.ref?.current;
  check('预览容器挂了滚动 ref', !!el && typeof el.scrollTop === 'number');
  check('运行中自动滚到底部（跟随最新内容）',
    el && el.scrollTop === el.scrollHeight, `scrollTop=${el?.scrollTop} scrollHeight=${el?.scrollHeight}`);
  check('预览容器注册了 onScroll', typeof preview?.props?.onScroll === 'function');
  // 模拟「程序化滚动自己派发的 scroll 事件」：必须被忽略，不得关闭跟随
  const before = el.scrollTop;
  preview.props.onScroll();
  check('程序化滚动事件不改变滚动位置', el.scrollTop === before);
  flushRaf();
  // 模拟用户往上拖：距底部很远 → 暂停跟随（stick=false，本渲染周期内不可直接观测，
  // 由下面的静态断言保证逻辑接线正确）
  el.scrollTop = 200;
  preview.props.onScroll();
  check('用户拖动后不再强制回底（单次渲染内无可观测副作用）', el.scrollTop === 200);
}

// (j) 静态回归：滚动跟随的实现细节
{
  check('区分程序化滚动与用户滚动', /if \(programmatic\.current\) return;/.test(clientSrc));
  check('程序化滚动标记用 rAF 清除（scroll 事件先于下一帧）',
    /requestAnimationFrame\(clear\)/.test(clientSrc));
  check('已移除会误判的 userScrolled 标记', !/userScrolled/.test(clientSrc));
  check('距底部 24px 内视为跟随中',
    /const gap = el\.scrollHeight - el\.scrollTop - el\.clientHeight;/.test(clientSrc)
    && /gap < 24/.test(clientSrc));
  check('跟随 effect 不再跳过展开态（回归：曾写成 `|| expanded`）',
    !/if \(el === null \|\| expanded\) return;/.test(clientSrc));
  check('展开态与折叠态共用同一个滚动 ref', /ref: scrollRef,          \/\/ ★ 与折叠态共用/.test(clientSrc));
}

// (j2) 静态回归：耗时改为读出厂 timing，不再自己记账
{
  // 回归：早先用模块级 Map 按 node key 记账，而 node key 只在**会话内**唯一
  //（出厂就是 "${turn}:${step}"）→ 两个会话的 1:1 共用一条记录、耗时互相污染。
  check('耗时读出厂结算数据（node.data.finalNode.timing）',
    /data\.finalNode && data\.finalNode\.timing\) \|\| data\.timing/.test(clientSrc)
    && /const ms = completedTime - stepStartTime;/.test(clientSrc));
  check('不再自己记账（模块级计时 Map 与 noteRunning/noteSettled 都已移除）',
    !/const timings = new Map\(\)/.test(clientSrc) && !/noteRunning|noteSettled/.test(clientSrc));
  check('耗时对缺字段/非法值安全返回 null',
    /typeof stepStartTime !== 'number' \|\| typeof completedTime !== 'number'/.test(clientSrc)
    && /if \(!Number\.isFinite\(ms\) \|\| ms <= 0\) return null;/.test(clientSrc));
}

// (h) ui-primitives 不可用 → 纯文本降级
{
  primitivesAvailable = false;
  const mod2 = mod.factory(requireStub);
  const regs2 = [];
  const ctx2 = {
    effect: (fn) => fn(),
    locale: mockClientCtx.locale,
    slots: { inject: (k, cb) => cb(), register: (o, c) => { regs2.push({ o, c }); return () => {}; } },
  };
  let threw = null;
  try { mod2.apply(ctx2); } catch (e) { threw = e; }
  check('primitives 缺失时 apply 不抛错', threw === null, String(threw));
  const nodeReg2 = regs2.find((r) => r.o.name === 'conversation.chat.node');
  let threw2 = null;
  let nodes2 = [];
  try { nodes2 = flatten(render(React.createElement(nodeReg2.c, baseProps()))); } catch (e) { threw2 = e; }
  check('primitives 缺失时渲染不抛错', threw2 === null, String(threw2));
  check('primitives 缺失时降级为纯文本思考', nodes2.some((n) => n.props?.className === 'dst-plain-reasoning'));
  primitivesAvailable = true;
}

/* --- 设置行 ------------------------------------------------------------ */
{
  const tree = render(settingsReg.component());
  check('SettingsSection 渲染出元素树', !!tree && typeof tree.type === 'string', `type=${typeof tree?.type}`);
  const flat = JSON.stringify(tree);
  check('设置行使用 locale 文案（中文标题）', flat.includes('深度思考面板'));
  check('设置行使用主题令牌', flat.includes('--dsw-alias-label-primary'));

  // 回归：早先是自绘的文字 button —— 深色主题下 --dsw-alias-brand-primary 与
  // --dsw-alias-label-primary 都是白色，白底白字，「已启用」几乎读不出来。
  // 现在优先用官方 Switch（与同页官方条目同款），primitives 缺失时才退回自绘滑块。
  const sw = flatten(tree).find((n) => n.type === 'switch');
  check('设置行使用官方 Switch 组件', !!sw);
  check('Switch 受控：checked 反映当前开关状态', typeof sw?.props?.checked === 'boolean');
  check('Switch 带无障碍 label', typeof sw?.props?.label === 'string' && sw.props.label.length > 0);
  check('Switch 的 onChange 是函数', typeof sw?.props?.onChange === 'function');
  // 回归：早先是自绘的文字 button —— 深色主题下 --dsw-alias-brand-primary 与
  // --dsw-alias-label-primary 都是白色，白底白字，「已启用」几乎读不出来。
  // （`aria-pressed` 现在也出现在设置页「预览行数」那排选项按钮上，所以按 Switch 的存在性判。）
  check('开关行用官方 Switch 或自绘滑块（不是文字按钮）',
    /\? h\(Switch, \{/.test(clientSrc) && /role: 'switch'/.test(clientSrc));
}

/* --- 0.2.0：设置页、开关接线与一批审查修复的回查 ------------------------ */
{
  const flat = flatten(render(settingsReg.component()));
  const sw = flat.filter((n) => n.type === 'switch');
  // 端点不可用（沙箱没有 fetch）时 UpdatePanel 会静默隐藏，所以这里只要求前两个开关
  check('设置页渲染出总开关与自动展开开关', sw.length >= 2, `got ${sw.length}`);
  check('设置页标题用 locale 文案', JSON.stringify(flat).includes('深度思考面板'));
}
check('注入开关走 Host 的 mode 端点（不存本地）',
  /run\('mode', \{ mode: next \? \(lastOnMode\.current \|\| 'auto'\) : 'off' \}\)/.test(clientSrc));
check('关掉再打开会恢复成关掉之前的模式（不把 zh/en 静默改成 auto）',
  /const lastOnMode = React\.useRef\('auto'\);/.test(clientSrc));
check('自动更新开关走 auto-update 端点',
  /run\('auto-update', \{ enabled: next \}\)/.test(clientSrc));
check('回退按钮显示 Host 算好的目标版本',
  /state\.previousVersion[\s\S]{0,140}update\.rollbackTo/.test(clientSrc));
check('兼容性提示会显示到设置页（不再只打控制台）',
  /settings\.compatWarn/.test(clientSrc) && /compatIssues\.push/.test(clientSrc));
check('思考面板有复制按钮', /dst-think-copy/.test(clientSrc) && /navigator\.clipboard/.test(clientSrc));
check('排版容器与出厂同构（.root 字号行高 / .body 16px 间距）',
  /\.dst-root\{font-size:var\(--dsh-content-font-size/.test(clientSrc)
  && /\.dst-body>\*\+\*\{margin-top:16px\}/.test(clientSrc));
check('排版容器刻意不用 flex+gap（flex item 的 min-height:auto 会把 5 行预览压成 1 行）',
  !/\.dst-body\{flex-direction:column;gap:16px/.test(clientSrc));

/* --- 0.2.1 新增的四个功能 ---------------------------------------------- */
check('思考中显示已用时间（用出厂的 data.time，不自己计时）',
  /startedAt: typeof data\.time === 'number' \? data\.time : null/.test(clientSrc)
  && /const liveSeconds = running && hasStart/.test(clientSrc));
check('自检区块渲染到设置页',
  /function DiagBlock\(props\)/.test(clientSrc) && /h\(DiagBlock, \{ key: 'diag'/.test(clientSrc));
check('自检记录自动展开的成功/放弃次数与导航图标状态',
  /diag\.revealHits \+= 1/.test(clientSrc) && /diag\.revealMisses \+= 1/.test(clientSrc)
  && /diag\.navIcon = 'applied'/.test(clientSrc));
check('「回到底部」只在没贴底时出现',
  /const backToBottom = atBottom \? null : h\('button'/.test(clientSrc));
// 回归：只挂在思考面板里不够 —— 面板在「最终回答」阶段已经不再变化（running=false、text 不变），
// 而内容还在长，那正是实测撞上的那条路。
check('不再往 assistant 节点上挂外层滚动兜底（该方案已撤销）',
  !/stepRef/.test(clientSrc) && !/followingRef/.test(clientSrc));
check('预览行数可配（滑动条 1–20，:root 上的 CSS 变量 + 记忆）',
  /var\(--dst-preview-lines,5\)/.test(clientSrc)
  && /setProperty\('--dst-preview-lines'/.test(clientSrc)
  && /dsh-thinking-panel\.preview-lines/.test(clientSrc)
  && /function SliderRow\(props\)/.test(clientSrc)
  && /const PREVIEW_MIN = 1;/.test(clientSrc)
  && /const PREVIEW_MAX = 20;/.test(clientSrc));
check('滑块自绘（官方 primitives 只导出 Switch，没有 Slider），越界输入会被夹住',
  /type: 'range'/.test(clientSrc) && /function clampPreview\(next\)/.test(clientSrc));
check('负边距只在插件自己的正文容器里补偿（不再全局）',
  /\.dst-body>\[data-turn-process-inline\]\[hidden\]\{margin-bottom:-16px\}/.test(clientSrc));
check('未知块传的是包装体里的真实载荷', /const payload = block\.block !== undefined \? block\.block : block;/.test(clientSrc));
check('错误边界失败后可复位', /componentDidUpdate\(prevProps\)/.test(clientSrc));
check('图片失败至少留一行日志', /renderMessageImages failed/.test(clientSrc));
check('本地图片走鉴权文件路由', /api\/file\?path=/.test(clientSrc) && /function localPathMediaUrl/.test(clientSrc));
check('fileMentions 补上了 tail 守卫', /useTurnData\('turn-tail'\)/.test(clientSrc));
check('不再条件调用 hook（改成条件渲染包装组件）',
  /function Expandable\(props\)/.test(clientSrc)
  && !/typeof useDisclosure === 'function' \? useDisclosure\(\)/.test(clientSrc));
check('滚动 effect 有依赖数组（不再每次渲染强制布局）', /\}, \[text, expanded, running\]\);/.test(clientSrc));
check('ResizeObserver 只在挂载时建一次',
  /new ResizeObserver\(\(\) => updateCanScrollRef\.current\(\)\)/.test(clientSrc));
check('兜底翻译器是模块级常量（否则 labels 的 memo 全被击穿）',
  /const IDENTITY_T = \(key\) => key;/.test(clientSrc) && !/\(k\) => k;/.test(clientSrc));
check('useSearchableHidden 与出厂同构（layout 设属性 + 无条件注册监听）',
  /useLayout\(\(\) => \{/.test(clientSrc) && /addEventListener\('beforematch'/.test(clientSrc));
check('无障碍朗读文本接上了', /think\.srRunning/.test(clientSrc) && /className: 'dst-sr'/.test(clientSrc));
check('markProgrammatic 有定时器兜底（窗口不可见时 rAF 会停）',
  /setTimeout\(clear, 250\)/.test(clientSrc));

/* --- 自动展开过程组 ---------------------------------------------------- */
/**
 * 造一棵假 DOM：
 *   面板 ── closest('[data-step-process-body]') ──▶ 组体
 *   组体 ── closest('[data-step-process]')      ──▶ 组根
 *   组根 ── querySelector('button[aria-controls]') ▶ 组头
 */
function makeProcessGroupDom({ hidden }) {
  const head = { clicks: 0, click() { this.clicks += 1; } };
  const root = makeFakeElement();
  root.querySelector = (sel) => (sel === 'button[aria-controls]' ? head : null);
  const body = makeFakeElement();
  if (hidden) body.setAttribute('hidden', 'until-found');
  body.closest = (sel) => (sel === '[data-step-process]' ? root : null);
  const panel = makeFakeElement();
  panel.closest = (sel) => (sel === '[data-step-process-body]' ? body : null);
  return { panel, body, root, head, clicks: () => head.clicks };
}

check('自动展开走官方 beforematch 揭示通道（不直接动 DOM）',
  /dispatchEvent\(new Event\('beforematch'\)\)/.test(clientSrc));

const settingsFlat = flatten(render(settingsReg.component()));
const switches = settingsFlat.filter((n) => n.type === 'switch');
check('设置行渲染两个开关（总开关 + 自动展开）', switches.length === 2, `got ${switches.length}`);
check('自动展开过程组默认打开', switches[1]?.props?.checked === true);
check('自动展开开关带无障碍 label',
  typeof switches[1]?.props?.label === 'string' && switches[1].props.label.length > 0);
check('自动展开开关的 onChange 是函数', typeof switches[1]?.props?.onChange === 'function');

/**
 * 正在生成、且 reasoning 是**最后一块**（= 流式尾部）的节点 —— 只有这时面板才是 running。
 * ⚠️ 这里踩过坑：直接用 baseProps()（reasoning + text 两块）时 reasoning 不是尾块，
 * 面板 running 为 false，自动展开压根不会触发，断言会**假通过**。
 */
const runningProps = () => baseProps({
  node: {
    key: 'assistant-step:1:1',
    data: { status: 'running', turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: '正在想……' }] },
    location: { kind: 'step', turn: { status: 'open' } },
  },
});

{
  // (a) 运行中 + 组体收起 → 派发 beforematch；官方通道一帧后仍没收起就退回点击组头
  const dom = makeProcessGroupDom({ hidden: true });
  fakeRoot = dom.panel;
  render(React.createElement(nodeReg.component, runningProps()));
  fakeRoot = null;
  check('自动展开：对收起的组体派发 beforematch',
    dom.body.dispatched?.includes('beforematch') === true,
    `dispatched=${JSON.stringify(dom.body.dispatched ?? [])}`);
  flushRaf();
  check('自动展开：官方通道无效时退回点击组头', dom.clicks() === 1, `clicks=${dom.clicks()}`);
}
{
  // (b) 组本来就是展开的（详细 / 完全展开模式）→ 首次不动作
  const dom = makeProcessGroupDom({ hidden: false });
  fakeRoot = dom.panel;
  render(React.createElement(nodeReg.component, runningProps()));
  fakeRoot = null;
  flushRaf();
  check('组已展开时首次不动作', (dom.body.dispatched?.length ?? 0) === 0 && dom.clicks() === 0);

  // (e) 回归：首次没成功必须重试 —— effect 依赖只有 [autoReveal, running]，
  //     running 整个生成期间恒为 true，不重试就等于「这一轮彻底放弃」。
  //     这里模拟「官方给组体打 hidden 晚了一帧」的真实时序。
  dom.body.setAttribute('hidden', 'until-found');
  flushTimers();
  check('首次失败后会重试（官方晚一帧折叠也能展开）',
    dom.body.dispatched?.includes('beforematch') === true);
}

/* --- 插件不碰外层滚动（反向断言） ---------------------------------------- */
/* 这里原本有五条断言，验证「插件把外层会话滚回底部」的几种做法。
 * 代码审查（对照出厂源码）判定这条路走不通，整段撤掉了 —— 见 docs/ROADMAP.md 的待定位条目。
 * 现在反过来钉住：插件**只滚自己的面板**，绝不写外层滚动容器的位置。 */
{
  check('插件不再写外层会话的滚动位置',
    !/function scrollToTail/.test(clientSrc)
    && !/function conversationScroller/.test(clientSrc)
    && !/function isFollowingTail/.test(clientSrc));
  check('撤掉的原因留在代码里（免得以后又有人「顺手修一下」）',
    /conversationScroller/.test(clientSrc) && /scrollToTail/.test(clientSrc)
    && /movedByReader/.test(clientSrc));
}
{
  // (c) 已结束的轮次 → 不动作（那是 DSH 自己的收起规则，四种模式一致）
  const dom = makeProcessGroupDom({ hidden: true });
  fakeRoot = dom.panel;
  render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'assistant-step:1:2',
      data: { status: 'settled', turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: '已经想完了。' }] },
      location: { kind: 'step', turn: { status: 'closed' } },
    },
  })));
  fakeRoot = null;
  flushRaf();
  check('已结束的轮次不自动展开', (dom.body.dispatched?.length ?? 0) === 0 && dom.clicks() === 0);
}
{
  // (d) 开关关掉 → 不动作，并且落盘
  switches[1]?.props?.onChange(false);
  check('关掉自动展开会写入 localStorage',
    sandbox.window.localStorage.getItem('dsh-thinking-panel.auto-reveal-process') === 'false');
  const dom = makeProcessGroupDom({ hidden: true });
  fakeRoot = dom.panel;
  render(React.createElement(nodeReg.component, runningProps()));
  fakeRoot = null;
  flushRaf();
  check('关掉自动展开后不再插手过程组', (dom.body.dispatched?.length ?? 0) === 0 && dom.clicks() === 0);
  switches[1]?.props?.onChange(true);   // 复原，别污染后续断言
  check('重新打开会写回 true',
    sandbox.window.localStorage.getItem('dsh-thinking-panel.auto-reveal-process') === 'true');
}

/* --- 被中断的轮次 / 流式尾部 / 自更新面板守卫 ------------------------------ */
{
  const tree = render(React.createElement(nodeReg.component, baseProps({
    node: {
      key: 'assistant-step:1:3',
      data: { status: 'interrupted', turn: 1, step: 3, blocks: [{ kind: 'reasoning', text: '被打断了。' }] },
      location: { kind: 'step', turn: { status: 'closed' } },
    },
  })));
  const nodes = flatten(tree);
  const head = nodes.find((n) => n.props?.className === 'dst-think-head');
  // 回归：出厂把 interrupted 当独立状态；早先只判 running，中断被当成正常结束
  check('被中断时标题是「已停止」', JSON.stringify(head?.children ?? '').includes('已停止'),
    JSON.stringify(head?.children ?? '').slice(0, 120));
  check('被中断时挂出厂的「已停止」徽标', nodes.some((n) => n.props?.className === 'dst-stopped'));
  check('被中断时面板 data-state=stopped',
    nodes.some((n) => n.props?.['data-state'] === 'stopped'));
}
check('流式尾部按「后面还有没有正文块」判定，而不是 blocks.length-1',
  /const tail = !blocks\.slice\(i \+ 1\)\.some/.test(clientSrc));
check('自更新面板有重入守卫与卸载保护',
  /const inFlight = React\.useRef\(false\)/.test(clientSrc)
  && /const alive = React\.useRef\(true\)/.test(clientSrc));

/* ================================================================== *
 * 3. 规格交叉比对（回查 DSH 出厂源码）
 * ================================================================== */
console.log('\n[3] 规格交叉比对 vs DSH 出厂源码');

function readSrc(name) {
  if (!haveSrc) return null;
  const p = path.join(srcDir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
const uiChat = readSrc('ui-chat-client.js');
const themeJs = readSrc('ui-theme-client.js');
const catalog = haveCatalog ? fs.readFileSync(catalogPath, 'utf8') : null;

/** 第 [3] 节专用：缺出厂源码时 SKIP（而不是把「没材料」报成「不符合」）。 */
const spec = (name, ok) => (haveSrc ? check(name, ok) : skip(name, '未提供出厂源码目录'));
/** 槽目录是另一份材料，单独判定。 */
const specCatalog = (name, ok) => (haveCatalog ? check(name, ok) : skip(name, '未提供槽目录 DSH_SLOT_CATALOG'));

if (!haveSrc) {
  console.log('  提示：未提供出厂源码目录 —— 本节断言记为 SKIP。');
  console.log('        启用方式： DSH_SRC_DIR=<解包源码目录> node tools/verify.mjs');
}

spec('已提取 ui-chat-client.js', !!uiChat);
spec('已提取 ui-theme-client.js', !!themeJs);

spec('出厂确有 assistant-step 定义', !!uiChat && uiChat.includes('"assistant-step"'));
spec('出厂确有 groupPart=reasoning 过滤规则', !!uiChat && /groupPart === "reasoning" && block\.kind !== "reasoning"/.test(uiChat));
spec('出厂确有 groupPart=response 过滤规则', !!uiChat && /groupPart === "response" && block\.kind === "reasoning"/.test(uiChat));
spec('出厂确实跳过 tool-call 块', !!uiChat && /case "tool-call": break;/.test(uiChat));
spec('出厂图片块走 renderMessageImages', !!uiChat && /renderMessageImages\(\{\s*images:/.test(uiChat));
spec('出厂 owner props 含 turnProcess/fileMentions/renderMessageImages', !!uiChat
  && /renderMessageImages,/.test(uiChat) && /fileMentions,/.test(uiChat) && /turnProcess/.test(uiChat));
spec('出厂 hookContext = { turnData, disclosureReset }', !!uiChat
  && /hookContext = \(0, react\.useMemo\)\(\(\) => \(\{\s*turnData,\s*disclosureReset\s*\}\),/.test(uiChat));
specCatalog('出厂 keyed 槽语义：重复 key 会替换占位者', !!catalog
  && /Registering an already-occupied key replaces that occupant/.test(catalog));
specCatalog('槽目录确认 assistant-step 已被占位', !!catalog
  && /client-ui-chat AssistantNodeView key 'assistant-step'/.test(catalog));
specCatalog('槽目录确认 replaceRisk = shadows-shipped-ui', !!catalog
  && /replaceRisk: "shadows-shipped-ui"/.test(catalog));

/* 「自动展开过程组」的依据 —— 全部回查出厂源码，不是推测 */
spec('出厂 useSearchableHidden 用 beforematch 做揭示通道', !!uiChat
  && /addEventListener\("beforematch", reveal\)/.test(uiChat));
spec('出厂过程组折叠时给组体设 hidden="until-found"', !!uiChat
  && /setAttribute\("hidden", "until-found"\)/.test(uiChat));
spec('出厂过程组按 stepGrouping 决定是否折叠', !!uiChat
  && /policy\.stepGrouping === "collapsed" \|\| policy\.stepGrouping === "history"/.test(uiChat));
spec('出厂桌面端默认「工作步骤展示」是 standard', !!uiChat
  && /"dshDesktop" in globalThis \? "standard"/.test(uiChat));
spec('出厂推理行属于过程组（processMember）', !!uiChat
  && /groupPart === "reasoning" && routedNode\.kind === "assistant-step"/.test(uiChat));

for (const tok of [
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-caption',
  '--dsw-alias-brand-primary',
  '--dsw-font-markdown-small',
]) {
  spec(`DSH 主题定义了 ${tok}`, !!themeJs && themeJs.includes(tok));
}

/* ================================================================== *
 * 4. 自更新接线（核心逻辑由 tools/test-self-update.mjs 单独覆盖）
 * ================================================================== */
console.log('\n[4] 自更新接线');

const selfUpdateSrc = fs.readFileSync(path.join(pkgDir, 'self-update.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8');

check('self-update.js 存在且导出 createSelfUpdater', /export function createSelfUpdater/.test(selfUpdateSrc));
check('Host 侧注册了自更新路由',
  /webCtx\.webServer\.register\(\{ kind: 'prefix', path: ROUTE_PREFIX, handler \}\)/.test(indexSrc));
check('路由前缀与 Client 侧一致',
  /const ROUTE_PREFIX = '\/dsh-thinking-panel\/update'/.test(indexSrc)
  && /const UPDATE_ROUTE = '\/dsh-thinking-panel\/update'/.test(clientSrc));
check('端点复用 DSH 的鉴权边界',
  /webCtx\.connection\.requestRejection\(req\)/.test(indexSrc));
check('变更类方法要求 POST', /const MUTATING = new Set\(\['check', 'install', 'rollback', 'auto-update', 'mode'\]\)/.test(indexSrc));
/* 回归：check 不需要参数，而早先客户端按「有没有传 body」决定 GET/POST，把它发成 GET，
 * 而 Host 侧 check 属于变更类、一律要求 POST —— 点「检查更新」直接 HTTP 405。 */
check('自更新客户端：只有 status 是只读方法',
  /const UPDATE_READONLY = new Set\(\['status'\]\)/.test(clientSrc)
  && /const readonly = UPDATE_READONLY\.has\(method\)/.test(clientSrc));
check('自更新客户端：变更类方法带空 JSON body 发 POST',
  /body: JSON\.stringify\(body \?\? \{\}\)/.test(clientSrc));
check('两端方法策略不相交（status 只读，其余变更）',
  !/MUTATING = new Set\(\[[^\]]*'status'/.test(indexSrc));
check('路线图文档存在（0.2.0 待办）', fs.existsSync(path.join(pkgDir, 'docs', 'ROADMAP.md')));
check('自更新：Host 侧有并发互斥（桌面端与 Web GUI 可能同时点）',
  /async function locked\(label, fn\)/.test(selfUpdateSrc)
  && /check: \(\) => locked\('check', checkImpl\)/.test(selfUpdateSrc)
  && /install: \(version\) => locked\('install'/.test(selfUpdateSrc)
  && /rollback: \(version\) => locked\('rollback'/.test(selfUpdateSrc));
/* ⚠️ 这两条用 includes 而不是正则：同一个模式写成正则时死活匹配不上 ——
 * 字符码逐一对得上、`new RegExp(source)` 重建也不匹配、而 has 判断是 true。
 * 断言真正要的是「源码长这样」，不是「正则引擎对不对」，所以用确定性比较。 */
check('自更新：体积上限是流式判定，不是读完再判',
  selfUpdateSrc.includes("if (res.body && typeof res.body.getReader === 'function')")
  && selfUpdateSrc.includes('if (total > maxBytes)'));
check('自更新：没有流式 body 时退回一次性读取，但仍判大小',
  selfUpdateSrc.includes('const buf = Buffer.from(await res.arrayBuffer());')
  && selfUpdateSrc.includes('if (buf.length > maxBytes) throw tooBig();'));
{
  /* 回归：早先 `apply()` 里有 `if (text === null) return;` 的提前返回，而端点注册写在它
   * 后面 —— mode=off 的用户会连自更新面板一起失去（/update/status 变 404）。
   * 现在两者彻底解耦：注入归 createInjection 管，端点无条件注册。 */
  const applyBody = indexSrc.slice(
    indexSrc.indexOf('export function apply'),
    indexSrc.indexOf('function pluginDataDir'),
  );
  check('语言注入不再用提前 return 短路（端点与注入解耦）',
    applyBody.length > 0 && !/if \(text === null\) return/.test(applyBody));
  check('模式切换走 createInjection 的「先注销再注册」',
    /function createInjection\(ctx\)/.test(indexSrc) && /disposeAll\(\);/.test(indexSrc));
  check('mode 持久化在插件数据目录（cordis.patch.yml 只是默认值）',
    /function createModeStore\(fallback\)/.test(indexSrc) && /settings\.json/.test(indexSrc));
  check('端点注册在 apply 内部无条件执行', /registerUpdateRoutes\(ctx, \{/.test(indexSrc));
  check('启动后会自动跑一次自动更新（不阻塞启动）',
    /AUTO_UPDATE_DELAY_MS/.test(indexSrc) && /updater\.autoUpdate\(\)/.test(indexSrc)
    && /typeof timer\.unref === 'function'/.test(indexSrc));
}
/* 回归：早先写的是 `inject(['connection','webServer'])` —— 那要求**两个服务都就绪**才回调，
 * 而 connection 是可选服务，它一旦缺席回调就永不触发 → 端点 404，
 * 用户看到的就是「自动更新暂不可用 HTTP 404」（实测：本机 19387 也是 404）。
 * 对照：@copylee/dsh-computer-use 只 inject ["webServer"]。 */
check('自更新只依赖 webServer（connection 缺席也能注册端点）',
  /ctx\.inject\(\['webServer'\]/.test(indexSrc)
  && !/ctx\.inject\(\['connection', 'webServer'\]/.test(indexSrc));
check('鉴权改成可选（拿不到 connection 就跳过 requestRejection）',
  /typeof webCtx\.connection\?\.requestRejection === 'function'/.test(indexSrc));
check('registry 有国内备选节点（npmmirror），按顺序自动尝试',
  /'https:\/\/registry\.npmmirror\.com'/.test(selfUpdateSrc)
  && /async function fetchFromAnyRegistry/.test(selfUpdateSrc)
  && /所有 registry 节点都不可用/.test(selfUpdateSrc));
check('端点失败时不再静默隐藏，而是把原因显示出来',
  /update\.endpointDown/.test(clientSrc) && /setEndpointError\(String\(error/.test(clientSrc));
check('端点回来之前显示「正在读取」占位（不闪空白）',
  /update\.connecting/.test(clientSrc) && /if \(state === null\) \{/.test(clientSrc));
check('更新改到 Host 半部时提示需要重启',
  /restartRequired/.test(selfUpdateSrc) && /update\.installedRestart/.test(clientSrc));
check('回滚过的版本不会被自动装回来（holdVersion）',
  /holdVersion/.test(selfUpdateSrc) && /state\.holdVersion === latest/.test(selfUpdateSrc));
check('下载有超时与体积上限', /timeoutMs/.test(selfUpdateSrc) && /maxBytes/.test(selfUpdateSrc));
check('package.json 的 files 收录了 self-update.js',
  JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).files.includes('self-update.js'));

/* ================================================================== */
console.log(`\n==================== ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} ====================`);
if (skipped) {
  console.log(`跳过 ${skipped} 项（缺少出厂源码材料，不是失败）：`);
  for (const s of skips) console.log(`  - ${s}`);
}
if (fail) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
