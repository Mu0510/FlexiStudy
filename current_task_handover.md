## 作業引き継ぎ資料: 新規チャットパネル実装 (2025年7月31日更新)

### 1. 最終目標

既存のWebアプリケーション (`web/public/js/chat.js`) のチャット機能を、新しいNext.jsアプリケーション (`webnew` ディレクトリ以下) のコンポーネント (`webnew/components/new-chat-panel.tsx`) として完全に再現すること。特に、`chat.js`の「繊細な」挙動（思考中表示、ツールカードの動的な更新、スクロール挙動など）の再現が求められています。

### 2. 現在の作業状況と問題点

*   **新規コンポーネントの作成:**
    *   `webnew/components/new-chat-panel.tsx` が作成され、基本的なチャットUI（メッセージ表示エリア、入力欄、送信ボタン）が実装されています。
    *   `webnew/hooks/useChat.ts` が作成され、WebSocket接続の管理、メッセージの状態管理、メッセージ送受信の基本的なロジックが組み込まれています。
*   **UI統合:**
    *   `webnew/app/page.tsx` に `NewChatPanel` が組み込まれ、`webnew/components/sidebar.tsx` に新しいチャットパネルを開くためのボタンが追加されています。
*   **WebSocket接続の調整:**
    *   `webnew/server.js` がWebSocketサーバーをポート `3001` で起動しています。
    *   `webnew/hooks/useChat.ts` のWebSocket接続URLは `ws://${window.location.hostname}:3001/ws` に設定済みです。

**【未解決の問題】**

1.  **アシスタントのストリーミングメッセージが表示されない、または一瞬で消える:**
    *   **現象:** ユーザーがメッセージを送信すると、アシスタントの「思考中」メッセージ（`streamAssistantThoughtChunk`）は一瞬表示されるが、その後のアシスタントの返答（`streamAssistantMessageChunk`の`chunk.text`）が表示されない、または一瞬表示されてすぐに消えてしまう。
    *   **ログの観察:**
        *   `streamAssistantThoughtChunk`と`streamAssistantMessageChunk`の両方がクライアントに正常に受信され、`useChat.ts`内で`activeMessage.content`が更新されていることはコンソールログで確認済み。
        *   `activeMessage.content`のログは、`thought`の内容から`text`の内容へと正しく変化している。
        *   `useChat.ts`からサーバーへのACKも送信されている。
    *   **現在の推測される原因:**
        *   `chat.js`の`active`オブジェクトはDOM要素への直接参照を持ち、`innerHTML`を直接操作することでリアルタイム更新を実現していた。Reactの`useState`で管理される`activeMessage`は、DOM要素への直接参照を持たないため、`chat.js`と同じようなリアルタイム更新の挙動を再現できていない可能性がある。
        *   `streamAssistantMessageChunk`が`chunk.thought`と`chunk.text`の両方を持つ場合（または`thought`が先に、その後に`text`が来る場合）、`setActiveMessage`が同じイベントループ内で複数回呼び出され、状態が上書きされてしまうことで、UIの更新が追いついていない可能性がある。
        *   `activeMessage`の`id`は固定するように修正済みだが、`activeMessage.type`が`thought`から`assistant`に切り替わる際に、Reactのレンダリングサイクルが適切に処理できていない可能性がある。

2.  **WebSocketの二重接続（解消済みだが念のため記載）:**
    *   **現象:** 以前、WebSocket接続が複数回確立され、同じメッセージが二重に受信される問題があった。
    *   **対応:** `webnew/hooks/useChat.ts`の`useEffect`の依存関係を空配列`[]`に変更することで、コンポーネントマウント時に一度だけ接続が確立されるように修正済み。この問題は解消されているはず。

### 3. これまでの主な変更点

*   `webnew/hooks/useChat.ts`:
    *   `marked`ライブラリのインポートと、`streamAssistantThoughtChunk`, `streamAssistantMessageChunk`, `updateToolCall`, 履歴メッセージの処理における`marked.parse`の適用。
    *   `useEffect`の依存関係を空配列`[]`に変更し、WebSocketの二重接続を防止。
    *   `streamAssistantMessageChunk`の処理において、`chunk.thought`と`chunk.text`の両方を適切に処理し、`activeMessage`の`id`を固定し、`type`を適切に切り替えるように修正。
    *   `sendMessage`時に`activeMessage`を`null`にリセットするように修正。
*   `webnew/components/new-chat-panel.tsx`:
    *   `useChat`フックの統合。
    *   スクロールロジック（`isNearBottom`, `scrollBottom`）の実装。
    *   `messagesEndRef`の削除と`messagesContainerRef`への統一。
    *   `activeMessage.content`のデバッグログを追加。
*   `webnew/server.js`:
    *   WebSocketの`on('close')`, `on('error')`、およびGeminiプロセスの`on('close')`に詳細なログを追加。
    *   `streamAssistantMessageChunk`の処理で`ongoingText`が空でない場合の`history.push`の前にデバッグログを追加。

### 4. 次のGeminiエージェントへの引き継ぎ事項

1.  **アシスタントのストリーミングメッセージ表示問題の解決:**
    *   `webnew/hooks/useChat.ts`の`activeMessage`の状態更新ロジックを再検討し、`chat.js`の`active`オブジェクトの挙動（特に`thoughtMode`の切り替えとDOMの直接操作）をReactのState管理でどのように再現するかを深く分析してください。
    *   `activeMessage`の`type`が`thought`から`assistant`に切り替わる際に、UIがスムーズに更新されるように、`new-chat-panel.tsx`のレンダリングロジックを調整する必要があるかもしれません。
    *   Reactの`key`プロパティが正しく使用されているか、`activeMessage`の更新がReactのレンダリングサイクルに適切に組み込まれているかを確認してください。
    *   `useReducer`など、より複雑な状態管理パターンを検討することも有効かもしれません。

2.  **`chat.js`の`resetActive()`関数の完全な再現:**
    *   `chat.js`の`resetActive()`が`active`変数を`null`にし、`#typingBubble`をDOMから削除する挙動を、Reactのstate管理でどのように実現するかを再確認してください。

3.  **ツールカードの動的な更新の検証:**
    *   `pushToolCall`と`updateToolCall`の連携が正しく機能し、ツールカードのヘッダー情報とボディコンテンツが非同期に届く場合でも正しく更新されることを確認してください。

4.  **スクロール挙動の最終確認:**
    *   `chat.js`の `isNearBottom()` と `scrollBottom()` 関数のロジックが、`new-chat-panel.tsx`で正確に再現されていることを確認してください。

このタスクは、元のJavaScriptコードの深い理解と、それをReactのベストプラクティスに適合させるための慎重な作業が求められます。頑張ってください！
