# 遮蔽 assistant-step 后的维护清单

> 本清单来自两条独立来源的交叉验证：
> ① 我们在 DSH 0.2.0-rc.2 上的实测（隔离 profile + 真实浏览器）；
> ② 同一问题交给模型独立排查后给出的结论（两者在 priority 机制上互相印证）。
>
> 每次 DSH 升级后按此清单回归一遍即可。

---

## 一、遮蔽生效性（第一优先级）

| 检查 | 判据 | 失效表现 |
|---|---|---|
| 我们的注册优先级仍低于出厂 | 出厂注册 **不写 priority**（即 0）；我们必须 **< 0**（当前用 `-1`） | 出厂哪天把 priority 调到比我们更低，我们**静默失去遮蔽**、悄悄变回出厂渲染 |
| 同 key 同 priority 会**直接抛错** | 控制台出现 `keyed slot "conversation.chat.node" already has an entry for key "assistant-step"` | 我们的注册被拒绝；插件会打印 `could not shadow assistant-step; shipped renderer stays` 并保持出厂渲染 |
| 槽条目未崩溃 | 控制台无 `slot entry crashed in '<slot>'` | 整行空白 |
| 注册确实生效 | 页面里出现 `.dst-think` 元素 | 只有出厂「思考」单行摘要 |

**实测原文**（DSH 0.2.0-rc.2 控制台）：

```
Error: keyed slot "conversation.chat.node" already has an entry for key "assistant-step"
       at priority 0 (registered by mf)
       — register at a different priority to shadow it (lowest renders)
```

> ⚠️ 槽目录（`Slots.listSubTree`）里那句「Registering an already-occupied key replaces that
> occupant」**是不完整的**：运行时要求换一个优先级，且**数值最低者渲染**。

## 二、必须复刻的出厂行为清单

遮蔽后我们接管的是**整条 assistant 消息**，不是「思考链那一行」。以下逐项对应出厂
`AssistantNodeView` → `AssistantMarkdown` → `ReasoningRow`：

| 行为 | 出厂实现 | 我们的对应实现 |
|---|---|---|
| 块遍历与 `groupPart` 过滤 | `groupPart==='reasoning'` 只留 reasoning；`'response'` 跳过 reasoning | 同构 |
| `tool-call` 块 | `case "tool-call": break`（工具卡是**独立 ChatNodeKind**，不在本节点） | 同构 |
| `text` 块 | `MarkdownText {text, streaming, labels, fileMentions, pathImages}` | 同构 |
| `image` 块 | 连续图片合并成一组 → `renderMessageImages({images, align:'start'})` | 同构 |
| 未知块 | `JsonBlock` + `t("message.unknownBlock")` | 同构 |
| 推理折叠锚点 | `ProcessReasoning` → `div[data-turn-process-inline]` | 同构 |
| 折叠时保留可查找性 | `hidden="until-found"` + `beforematch` 揭示 | 同构 |
| 折叠态间距 | `[data-turn-process-inline][hidden]{margin-bottom:-16px}` | 同构 |
| **Markdown 装饰文案** | `markdownLabels(t)` → `code.{copyLabel,copiedLabel,toolbarLabels:{codeLabel,wrapLabel,unwrapLabel}}` + `footnotes` | 同构（**缺项会在渲染含代码块的消息时抛错**） |
| 展开状态 | 注入的 `useDisclosure()`（跟随 Turn 重置） | 优先用注入值，缺失时退回自带 `useState` |
| 空 blocks | 返回 `null` | 同构 |
| 文件提及 | `fileMentions({turn, seq, openFile})`，仅 turn 关闭且有 `finalNode` 时 | 同构 |
| 错误兜底 | 无（条目抛错即整行空白） | **额外加 ErrorBoundary → 纯文本兜底** |

## 三、易静默退化的宿主 DOM 契约

这些属性由宿主 `ChatNodeSeat` 提供（**不在我们的组件里**），但它们的语义依赖我们的 DOM 结构：

`data-chat-node-key` / `data-chat-group-part` / `data-chat-anchor-key` / `data-chat-flow-key`
/ `data-chat-paging-anchor` / `data-chat-flow-kind` / `data-chat-turn`
/ `data-turn-process-member` / `data-turn-process-hidden` / `data-turn-process-answer`

**症状**：界面不报错，但分组间距、阅读位置恢复、Turn 折叠语义**安静退化**。
**排查**：升级后对比遮蔽前后的 DOM，确认这些属性仍在、且我们的组件没有打断它们的作用域。

## 四、升级回归步骤（建议顺序）

1. **先验遮蔽**：看控制台是否出现 `already has an entry` / `slot entry crashed`；用
   `cordis_inspect_query`（client `Slots.listSubTree(root='conversation.chat.node')`）
   对比双方注册的 priority。
2. **再对行为清单**：拿上表逐项对照私有 `AssistantMarkdown` 的行为（reasoning 折叠、
   streaming markdown、工具调用分发、图片、mentions、`revealProcess`）。
3. **最后端到端**：DOM 锚点 + 滚动 / 分组 / 折叠的用例回归；确认 ErrorBoundary 未触发
   （控制台不应出现 `[dsh-thinking-panel] render failed`）。

## 五、已知限制

- **耗时只在本次页面会话内测得**：页面加载后才开始的步骤能显示「（用时 X 秒）」，
  历史步骤不显示（官方是服务端持久化的）。
- **预览跟随最新内容**（`FOLLOW='tail'`）；官方字面行为是钉在开头
  （`StreamingSmoothScrollEffect` 把 offset 动画回 0），改一个常量即可切换。
- **思考结束后仍显示预览**（官方默认开启「自动折叠」只留标题）。这是有意保留的
  ——用户抱怨过 DSH 隐藏太多内容。
