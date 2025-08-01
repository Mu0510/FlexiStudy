# Gemini CLI - タスク引き継ぎ資料

## 1. 全体目標

チャットUIの改善: ファイル添付表示、スクロールベースの履歴読み込み、および自動スクロール動作の洗練。

## 2. 主要な知識

*   プロジェクトは、`webnew/`にNext.js/ReactチャットUIを持つGemini CLIアプリケーションです。
*   WebSocket (`webnew/server.js`) がクライアント-サーバー間の通信に使用されます。
*   ファイルアップロードは`webnew/app/api/upload/route.ts`で処理され、1GBの制限があります。
*   `webnew/hooks/useChat.ts`がクライアント側のチャット状態とWebSocketを管理します。
*   `webnew/components/new-chat-panel.tsx`が主要なチャットUIコンポーネントです。
*   ファイル添付情報は`[System]`メッセージを介してAIに伝えられます。
*   履歴読み込みは、初回30メッセージ、以降20メッセージずつロードされます。
*   `web/public/js/chat.js`ファイルはスクロールロジックの参考として使用されました。

## 3. ファイルシステムの状態

*   **MODIFIED: `webnew/hooks/useChat.ts`**
    *   `Message`インターフェースを`files`を含むように拡張し、`sendMessage`がファイルデータを処理するように更新。
    *   `isFetchingHistory`と`historyFinished`をUI状態管理のためにエクスポート。
    *   **Thoughtメッセージのレンダリング改善のため、`activeMessage`の処理ロジックを修正済み。**
*   **MODIFIED: `webnew/components/new-chat-panel.tsx`**
    *   `handleSendMessage`がファイルデータを渡すように更新。
    *   ローディングインジケーター付きのスクロールベース履歴読み込みを実装。
    *   メッセージ送信時および受信時の自動スクロールロジックを洗練しようと試行中。
    *   **自動スクロールのロジックを複数回修正したが、まだ完全には機能していない状態。**
    *   **AI応答中でも入力欄に入力できるように変更済み（アップロード中は除く）。**
    *   **停止ボタンが押せなくなる問題を修正済み。**
*   **MODIFIED: `webnew/app/api/upload/route.ts`**
    *   アップロードAPIの応答を、アップロードされた各ファイルの`name`、`path`、`size`を含む`files`配列を含むように変更。
*   **MODIFIED: `webnew/server.js`**
    *   `sendUserMessage`がAI向けにファイル詳細を含む`[System]`メッセージを構築するように変更。
    *   `thought`メッセージが`streamAssistantMessageChunk`によって上書きされるバグを修正。
    *   **Thoughtメッセージのレンダリング改善のため、ストリーミングパーサーを導入し、`streamAssistantMessageChunk`の処理を簡素化済み。**

## 4. 最近の行動

*   プロジェクトのコンテキストと初期タスクの引き継ぎを確認。
*   チャットUIでのファイル添付表示のための変更を実装しコミット。
*   スクロールベースの履歴読み込みのための変更を実装しコミット。
*   iOSのスクロールジャンプ問題の修正を試みたが、新たな問題が発生したため変更を元に戻した。
*   メッセージ送信時（常に最下部へスクロール）および受信時（最下部にいる場合のみ条件付きスクロール）の新しい自動スクロールロジックを実装しコミット。
*   `server.js`と`useChat.ts`のメッセージブロードキャストロジックを修正することで、`thought`メッセージがレンダリングされないバグを調査し修正。
*   **自動スクロールの再修正を複数回試行:**
    *   `useLayoutEffect`と`useRef`を組み合わせ、コンテンツの高さの変化やメッセージの追加を検知してスクロールを試みた。
    *   `isNearBottom()`の判定タイミング（DOM更新前か後か）が問題であるとの指摘を受け、`shouldScrollToBottomRef`などのRefを導入し、DOM更新前のスクロール状態を記憶するロジックを試みた。
    *   デバッグログを追加して状況把握を試みた。
    *   **現状の問題点:** メッセージ受信時の自動スクロールが依然として不安定。特に、DOM更新前のスクロール状態を正確に把握し、それに基づいてスクロールを実行するロジックの確立が課題。`useLayoutEffect`のトリガー条件と`isNearBottom()`の評価タイミングの調整が課題。
*   AI応答中でも入力欄に入力できるように変更（ファイルアップロード中は除く）。
*   停止ボタンが押せなくなる問題を修正。

## 5. 現在の計画

1.  **[PENDING] 自動スクロールの問題解決:**
    *   メッセージ受信時の自動スクロールが不安定な状態。
    *   特に、DOM更新前のスクロール状態を正確に把握し、それに基づいてスクロールを実行するロジックの確立が必要。
    *   `useLayoutEffect`のトリガー条件と`isNearBottom()`の評価タイミングの調整が課題。
    *   `webnew/components/new-chat-panel.tsx`の`useLayoutEffect`内のロジックを再検討し、`isNearBottom()`の評価がDOM更新の影響を受けないようにする必要がある。
    *   `scrollBottom(true)`の呼び出しが適切なタイミングで行われるように調整する。
2.  **[PENDING] ユーザーからの引き継ぎ指示を待機。**
