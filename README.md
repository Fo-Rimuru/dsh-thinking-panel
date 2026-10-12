# dsh-thinking-panel · 深度思考面板

[English](README.en.md) | **中文**

**让 DSH 的思考链看起来像 DeepSeek 官方 App。**

中文提问就用中文思考；思考中显示多行滚动预览，展开能看到完整推理。

![思考中：多行滚动预览](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.gif)

## 它解决什么问题

DSH 出厂的思考链和官方客户端有五处不一样：

| | 出厂行为 | 装上之后 |
|---|---|---|
| **思考语言** | 系统提示词是英文，**中文提问也常常用英文思考**（实测 91%） | 注入推理语言规则，思考跟随你的语言 |
| **思考中预览** | 折叠态是**结构性单行**（`contain:size` + `nowrap`），只给你一行摘要 | 显示**完整推理正文**的 5 行滚动预览，自动跟随最新内容 |
| **展开** | 无高度约束，长推理只能靠整页滚动 | 自带高度受限容器与**可拖动的滚动条** |
| **细节** | 没有左侧竖线，没有耗时标题 | 竖线、品牌色图标、`深度思考中` / `已思考（用时 X 秒）` 全部对齐 |
| **看得见** | 桌面端默认「标准」：正在生成的过程被折叠进「过程组」，**要先点开才看得到** | **默认自动展开**过程组，思考链直接出现（可在设置里关掉） |

## 先说清楚限制

### 看不到思考链？

**先看这一条：0.1.1 起默认自动展开，装上就能看到。** 背景是 —— DSH 桌面端的
「工作步骤展示」默认是「标准」：正在生成的过程会被折叠进「过程组」，而本插件的面板就在那个组里，
出厂行为下要**先点开过程组**才看得到它（再点一次才展开全文）。

插件现在会在**正在生成**的那一轮自动帮你展开它：走的是官方自己的揭示通道
（组体上的 `beforematch` → `setOpen(true)`），不抢焦点、不直接改 DOM、不绕过 React 状态机；
万一那条通道在某个版本失效，才退回点击组头并把焦点还回去。
设置项在 **设置 → 通用 → 深度思考面板 → 自动展开过程组**，**默认打开**。

关掉它之后，"看不到思考链"就会回来 —— 那时把
**设置 → 通用设置 → 工作步骤展示模式** 改成 **详细** 即可：「详细」和「标准」在**运行中**的唯一
区别就是过程行不折叠。（已结束的轮次四种模式都会收起，那是 DSH 自己的设计，插件不去改写它。）

**语言跟随是提示词级约束，在重度 agent 会话里基本无效。**
干净短会话实测 CJK 0.399–0.607（对照组 0.000），但塞满英文工具输出的 agent 会话只有 **0.012**
—— 这不是实现问题，是模型上下文决定的固有上限，详见[已知限制](#已知限制)。

**面板样式不受此影响**，任何时候都生效。

## 效果

| 画面 | 说明 |
|---|---|
| ![思考中](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.png) | **思考中（折叠态）**：`深度思考中` + 5 行滚动预览 + 底部淡出遮罩 |
| ![展开态](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-expanded.png) | **展开态**：完整长推理 + 自带可拖动滚动条 |
| ![已思考](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-collapsed.png) | **思考结束**：`已思考，用时 23 秒`，折叠回摘要 |
| ![设置行](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-settings.png) | **设置 → 通用**：官方同款滑块开关 |

动图（原分辨率 2560×1440，点击可放大）：

- [`docs/preview-thinking.gif`](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.gif) —— 思考中滚动跟随（8 秒）
- [`docs/preview-expanded.gif`](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-expanded.gif) —— 折叠 → 展开 → 内容继续增长（8 秒）

## 安装

### npm（推荐）

```powershell
# dsh.cmd 在 <DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd（Windows）
$dsh = '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add dsh-thinking-panel
```

### 让 AI 帮你装

把下面这段整段复制给你的 AI（Claude / ChatGPT / DeepSeek，或者你自己的 DSH 都行）：

```text
请帮我在本机安装 DSH 插件 dsh-thinking-panel（深度思考面板）。

【这是什么】
一个 DSH 客户端插件，让 DSH 的思考链看起来像 DeepSeek 官方 App：
中文提问就用中文思考，思考中显示多行滚动预览，展开能看到完整推理。
项目主页：https://github.com/Fo-Rimuru/dsh-thinking-panel

【怎么装】
DSH 的插件安装命令只是把参数透传给 pnpm，格式是：
    dsh plugin --profile <profile名> add <包名或路径>

请按顺序做：
1. 找到 DSH 的 CLI。Windows 一般在
   <DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
   找不到就问我。
2. 确认要装进哪个 profile —— 一般是我平时在用的那个，目录在
   $DSH_HOME/profiles/<名字>（$DSH_HOME 通常是 ~/.dsh）
3. 执行安装：
   dsh plugin --profile <profile名> add dsh-thinking-panel
4. 重启 DSH。
5. 重启后帮我确认三件事：
   - 「设置 → 插件」里出现 dsh-thinking-panel[深度思考面板]
   - 「设置 → 通用」里出现「深度思考面板」一行（带开关）
   - 发一条中文消息，思考面板应有：左侧竖线、多行滚动预览、可展开

【出问题怎么办】
- 需要 DSH >= 0.2.0-rc.1
- 装完必须重启 DSH（Host 半部不热加载）
- 如果被拒绝安装，多半是 DSH 的版本兼容闸门，可以试
  dsh plugin allow-version 授予版本豁免后重试
- 装不上就把完整报错贴给我
```

### 从 GitHub 直装

```powershell
& $dsh plugin --profile desktop add 'github:Fo-Rimuru/dsh-thinking-panel'
# 锁定版本：
& $dsh plugin --profile desktop add 'github:Fo-Rimuru/dsh-thinking-panel#v0.1.1'
```

> 需要本机有 `git`。装的是**默认分支最新提交**，没有版本语义；更新要 `pnpm update`。

### 本地路径（开发用）

```powershell
& $dsh plugin --profile desktop add '<本仓库目录>'
```

pnpm 会写成 `link:` 依赖 —— 改源码即生效（Client 半部热加载，Host 半部需重启）。

也可以用 GUI：**设置 → 插件 → 安装本地包**，选中仓库目录。

### 装完怎么确认

1. **设置 → 插件** 里出现 `dsh-thinking-panel[深度思考面板]`
2. **设置 → 通用** 里出现「深度思考面板」一行，带官方同款滑块开关
3. 随便发一条中文消息，思考面板应有：左侧竖线、`深度思考中` 标题、多行滚动预览
4. 点标题行能展开，展开后内容可以独立滚动

> ⚠️ **Host 半部不热加载**：改完 `index.js` 必须**重启 DSH** 才会生效
> （实测：不重启时系统提示词里仍是旧版、也没有运行时上下文）。Client 半部会热加载。

### ⚠️ GitHub 直装失败怎么办

从 GitHub 地址安装时，pnpm 解析引用会跑 `git ls-remote`，而**它可能选用 SSH 协议**
（`git+ssh://git@github.com/...`）。机器上没配 SSH key 就会失败，报错通常是这两种之一：

```
Host key verification failed.                      ← 没有 known_hosts
git@github.com: Permission denied (publickey).     ← 有 known_hosts 但没 SSH key
```

**这条路偶尔会失败**：多数情况 pnpm 走 HTTPS 正常安装（实测 `https://github.com/Fo-Rimuru/dsh-thinking-panel`
和 `github:Fo-Rimuru/dsh-thinking-panel` 两种写法都成功、几秒完成），但它**有时**会改用 SSH 协议去解析引用，
没配 SSH key 的机器就会报上面两种错。**遇到失败时**：先重试一次，仍失败就按下面的办法处理。

**最稳妥的是 npm 通道**（完全不经过 git）：

```powershell
& $dsh plugin --profile desktop add dsh-thinking-panel
```

**如果你确实要走 GitHub**，让 git 把所有 SSH 形式的 GitHub 地址自动改写成 HTTPS ——
在 `~/.gitconfig` 里加：

```ini
[url "https://github.com/"]
	insteadOf = git+ssh://git@github.com/
	insteadOf = ssh://git@github.com/
	insteadOf = git@github.com:
```

改完之后 `github:owner/repo` 和完整 URL 都会走 HTTPS，不再需要 SSH key。
（也可以两种写法都试一下，哪个通用哪个。）

## 自动更新与回滚

> **DSH 官方目前不支持插件自动更新** —— 安装对话框里就写着「插件安装后，暂不支持自动更新。
> 若需升级，请先卸载再安装新版」。**本插件自带自更新，不需要卸载重装。**

插件自带自更新，入口就在 **设置 → 通用 → 深度思考面板** 那一行下面。

| 行为 | 说明 |
|---|---|
| **检查更新** | 查 npm registry 上的最新版；有新版本时显示 `v0.1.0 → v0.2.0` |
| **更新** | 下载 tarball → 校验 → **原子替换**（同目录 `rename`，要么旧内容要么新内容）→ 失败自动回滚 |
| **回滚** | 装回上一个版本，并把该版本记进 `holdVersion` —— **防止自动检查又把它装回来**（否则逃生门会自己关上） |
| **无感 vs 重启** | 只改 `client.js` 时**立即生效**；改到 `index.js` / `package.json` / `cordis.patch.yml` 会提示**重启 DSH**（Host 半部不热加载） |

**安全边界**（自更新是在改你自己的插件目录，所以这些必须说清楚）：

- **路径白名单**：只允许覆盖 `index.js`、`client.js`、`package.json`、`cordis.patch.yml`、`locale/*.json`；tarball 里其它文件（含 `../` 穿越）**一律拒绝**
- **写入前整体预检**：任何一个路径不合法就整体失败，**不会写一半**
- **符号链接防护**：`packageDir` 之下任意路径段是软链就拒绝写入（但 `packageDir` 自身允许是软链 —— 本插件常以 `link:` 安装）
- **下载限制**：60 秒超时、8 MB 上限
- **鉴权**：端点复用 DSH 的 `connection.requestRejection`，且变更类方法**只接受 POST**
- **`holdVersion`**：回滚过的版本不会再被自动提示更新

> ⚠️ **插件崩了、按钮点不到时**，用命令行回滚：
> ```powershell
> & $dsh plugin --profile desktop add dsh-thinking-panel@<上一个版本>
> ```

状态与备份存放在 `$DSH_HOME/plugin-data/dsh-thinking-panel/`（`update-state.json` + `update-backup/`）。

## 配置

`cordis.patch.yml` 的行配置支持 `mode`：

| mode | 行为 |
|---|---|
| `auto`（默认） | 跟随用户语言 |
| `zh` | 强制中文思考 |
| `en` | 强制英文思考 |
| `off` | 不注入任何段落（仅保留样式） |

## 已知限制

**先说不好听的**，这样你装之前就知道能期待什么：

- **语言跟随是概率性的，而且在重度 agent 会话里基本无效**。它是提示词级约束，不是模型原生行为：
  干净短会话实测 CJK 0.399–0.607（对照组 0.000），但**塞满英文工具输出的 agent 会话实测只有 0.012**。
  详见下文 [Host 半部](#host-半部indexjs语言跟随)。
- **思考耗时只在本次页面会话内测得**：页面加载后才开始的步骤能显示「（用时 X 秒）」，
  历史步骤不显示（官方是服务端持久化的）。
- **展开态的高度上限是自加的非官方行为**（官方展开态无约束），为可用性而加，可一键关闭。
- **预览跟随方向与官方相反**：官方流式时把滚动位置拉回**顶部**，本插件默认跟随**最新内容**。
  这是刻意的取舍（尾部跟随更像「正在思考」），改一个常量即可切回。
- **官方 Lottie 思考环动画未实现**（本插件用静态图标）。
- **遮蔽 `assistant-step` 意味着接管整条 assistant 消息**：DSH 升级后出厂新增的块类型或行为
  需要跟着复刻，请按 [`docs/遮蔽assistant-step-维护清单.md`](docs/遮蔽assistant-step-维护清单.md) 回归。

---

## 工作原理

### Host 半部（`index.js`）—— 语言跟随

在每一步模型请求前注入语言规则，**走两个通道**：

```js
// ① 系统提示词段落：排在整份系统提示词的最末
//    （SECTION_ORDER = 10300 > DEPLOYMENT_PERSONA_SUFFIX 10200）
ctx.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text });

// ② 运行时上下文：既进日志、又紧贴用户回合，离生成点最近 —— 实测决定成败的就是它
//    （CONTEXT_ORDER = 130 > SUBAGENT_DELEGATION 120）
ctx.systemPrompt.context({ name: CONTEXT_NAME, order: CONTEXT_ORDER, text: shortReminder });
```

**为什么需要它**：DSH 的系统提示词是英文（实测 7,822 字符，中文占比 0.9%–3.1%），
模型据此把「工作语言」判为英文，于是中文提问也会用英文思考。
本机 34 个会话、3,353 个推理步的实测：中文提问时思考为中文的仅 **3.3%**，**91% 变成英文**。

**只有系统提示词段落是不够的（实测教训）**：段落确实进了提示词，但推理**仍是英文**
（同一提示词实测 CJK 0.096）。把规则同时放进**运行时上下文**后才真正生效。

#### 受控 A/B（同一提示词、全新会话，唯一变量是插件 mode）

| 提问语言 | mode | 运行时上下文 | 推理块 | 平均 CJK | 判定 |
|---|---|---|---|---|---|
| 中文 | **off**（对照） | ❌ | 5 | **0.000** | 英文 ✗ |
| 中文 | auto | ✅ | 4 | **0.399** | 中文 ✓ |
| 中文 | auto | ✅ | 1 | **0.607** | 中文 ✓ |
| 英文 | auto | ✅ | 20 | **0.001** | 英文 ✓ |
| 中文 | auto（仅段落，旧版） | ❌ | 1 | 0.096 | 英文 ✗ |

#### ⚠️ 但它**在重度 agent 会话里会失效**（真实会话实测）

在开发会话（2860 个事件、大量英文工具输出）里，规则**确实注入了**，但推理语言**没有变化**：

| 阶段 | 推理块 | 平均 CJK |
|---|---|---|
| 规则生效前 | 308 | 0.014 |
| 规则生效后（重启后，上下文已确认注入） | 4 | **0.012** |

**结论（重要）**：这是**提示词级约束**，不是模型原生行为。它在**干净、短、以对话为主**的会话里有效
（0.4–0.6），但在**塞满英文工具输出 / 代码 / 命令结果**的 agent 会话里会被淹没。

官方 App 之所以稳定，是因为它的上下文**天然干净**——只有系统提示词 + 用户那一句话。
DSH 的 agent 会话不具备这个条件，所以「完全等同官方」在重度 agent 用法下**靠提示词做不到**。

**所以「移植」的正确做法是提示词，而不是翻译**：思考语言由模型侧决定，
在渲染层做翻译只会得到一个假的「中文思考」。

复现方式（用完即弃的 `headless` profile，走第三方 provider 不耗官方额度）：

```powershell
& $dsh plugin --profile headless add '<本仓库目录>'
& $dsh headless --patch tools\ab-provider-opencode-go.yml "用中文问一个需要多步推理的问题…"
& $dsh headless --patch tools\ab-provider-opencode-go.yml --patch tools\ab-mode-off.yml "同一提示词"
```

> `tools\ab-provider-opencode-go.yml` 里的 `apiKeyEnv: OPENCODE_GO_API_KEY` 需要你自己提供该
> 环境变量；它只是一个**示例 provider**，换成任何你已有的 provider 都能复现同一组对照。

### Client 半部（`client.js`）—— 自绘思考面板

**不再针对出厂类名做 CSS 覆盖**，而是遮蔽 `conversation.chat.node` 的 `assistant-step`
键，自己完整渲染 assistant 消息：

```js
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node',
  key: 'assistant-step',
  priority: -1,          // ★ 出厂占 priority 0；运行时要求「换一个优先级，数值最低者渲染」
}, (slotProps) => h(DeepSeekAssistantStep, { ...slotProps, pluginT: t })));
```

| 能力 | 实现 |
|---|---|
| 思考中预览 | **完整推理文本**铺进可滚动窗口，高度上限对齐官方观感：**5 行** |
| 展开 | 点标题行展开完整 Markdown 推理，`useDisclosure` 跟随 Turn 重置；**自带高度受限的滚动容器与可拖动滚动条**（`BODY_MAX = min(60vh, 640px)`） |
| 竖线 / 图标 / 配色 / 标题 / 耗时 | 自绘，全部用主题令牌，类名自带 `dst-` 前缀 |
| 出厂行为复刻 | `groupPart` 双向过滤、`tool-call` 跳过、连续图片合并、`fileMentions`、空 blocks → null |
| 折叠锚点 | `div[data-turn-process-inline]` + `hidden="until-found"` + `beforematch` 揭示 |
| Markdown 装饰 | 完整 `markdownLabels` 形状（`code.{copyLabel,copiedLabel,toolbarLabels}` + `footnotes`） |
| 错误兜底 | ErrorBoundary → 纯文本兜底，**绝不整行空白** |
| 降级 | `ui-primitives` 取不到时纯文本渲染，不抛错 |

> ⚠️ 槽目录里「重复 key 会替换占位者」的说法**不完整**：运行时实际要求换一个优先级，
> 且**数值最低者渲染**。同 key 同 priority 会直接抛错。详见维护清单第一节。

### 动机：出厂折叠态是「结构性单行」

DSH 出厂实现里，折叠态是**结构性**的单行（`ReasoningRow.module.css`）：

```css
._root:not([data-expanded]){contain:size layout;height:calc(24px + Δ)}  /* 固定一行高 */
._summary{white-space:nowrap}                                          /* 禁止换行 */
._summaryText{text-overflow:ellipsis}                                  /* 溢出省略号 */
```

外加 JS 侧 `latestCompletedParagraphFirstLine()` 只取「最新一段的首行」作为摘要，
所以肉眼看到的就是一行、且只有个大概。

**注意**：这一段只回答「出厂折叠态为什么是一行」—— 就 `ReasoningRow` 自己的折叠态而言，
四种模式渲染的确实是同一行摘要，`settledReasoningPreview` 只决定思考**结束后**要不要保留它。

**但「工作步骤展示」确实会决定「你能不能看到本插件的面板」**：四种模式除 `settledReasoningPreview`
外还切 `stepGrouping`（`collapsed` / `history` / `none`）与 `foldCompletedTurns`。
本插件的面板渲染在 `reasoning` 分组里、属于出厂「过程组」的成员，所以在「简洁 / 标准」下
会被收起的过程组挡住。见 [看不到思考链？](#看不到思考链)。

### 两条路，以及为什么选了后者

| 做法 | 结果 |
|---|---|
| **① CSS 覆盖**：解除 `contain:size`、放开 `nowrap`、给摘要加 `-webkit-line-clamp` | 能做出多行，但**拿不到完整推理正文**：摘要文本由出厂 JS `latestCompletedParagraphFirstLine()` 算好，CSS 只能把**那一行摘要**折成多行，还要对抗 `TextShimmer` 的 `inline-grid` / `flex` 原子盒 |
| **② 遮蔽 `assistant-step` 渲染器**（**本插件采用**） | 直接拿到 `block.text` 完整推理正文，预览、展开、竖线、标题、耗时全部自绘；代价是必须自行复刻出厂的全部行为（见 [维护清单](docs/遮蔽assistant-step-维护清单.md)） |

早期原型走过 ①：当时的 CSS 是
`[data-variant="think"][data-state="running"]{contain:layout;height:auto}` 加
`[class*="_summaryText"]{-webkit-line-clamp:3}`，并要把 `TextShimmer.root`
（`display:inline-grid;width:max-content`，原子内联盒不参与换行）和 `TextShimmer.content`
（`display:flex`）都改成块级。这条路最终被放弃 —— 原因就是上表左栏那条：
**它能改变换行，但拿不到正文**。

#### 历史记录：当初凭什么断定「出厂是结构性单行」

方案① 阶段曾有一套离线对照页工具（`build-preview.mjs` / `preview.html` /
`check-tokens.mjs` / `preview-server.mjs`）和一张验证截图。做法是：从 DSH 出厂源码里
**逐字提取** `ReasoningRow` / `TextShimmer` / `DisclosureRow` 的原始 CSS，配上出厂 DOM 结构，
在真实 Edge 里渲染。它验证了两件事 —— **(a)** 出厂折叠态确实是结构性单行
（`contain:size` + `nowrap` + `ellipsis` 三重锁定）；**(b)** 主题令牌的两层链路
（原语层 `--dsw-static-*` → 别名层 `--dsw-alias-*`）都能解析。

**这些文件已在开源前移除**：它们只对方案① 有意义，而 `build-preview.mjs` 是按旧的
`[...].join('')` 形式从 `client.js` 提取 CSS 的，与方案② 的模板字符串实现不再兼容
（实测会抛 `未能从 client.js 提取 CSS 数组`）。留着只会让访客运行到一个报错。

如果你要复现当时的验证，步骤是：解包 DSH 的 `app.asar` → 从 `ui-chat-client.js` 里取出
`ReasoningRow` 的 CSS → 从 `ui-theme-client.js` 里取出两层令牌定义 → 按出厂 DOM 结构
拼一个静态页在浏览器里打开。不过上面「动机」一节的那三个 CSS 事实就是那次验证的结论，
**不依赖任何工具也能直接读懂**。

### 为什么预览是 5 行

折叠态预览取 **5 行**，是照着官方客户端的观感定的：官方流式预览的可视高度大约是
「5 行正文 + 一点底部余量」，超过就滚动，不会无限撑高。

插件里对应 `PREVIEW_LINES = 5`，高度上限写成

```css
max-height: calc(110px + var(--dsh-content-font-delta-secondary,0px) * 5)
```

（DSH 摘要行高 = `20px + delta-secondary`，故 `5×20 + 10 = 110px`。）

**改行数只需要改这一个常量** —— `PREVIEW_LINES` 同时驱动 CSS 里的 `110px` 与 `* 5`。

### 官方是「滚动」而不是静态截断

官方的折叠预览是一个**可滚动窗口**，而且流式时滚动位置会被动画**拉回顶部**，
所以用户稳定看到的是**思考文本开头的 5 行**（想往下看可以手动滚），
底部还有一个随「能否滚动」出现的淡出提示。

**展开态则完全没有行数或高度约束** —— 5 行上限只存在于流式预览，
这就是「展开后更详细」的原因。

> ⚠️ **竖线颜色说明**：官方 Web 端用的是 `--dsw-alias-label-dimmed`，它在浅色主题下解析为
> **`#e1e5ee`**（底色 `#fff`）——这是一条**极淡的引导线，官方本身就是这个观感**。
> 插件默认忠实沿用该令牌。如果你希望它更明显，把 `client.js` 的 CSS 里那行
> `border-left:1px solid var(--dsw-alias-label-dimmed)` 换成
> `var(--dsw-alias-label-caption)`（`#adb2b8`）即可。
>
> 另注：`--dsw-alias-brand-primary` 在浅色主题下解析为 `#0f1115`（近黑），
> 所以思考图标是近黑色而非蓝色——这与官方设计系统一致。

> ⚠️ **与官方剩余的两处差异**（诚实说明）：
>
> **① 跟随方向相反**：官方流式时把滚动位置动画回**顶部**；本插件默认 `FOLLOW = 'tail'`，
> 跟随**最新内容**。这是刻意的可用性取舍（尾部跟随更像「正在思考」），改一个常量即可切回。
>
> **② 展开态有高度上限**：官方展开态**没有任何行数或高度约束**；本插件加了
> `BODY_MAX = min(60vh, 640px)` 的内部滚动容器 —— 否则长推理只能靠整页滚动、
> 面板里没有可拖动的滚动条（用户实测反馈）。想恢复官方行为就把它设为 `'none'`。

> ⚠️ **为什么文案用 CSS 而不是 locale**：`ctx.locale.register()` 对已存在的语言直接抛错
> （`locale namespace "chat" already has locale "zh"`），所以无法覆盖 `message.think`。
> 这是官方设计，不是 bug。

### 关于 `peerDependencies`：DSH 的兼容性闸门（实测）

DSH 在安装插件时会校验插件的 `peerDependencies`，不匹配会**拒绝安装并回滚**
（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）。在 DSH `0.2.0-rc.2` 上实测的规则：

| 规则 | 实测 |
|---|---|
| 校验范围 | **只校验 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`**；`@deepseek-ai/cordis`、`react` 等**不参与判定** |
| 判定式 | `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`，`runtimeVersion` 取 `@deepseek-ai/dsh-app-boot` 的版本 |
| ⚠️ 易踩的坑 | **必须带 prerelease 标记**：`^0.2.0-rc.1` 匹配 `0.2.0-rc.2`（✓），而 `^0.2.0` **不匹配**（✗）—— node-semver 的 prerelease 规则 |
| 不匹配时 | 提示用 `dsh plugin allow-version`（或插件管理器）授予**精确版本豁免**后重试 |

本插件声明 `@deepseek-ai/dsh-*: ^0.2.0-rc.1`，在 `0.2.0-rc.2` 上判定通过。

---

## 升级 DSH 后插件失效怎么办

DSH 升级后最常见的是**被兼容性闸门拦下**（见上一节的 `peerDependencies` 规则）。按顺序试：

**① 先看是不是版本区间不匹配**

报错信息里会写明是哪个 peer 不匹配。如果只是版本区间太旧（例如 DSH 升到了 `0.3.0`），
可以授予**精确版本豁免**：

```powershell
& $dsh plugin allow-version            # 按提示操作，或见插件管理器里的「版本豁免」
```

然后在**设置 → 插件**里重新启用，或重启 DSH。

**② 是不是遮蔽失效了（样式回到出厂的样子）**

打开 F12 → Console，搜 `dsh-thinking-panel`：

| 控制台信息 | 含义 | 处理 |
|---|---|---|
| `could not shadow assistant-step; shipped renderer stays` | 遮蔽注册被拒（出厂改了 priority 机制） | 提 [Issue](https://github.com/Fo-Rimuru/dsh-thinking-panel/issues)，附上 DSH 版本 |
| `[dsh-thinking-panel] render failed, falling back to plain text` | 渲染抛错，已降级为纯文本 | 提 Issue，把报错栈一起贴上 |
| 什么都没有，但样式就是没变 | 可能插件没被加载 | 看**设置 → 插件**里在不在，在的话重启一次 |

**③ 自查这几条**（能直接定位到具体环节）

- 页面里有没有 `.dst-think` 元素？（有 = 遮蔽生效）
- 改过 `index.js` 之后重启过 DSH 吗？（Host 半部不热加载）
- `ui-primitives` 是否可用？（不可用会整体降级为纯文本）

**④ 实在不行先回滚**：`& $dsh plugin --profile desktop add dsh-thinking-panel@<上一个版本>`

升级回归的完整清单在 [`docs/遮蔽assistant-step-维护清单.md`](docs/遮蔽assistant-step-维护清单.md)。

## 反馈与贡献

- **遇到问题 / 想要新功能**：[开一个 Issue](https://github.com/Fo-Rimuru/dsh-thinking-panel/issues)
  —— Bug 模板会引导你填 DSH 版本、控制台输出和几条自查项，这几项能省掉好几轮来回
- **Pull Request**：欢迎。改完请先跑 `node tools/verify.mjs`（见下），确保 174 项通过
  （准备了出厂源码副本则是 197 项）
- **提问也是 Issue**：选 Bug 模板即可，问题可搜索、可追溯，别人遇到同样情况能直接搜到
- **已排期但还没做的改动**：见 [`docs/ROADMAP.md`](docs/ROADMAP.md)（0.2.0 待办：注入开关、
  自动更新开关、一键回退入口、设置独立成一栏）

> 提 Issue 前建议先看一眼 [已知限制](#已知限制) —— 「语言跟随在重度 agent 会话里无效」
> 这类是**已知的固有上限**，不是 bug。

## 自检

```powershell
# 197 项契约自检：Host 半部的 PromptSection 契约与四种 mode；Client 半部的模块注册、
# locale、三个 slot 条目、<style> 内容；并真实渲染 assistant-step 组件树
# （分组过滤 / tool-call / 图片合并 / 错误边界 / 滚动跟随 / 空 blocks / 官方 Switch /
#   自动展开过程组：beforematch 通道、焦点兜底、已结束轮次不插手、开关默认打开）
node tools\verify.mjs
#   无出厂源码时 → 174 passed, 0 failed, 23 skipped
#   有出厂源码时 → 194 passed, 0 failed, 3 skipped
#   再提供槽目录 → 197 passed, 0 failed
```

其中 23 项是「回查 DSH 出厂源码」的交叉比对，需要你自己准备一份解包副本才会执行：

```powershell
$env:DSH_SRC_DIR = '<含 ui-chat-client.js / ui-theme-client.js 的目录>'
$env:DSH_SLOT_CATALOG = '<Slots.listSubTree 的导出文本>'   # 只有 keyed 槽语义那 3 项需要
node tools\verify.mjs
```

缺材料时这些断言记为 **SKIP**（不计入失败、退出码仍为 0），所以别人 clone 下来直接跑不会红，
也不会把「没材料」伪装成「已通过」。

**自更新模块另有一套单元测试**（不联网、不碰真实插件目录，全部在临时目录里跑）：

```powershell
node tools\test-self-update.mjs
#   → 46 passed, 0 failed
#   覆盖：semver 比较（含 prerelease 规则）、路径白名单与穿越攻击、
#        tar 解析、原子写入、回滚正确性、越界时整体拒绝
```

CI 也会跑这两项（[`.github/workflows/verify.yml`](.github/workflows/verify.yml)），
所以每次 push 都会看到那 174 项（无出厂源码时）是否通过。

## 卸载

**设置 → 插件** 里移除即可；插件不写任何 DSH 核心文件、不改会话日志。
开关状态存在 `localStorage`：`dsh-thinking-panel.enabled`（总开关）与
`dsh-thinking-panel.auto-reveal-process`（自动展开过程组，默认打开）。

## 许可

MIT © [Fo-Rimuru](https://github.com/Fo-Rimuru)
