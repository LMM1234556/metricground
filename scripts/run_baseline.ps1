$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot ".venv\Scripts\python.exe"
$dataPath = Join-Path $projectRoot "runtime\data-formulator"

if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw "未找到项目虚拟环境，请先完成依赖安装。"
}

if (-not (Test-Path -LiteralPath $dataPath)) {
    New-Item -ItemType Directory -Path $dataPath | Out-Null
}

& $pythonPath -m data_formulator --host 127.0.0.1 --port 5000 --data-dir $dataPath
