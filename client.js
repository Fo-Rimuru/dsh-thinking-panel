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
    /**
     * 兜底翻译器。**必须是模块级常量**：写成每次 render 新建的箭头函数会让
     * `labels` 的 useMemo 每次都失效，进而击穿 MarkdownText 的 memo ——
     * 流式期间整段 Markdown 会全量重渲染。
     */
    const IDENTITY_T = (key) => key;
    /** useLayoutEffect 在自检沙箱（mock React）里没有，降级到 useEffect。 */
    const useLayout = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect;
    const STORAGE_KEY = 'dsh-thinking-panel.enabled';

    /**
     * 兼容性提示：DSH 升级后接口可能变化。
     *
     * 原则是**尽量不阻断**——能跑就先跑、能降级就降级，但一定要把问题明确打到
     * 控制台，否则用户只会看到「样式没变」却毫无头绪。提示里带上版本与反馈入口。
     */
    /** 兼容性提示的留档：设置页会读它并显示出来。 */
    const compatIssues = [];

    /**
     * 自检数据（设置页会渲染出来）。
     *
     * 为什么需要：本插件靠**遮蔽出厂的 `assistant-step`** 工作，DSH 每次升级都可能改这个
     * 节点的契约，而失败时的表现是「样式悄悄变回出厂」—— 用户只会以为插件没装好。
     * 把这些状态摊开，至少能一眼看出是哪一环掉了。
     */
    const diag = {
      // 静态能力（缺了就降级）
      markdownText: MarkdownText !== null,
      jsonBlock: JsonBlock !== null,
      thinkIcon: IconThink !== null,
      switch: Switch !== null,
      // 运行时计数
      rendered: 0,          // 成功渲染过的 assistant 节点数
      degraded: 0,          // 走了纯文本兜底的次数
      revealHits: 0,        // 自动展开过程组成功次数
      revealMisses: 0,      // 自动展开重试到放弃的次数
      navIcon: 'unknown',   // 导航图标补丁：applied / missing / unknown
      since: Date.now(),
    };

    function compatReport(problem, detail) {
      /* 留档一份：设置页会把它显示出来 —— 只打控制台的话，用户永远看不到，
       * 只会觉得「装了插件样式没变」。 */
      try {
        compatIssues.push(String(problem));
        while (compatIssues.length > 20) compatIssues.shift();
      } catch { /* ignore */ }
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
      'settings.navLabel': '深度思考面板',
      'settings.compatWarn': '检测到 {n} 条兼容性提示（详见控制台）—— DSH 升级后接口可能有变化，插件已尽量降级运行。',
      'settings.inject.title': '跟随提问语言思考',
      'settings.inject.desc': '向系统提示词与运行时上下文注入「用提问的语言思考」的规则。关掉就回到出厂的英文思考（部分任务上英文推理更稳）。',
      'settings.inject.toggle': '跟随提问语言思考',
      'settings.autoUpdate.title': '自动更新',
      'settings.autoUpdate.desc': 'DSH 启动后自动检查并安装新版本（写入前有预检与备份，失败会自动回滚）。',
      'settings.autoUpdate.toggle': '自动安装新版本',
      'update.rollbackTo': '回退到 v{v}',
      /* 自检 */
      'diag.title': '自检',
      'diag.render': '渲染过的思考节点',
      'diag.degraded': '降级',
      'diag.primitives': '可用的官方组件',
      'diag.autoReveal': '自动展开（成功 / 尝试）',
      'diag.navIcon': '导航图标补丁',
      'diag.compat': '兼容性提示',
      'diag.none': '无（已全部降级）',
      'diag.ok': '无',
      'diag.hint': '样式悄悄变回出厂时，先看这里：哪一项是 0 或者「无」，就是那一环掉了。',
      'settings.preview.title': '思考预览行数',
      'settings.preview.desc': '「思考中」折叠态显示几行推理正文（1–20，拖动即时生效）。5 行是照官方客户端的观感定的。',
      'settings.preview.unit': ' 行',
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
      'think.srRunning': '正在思考',
      'think.copy': '复制',
      'think.copied': '已复制',
      'think.backToBottom': '回到底部',
      'plain.unknownBlock': '未知内容块',
      'plain.truncated': '已截断（共 {total} 行）',
      'think.done': '已思考',
      'think.stopped': '已停止',
      'think.seconds': '（用时 {s} 秒）',
      'think.elapsed': '（已用时 {s} 秒）',
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
      'settings.navLabel': 'Thinking Panel',
      'settings.compatWarn': '{n} compatibility notice(s) — see the console. DSH interfaces may have changed; the plugin is degrading gracefully.',
      'settings.inject.title': 'Reason in the language of the question',
      'settings.inject.desc': 'Injects a "think in the language you were asked in" rule into the system prompt and the runtime context. Turn it off to go back to the shipped English reasoning (more reliable on some tasks).',
      'settings.inject.toggle': 'Reason in the question language',
      'settings.autoUpdate.title': 'Automatic updates',
      'settings.autoUpdate.desc': 'Checks for and installs new versions after DSH starts (pre-checked, backed up, and rolled back on failure).',
      'settings.autoUpdate.toggle': 'Install new versions automatically',
      'update.rollbackTo': 'Roll back to v{v}',
      /* self-check */
      'diag.title': 'Self-check',
      'diag.render': 'Thinking nodes rendered',
      'diag.degraded': 'degraded',
      'diag.primitives': 'Official components available',
      'diag.autoReveal': 'Auto-expand (ok / attempts)',
      'diag.navIcon': 'Nav icon patch',
      'diag.compat': 'Compatibility notices',
      'diag.none': 'none (fully degraded)',
      'diag.ok': 'none',
      'diag.hint': 'If the styling silently reverts to shipped, look here first: whichever row is 0 or "none" is the broken link.',
      'settings.preview.title': 'Preview lines',
      'settings.preview.desc': 'How many lines of reasoning the collapsed "thinking" state shows (1–20, applies as you drag). Five matches the official client.',
      'settings.preview.unit': ' lines',
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
      'think.srRunning': 'Thinking',
      'think.copy': 'Copy',
      'think.copied': 'Copied',
      'think.backToBottom': 'Back to bottom',
      'plain.unknownBlock': 'Unknown block',
      'plain.truncated': 'Truncated ({total} lines)',
      'think.done': 'Thought',
      'think.stopped': 'Stopped',
      'think.seconds': ' for {s}s',
      'think.elapsed': ' ({s}s elapsed)',
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
.dst-think-preview{margin-top:2px;max-height:calc(var(--dst-preview-lines,5) * 20px + 10px + var(--dsh-content-font-delta-secondary,0px) * var(--dst-preview-lines,5));
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
/* 与出厂 AssistantMarkdown.module.css 同构的排版基线：
   .root 给字号/行高/正文色，.body 给 16px 块间距。
   ⚠️ 刻意用 block + 相邻兄弟 margin，**不用 flex + gap**：
   flex item 的 min-height:auto 会在容器高度受限时把它压扁 —— 实测反馈就是
   「思考内容只剩一行」（5 行滚动预览被压成 1 行）。block 布局没有这个副作用。 */
.dst-root{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));
  color:var(--dsw-alias-label-primary);display:block;min-width:0}
.dst-body{display:block;min-width:0}
.dst-body>*+*{margin-top:16px}
/* 无障碍：屏幕阅读器能听出「正在思考」（出厂在同一位置用 row.running） */
.dst-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* 设置页（settings.section 的整页内容） */
.dst-page{display:flex;flex-direction:column;gap:2px;padding:4px 0;min-width:0}
.dst-page-title{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);margin-bottom:4px}
.dst-page-compat{margin:6px 0;padding:8px 10px;border-radius:6px;font-size:12px;line-height:18px;
  color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));
  background:var(--dsw-alias-interactive-bg-hover)}
.dst-update-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0 10px;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dst-update-ver,.dst-update-arrow{color:var(--dsw-alias-label-secondary)}
/* 设置页的自检区块 */
.dst-diag{margin-top:12px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);
  font-size:12px;line-height:18px}
.dst-diag-title{color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.dst-diag-row{display:flex;gap:8px;color:var(--dsw-alias-label-tertiary)}
.dst-diag-key{flex:none;min-width:9em}
.dst-diag-val{color:var(--dsw-alias-label-secondary);word-break:break-all}
.dst-diag-hint{margin-top:6px;color:var(--dsw-alias-label-caption)}
.dst-diag-issues{margin-top:6px;white-space:pre-wrap;
  color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
/* 设置页的滑动条行（预览行数）。自绘是因为拿不到官方的 Slider —— primitives 只导出了 Switch。 */
.dst-slider{display:flex;align-items:center;gap:12px;padding:10px 0;min-width:0}
.dst-slider-text{flex:1 1 auto;min-width:0}
.dst-slider-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dst-slider-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dst-slider-ctl{flex:none;display:inline-flex;align-items:center;gap:10px}
.dst-slider-input{width:150px;height:20px;-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer}
.dst-slider-input::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2)}
.dst-slider-input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5px;
  border-radius:50%;background:var(--dsw-alias-brand-primary);border:2px solid var(--dsw-alias-bg-base);
  box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}
.dst-slider-input:focus{outline:none}
.dst-slider-input:focus-visible::-webkit-slider-thumb{
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.dst-slider-val{flex:none;min-width:3.5em;text-align:right;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
/* 「回到底部」：浮在面板右下的小胶囊，只在没贴底时出现（长推理翻上去之后不用一路拖回来） */
.dst-scroll-bottom{position:absolute;right:8px;bottom:8px;z-index:2;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
  height:22px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:20px;
  box-shadow:0 1px 4px rgba(0,0,0,.12);transition:color .15s,background .15s}
.dst-scroll-bottom:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* 思考面板的复制按钮（官方 Markdown 有复制，思考正文一直没有） */
.dst-think-copy{margin-left:8px;flex:none;cursor:pointer;border:0;background:transparent;padding:0 4px;
  color:var(--dsw-alias-label-caption);font-size:var(--dsh-content-font-size-secondary,13px);border-radius:4px}
.dst-think-copy:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* 与出厂 AssistantMarkdown.module.css 的 .stopped 同款：被中断的轮次挂一个小徽标 */
.dst-stopped{border-radius:var(--dsw-radius-s,4px);background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-tertiary);align-self:flex-start;padding:0 6px;font-size:11px;line-height:18px}
/* 图标样板：只用来给设置导航项克隆 SVG，本身不占位、不可见。 */
.dst-icon-sample{position:absolute;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none}
.dst-plain{color:var(--dsw-alias-label-primary)}
.dst-plain-reasoning{margin:4px 0;color:var(--dsw-alias-label-secondary);
  font:var(--dsw-font-markdown-small);white-space:pre-wrap;max-height:6.5em;overflow:hidden}
/* 与出厂 AssistantMarkdown.module.css 同构：折叠的推理块收掉多余间距 */
/* 与出厂同构：负边距只在插件自己的 flex 正文容器里补偿（出厂限定 .body > …）；
   写成全局选择器会在没有 gap 的上下文里凭空把后续内容上移 16px。 */
.dst-body>[data-turn-process-inline][hidden]{margin-bottom:-16px}
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
     * 思考预览的行数（3 / 5 / 8 / 12）。
     *
     * 5 行是按官方观感定的，但屏幕高度和字号因人而异 —— 做成滑动条（1–20，步长 1）。
     * 用 CSS 变量下发：`.dst-think-preview` 的 `max-height` 直接乘它。
     */
    const PREVIEW_KEY = 'dsh-thinking-panel.preview-lines';
    const PREVIEW_MIN = 1;
    const PREVIEW_MAX = 20;
    const previewSubs = new Set();
    let previewLines = PREVIEW_LINES;
    try {
      const raw = Number(window.localStorage.getItem(PREVIEW_KEY));
      if (Number.isFinite(raw) && raw >= PREVIEW_MIN && raw <= PREVIEW_MAX) previewLines = Math.round(raw);
    } catch { /* ignore */ }
    /** 夹到合法范围（滑块的输入可能越界，也可能是 NaN）。 */
    function clampPreview(next) {
      const value = Math.round(Number(next));
      if (!Number.isFinite(value)) return previewLines;
      return Math.min(PREVIEW_MAX, Math.max(PREVIEW_MIN, value));
    }
    /** 把当前行数写进 `:root` 的 CSS 变量（样式表里用 var() 读）。 */
    function applyPreviewLines() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.style.setProperty('--dst-preview-lines', String(previewLines));
        }
      } catch { /* ignore */ }
    }
    function setPreviewLines(next) {
      const value = clampPreview(next);
      if (value === previewLines) return;
      previewLines = value;
      try { window.localStorage.setItem(PREVIEW_KEY, String(value)); } catch { /* ignore */ }
      applyPreviewLines();
      for (const fn of previewSubs) fn();
    }
    function usePreviewLines() {
      const [, force] = React.useReducer((n) => n + 1, 0);
      React.useEffect(() => {
        const listener = () => force();
        previewSubs.add(listener);
        return () => { previewSubs.delete(listener); };
      }, []);
      return previewLines;
    }

    /**
     * 出厂的会话滚动容器带 `data-conversation-scroll`（在 ui-chat-client.js 里就是这么找的），
     * 用它定位是**唯一可靠**的方式。
     *
     * ⚠️ 早先是沿 `parentElement` 往上找「第一个可滚动祖先」—— 结果先撞上过程组自己的
     * `[data-step-process-body]`（同样是 `overflow:auto`），于是把**组体**滚到底、
     * 外层纹丝不动，用户看到的还是「界面停在上一段」（实测反馈）。
     */
    function conversationScroller(el) {
      try {
        if (el && typeof el.closest === 'function') {
          const marked = el.closest('[data-conversation-scroll]');
          if (marked !== null && marked !== undefined) return marked;
        }
      } catch { /* ignore */ }
      return null;
    }

    /**
     * 是否「还在跟着最新内容」。
     *
     * 容差取**近一屏**而不是几十像素：用户插话时通常只是停在上一段（差不到一屏），
     * 而真正在翻历史的人会滚得远得多 —— 用几十像素的容差会把前一种情况误判成「在回看」，
     * 于是修复被自己的守卫挡掉（实测踩过）。
     */
    function isFollowingTail(node) {
      if (node === null || node === undefined) return false;
      try {
        const slack = node.clientHeight > 0 ? node.clientHeight * 0.9 : 400;
        return node.scrollHeight - node.scrollTop - node.clientHeight < slack;
      } catch { return false; }
    }

    function scrollToTail(node) {
      if (node === null || node === undefined) return;
      try { node.scrollTop = node.scrollHeight; } catch { /* ignore */ }
    }

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
          /* 只有「真的能聚焦」的元素才值得还原：document.body 的 focus() 是空操作，
           * 不判断就会出现「输入框失焦、焦点跳到组头」。 */
          const refocus = prev && prev !== head && prev !== document.body && typeof prev.focus === 'function';
          head.click();
          if (refocus) {
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
        diag.degraded += 1;
        try { console.error('[dsh-thinking-panel] render failed, falling back to plain text', error); }
        catch { /* ignore */ }
      }

      componentDidUpdate(prevProps) {
        /* 一次瞬时异常（半截 block、循环引用）不该让这条消息**永久**只剩纯文本：
         * 数据换了就再给正常渲染一次机会。 */
        if (this.state.failed && prevProps.blocks !== this.props.blocks) this.setState({ failed: false });
      }

      render() {
        if (this.state.failed) return plainFallback(this.props.blocks);
        return this.props.children;
      }
    }

    /** 兜底渲染的文本归一：非字符串直接塞进 React 会抛 "Objects are not valid as a React child"。 */
    function asText(value) {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try { return String(value); } catch { return ''; }
    }

    /** 未知块的兜底序列化：循环引用 / BigInt 会让 JSON.stringify 抛错，
     *  而抛在错误边界内部没人接 —— 整条消息会被降级成纯文本。 */
    function safeStringify(value) {
      try { return JSON.stringify(value); } catch { return '[unserializable]'; }
    }

    const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;
    function isAbsoluteWorkspacePath(path) { return path.startsWith('/') || WINDOWS_PATH.test(path); }
    /**
     * 与出厂 fileMediaUrl 同构：把**绝对本地路径**改写成带鉴权的 `api/file?path=…`。
     * ⚠️ 早先这里是直接 `new URL(value, base)` —— 本地图片不走鉴权路由、加载不出来；
     * 而出厂会拒绝的值（非绝对路径、UNC、控制字符）反而被原样放行。
     */
    function fileMediaUrl(base, path) {
      if (typeof base !== 'string' || typeof path !== 'string' || path.length === 0) return undefined;
      if (!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) return undefined;
      if (!isAbsoluteWorkspacePath(path)) return undefined;
      if (/^[/\\]{2}/u.test(path)) return undefined;
      if (/[\u0000-\u001f\u007f]/u.test(path)) return undefined;
      try { return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href; } catch { return undefined; }
    }
    function localPathMediaUrl(base, value) {
      let path;
      try { path = decodeURIComponent(String(value).split(/[?#]/u)[0] ?? ''); } catch { return undefined; }
      return fileMediaUrl(base, path);
    }

    /** 兜底渲染：只输出纯文本，不依赖任何 Harness 客户端包。 */
    function plainFallback(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b === undefined || b === null) continue;
        if (b.kind === 'reasoning') {
          out.push(h('div', { className: 'dst-plain-reasoning', key: i }, asText(b.text)));
        } else if (b.kind === 'text') {
          out.push(h('div', { className: 'dst-plain', key: i }, asText(b.text)));
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
      /* 揭示回调放进 ref：出厂的 reveal 每次 render 都可能换引用，
       * 直接写进依赖会让 beforematch 监听器反复摘挂、hidden 属性反复重设。 */
      const revealRef = React.useRef(reveal);
      revealRef.current = reveal;
      /* 与出厂同构：属性用 **layout effect** 设/清（用 useEffect 会晚一帧、折叠时闪一下），
       * 监听器则**单独且无条件**注册（展开期间也要在位）。 */
      useLayout(() => {
        const element = ref.current;
        if (element === null || typeof element.setAttribute !== 'function') return undefined;
        const doc = element.ownerDocument;
        if (hidden && doc && typeof element.contains === 'function' && element.contains(doc.activeElement)) {
          if (typeof revealRef.current === 'function') revealRef.current();
          return undefined;
        }
        if (hidden) element.setAttribute('hidden', 'until-found');
        else element.removeAttribute('hidden');
        return undefined;
      }, [hidden]);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null || typeof element.addEventListener !== 'function') return undefined;
        const onBeforeMatch = () => { if (typeof revealRef.current === 'function') revealRef.current(); };
        element.addEventListener('beforematch', onBeforeMatch);
        return () => { element.removeEventListener('beforematch', onBeforeMatch); };
      }, []);
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
    /**
     * 展开状态的两种来源，各自包成一个 hook 序列固定的组件。
     *
     * ⚠️ 这里踩过 React hooks 的坑：早先是在 ThinkingPanel 里写成「有注入就调用它、
     * 没有就退回本地状态」的三元表达式 —— 那是**条件调用 hook**。
     * 只要 props 变（DSH 换渲染路径、热更新），hook 数量随之变化，整棵 chat 树直接崩。
     * 现在改为「按 props 决定**渲染哪个**包装组件」，两边内部都是无条件调用。
     */
    function WithDisclosure(props) {
      const disclosure = props.useDisclosure();
      return h(ThinkingPanel, {
        ...props,
        useDisclosure: undefined,
        expanded: disclosure !== null && disclosure !== undefined && disclosure.expanded === true,
        toggle: disclosure && typeof disclosure.toggle === 'function' ? disclosure.toggle : NOOP,
      });
    }
    function WithOwnState(props) {
      const [expanded, setExpanded] = React.useState(false);
      return h(ThinkingPanel, {
        ...props,
        useDisclosure: undefined,
        expanded,
        toggle: React.useCallback(() => setExpanded((v) => !v), []),
      });
    }
    /** 有注入的 useDisclosure 就用它（与出厂一致，跟随 Turn 重置），否则退回自带状态。 */
    function Expandable(props) {
      return typeof props.useDisclosure === 'function'
        ? h(WithDisclosure, props)
        : h(WithOwnState, props);
    }

    function ThinkingPanel(props) {
      const { text, running, stopped, expanded, toggle, t } = props;
      const tr = typeof t === 'function' ? t : IDENTITY_T;
      /** 复制思考正文。`navigator.clipboard` 在非安全上下文里可能没有 → 静默降级。 */
      const [copied, setCopied] = React.useState(false);
      const copy = React.useCallback(() => {
        try {
          const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
          if (!clip || typeof clip.writeText !== 'function') return;
          clip.writeText(text).then(() => {
            setCopied(true);
            if (typeof setTimeout === 'function') setTimeout(() => setCopied(false), 1500);
          }, () => { /* 被拒绝就算了，不打扰用户 */ });
        } catch { /* ignore */ }
      }, [text]);

      const scrollRef = React.useRef(null);
      const rootRef = React.useRef(null);
      /** 是否已经贴底（决定要不要显示「回到底部」）。 */
      const [atBottom, setAtBottom] = React.useState(true);
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

        /* ⚠️ 必须在**展开之前**记录外层是否在跟随：展开会让内容瞬间长高几百像素，
         * 之后再判断就已经「不接近底部」了，守卫反而会把正确的修复挡掉（实测踩过）。 */
        const following = isFollowingTail(conversationScroller(el));

        /* 展开之后把外层带回底部：既修正视觉位置，也触发一次 scroll 事件，
         * 让 DSH 自己的跟随逻辑重新判定「在底部」而恢复跟随。
         * ⚠️ 首次成功和**重试成功**都必须走这一步 —— 实测撞上的恰恰是重试那条路径
         *（面板挂载时官方还没给组体打 hidden），上一版只在首次分支里调用，等于没修（审查发现）。 */
        const settle = () => {
          if (!following) return;
          const stick = () => scrollToTail(conversationScroller(el));
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(stick));
          } else {
            stick();
          }
        };

        if (revealProcessGroup(el)) {
          revealed.current = true;
          diag.revealHits += 1;
          settle();
          return undefined;
        }

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
          if (revealProcessGroup(rootRef.current)) { revealed.current = true; diag.revealHits += 1; settle(); return; }
          if (++tries >= 8) { diag.revealMisses += 1; return; }
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
        let scheduled = false;
        if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(clear); scheduled = true; }
        /* 窗口不可见时 rAF 会暂停，标志就可能一直挂着（用户的向上滚动会被永远忽略）→ 定时器兜底 */
        if (typeof setTimeout === 'function') { setTimeout(clear, 250); scheduled = true; }
        if (!scheduled) clear();
      };

      // 跟随最新内容（FOLLOW='tail'）或钉在开头（FOLLOW='top'）。
      // ⚠️ 展开态**也要跟随**：早先这里写成 `if (el === null || expanded) return`，
      // 导致流式推理展开后停在中途、用户得手动往下拖（实测反馈）。展开与折叠
      // 共用同一个 scrollRef，所以只要不提前返回，两端都会自动贴到最新内容。
      React.useEffect(() => {
        const el = scrollRef.current;
        /* 面板长高会让**外层**的跟随失效：DSH 的跟随阈值只有 25px（出厂
         * `useScrollFollow(state.followingTail, 25)`），我们一次流式更新就可能长几十像素 ——
         * 一超阈值它就认定「用户在往上读」，此后连插话都不再自动滚
         *（出厂源码 4979 行：steering 变化时也带着 `&& reading.followingTail`）。
         * 所以在每次内容变化后，只要外层仍在底部附近，就顺手把它带到底。 */
        const outer = conversationScroller(el);
        if (isFollowingTail(outer)) scrollToTail(outer);
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
        /* 只在内容/形态真的变了才滚 —— 没有依赖数组时，任何一次重渲染都会读
         * scrollHeight（强制同步布局），而流式期间每秒要重渲染几十次。 */
      }, [text, expanded, running]);

      const handleScroll = React.useCallback(() => {
        if (programmatic.current) return;           // 自己触发的滚动，不算用户操作
        const el = scrollRef.current;
        if (el === null) return;
        // 距底部 24px 内视为「跟随中」，否则暂停跟随
        const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        stick.current = gap < 24;
        setAtBottom(gap < 24);
      }, []);

      // 是否可滚动 → 决定底部淡出遮罩。
      // ⚠️ ResizeObserver 只在挂载时建一次：早先依赖 [text, …]，流式期间每秒
      //    创建销毁几十个观察器。真正的判定逻辑放进 ref，回调里读最新值。
      const updateCanScrollRef = React.useRef(null);
      updateCanScrollRef.current = () => {
        const el = scrollRef.current;
        if (el === null || expanded) { setCanScroll(false); setAtBottom(true); return; }
        setCanScroll(el.scrollHeight > el.clientHeight + 1);
        setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      };
      useLayout(() => { updateCanScrollRef.current(); }, [text, expanded, running]);
      React.useEffect(() => {
        if (typeof ResizeObserver === 'undefined') return undefined;
        const el = scrollRef.current;
        if (el === null) return undefined;
        const ro = new ResizeObserver(() => updateCanScrollRef.current());
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      /**
       * 思考中也要显示已用时间。
       *
       * 数据是现成的：出厂 `projectAssistant` 里
       * `const time = settled?.time ?? state.firstVisibleTime ?? …`（ui-chat-client.js 7604 行）
       * —— 流式期就有 `state.firstVisibleTime`，所以**不需要自己计时**，
       * 只要每秒重渲染一次、把差值算出来。定时器只在 running 时开。
       */
      const [, tick] = React.useState(0);
      const startedAt = props.startedAt;
      const hasStart = typeof startedAt === 'number' && startedAt > 0;
      React.useEffect(() => {
        if (!running || !hasStart) return undefined;
        if (typeof setInterval !== 'function') return undefined;
        const timer = setInterval(() => tick((n) => n + 1), 1000);
        return () => { try { clearInterval(timer); } catch { /* ignore */ } };
      }, [running, hasStart]);

      const liveSeconds = running && hasStart
        ? Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        : null;
      const seconds = liveSeconds !== null ? liveSeconds : props.seconds;
      const title = running
        ? tr('think.running') + (liveSeconds !== null ? tr('think.elapsed', { s: liveSeconds }) : '')
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
          /* 键盘焦点落在子元素（复制按钮）上时不要抢它的 Enter/Space：
           * 否则按 Enter 想复制，结果被这里 preventDefault 掉、还顺手切换了展开态。 */
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        },
      }, [
        h('span', { className: 'dst-think-icon', key: 'icon', 'aria-hidden': true },
          IconThink ? h(IconThink, { size: 14 }) : h('span', null, '✦')),
        h('span', { className: 'dst-think-title', key: 'title' }, title),
        running ? h('span', { key: 'sr', className: 'dst-sr' }, tr('think.srRunning')) : null,
        text ? h('button', {
          key: 'copy',
          type: 'button',
          className: 'dst-think-copy',
          title: tr('think.copy'),
          'aria-label': tr('think.copy'),
          onClick: (event) => { event.stopPropagation(); copy(); },
        }, copied ? tr('think.copied') : tr('think.copy')) : null,
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

      /* 「回到底部」：长推理往上翻之后不用一路拖回来。只在没贴底时出现，浮在右下角。 */
      const backToBottom = atBottom ? null : h('button', {
        key: 'back',
        type: 'button',
        className: 'dst-scroll-bottom',
        title: tr('think.backToBottom'),
        'aria-label': tr('think.backToBottom'),
        onClick: (event) => {
          event.stopPropagation();
          const el = scrollRef.current;
          if (el === null) return;
          markProgrammatic();
          el.scrollTop = el.scrollHeight;
          stick.current = true;
          setAtBottom(true);
        },
      }, tr('think.backToBottom'));

      return h('div', {
        ref: rootRef,
        className: 'dst-think',
        'data-collapsed': expanded ? undefined : true,
        'data-variant': 'think',
        'data-state': running ? 'running' : (stopped ? 'stopped' : 'ok'),
      }, [head, body, backToBottom]);
    }

    /* ================================================================== *
     * assistant-step 渲染器（遮蔽出厂 AssistantNodeView）
     * ================================================================== */
    function DeepSeekAssistantStep(props) {
      const { node, groupPart, renderMessageImages, fileMentions, turnProcess, useDisclosure, useTurnData } = props;
      /* 自带翻译器优先：注入的 t 属于 chat 命名空间，未必提供给我们这个条目。 */
      const tr = typeof props.pluginT === 'function'
        ? props.pluginT
        : (typeof props.t === 'function' ? props.t : IDENTITY_T);
      const on = useEnabled();
      // 自检计数放在 effect 里（render 期间不改模块状态 —— 那是之前 timings 踩过的坑）
      React.useEffect(() => { diag.rendered += 1; }, []);

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

      /* ⚠️ `tail` 必须是**组件主体里的无条件 hook**，绝不能塞进下面的 useMemo 里：
       * useTurnData 内部是 useSyncExternalStore（出厂的 useTurnDataValue），而它原本还位于
       * 两道提前 return 之后 —— turn 从 open→closed 时这次渲染就多一个 hook，React 会抛
       * #310，生产下 hook 槽位错位（审查发现；与设置页那次是同一个病根）。
       * 出厂 AssistantNodeView 也是把 `const tail = useTurnData('turn-tail')` 放在顶层。 */
      const turnTail = typeof useTurnData === 'function' ? useTurnData('turn-tail') : undefined;

      /**
       * 外层跟随的兜底 —— **整个 assistant 节点**每次渲染都检查一次。
       *
       * ⚠️ 只挂在思考面板里是不够的：面板在「最终回答」阶段已经不再变化
       *（`running=false`、`text` 也不再变），而内容还在长。
       * 实测反馈正是这条路：「上一段话还没输出完就插话，之后界面不跟随」。
       * 这里没有依赖数组 —— 每次渲染都查一次，代价只是一次 closest + 一次算术。
       */
      const stepRef = React.useRef(null);
      React.useEffect(() => {
        const outer = conversationScroller(stepRef.current);
        if (isFollowingTail(outer)) scrollToTail(outer);
      });

      // 文件提及（与出厂同构：仅在 turn 关闭且有 finalNode 时可用）
      const mentions = React.useMemo(() => {
        try {
          if (!fileMentions || !node || !node.location) return undefined;
          const loc = node.location;
          const turn = loc.kind === 'turn' || loc.kind === 'step' ? loc.turn : undefined;
          if (!turn || turn.status !== 'closed' || data.finalNode === undefined) return undefined;
          /* 与出厂同构：只有「收尾的那一节点」才解析文件提及。少了这道守卫，
           * 非收尾步骤也会解析一遍 —— 而同一个节点会以 reasoning / response
           * 两种 groupPart 各渲染一次。 */
          const closing = turnTail && turnTail.closing ? turnTail.closing.finalNode : undefined;
          if (closing !== undefined && closing !== null && closing.seq !== data.finalNode.seq) return undefined;
          return fileMentions({ turn, seq: data.finalNode.seq, openFile: props.openFile });
        } catch { return undefined; }
      }, [fileMentions, node, data.finalNode, props.openFile, turnTail]);

      const labels = React.useMemo(() => markdownLabels(tr), [tr]);
      // 与出厂同构：本地绝对路径走鉴权文件路由，而不是直接拼 URL
      const pathImages = React.useMemo(() => ({
        resolve: (value) => localPathMediaUrl(document.baseURI, value),
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
            ? h(Expandable, {
              text: block.text,
              running: running && tail,
              stopped: interrupted,
              seconds,
              // 思考中的「已用时间」用它算：出厂的 data.time 在流式期就是首个可见块的时间
              startedAt: typeof data.time === 'number' ? data.time : null,
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
          } catch (error) {
            /* 静默吞掉过一次：图片整组消失且毫无线索。至少留一行日志。 */
            try { console.warn('[dsh-thinking-panel] renderMessageImages failed', error); } catch { /* ignore */ }
          }
          continue;
        }

        if (block.kind === 'tool-call') continue; // 工具调用是独立节点

        /* 与出厂同构：payload 取 other 包装体里的真实载荷（block.block），标签与
         * truncatedLabel 也照抄 —— 否则未知块显示的是整个包装对象、还丢了截断提示。 */
        const payload = block.block !== undefined ? block.block : block;
        out.push(JsonBlock
          ? h(JsonBlock, {
            key: i,
            label: tr('plain.unknownBlock'),
            payload,
            truncatedLabel: (total) => tr('plain.truncated', { total }),
          })
          : h('div', { key: i, className: 'dst-plain' }, safeStringify(payload)));
      }

      if (out.length === 0) return null;
      /* 与出厂同构：只有「非 reasoning 分组」的那一份才挂「已停止」徽标，
       * 否则同一个节点会在过程组内外各显示一次。 */
      const stoppedBadge = interrupted && (groupPart === undefined || groupPart === 'response')
        ? h('span', { key: 'stopped', className: 'dst-stopped' }, tr('think.stopped'))
        : null;
      /* 与出厂 AssistantMarkdown 同构：外面套 .dst-root（字号/行高/正文色基线）与
       * .dst-body（16px 块间距）。少了它们，多块消息的行距与段间距会和出厂不一样。 */
      return h(ThinkingBoundary, { blocks },
        h('div', { ref: stepRef, className: 'dst-root', 'data-streaming': running || undefined },
          h('div', { className: 'dst-body' },
            stoppedBadge === null ? out : out.concat([stoppedBadge]))));
    }

    /* ================================================================== *
     * 样式座位与设置行
     * ================================================================== */
    function StyleSeat() {
      return h(React.Fragment, null, [
        h('style', { key: 'css', 'data-plugin': 'dsh-thinking-panel' }, CSS),
        /* 藏一个图标样板：设置导航项的 DOM 补丁要克隆这里的 SVG，
         * 这样它和「已思考」左边那个图标一定是同一个。 */
        IconThink
          ? h('span', { key: 'icon', className: 'dst-icon-sample', 'aria-hidden': true },
            h(IconThink, { size: 16 }))
          : null,
      ]);
    }

    /**
     * 通用开关行：标题 + 说明 + 官方 Switch（拿不到 primitives 时退回自绘滑块）。
     * 设置里有两行，抽出来也顺便保证两行与同页官方条目同款。
     */
    function ToggleRow(props) {
      const { title, desc, checked, label, onLabel, offLabel, onChange, disabled } = props;
      const fallbackToggle = h('button', {
        key: 'toggle',
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        title: checked ? offLabel : onLabel,
        disabled: disabled === true,
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
            /* 写入进行中时禁用：官方 Switch 支持 disabled（注释里写明 owners also set it
             * while a write is in flight）。不传的话点了会被 run() 的重入守卫静默吞掉 ——
             * 开关纹丝不动、也没任何提示。 */
            disabled: disabled === true,
            onChange,
          })
          : fallbackToggle,
      ]);
    }

    /**
     * 设置页的错误边界。
     *
     * ⚠️ 加这一层是因为踩过：0.2.0 刚发出去时，设置左侧的导航项出来了、**内容却是空白** ——
     * 组件抛的错被宿主吞掉，一点线索都没有。现在抛错会**显示在页面上**。
     */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) { return { error }; }

      componentDidCatch(error) {
        try { console.error('[dsh-thinking-panel] settings section failed', error); } catch { /* ignore */ }
      }

      render() {
        if (this.state.error !== null) {
          const message = this.state.error && this.state.error.message
            ? this.state.error.message
            : String(this.state.error);
          return h('div', { className: 'dst-page' }, [
            h('div', { key: 'title', className: 'dst-page-title' }, '深度思考面板'),
            h('div', { key: 'error', className: 'dst-page-compat' }, `设置页渲染失败：${message}`),
          ]);
        }
        return this.props.children;
      }
    }

    /**
     * 给设置导航项换上思考图标。
     *
     * ⚠️ DSH 的设置导航图标是 shell 里 `navIcon(id)` 的**硬编码映射**，第三方 section
     * 一律拿兜底齿轮 —— 官方 SlotLabel 也没有 icon 选项（壁纸引擎的源码注释里写明了这点）。
     * 所以只能像壁纸引擎 / 电脑控制那样做 DOM 补丁：给标签文字匹配的按钮打个 class，
     * 再用 CSS mask 盖上我们自己的图标。**补丁失败就保留齿轮**，不抛、不重试。
     */
    const NAV_SVG_CLASS = 'dst-nav-svg';

    function installNavIcon(labelOf) {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      let observer = null;
      let frame = 0;
      let disposed = false;

      const sync = () => {
        frame = 0;
        if (disposed) return;
        try {
          const label = typeof labelOf === 'function' ? labelOf() : '';
          if (!label) return;
          const sample = document.querySelector('.dst-icon-sample svg');
          if (sample === null) return;                 // 样板还没渲染：等下一次 MutationObserver
          for (const dialog of document.querySelectorAll('[role="dialog"]')) {
            for (const button of dialog.querySelectorAll('nav button')) {
              if ((button.textContent || '').trim() !== label) continue;
              /* ⚠️ 走「克隆真实 SVG 替换原图标」，不用 CSS mask。
               * mask 那条路踩了两次坑：① data URI 里没有 currentColor 的上下文，
               * DSH 的描边型图标会被渲染成**全透明**，mask 拿到空 alpha，那个位置一片空白；
               * ② 原图标外面还套了一层，`>svg` 选不中它，于是新旧图标并排、中间留出空位。
               * 直接换节点没这些问题：颜色（currentColor）、尺寸、描边全都跟原样走。 */
              if (button.querySelector(`.${NAV_SVG_CLASS}`) !== null) continue;
              const original = button.querySelector('svg');
              if (original === null) continue;
              const clone = sample.cloneNode(true);
              clone.classList.add(NAV_SVG_CLASS);
              try {
                const box = original.getBoundingClientRect();
                if (box && box.width > 0) {
                  clone.setAttribute('width', String(Math.round(box.width)));
                  clone.setAttribute('height', String(Math.round(box.height)));
                }
              } catch { /* 拿不到尺寸就用样板自带的 */ }
              try {
                original.replaceWith(clone);
                clone.__dstOriginalSvg = original;    // 卸载时换回去
                diag.navIcon = 'applied';
              } catch { diag.navIcon = 'missing'; }
            }
          }
        } catch { /* 补丁失败＝保留齿轮 */ }
      };

      const schedule = () => {
        if (frame !== 0) return;
        try { frame = requestAnimationFrame(sync); } catch { sync(); }
      };
      sync();
      try {
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
      } catch { /* ignore */ }

      return () => {
        disposed = true;
        if (frame !== 0) { try { cancelAnimationFrame(frame); } catch { /* ignore */ } }
        try { if (observer) observer.disconnect(); } catch { /* ignore */ }
        /* 换进去的图标在插件卸载/禁用时换回原来的（否则齿轮回不来，得重开设置面板才自愈）。 */
        try {
          document.querySelectorAll(`.${NAV_SVG_CLASS}`).forEach((node) => {
            const original = node.__dstOriginalSvg;
            if (original && typeof node.replaceWith === 'function') node.replaceWith(original);
          });
        } catch { /* ignore */ }
      };
    }

    /** 设置页的「自检」区块：把 diag 摊成几行 —— 样式回退时一眼看出是哪一环掉了。 */
    function DiagBlock(props) {
      const tr = typeof props.t === 'function' ? props.t : IDENTITY_T;
      const primitives = [
        diag.markdownText ? 'MarkdownText' : null,
        diag.thinkIcon ? 'IconThink' : null,
        diag.jsonBlock ? 'JsonBlock' : null,
        diag.switch ? 'Switch' : null,
      ].filter(Boolean);
      const rows = [
        [tr('diag.render'), String(diag.rendered) + (diag.degraded > 0 ? `  ·  ${tr('diag.degraded')} ${diag.degraded}` : '')],
        [tr('diag.primitives'), primitives.length > 0 ? primitives.join(' · ') : tr('diag.none')],
        [tr('diag.autoReveal'), `${diag.revealHits} / ${diag.revealHits + diag.revealMisses}`],
        [tr('diag.navIcon'), diag.navIcon],
        [tr('diag.compat'), compatIssues.length > 0 ? String(compatIssues.length) : tr('diag.ok')],
      ];
      return h('div', { className: 'dst-diag' }, [
        h('div', { key: 'title', className: 'dst-diag-title' }, tr('diag.title')),
        ...rows.map((pair, i) => h('div', { key: `r${i}`, className: 'dst-diag-row' }, [
          h('span', { key: 'k', className: 'dst-diag-key' }, pair[0]),
          h('span', { key: 'v', className: 'dst-diag-val' }, String(pair[1])),
        ])),
        h('div', { key: 'hint', className: 'dst-diag-hint' }, tr('diag.hint')),
        compatIssues.length > 0
          ? h('div', { key: 'issues', className: 'dst-diag-issues' }, compatIssues.join('\n'))
          : null,
      ]);
    }

    /**
     * 设置页 —— 注册在 `settings.section`，也就是设置左侧导航里**独立的一栏**。
     *
     * 早先挂在 `settings.general.item`（通用设置里的一行）：位置太深，也塞不下
     * 现在这些开关。`label` 是个 thunk，跟随语言切换。
     */
    /**
     * 带滑动条的数值行（目前只有「预览行数」用）。
     *
     * 自绘 `<input type="range">`：在 ui-chat 用到的那几十个 `ui-primitives` 导出里没见到 Slider
     *（有 Icon* / MarkdownText / JsonBlock / DisclosureRow / Tooltip / TextShimmer / StateDot /
     *  Modal / Button / Menu / Toast …，就是没有滑块），所以自己画。样式尽量贴官方。
     */
    function SliderRow(props) {
      const { title, desc, value, min, max, unit, onInput } = props;
      return h('div', { className: 'dst-slider' }, [
        h('div', { key: 'text', className: 'dst-slider-text' }, [
          h('div', { key: 't', className: 'dst-slider-title' }, title),
          h('div', { key: 'd', className: 'dst-slider-desc' }, desc),
        ]),
        h('div', { key: 'ctl', className: 'dst-slider-ctl' }, [
          h('input', {
            key: 'input',
            type: 'range',
            className: 'dst-slider-input',
            min, max, step: 1,
            value,
            'aria-label': title,
            onChange: (event) => onInput(event.target.value),
          }),
          h('span', { key: 'val', className: 'dst-slider-val' }, `${value}${unit || ''}`),
        ]),
      ]);
    }

    function SettingsSection(props) {
      const tr = typeof props.t === 'function' ? props.t : IDENTITY_T;
      const on = useEnabled();
      const auto = useAutoReveal();
      const preview = usePreviewLines();
      return h('div', { className: 'dst-page' }, [
        h('div', { key: 'title', className: 'dst-page-title' }, tr('settings.title')),
        compatIssues.length > 0
          ? h('div', { key: 'compat', className: 'dst-page-compat' }, tr('settings.compatWarn', { n: compatIssues.length }))
          : null,
        h(ToggleRow, {
          key: 'enabled',
          title: tr('settings.toggle'),
          desc: tr('settings.desc'),
          checked: on,
          label: tr('settings.toggle'),
          onLabel: tr('settings.on'),
          offLabel: tr('settings.off'),
          onChange: (next) => setEnabled(next),
        }),
        h(ToggleRow, {
          key: 'auto-reveal',
          title: tr('settings.autoReveal.title'),
          desc: tr('settings.autoReveal.desc'),
          checked: auto,
          label: tr('settings.autoReveal.toggle'),
          onLabel: tr('settings.autoReveal.on'),
          offLabel: tr('settings.autoReveal.off'),
          onChange: (next) => setAutoReveal(next),
        }),
        h(SliderRow, {
          key: 'preview',
          title: tr('settings.preview.title'),
          desc: tr('settings.preview.desc'),
          value: preview,
          min: PREVIEW_MIN,
          max: PREVIEW_MAX,
          unit: tr('settings.preview.unit'),
          onInput: (n) => setPreviewLines(n),
        }),
        h(UpdatePanel, { key: 'update', t: tr }),
        h(DiagBlock, { key: 'diag', t: tr }),
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

    function UpdatePanel(props) {
      const t = props.t;
      const [state, setState] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState(null);

      /**
       * 卸载保护 + 重入守卫。两个都踩过：
       *  ① `await` 之后 setState 落在已卸载组件上；
       *  ② `disabled` 要等重渲染才生效，快速双击能并发两次 install ——
       *     而 install 是会**写文件系统**的操作（Host 侧另有一道互斥兜底）。
       *
       * ⚠️ 这两个 ref 必须在 `if (state === null) return null;` **之前**声明。
       * 0.2.0 把它们写在了后面：首帧 `state` 还是 null，只跑 5 个 hook 就提前返回；
       * status 回来后又接着跑 8 个 hook —— React 抛 #310（hooks 数量变化），
       * 整个设置页被错误边界兜成一片空白。
       */
      const alive = React.useRef(true);
      React.useEffect(() => {
        /* ⚠️ 进入时先置 true：StrictMode / 热更新会 mount → cleanup → mount，
         * 不复位的话第二次挂载后 alive 恒为 false → finally 里的 setBusy('') 永不执行，
         * 按钮就永久 disabled、提示永不显示（审查发现）。 */
        alive.current = true;
        return () => { alive.current = false; };
      }, []);
      const inFlight = React.useRef(false);

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

      /* ⚠️ 记住「关掉之前是哪个模式」：Host 有四种（auto/zh/en/off），而 UI 只有两态。
       * 用户把 cordis.patch.yml 配成 zh 之后，把开关关一下再开，不该被静默改成 auto
       * （审查发现）。这个 ref 必须在下面的提前返回**之前**声明。 */
      const lastOnMode = React.useRef('auto');
      if (state !== null) {
        const current = typeof state.mode === 'string' ? state.mode : 'auto';
        if (current !== 'off') lastOnMode.current = current;
      }

      // ⚠️ 这个提前返回必须放在**所有 hook 之后**
      if (state === null) return null;

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

      const mode = typeof state.mode === 'string' ? state.mode : 'auto';
      return h('div', { className: 'dst-update' }, [
        h(ToggleRow, {
          key: 'inject',
          title: t('settings.inject.title'),
          desc: t('settings.inject.desc'),
          checked: mode !== 'off',
          label: t('settings.inject.toggle'),
          onLabel: t('settings.on'),
          offLabel: t('settings.off'),
          onChange: (next) => run('mode', { mode: next ? (lastOnMode.current || 'auto') : 'off' }),
          disabled: busy !== '',
        }),
        h(ToggleRow, {
          key: 'auto-update',
          title: t('settings.autoUpdate.title'),
          desc: t('settings.autoUpdate.desc'),
          checked: state.autoUpdate !== false,
          label: t('settings.autoUpdate.toggle'),
          onLabel: t('settings.on'),
          offLabel: t('settings.off'),
          onChange: (next) => run('auto-update', { enabled: next }),
          disabled: busy !== '',
        }),
        h('div', { key: 'row', className: 'dst-update-row' }, [
          h('span', { key: 'ver', className: 'dst-update-ver' }, `v${state.runningVersion}`),
          state.hasUpdate
            ? h('span', { key: 'arrow', className: 'dst-update-arrow' }, `→ v${state.latestVersion}`)
            : null,
          note ? h('span', { key: 'note', style: { color: tone[note.kind] ?? tone.info } }, note.text) : null,
          h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          btn(t('update.check'), 'check', undefined, false),
          state.hasUpdate ? btn(t('update.install'), 'install', { version: state.latestVersion }, true) : null,
          /* 回退目标由 Host 算好（上一个**装过**的版本），不是当前版本 ——
           * 否则重启之后点回退只会把当前版本再装一遍。 */
          state.previousVersion
            ? btn(t('update.rollbackTo', { v: state.previousVersion }), 'rollback', undefined, false)
            : null,
        ]),
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
        // 预览行数落在 :root 的 CSS 变量上（样式表里 var(--dst-preview-lines,5)）
        applyPreviewLines();

        /* 设置导航项的图标：官方只给第三方兜底齿轮，这里做 DOM 补丁换成本插件的思考图标
         *（失败就保留齿轮，不影响任何功能）。 */
        ctx.effect(() => installNavIcon(() => t('settings.navLabel')), 'dsh-thinking-panel: settings nav icon');

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'thinking-panel-style', order: 90,
        }, StyleSeat));

        /* 设置左侧导航里**独立的一栏**（`settings.section`）。
         * 电脑控制 / 壁纸引擎 / Token 用量都用这个槽位，已实测可用；
         * `label` 是 thunk，跟随语言切换。 */
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'thinking-panel',
          order: 62,
          label: () => t('settings.navLabel'),
          locale: NS,
        }, (slotProps) => h(SectionBoundary, null,
          h(SettingsSection, { t: slotProps && slotProps.t ? slotProps.t : t }))));

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
