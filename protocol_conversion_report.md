# レポート: 新ACP(v0.2.2)と旧フロントエンドのプロトコル変換計画 (改訂版)

## 1. はじめに

### 1.1. 目的
`gemini-cli@0.2.2` の新しいACP(Agent Communication Protocol)で動作する現在の `server.js` と、安定稼働していた `master` ブランチのフロントエンド (`useChat.ts` 等) を連携させる。

### 1.2. 方針
`server.js` を「新ACPと通信する部分」と「フロントエンドと通信する部分」に分け、その間に**変換ロジック（アダプター）**を実装する。具体的には、`handleSessionUpdate`関数を修正し、新ACPからのデータを旧フロントエンドが期待する形式に変換して送信する。

---

## 2. `server.js` 修正対象コード

`webnew/server.js` ファイル内にある `handleSessionUpdate` 関数を、以下のコードで**完全に置き換えてください。**

このコードは、新ACPから `agent_thought_chunk` を受信した際に、旧フロントエンドが期待する `streamAssistantThoughtChunk` メソッドに変換して送信するロジックを実装したものです。他のメッセージ形式については、既存の互換性を維持しています。

```javascript
// handleSessionUpdate 関数 (このコードで完全に置き換えてください)
function handleSessionUpdate(upd, wss) {
  const nowTs = Date.now();

  switch (upd.sessionUpdate) {
    case 'agent_thought_chunk':
      ensureAssistantMessage(wss, nowTs);
      const thoughtChunk = upd.content?.type === 'text' ? upd.content.text : '';
      currentAssistantMessage.thought += thoughtChunk;
      // フロントエンド(master版)の期待に合わせて変換
      broadcast(wss, {
        jsonrpc: '2.0',
        method: 'streamAssistantThoughtChunk', // メソッド名を変更
        params: { thought: thoughtChunk }      // パラメータ構造を変更
      });
      break;

    case 'agent_message_chunk':
      ensureAssistantMessage(wss, nowTs);
      const textChunk = upd.content?.type === 'text' ? upd.content.text : '';
      currentAssistantMessage.text += textChunk;
      broadcast(wss, {
        jsonrpc: '2.0',
        method: 'streamAssistantMessageChunk',
        params: { messageId: currentAssistantMessage.id, chunk: { text: textChunk } }
      });
      break;

    case 'end_of_turn':
      flushAssistantMessage(wss, upd.stopReason);
      break;

    case 'tool_call':
      const toolCallId = upd.toolCallId || `tool-${nowTs}`;
      const toolMsg = {
        jsonrpc: '2.0',
        method: 'pushToolCall',
        params: {
          toolCallId: toolCallId,
          icon: upd.kind || 'tool',
          label: upd.title || String(upd.kind || 'tool'),
          locations: upd.locations || [],
        }
      };
      history.push({ ...toolMsg, ts: nowTs, type: 'tool' });
      broadcast(wss, toolMsg);
      break;

    case 'tool_call_update':
      let content = undefined;
      if (Array.isArray(upd.content) && upd.content.length > 0) {
        const c = upd.content[0];
        if (c.type === 'content' && c.content?.type === 'text') {
          content = { type: 'markdown', markdown: c.content.text };
        } else if (c.type === 'diff') {
          content = { type: 'diff', oldText: c.oldText || '', newText: c.newText || '' };
        }
      }
      const updateMsg = {
        jsonrpc: '2.0',
        method: 'updateToolCall',
        params: { toolCallId: upd.toolCallId, status: mapToolStatus(upd.status), content }
      };
      broadcast(wss, updateMsg);
      break;

    case 'plan':
      console.log('[ACP] Plan update with entries:', upd.entries?.length || 0);
      broadcast(wss, {
        jsonrpc: '2.0',
        method: 'updatePlan',
        params: { plan: upd.entries || [] }
      });
      break;
      
    case 'agent_state':
        // This can be used to show a generic "Agent is thinking..." state
        // console.log('[ACP] Agent state update:', upd.state);
        break;

    default:
      // console.log(`[ACP] Unhandled session update: ${upd.sessionUpdate}`);
  }
}
```

---

## 3. 実装手順

1.  **フロントエンドファイルの同期:**
    フロントエンド関連のファイルを `master` ブランチの安定版に戻します。以下のコマンドを実行してください。
    ```bash
    git checkout master -- webnew/hooks/useChat.ts webnew/components/new-chat-panel.tsx webnew/app/page.tsx
    ```

2.  **`server.js`の修正:**
    `webnew/server.js` を開き、既存の `handleSessionUpdate` 関数全体を、上記の**「2. `server.js` 修正対象コード」**に記載されているコードで完全に置き換えてください。