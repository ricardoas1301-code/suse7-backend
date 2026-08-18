# Launcher Batch 5C2 — Billing 114 trial lifecycle PROD (senha postgres somente em memoria).

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$secure = Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString

$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)

try {
  $env:PROD_DB_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
  Set-Location $ScriptDir
  node (Join-Path $ScriptDir 'execute_batch5c2_billing114_prod.mjs')
  exit $LASTEXITCODE
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
  Remove-Item Env:PROD_DB_PASSWORD -ErrorAction SilentlyContinue
}
