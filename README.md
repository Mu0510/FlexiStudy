# FlexiStudy

Gemini CLIとNext.jsベースのWebアプリケーションを組み合わせた学習支援システムです。


## 目次

- [システム要件](#システム要件)
- [クイックスタート](#クイックスタート)
- [使い方のヒント](#使い方のヒント)
- [機能ハイライト](#機能ハイライト)
- [アーキテクチャ](#アーキテクチャ)
- [プロジェクト構造](#プロジェクト構造)
- [開発](#開発)
- [認証](#認証)


## システム要件

### macOS
- Homebrew
- Bash 4

### Debian系Linux
- apt


## クイックスタート

### 1. セットアップスクリプトの実行

プロジェクトルートで以下のコマンドを実行してください：

```bash
bash setup.sh
```

このスクリプトは以下を自動化します：
- 依存パッケージのインストール
- SQLiteデータベースの初期化
- 環境変数ファイル（`.env.local`）の作成
- Gemini CLIの認証案内

### 2. Gemini CLIの認証

Gemini CLIのセットアップには以下のいずれかが必要です：

1. **Google AI Studio**が利用可能なGoogleアカウントでのログイン
2. **Gemini APIキー**の利用

指示に従ってGeminiCLIへのログインまで済ませたら、GeminiCLI上で「/quit」と送信しGeminiCLIを閉じてください。

エラーが出てGeminiCLIが起動しなかった場合は、プロジェクトルートにて
```bash
npx @google/gemini-cli@0.8.2
```
を実行し、ログインして、GeminiCLI上で「/quit」と送信しGeminiCLIを閉じてください。

### 3. サーバーの起動

```bash
cd webnew
sudo -E pnpm run dev 2>&1 | cat
```

> **注意:** `sudo` なしの `pnpm run dev` でも起動できますが、一部機能が動作しない場合があります。

### 4. アクセス

実行ログに表示されたURLにアクセスしてください：

- **メインアプリケーション:** `https://127.0.0.1:443` または `https://127.0.0.1:3000`
- **レスキューチャットアプリ:** `http://127.0.0.1:3001`


## 使い方のヒント

FlexiStudy を最大限に活用するには、AI を単なる道具ではなく気軽に話せる相手として接することが大切です。友達に学習内容を共有する感覚で会話すると、その対話がそのまま学習記録として残ります。これが FlexiStudy のもっとも特徴的な体験です。

アプリを初めて起動したら、まずは「はじめまして」と挨拶してみてください。AI が自己紹介を返し、すぐに会話を始められます。

操作で迷ったときは、遠慮なく AI に質問してみましょう。AI がすべての機能を把握していない場合もありますが、ときには実際のコードを読みながら説明してくれます。「docs を読んで」などと指示すると、既存ドキュメントを参照した回答を返してくれることもあります。


## 機能ハイライト

気づきにくい機能をまとめました。
詳しい使い方等はアプリ内のAIに聞いてみてください。

- スラッシュコマンドで即操作：`/web` で Web 検索を許可、`/refresh` で Gemini セッションをリフレッシュ、`/handover` で会話の引き継ぎスナップショット保存、`/clear` で会話リセットなどがワンアクションで実行できます。
- レスキューチャット：メイン画面が破損しても、レスキューチャットアプリで復旧作業ができます。
- 通知制御：AI に「通知設定を見せて」などと尋ねると、現在の通知ポリシーや通知間隔を確認でき、必要に応じて設定変更の提案も受けられます。
- コンテキストモードの自動切り替え：`/api/context/signals` を叩くだけでモードの `enter/exit` を切り替えられるため、スマホのオートメーションや外部スクリプトからコンテキストモードを自動切り替えできます。
- 休憩と再開のトラッキング：チャットから「休憩したい」「再開したい」と伝えると、`log.break` / `log.resume` を使って正確にセッションを区切り、タイムラインへ反映します。
- ドキュメント：AI に「docs を読んで」と頼むと、対象ドキュメントを読み込んだうえで解説や変更案を提示してくれます。


## アーキテクチャ

### サーバー側の実装

#### メインサーバー (`webnew/server.js`)
- ルートの `webnew/server.js` は Next.js をラップした Node.js サーバー
- HTTP/HTTPS サーバーと ws による WebSocket を直接構築
- 環境変数の読み込み（dotenv）やポート解決を行います

#### REST エンドポイント
サーバーは以下の REST 風エンドポイントを自前で実装：
- `/api/chat/restart` - チャット再起動
- `/api/notify/*` - 通知決定・ログ再送・VAPID 鍵配布・リマインダー管理
- `/api/context/*` - コンテキスト管理

#### WebSocket (`/ws`)
WebSocket `/ws` では以下の JSON-RPC 形式でリアルタイム制御：
- チャット履歴同期
- Gemini セッション再生成
- ユーザーメッセージ送信
- ツール呼び出し許可

### Gemini との連携

#### バックグラウンド処理
- Gemini との連携はバックグラウンドで `@google/gemini-cli` を `BackgroundGemini` からサブプロセス起動する構成
- `server-wrapper.js` がサーバー起動時に Gemini プロセスを確実に立ち上げます（sudo/uid 切り替えも考慮）

#### ツール実行許可ロジック
Gemini の背景処理ツール実行許可ロジックでは以下の Python スクリプトのみをホワイトリスト化：
- `manage_context.py` - コンテキスト状態管理
- `manage_log.py` - 学習ログ管理  
- `notify_tool.py` - 通知送信処理

SQLite で文脈状態・学習ログ・通知送信を管理します。

### レスキューサーバー
- 追加で `webnew/rescue-chat-app/rescue-server.js` が別ポートで動く Next.js ベースのレスキュー用サーバーを提供
- 接続するGeminiプロセスはメインサーバーと同じものなので、メインサーバーのクライアントクラッシュ時にも続けて会話・コード修正が行えます


## プロジェクト構造

```
FlexiStudy/
├── GEMINI.md                    # Gemini CLIのメインコンテキスト、設定、運用ルール
├── manage_context.py            # コンテキスト（モード、リマインダーなど）を管理
├── manage_log.py                # 学習ログの記録、取得、集計
├── manage_log.log               # 学習ログファイル
├── notify_tool.py               # 通知の送信を処理
├── package.json                 # プロジェクト全体の依存関係とスクリプト定義
├── setup.sh                     # プロジェクトの初期設定スクリプト
├── docs/                        # プロジェクトに関する各種ドキュメント
└── webnew/                      # Next.jsベースのWebアプリケーション
    ├── background-gemini.js     # Gemini CLIをバックグラウンドで実行
    ├── components.json          # UIコンポーネントの設定ファイル
    ├── next-env.d.ts            # Next.jsの型定義ファイル
    ├── next.config.mjs          # Next.jsの設定ファイル
    ├── package.json             # Webアプリケーションの依存関係とスクリプト定義
    ├── postcss.config.mjs       # PostCSSの設定ファイル
    ├── server-wrapper.js        # サーバーのラッパーファイル
    ├── server.js                # カスタムNext.jsサーバーのメインファイル
    ├── server.js.acp-impl       # ACP実装関連ファイル
    ├── sw.js                    # Service Workerファイル
    ├── tailwind.config.ts       # Tailwind CSSの設定ファイル
    ├── tsconfig.json            # TypeScriptの設定ファイル
    ├── app/                     # Next.jsのルーティングとページコンポーネント
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── page.tsx
    │   └── api/                 # APIルート
    ├── certs/                   # 証明書関連ファイル
    ├── components/              # 再利用可能なReactコンポーネント
    │   ├── dashboard.tsx
    │   ├── settings.tsx
    │   └── ui/                  # UIコンポーネント
    ├── context/                 # React Context APIの定義
    ├── data/                    # アプリケーションで使用するデータファイル
    ├── hooks/                   # カスタムReactフック
    ├── lib/                     # ユーティリティ関数やヘルパー
    ├── notify/                  # 通知機能に関する設定やプロンプト
    │   └── config/
    ├── public/                  # Webアプリケーションの静的アセット
    ├── rescue-chat-app/         # 緊急時用のチャットアプリケーション
    │   └── rescue-server.js     # レスキューサーバー
    ├── scripts/                 # Webアプリケーション関連のスクリプト
    └── styles/                  # Webアプリケーションのスタイルシート
```


## 開発

### 関連ソースコード

- **メインサーバー:** `webnew/server.js`
- **Gemini 背景処理:** `webnew/background-gemini.js`
- **サーバー起動ラッパー:** `webnew/server-wrapper.js`
- **レスキューサーバー:** `webnew/rescue-chat-app/rescue-server.js`
- **Python 補助ツール:** `manage_context.py`, `manage_log.py`, `notify_tool.py`

### フロント依存・スクリプト

フロントエンドの依存関係は `webnew/package.json` で管理されています。

### 動作手順

#### セットアップ
- 依存パッケージ・証明書・Node/Python 環境を整える `setup.sh` を実行すると、`pnpm install` や SQLite 初期化、`.env.local` 作成、`npx @google/gemini-cli@0.5.5` による認証案内まで自動化されます

#### 開発サーバー起動
- 開発サーバーは `cd webnew && sudo -E pnpm run dev 2>&1 | cat`（実体は `node server-wrapper.js`）で起動します
- `sudo` 無しの `pnpm run dev` でも起動できますが、一部機能が動作しない場合があります

#### 起動確認
- `setup.sh` によるセットアップが問題なく完了していれば、以下のコマンドで起動します：
  ```bash
  cd webnew
  sudo -E pnpm run dev 2>&1 | cat
  ```
- （`sudo` 無しの `pnpm run dev` でも起動できますが、一部機能が動作しない場合があります）
