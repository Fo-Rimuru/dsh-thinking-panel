# 启动一个**数据完全隔离**的 DSH 测试副本
#
# 用途：在浏览器里真实地点着测插件（设置页、面板、滑块……），而**不碰主环境**。
#   .\tools\dev-clone.ps1
#
# 隔离原理：DSH 用 `DSH_HOME` 决定数据目录（会话、插件数据、日志都在里面），
# 所以副本用另一个 home（默认 C:\Users\fongs\.dsh-test），会话列表、插件数据互不可见。
#
# 副本 profile 说明（`.dsh-test\profiles\dst-test`）：
#   - bundles = @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app  → 跑的是 Web UI，能浏览器访问
#   - cordis.patch.yml 只 insert 本插件一项
#   - node_modules 是 junction 指向主环境，所以**插件代码始终是最新的**（改完重启即可）
#
# 刷完代码后的用法：Ctrl+C 停掉，重新跑一遍本脚本。

param(
  [int]$Port = 19390,
  [string]$Profile = 'dst-test',
  [string]$CloneHome = 'C:\Users\fongs\.dsh-test'
)

$ErrorActionPreference = 'Stop'
$dsh = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
if (-not (Test-Path $dsh)) { throw "找不到 dsh：$dsh" }

# 端口若被上次的副本占着，先收掉
Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host "停止占用 $Port 的进程 PID $($_.OwningProcess)"
  Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
}

$env:DSH_HOME = $CloneHome

# 防呆：副本的 cordis.patch.yml 必须是**完整**配置（模型列表与提供源都在里面）。
# 调试「插件不激活」时曾把它精简成一行 insert 忘了恢复，结果副本里模型列表是空的（作者发现的）。
$patch = Join-Path $CloneHome "profiles\$Profile\cordis.patch.yml"
if (Test-Path $patch) {
  $size = (Get-Item $patch).Length
  if ($size -lt 5000) {
    Write-Warning "副本的 cordis.patch.yml 只有 $size 字节 —— 像是调试留下的精简版，模型列表/提供源会缺失。"
    Write-Warning "从主环境恢复即可：Copy-Item `"$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml`" `"$patch`" -Force"
  }
}

Write-Host "DSH_HOME = $CloneHome（与主环境隔离）"

# 确保副本的 patch 里有本插件的显式 insert。
# 主 profile **不含**这个条目 —— 插件是靠 package.json 的 `dsh.bundle.patch` 自动加载的，
# 而那个机制在副本 profile 下不生效（实测），所以副本必须自己插一条。
$marker = '# == dev-clone: 本插件显式插入 =='
if ((Test-Path $patch) -and ((Get-Content $patch -Raw) -notlike "*$marker*")) {
  Write-Host '副本 patch 缺少本插件条目，自动追加…'
  Add-Content -Path $patch -Encoding utf8 -Value @"

$marker
- insert:
    - id: thinking-panel
      name: 'dsh-thinking-panel'
      config:
        mode: auto
"@
}
Write-Host "profile  = $Profile"
Write-Host "启动后，终端会打印一个带 token 的 URL —— 用浏览器打开它即可。"
Write-Host ''

& $dsh --profile $Profile --port $Port --no-open
