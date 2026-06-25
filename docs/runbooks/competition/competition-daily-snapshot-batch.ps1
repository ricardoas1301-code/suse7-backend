$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:JOB_SECRET)) {
  throw "Variavel de ambiente JOB_SECRET nao definida."
}
if ([string]::IsNullOrWhiteSpace($env:BASE_URL)) {
  throw "Variavel de ambiente BASE_URL nao definida."
}

$baseUrl = $env:BASE_URL.TrimEnd("/")
$headers = @{
  "x-job-secret" = $env:JOB_SECRET
  "Content-Type" = "application/json"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Join-Path (Get-Location) "competition-daily-runs-$timestamp"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$rounds = @(
  @{ Name = "run1"; Query = "limit=20&max_per_run=60"; SleepAfterSec = 60 },
  @{ Name = "run2"; Query = "limit=20&max_per_run=60"; SleepAfterSec = 60 },
  @{ Name = "run3"; Query = "limit=15&max_per_run=40"; SleepAfterSec = 0  }
)

function Invoke-Round {
  param(
    [string]$Name,
    [string]$Query
  )

  $url = "$baseUrl/api/jobs/competition-daily-snapshot?$Query"
  Write-Host ">> Executando $Name em $url"

  try {
    $resp = Invoke-RestMethod -Method Post -Uri $url -Headers $headers -TimeoutSec 120
  } catch {
    $errMsg = $_.Exception.Message
    Write-Warning "$Name falhou na chamada HTTP: $errMsg"
    $resp = [ordered]@{
      ok = $false
      round = $Name
      processed = 0
      updated = 0
      unchanged_touched = 0
      failed = 1
      remaining_estimate = $null
      timed_out = $true
      sample_results = @(
        [ordered]@{
          status = "error"
          error_code = "http_request_failed"
          error_message = $errMsg
        }
      )
    }
  }

  $filePath = Join-Path $outDir "$Name.json"
  ($resp | ConvertTo-Json -Depth 100) | Set-Content -Path $filePath -Encoding UTF8
  Write-Host "   Salvo: $filePath"
  return $resp
}

$results = @()

for ($i = 0; $i -lt $rounds.Count; $i++) {
  $r = $rounds[$i]
  $res = Invoke-Round -Name $r.Name -Query $r.Query
  $results += [PSCustomObject]@{
    name = $r.Name
    response = $res
  }

  if ($r.SleepAfterSec -gt 0) {
    Write-Host "   Aguardando $($r.SleepAfterSec)s antes da proxima rodada..."
    Start-Sleep -Seconds $r.SleepAfterSec
  }
}

$run1 = Get-Content (Join-Path $outDir "run1.json") -Raw | ConvertFrom-Json
$run2 = Get-Content (Join-Path $outDir "run2.json") -Raw | ConvertFrom-Json
$run3 = Get-Content (Join-Path $outDir "run3.json") -Raw | ConvertFrom-Json
$all = @($run1, $run2, $run3)

$processedTotal = ($all | ForEach-Object { [int]($_.processed ?? 0) } | Measure-Object -Sum).Sum
$updatedTotal = ($all | ForEach-Object { [int]($_.updated ?? 0) } | Measure-Object -Sum).Sum
$unchangedTouchedTotal = ($all | ForEach-Object { [int]($_.unchanged_touched ?? 0) } | Measure-Object -Sum).Sum
$failedTotal = ($all | ForEach-Object { [int]($_.failed ?? 0) } | Measure-Object -Sum).Sum
$lastRemainingEstimate = $run3.remaining_estimate
$timedOutAny = ($all | Where-Object { $_.timed_out -eq $true }).Count -gt 0

Write-Host ""
Write-Host "===== RESUMO FINAL ====="
[PSCustomObject]@{
  processed_total = $processedTotal
  updated_total = $updatedTotal
  unchanged_touched_total = $unchangedTouchedTotal
  failed_total = $failedTotal
  ultimo_remaining_estimate = $lastRemainingEstimate
  houve_timed_out_em_alguma_rodada = $timedOutAny
} | Format-List

Write-Host ""
Write-Host "===== SAMPLE_RESULTS (RESUMIDO) ====="
foreach ($label in @("run1","run2","run3")) {
  $obj = Get-Content (Join-Path $outDir "$label.json") -Raw | ConvertFrom-Json
  Write-Host ""
  Write-Host "-- $label --"
  if ($null -eq $obj.sample_results -or $obj.sample_results.Count -eq 0) {
    Write-Host "sem sample_results"
    continue
  }

  $obj.sample_results |
    Select-Object -First 10 `
      @{n="status";e={$_.status}},
      @{n="item_id";e={$_.item_id}},
      @{n="competitor_id";e={$_.competitor_id}},
      @{n="error_code";e={$_.error_code}},
      @{n="new_price";e={$_.new_price}},
      @{n="captured_at";e={$_.captured_at}} |
    Format-Table -AutoSize
}

$errors = @()
foreach ($obj in $all) {
  if ($obj.sample_results) {
    $errors += $obj.sample_results | Where-Object { $_.status -eq "error" -or $_.error_code }
  }
}

if ($errors.Count -gt 0) {
  Write-Host ""
  Write-Host "===== CLASSIFICACAO PROVAVEL (AMOSTRA) ====="
  $classified = $errors | ForEach-Object {
    $code = [string]($_.error_code)
    $msg  = [string]($_.error_message)

    $causa =
      if ($code -eq "ml_token_unavailable") { "token invalido/ausente" }
      elseif ($code -match "timeout" -or $msg -match "timeout|timed out|FUNCTION_INVOCATION_TIMEOUT") { "timeout" }
      elseif ($code -match "404|not_found" -or $msg -match "404|not found") { "anuncio removido/404 ML" }
      elseif ($code -match "403|forbidden" -or $msg -match "403|forbidden") { "403 ML (permissao/politica)" }
      else { "erro interno/outros" }

    [PSCustomObject]@{
      item_id = $_.item_id
      competitor_id = $_.competitor_id
      error_code = $code
      causa_provavel = $causa
      error_message = $msg
    }
  }

  $classified | Group-Object causa_provavel | Select-Object Name,Count | Format-Table -AutoSize
}

Write-Host ""
Write-Host "Arquivos gerados em: $outDir"
Write-Host "  - run1.json"
Write-Host "  - run2.json"
Write-Host "  - run3.json"
