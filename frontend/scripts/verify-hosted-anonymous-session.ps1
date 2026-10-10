param([string]$BaseUrl = 'https://metricground.chirpyseed1.chatgpt.site')
$ErrorActionPreference = 'Stop'

function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) { throw "$Label : expected $Expected, received $Actual" }
}

function Invoke-Probe([string]$Path, $Session, [string]$Method = 'Get', $Body = $null, $Headers = @{}) {
  $arguments = @{ Uri = $BaseUrl + $Path; Method = $Method; SkipHttpErrorCheck = $true; TimeoutSec = 30; Headers = $Headers }
  if ($Session) { $arguments.WebSession = $Session }
  if ($null -ne $Body) { $arguments.ContentType = 'application/json'; $arguments.Body = ($Body | ConvertTo-Json -Depth 30 -Compress) }
  $response = Invoke-WebRequest @arguments
  return @{ Status = [int]$response.StatusCode; Body = ($response.Content | ConvertFrom-Json); Headers = $response.Headers }
}

function New-ProbeRun([string]$Label, [string]$Suffix) {
  $now = [DateTime]::UtcNow.ToString('o')
  return @{ id = "task_hosted_anonymous_${Label}_${Suffix}"; traceId = "trace_hosted_anonymous_${Label}_${Suffix}";
    persistenceRevision = 0; question = "匿名会话隔离探针 $Label"; state = 'IDLE'; createdAt = $now; updatedAt = $now;
    datasetVersions = @(); analysisSpec = $null; plan = @(); toolCalls = @(); approvals = @(); validationSummary = $null;
    resultSummary = $null; failure = $null; events = @() }
}

$sessionA = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$sessionB = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$initA = Invoke-Probe '/api/session' $sessionA
$initB = Invoke-Probe '/api/session' $sessionB
foreach ($initialized in @($initA, $initB)) {
  Assert-Equal $initialized.Status 200 'session HTTP status'
  Assert-Equal $initialized.Body.authenticated $false 'anonymous client'
  Assert-Equal $initialized.Body.required $false 'no login required'
  Assert-Equal $initialized.Body.anonymous $true 'anonymous mode enabled'
  $cookieHeader = $initialized.Headers['Set-Cookie'] -join ';'
  if ($cookieHeader -notmatch 'HttpOnly' -or $cookieHeader -notmatch 'SameSite=Lax' -or $cookieHeader -notmatch 'Secure') {
    throw 'Hosted anonymous cookie security attributes missing'
  }
}
$cookieA = ($sessionA.Cookies.GetCookies([Uri]$BaseUrl) | Where-Object Name -eq 'metricground_anon_session').Value
$cookieB = ($sessionB.Cookies.GetCookies([Uri]$BaseUrl) | Where-Object Name -eq 'metricground_anon_session').Value
if (-not $cookieA -or -not $cookieB -or $cookieA -eq $cookieB) { throw 'Browser identities are not independent' }
$reused = Invoke-Probe '/api/session' $sessionA
Assert-Equal $reused.Body.anonymous $true 'session refresh'
if ($reused.Headers['Set-Cookie']) { throw 'Session refresh unexpectedly replaced identity' }
$missing = Invoke-Probe '/api/agent/plan' $null 'Post' @{}
Assert-Equal $missing.Status 401 'missing anonymous session rejected'
Assert-Equal $missing.Body.code 'ANONYMOUS_SESSION_REQUIRED' 'missing session error code'

$suffix = [Guid]::NewGuid().ToString('N')
$runA = New-ProbeRun 'a' $suffix
$runB = New-ProbeRun 'b' $suffix
$headersA = @{ 'X-Trace-Id' = $runA.traceId; 'Idempotency-Key' = "anon_a_$suffix" }
$headersB = @{ 'X-Trace-Id' = $runB.traceId; 'Idempotency-Key' = "anon_b_$suffix" }
Assert-Equal (Invoke-Probe '/api/task-runs' $sessionA 'Put' $runA $headersA).Status 201 'A create'
Assert-Equal (Invoke-Probe ('/api/task-runs?id=' + $runA.id) $sessionA 'Get' $null @{ 'X-Trace-Id' = $runA.traceId }).Status 200 'A self read'
Assert-Equal (Invoke-Probe ('/api/task-runs?id=' + $runA.id) $sessionB 'Get' $null @{ 'X-Trace-Id' = $runA.traceId }).Status 404 'B cannot read A'
Assert-Equal (Invoke-Probe '/api/task-runs' $sessionB 'Put' $runB $headersB).Status 201 'B create'
Assert-Equal (Invoke-Probe ('/api/task-runs?id=' + $runB.id) $sessionB 'Get' $null @{ 'X-Trace-Id' = $runB.traceId }).Status 200 'B self read'
Assert-Equal (Invoke-Probe ('/api/task-runs?id=' + $runB.id) $sessionA 'Get' $null @{ 'X-Trace-Id' = $runB.traceId }).Status 404 'A cannot read B'
$crossWrite = Invoke-Probe '/api/task-runs' $sessionB 'Put' $runA @{ 'X-Trace-Id' = $runA.traceId; 'Idempotency-Key' = "anon_cross_$suffix" }
Assert-Equal $crossWrite.Status 409 'B cannot overwrite A'
Assert-Equal $crossWrite.Body.current $null 'conflict must not disclose A'

$dataset = @{ fileName = 'anonymous-probe.csv'; rowCount = 11; columnCount = 1; grainSuggestion = '粒度需人工确认';
  fields = @(@{ name = 'order_id'; type = '文本'; missingRate = 0; uniqueCount = 10; candidateKey = $false });
  qualityIssues = @(); availableTools = @('profile_dataset','run_quality_checks','request_metric_contract','execute_metric','validate_result') }
$planned = Invoke-Probe '/api/agent/plan' $sessionA 'Post' @{ question = '统计 order_id 去重后的订单数量'; dataset = $dataset }
Assert-Equal $planned.Status 200 'anonymous planning'
Assert-Equal $planned.Body.plan.analysisType 'metric' 'count planning type'
Assert-Equal $planned.Body.plan.fieldBindings.entityField 'order_id' 'count entity binding'
$health = Invoke-Probe '/api/health' $null
Assert-Equal $health.Status 200 'public health'
Assert-Equal $health.Body.version '0.3.2' 'deployed version'

@{ passed = $true; baseUrl = $BaseUrl; checkedAt = [DateTime]::UtcNow.ToString('o'); version = $health.Body.version;
  anonymousSessionsInitialized = $true; loginRequired = $false; anonymousPlanning = 200; missingSession = 401;
  sessionASelfRead = 200; sessionBCannotReadA = 404; sessionBSelfRead = 200; sessionACannotReadB = 404;
  sessionBCannotOverwriteA = 409; taskRunA = $runA.id; taskRunB = $runB.id } | ConvertTo-Json -Depth 5
