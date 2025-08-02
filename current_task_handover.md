# Gemini CLI - タスク引き継ぎ資料

## 1. 全体目標

*   UIコンポーネントのダークモード対応完了。
*   チャットUIの改善: ファイル添付表示、スクロールベースの履歴読み込み、および自動スクロール動作の洗練。

## 2. 現在の最優先課題

**ダークモード対応に起因するライトモードのスタイル破壊の修正**

`study-records.tsx`のダークモード対応を行った際、ライトモードのスタイルが破壊される問題が発生しました。これは、ライトモード用の固定色指定クラスを、`dark:`プレフィックスを付けずにテーマ追従クラスに置き換えてしまったことが原因です。

同様の問題が、これまでダークモード対応を行った他のすべてのコンポーネントで発生している可能性があります。

**修正方針:**
各コンポーネントのライトモード時のスタイル指定（例: `bg-white`, `text-slate-800`）を元に戻し、`dark:`プレフィックスを使用してダークモード用のスタイルを別途指定します。（例: `className="bg-white dark:bg-card"`）

**影響範囲の可能性があるコンポーネントリスト:**
*   `webnew/components/dashboard.tsx`
*   `webnew/components/sidebar.tsx`
*   `webnew/components/mobile-header.tsx`
*   `webnew/components/settings.tsx`
*   `webnew/components/new-chat-panel.tsx`
*   `webnew/components/tool-card.tsx`
*   `webnew/components/tool-card-item.tsx`
*   `webnew/components/study-records.tsx` (修正済み)

## 3. 今後のタスク

1.  **[最優先] 上記コンポーネントのスタイル破壊の確認と修正**
2.  **[未着手] `analytics.tsx` のダークモード対応**
3.  **[未着手] `exam-analysis.tsx` のダークモード対応**
4.  **[保留中] チャットUIの自動スクロールの問題解決**
    *   メッセージ受信時の自動スクロールが不安定な状態。
    *   `webnew/components/new-chat-panel.tsx`の`useLayoutEffect`内のロジックを再検討する必要がある。

## 4. 主要な知識

*   プロジェクトは、`webnew/`にNext.js/ReactチャットUIを持つGemini CLIアプリケーションです。
*   WebSocket (`webnew/server.js`) がクライアント-サーバー間の通信に使用されます。
*   ファイルアップロードは`webnew/app/api/upload/route.ts`で処理され、1GBの制限があります。
*   `webnew/hooks/useChat.ts`がクライアント側のチャット状態とWebSocketを管理します。
*   `webnew/components/new-chat-panel.tsx`が主要なチャットUIコンポーネントです。
*   ファイル添付情報は`[System]`メッセージを介してAIに伝えられます。
*   履歴読み込みは、初回30メッセージ、以降20メッセージずつロードされます。

## 5. ファイルシステムの状態

*   **MODIFIED: `webnew/components/study-records.tsx`**
    *   ダークモード対応時のスタイル破壊を修正済み (`0e0cb96`)。
*   **MODIFIED: `webnew/components/new-chat-panel.tsx`, `tool-card.tsx`, `tool-card-item.tsx`**
    *   ダークモード対応済みだが、ライトモードのスタイルが破壊されている可能性があるため要確認。
*   **MODIFIED: `webnew/hooks/useChat.ts`**
    *   `Message`インターフェースを`files`を含むように拡張し、`sendMessage`がファイルデータを処理するように更新。
    *   `isFetchingHistory`と`historyFinished`をUI状態管理のためにエクスポート。
    *   `activeMessage`の処理ロジックを修正済み。
*   **MODIFIED: `webnew/server.js`**
    *   `sendUserMessage`がAI向けにファイル詳細を含む`[System]`メッセージを構築するように変更。
    *   `thought`メッセージが`streamAssistantMessageChunk`によって上書きされるバグを修正。
*   **MODIFIED: `webnew/app/api/upload/route.ts`**
    *   アップロードAPIの応答を、アップロードされた各ファイルの`name`、`path`、`size`を含む`files`配列を含むように変更。