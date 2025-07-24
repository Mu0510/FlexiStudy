window.addEventListener('DOMContentLoaded', () => {
  marked.setOptions({ breaks: false }); // 改行を <br> タグとして処理する

  const panel    = document.getElementById('chatPanel');
  const openBtn  = document.getElementById('chatOpenBtn');
  const closeBtn = document.getElementById('chatClose');
  const fullBtn  = document.getElementById('fullscreenToggle');
  const sendBtn  = document.getElementById('chatSend');
  const input    = document.getElementById('chatInput');
  input.style.color = 'white';

  // デバッグ：フォーカスイベント確認
  input.addEventListener("focus", () => console.log("input focused"));
  input.addEventListener("blur", () => console.log("input blurred"));
  const messages = document.getElementById('chatMessages');

  let currentBubble = null;       // <div id="typingBubble"> 要素
  let accumulatedText = '';       // 全チャンクを結合するバッファ

  let active = null; // { bubble, thoughtMode, text }

  let oldestCursor = null; // いちばん古いメッセージID を保持

  // WebSocket 接続
  const ws = new WebSocket(`ws://${location.host}/ws`);
  let requestId = 1;
  ws.addEventListener('message', e => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      console.error('❌ JSON parse error on chunk:', err, e.data);
      return;
    }
    

    if (msg.method && msg.method !== 'streamAssistantMessageChunk') {
      handleNotification(msg);
      return;
    }

    if (msg.method === 'streamAssistantMessageChunk') {
      const { chunk } = msg.params;

      // ─────────────────────────────
      // ① 新しい応答の開始判定
      //    ・active が無い  ＝ 1 本目
      //    ・active はあるが thoughtMode==false かつ
      //      今回は thought チャンク ＝ 2 本目以降の開始
      // ─────────────────────────────
      if (
          !active ||
          (chunk.thought !== undefined && active.thoughtMode === false)
      ) {
        active = {
          bubble: createTypingBubble(),
          thoughtMode: true,
          text: ''
        };
      }

      // ── thought
      if (chunk.thought !== undefined) {
        active.bubble.innerHTML = marked.parse(chunk.thought.trim());
        scrollBottom();
      }

      // ── text
      if (chunk.text !== undefined) {
        if (active.thoughtMode) {       // 初回 text → バブルを正式化
          active.bubble.remove();
          active.bubble     = appendMsgEl('assistant-message');
          active.thoughtMode = false;
          active.text        = '';
        }

        active.text += chunk.text.replace(/^[\r\n]+/, '');
        active.bubble.innerHTML = marked.parse(active.text.trimEnd());
        scrollBottom();
      }

      // ACK は id があるときだけ
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result:null }));
      }
      return;
    }

    // 終端シグナルで一度だけ finish
    if (msg.result === null) {
      active = null;
      return;
    }

    // ─── 4) RPC 応答（error も含む）
    if (msg.id !== undefined) {
      handleRpcResponse(msg);
      return;
    }

    // ─── 5) 既存のフォールバック（stdout/stderr はチャット外へ回すか無視）
    if (msg.stdout) {
      appendSystem(msg.stdout);  // system 用の表示に回す
    } else if (msg.stderr) {
      appendSystem(msg.stderr);
    }
  });

  // メッセージ処理関数
  /**
   * サーバ → クライアント の通知を一元処理
   */
  function handleNotification(message) {
    const { method, params, id } = message;
    switch (method) {
      case 'requestToolCallConfirmation':
        // 「Edit」や「execute」など、ツール実行の確認ダイアログ
        // readFile など fetch ベースのツールは自動承認
        // すべてのツール呼び出しを自動承認
        respondToolCall(id, 'allow');
        break;

      case 'pushToolCall': {
        console.log('[DEBUG] pushToolCall received, about to respond to tool call with id=', id);
        // (1) ツール呼び出しUIを生成
        const toolCallId = params.toolCallId ?? id;
        // ★ ここで typingBubble を終わらせる
        const thinking = document.querySelector('.thinking-bubble');
        if (thinking) thinking.remove();

        active = null;

        showToolInvocationUI({ ...params, toolCallId });
        ws.send(JSON.stringify({
          jsonrpc:'2.0',
          id,                     // 受け取った requestId
          result:{ id: toolCallId } // ← これだけで十分
        }));
        break;
      }

      case 'updateToolCall': {
        // ① UI 更新
        updateToolCallStatus(params);

        // ② Gemini へ ACK
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,          // 受け取った requestId をそのまま返す
          result: null // void メソッドなので null
        }));
        break;
      }

      

      default:
        console.warn(`Unhandled notification: ${method}`, params);
    }
  }

  /**
   * client→server のレスポンス受信処理
   */
  function handleRpcResponse(message) {
    if (message.error) {
      // エラーハンドリング
      console.error('RPC Error:', message.error);
      showRpcError(message.error);
    } else {
      // 任意の結果処理があればここで
      console.log('RPC Result:', message.result);
      if (message.result && message.result.command === 'runShellCommand') {
        // runShellCommand の結果を処理
        if (message.result.stdout) {
          try {
            const msgs = JSON.parse(message.result.stdout);
            if (msgs.length === 0) return; // これ以上なし

            // 古い順(新→旧)なので逆順で挿入
            const reversedMsgs = msgs.reverse();
            const prevScrollHeight = messages.scrollHeight;
            renderMessages(reversedMsgs, { prepend: true });
            // スクロール位置を維持
            messages.scrollTop = messages.scrollHeight - prevScrollHeight;
            oldestCursor = reversedMsgs[0].id; // 最も古いメッセージのIDを更新
          } catch (parseError) {
            console.error('Failed to parse stdout as JSON:', parseError, message.result.stdout);
            appendSystem(`エラー: チャット履歴の解析に失敗しました。${message.result.stdout}`);
          }
        }
      } else if (message.result) {
        // その他のRPC結果処理
        console.log('RPC Result:', message.result);
      }
    }
  }

  // Placeholder for UI components (User needs to implement these based on their UI framework)
  function showToolConfirmationDialog(message) {
    const { id: requestId, params } = message;
    console.log('Placeholder: showToolConfirmationDialog', requestId, params);
    // 例：組み込みの confirm ダイアログで許可/拒否
    const allow = confirm(`Confirm tool call: ${params.label}
Content: ${JSON.stringify(params.content, null, 2)}`);
    respondToolCall(requestId, allow ? 'allow' : 'reject');
  }

  function respondToolCall(requestId, outcome) {
    const response = {
      jsonrpc: '2.0',
      id: requestId,
      result: { id: requestId, outcome }
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * pushToolCall を受けてツールパネルを生成・表示
   * params.toolCallId をキーにして、後続の update で参照可能にする
   */
  function showToolInvocationUI({ toolCallId, label, icon, content, locations }) {
    // まず「ツール実行開始」のシステムメッセージを流す
    appendSystem(` ${label} を実行します…`);

    // もし locations があれば、ファイル名などの情報も出す
    if (Array.isArray(locations) && locations.length) {
      appendSystem(` ${locations.map(l => l.path).join(' , ')}`);
    }
  }

  /**
   * updateToolCall を受けて、該当パネルを更新
   */
  function updateToolCallStatus({ toolCallId, status, content }) {
    // ツール終了 or 中間結果をチャットに流す
    if (status === 'finished') {
      appendSystem(`✅ ツール「${toolCallId}」処理完了`);
    } else {
      appendSystem(`⏳ ツール「${toolCallId}」ステータス: ${status}`);
    }

    // content があれば中身をバブルで流す
    if (content) {
      if (content.type === 'markdown') {
        appendMsg('assistant-message', content.markdown);
      } else if (content.type === 'diff') {
        appendMsg('assistant-message', '```diff\n' +
          content.content.map(d=>d.value).join('') +
          '\n```'
        );
      } else {
        appendMsg('assistant-message', JSON.stringify(content, null, 2));
      }
    }
  }

  function showRpcError(error) {
    console.log('Placeholder: showRpcError', error);
    if (error.code === 8 && error.message.includes('RESOURCE_EXHAUSTED')) { // 8はGRPCのRESOURCE_EXHAUSTEDコード
      appendSystem('今日のクォータに達しました。16:00 (JST) にリセットされます。');
    } else {
      alert(`RPC Error: ${error.message}`);
    }
  }

  // Basic implementation for UI components
  function createPanel({ id, title, icon, body }) {
    const panelElement = document.createElement('div');
    panelElement.id = `tool-panel-${id}`;
    panelElement.classList.add('tool-panel');
    panelElement.innerHTML = `
      <div class="tool-panel-header">
        <h3>${title}</h3>
        <span class="tool-panel-status"></span>
      </div>
      <div class="tool-panel-body">${body || ''}</div>
    `;
    messages.appendChild(panelElement);

    return {
      open: () => {
        panelElement.style.display = 'block';
        scrollBottom();
      },
      setStatus: (status) => {
        const statusSpan = panelElement.querySelector('.tool-panel-status');
        if (statusSpan) statusSpan.textContent = status;
      },
      updateBody: (newBody) => {
        const bodyDiv = panelElement.querySelector('.tool-panel-body');
        if (bodyDiv) bodyDiv.innerHTML = newBody;
        scrollBottom();
      }
    };
  }

  function renderDiff(content) {
    // For simplicity, just stringify the diff content
    return `<pre>${JSON.stringify(content, null, 2)}</pre>`;
  }

  function renderToolContent(content) {
    // For simplicity, just stringify the content
    return `<pre>${JSON.stringify(content, null, 2)}</pre>`;
  }

  function renderLoadingSpinner() {
    return `<div>Loading...</div>`;
  }

  // 「resizer」要素を Pointer Events で掴めるように
  const resizer = document.getElementById('resizer');

  // Get references to the main layout elements
  const appContainer = document.getElementById('appContainer');
  const leftColumn = document.getElementById('leftColumn');
  // chatPanel is already defined as 'panel'

  // Variables for resize
  let startPos; // Stores e.clientX or e.clientY
  let startLeftColumnSize; // Stores leftColumn.offsetWidth or leftColumn.offsetHeight
  let startChatPanelSize; // Stores chatPanel.offsetWidth or chatPanel.offsetHeight

  // タッチデバイスを検出してリサイザーの幅を調整
  if (window.matchMedia('(pointer:coarse)').matches) {
    resizer.style.width = '25px'; // 例: 10px * 2.5 = 25px
  }

  resizer.addEventListener('pointerdown', startResize);

  function startResize(e) {
    e.preventDefault();
    document.addEventListener('pointermove', doResize);
    document.addEventListener('pointerup', stopResize);

    const isPortrait = window.matchMedia('(orientation: portrait)').matches;

    if (isPortrait) {
      startPos = e.clientY;
      startLeftColumnSize = leftColumn.offsetHeight;
      startChatPanelSize = panel.offsetHeight; // Use 'panel' for chatPanel
    } else {
      startPos = e.clientX;
      startLeftColumnSize = leftColumn.offsetWidth;
      startChatPanelSize = panel.offsetWidth; // Use 'panel' for chatPanel
    }
  }

  function doResize(e) {
    const isPortrait = window.matchMedia('(orientation: portrait)').matches;
    let delta;

    if (isPortrait) {
      delta = e.clientY - startPos;
      const newLeftColumnHeight = startLeftColumnSize + delta;
      const newChatPanelHeight = startChatPanelSize - delta;

      const minHeight = 200; // Minimum height for either panel
      if (newLeftColumnHeight >= minHeight && newChatPanelHeight >= minHeight) {
        leftColumn.style.height = `${newLeftColumnHeight}px`;
        panel.style.height = `${newChatPanelHeight}px`; // Use 'panel' for chatPanel
      }
    } else {
      delta = e.clientX - startPos;
      const newLeftColumnWidth = startLeftColumnSize + delta;
      const newChatPanelWidth = startChatPanelSize - delta;

      const minWidth = 200; // Minimum width for either panel
      if (newLeftColumnWidth >= minWidth && newChatPanelWidth >= minWidth) {
        leftColumn.style.width = `${newLeftColumnWidth}px`;
        panel.style.width = `${newChatPanelWidth}px`; // Use 'panel' for chatPanel
      }
    }
  }

  function stopResize() {
    document.removeEventListener('pointermove', doResize);
    document.removeEventListener('pointerup', stopResize);
  }

  // appendFileNotice の実装例
  function appendFileNotice(type, path) {
    const el = document.createElement('div');
    el.classList.add('file-notice');
    el.textContent = `✔ ${type} ${path}`;
    messages.appendChild(el);
    scrollBottom();
  }

  // 送信
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', e => {
    if (e.key === 'Enter') sendMessage();
  });
  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    appendMsg('user-message', text);
    createTypingBubble();         // **ここで一度だけ** 思考中バブルを作成
    accumulatedText = '';         // バッファ初期化

    const req = {
      jsonrpc: '2.0',
      id:      ++requestId,
      method:  'sendUserMessage',
      params:  { chunks: [{ text }] }
    };
    ws.send(JSON.stringify(req));
    input.value = '';
  }

  // 初期は開いた状態
  panel.style.display = 'flex';
  openBtn.style.display = 'none';

  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    openBtn.style.display = 'block';
    // メインを全幅に戻す
    document.getElementById('appContainer').style.gridTemplateColumns = '1fr';
  });

  openBtn.addEventListener('click', () => {
    panel.style.display = 'flex';
    openBtn.style.display = 'none';
    // 2列レイアウトに戻す
    document.getElementById('appContainer').style.removeProperty('grid-template-columns');
  });

  // 全画面切り替え
  fullBtn.addEventListener('click', () => {
    panel.classList.toggle('fullscreen');
  });

  function createTypingBubble() {
    // 既存の #typingBubble があれば削除
    document.querySelector('#typingBubble')?.remove();

    const chatArea = document.getElementById('chatMessages');
    const bubble   = document.createElement('div');
    bubble.id      = 'typingBubble';
    bubble.className = 'assistant-message typing';
    bubble.textContent = '…思考中…';
    chatArea.appendChild(bubble);
    return bubble;
  }

  function finishAssistantMessage() {
    // この関数はもう使わない
  }

  // メッセージ追加（エラー含む）
  function appendMsg(role, text) {
    const el = appendMsgEl(role);
    el.innerHTML = marked.parse(text);
    scrollBottom();
  }

  // appendMsg の DOM 生成部分を分離
  function appendMsgEl(role) {
    const el = document.createElement('div');
    el.classList.add(role);
    messages.appendChild(el);
    return el;
  }
  function appendSystem(text) {
    const el = document.createElement('div');
    el.classList.add('system');
    el.textContent = text;
    messages.appendChild(el);
    scrollBottom();
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  // 1. 起動時に最新5件をロード
  function loadRecent() {
    const req = {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'runShellCommand',
      params: {
        command: 'python3 /home/geminicli/GeminiCLI/manage_log.py get_chat_history 5',
        description: 'チャット履歴の最新5件を取得します。'
      }
    };
    ws.send(JSON.stringify(req));
  }

  // 2. スクロール上端で過去をロード
  function loadOlder() {
    if (!oldestCursor) return;
    const req = {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'runShellCommand',
      params: {
        command: `python3 /home/geminicli/GeminiCLI/manage_log.py get_chat_history 5 ${oldestCursor}`,
        description: `チャット履歴の過去5件をID ${oldestCursor} より古いものから取得します。`
      }
    };
    ws.send(JSON.stringify(req));
  }

  // 汎用レンダー関数
  function renderMessages(msgArray, { prepend = false } = {}) {
    msgArray.forEach(msg => {
      const div = document.createElement('div');
      // roleを決定 (user-message, assistant-message, system)
      let role = 'system'; // デフォルトはsystem
      if (msg.event_type === 'START' || msg.event_type === 'RESUME') {
        role = 'user-message'; // ユーザーの学習開始・再開はユーザーメッセージとして扱う
      } else if (msg.event_type === 'BREAK') {
        role = 'assistant-message'; // 休憩はアシスタントメッセージとして扱う
      }
      div.className = role;
      
      // メッセージ内容の整形
      let messageContent = '';
      if (msg.event_type === 'START') {
        messageContent = `学習開始: ${msg.subject} - ${msg.content}`;
      } else if (msg.event_type === 'RESUME') {
        messageContent = `学習再開: ${msg.subject} - ${msg.content}`;
      } else if (msg.event_type === 'BREAK') {
        messageContent = `休憩: ${msg.content || '休憩中'}`;
      } else {
        messageContent = msg.content; // その他のイベントタイプ
      }

      div.innerHTML = marked.parse(messageContent);
      div.dataset.messageId = msg.id; // メッセージIDをデータ属性として保存

      if (prepend) messages.prepend(div);
      else      messages.append(div);
    });
  }

  // イベント登録：上端に来たら loadOlder
  messages.addEventListener('scroll', () => {
    if (messages.scrollTop < 50) {
      loadOlder();
    }
  });

  // 初回ロードは WebSocket open イベントで呼ぶように変更済み
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.activeElement.blur();
  }
});