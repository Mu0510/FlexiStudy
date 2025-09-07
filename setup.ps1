# FlexiStudy 環境構築スクリプト for Windows

# --- スタイル関数 ---
function Write-Step {
    param($message)
    Write-Host "`n===> $message" -ForegroundColor Cyan
}

function Write-Success {
    param($message)
    Write-Host "✓ $message" -ForegroundColor Green
}

function Write-Warning {
    param($message)
    Write-Host "⚠ $message" -ForegroundColor Yellow
}

function Write-Failure {
    param($message)
    Write-Host "✗ $message" -ForegroundColor Red
    Read-Host "処理を終了するには Enter キーを押してください"
    exit 1
}

function Check-Command {
    param($command)
    return (Get-Command $command -ErrorAction SilentlyContinue)
}

# --- メインスクリプト ---

# 1. 実行ポリシーのチェック
$currentPolicy = Get-ExecutionPolicy
if ($currentPolicy -ne 'Unrestricted' -and $currentPolicy -ne 'RemoteSigned' -and $currentPolicy -ne 'Bypass') {
    Write-Warning "PowerShell の実行ポリシーが '$currentPolicy' に設定されています。"
    Write-Warning "このスクリプトは実行できない可能性があります。問題が発生した場合は、PowerShellを管理者として開き、以下のコマンドを実行してから再度お試しください:"
    Write-Host "Set-ExecutionPolicy RemoteSigned -Scope Process -Force"
    Read-Host "続行するには Enter キーを押してください..."
}


Write-Step "1. パッケージマネージャ (Winget) をチェックしています..."
if (!(Check-Command winget)) {
    Write-Warning "Winget が利用できません。Node.js, Python, mkcert を手動でインストールしてください。"
    Write-Host "Node.js: https://nodejs.org/"
    Write-Host "Python: https://www.python.org/"
    Write-Host "mkcert: https://github.com/FiloSottile/mkcert/releases"
    Read-Host "手動でインストールした後、このスクリプトを再度実行してください。Enter キーを押すと終了します。"
    exit 1
} else {
    Write-Success "Winget は利用可能です。"
}

Write-Step "2. システムの依存関係をチェック・インストールしています..."

# Node.js (npmを含む) のチェック/インストール
if (!(Check-Command node)) {
    Write-Host "Node.js が見つかりません。winget を使ってインストールします..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "Node.js のインストールに失敗しました。" }
    Write-Success "Node.js のインストールが完了しました。"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "Node.js は既にインストールされています。"
}

# Python のチェック/インストール
if (!(Check-Command python) -and !(Check-Command python3)) {
    Write-Host "Python が見つかりません。winget を使ってインストールします..."
    winget install --id Python.Python.3 -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "Python のインストールに失敗しました。" }
    Write-Success "Python のインストールが完了しました。"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "Python は既にインストールされています。"
}

# pnpm のチェック/インストール
if (!(Check-Command pnpm)) {
    Write-Host "pnpm が見つかりません。npm を使ってグローバルにインストールします..."
    npm install -g pnpm
    if ($LASTEXITCODE -ne 0) { Write-Failure "pnpm のインストールに失敗しました。" }
    Write-Success "pnpm のインストールが完了しました。"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "pnpm は既にインストールされています。"
}

# mkcert のチェック/インストール
if (!(Check-Command mkcert)) {
    Write-Host "mkcert が見つかりません。winget を使ってインストールします..."
    winget install --id FiloSottile.mkcert -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Failure "mkcert のインストールに失敗しました。" }
    Write-Success "mkcert のインストールが完了しました。"
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Success "mkcert は既にインストールされています。"
}


Write-Step "3. ルートディレクトリの Node.js 依存関係をインストールしています..."
if (Test-Path -Path "package.json") {
    pnpm install
    if ($LASTEXITCODE -ne 0) { Write-Failure "ルートの依存関係のインストールに失敗しました。" }
    Write-Success "ルートの依存関係のインストールが完了しました。"
} else {
    Write-Warning "ルートに package.json が見つかりません。スキップします。"
}

Write-Step "4. Webアプリケーション (webnew) の依存関係をインストールしています..."
if (Test-Path -Path "webnew/package.json") {
    Push-Location -Path "webnew"
    pnpm install
    if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Failure "webnew の依存関係のインストールに失敗しました。" }
    Pop-Location
    Write-Success "webnew の依存関係のインストールが完了しました。"
} else {
    Write-Warning "webnew/package.json が見つかりません。スキップします。"
}

Write-Step "5. ローカルHTTPS証明書を作成しています..."
if (Test-Path -Path "webnew") {
    # certs ディレクトリがなければ作成
    New-Item -ItemType Directory -Force -Path "webnew/certs" | Out-Null
    
    Write-Host "ローカル認証局 (CA) をインストールしています..."
    mkcert -install
    if ($LASTEXITCODE -ne 0) { Write-Failure "ローカルCAのインストールに失敗しました。" }

    Write-Host "localhost 用の証明書を生成しています..."
    mkcert -key-file webnew/certs/key.pem -cert-file webnew/certs/cert.pem localhost 127.0.0.1 ::1
    if ($LASTEXITCODE -ne 0) { Write-Failure "HTTPS証明書の作成に失敗しました。" }
    
    Write-Success "HTTPS証明書を webnew/certs/ に作成しました。"
} else {
    Write-Warning "webnew ディレクトリが見つかりません。証明書の生成をスキップします。"
}

Write-Step "6. Gemini CLI の認証を行います..."
Write-Host "しばらく待つと、GeminiCLIが起動します。" -ForegroundColor Yellow
Write-Host "Login with Googleを選択してEnterを押すと、ブラウザが開き、Googleアカウントでのログインを求められます。" -ForegroundColor Yellow
Write-Host "ログインと設定が完了したら、ターミナルに戻り「/quit」と入力してEnterキーを押してください。"
npx @google/gemini-cli@0.3.2
Write-Success "Gemini CLI の設定が完了しました。"


Write-Step "🎉 すべてのセットアップが完了しました！"
Write-Host "次のコマンドでアプリケーションを起動できます:" -ForegroundColor Green
Write-Host "cd webnew" -ForegroundColor Yellow
Write-Host "pnpm dev" -ForegroundColor Yellow
Write-Host "サーバーは https://localhost:3000 で利用可能になります。" -ForegroundColor Green

Read-Host "処理を終了するには Enter キーを押してください"
