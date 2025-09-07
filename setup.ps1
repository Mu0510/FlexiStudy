# FlexiStudy 迺ｰ蠅�讒狗ｯ峨せ繧ｯ繝ｪ繝励ヨ for Windows

# --- 繧ｹ繧ｿ繧､繝ｫ髢｢謨ｰ ---
function Write-Step {
    param($message)
    Write-Host "`n===> $message" -ForegroundColor Cyan
}

function Write-Success {
    param($message)
    Write-Host "笨� $message" -ForegroundColor Green
}

function Write-Warning {
    param($message)
    Write-Host "笞 $message" -ForegroundColor Yellow
}

function Write-Failure {
    param($message)
    Write-Host "笨� $message" -ForegroundColor Red
    Read-Host "蜃ｦ逅�繧堤ｵゆｺ�縺吶ｋ縺ｫ縺ｯ Enter 繧ｭ繝ｼ繧呈款縺励※縺上□縺輔＞"
    exit 1
}

function Check-Command {
    param($command)
    return (Get-Command $command -ErrorAction SilentlyContinue)
}

# --- 繝｡繧､繝ｳ繧ｹ繧ｯ繝ｪ繝励ヨ ---

# 1. 螳溯｡後�昴Μ繧ｷ繝ｼ縺ｮ繝√ぉ繝�繧ｯ
$currentPolicy = Get-ExecutionPolicy
if ($currentPolicy -ne 'Unrestricted' -and $currentPolicy -ne 'RemoteSigned' -and $currentPolicy -ne 'Bypass') {
    Write-Warning "PowerShell 縺ｮ螳溯｡後�昴Μ繧ｷ繝ｼ縺� '$currentPolicy' 縺ｫ險ｭ螳壹＆繧後※縺�縺ｾ縺吶�"
    Write-Warning "縺薙�ｮ繧ｹ繧ｯ繝ｪ繝励ヨ縺ｯ螳溯｡後〒縺阪↑縺�蜿ｯ閭ｽ諤ｧ縺後≠繧翫∪縺吶ょ撫鬘後′逋ｺ逕溘＠縺溷ｴ蜷医�ｯ縲￣owerShell繧堤ｮ｡逅�閠�縺ｨ縺励※髢九″縲∽ｻ･荳九�ｮ繧ｳ繝槭Φ繝峨ｒ螳溯｡後＠縺ｦ縺九ｉ蜀榊ｺｦ縺願ｩｦ縺励￥縺縺輔＞:"
    Write-Host "Set-ExecutionPolicy RemoteSigned -Scope Process -Force"
    Read-Host "邯夊｡後☆繧九↓縺ｯ Enter 繧ｭ繝ｼ繧呈款縺励※縺上□縺輔＞..."
}


Write-Step "1. 繝代ャ繧ｱ繝ｼ繧ｸ繝槭ロ繝ｼ繧ｸ繝｣ (Winget) 繧偵メ繧ｧ繝�繧ｯ縺励※縺�縺ｾ縺�..."
if (!(Check-Command winget)) {
    Write-Warning "Winget 縺悟茜逕ｨ縺ｧ縺阪∪縺帙ｓ縲�Node.js, Python, mkcert 繧呈焔蜍輔〒繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励※縺上□縺輔＞縲�"
    Write-Host "Node.js: https://nodejs.org/"
    Write-Host "Python: https://www.python.org/"
    Write-Host "mkcert: https://github.com/FiloSottile/mkcert/releases"
    Read-Host "謇句虚縺ｧ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励◆蠕後√％縺ｮ繧ｹ繧ｯ繝ｪ繝励ヨ繧貞�榊ｺｦ螳溯｡後＠縺ｦ縺上□縺輔＞縲�Enter 繧ｭ繝ｼ繧呈款縺吶→邨ゆｺ�縺励∪縺吶�"
    exit 1
} else {
    Write-Success "Winget 縺ｯ蛻ｩ逕ｨ蜿ｯ閭ｽ縺ｧ縺吶�"
}

Write-Step "2. 繧ｷ繧ｹ繝�繝縺ｮ萓晏ｭ倬未菫ゅｒ繝√ぉ繝�繧ｯ繝ｻ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励※縺�縺ｾ縺�..."

# Node.js (npm繧貞性繧) 縺ｮ繝√ぉ繝�繧ｯ/繧､繝ｳ繧ｹ繝医�ｼ繝ｫ
if (!(Check-Command node)) {
    Write-Host "Node.js 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲Ｘinget 繧剃ｽｿ縺｣縺ｦ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励∪縺�..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "Node.js 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Write-Success "Node.js 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "Node.js 縺ｯ譌｢縺ｫ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺輔ｌ縺ｦ縺�縺ｾ縺吶�"
}

# Python 縺ｮ繝√ぉ繝�繧ｯ/繧､繝ｳ繧ｹ繝医�ｼ繝ｫ
if (!(Check-Command python) -and !(Check-Command python3)) {
    Write-Host "Python 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲Ｘinget 繧剃ｽｿ縺｣縺ｦ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励∪縺�..."
    winget install --id Python.Python.3 -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "Python 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Write-Success "Python 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "Python 縺ｯ譌｢縺ｫ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺輔ｌ縺ｦ縺�縺ｾ縺吶�"
}

# pnpm 縺ｮ繝√ぉ繝�繧ｯ/繧､繝ｳ繧ｹ繝医�ｼ繝ｫ
if (!(Check-Command pnpm)) {
    Write-Host "pnpm 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲Ｏpm 繧剃ｽｿ縺｣縺ｦ繧ｰ繝ｭ繝ｼ繝舌Ν縺ｫ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励∪縺�..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) { Write-Failure "pnpm 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Write-Success "pnpm 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "pnpm 縺ｯ譌｢縺ｫ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺輔ｌ縺ｦ縺�縺ｾ縺吶�"
}

# mkcert 縺ｮ繝√ぉ繝�繧ｯ/繧､繝ｳ繧ｹ繝医�ｼ繝ｫ
if (!(Check-Command mkcert)) {
    Write-Host "mkcert 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲Ｘinget 繧剃ｽｿ縺｣縺ｦ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励∪縺�..."
    winget install --id FiloSottile.mkcert -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "mkcert 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Write-Success "mkcert 縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "mkcert 縺ｯ譌｢縺ｫ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺輔ｌ縺ｦ縺�縺ｾ縺吶�"
}


Write-Step "3. 繝ｫ繝ｼ繝医ョ繧｣繝ｬ繧ｯ繝医Μ縺ｮ Node.js 萓晏ｭ倬未菫ゅｒ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励※縺�縺ｾ縺�..."
if (Test-Path -Path "package.json") {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Failure "繝ｫ繝ｼ繝医�ｮ萓晏ｭ倬未菫ゅ�ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Write-Success "繝ｫ繝ｼ繝医�ｮ萓晏ｭ倬未菫ゅ�ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
} else {
    Write-Warning "繝ｫ繝ｼ繝医↓ package.json 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲ゅせ繧ｭ繝�繝励＠縺ｾ縺吶�"
}

Write-Step "4. Web繧｢繝励Μ繧ｱ繝ｼ繧ｷ繝ｧ繝ｳ (webnew) 縺ｮ萓晏ｭ倬未菫ゅｒ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺励※縺�縺ｾ縺�..."
if (Test-Path -Path "webnew/package.json") {
    Push-Location -Path "webnew"
    pnpm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Failure "webnew 縺ｮ萓晏ｭ倬未菫ゅ�ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }
    Pop-Location
    Write-Success "webnew 縺ｮ萓晏ｭ倬未菫ゅ�ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺悟ｮ御ｺ�縺励∪縺励◆縲�"
} else {
    Write-Warning "webnew/package.json 縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲ゅせ繧ｭ繝�繝励＠縺ｾ縺吶�"
}

Write-Step "5. 繝ｭ繝ｼ繧ｫ繝ｫHTTPS險ｼ譏取嶌繧剃ｽ懈�舌＠縺ｦ縺�縺ｾ縺�..."
if (Test-Path -Path "webnew") {
    # certs 繝�繧｣繝ｬ繧ｯ繝医Μ縺後↑縺代ｌ縺ｰ菴懈��
    New-Item -ItemType Directory -Force -Path "webnew/certs" | Out-Null
    
    Write-Host "繝ｭ繝ｼ繧ｫ繝ｫ隱崎ｨｼ螻 (CA) 繧偵う繝ｳ繧ｹ繝医�ｼ繝ｫ縺励※縺�縺ｾ縺�..."
    mkcert -install
    if ($LASTEXITCODE -ne 0) { Write-Failure "繝ｭ繝ｼ繧ｫ繝ｫCA縺ｮ繧､繝ｳ繧ｹ繝医�ｼ繝ｫ縺ｫ螟ｱ謨励＠縺ｾ縺励◆縲�" }

    Write-Host "localhost 逕ｨ縺ｮ險ｼ譏取嶌繧堤函謌舌＠縺ｦ縺�縺ｾ縺�..."
    mkcert -key-file webnew/certs/key.pem -cert-file webnew/certs/cert.pem localhost 127.0.0.1 ::1
    if ($LASTEXITCODE -ne 0) { Write-Failure "HTTPS險ｼ譏取嶌縺ｮ菴懈�舌↓螟ｱ謨励＠縺ｾ縺励◆縲�" }
    
    Write-Success "HTTPS險ｼ譏取嶌繧� webnew/certs/ 縺ｫ菴懈�舌＠縺ｾ縺励◆縲�"
} else {
    Write-Warning "webnew 繝�繧｣繝ｬ繧ｯ繝医Μ縺瑚ｦ九▽縺九ｊ縺ｾ縺帙ｓ縲りｨｼ譏取嶌縺ｮ逕滓�舌ｒ繧ｹ繧ｭ繝�繝励＠縺ｾ縺吶�"
}

Write-Step "6. Gemini CLI 縺ｮ隱崎ｨｼ繧定｡後＞縺ｾ縺�..."
Write-Host "繝悶Λ繧ｦ繧ｶ縺碁幕縺阪；oogle繧｢繧ｫ繧ｦ繝ｳ繝医〒縺ｮ繝ｭ繧ｰ繧､繝ｳ繧呈ｱゅａ繧峨ｌ縺ｾ縺吶�" -ForegroundColor Yellow
Write-Host "繝ｭ繧ｰ繧､繝ｳ縺ｨ險ｭ螳壹′螳御ｺ�縺励◆繧峨√ち繝ｼ繝溘リ繝ｫ縺ｫ謌ｻ繧翫�/quit縲阪→蜈･蜉帙＠縺ｦEnter繧ｭ繝ｼ繧呈款縺励※縺上□縺輔＞縲�"
npx @google/gemini-cli@0.3.2
Write-Success "Gemini CLI 縺ｮ險ｭ螳壹′螳御ｺ�縺励∪縺励◆縲�"


Write-Step "脂 縺吶∋縺ｦ縺ｮ繧ｻ繝�繝医い繝�繝励′螳御ｺ�縺励∪縺励◆�ｼ�"
Write-Host "谺｡縺ｮ繧ｳ繝槭Φ繝峨〒繧｢繝励Μ繧ｱ繝ｼ繧ｷ繝ｧ繝ｳ繧定ｵｷ蜍輔〒縺阪∪縺�:" -ForegroundColor Green
Write-Host "node webnew/server.js" -ForegroundColor Yellow
Write-Host "繧ｵ繝ｼ繝舌�ｼ縺ｯ https://localhost:3000 縺ｧ蛻ｩ逕ｨ蜿ｯ閭ｽ縺ｫ縺ｪ繧翫∪縺吶�" -ForegroundColor Green

Read-Host "蜃ｦ逅�繧堤ｵゆｺ�縺吶ｋ縺ｫ縺ｯ Enter 繧ｭ繝ｼ繧呈款縺励※縺上□縺輔＞"