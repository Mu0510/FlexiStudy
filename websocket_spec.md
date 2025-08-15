# Gemini CLI WebSocket JSON-RPC Specification

## 1. 概要

このドキュメントは、Gemini CLIのWebインターフェース（クライアント）とバックエンドサーバー（Node.js）間のリアルタイム通信で使用されるWebSocket上のJSON-RPC 2.0プロトコルの仕様を定義します。

外部アプリケーション（例：Python製音声アシスタント）がこの仕様に準拠することで、Gemini CLIのチャット機能と連携できます。

- **トランスポート:** WebSocket Secure (`wss://`)
- **プロトコル:** JSON-RPC 2.0
- **エンドポイント:** `wss://<hostname>:443/ws`
- **データ形式:** JSON

## 2. 接続

クライアントは指定されたエンドポイントにWebSocket接続を確立します。サーバーはHTTP/HTTPSサーバー上で動作しており、`/ws`パスへのリクエストをWebSocketにアップグレードします。

接続が意図せず切断された場合、クライアントは再接続を試みることが推奨されます。

## 3. 通信モデル

通信は、クライアントからの**リクエスト (Request)**と、サーバーからの**レスポンス (Response)**および**通知 (Notification)**によって構成されます。

- **リクエスト:** クライアントがサーバーに特定の処理を要求します。`id`フィールドを持ちます。
- **レスポンス:** サーバーがクライアントのリクエストに対して返す結果。リクエストと同じ`id`を持ちます。
- **通知:** サーバーがクライアントに一方的に情報を送信します。`id`フィールドを持ちません。AIの応答ストリームや状態変化の通知に使用されます。

## 4. クライアント → サーバー メソッド (Requests)

クライアントからサーバーへ送信する主要なリクエストメソッドです。

### 4.1. `sendUserMessage`

ユーザーからのチャットメッセージをサーバーに送信します。AIの応答生成をトリガーする最も基本的なメソッドです。

- **method:** `sendUserMessage`
- **params:** `object`
  - `chunks`: `array` - 現在は要素数1の配列。
    - `object`:
      - `text`: `string` - ユーザーが入力したメッセージ本文。
      - `messageId`: `string` - クライアント側で生成した一意のメッセージID。
      - `files` (optional): `array` - アップロードされたファイル情報。
        - `object`: `{ name: string, path: string, size: number }`
      - `goal` (optional): `object` - 関連付けられた学習目標。
      - `session` (optional): `object` - 関連付けられた学習セッションログ。
- **レスポンス:**
  サーバーはこのリクエストに対する直接の`result`をすぐには返しません。代わりに、後述するサーバーからの通知 (`streamAssistantMessageChunk`など) が送られてきます。最終的に、リクエスト`id`に対応する`result: null`のレスポンスが返されることで、一連のストリームが完了したことを示します。

**リクエスト例:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sendUserMessage",
  "params": {
    "chunks": [
      {
        "text": "こんにちは、今日の調子はどうですか？",
        "messageId": "user-msg-1678886400000"
      }
    ]
  }
}
```

### 4.2. `fetchHistory`

過去のメッセージ履歴を取得します。主にUIの無限スクロールで使用されます。

- **method:** `fetchHistory`
- **params:** `object`
  - `limit`: `number` - 取得するメッセージの最大数。
  - `before` (optional): `number` - このタイムスタンプより前のメッセージを取得します。
- **レスポンス:**
  - `result`: `object`
    - `messages`: `array` - メッセージオブジェクトの配列。

**リクエスト例:**
```json
{
  "jsonrpc": "2.0",
  "id": 10001,
  "method": "fetchHistory",
  "params": {
    "limit": 30,
    "before": 1678886400000
  }
}
```

### 4.3. `clearHistory`

サーバー上のチャット履歴をすべて消去し、Geminiのバックエンドプロセスを再起動します。

- **method:** `clearHistory`
- **params:** `{}` (空オブジェクト)
- **レスポンス:**
  - `result`: `null`

**リクエスト例:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "clearHistory",
  "params": {}
}
```

## 5. サーバー → クライアント メソッド (Notifications)

サーバーからクライアントへ送信される主要な通知メソッドです。これらを適切に処理することで、リアルタイムなチャット体験が実現されます。

### 5.1. `addMessage`

確定したメッセージ（ユーザーまたはAI）をチャット履歴に追加するようクライアントに通知します。

- **method:** `addMessage`
- **params:** `object`
  - `message`: `object` - メッセージオブジェクト。
    - `id`: `string` - 一意のメッセージID。
    - `ts`: `number` - タイムスタンプ。
    - `role`: `string` - `"user"` または `"assistant"`。
    - `text`: `string` - メッセージの本文 (Markdown形式)。
    - `files`, `goal`, `session` (optional): 関連データ。

**通知例:**
```json
{
  "jsonrpc": "2.0",
  "method": "addMessage",
  "params": {
    "message": {
      "id": "user-msg-1678886400000",
      "ts": 1678886400000,
      "role": "user",
      "text": "こんにちは、今日の調子はどうですか？"
    }
  }
}
```

### 5.2. `streamAssistantMessageChunk`

AIの応答をチャンク（断片）としてリアルタイムにストリーミングします。思考プロセスと実際の応答テキストの両方が含まれる可能性があります。

- **method:** `streamAssistantMessageChunk`
- **params:** `object`
  - `messageId`: `string` - このストリームが属するアシスタントメッセージのID。
  - `chunk`: `object`
    - `text` (optional): `string` - 応答テキストの断片。
    - `thought` (optional): `string` - AIの思考プロセスのテキスト。

**通知例:**
```json
{
  "jsonrpc": "2.0",
  "method": "streamAssistantMessageChunk",
  "params": {
    "messageId": "assistant-msg-1678886401000",
    "chunk": {
      "text": "こんにちは！"
    }
  }
}
```

### 5.3. ツール関連 (`pushToolCall`, `updateToolCall`, etc.)

AIがツールを使用する際の詳細な状態変化を通知します。

- **`pushToolCall`**: ツールの実行が開始されたことを示します。
- **`requestToolCallConfirmation`**: (Web UIでは自動承認) ツールの実行確認を要求します。
- **`updateToolCall`**: 実行中のツールの状態（ステータスや出力内容）を更新します。`content`にはMarkdownやdiff形式のテキストが含まれることがあります。

### 5.4. `historyCleared`

`clearHistory`リクエストが処理され、履歴が消去されたことを通知します。

- **method:** `historyCleared`
- **params:** `object`
  - `reason`: `string` - クリアされた理由 (`"command"`など)。

## 6. 基本的なシーケンス例

1.  **クライアント**が`sendUserMessage`リクエストを送信します。
    ```json
    { "jsonrpc": "2.0", "id": 1, "method": "sendUserMessage", "params": { ... } }
    ```
2.  **サーバー**は、そのユーザーメッセージを全クライアントにブロードキャストします。
    ```json
    { "jsonrpc": "2.0", "method": "addMessage", "params": { "message": { "role": "user", ... } } }
    ```
3.  **サーバー**は、AIの応答を`streamAssistantMessageChunk`通知でストリーミング開始します。
    ```json
    { "jsonrpc": "2.0", "method": "streamAssistantMessageChunk", "params": { "messageId": "...", "chunk": { "text": "もち" } } }
    { "jsonrpc": "2.0", "method": "streamAssistantMessageChunk", "params": { "messageId": "...", "chunk": { "text": "ろん" } } }
    { "jsonrpc": "2.0", "method": "streamAssistantMessageChunk", "params": { "messageId": "...", "chunk": { "text": "です！" } } }
    ```
4.  **サーバー**は、ストリーミングが完了すると、元のリクエストIDに対応するレスポンスを返します。
    ```json
    { "jsonrpc": "2.0", "id": 1, "result": null }
    ```
5.  **クライアント**は、この`result: null`のレスポンスを受け取ることで、一連の応答が完了したと判断します。UI上でストリーミング中だったメッセージを確定させます。
