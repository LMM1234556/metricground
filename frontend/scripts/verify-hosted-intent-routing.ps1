param([string]$BaseUrl = 'https://metricground.chirpyseed1.chatgpt.site')
$ErrorActionPreference = 'Stop'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$initialized = Invoke-RestMethod ($BaseUrl + '/api/session') -WebSession $session -TimeoutSec 30
if ($initialized.required -or -not $initialized.anonymous) { throw 'This probe requires the public anonymous test environment' }
$dataset = @{ fileName = 'hosted-intent-probe.csv'; rowCount = 3; columnCount = 3; grainSuggestion = '业务含义需人工确认';
  fields = @(
    @{ name = 'order_id'; type = '文本'; missingRate = 0; uniqueCount = 3; candidateKey = $true },
    @{ name = 'amount'; type = '数值'; missingRate = 0; uniqueCount = 3; candidateKey = $false },
    @{ name = 'region'; type = '文本'; missingRate = 0; uniqueCount = 2; candidateKey = $false });
  qualityIssues = @(); availableTools = @('profile_dataset','run_quality_checks','request_metric_contract','execute_metric','execute_top_n','validate_result') }
function Get-Plan([string]$Question, $Context = $dataset) {
  $body = @{ question = $Question; dataset = $Context } | ConvertTo-Json -Depth 20 -Compress
  $result = Invoke-RestMethod ($BaseUrl + '/api/agent/plan') -Method Post -ContentType 'application/json' -Body $body -WebSession $session -TimeoutSec 30
  if ($result.source -ne 'policy-router') { throw 'Probe does not measure model accuracy; expected policy-router' }
  return $result.plan
}
function Assert-Equal($Actual, $Expected, [string]$Label) {
  if ($Actual -ne $Expected) { throw "$Label : expected $Expected, received $Actual" }
}
$count = Get-Plan '帮我算一下有多少笔不同的订单'
Assert-Equal $count.analysisType 'metric' 'count intent'
Assert-Equal $count.fieldBindings.entityField 'order_id' 'count binding'
$once = Get-Plan '相同订单编号只算一次，一共有多少个订单？'
Assert-Equal $once.analysisType 'metric' 'once-only count'
$rank = Get-Plan '哪个地区的订单金额最多？'
Assert-Equal $rank.analysisType 'top_n' 'ranking preserved'
Assert-Equal $rank.action 'clarify' 'amount scope needs confirmation'
Assert-Equal $rank.nextView '经营分析' 'ranking handoff'
$forecast = Get-Plan '预测下个月的销售额'
Assert-Equal $forecast.action 'unsupported' 'forecast rejected'
Assert-Equal $forecast.nextView $null 'no unsupported handoff'
$customer = Get-Plan '统计客户数'
Assert-Equal $customer.action 'clarify' 'missing customer clarification'
Assert-Equal $customer.fieldBindings.entityField $null 'order ID not substituted'
$cost = Get-Plan '计算 cost 合计'
Assert-Equal $cost.action 'clarify' 'missing measure clarification'
Assert-Equal $cost.fieldBindings.valueField $null 'amount not substituted'
$channel = Get-Plan '哪个渠道的订单金额最多？'
Assert-Equal $channel.fieldBindings.groupField $null 'region not substituted'
Assert-Equal $channel.action 'clarify' 'missing dimension clarification'
$price = Get-Plan '哪个地区 price 合计最多？'
Assert-Equal $price.analysisType 'top_n' 'missing price retains ranking'
Assert-Equal $price.action 'clarify' 'missing price clarification'
Assert-Equal $price.fieldBindings.valueField $null 'price not substituted'
$join = Get-Plan '关联后订单金额多了一倍，怎么办？'
Assert-Equal $join.analysisType 'quality' 'join risk investigation'
Assert-Equal $join.nextView '多表关联' 'join handoff'
if ($join.clarification -notmatch '画像不足以确认根因') { throw 'Join diagnosis overclaims its evidence' }
$rows = Get-Plan '为什么表的行数比订单数多？'
if ($rows.summary -notmatch '未发现') { throw 'Equal row and object counts must challenge the false premise' }
$health = Invoke-RestMethod ($BaseUrl + '/api/health') -TimeoutSec 30
$expected = (Get-Content (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
Assert-Equal $health.version $expected 'deployed version'
@{ passed = $true; cases = 10; version = $health.version; source = 'policy-router';
  checkedAt = [DateTime]::UtcNow.ToString('o'); scope = '线上匿名规划和字段绑定探针，不代表大模型准确率或真实用户研究' } | ConvertTo-Json
