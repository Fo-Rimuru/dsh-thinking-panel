/**
 * 深度思考面板 · Client 半部（节点遮蔽版）
 *
 * 形态：官方 Client 模块（window.__ModuleLoader__.load + lazy factory）。
 *
 * 本半部做两件事：
 *  1. 遮蔽 conversation.chat.node 的 assistant-step 渲染器，自己完整渲染
 *     assistant 消息，并把 reasoning 块换成 DeepSeek 官方样式的思考面板：
 *       · 思考中：N 行可滚动预览（对齐官方 5×lineHeight + 10dp 的高度上限）
 *       · 思考结束：折叠为摘要行，可展开看完整推理
 *       · 左侧引导竖线、品牌色图标、「深度思考」标题、思考耗时
 *  2. shell.overlay 注入自身样式；settings.general.item 提供两行开关
 *     （插件总开关 + 「自动展开过程组」，后者**默认打开**）。
 *  3. 自动展开过程组：出厂把 reasoning 分组的 assistant-step 归进「过程组」，
 *     而「简洁 / 标准」下过程组默认收起（桌面端默认正是「标准」）—— 不自动展开的话，
 *     装完插件只会看到一行过程组头。见 revealProcessGroup()。
 *
 * 规格来源（均为出厂源码原文，非推测）：
 *  · owner props：ChatNodeSeat 构造的 { groupPart?, cwd, openFile, openSkill,
 *    inspectCall, forkAt, loadImage, renderMessageImages, fileMentions, turnProcess }
 *    再叠加 { node }（routedOwner = { ...owner, node: routedNode }）。
 *  · hookContext：ChatNodeSeat 内 useMemo(() => ({ turnData, disclosureReset }))。
 *  · slotInject：含 renderSlot / useDisclosure / useTurnData / usePresentation / t
 *    （证据：出厂 CommandNodeView({ node, renderSlot, t })、
 *      AssistantNodeView({ …, useDisclosure, useTurnData, usePresentation, t })）。
 *  · 节点数据：node.data = { status, turn, step, blocks, time, usage?, finalNode? }，
 *    blocks = { kind: 'text' | 'reasoning' | 'image' | 'tool-call' | 'other', … }。
 *  · 渲染规则（AssistantMarkdown）：groupPart==='reasoning' 只留 reasoning 块；
 *    groupPart==='response' 跳过 reasoning；tool-call 不在本节点渲染（独立节点）；
 *    text → MarkdownText，image → renderMessageImages（连续图片合并成组）。
 *  · 折叠预览的行数上限：对齐官方观感（5 行，另加一点底部余量），见 PREVIEW_LINES。
 */

window.__ModuleLoader__.load({
  id: 'dsh-thinking-panel',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /* ui-primitives 通过 dsh.client.external 声明；取不到时全程降级为纯文本渲染。 */
    let primitives = null;
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { primitives = null; }
    const MarkdownText = primitives && primitives.MarkdownText ? primitives.MarkdownText : null;
    const JsonBlock = primitives && primitives.JsonBlock ? primitives.JsonBlock : null;
    const IconThink = primitives && primitives.IconThinkOutlineRegular ? primitives.IconThinkOutlineRegular : null;
    /* 官方开关组件：与「设置 → 通用」里官方条目的开关完全同款（样式由 primitives 自带）。 */
    const Switch = primitives && primitives.Switch ? primitives.Switch : null;

    const NS = 'thinking-panel';
    const STORAGE_KEY = 'dsh-thinking-panel.enabled';

    /**
     * 兼容性提示：DSH 升级后接口可能变化。
     *
     * 原则是**尽量不阻断**——能跑就先跑、能降级就降级，但一定要把问题明确打到
     * 控制台，否则用户只会看到「样式没变」却毫无头绪。提示里带上版本与反馈入口。
     */
    function compatReport(problem, detail) {
      try {
        const lines = [
          `[dsh-thinking-panel] 兼容性提示：${problem}`,
          detail ? `  ${detail}` : null,
          '  插件会尽量继续以降级方式运行。若外观退回出厂样式，多半是 DSH 升级后接口变了。',
          '  反馈：https://github.com/Fo-Rimuru/dsh-thinking-panel/issues',
        ].filter(Boolean);
        console.warn(lines.join('\n'));
      } catch { /* ignore */ }
    }

    /** 思考中预览的行数上限 —— 对齐官方 5×lineHeight + 10dp。 */
    const PREVIEW_LINES = 5;
    /**
     * 展开态正文的最大高度：超过则**在面板内滚动**（自带可拖动滚动条）。
     * 官方展开态其实没有高度限制，这里加上是为了可用性（用户实测反馈：
     * 展开后没有滚动条、只能靠整页滚动，不方便）。想恢复官方行为就设为 'none'。
     */
    const BODY_MAX = 'min(60vh, 640px)';
    /**
     * 流式时预览窗口跟随哪一端：
     *   'tail' —— 跟随最新内容（「流动」观感，默认）
     *   'top'  —— 钉在开头（官方 StreamingSmoothScrollEffect 的字面行为）
     */
    const FOLLOW = 'tail';

    const zh = {
      'settings.title': '深度思考面板',
      'settings.desc': '让思考内容跟随用户输入语言；思考中多行滚动预览、展开看完整推理、左侧竖线、「已思考（用时 X 秒）」标题。',
      'settings.on': '已启用',
      'settings.off': '已停用',
      'settings.toggle': '启用官方思考链渲染',
      'settings.autoReveal.title': '自动展开过程组',
      'settings.autoReveal.desc': '默认打开。DSH 桌面端默认的「标准」会把正在生成的过程折叠进「过程组」；打开后本插件在生成时自动帮你展开它。已结束的轮次仍按 DSH 的规则收起。',
      'settings.autoReveal.toggle': '自动展开过程组',
      'settings.autoReveal.on': '已打开',
      'settings.autoReveal.off': '已关闭',
      'think.running': '深度思考中',
      'think.done': '已思考',
      'think.stopped': '已停止',
      'think.seconds': '（用时 {s} 秒）',
      'think.expand': '展开思考过程',
      'think.collapse': '收起思考过程',
      'plain.reasoning': '思考',
      /* Markdown 装饰文案：出厂 markdownLabels(t) 需要 code.{copyLabel,copiedLabel,
       * toolbarLabels:{codeLabel,wrapLabel,unwrapLabel}} 与 footnotes 的完整形状，
       * 缺任一项都会在渲染含代码块的消息时抛错。 */
      'md.copy': '复制',
      'md.copied': '已复制',
      'md.codeBlock.title': '代码',
      'md.codeBlock.wrap': '自动换行',
      'md.codeBlock.unwrap': '取消换行',
      'md.footnotes': '脚注',
      /* 自更新面板 */
      'update.check': '检查更新',
      'update.install': '更新',
      'update.rollback': '回滚',
      'update.working': '处理中…',
      'update.available': '有新版本 v{v}',
      'update.upToDate': '已是最新版本',
      'update.installed': '已更新到 v{v}',
      'update.installedRestart': '已更新到 v{v}，重启 DSH 后生效',
      'update.failed': '更新失败，详见控制台',
    };
    const en = {
      'settings.title': 'Thinking Panel',
      'settings.desc': 'Reasoning follows your language; multi-line live preview, expandable full reasoning, left rail, and a duration title.',
      'settings.on': 'Enabled',
      'settings.off': 'Disabled',
      'settings.toggle': 'Enable the official thinking-chain renderer',
      'settings.autoReveal.title': 'Auto-expand the process group',
      'settings.autoReveal.desc': 'On by default. DSH on desktop defaults to "Standard", which folds the running process into a "process group"; when on, this plugin expands it for you while a turn is running. Settled turns still collapse, as DSH intends.',
      'settings.autoReveal.toggle': 'Auto-expand the process group',
      'settings.autoReveal.on': 'On',
      'settings.autoReveal.off': 'Off',
      'think.running': 'Thinking',
      'think.done': 'Thought',
      'think.stopped': 'Stopped',
      'think.seconds': ' for {s}s',
      'think.expand': 'Expand reasoning',
      'think.collapse': 'Collapse reasoning',
      'plain.reasoning': 'Think',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.codeBlock.title': 'Code',
      'md.codeBlock.wrap': 'Wrap',
      'md.codeBlock.unwrap': 'No wrap',
      'md.footnotes': 'Footnotes',
      /* self-update panel */
      'update.check': 'Check for updates',
      'update.install': 'Update',
      'update.rollback': 'Roll back',
      'update.working': 'Working…',
      'update.available': 'v{v} available',
      'update.upToDate': 'Up to date',
      'update.installed': 'Updated to v{v}',
      'update.installedRestart': 'Updated to v{v} — restart DSH to apply',
      'update.failed': 'Update failed; see the console',
    };

    /* ================================================================== *
     * 样式：全部使用 DSH 主题令牌，类名自带 dst- 前缀，不触碰出厂类名
     * ================================================================== */
    const CSS = `
.dst-think{display:flex;flex-direction:column;position:relative;padding:5px 0 5px 22px;margin:0}
.dst-think::before{content:"";position:absolute;left:7.5px;top:31px;bottom:6px;
  border-left:1px solid var(--dsw-alias-label-dimmed);pointer-events:none}
.dst-think[data-collapsed]{padding-bottom:0}
.dst-think[data-collapsed]::before{display:none}
.dst-think-head{display:flex;align-items:center;min-height:calc(24px + var(--dsh-content-font-delta,0px));
  color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none;transition:color .2s}
.dst-think-head:hover{color:var(--dsw-alias-label-primary)}
.dst-think-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;margin-right:6px;color:var(--dsw-alias-brand-primary)}
.dst-think-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);font-weight:400}
.dst-think-time{flex:none;margin-left:6px;color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsh-content-font-size-secondary,13px)}
.dst-think-chevron{margin-left:8px;flex:none;color:var(--dsw-alias-label-caption);
  transition:transform .2s;transform:rotate(0deg)}
.dst-think-head[data-open] .dst-think-chevron{transform:rotate(90deg)}
.dst-think-preview{margin-top:2px;max-height:calc(${20 * PREVIEW_LINES + 10}px + var(--dsh-content-font-delta-secondary,0px) * ${PREVIEW_LINES});
  overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;
  color:var(--dsw-alias-label-secondary);
  font:var(--dsw-font-markdown-small);
  -webkit-mask-image:linear-gradient(180deg,#000 calc(100% - 18px),transparent 100%);
  mask-image:linear-gradient(180deg,#000 calc(100% - 18px),transparent 100%)}
.dst-think-preview[data-noscroll]{-webkit-mask-image:none;mask-image:none}
.dst-think-preview p,.dst-think-preview ul,.dst-think-preview ol,.dst-think-preview blockquote{margin:4px 0}
/* 展开态：同样给一个自带滚动条的高度受限容器，否则长推理只能靠整页滚动、
   面板里没有可拖动的滚动条（用户实测反馈）。上限取 BODY_MAX，可调。 */
.dst-think-body{margin-top:4px;color:var(--dsw-alias-label-secondary);
  max-height:${BODY_MAX};overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
.dst-think-body p,.dst-think-body ul,.dst-think-body ol,.dst-think-body blockquote{margin:6px 0}
/* 显式绘制滚动条，保证 Chromium 下始终可见、可拖动 */
.dst-think-preview::-webkit-scrollbar,
.dst-think-body::-webkit-scrollbar{width:8px;height:8px}
.dst-think-preview::-webkit-scrollbar-track,
.dst-think-body::-webkit-scrollbar-track{background:transparent}
.dst-think-preview::-webkit-scrollbar-thumb,
.dst-think-body::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-label-caption,var(--dsw-alias-border-l2));
  border-radius:4px;border:2px solid transparent;background-clip:padding-box}
.dst-think-preview::-webkit-scrollbar-thumb:hover,
.dst-think-body::-webkit-scrollbar-thumb:hover{
  background:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2));
  background-clip:padding-box}
/* 与出厂 AssistantMarkdown.module.css 的 .stopped 同款：被中断的轮次挂一个小徽标 */
.dst-stopped{border-radius:var(--dsw-radius-s,4px);background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-tertiary);align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}
.dst-plain{color:var(--dsw-alias-label-primary)}
.dst-plain-reasoning{margin:4px 0;color:var(--dsw-alias-label-secondary);
  font:var(--dsw-font-markdown-small);white-space:pre-wrap;max-height:6.5em;overflow:hidden}
/* 与出厂 AssistantMarkdown.module.css 同构：折叠的推理块收掉多余间距 */
[data-turn-process-inline][hidden]{margin-bottom:-16px}
`;

    /* ================================================================== *
     * 开关状态
     *
     * ⚠️ 只有存过 'true' / 'false' 时才覆盖默认值 —— 这样**新增开关的默认值
     * 可以随版本调整**，而没碰过这个开关的老用户会跟着新默认走。
     * ================================================================== */
    function createToggle(key, fallback) {
      const subs = new Set();
      let value = fallback;
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === 'true') value = true;
        else if (raw === 'false') value = false;
      } catch { /* ignore */ }
      return {
        get: () => value,
        set: (next) => {
          value = next === true;
          try { window.localStorage.setItem(key, value ? 'true' : 'false'); } catch { /* ignore */ }
          for (const fn of subs) fn();
        },
        /** 订阅式读取：开关变化时重渲染读取方。 */
        use: () => {
          const [, force] = React.useReducer((n) => n + 1, 0);
          React.useEffect(() => {
            const listener = () => force();
            subs.add(listener);
            return () => { subs.delete(listener); };
          }, []);
          return value;
        },
      };
    }

    /** 插件总开关：关掉后完全不介入出厂渲染。 */
    const enabledToggle = createToggle(STORAGE_KEY, true);
    const useEnabled = enabledToggle.use;
    const setEnabled = enabledToggle.set;
    /**
     * 自动展开过程组 —— **默认打开**。
     *
     * 出厂把 reasoning 分组的 assistant-step 归进「过程组」（ChatNodeSeat.processMember），
     * 而过程组在「简洁 / 标准」下恒可折叠、且默认收起（ChatGroupSeat.grouped +
     * useSearchableHidden → hidden="until-found"）；桌面端「工作步骤展示」默认正是**标准**。
     * 不自动展开的话，装完插件只会看到一行过程组头 —— 「思考链没生效」，实测反馈如此。
     */
    const AUTO_REVEAL_KEY = 'dsh-thinking-panel.auto-reveal-process';
    const autoRevealToggle = createToggle(AUTO_REVEAL_KEY, true);
    const useAutoReveal = autoRevealToggle.use;
    const setAutoReveal = autoRevealToggle.set;

    /**
     * 展开包住本面板的「过程组」，让被 hidden="until-found" 挡住的思考面板露出来。
     *
     * 优先走官方自己的揭示通道：出厂的 useSearchableHidden 在组体上注册了
     * `beforematch` → reveal() → setOpen(true)，所以派发一个 beforematch 就等于
     * 「让浏览器替用户展开」—— 不抢焦点、不动 DOM、不绕过 React 状态机。
     * 万一那条通道在某个版本失效（下一帧仍是 hidden），退回点击组头，并把焦点还回去：
     * 出厂组头的 onClick 里有 `currentTarget.focus()`，不还原会把用户正在打字的输入框顶掉。
     *
     * @returns 是否已派出揭示事件（false = 当前不需要展开，或环境不支持）。
     */
    function revealProcessGroup(el) {
      if (el === null || el === undefined || typeof el.closest !== 'function') return false;
      let body = null;
      try {
        body = el.closest('[data-step-process-body]');
        if (body === null || typeof body.hasAttribute !== 'function') return false;
        if (!body.hasAttribute('hidden')) return false;               // 组本来就是展开的
      } catch { return false; }
      const root = typeof body.closest === 'function' ? body.closest('[data-step-process]') : null;

      let dispatched = false;
      try {
        if (typeof Event === 'function') {
          body.dispatchEvent(new Event('beforematch'));
          dispatched = true;
        }
      } catch { dispatched = false; }

      const fallback = () => {
        try {
          if (!body.hasAttribute('hidden')) return;                   // 官方通道已经生效
          const head = root === null ? null : root.querySelector('button[aria-controls]');
          if (head === null || typeof head.click !== 'function') return;
          const prev = typeof document !== 'undefined' && document !== null ? document.activeElement : null;
          head.click();
          if (prev && prev !== head && typeof prev.focus === 'function') {
            try { prev.focus({ preventScroll: true }); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      };
      try {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fallback);
        else fallback();
      } catch { /* ignore */ }

      return dispatched;
    }

    /* ================================================================== *
     * 思考耗时：直接用出厂自己记的时间戳
     *
     * ⚠️ 这里换过一次实现。早先是模块级 Map 按 node key 自己记账（挂载开表、结算收表），
     * 但 node key 只在**会话内**唯一（出厂就是 `"${turn}:${step}"`），于是两个会话的
     * `1:1` 会共用一条记录：后一个会话要么显示前一个会话的耗时，要么因为记录已结算
     * 而整轮都不重新计时。那套还有两个毛病 —— 在 render 期间写外部状态、以及需要 LRU 淘汰。
     *
     * 现在读出厂结算数据：`node.data.finalNode.timing = { stepStartTime, firstTokenTime,
     * completedTime }`（毫秒），耗时 = completedTime - stepStartTime。
     * 不需要任何跨渲染状态。思考中也不吃亏：那时标题本来就不显示秒数。
     * ================================================================== */
    function durationOf(node) {
      const data = (node && node.data) || {};
      const timing = (data.finalNode && data.finalNode.timing) || data.timing || null;
      if (!timing) return null;
      const { stepStartTime, completedTime } = timing;
      if (typeof stepStartTime !== 'number' || typeof completedTime !== 'number') return null;
      const ms = completedTime - stepStartTime;
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return Math.max(1, Math.round(ms / 1000));
    }

    /* ================================================================== *
     * 错误边界：任何渲染异常都降级为纯文本，绝不留下空白行
     * （槽条目的失败模式是整行空白，所以这一层是安全安装的前提）
     * ================================================================== */
    class ThinkingBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try { console.error('[dsh-thinking-panel] render failed, falling back to plain text', error); }
        catch { /* ignore */ }
      }

      render() {
        if (this.state.failed) return plainFallback(this.props.blocks);
        return this.props.children;
      }
    }

    /** 兜底渲染：只输出纯文本，不依赖任何 Harness 客户端包。 */
    function plainFallback(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b === undefined || b === null) continue;
        if (b.kind === 'reasoning') {
          out.push(h('div', { className: 'dst-plain-reasoning', key: i }, b.text));
        } else if (b.kind === 'text') {
          out.push(h('div', { className: 'dst-plain', key: i }, b.text));
        }
      }
      return out.length === 0 ? null : h(React.Fragment, null, out);
    }

    /* ================================================================== *
     * Markdown 装饰文案：与出厂 markdownLabels(t) 同构
     * （出厂源码 lib/types/client/markdown-labels.js；形状不完整会在渲染
     *   含代码块的消息时抛 "Cannot read properties of undefined"）
     * ================================================================== */
    function markdownLabels(tr) {
      return {
        code: {
          copyLabel: tr('md.copy'),
          copiedLabel: tr('md.copied'),
          toolbarLabels: {
            codeLabel: tr('md.codeBlock.title'),
            wrapLabel: tr('md.codeBlock.wrap'),
            unwrapLabel: tr('md.codeBlock.unwrap'),
          },
        },
        footnotes: tr('md.footnotes'),
      };
    }

    /* ================================================================== *
     * 可搜索隐藏：复刻出厂 useSearchableHidden / ProcessReasoning
     * （出厂源码 lib/types/client/chat/searchable-hidden.js：
     *   hidden 时设 hidden="until-found" 而非卸载子树，使浏览器「页内查找」
     *   仍能找到隐藏的推理内容，并通过 beforematch 揭示；宿主 CSS 依赖
     *   [data-turn-process-inline][hidden] 调整间距。）
     * ================================================================== */
    function useSearchableHidden(hidden, reveal) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        const doc = element.ownerDocument;
        if (hidden && doc && element.contains(doc.activeElement)) { reveal(); return undefined; }
        if (hidden) {
          element.setAttribute('hidden', 'until-found');
          const onBeforeMatch = () => reveal();
          element.addEventListener('beforematch', onBeforeMatch);
          return () => {
            element.removeEventListener('beforematch', onBeforeMatch);
            element.removeAttribute('hidden');
          };
        }
        element.removeAttribute('hidden');
        return undefined;
      }, [hidden, reveal]);
      return ref;
    }

    function ProcessReasoning(props) {
      const { hidden, reveal, children } = props;
      const ref = useSearchableHidden(hidden, reveal || NOOP);
      return h('div', {
        ref,
        className: 'dst-think-wrap',
        'data-turn-process-inline': hidden || undefined,
      }, children);
    }
    const NOOP = () => {};

    /* ================================================================== *
     * 思考面板
     * ================================================================== */
    function ThinkingPanel(props) {
      const { text, running, stopped, useDisclosure, t } = props;
      const tr = typeof t === 'function' ? t : (k) => k;
      /* 展开状态优先用注入的 useDisclosure（与出厂一致，跟随 Turn 重置）；
       * 未注入时退回自带 useState，保证仍可展开。 */
      const [ownExpanded, setOwnExpanded] = React.useState(false);
      const disclosure = typeof useDisclosure === 'function' ? useDisclosure() : null;
      const expanded = disclosure !== null ? disclosure.expanded === true : ownExpanded;
      const toggle = disclosure !== null
        ? (typeof disclosure.toggle === 'function' ? disclosure.toggle : () => {})
        : () => setOwnExpanded((v) => !v);

      const scrollRef = React.useRef(null);
      const rootRef = React.useRef(null);
      /**
       * 自动展开过程组（默认打开，可在「设置 → 通用」里关掉）。
       *
       * 只作用于**正在生成**的这一轮：已结束的轮次按 DSH 自己的规则收起（四种模式一致），
       * 不该借这个开关改写它。用户手动收起过之后也不再插手（revealed 标记）。
       */
      const autoReveal = useAutoReveal();
      const revealed = React.useRef(false);
      React.useEffect(() => {
        if (!autoReveal || !running || revealed.current) return undefined;
        const el = rootRef.current;
        // 非真实 DOM（自检的 mock 环境、降级路径）：没有可探测的祖先，直接放弃。
        if (el === null || typeof el.closest !== 'function') return undefined;
        if (revealProcessGroup(el)) { revealed.current = true; return undefined; }

        /**
         * ⚠️ 首次没成功必须重试。这个 effect 的依赖只有 [autoReveal, running]，而 running
         * 在整个生成期间恒为 true —— 不重试就等于「这一轮彻底放弃」。真实会撞上的时序：
         * 面板挂载那一刻，官方给组体打 hidden 的 layout effect 还没落到 DOM 上。
         * 上限 8 次 × 250ms = 2 秒，够覆盖首帧时序，也不会一直骚扰 DOM。
         */
        // 非浏览器环境（自检沙箱等）没有 setTimeout：直接放弃，别抛。
        if (typeof setTimeout !== 'function') return undefined;
        let tries = 0;
        let timer = 0;
        const retry = () => {
          timer = 0;
          if (revealed.current) return;
          if (revealProcessGroup(rootRef.current)) { revealed.current = true; return; }
          if (++tries >= 8) return;
          timer = setTimeout(retry, 250);
        };
        timer = setTimeout(retry, 250);
        return () => { if (timer) clearTimeout(timer); };
      }, [autoReveal, running]);
      const [canScroll, setCanScroll] = React.useState(false);
      /**
       * 是否粘住滚动端（默认跟随最新内容）。
       * 用户往上拖 → 暂停跟随；拖回底部 → 自动恢复。
       */
      const stick = React.useRef(true);
      /**
       * 程序化滚动期间必须忽略 scroll 事件。
       * ⚠️ 这是踩过的坑：设置 scrollTop 也会派发 scroll 事件，
       * 若不区分，第一次自动滚到底就会被误判成「用户手动拖动」，
       * 从而永久关闭跟随——表现就是「输出第一段之后就停住不动」。
       */
      const programmatic = React.useRef(false);
      const markProgrammatic = () => {
        programmatic.current = true;
        const clear = () => { programmatic.current = false; };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(clear);
        else clear();
      };

      // 跟随最新内容（FOLLOW='tail'）或钉在开头（FOLLOW='top'）。
      // ⚠️ 展开态**也要跟随**：早先这里写成 `if (el === null || expanded) return`，
      // 导致流式推理展开后停在中途、用户得手动往下拖（实测反馈）。展开与折叠
      // 共用同一个 scrollRef，所以只要不提前返回，两端都会自动贴到最新内容。
      React.useEffect(() => {
        const el = scrollRef.current;
        if (el === null) return;
        if (FOLLOW === 'top') {
          if (!running && !stick.current) return;
          markProgrammatic();
          el.scrollTop = 0;
          return;
        }
        if (!stick.current) return;
        markProgrammatic();
        el.scrollTop = el.scrollHeight;
      });

      const handleScroll = React.useCallback(() => {
        if (programmatic.current) return;           // 自己触发的滚动，不算用户操作
        const el = scrollRef.current;
        if (el === null) return;
        // 距底部 24px 内视为「跟随中」，否则暂停跟随
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }, []);

      // 是否可滚动 → 决定底部淡出遮罩
      React.useEffect(() => {
        const el = scrollRef.current;
        if (el === null || expanded) { setCanScroll(false); return undefined; }
        const update = () => setCanScroll(el.scrollHeight > el.clientHeight + 1);
        update();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
      }, [text, expanded, running]);

      const seconds = props.seconds;
      const title = running
        ? tr('think.running')
        : stopped
          ? tr('think.stopped')
          : (seconds !== null && seconds !== undefined
            ? tr('think.done') + tr('think.seconds', { s: seconds })
            : tr('think.done'));

      const head = h('div', {
        className: 'dst-think-head',
        'data-open': expanded || undefined,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': expanded,
        title: expanded ? tr('think.collapse') : tr('think.expand'),
        onClick: toggle,
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        },
      }, [
        h('span', { className: 'dst-think-icon', key: 'icon', 'aria-hidden': true },
          IconThink ? h(IconThink, { size: 14 }) : h('span', null, '✦')),
        h('span', { className: 'dst-think-title', key: 'title' }, title),
        h('span', { className: 'dst-think-chevron', key: 'chev', 'aria-hidden': true }, '›'),
      ]);

      const inner = MarkdownText
        ? h(MarkdownText, { text, streaming: running, variant: 'compact', labels: props.labels })
        : h('div', { className: 'dst-plain-reasoning' }, text);

      const body = expanded
        ? h('div', {
          className: 'dst-think-body',
          key: 'body',
          ref: scrollRef,          // ★ 与折叠态共用同一个 ref，展开时同样跟随最新内容
          onScroll: handleScroll,
        }, inner)
        : h('div', {
          className: 'dst-think-preview',
          key: 'preview',
          ref: scrollRef,
          'data-noscroll': canScroll ? undefined : true,
          onScroll: handleScroll,
        }, inner);

      return h('div', {
        ref: rootRef,
        className: 'dst-think',
        'data-collapsed': expanded ? undefined : true,
        'data-variant': 'think',
        'data-state': running ? 'running' : (stopped ? 'stopped' : 'ok'),
      }, [head, body]);
    }

    /* ================================================================== *
     * assistant-step 渲染器（遮蔽出厂 AssistantNodeView）
     * ================================================================== */
    function DeepSeekAssistantStep(props) {
      const { node, groupPart, renderMessageImages, fileMentions, turnProcess, useDisclosure } = props;
      /* 自带翻译器优先：注入的 t 属于 chat 命名空间，未必提供给我们这个条目。 */
      const tr = typeof props.pluginT === 'function'
        ? props.pluginT
        : (typeof props.t === 'function' ? props.t : (k) => k);
      const on = useEnabled();

      const data = (node && node.data) || {};
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      const running = data.status === 'running';
      /**
       * 被中断的轮次。出厂把它当独立状态（`data.status === 'interrupted'`），并在正文后面
       * 挂一个「已停止」小徽标；插件早先只判 running，于是中断被当成正常结束、
       * 显示「已思考（用时 N 秒）」—— 语义错了，`think.stopped` 也成了死代码。
       */
      const interrupted = data.status === 'interrupted';

      // 耗时：直接读出厂结算数据，不再自己记账（见 durationOf 的说明）
      const seconds = durationOf(node);

      // 推理行的隐藏/揭示（turnProcess 折叠）
      const reasoningHidden = turnProcess !== undefined && turnProcess.foldable
        && turnProcess.spec && turnProcess.spec.answerStep === data.step
        && turnProcess.spec.inlineReasoning && !turnProcess.open;
      const reveal = React.useCallback(() => { if (turnProcess) turnProcess.setOpen(true); }, [turnProcess]);

      // 文件提及（与出厂同构：仅在 turn 关闭且有 finalNode 时可用）
      const mentions = React.useMemo(() => {
        try {
          if (!fileMentions || !node || !node.location) return undefined;
          const loc = node.location;
          const turn = loc.kind === 'turn' || loc.kind === 'step' ? loc.turn : undefined;
          if (!turn || turn.status !== 'closed' || data.finalNode === undefined) return undefined;
          return fileMentions({ turn, seq: data.finalNode.seq, openFile: props.openFile });
        } catch { return undefined; }
      }, [fileMentions, node, data.finalNode, props.openFile]);

      const labels = React.useMemo(() => markdownLabels(tr), [tr]);
      const pathImages = React.useMemo(() => ({
        resolve: (value) => {
          try {
            return new URL(decodeURIComponent(String(value).split(/[?#]/u)[0]), document.baseURI).href;
          } catch { return undefined; }
        },
      }), []);

      const out = [];
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block === undefined || block === null) continue;
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue;
        if (groupPart === 'response' && block.kind === 'reasoning') continue;

        if (block.kind === 'text') {
          out.push(MarkdownText
            ? h(MarkdownText, {
              key: i, text: block.text, streaming: running, labels,
              fileMentions: mentions, pathImages,
            })
            : h('div', { key: i, className: 'dst-plain' }, block.text));
          continue;
        }

        if (block.kind === 'reasoning') {
          /**
           * 是否流式尾部。⚠️ 不能用 `i === blocks.length - 1`：末块是图片时，真正的
           * reasoning 块 i < last，会被误判成「已经想完了」—— 流式期间标题就显示成
           * 「已思考」而不是「深度思考中」。正确判据是「它后面再没有正文块」。
           */
          const tail = !blocks.slice(i + 1).some((b) => b && (b.kind === 'text' || b.kind === 'reasoning'));
          const panel = on
            ? h(ThinkingPanel, {
              text: block.text,
              running: running && tail,
              stopped: interrupted,
              seconds,
              useDisclosure,
              t: tr,
              labels,
            })
            : h('div', { className: 'dst-plain-reasoning' }, block.text);
          // 与出厂同构：折叠态用 hidden="until-found" 保留可查找性，点击/页内查找揭示
          out.push(h(ProcessReasoning, { key: i, hidden: reasoningHidden, reveal }, panel));
          continue;
        }

        if (block.kind === 'image') {
          const start = i;
          const group = [block];
          while (i + 1 < blocks.length) {
            const next = blocks[i + 1];
            if (next === undefined || next === null || next.kind !== 'image') break;
            group.push(next);
            i += 1;
          }
          try {
            out.push(h(React.Fragment, { key: start },
              renderMessageImages({
                images: group.map((b) => ({ attachment: b.attachment })),
                align: 'start',
              })));
          } catch { /* 图片渲染失败不影响文本 */ }
          continue;
        }

        if (block.kind === 'tool-call') continue; // 工具调用是独立节点

        out.push(JsonBlock
          ? h(JsonBlock, { key: i, label: 'Unknown block', payload: block })
          : h('div', { key: i, className: 'dst-plain' }, JSON.stringify(block)));
      }

      if (out.length === 0) return null;
      /* 与出厂同构：只有「非 reasoning 分组」的那一份才挂「已停止」徽标，
       * 否则同一个节点会在过程组内外各显示一次。 */
      const stoppedBadge = interrupted && (groupPart === undefined || groupPart === 'response')
        ? h('span', { key: 'stopped', className: 'dst-stopped' }, tr('think.stopped'))
        : null;
      return h(ThinkingBoundary, { blocks },
        h(React.Fragment, null, stoppedBadge === null ? out : out.concat([stoppedBadge])));
    }

    /* ================================================================== *
     * 样式座位与设置行
     * ================================================================== */
    function StyleSeat() {
      return h('style', { 'data-plugin': 'dsh-thinking-panel' }, CSS);
    }

    /**
     * 通用开关行：标题 + 说明 + 官方 Switch（拿不到 primitives 时退回自绘滑块）。
     * 设置里有两行，抽出来也顺便保证两行与同页官方条目同款。
     */
    function ToggleRow(props) {
      const { title, desc, checked, label, onLabel, offLabel, onChange } = props;
      const fallbackToggle = h('button', {
        key: 'toggle',
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: checked ? offLabel : onLabel,
        onClick: () => onChange(!checked),
        style: {
          flex: 'none', cursor: 'pointer', borderRadius: '4096px',
          width: '38px', height: '22px', padding: '2px', boxSizing: 'border-box',
          display: 'flex', alignItems: 'center',
          justifyContent: checked ? 'flex-end' : 'flex-start',
          background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)',
          transition: 'background .2s',
        },
      }, h('span', {
        style: {
          width: '16px', height: '16px', borderRadius: '50%', display: 'block',
          background: checked ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-tertiary)',
        },
      }));
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', minWidth: 0 },
      }, [
        h('div', { key: 'text', style: { flex: '1 1 auto', minWidth: 0 } }, [
          h('div', {
            key: 'title',
            style: { fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
          }, title),
          h('div', {
            key: 'desc',
            style: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
          }, desc),
        ]),
        Switch
          ? h(Switch, {
            key: 'toggle',
            checked,
            label,
            title: checked ? offLabel : onLabel,
            onChange,
          })
          : fallbackToggle,
      ]);
    }

    function SettingsRow(props) {
      const t = props.t;
      const on = useEnabled();
      const auto = useAutoReveal();
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, [
        h(ToggleRow, {
          key: 'main',
          title: t('settings.title'),
          desc: t('settings.desc'),
          checked: on,
          label: t('settings.toggle'),
          onLabel: t('settings.on'),
          offLabel: t('settings.off'),
          onChange: (next) => setEnabled(next),
        }),
        h(ToggleRow, {
          key: 'auto-reveal',
          title: t('settings.autoReveal.title'),
          desc: t('settings.autoReveal.desc'),
          checked: auto,
          label: t('settings.autoReveal.toggle'),
          onLabel: t('settings.autoReveal.on'),
          offLabel: t('settings.autoReveal.off'),
          onChange: (next) => setAutoReveal(next),
        }),
        h(UpdateRow, { key: 'update', t }),
      ]);
    }

    /* ================================================================== *
     * 自更新面板
     *
     * 更新本身跑在 Host 半部（要写文件系统），这里只读它的 HTTP 端点。
     * 端点不可用时整块**静默隐藏** —— 自更新不该成为插件能否使用的前提。
     * ================================================================== */
    const UPDATE_ROUTE = '/dsh-thinking-panel/update';
    /**
     * 只有它是只读的：Host 侧对 `check / install / rollback / auto-update` 一律要求 POST
     * （变更类方法），只有 `status` 走 GET。
     * ⚠️ 这里踩过坑：早先客户端按「有没有传 body」决定 GET/POST，于是 `check`
     * （变更类、但不需要参数）被发成 GET，点「检查更新」直接 HTTP 405。
     */
    const UPDATE_READONLY = new Set(['status']);

    function UpdateRow(props) {
      const t = props.t;
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState(null);

      const call = React.useCallback(async (method, body) => {
        const readonly = UPDATE_READONLY.has(method) && body === undefined;
        const res = await fetch(`${UPDATE_ROUTE}/${method}`, readonly
          ? { method: 'GET' }
          : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      }, []);

      React.useEffect(() => {
        let alive = true;
        call('status')
          .then((s) => { if (alive && s && s.ok) setState(s); })
          .catch(() => { /* 端点不可用：保持 null，整块不渲染 */ });
        return () => { alive = false; };
      }, [call]);

      if (state === null) return null;

      /**
       * 卸载保护 + 重入守卫。两个都踩过：
       *  ① `await` 之后 setState 落在已卸载组件上；
       *  ② `disabled` 要等重渲染才生效，快速双击能并发两次 install ——
       *     而 install 是会**写文件系统**的操作（Host 侧另有一道互斥兜底）。
       */
      const alive = React.useRef(true);
      React.useEffect(() => () => { alive.current = false; }, []);
      const inFlight = React.useRef(false);

      const run = async (method, body) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(method);
        setNote(null);
        try {
          const result = await call(method, body);
          if (!alive.current) return;
          if (result && result.ok) {
            if (method === 'check') {
              setNote(result.hasUpdate
                ? { kind: 'info', text: t('update.available', { v: result.latestVersion }) }
                : { kind: 'ok', text: t('update.upToDate') });
            } else if (method === 'install' || method === 'rollback') {
              setNote({
                kind: result.restartRequired ? 'warn' : 'ok',
                text: result.restartRequired
                  ? t('update.installedRestart', { v: result.version })
                  : t('update.installed', { v: result.version }),
              });
            }
            /* 刷新状态单独兜住：它失败不该把刚显示的「已更新到 vX」覆盖成错误文案。 */
            try {
              const next = await call('status');
              if (alive.current) setState(next);
            } catch { /* 状态没刷上不影响本次结果 */ }
          } else {
            setNote({ kind: 'error', text: (result && result.error) || t('update.failed') });
          }
        } catch (error) {
          if (alive.current) {
            setNote({ kind: 'error', text: String(error && error.message ? error.message : error) });
          }
        } finally {
          inFlight.current = false;
          if (alive.current) setBusy('');
        }
      };

      const tone = { ok: 'var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))',
        warn: 'var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))',
        error: 'var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))',
        info: 'var(--dsw-alias-label-tertiary)' };

      const btn = (label, method, body, primary) => h('button', {
        key: method,
        type: 'button',
        disabled: busy !== '',
        onClick: () => run(method, body),
        style: {
          flex: 'none', cursor: busy ? 'default' : 'pointer',
          padding: '3px 10px', fontSize: '12px', lineHeight: '18px',
          borderRadius: '6px', opacity: busy && busy !== method ? 0.5 : 1,
          color: primary ? 'var(--dsw-alias-label-primary-inverted,var(--dsw-alias-bg-base))' : 'var(--dsw-alias-label-secondary)',
          background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          border: `1px solid ${primary ? 'transparent' : 'var(--dsw-alias-border-l1)'}`,
        },
      }, busy === method ? t('update.working') : label);

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          padding: '6px 0 10px', minWidth: 0,
          fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)',
        },
      }, [
        h('span', { key: 'ver' }, `v${state.runningVersion}`),
        state.hasUpdate ? h('span', {
          key: 'arrow',
          style: { color: 'var(--dsw-alias-label-secondary)' },
        }, `→ v${state.latestVersion}`) : null,
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        note ? h('span', { key: 'note', style: { color: tone[note.kind] ?? tone.info } }, note.text) : null,
        btn(t('update.check'), 'check', undefined, false),
        state.hasUpdate ? btn(t('update.install'), 'install', { version: state.latestVersion }, true) : null,
        state.lastAppliedAt ? btn(t('update.rollback'), 'rollback', undefined, false) : null,
      ]);
    }

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        /* ---- 兼容性自检 ------------------------------------------------
         * DSH 升级后接口可能变化。这里**不阻断**插件加载（能跑就先跑），
         * 但把问题明确打到控制台，省得用户只看到「样式没变」却毫无头绪。 */
        const missing = [];
        if (typeof ctx.locale?.register !== 'function' || typeof ctx.locale?.bind !== 'function') missing.push('locale');
        if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') missing.push('slots');
        if (missing.length > 0) {
          compatReport(
            `缺少必需的服务：${missing.join(' / ')}`,
            '插件无法注册界面与文案，本次不会生效。',
          );
          return;
        }
        if (!primitives) {
          compatReport(
            '取不到 @deepseek-ai/dsh-client-ui-primitives',
            '思考面板会降级为纯文本渲染：功能仍在，但没有 Markdown 排版与思考图标。',
          );
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-thinking-panel: dictionaries');
        const t = ctx.locale.bind(NS);

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'thinking-panel-style', order: 90,
        }, StyleSeat));

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'thinking-panel-settings', order: 45,
        }, () => h(SettingsRow, { t })));

        // 遮蔽 assistant-step。
        // 运行时规则（实测于 DSH 0.2.0-rc.2 控制台）：
        //   keyed slot "conversation.chat.node" already has an entry for key
        //   "assistant-step" at priority 0 (registered by mf)
        //   — register at a different priority to shadow it (lowest renders)
        // 出厂占 priority 0，故必须用更小的值才能胜出。
        ctx.slots.inject('conversation.chat.node', () => {
          try {
            return ctx.slots.register({
              name: 'conversation.chat.node',
              key: 'assistant-step',
              priority: -1,
            }, (slotProps) => h(DeepSeekAssistantStep, Object.assign({}, slotProps, { pluginT: t })));
          } catch (error) {
            // 注册失败时出厂渲染器保持不动，功能不受影响，只是没有官方样式。
            compatReport(
              '遮蔽 assistant-step 失败，出厂渲染器保持不变',
              `原因：${error && error.message ? error.message : String(error)}\n`
              + '  常见原因：DSH 改了 keyed 槽的 priority 机制（本插件靠 priority -1 胜过出厂的 0）。',
            );
            return () => {};
          }
        });
      },
    };
  },
});
