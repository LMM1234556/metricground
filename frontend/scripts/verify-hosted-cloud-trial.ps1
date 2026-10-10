param([string]$BaseUrl = 'https://metricground.chirpyseed1.chatgpt.site')
$ErrorActionPreference = 'Stop'
$expectedVersion = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$before = Invoke-RestMethod ($BaseUrl + '/api/health?check=' + [Guid]::NewGuid().ToString('N')) -TimeoutSec 30
if ($before.version -ne $expectedVersion) { throw 'Deployment not ready: no model requests sent' }
if (-not $before.cloudBudget.enabled -or $before.cloudBudget.totalRequestLimit -ne 20 -or $before.cloudBudget.remainingRequests -lt 2) { throw 'Bounded trial unavailable: no model requests sent' }
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$init = Invoke-RestMethod ($BaseUrl + '/api/session') -WebSession $session -TimeoutSec 20
if (-not $init.anonymous -or $init.required) { throw 'Expected anonymous trial session' }
$dataset = @{ fileName = 'public-model-trial.csv'; rowCount = 3; columnCount = 3; grainSuggestion = '业务含义需人工确认';
  fields = @(
    @{ name = 'order_id'; type = '文本'; missingRate = 0; uniqueCount = 3; candidateKey = $true },
    @{ name = 'amount'; type = '数值'; missingRate = 0; uniqueCount = 3; candidateKey = $false },
    @{ name = 'region'; type = '文本'; missingRate = 0; uniqueCount = 2; candidateKey = $false });
  qualityIssues = @(); availableTools = @('profile_dataset','run_quality_checks','request_metric_contract','execute_metric','execute_group_compare','execute_top_n','validate_result') }
$body = @{ question = '每个地方带来的钱分别是多少'; dataset = $dataset } | ConvertTo-Json -Depth 20 -Compress
$result = Invoke-RestMethod ($BaseUrl + '/api/agent/plan') -Method Post -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 55
if ($result.source -ne 'cloud-agent') { throw "Cloud trial failed: source=$($result.source), diagnostic=$($result.fallbackReason)" }
if ($result.model -ne 'qwen-plus' -or $result.provider -ne 'dashscope' -or $result.stepsExecuted -ne 2) { throw 'Unexpected provider, model or tool steps' }
if ($result.plan.analysisType -ne 'group_compare' -or $result.plan.fieldBindings.groupField -ne 'region' -or $result.plan.fieldBindings.valueField -ne 'amount' -or $result.plan.action -ne 'clarify') { throw 'Model planning/clarification guard did not meet the probe contract' }
$after = Invoke-RestMethod ($BaseUrl + '/api/health?check=' + [Guid]::NewGuid().ToString('N')) -TimeoutSec 30
$delta = $after.cloudBudget.reservedRequests - $before.cloudBudget.reservedRequests
if ($delta -lt 2 -or $after.cloudBudget.reservedRequests -gt 20) { throw 'Persistent request counter assertion failed' }
@{ passed = $true; checkedAt = [DateTime]::UtcNow.ToString('o'); version = $after.version;
  source = $result.source; model = $result.model; provider = $result.provider; steps = $result.stepsExecuted;
  plan = $result.plan; usage = $result.usage; latencyMs = $result.latencyMs;
  budgetBefore = $before.cloudBudget; budgetAfter = $after.cloudBudget; observedReservedDelta = $delta;
  scope = 'One self-built public API/cloud planning probe, not browser approval/calculation or open-question accuracy' } | ConvertTo-Json -Depth 12
