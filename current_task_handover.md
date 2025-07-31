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

1.  **ツールカードの更新が不完全、または表示されない:**
    *   **現象:** `pushToolCall` でツールカードのプレースホルダーは表示されるが、その後の `updateToolCall` や `pushChunk` で内容が更新されない、または更新されてもすぐに消えてしまう。
    *   **現在の推測される原因:** `useChat.ts` 内の `toolCardsData` の更新と `messages` 配列の同期に問題がある可能性がある。特に `Map` の更新が React の状態管理と適切に連携できていない可能性がある。

**【解決済みの問題】**

1.  **アシスタントのストリーミングメッセージ表示問題:**
    *   **現象:** ユーザーがメッセージを送信すると、アシスタントの「思考中」メッセージ（`streamAssistantThoughtChunk`）は一瞬表示されるが、その後のアシスタントの返答（`streamAssistantMessageChunk`の`chunk.text`）が表示されない、または一瞬表示されてすぐに消えてしまう。
    *   **解決:** `useChat.ts` の `ActiveMessage` インターフェースに `thoughtMode` を追加し、`streamAssistantThoughtChunk` と `streamAssistantMessageChunk` のロジックを `chat.js` の `active` オブジェクトの挙動に近づけた。`sendMessage` 時に初期の `activeMessage` を設定するように修正し、`new-chat-panel.tsx` で `marked.parse` を適用するようにした。
2.  **WebSocketの二重接続:**
    *   **現象:** 以前、WebSocket接続が複数回確立され、同じメッセージが二重に受信される問題があった。
    *   **解決:** `webnew/hooks/useChat.ts` の `useEffect` の依存関係を空配列`[]`に変更することで、コンポーネントマウント時に一度だけ接続が確立されるように修正済み。`requestHistory(true)` の呼び出しを WebSocket の `onopen` イベントリスナーの中に移動させた。
3.  **`result:null` で吹き出しが消える問題:**
    *   **現象:** `sendUserMessage` の RPC 応答として `result:null` が返ってきたタイミングで、ストリーミング中のアシスタントの吹き出しが消えてしまう。
    *   **解決:** `useChat.ts` の `result:null` 処理を修正し、`sendUserMessage` の `id` と一致する場合にのみ `setActiveMessage(null)` を呼び出すようにした。
4.  **`marked is not defined` エラー:**
    *   **現象:** `new-chat-panel.tsx` で `marked.parse` を使用しているにもかかわらず、`marked` が定義されていないというエラーが発生した。
    *   **解決:** `new-chat-panel.tsx` に `marked` ライブラリをインポートした。
5.  **`useChat.ts` の構文エラー:**
    *   **現象:** `webnew/hooks/useChat.ts` の `useEffect` ブロック内で構文エラーが発生した。
    *   **解決:** `ws.current.onopen`、`ws.current.onmessage`、`ws.current.onclose`、`ws.current.onerror` の各イベントハンドラの定義が `useEffect` のスコープ内に正しくネストされるように修正し、余分なセミコロンや閉じ括弧を削除した。

### 3. これまでの主な変更点 (詳細)

*   **`webnew/hooks/useChat.ts`:**
    *   `ActiveMessage` インターフェースに `thoughtMode` を追加。
    *   `streamAssistantThoughtChunk` と `streamAssistantMessageChunk` のロジックを `chat.js` の `active` オブジェクトの挙動に近づけ、`content` を生のテキストとして保持し、`thoughtMode` を適切に設定するように修正。
    *   `sendMessage` 関数を修正し、メッセージ送信時に初期の `activeMessage` を設定するように変更。
    *   `ToolCardData` インターフェースの `content` の型を `string` に変更。
    *   `pendingToolBodies` と `toolCards` (ref) を追加。
    *   `pushToolCall` のロジックを `chat.js` に合わせて修正し、`toolCardsData` にエントリを追加し、`messages` ステートに `role: 'tool'` のメッセージを追加するように変更。
    *   `updateToolCall` のロジックを `chat.js` に合わせて修正し、`pendingBodies` の処理と `__headerPatch` の処理を再現。`toolCardsData` と `messages` 配列内のツールメッセージの `content` を同期して更新するように変更。
    *   `pushChunk` (sender === 'tool') のロジックを修正し、`messages` 配列内のツールメッセージの `content` も更新するように変更。
    *   `jsdiff` ライブラリをインポートし、`generateContextualDiffHtml` 関数を `chat.js` の実装に合わせて修正。
    *   `ws.current.onopen` イベントリスナーの中に `requestHistory(true)` を移動。
    *   `result:null` 処理を修正し、`sendUserMessage` の `id` と一致する場合にのみ `setActiveMessage(null)` を呼び出すように変更。
    *   `ws.current.onmessage`、`ws.current.onclose`、`ws.current.onerror` の定義が `useEffect` のスコープ内に正しくネストされるように修正。
*   **`webnew/components/new-chat-panel.tsx`:**
    *   `marked` ライブラリをインポート。
    *   `activeMessage` の `thoughtMode` プロパティに基づいて `animate-pulse` クラスを適用するように修正。
    *   `marked.parse` の適用をレンダリング時に行うように修正。
    *   ツールカードのレンダリングロジックを `chat.js` に合わせて修正し、`tool-card--running`, `tool-card--finished`, `tool-card--error` クラスの適用や、`command` の表示を追加。
    *   履歴読み込み時のスクロール位置維持ロジックを追加。
*   **`webnew/package.json` & `webnew/pnpm-lock.yaml`:**
    *   `diff` (jsdiff) を `dependencies` に追加。

### 4. 次のGeminiエージェントへの引き継ぎ事項

1.  **ツールカードの更新の最終確認:**
    *   `pushToolCall`、`updateToolCall`、`pushChunk` の各メッセージがツールカードに正しく反映され、内容が動的に更新されることを確認してください。特に、`pendingBodies` の挙動が正しく再現されているか、`__headerPatch` が適用されているか、`diff` の表示が正しいかを確認してください。
2.  **スクロール挙動の最終確認:**
    *   メッセージの追加、ストリーミング、履歴読み込み時に、`chat.js` と同様の「繊細な」スクロール挙動（ユーザーが最下部に近い場合のみ自動スクロール、履歴読み込み時のスクロール位置維持）が再現されていることを確認してください。
3.  **全体的な動作確認とデバッグ:**
    *   上記以外の `chat.js` の機能（例: `cancelMessage`、`showToolConfirmationDialog` など）が正しく移植されているか、または代替手段が提供されているかを確認してください。
    *   WebSocket 接続が安定しているか、エラーが発生していないか、コンソールログを詳細に確認してください。
    *   UI の表示崩れや予期せぬ動作がないか、全体的に確認してください。

このタスクは、元のJavaScriptコードの深い理解と、それをReactのベストプラクティスに適合させるための慎重な作業が求められます。頑張ってください！