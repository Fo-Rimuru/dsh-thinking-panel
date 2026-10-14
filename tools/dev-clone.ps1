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
Write-Host "DSH_HOME = $CloneHome（与主环境隔离）"
Write-Host "profile  = $Profile"
Write-Host "启动后，终端会打印一个带 token 的 URL —— 用浏览器打开它即可。"
Write-Host ''

& $dsh --profile $Profile --port $Port --no-open
