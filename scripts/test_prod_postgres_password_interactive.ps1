# Teste read-only PROD postgres — senha só em memória, nunca persistida.
$ErrorActionPreference = 'Stop'
$secure = Read-Host 'Senha postgres PROD (Suse7-prod)' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr)
  $env:PGPASSWORD = $pass
  $out = docker run --rm --network host `
    -e PGPASSWORD `
    postgres:17 psql `
    -h db.bazibzquasbdgjwdcwbz.supabase.co `
    -p 5432 `
    -U postgres `
    -d postgres `
    -t -A `
    -c "SELECT 1" 2>$null
  $ok = ($LASTEXITCODE -eq 0) -and ($out.Trim() -eq '1')
  if ($ok) { 'POSTGRES PASSWORD: VÁLIDA' } else { 'POSTGRES PASSWORD: INVÁLIDA' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) | Out-Null
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  $pass = $null
  $secure = $null
}
