## 作業引き継ぎ資料: 新規チャットパネル実装

### 1. タスクの目標

既存のWebアプリケーション (`web/public/js/chat.js`) のチャット機能を、新しいNext.jsアプリケーション (`webnew` ディレクトリ以下) のコンポーネント (`webnew/components/new-chat-panel.tsx`) として完全に再現すること。特に、`chat.js`の「繊細な」挙動（思考中表示、ツールカードの動的な更新、スクロール挙動など）の再現が求められています。

### 2. 現在の作業状況

*   **新規コンポーネントの作成:**
    *   `webnew/components/new-chat-panel.tsx` が作成され、基本的なチャットUI（メッセージ表示エリア、入力欄、送信ボタン）が実装されています。
    *   `webnew/hooks/useChat.ts` が作成され、WebSocket接続の管理、メッセージの状態管理、メッセージ送受信の基本的なロジックが組み込まれています。
*   **UI統合:**
    *   `webnew/app/page.tsx` に `NewChatPanel` が組み込まれ、`webnew/components/sidebar.tsx` に新しいチャットパネルを開くためのボタンが追加されています。
*   **WebSocket接続の調整:**
    *   `webnew/server.js` がWebSocketサーバーをポート `3001` で起動していることを確認しました。
    *   `webnew/hooks/useChat.ts` のWebSocket接続URLを `ws://${window.location.hostname}:3001/ws` に修正しました。

### 3. 発生している問題と課題

*   **WebSocket接続の不安定さ:**
    *   `ws://localhost:3001/ws` への接続を試みていますが、ユーザーからは「websocketの接続が確立できてないみたい」との報告があります。環境依存の可能性も考慮し、接続の安定性を再確認する必要があります。
*   **`chat.js`機能の再現不足:**
    *   ユーザーから「chat.jsの機能が中々再現しきれてないな、結構繊細なんだよなあいつ、再現するには…」とのフィードバックがあり、特に以下の「繊細な」挙動の再現が不十分であると推測されます。
        *   **`active`変数の挙動:** `chat.js`では、`active`変数が思考中バブルやアシスタントメッセージのストリーム処理の状態を管理しています。これには、思考中表示の開始・更新・終了、メッセージの確定などが含まれます。現在のReact実装でこの状態遷移が正確に再現されているか要確認です。
        *   **ツールカードの動的な更新:** `chat.js`では`toolCards`と`pendingBodies`というMapを使用して、ツールカードのヘッダー情報とボディコンテンツが非同期に届く場合でも正しく更新されるように制御しています。特に`pushToolCall`と`updateToolCall`の連携が重要です。
        *   **スクロール挙動:** `chat.js`の`scrollBottom`関数は、ユーザーがチャットの最下部に近い場合にのみ自動スクロールを行うという「繊細な」挙動を持っています。履歴読み込み時のスクロール位置維持も考慮されています。
        *   **WebSocketメッセージ処理の順序と状態遷移:** `chat.js`の`ws.addEventListener('message', ...)`内の`if`/`else if`の順序と、それらが`active`状態や`toolCards`に与える影響が非常に重要です。このロジックをReactの`useState`や`useRef`、`useEffect`で正確に再現する必要があります。

### 4. 次のGeminiエージェントへの引き継ぎ事項

1.  **WebSocket接続の最終確認とデバッグ:**
    *   `webnew`アプリケーションが `http://localhost:3000` で、WebSocketサーバー (`webnew/server.js`) が `ws://localhost:3001` でそれぞれ正しく起動していることを確認してください。
    *   ブラウザの開発者ツール（コンソール、ネットワークタブ）を使用して、WebSocket接続が確立されているか、エラーが発生していないか、メッセージが正しく送受信されているかを詳細に確認してください。
    *   必要であれば、`webnew/server.js`と`webnew/hooks/useChat.ts`にデバッグログを追加し、メッセージのフローを追跡してください。

2.  **`web/public/js/chat.js`のメッセージ処理ロジックの徹底的な再分析と移植:**
    *   `chat.js`の `ws.addEventListener('message', ...)` ブロックを再度、**行単位で**詳細に分析してください。
    *   特に、`streamAssistantThoughtChunk`, `streamAssistantMessageChunk`, `agentMessageFinished`, `messageCompleted`, `pushToolCall`, `updateToolCall`, `pushChunk`, `pushMessage`, `fetchHistory` の各メッセージタイプが、`active`変数、`toolCards`、`pendingBodies`、`history`といったグローバル変数にどのように影響を与えているかを正確に把握してください。
    *   これらの挙動を、`webnew/hooks/useChat.ts` 内のReactのstate (`useState`) とref (`useRef`) を用いて、**可能な限り忠実に**再現してください。特に、状態の更新順序と依存関係に注意を払ってください。
    *   `chat.js`の`resetActive()`関数が、`active`変数を`null`にし、`#typingBubble`をDOMから削除する挙動を、Reactのstate管理でどのように実現するかを検討してください。
    *   `generateContextualDiffHtml`のようなユーティリティ関数も、必要に応じて正確に移植してください。

3.  **スクロール挙動の再現:**
    *   `chat.js`の `isNearBottom()` と `scrollBottom()` 関数のロジックを分析し、`new-chat-panel.tsx` の `useEffect` や `useRef` を用いて、自動スクロールと履歴読み込み時のスクロール位置維持を正確に再現してください。

4.  **UIの最終調整:**
    *   `useChat.ts`からのデータが正確になったら、`new-chat-panel.tsx`のUIがそのデータを適切に表示しているかを確認し、必要に応じてCSSやコンポーネントの構造を微調整してください。

このタスクは、元のJavaScriptコードの深い理解と、それをReactのベストプラクティスに適合させるための慎重な作業が求められます。頑張ってください！