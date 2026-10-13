# dsh-thinking-panel

[中文](README.md) | **English**

**Makes DSH's thinking chain look like the DeepSeek official app.**

Ask in Chinese, think in Chinese; watch a multi-line scrolling preview while it thinks, and expand it to read the full reasoning.

![Thinking — multi-line scrolling preview](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.gif)

## What it solves

DSH's shipped thinking chain differs from the official client in five ways:

| | Shipped behaviour | With this plugin |
|---|---|---|
| **Reasoning language** | The system prompt is English, so **Chinese questions are often reasoned in English** (91% measured) | A reasoning-language rule is injected; reasoning follows your language |
| **Preview while thinking** | The collapsed state is a **structural single line** (`contain:size` + `nowrap`) — you get one summary line | The **full reasoning text** in a 5-line scrolling preview, auto-following the newest content |
| **Expanding** | No height constraint; long reasoning means scrolling the whole page | A height-capped container with its own **draggable scrollbar** |
| **Details** | No left rail, no duration title | Rail, brand-coloured icon, `Thinking` / `Thought for Xs` — all matched |
| **Visibility** | Desktop defaults to "Standard": the running process folds into a "process group" — **you have to open it first** | The process group is **auto-expanded** while a turn runs (can be switched off) |

## Honest limitations first

### Can't see the thinking chain?

**Read this first: since 0.1.1 it is auto-expanded — it works out of the box.** The background: DSH on
desktop defaults to "Standard", which folds the running process into a "process group", and this
plugin's panel lives inside that group — so shipped behaviour requires you to **open the process group
first** (and click once more for the full text).

The plugin now expands it for you **while a turn is running**, through DSH's own reveal channel
(`beforematch` on the group body → `setOpen(true)`): it does not steal focus, does not touch the DOM
directly and does not bypass React's state machine. Only if that channel ever breaks does it fall back
to clicking the group header — and restoring focus afterwards. The switch lives in
**Settings → General → Thinking Panel → Auto-expand the process group** and is **on by default**.

Turn it off and the old behaviour returns; then set
**Settings → General → Work details** to **Detailed** — while a turn is running, that is the only
difference from Standard. (Settled turns are folded in all four modes; that is DSH's own design and the
plugin does not rewrite it.)

**Language following is a prompt-level constraint and is effectively useless in heavy agent sessions.**
Clean short conversations measured CJK 0.399–0.607 (control group 0.000), but an agent session stuffed with
English tool output measured only **0.012** — this is an inherent limit set by the model's context, not an
implementation bug. See [Known limitations](#known-limitations).

**The panel styling is unaffected by this** and works at all times.

## Screenshots

| | |
|---|---|
| ![Thinking](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.png) | **While thinking (collapsed)**: `Thinking` + 5-line scrolling preview + bottom fade |
| ![Expanded](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-expanded.png) | **Expanded**: full reasoning with its own draggable scrollbar |
| ![Settled](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-collapsed.png) | **Settled**: `Thought for 23s`, collapsed back to a summary |
| ![Settings](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-settings.png) | **Settings → General**: the official-style switch |

Animated (native 2560×1440, click to enlarge):

- [`docs/preview-thinking.gif`](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-thinking.gif) — preview following new content (8s)
- [`docs/preview-expanded.gif`](https://raw.githubusercontent.com/Fo-Rimuru/dsh-thinking-panel/main/docs/preview-expanded.gif) — collapse → expand → content keeps growing (8s)


## Install

**From npm (recommended)**

```powershell
# dsh.cmd lives at <DSH install dir>\resources\runtime\cli\bin\dsh.cmd on Windows
$dsh = '<DSH install dir>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add dsh-thinking-panel
```

**Let your AI install it for you**

Copy the whole block below to your AI (Claude / ChatGPT / DeepSeek, or your own DSH):

```text
Please install the DSH plugin dsh-thinking-panel (Thinking Panel) on this machine.

【What it is】
A DSH client plugin that makes DSH's thinking chain look like the DeepSeek official
app: ask in Chinese and it thinks in Chinese, a multi-line scrolling preview while
thinking, and expandable full reasoning.
Homepage: https://github.com/Fo-Rimuru/dsh-thinking-panel

【How to install】
The DSH plugin command just forwards its arguments to pnpm:
    dsh plugin --profile <profile-name> add <package-or-path>

Please do this in order:
1. Locate the DSH CLI. On Windows it is usually
   <DSH install dir>\resources\runtime\cli\bin\dsh.cmd
   If you cannot find it, ask me.
2. Work out which profile to install into — normally the one I use day to day; its
   directory is $DSH_HOME/profiles/<name> ($DSH_HOME is usually ~/.dsh).
3. Install:
   dsh plugin --profile <profile-name> add dsh-thinking-panel
4. Restart DSH.
5. After the restart, confirm three things for me:
   - Settings → Plugins lists dsh-thinking-panel[Thinking Panel]
   - Settings → General shows a "Thinking Panel" row with a switch
   - Send a message: the thinking panel should show a left rail, a multi-line
     scrolling preview, and expand when clicked

【If something goes wrong】
- Requires DSH >= 0.2.0-rc.1
- DSH must be restarted after installing (the host half does not hot-reload)
- If the install is refused, it is most likely DSH's version compatibility gate;
  try `dsh plugin allow-version` to grant a version exemption, then retry
- If it still fails, paste the full error back to me
```

**Straight from GitHub**

```powershell
& $dsh plugin --profile desktop add 'github:Fo-Rimuru/dsh-thinking-panel'
# pin a version:
& $dsh plugin --profile desktop add 'github:Fo-Rimuru/dsh-thinking-panel#v0.1.1'
```

> Requires `git`. Installs the latest commit on the default branch — no version semantics;
> update with `pnpm update`.

**From a local path (development)**

```powershell
& $dsh plugin --profile desktop add '<path to this repo>'
```

pnpm records a `link:` dependency, so source edits take effect immediately
(the client half hot-reloads; the host half needs a DSH restart).

You can also use the GUI: **Settings → Plugins → Install local package**.

**Confirm it worked**

1. **Settings → Plugins** lists `dsh-thinking-panel[Thinking Panel]`
2. **Settings → General** shows a "Thinking Panel" row with the official-style switch
3. Send any message — the thinking panel should show a left rail, a `Thinking` title and a
   multi-line scrolling preview
4. Clicking the title row expands it, and the expanded body scrolls independently

> ⚠️ **The host half does not hot-reload.** After editing `index.js` you must **restart DSH**
> (measured: without a restart the old prompt section is still in effect and the runtime context
> is missing entirely). The client half does hot-reload.

### ⚠️ If installing from GitHub fails

When installing from a GitHub URL, pnpm resolves the reference with `git ls-remote`, and
**it may pick the SSH protocol** (`git+ssh://git@github.com/...`). On a machine without an
SSH key this fails with one of:

```
Host key verification failed.                      # no known_hosts
git@github.com: Permission denied (publickey).     # known_hosts present, no key
```

**This path occasionally fails**: most of the time pnpm uses HTTPS and installs fine (both
`https://github.com/Fo-Rimuru/dsh-thinking-panel` and `github:Fo-Rimuru/dsh-thinking-panel`
were measured working in a few seconds), but it *sometimes* resolves the reference over SSH,
and a machine with no SSH key then reports one of the errors above. **On failure**: retry once;
if it still fails, use the advice below.

**The npm channel is the most reliable** (it never touches git):

```powershell
& $dsh plugin --profile desktop add dsh-thinking-panel
```

**If you do want to use GitHub**, make git rewrite every SSH-form GitHub address to HTTPS by
adding this to `~/.gitconfig`:

```ini
[url "https://github.com/"]
	insteadOf = git+ssh://git@github.com/
	insteadOf = ssh://git@github.com/
	insteadOf = git@github.com:
```

After that, both `github:owner/repo` and full URLs go over HTTPS and no SSH key is needed.

## Self-update and rollback

> **DSH does not support automatic plugin updates yet** — its install dialog says as much
> ("Installed plugins do not update automatically yet. To upgrade a plugin, uninstall it and
> install the new version."). **This plugin updates itself; no uninstall/reinstall needed.**

The plugin updates itself; the controls live in **Settings → Thinking Panel** (its own entry in the
settings sidebar).

| Action | Behaviour |
|---|---|
| **Check for updates** | Queries npm for the latest version; shows `v0.1.0 → v0.2.0` when one exists |
| **Update** | Downloads the tarball → verifies → **atomically replaces** files (same-directory `rename`: readers see either the old or the new content) → rolls back automatically on failure |
| **One-click rollback** | Returns to the **previously installed** version (not "the running version" — after a restart that is a no-op), and holds it so the auto-check will not install it again |
| **Automatic updates** | On by default: eight seconds after DSH starts it checks silently and installs. Switchable in settings |
| **Roll back** | Reinstalls the previous version and records it in `holdVersion` — so the automatic check **will not offer it again** (otherwise the escape hatch would close itself) |
| **Seamless vs. restart** | A `client.js`-only change takes effect **immediately**; touching `index.js` / `package.json` / `cordis.patch.yml` prompts a **DSH restart** (the host half does not hot-reload) |

**Safety boundaries** (this rewrites your own plugin directory, so they matter):

- **Path whitelist**: only `index.js`, `client.js`, `package.json`, `cordis.patch.yml` and `locale/*.json` may be overwritten; anything else in the tarball — including `../` traversal — is refused
- **Whole-batch pre-check**: one illegal path fails the entire operation, so it never writes half a payload
- **Symlink protection**: any path segment *below* `packageDir` that is a symlink is refused (but `packageDir` itself may be a symlink — this plugin is commonly installed via `link:`)
- **Download limits**: 60 s timeout, 8 MB cap — enforced **while streaming** (cut off the moment it is exceeded, not after reading the whole response)
- **Concurrency lock**: if the desktop app and the Web GUI press "Update" at the same time, the second one is refused instead of the writes interleaving
- **Authentication**: the endpoint reuses DSH's `connection.requestRejection`, and mutating methods accept **POST only**
- **`holdVersion`**: a version you rolled back from is never offered again (both `check` and `status` account for it)

> ⚠️ **If the plugin itself breaks and the button is unreachable**, roll back from the CLI:
> ```powershell
> & $dsh plugin --profile desktop add dsh-thinking-panel@<previous version>
> ```

State and backups live in `$DSH_HOME/plugin-data/dsh-thinking-panel/` (`update-state.json` + `update-backup/`).

## Configuration

### Settings page (recommended)

**Settings → Thinking Panel** holds four switches: plugin master switch, "reason in the language of
the question", auto-expand the process group, and automatic updates. The injection switch is on by
default — turn it off to go back to the shipped English reasoning (more reliable on some tasks).

### `cordis.patch.yml` (advanced: force a language)

The row's `mode` only provides the **first-run default**; once you change it in settings, the state
file (`$DSH_HOME/plugin-data/dsh-thinking-panel/settings.json`) wins.

| mode | Behaviour |
|---|---|
| `auto` (default) | Follow the user's language |
| `zh` | Always think in Chinese |
| `en` | Always think in English |
| `off` | Inject nothing (styling only — self-update and the settings page keep working) |

## Known limitations

**The honest list** — read this before installing so you know what to expect:

- **Language following is probabilistic, and effectively useless in heavy agent sessions.** It is a
  prompt-level constraint, not native model behaviour: clean short conversations measured CJK 0.399–0.607
  (control group 0.000), but in an agent session **stuffed with English tool output it measured only 0.012**.
- **Thinking duration is only measured within the current page session.** Steps that started after the
  page loaded show "for Xs"; historical steps do not (the official client persists it server-side).
- **The expanded-state height cap is a non-official addition** (the official expanded state has no
  constraint). It exists for usability and can be turned off with one constant.
- **The preview follows the opposite end from the official client.** The official one animates the
  scroll position back to the **top**; this plugin defaults to following the **newest content**.
- **The official Lottie thinking-ring animation is not implemented** (a static icon is used).
- **Shadowing `assistant-step` means taking over the entire assistant message.** When DSH adds new
  block kinds or behaviours, they have to be mirrored — see
  [`docs/遮蔽assistant-step-维护清单.md`](docs/遮蔽assistant-step-维护清单.md) (Chinese) for the
  upgrade regression checklist.

## How it works (short version)

- **Host half (`index.js`)** injects a reasoning-language rule before every model request, through
  **two** channels: a prompt *section* ordered last (`order: 10300`) and a runtime *context*
  (`order: 130`) that sits right next to the user turn. The section alone is not enough — measured
  CJK stayed at 0.096 with the section only, and only rose to 0.399–0.607 once the runtime context
  was added as well.
- **Client half (`client.js`)** shadows the `assistant-step` key of the `conversation.chat.node` slot
  with `priority: -1` (the shipped renderer registers at priority 0; **the lowest priority renders**,
  and registering at the *same* priority throws). It then re-draws the whole assistant message,
  reproducing the shipped behaviours it takes over: `groupPart` filtering, skipping `tool-call`
  blocks, merging consecutive images, `fileMentions`, empty blocks → `null`, the
  `data-turn-process-inline` + `hidden="until-found"` + `beforematch` searchable-collapse contract,
  and the complete `markdownLabels` shape.

**The full write-up — including the controlled A/B tables, the two failed approaches, the 5-line
rationale and every measured caveat — is in the Chinese README: [README.md](README.md).**
It is the authoritative document; this English file is a summary.

## If the plugin breaks after a DSH upgrade

DSH validates a plugin's `peerDependencies` and **refuses to install (rolling back) when they do not
match**. Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` are checked, using
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.

1. **Version range too old?** Grant an exact-version exemption:
   `& $dsh plugin allow-version`, then re-enable or restart DSH.
2. **Styling reverted to the shipped look?** Open F12 → Console and search `dsh-thinking-panel`:
   - `could not shadow assistant-step; shipped renderer stays` → the shadow registration was rejected
   - `[dsh-thinking-panel] render failed, falling back to plain text` → rendering threw, now degraded
   - nothing at all, but styling is unchanged → the plugin may not be loaded; check Settings → Plugins
3. **Quick self-checks**: is there a `.dst-think` element in the page? Did you restart DSH after
   editing `index.js`? Is `ui-primitives` available?
4. **Roll back**: `& $dsh plugin --profile desktop add dsh-thinking-panel@<previous version>`

## Feedback

- **Bugs and feature requests**: [open an issue](https://github.com/Fo-Rimuru/dsh-thinking-panel/issues).
  The bug template asks for your DSH version, console output and a few self-checks — those save
  several rounds of back-and-forth.
- **Pull requests** are welcome. Please run `node tools/verify.mjs` first and keep all 201 checks green (224 with a DSH source copy).
- **Planned but not built yet**: see [`docs/ROADMAP.md`](docs/ROADMAP.md) (0.2.0: injection toggle,
  auto-update toggle, one-click rollback entry, settings as its own section).
- Please skim [Known limitations](#known-limitations) before filing — things like "language following
  does nothing in heavy agent sessions" are known inherent limits, not bugs.

## Self-check

```powershell
node tools/verify.mjs
#   without DSH source → 201 passed, 0 failed, 23 skipped
#   with DSH source    → 221 passed, 0 failed, 3 skipped
```

The 23 skipped ones cross-check the plugin against DSH's shipped source; supply an unpacked copy via
`DSH_SRC_DIR` (and `DSH_SLOT_CATALOG` for three slot-semantics checks) to run them. Missing material
is reported as **SKIP** — never as a pass, and never as a failure.

**The self-update module has its own unit tests** (no network, no touching the real plugin directory —
everything runs in a temp dir):

```powershell
node tools/test-self-update.mjs
#   → 56 passed, 0 failed
#   covers: semver comparison (incl. prerelease rules), path whitelist and traversal attacks,
#           tar parsing, atomic writes, rollback correctness, whole-batch rejection on bad paths
```

CI runs both on every push ([`.github/workflows/verify.yml`](.github/workflows/verify.yml)).

## Uninstall

Remove it in **Settings → Plugins**. The plugin writes no DSH core files and no session logs.
Its on/off state lives in `localStorage['dsh-thinking-panel.enabled']`.

## License

MIT © [Fo-Rimuru](https://github.com/Fo-Rimuru)
