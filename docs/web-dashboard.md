# Web Study Dashboard

*Last updated: 2025-09-23*

## Access
- `http://localhost:3000` (開発環境) またはデプロイされたURLにアクセスすると学習ログを可視化するWebダッシュボードが起動します。

## Architecture
- **Frontend:** Next.js (React) を使用。
- **UI Components:** Shadcn UI (`@/components/ui/*`) を利用し、モダンなUIを提供。
- **State Management:** Reactの `useState`, `useEffect`, `useRef`, `useCallback` を中心に状態を管理。
- **API Integration:** `/api/logs/{date}`, `/api/dashboard`, `/api/subjects`, `/api/colors`, `/api/settings` などのRESTful APIエンドポイントと連携し、バックエンドからデータを取得・更新。
- **Real-time Sync:** WebSocket (`@/context/WebSocketContext`) と `useDbLiveSync` フック (`@/hooks/useDbLiveSync`) を使用し、バックエンドのDB更新をリアルタイムでフロントエンドに同期。
- **Offline Detection:** `useOnlineStatus` フック (`@/hooks/useOnlineStatus`) により、オフライン状態を検出しユーザーに通知。
- **Notifications:** Service Worker (`sw.js`) を利用したプッシュ通知機能。

## Features
- **ビュー切り替え:**
  - `records`: 特定の日付の学習ログ詳細を表示。
  - `dashboard`: 今日の学習時間、週間の学習時間、目標達成状況、連続学習日数などの概要を表示。
  - `analytics`: 学習データの分析結果を表示。
  - `exams`: 試験結果の分析を表示。
  - `settings`: アプリケーションの設定（科目ごとの色設定など）を管理。
  - `system-chat`: Gemini CLIとの対話インターフェースを提供。
- **学習記録表示:** `StudyRecords` コンポーネント (`@/components/study-records`) で、選択した日付の学習セッションとログエントリーを詳細に表示。
- **ダッシュボード概要:** `Dashboard` コンポーネント (`@/components/dashboard`) で、主要な学習統計と進捗を視覚的に表示。
- **目標管理:** `DailyGoalsCard` コンポーネント (`@/components/daily-goals-card`) で、今日の目標を表示し、達成状況を管理。チャットからの目標選択も可能。
- **最近の学習:** 最近の学習セッションの概要を表示し、クイックアクセスを提供。
- **チャット機能:** `NewChatPanel` コンポーネント (`@/components/new-chat-panel`) を通じて、Gemini CLIと対話。学習ログや目標、ファイルなどをコンテキストとしてチャットに渡すことが可能。
- **設定管理:** `Settings` コンポーネント (`@/components/settings`) で、学習科目の色設定などをカスタマイズし、バックエンドに保存。
- **データ同期:** バックエンドのDB更新イベントをWebSocketで受信し、フロントエンドの表示にリアルタイムで反映。
- **オフライン表示:** ネットワーク接続状態を検出し、オフライン時にはチャット送信を無効化するなどのUIフィードバックを提供。

## UI/UX Change Log
- `webnew/app/page.tsx` や `webnew/components/dashboard.tsx` などのコンポーネントの更新履歴を参照してください。

## Future Ideas
- `docs/roadmap.md` に記載されているプロダクトロードマップと連携し、新機能や改善を計画。
- 学習パターン分析による計画提案の自動化や、自動弱点分析と教材推薦など、AIを活用した高度な学習支援機能の統合。