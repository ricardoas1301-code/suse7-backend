# Launcher Batch 2A — senha postgres somente em memoria durante a execucao.
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$secure = Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:PROD_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
  Set-Location $ScriptDir
  node (Join-Path $ScriptDir 'execute_batch2a_execute_as_is_prod.mjs')
  exit $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
  Remove-Item Env:PROD_DB_PASSWORD -ErrorAction SilentlyContinue
}
