let toolCards = new Map(); // toolCallId -> toolCardElement
let pendingBodies = new Map();

// 旧バージョン generateContextualDiffHtml を全部置き換え
function generateContextualDiffHtml(oldText, newText, ctx = 3) {
  const patch = Diff.structuredPatch('old','new',oldText,newText,'','',{context:ctx});
  let html = '<pre>';
  patch.hunks.forEach((h, hi) => {
    let oldNum = h.oldStart;
    let newNum = h.newStart;
    h.lines.forEach(line => {
      if (line.includes('\ No newline at end of file')) return;
      let oldNumHtml = '', newNumHtml = '', lineClass = '';
      if (line.startsWith('+')) {
        lineClass = 'add';
        oldNumHtml = `<span class="line-num"></span>`;
        newNumHtml = `<span class="line-num new">${newNum++}</span>`;
      } else if (line.startsWith('-')) {
        lineClass = 'del';
        oldNumHtml = `<span class="line-num old">${oldNum++}</span>`;
        newNumHtml = `<span class="line-num"></span>`;
      } else {
        lineClass = 'context';
        oldNumHtml = `<span class="line-num old">${oldNum}</span>`;
        newNumHtml = `<span class="line-num new">${newNum}</span>`;
        oldNum++; newNum++;
      }
      const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      html += `<span class="${lineClass}">${oldNumHtml}${newNumHtml}${esc}</span>\n`;
    });
    if (hi !== patch.hunks.length - 1) html += '<hr class="diff-separator">\n';
  });
  html += '</pre>';
  return html;
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
  let isGeneratingResponse = false; // AIが応答を生成中かどうかを示すフラグ

  // チャットUIの状態を制御する関数
  function setChatUIState(generating) {
    isGeneratingResponse = generating;
    if (generating) {
      sendBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32"
             stroke="black" stroke-width="3" stroke-linecap="round"
             fill="none">
          <path d="M6 6L18 18M6 18L18 6"/>
        </svg>
      `; // 停止ボタンのアイコン
      sendBtn.removeEventListener('click', sendMessage);
      sendBtn.addEventListener('click', cancelMessage);
    } else {
      sendBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="32" height="32"
             stroke="black" stroke-width="3" stroke-linecap="round"
             fill="none">
          <path d="M12 5v14M5 12l7-7 7 7"/>
        </svg>
      `; // 送信ボタンのアイコン
      sendBtn.removeEventListener('click', cancelMessage);
      sendBtn.addEventListener('click', sendMessage);
    }
  }

  function resetActive() {
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
  let lastSentRequestId = null; // 最後に送信したリクエストのIDを保持
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
      updateToolCard({
        callId: msg.params.callId ?? msg.params.toolCallId,
        status: msg.params.status,
        content: msg.params.content
      });
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

      const shouldScroll = isNearBottom();
      const card = createToolCard({ callId: toolId, icon, label, command });
      messages.appendChild(card);
      if (shouldScroll) {
        requestAnimationFrame(() => {
          scrollBottom(true);
        });
      }

      // Agent へ ACK を返す  ←★これが無いと止まる★
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id:      msg.id,        // 受信した pushToolCall の id
        result:  { id: toolId } // 自分で決めた toolId
      }));

      resetActive();
      return;
    }

    if (msg.method === 'streamAssistantThoughtChunk') {
      const { thought } = msg.params;
      const shouldScroll = isNearBottom();

      if (!active) {
        active = {
          bubble: createTypingBubble(),
          thoughtMode: true,
          text: ''
        };
      }

      active.bubble.innerHTML = marked.parse(thought.trim());
      if (shouldScroll) scrollBottom(true);
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
      if (!active) {
        active = {
          bubble: createTypingBubble(),
          thoughtMode: false,
          text: ''
        };
      }

      // ── text
      if (chunk.text !== undefined) {
        // 常にバブルを正式化
        active.bubble.classList.remove('typing');
        active.bubble.classList.add('assistant-message');
        active.bubble.id = ''; // typingBubble の id を削除
        active.thoughtMode = false; // thoughtMode は常に false にリセット

        active.text += chunk.text.replace(/^\n+/, '');
        active.bubble.innerHTML = marked.parse(active.text.trimEnd()); // リアルタイム更新

        // 判定結果に基づいてスクロールを遅延実行
        if (shouldScroll) {
          requestAnimationFrame(() => {
            scrollBottom(true);
          });
        }
      }

      // ACK は id があるときだけ
      if (msg.id !== undefined) {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id: msg.id, result:null }));
      }
      return;
    }

    // agentMessageFinished / messageCompleted でのみ完了判定
    if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
      if (active) {
        active.bubble.innerHTML = marked.parse(active.text.trimEnd()); // 最終確定
      }
      resetActive();           // ← 既存処理を書き換え
      return;
    }

    // ─── 4) RPC 応答（error も含む）
    if (msg.id !== undefined) {
      // RPC レスポンスが result:null の場合、現在のメッセージの終了と判断
      if (msg.result === null) {
        setChatUIState(false); // UI状態をリセット
        resetActive();         // active状態と思考中バブルをリセット
      }
      handleRpcResponse(msg); // ← この行を元に戻します。
      return;
    }

    // ─── 5) 既存のフォールバック（stdout/stderr はチャット外へ回すか無視）
    // if (msg.stdout) {
    //   appendSystem(msg.stdout);  // system 用の表示に回す
    // } else if (msg.stderr) {
    //   appendSystem(msg.stderr);
    // }
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
          const card = createToolCard({ callId: toolId, icon:params.icon, label:params.label, command:params.confirmation?.command||'' });
          messages.appendChild(card);
          const shouldScroll = isNearBottom();
          if (shouldScroll) {
            scrollBottom(true);
          }
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
        const arr = message.result.messages.slice(); // Use slice to avoid modifying original array
        if (arr && arr.length) {
            // スクロール位置を保持
            const prevScrollHeight = messages.scrollHeight;
            const initialScrollTop = messages.scrollTop; // 履歴読み込み前のスクロール位置を記録

            // ドキュメントフラグメントにまとめて作成
            const frag = document.createDocumentFragment();
            arr.forEach(m => {
                if (loadedIds.has(m.id)) return;

                console.log('History message ID:', m.id, 'Type:', m.type, 'Method:', m.method, 'Params:', m.params); // ★この行を追加★

                const historicalToolCards = new Map(); // Map to hold tool card elements for this history batch

                // First pass: Process and consolidate tool calls
                arr.forEach(m => {
                    if (loadedIds.has(m.id)) return; // Skip already loaded messages

                    if (m.type === 'tool') {
                        const toolCallId = m.params.toolCallId ?? m.id;

                        if (m.method === 'pushToolCall' || m.method === 'requestToolCallConfirmation') {
                            // Create the tool card element
                            const el = createToolCard({
                                callId: toolCallId,
                                icon: m.params.icon,
                                label: m.params.label,
                                command: m.params.confirmation?.command || m.params.locations?.[0]?.path || ''
                            });
                            // Store it in our temporary map
                            historicalToolCards.set(toolCallId, el);

                            // Initial body content from pushToolCall (if any)
                            const bodyDiv = el.querySelector('.tool-card__body');
                            if (bodyDiv) {
                                let body = '';
                                if (m.params?.content) { // pushToolCall might have initial content
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
                                bodyDiv.innerHTML = body;
                                    // DOMレンダリング後に高さを調整
                                    requestAnimationFrame(() => {
                                        adjustToolCardBodyHeight(el, bodyDiv);
                                    });
                                }

                            } else if (m.method === 'updateToolCall') {
                                // Find the existing tool card element in our temporary map
                                const el = historicalToolCards.get(toolCallId);
                                if (el) {
                                    const bodyDiv = el.querySelector('.tool-card__body');
                                    if (bodyDiv) {
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
                                        bodyDiv.innerHTML = body;
                                        // DOMレンダリング後に高さを調整
                                        requestAnimationFrame(() => {
                                            adjustToolCardBodyHeight(el, bodyDiv);
                                        });
                                    }
                                    // Update status if needed
                                    if (m.params.status === 'finished') {
                                        el.classList.add('tool-card--finished');
                                    } else if (m.params.status === 'error') {
                                        el.classList.add('tool-card--error');
                                    }
                                }
                            }
                        }
                    });

                // Second pass: Append all messages (including consolidated tool cards) to the fragment
                // We need to maintain the original order of messages as they appeared in `arr`
                arr.forEach(m => {
                    if (loadedIds.has(m.id)) return; // Skip if already loaded/appended

                    let el;
                    if (m.type === 'tool' && (m.method === 'pushToolCall' || m.method === 'requestToolCallConfirmation')) { // ★この行を変更★
                        const toolCallId = m.params.toolCallId ?? m.id;
                        el = historicalToolCards.get(toolCallId);
                    } else if (m.type !== 'tool') { // For non-tool messages, create them as before
                        const role = m.role === 'user' ? 'user-message'
                                   : m.role === 'assistant' ? 'assistant-message' : 'system';
                        el = document.createElement('div');
                        el.classList.add(role);
                        el.innerHTML = marked.parse(m.text ?? '');
                    }

                    if (el) {
                        frag.appendChild(el);
                        loadedIds.add(m.id);
                    }
                });
            });

            // 先頭にまとめて挿入
            messages.insertBefore(frag, messages.firstChild);
            // 強制的にリフローを発生させる
            messages.offsetHeight; // Accessing offsetHeight forces a reflow

            // スクロール位置を保つ (requestAnimationFrame を2回ネストしてDOM更新後に実行)
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const newScrollTop = initialScrollTop + (messages.scrollHeight - prevScrollHeight);
                    messages.scrollTop = newScrollTop;
                    isFetchingHistory = false; // 履歴取得完了
                });
            });

            /* (3) 一番古い ts を次の before に使う */
            // arr は古い順（昇順）で並んでいるので、先頭が最も古い
            if (arr.length) {
              oldestTs = arr[0].ts;     // ← ここでだけ更新する
            }

            /* (4) 返ってきた件数が limit 未満なら最後まで読んだと判断 */
            // (4) 返ってきた件数が limit 未満なら最後まで読んだと判断
            const limit = 20; // fetchHistory の limit (web/server.js の limit と合わせる)
            if (arr.length < limit) { // newMessagesToRender.length === 0 の条件を削除
              finished = true;
            }

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
  console.log('chatPanel display:', panel.style.display);
  console.log('chatOpenBtn display:', openBtn.style.display);

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

      /*
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
      */
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
    const scrollHeight = messages.scrollHeight;
    const scrollTop = messages.scrollTop;
    const clientHeight = messages.clientHeight;
    const isNear = scrollHeight - scrollTop <= clientHeight + 5;

    console.log(`[DEBUG] isNearBottom: scrollHeight=${scrollHeight}, scrollTop=${scrollTop}, clientHeight=${clientHeight}, isNear=${isNear}`);
    return isNear;
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
      if (!isGeneratingResponse) {
        sendMessage();        // 既存関数を呼ぶ
      }
    }
  });

  function sendMessage() {
    if (isGeneratingResponse) return; // AI応答中は送信しない

    const text = input.value.trim();
    if (!text) return;
    appendMsg('user-message', text);
    createTypingBubble();         // **ここで一度だけ** 思考中バブルを作成
    accumulatedText = '';         // バッファ初期化

    setChatUIState(true); // メッセージ送信時にUIを更新

    const req = {
      jsonrpc: '2.0',
      id:      ++requestId,
      method:  'sendUserMessage',
      params:  { chunks: [{ text }] }
    };
    lastSentRequestId = req.id; // 最後に送信したリクエストのIDを保存
    ws.send(JSON.stringify(req));
    input.value = '';
    input.style.height = 'auto'; // 入力欄の高さをリセット
    input.focus(); // ← この行を追加
    scrollBottom(true); // メッセージ送信後に強制的に最下部までスクロール
  }

  function cancelMessage() {
    const req = {
      jsonrpc: '2.0',
      id: lastSentRequestId, // 最後に送信したリクエストのIDを使用
      method: 'cancelSendMessage',
      params: {}
    };
    ws.send(JSON.stringify(req));
    setChatUIState(false); // キャンセル時にUIをリセット
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
  let isFetchingHistory = false; // 履歴取得中フラグ

  function handleScroll() {
    // スクロール位置が上から1000px以内になったら履歴を読み込む
    if (messages.scrollTop < 1000 && !finished && !isFetchingHistory) {
      requestHistory();
    }
  }

  function requestHistory(isInitialLoad = false){
    console.log('[DEBUG] requestHistory called. isFetchingHistory:', isFetchingHistory, 'finished:', finished, 'isInitialLoad:', isInitialLoad);
    if (isFetchingHistory) return; // 既に取得中の場合は何もしない
    isFetchingHistory = true; // 取得開始
    console.log('[DEBUG] isFetchingHistory set to true.');

    const id = ++histReqId;
    pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20; // 初回読み込みは30件、それ以外は20件
    console.log('[DEBUG] Sending fetchHistory request with id:', id, 'before:', oldestTs, 'limit:', limit);
    ws.send(JSON.stringify({
      jsonrpc:'2.0',
      id,
      method:'fetchHistory',
      params:{ limit: limit, before: oldestTs }
    }));
  }

  ws.addEventListener('open', () => {
    requestHistory(true); // 初回読み込み
    scrollBottom(true); // 初期表示時にも一番下までスクロール (強制)
    setChatUIState(false); // 初期状態を設定
  });

  messages.addEventListener('scroll', handleScroll);

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
  function getToolIconText(iconName) {
    switch (iconName) {
      case 'pencil':
        return 'Edit';
      case 'search':
        return 'Search';
      case 'terminal':
        return 'Shell';
      case 'file':
        return 'File';
      case 'code':
        return 'Code';
      case 'web':
        return 'Web';
      case 'folder':
        return 'Dir';
      case 'info':
        return 'Info';
      default:
        return iconName; // 未知のアイコン名の場合はそのまま表示
    }
  }

  const PROJECT_ROOT_PATH = '/home/geminicli/GeminiCLI/';

  function getRelativePath(absolutePath) {
    if (absolutePath.startsWith(PROJECT_ROOT_PATH)) {
      return absolutePath.substring(PROJECT_ROOT_PATH.length);
    }
    return absolutePath;
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

    const iconText = getToolIconText(icon); // アイコン名からテキストを取得
    const displayCommand = getRelativePath(command); // パスを短縮

    card.innerHTML = `
      <div class="tool-card__header">
        <div class="tool-card__status-indicator"></div>
        <span class="tool-card__icon-text">${iconText}</span>
        <span class="tool-card__title">${label}</span>
        <div class="tool-card__line-break"></div> <!-- commandを次の行に表示するための要素 -->
        <code class="tool-card__command">${displayCommand}</code>
      </div>
      <pre class="tool-card__body"></pre>
    `;
    card.classList.add('tool-card--running'); // ツールカード作成時にrunningクラスを付与

    toolCards.set(callId, {
      cardElem: card,
      bodyElem: card.querySelector('.tool-card__body')
    });
    console.log('[DEBUG] createToolCard: card added to toolCards. callId:', callId, 'toolCards size:', toolCards.size); // 追加
    console.log('[DEBUG] toolCards content:', toolCards); // 追加
    return card; // 生成したカード要素を返す
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
      h.querySelector('.tool-card__icon-text').textContent = getToolIconText(icon);
      h.querySelector('.tool-card__title').textContent   = label;
      h.querySelector('.tool-card__command').textContent = getRelativePath(command);
      // headerPatch は body ではないのでここで return して良い
      return;
    }

    const shouldScroll = isNearBottom(); // DOM変更前に判定
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

      adjustToolCardBodyHeight(card.cardElem, bodyEl); // 新しい関数を呼び出す
    }

    // ステータスに応じた表示更新
    if (status === 'finished') {
      card.cardElem.classList.remove('tool-card--running');
      card.cardElem.classList.add('tool-card--finished');
      resetActive();           // ← 追加
    } else if (status === 'error') {
      card.cardElem.classList.remove('tool-card--running');
      card.cardElem.classList.add('tool-card--error');
    }
    if (shouldScroll) { // 冒頭で判定した shouldScroll を使用
      requestAnimationFrame(() => {
        scrollBottom(true);
      });
    }
  }

  /**
   * ツールカードのbodyのmax-heightを調整し、必要に応じてスクロールを有効にする関数
   * @param {HTMLElement} cardElem - ツールカードの要素
   * @param {HTMLElement} bodyEl - ツールカードのbody要素
   */
  function adjustToolCardBodyHeight(cardElem, bodyEl) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const maxHeightThreshold = viewportHeight * 0.50; // 60%から50%に変更

    // body以外の要素の高さを計算
    const headerHeight = cardElem.querySelector('.tool-card__header').offsetHeight;
    const bodyPadding = 20; // tool-card__bodyの上下パディングを考慮 (padding: 0 10px; なので上下は0ですが、将来的な変更に備えて残します)

    // bodyの現在の高さを取得
    const currentBodyHeight = bodyEl.scrollHeight; // スクロール可能な高さを取得

    // カード全体の高さが閾値を超える場合
    if ((headerHeight + currentBodyHeight + bodyPadding) > maxHeightThreshold) {
      const calculatedMaxHeight = maxHeightThreshold - headerHeight - bodyPadding;
      bodyEl.style.maxHeight = `${calculatedMaxHeight}px`;
    } else {
      bodyEl.style.maxHeight = ''; // リセット
    }
  }

  // チャット入力欄以外の場所をクリックしたらフォーカスを外す

  // チャット入力欄以外の場所をクリックしたらフォーカスを外す
  document.addEventListener('click', (e) => {
    const chatInput = document.getElementById('chatInput');
    const chatInputArea = document.getElementById('chatInputArea');

    // クリックされた要素が chatInput または chatInputArea の子孫でない場合
    if (chatInput && chatInputArea && !chatInputArea.contains(e.target)) {
      chatInput.blur(); // フォーカスを外す
    }
  });

});
