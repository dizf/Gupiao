$ErrorActionPreference = "Stop"

python -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    throw "依赖安装失败"
}

python -m PyInstaller `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name GupiaoSelector `
    gui.py
if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller 构建失败"
}

if (-not (Test-Path ".\dist\GupiaoSelector.exe")) {
    throw "未找到生成的 EXE"
}

Write-Host "EXE 已生成：dist\GupiaoSelector.exe"
