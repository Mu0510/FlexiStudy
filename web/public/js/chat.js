window.addEventListener('DOMContentLoaded', () => {
  // dvh のフォールバック
  function setVH() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);

  marked.setOptions({ breaks: false }); // 改行を <br> タグとして処理する

  const panel    = document.getElementById('chatPanel');
  const openBtn  = document.getElementById('chatOpenBtn');
  const closeBtn = document.getElementById('chatClose');
  const fullBtn  = document.getElementById('fullscreenToggle');
  const sendBtn  = document.getElementById('chatSend');
  const input    = document.getElementById('chatInput');
  input.style.color = 'white';

  // デバッグ：フォーカスイベント確認
  input.addEventListener("focus", () => {
    console.log("input focused");
    input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
  input.addEventListener("blur", () => console.log("blurred"));
  const messages = document.getElementById('chatMessages');

  let currentBubble = null;       // <div id="typingBubble"> 要素
  let accumulatedText = '';       // 全チャンクを結合するバッファ

  let active = null; // { bubble, thoughtMode, text }

  let oldestCursor = null; // いちばん古いメッセージID を保持
  const pendingHistory = new Set();
  const loadedIds = new Set();
  let oldestTs   = null;
  let finished   = false;

  // WebSocket 接続
  const ws = new WebSocket(`ws://${location.host}/ws`);
  window.ws = ws;  // ← これを1行追加！
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

    if (msg.method === 'historyCleared'){
      messages.innerHTML = '';
      loadedIds.clear();
      oldestTs = null; finished = false;
      pendingHistory.clear();
      return;
    }

    if (msg.role && msg.text){           // これは既存の if があるはず
      appendMsg(msg.role+'-message', msg.text);
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

        active.text += chunk.text.replace(/^[\n]+/, '');
        active.bubble.innerHTML = marked.parse(active.text.trimEnd());
        scrollBottom();
      }

      // ACK は id があるときだけ
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result:null }));
      }
      return;
    }

    // agentMessageFinished / messageCompleted でのみ完了判定
    if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
      active = null;
      document.querySelector('#typingBubble')?.remove();
      return;
    }
    // 裸の result:null は無視
    if (msg.result === null) return;

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
  function handleRpcResponse(message){
    /* --- fetchHistory 応答を先に処理 --- */
    if (pendingHistory.has(message.id) && message.result?.messages){
        pendingHistory.delete(message.id);

        const arr = message.result.messages;
        if(arr.length === 0){ finished = true; return; }

        /* (1) サーバは「新→古」の順で返すので reverse して古→新へ */
        const mapped = arr.slice().reverse().map(m => ({
            id:  m.id,
            ts:  m.ts,
            roleClass: m.role==='user' ? 'user-message'
                      : m.role==='assistant' ? 'assistant-message'
                      : 'system',
            text: m.text
        }));

        /* (2) 既に表示済みの id はスキップ */
        mapped.forEach(o=>{
            if (loadedIds.has(o.id)) return;          // ← ここが重複ブロック
            const el = appendMsgEl(o.roleClass);
            el.innerHTML = marked.parse(o.text);
            messages.prepend(el);
            loadedIds.add(o.id);
        });

        /* (3) 一番古い ts を次の before に使う */
        oldestTs = mapped[0].ts;

        /* (4) 返ってきた件数が limit 未満なら最後まで読んだと判断 */
        if (arr.length < 5) finished = true;

        scrollBottom(); // 履歴読み込み後に一番下までスクロール

        return;
    }

    /* ↓↓↓ 既存の sendUserMessage / エラー処理などはそのまま ↓↓↓ */
    if (message.error){
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
    const allow = confirm(`Confirm tool call: ${params.label}\nContent: ${JSON.stringify(params.content, null, 2)}`);
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

  // リサイザーのサイズを更新する関数
  function updateResizerSize() {
    const isPortrait = window.matchMedia('(orientation: portrait)').matches;
    const isCoarsePointer = window.matchMedia('(pointer:coarse)').matches;

    if (isCoarsePointer) {
      if (isPortrait) {
        resizer.style.height = '25px';
        resizer.style.width = '100%';
      } else {
        resizer.style.width = '25px';
        resizer.style.height = '100%';
      }
    } else {
      // 非タッチデバイスの場合のデフォルトスタイル（CSSで設定済み）
      // ここでは何もしないか、必要であればデフォルト値を設定
      resizer.style.removeProperty('width');
      resizer.style.removeProperty('height');
    }
  }

  // 初期ロード時にリサイザーのサイズを設定
  updateResizerSize();

  // 画面の向きが変わった時にリサイザーのサイズを更新
  window.matchMedia('(orientation: portrait)').addListener(updateResizerSize);

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
        leftColumn.style.flexBasis = `${newLeftColumnHeight}px`;
        panel.style.flexBasis = `${newChatPanelHeight}px`; // Use 'panel' for chatPanel
      }
    } else {
      delta = e.clientX - startPos;
      const newLeftColumnWidth = startLeftColumnSize + delta;
      const newChatPanelWidth = startChatPanelSize - delta;

      const minWidth = 200; // Minimum width for either panel
      if (newLeftColumnWidth >= minWidth && newChatPanelWidth >= minWidth) {
        leftColumn.style.flexBasis = `${newLeftColumnWidth}px`;
        panel.style.flexBasis = `${newChatPanelWidth}px`; // Use 'panel' for chatPanel
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
  input.addEventListener('input', autoGrow);
  function autoGrow(){
    input.style.height = 'auto';                       // 一旦リセット
    input.style.height = Math.min(input.scrollHeight,     // 中身の高さ
                    window.innerHeight*0.25) + 'px';// 25dvh で頭打ち
  }
  // Shift+Enter で改行、Enter 単押しで送信
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){
      e.preventDefault();   // textarea の改行を抑止
      sendMessage();        // 既存関数を呼ぶ
    }
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

  /* 閉じる（×） */
  closeBtn.addEventListener('click', () => {
    panel.style.display   = 'none';
    resizer.style.display = 'none';
    openBtn.style.display = 'block';          // 右下 FAB
    // 左カラムを全幅に
    leftColumn.style.display = '';
  });

  /* 開く（右下 FAB）*/
  openBtn.addEventListener('click', () => {
    panel.style.display   = 'flex';
    resizer.style.display = '';               // 横/縦リサイズ復活
    openBtn.style.display = 'none';
    if(!isFull){                               // 通常レイアウト
      leftColumn.style.display = '';
    }
  });

  /* 先頭付近に退避用変数を用意 */
  let isFull          = false;
  let prevBasis       = null;   // flex-basis
  let prevMaxWidth    = null;   // max-width
  let prevPanelStyle  = null;   // インライン幅が全部ここにある

  /* 全画面トグル（⛶⇆↙）を置き換え */
  fullBtn.addEventListener('click', () => {
    isFull = !isFull;

    if (isFull) {
      // ── 入る前の状態を保存 ──
      prevBasis      = panel.style.flexBasis || '';
      prevMaxWidth   = panel.style.maxWidth  || '';
      prevPanelStyle = panel.getAttribute('style') || ''; // 念のため全部

      // ── ダッシュボードを隠し、幅100%へ ──
      leftColumn.style.display = 'none';
      resizer.style.display    = 'none';
      panel.style.flex         = '1 1 100%';
      panel.style.maxWidth     = '100%';     // ← これが効いて横いっぱい
      panel.style.flexBasis    = '100%';
      fullBtn.textContent      = '↙';
      openBtn.style.display    = 'none';

    } else {
      // ── 保存しておいた値で復元 ──
      leftColumn.style.display = '';
      resizer.style.display    = '';
      panel.style.flex         = '';
      panel.style.flexBasis    = prevBasis;
      panel.style.maxWidth     = prevMaxWidth;
      panel.setAttribute('style', prevPanelStyle); // さらに完全復元
      fullBtn.textContent      = '⛶';
    }
  });

  // visualViewport のリサイズイベントで入力エリアの位置を調整
  if (window.visualViewport) {
    const chatInputArea = document.getElementById('chatInputArea');
    const chatMessages = document.getElementById('chatMessages');

    function adjustChatLayout() {
      const visualViewportHeight = window.visualViewport.height;
      const visualViewportOffsetTop = window.visualViewport.offsetTop;
      const documentHeight = document.documentElement.clientHeight;

      // キーボードが表示されているかどうかの判定
      const isKeyboardShowing = (documentHeight - visualViewportHeight - visualViewportOffsetTop) > 0;

      if (isKeyboardShowing) {
        // キーボードが表示されている場合、入力エリアをキーボードの上に配置
        chatInputArea.style.bottom = `${documentHeight - visualViewportHeight - visualViewportOffsetTop}px`;
        // メッセージエリアのパディングを調整して、入力エリアがメッセージを隠さないようにする
        chatMessages.style.paddingBottom = `${chatInputArea.offsetHeight + 10}px`; // 10px は適当な余白
      } else {
        // キーボードが非表示の場合、入力エリアを通常の位置に戻す
        chatInputArea.style.bottom = `env(safe-area-inset-bottom)`;
        chatMessages.style.paddingBottom = '16px'; // デフォルトのパディングに戻す
      }
      scrollBottom(); // レイアウト調整後にスクロール位置を最下部に
    }

    window.visualViewport.addEventListener('resize', adjustChatLayout);
    // 初期ロード時にも一度調整を実行
    adjustChatLayout();
  }

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

  let histReqId = 10000;          // 衝突しない範囲で適当
  function requestHistory(){
    const id = ++histReqId;
    pendingHistory.add(id);
    ws.send(JSON.stringify({
      jsonrpc:'2.0',
      id,
      method:'fetchHistory',
      params:{ limit:5, before: oldestTs }
    }));
  }

  ws.addEventListener('open', () => {
    requestHistory();
    scrollBottom(); // 初期表示時にも一番下までスクロール
  });

  messages.addEventListener('scroll', () => {
    if (messages.scrollTop < 50 && !finished) {
      requestHistory();
    }
  });

  function renderMessages(msgArray, { prepend = false } = {}){
    msgArray.forEach(m=>{
        const role = m.role==='user'?'user-message':
                     m.role==='assistant'?'assistant-message':'system';
        const el = appendMsgEl(role);
        el.innerHTML = marked.parse(m.text);
        if(prepend) messages.prepend(el); else messages.append(el);
        loadedIds.add(m.id);               // ← 追加
    });
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.activeElement.blur();
  }
});