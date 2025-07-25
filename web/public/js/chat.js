let toolCards = new Map(); // toolCallId -> toolCardElement
let pendingBodies = new Map();

const CONTEXT_LINES = 3; // 表示する周辺行数

function generateContextualDiffHtml(oldText, newText, ctx = CONTEXT_LINES) {
  const patch = Diff.structuredPatch(
    'old', 'new',
    oldText, newText,
    '', '',                // ヘッダ用ラベルは空で OK
    { context: ctx }       // ここで抜粋行数を指定
  );

  let html = '<pre>';
  patch.hunks.forEach((h, hi) => {
    // --- 見出し行  ------------------------------------
    html += `<span class="hunk-header"> @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</span>\n`;

    // --- hunk 本体 ------------------------------------
    h.lines.forEach(line => {
      const cls = line[0] === '+' ? 'add'
                : line[0] === '-' ? 'del'
                : 'context';
      html += `<span class="${cls}">${line.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>\n`;
    });

    // --- hunk 区切り線 --------------------------------
    if (hi !== patch.hunks.length - 1) {
      html += '<hr class="diff-separator">\n';
    }
  });
  return html + '</pre>';
}

window.addEventListener('DOMContentLoaded', () => {
  // dvh のフォールバック
  function setVH() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);

  marked.setOptions({ breaks: true }); // 改行を <br> タグとして処理する

  const panel    = document.getElementById('chatPanel');
  const openBtn  = document.getElementById('chatOpenBtn');
  const closeBtn = document.getElementById('chatClose');
  const fullBtn  = document.getElementById('fullscreenToggle');
  const sendBtn  = document.getElementById('chatSend');
  const input    = document.getElementById('chatInput');
  const messages = document.getElementById('chatMessages');

  let currentBubble = null;       // <div id="typingBubble"> 要素
  let accumulatedText = '';       // 全チャンクを結合するバッファ

  let active = null; // { bubble, thoughtMode, text }

  function resetActive() {
    console.log('[DEBUG] resetActive');
    active = null;
    document.querySelector('#typingBubble')?.remove();
  }

  let oldestCursor = null; // いちばん古いメッセージID を保持
  const pendingHistory = new Set();
  const loadedIds = new Set();
  let oldestTs   = null;
  let finished   = false;

  
  let nextToolCallId = 1;           // 好きなスキームで

  // WebSocket 接続
  const ws = new WebSocket(`ws://${location.host}/ws`);
  window.ws = ws;  // ← これを1行追加！
  let requestId = 1;
  ws.addEventListener('message', e => {
    console.log('[DEBUG] Received WebSocket message:', e.data); // 追加
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      console.error('❌ JSON parse error on chunk:', err, e.data);
      return;
    }
    ['pushToolCall','pushChunk','updateToolCall',
     'pushMessage','streamAssistantMessageChunk'].includes(msg.method)
      && console.log('[ACP]', msg.method, msg.params);
    

    if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
      // 実行ログを対応カードに追記
      const entry = toolCards.get(msg.params.callId ?? msg.params.toolCallId); // ← callId で引く
      if (entry) {
        let textContent = msg.params.chunk.text;
        // diff 行の色付け
        if (msg.params.chunk.type === 'diff') {
          textContent = textContent.split('\n').map(line => {
            if (line.startsWith('+')) {
              return `<span class="add">${line}</span>`;
            } else if (line.startsWith('-')) {
              return `<span class="del">${line}</span>`;
            }
            return line;
          }).join('\n');
        }
        entry.bodyElem.innerHTML += textContent; // innerHTML を使用して span タグを反映
        scrollBottom(); // autoScroll() の代わりに scrollBottom() を使用
      }
      return;
    }

    if (msg.method === 'pushMessage') {
      console.log('[DEBUG]', msg.method, JSON.stringify(msg.params, null, 2));
      // ツール完了後のふつうのアシスタント返信
      appendMsg('assistant-message', msg.params.content); // appendAssistantBubble() の代わりに appendMsg() を使用
      resetActive();             // ← 追加
      return;
    }

    if (msg.method === 'updateToolCall') {
      console.log('[DEBUG] updateToolCall msg.params:', msg.params); // 追加
      const card = toolCards.get(msg.params.callId ?? msg.params.toolCallId);
      if (!card) {
        console.warn(`Tool card with ID ${msg.params.callId ?? msg.params.toolCallId} not found.`);
        return;
      }

      const bodyEl = card.bodyElem;
      if (!bodyEl) return;

      if (msg.params.content) {
        let contentHtml = '';
        if (msg.params.content.type === 'markdown') {
          contentHtml = marked.parse(msg.params.content.markdown);
        } else if (msg.params.content.type === 'diff') {
          contentHtml = msg.params.content.content.map(d => {
            let line = d.value;
            if (line.startsWith('+')) {
              return `<span class="add">${line}</span>`;
            } else if (line.startsWith('-')) {
              return `<span class="del">${line}</span>`;
            }
            return line;
          }).join('\n');
          contentHtml = `<pre>${contentHtml}</pre>`; // preタグで囲む
        } else {
          contentHtml = `<pre>${JSON.stringify(msg.params.content, null, 2)}</pre>`;
        }
        bodyEl.innerHTML = contentHtml;
      }

      // ステータスに応じた表示更新
      if (msg.params.status === 'finished') {
        if (card) {
          card.cardElem.classList.add('tool-card--finished');
        }
        resetActive();           // ← 追加
      } else if (msg.params.status === 'error') {
        if (card) {
          card.cardElem.classList.add('tool-card--error');
        }
      }
      scrollBottom(true);
      return;
    }

    if (msg.method === 'pushToolCall') {
      // ----- ① 確認付きならダイアログへ -----
      if (msg.params.confirmation) {
        showToolConfirmationDialog(msg);   // この関数内で ACK を返している
        return;
      }

      // ----- ② 通常ツール呼び出し -----
      const toolId   = msg.params.toolCallId ?? msg.id;   // サーバがくれる ID を優先
      const { icon, label, locations } = msg.params;
      const command  = locations?.[0]?.path ?? '';

      createToolCard({ callId: toolId, icon, label, command });

      // Agent へ ACK を返す  ←★これが無いと止まる★
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id:      msg.id,        // 受信した pushToolCall の id
        result:  { id: toolId } // 自分で決めた toolId
      }));

      resetActive();
      return;
    }

    if (msg.method && msg.method !== 'streamAssistantMessageChunk') {
      handleNotification(msg);
      return;
    }

    if (msg.method === 'historyCleared'){
      messages.innerHTML = '';
      loadedIds.clear();
      oldestTs = null; 
      finished = false;
      pendingHistory.clear();
      return;
    }

    if (msg.role && msg.text){           // これは既存の if があるはず
      appendMsg(msg.role+'-message', msg.text);
      return;
    }

    if (msg.method === 'streamAssistantMessageChunk') {
      const { chunk } = msg.params;
      const shouldScroll = isNearBottom(); // チャンク処理前にスクロール位置を判定

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
        if (shouldScroll) scrollBottom(true); // 判定結果に基づいてスクロール
      }

      // ── text
      if (chunk.text !== undefined) {
        if (active.thoughtMode) {       // 初回 text → バブルを正式化
          active.bubble.remove();
          active.bubble     = appendMsgEl('assistant-message');
          active.thoughtMode = false;
          active.text        = '';
        }

        active.text += chunk.text.replace(/^\n+/, '');
        active.bubble.innerHTML = marked.parse(active.text.trimEnd());
        if (shouldScroll) scrollBottom(true); // 判定結果に基づいてスクロール
      }

      // ACK は id があるときだけ
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result:null }));
      }
      return;
    }

    // agentMessageFinished / messageCompleted でのみ完了判定
    if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
      resetActive();           // ← 既存処理を書き換え
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
        const toolId = params.toolCallId ?? id;
        // 確認ダイアログなどを挟むならここで outcome を決める
        ws.send(JSON.stringify({
          jsonrpc:'2.0',
          id,
          result:{ id: toolId, outcome:'allow'}
        }));

        if (!toolCards.has(toolId)){
          createToolCard({ callId: toolId, icon:params.icon, label:params.label, command:params.confirmation?.command||'' });
          // もし body が先に届いていたら注入
          if (pendingBodies.has(toolId)){
              const {status, content} = pendingBodies.get(toolId);
              updateToolCard({ callId:toolId, status, content });
              pendingBodies.delete(toolId);
          }
        } else {
          // 既に updateToolCall で仮カードが作られている。
          // headerPatch を payload にして updateToolCard を再利用
          updateToolCard({
            callId:  toolId,
            status:'running',        // body はいじらない
            content:{ __headerPatch:{ icon:params.icon, label:params.label, command:params.confirmation?.command||'' }}
          });
        }
        break;

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

        if (message.result && message.result.messages) {
            const arr = message.result.messages.slice();

            const prevScrollHeight = messages.scrollHeight; // スクロール位置を維持するために現在の高さを取得

            arr.forEach(m => {
                if (loadedIds.has(m.id)) return;

                if (m.type === 'tool') {
                    if (m.method === 'requestToolCallConfirmation' || m.method === 'pushToolCall') {
                        const id = m.params.toolCallId ?? m.id;
                        if (!toolCards.has(id)) {
                            createToolCard({ callId: id, icon: m.params.icon, label: m.params.label, command: m.params.confirmation?.command || m.params.locations?.[0]?.path || '' });
                        }
                    } else if (m.method === 'updateToolCall') {
                        const id = m.params.toolCallId;
                        if (!toolCards.has(id)) {
                            // 対応するカードがまだない場合、仮のカードを作成
                            createToolCard({ callId: id, icon: 'terminal', label: '(tool)', command: '' });
                        }
                        updateToolCard({
                            callId: id,
                            status: m.params.status,
                            content: m.params.content
                        });
                    }
                } else { // user / assistant / system
                    const role = m.role === 'user' ? 'user-message'
                               : m.role === 'assistant' ? 'assistant-message' : 'system';
                    const el = appendMsgEl(role);
                    el.innerHTML = marked.parse(m.text ?? '');
                    messages.appendChild(el);
                }
                loadedIds.add(m.id);
            });

            // スクロール位置を維持
            messages.scrollTop = messages.scrollHeight - prevScrollHeight;

            /* (3) 一番古い ts を次の before に使う */
            const limit = 5; // fetchHistory の limit

            /* (3) 一番古い ts を次の before に使う */
            oldestTs = arr[0]?.ts ?? oldestTs;

            /* (4) 返ってきた件数が limit 未満なら最後まで読んだと判断 */
            const newArr = arr.filter(m => !loadedIds.has(m.id));
            if (newArr.length < limit) finished = true;

            return;
        }
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

  function read_file(path) {
    const req = {
      jsonrpc: '2.0',
      id: ++requestId,
      method: 'read_file',
      params: { path }
    };
    ws.send(JSON.stringify(req));
  }

  function appendFileNotice(type, path) {
    const el = document.createElement('div');
    el.classList.add('file-notice');
    el.textContent = `✔ ${type} ${path}`;
    messages.appendChild(el);
    scrollBottom(); // 条件付きスクロール
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

  /* 全画面トグル（⛶⇆↙）を置き換え */
  let isFull          = false;
  let prevBasis       = null;   // flex-basis
  let prevMaxWidth    = null;   // max-width
  let prevPanelStyle  = null;   // インライン幅が全部ここにある

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
      scrollBottom(true); // レイアウト調整後にスクロール位置を最下部に (強制)
    }

    window.visualViewport.addEventListener('resize', adjustChatLayout);
    // 初期ロード時にも一度調整を実行
    adjustChatLayout();
  }

  // メッセージ追加（エラー含む）
  function appendMsg(role, text) {
    const el = appendMsgEl(role);
    el.innerHTML = marked.parse(text);
    scrollBottom(); // 条件付きスクロール
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
    scrollBottom(); // 条件付きスクロール
  }

  /**
   * 現在のスクロール位置がチャットエリアの最下部に近いかどうかを判定します。
   * @returns {boolean} 最下部に近い場合は true、そうでない場合は false。
   */
  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop <= messages.clientHeight + 5;
  }

  /**
   * チャットメッセージを一番下までスクロールします。
   * @param {boolean} force - true の場合、現在のスクロール位置に関わらず強制的にスクロールします。
   *                          false (または未指定) の場合、ユーザーが一番下に近い位置にいる場合のみスクロールします。
   */
  function scrollBottom(force = false) {
    // ユーザーが一番下に近い位置にいるか、強制スクロールが指定されている場合のみスクロール
    if (force || isNearBottom()) {
      messages.scrollTop = messages.scrollHeight;
    }
  }

  // 送信
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('input', autoGrow);
  function autoGrow(){
    input.style.height = 'auto';                       // 一旦リセット
    input.style.height = Math.min(input.scrollHeight,     // 中身の高さ
                    window.innerHeight*0.25) + 'px';// 25dvh で頭打ち
  }
  // Alt+Enter で送信、Enter 単押しで改行
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter' && e.altKey){
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
    scrollBottom(true); // メッセージ送信後に強制的に最下部までスクロール
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
    scrollBottom(); // 条件付きスクロール
    return bubble;
  }

  function finishAssistantMessage() {
    // この関数はもう使わない
  }

  // 履歴読み込み
  let histReqId = 10000;          // 衝突しない範囲で適当
  function requestHistory(){
    const id = ++histReqId;
    pendingHistory.add(id);
    ws.send(JSON.stringify({
      jsonrpc:'2.0',
      id,
      method:'fetchHistory',
      params:{ limit:20, before: oldestTs }
    }));
  }

  ws.addEventListener('open', () => {
    requestHistory();
    scrollBottom(true); // 初期表示時にも一番下までスクロール (強制)
  });

  messages.addEventListener('scroll', () => {
    // スクロール位置が上から30%以内になったら履歴を読み込む
    if (messages.scrollTop < messages.clientHeight * 0.3 && !finished) {
      requestHistory();
    }
  });

  function renderMessages(msgArray, { prepend = false } = {}) {
    msgArray.forEach(m => {
        let el;
        if (m.type === 'tool') { // type が 'tool' の場合
            el = document.createElement('div');
            el.classList.add('tool-message');
            // toolCard header
            el.innerHTML = `
                <div class="tool-message__header">
                    <i class="tool-message__icon ${m.params.icon}"></i>
                    <span class="tool-message__title">${m.params.label}</span>
                    <code class="tool-message__command">${m.params.confirmation?.command || ''}</code>
                </div>
            `;

            // ▼ body描画：params.content（or内容がなければ空文字）
            let body = '';
            if (m.params?.content) {
                const content = m.params.content;
                if (content.type === 'markdown' && content.markdown) {
                    body = marked.parse(content.markdown);
                } else if (content.type === 'diff') {
                    body = generateContextualDiffHtml(content.oldText, content.newText);
                } else if (typeof content === 'string') {
                    body = `<pre>${content}</pre>`;
                } else {
                    body = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
                }
            } else {
                body = '<span style="color:gray">（内容なし）</span>';
            }
            // toolCard body
            const bodyDiv = document.createElement('div');
            bodyDiv.classList.add('tool-message__body');
            bodyDiv.innerHTML = body;
            el.appendChild(bodyDiv);
        } else {
            const role = m.role === 'user' ? 'user-message'
                : m.role === 'assistant' ? 'assistant-message' : 'system';
            el = appendMsgEl(role);
            el.innerHTML = marked.parse(m.text);
        }

        if (prepend) messages.prepend(el); else messages.append(el);
        loadedIds.add(m.id);
    });
  }

  /**
   * ツールカードを生成し、チャットに表示します。
   * @param {object} params - ツール呼び出しのパラメータ
   * @param {string} params.callId - ツール呼び出しのID
   * @param {string} params.icon - アイコン名
   * @param {string} params.label - ツール名
   * @param {string} params.command - コマンド文字列
   */
  function createToolCard({ callId, icon, label, command }) {
    const card = document.createElement('div');
    card.classList.add('tool-card');
    card.dataset.toolCallId = callId; // IDをデータ属性として保存

    card.innerHTML = `
      <div class="tool-card__header">
        <i class="tool-card__icon ${icon}"></i>
        <span class="tool-card__title">${label}</span>
        <code class="tool-card__command">${command}</code>
      </div>
      <pre class="tool-card__body"></pre>
    `;

    messages.appendChild(card);
    toolCards.set(callId, {
      cardElem: card,
      bodyElem: card.querySelector('.tool-card__body')
    });
    scrollBottom(true);
    console.log('[DEBUG] createToolCard: card added to toolCards. callId:', callId, 'toolCards size:', toolCards.size); // 追加
    console.log('[DEBUG] toolCards content:', toolCards); // 追加
  }

  /**
   * ツールカードを更新します。
   * @param {object} params - ツール更新のパラメータ
   * @param {string} params.toolCallId - ツール呼び出しのID
   * @param {string} params.status - ツール実行ステータス (e.g., 'running', 'finished', 'error')
   * @param {object} params.content - ツールからの出力内容
   */
  function updateToolCard({ callId, status, content }) {
    const card = toolCards.get(callId);
    if (!card){
       /* まだヘッダが来ていない → 一旦キャッシュして return */
       pendingBodies.set(callId, { status, content });
       return;
    }

    /* ── 後から requestToolCallConfirmation が来て
          ちゃんとした icon / label / command が分かった場合に
          ヘッダーを書き換えられるようにする ── */
    if (content?.__headerPatch) {
      const { icon, label, command } = content.__headerPatch;
      const h = card.cardElem.querySelector('.tool-card__header');
      h.querySelector('.tool-card__icon').className = `tool-card__icon ${icon}`;
      h.querySelector('.tool-card__title').textContent   = label;
      h.querySelector('.tool-card__command').textContent = command;
      // headerPatch は body ではないのでここで return して良い
      return;
    }

    const bodyEl = card.bodyElem;
    if (!bodyEl) return;

    if (content) {
      let contentHtml = '';
      if (content.type === 'markdown') {
        contentHtml = marked.parse(content.markdown);
      } else if (content.type === 'diff') {
        contentHtml = generateContextualDiffHtml(content.oldText, content.newText);
      } else {
        contentHtml = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
      }
      bodyEl.innerHTML = contentHtml;
    }

    // ステータスに応じた表示更新
    if (status === 'finished') {
      card.cardElem.classList.add('tool-card--finished');
      resetActive();           // ← 追加
    } else if (status === 'error') {
      card.cardElem.classList.add('tool-card--error');
    }
    scrollBottom(true);
  }

});