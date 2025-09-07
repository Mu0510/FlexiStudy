#!/bin/bash

# FlexiStudy 環境構築スクリプト

# --- カラーコード ---
C_RESET='\033[0m'
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_YELLOW='\033[0;33m'
C_CYAN='\033[0;36m'

# --- ヘルパー関数 ---
step() {
    echo -e "\n${C_CYAN}===> $1${C_RESET}"
}

success() {
    echo -e "${C_GREEN}✓ $1${C_RESET}"
}

warn() {
    echo -e "${C_YELLOW}⚠ $1${C_RESET}"
}

fail() {
    echo -e "${C_RED}✗ $1${C_RESET}"
    exit 1
}

check_command() {
    if ! command -v $1 &> /dev/null; then
        return 1
    else
        return 0
    fi
}

# --- メインスクリプト ---

step "1. システムの依存関係をチェックしています..."

# 必須コマンドのチェック
for cmd in node npm python3; do
    if ! check_command $cmd; then
        fail "$cmd がインストールされていません。インストールしてから再度実行してください。"
    else
        success "$cmd は利用可能です。"
    fi
done

# pnpm のチェックとインストール
if ! check_command pnpm; then
    echo "pnpm が見つかりません。npm を使ってグローバルにインストールします..."
    if npm install -g pnpm; then
        success "pnpm のインストールが完了しました。"
        # 現在のセッションのためにPATHを通す
        export PATH="$(npm config get prefix)/bin:$PATH"
    else
        fail "pnpm のインストールに失敗しました。手動でインストールしてください。"
    fi
else
    success "pnpm は利用可能です。"
fi

# mkcert のチェック
if ! check_command mkcert; then
    warn "mkcert がインストールされていません。ローカルHTTPS通信に必要です。"
    echo "お使いのシステムのパッケージマネージャでインストールしてください。"
    echo "  - macOS (Homebrew): brew install mkcert"
    echo "  - Debian/Ubuntu: sudo apt install -y libnss3-tools mkcert"
    echo "  - Fedora/CentOS: sudo dnf install -y nss-tools mkcert"
    fail "mkcert をインストールしてから、再度このスクリプトを実行してください。"
else
    success "mkcert は利用可能です。"
fi


step "2. ルートディレクトリの Node.js 依存関係をインストールしています..."
if [ -f "package.json" ]; then
    pnpm install || fail "ルートの依存関係のインストールに失敗しました。"
    success "ルートの依存関係のインストールが完了しました。"
else
    echo "ルートに package.json が見つかりません。スキップします。"
fi

step "3. Webアプリケーション (webnew) の依存関係をインストールしています..."
if [ -d "webnew" ] && [ -f "webnew/package.json" ]; then
    cd webnew
    pnpm install || fail "webnew の依存関係のインストールに失敗しました。"
    cd ..
    success "webnew の依存関係のインストールが完了しました。"
else
    echo "webnew ディレクトリ、または package.json が見つかりません。スキップします。"
fi

step "4. ローカルHTTPS証明書を作成しています..."
if [ -d "webnew" ]; then
    # certs ディレクトリがなければ作成
    mkdir -p webnew/certs
    
    echo "ローカル認証局 (CA) をインストールしています... (パスワードを要求される場合があります)"
    mkcert -install
    
    echo "localhost 用の証明書を生成しています..."
    if mkcert -key-file webnew/certs/key.pem -cert-file webnew/certs/cert.pem localhost 127.0.0.1 ::1; then
        success "HTTPS証明書を webnew/certs/ に作成しました。"
    else
        fail "HTTPS証明書の作成に失敗しました。"
    fi
else
    warn "webnew ディレクトリが見つかりません。証明書の生成をスキップします。"
fi

step "5. Gemini CLI の認証を行います..."
echo -e "${C_YELLOW}しばらく待つと、GeminiCLIが起動します。${C_RESET}"
echo -e "{C_YELLOW}Login with Googleを選択してEnterを押すと、ブラウザが開き、Googleアカウントでのログインを求められます。${C_RESET}"
echo "ログインと設定が完了したら、ターミナルに戻り「/quit」と入力してEnterキーを押してください。"
npx @google/gemini-cli@0.3.2
success "Gemini CLI の設定が完了しました。"


step "🎉 すべてのセットアップが完了しました！"
echo -e "次のコマンドでアプリケーションを起動できます: ${C_YELLOW}cd webnew && pnpm dev${C_RESET}"
echo -e "サーバーは ${C_GREEN}https://localhost:3000${C_RESET} で利用可能になります。"
