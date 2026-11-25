# Keeps the bot running on Windows: restarts it 30 seconds after it stops by itself (a crash, the
# network dropping, Betika's site failing), and writes everything to logs\bot-YYYY-MM-DD.log.
# Stopping it yourself with Ctrl+C ends the bot cleanly (exit code 0) and this script stops too.
#
#   powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1
#
# Optional: other commands, e.g.  -File scripts\run-forever.ps1 scan --once
$botArgs = if ($args.Count) { $args } else { @('scan') }
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force -Path logs | Out-Null
while ($true) {
  $log = "logs\bot-$(Get-Date -Format yyyy-MM-dd).log"
  "$(Get-Date -Format s) starting: node bin/ev-bot.js $botArgs" | Tee-Object -FilePath $log -Append
  node bin/ev-bot.js @botArgs 2>&1 | ForEach-Object { "$_" } | Tee-Object -FilePath $log -Append
  $code = $LASTEXITCODE
  if ($code -eq 0 -or $code -eq 130) {
    "$(Get-Date -Format s) bot stopped (exit $code) - not restarting" | Tee-Object -FilePath $log -Append
    break
  }
  "$(Get-Date -Format s) bot stopped with exit code $code - restarting in 30 s (Ctrl+C to stop)" | Tee-Object -FilePath $log -Append
  Start-Sleep -Seconds 30
}
