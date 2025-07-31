// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import { Diff } from 'diff'; // jsdiff ライブラリをインポート

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  type?: 'text' | 'tool'; // ユーザー/アシスタントは'text'、ツールメッセージは'tool'
  toolCallId?: string; // ツールメッセージ用
  status?: 'running' | 'finished' | 'error'; // ツールメッセージ用
  icon?: string; // ツールメッセージ用
  label?: string; // ツールメッセージ用
  command?: string; // ツールメッセージ用
}

interface ActiveMessage {
  id: string;
  type: 'thought' | 'assistant';
  content: string;
  thoughtMode: boolean; // chat.js の active.thoughtMode に対応
}

interface ToolCardData {
  callId: string;
  icon: string;
  label: string;
  command: string;
  status: 'running' | 'finished' | 'error';
  content: string; // HTMLコンテンツを保持するように変更
}

function generateContextualDiffHtml(oldText: string, newText: string, ctx = 3): string {
  const patch = Diff.structuredPatch('old','new',oldText,newText,'','',{context:ctx});
  let html = '<pre>';
  patch.hunks.forEach((h: any, hi: number) => {
    let oldNum = h.oldStart;
    let newNum = h.newStart;
    h.lines.forEach((line: string) => {
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

export const useChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const activeMessageRef = useRef<ActiveMessage | null>(null); // ここに移動
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const [toolCardsData, setToolCardsData] = useState<Map<string, ToolCardData>>(new Map());

  useEffect(() => { // ここに移動
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  const ws = useRef<WebSocket | null>(null);
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);
  const pendingToolBodies = useRef<Map<string, { status: string, content: any }>>(new Map());
  const toolCards = useRef<Map<string, { cardElem: any, bodyElem: any }>>(new Map()); // chat.js の toolCards に対応

  // 履歴関連の状態
  const historyState = useRef({
    oldestTs: null as number | null,
    loadedIds: new Set<string>(),
    pendingHistory: new Set<number>(),
    finished: false,
    isFetchingHistory: false,
    histReqId: 10000,
  });

  // toolCardsDataをイミュータブルに更新するヘルパー
  const updateToolCardData = useCallback((callId: string, newData: Partial<ToolCardData>) => {
    setToolCardsData(prev => {
      const newMap = new Map(prev);
      const existing = newMap.get(callId);
      newMap.set(callId, { ...(existing || {} as ToolCardData), ...newData });
      return newMap;
    });
  }, []);

  // WebSocketの初期化とメッセージハンドリング
  useEffect(() => {
    if (ws.current) return; // 既に接続済みなら何もしない

    // ws.current = new WebSocket(`wss://${window.location.hostname}:3001/ws`); // chat.jsからのオリジナル
    ws.current = new WebSocket(`ws://${window.location.hostname}:3001/ws`); // 引き継ぎ資料に基づいて修正

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      // 初期の履歴フェッチとUI状態の設定
      requestHistory(true); // requestHistoryを実装する必要があります
      setIsGeneratingResponse(false);
    }

    ws.current.onmessage = (event) => {
      console.log('[DEBUG] Received WebSocket message:', event.data);
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error('❌ JSON parse error on chunk:', err, event.data);
        return;
      }

      // --- メッセージハンドリングロジックはここに入ります ---
      if (msg.method === 'streamAssistantThoughtChunk') {
        const { thought } = msg.params;
        setActiveMessage(prev => ({
          id: prev?.id || msg.id || `thought-${Date.now()}`,
          type: 'thought',
          content: thought.trim(), // thought は常に上書き
          thoughtMode: true,
        }));
      } else if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const currentId = activeMessageRef.current?.id || msg.id || `assistant-${Date.now()}`;

        let newContent = activeMessageRef.current?.content || '';
        let newType: 'thought' | 'assistant' = activeMessageRef.current?.type || 'thought';
        let newThoughtMode = activeMessageRef.current?.thoughtMode || false;

        if (chunk?.text !== undefined) { // text が優先
          newType = 'assistant';
          newThoughtMode = false;
          // text が来た場合、thought の内容をクリアして text を追記
          // ただし、既に assistant タイプの場合は追記
          if (activeMessageRef.current?.type !== 'assistant') { // thought から assistant に切り替わる場合
            newContent = chunk.text.replace(/^\n+/, ''); // text で初期化
          } else {
            newContent = newContent + chunk.text.replace(/^\n+/, ''); // 追記
          }
        } else if (chunk?.thought !== undefined) { // text がない場合のみ thought を処理
          newContent = chunk.thought.trim(); // thought が来た場合は上書き
          newType = 'thought';
          newThoughtMode = true;
        }

        setActiveMessage({
          id: currentId,
          type: newType,
          content: newContent.trimEnd(),
          thoughtMode: newThoughtMode,
        });
        // msg.idが存在する場合はACK
        if (msg.id !== undefined && ws.current) {
          ws.current.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        }
      } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        if (activeMessage) {
          // アクティブなメッセージを確定し、メッセージに追加
          console.log("[DEBUG] agentMessageFinished/messageCompleted: activeMessage content before adding to messages:", activeMessage.content); // 追加
          setMessages(prev => {
            const newMessages = [...prev, {
              id: activeMessage.id,
              role: activeMessage.type === 'thought' ? 'assistant' : 'assistant', // 思考もアシスタントから
              content: activeMessage.content,
            }];
            console.log("[DEBUG] agentMessageFinished/messageCompleted: messages after adding activeMessage:", newMessages); // 追加
            return newMessages;
          });
          setActiveMessage(null); // メッセージが確定してからクリア
        }
        setIsGeneratingResponse(false); // 完了は応答生成の終了を仮定
      } else if (msg.method === 'pushMessage') {
        // ツール完了後のアシスタントメッセージ
        setMessages(prev => [...prev, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: msg.params.content,
        }]);
        // pushMessageは通常、ツール実行後の最終メッセージなので、activeMessageはクリアして問題ない
        setActiveMessage(null);
        setIsGeneratingResponse(false);
      } else if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations } = msg.params;
        const command = locations?.[0]?.path ?? '';

        // chat.js の createToolCard に相当する処理
        updateToolCardData(toolId, {
          callId: toolId,
          icon,
          label,
          command,
          status: 'running',
          content: '', // 初期は空の内容
        });

        // ツールカードのプレースホルダーメッセージを追加
        setMessages(prev => [...prev, {
          id: toolId,
          role: 'tool',
          type: 'tool',
          toolCallId: toolId,
          icon,
          label,
          command,
          status: 'running',
          content: '', // 内容はpushChunk/updateToolCallで更新されます
        }]);

        // AgentへACKを返す
        if (ws.current) {
          ws.current.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { id: toolId }
          }));
        }
        setActiveMessage(null); // chat.js の resetActive() に相当
      } else if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;

        // chat.js の pendingBodies ロジックを再現
        // まだヘッダが来ていない（toolCardsDataにエントリがない）場合、一旦キャッシュ
        if (!toolCardsData.has(toolId)) {
          pendingToolBodies.current.set(toolId, { status, content });
          return;
        }

        // __headerPatch が存在する場合、ヘッダー情報を更新
        if (content?.__headerPatch) {
          const { icon, label, command } = content.__headerPatch;
          updateToolCardData(toolId, { icon, label, command });
          return; // headerPatch は body ではないのでここで return
        }

        let processedContent = '';
        if (content) {
          if (content.type === 'markdown') {
            processedContent = marked.parse(content.markdown);
          } else if (content.type === 'diff') {
            processedContent = generateContextualDiffHtml(content.oldText, content.newText);
          } else {
            processedContent = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
          }
        }

        updateToolCardData(toolId, { status, content: processedContent });
        // メインのメッセージ配列のメッセージも更新
        setMessages(prevMessages => prevMessages.map(m =>
          m.id === toolId ? { ...m, status, content: processedContent } : m
        ));

        // chat.js の resetActive() に相当
        if (status === 'finished') {
          setActiveMessage(null);
        }
      }
      if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        let textContent = msg.params.chunk.text;

        // タイプが'diff'の場合のdiffカラーリングを処理
        if (msg.params.chunk.type === 'diff') {
          textContent = textContent.split('\n').map((line: string) => {
            if (line.startsWith('+')) {
              return `<span class="add">${line}</span>`;
            } else if (line.startsWith('-')) {
              return `<span class="del">${line}</span>`;
            }
            return line;
          }).join('\n');
        }

        // ツールカードの内容にテキストコンテンツを追加
        updateToolCardData(toolId, prev => ({
          ...prev,
          content: (prev?.content || '') + textContent, // 内容を追加
        }));
        // messages 配列内のツールメッセージの content も更新
        setMessages(prevMessages => prevMessages.map(m =>
          m.id === toolId ? { ...m, content: (m.content || '') + textContent } : m
        ));
      } else if (msg.id !== undefined) {
        // RPC応答ハンドリング（sendUserMessage、fetchHistoryなど）
        // sendUserMessage の応答が result:null の場合のみ setActiveMessage(null) を呼び出す
        if (msg.result === null && msg.id === lastSentRequestId.current) { // lastSentRequestId.current と比較
          console.log(`[DEBUG] result:null received for request ID: ${msg.id}. lastSentRequestId.current: ${lastSentRequestId.current}`); // 追加
          setIsGeneratingResponse(false);
          // activeMessage が存在する場合、messages に追加してからクリアする
          if (activeMessageRef.current) {
            // activeMessage のタイプが 'assistant' の場合のみ確定
            if (activeMessageRef.current.type === 'assistant') {
              console.log(`[DEBUG] result:null received. activeMessage content: "${activeMessageRef.current.content}"`); // 追加
              setMessages(prev => {
                const newMessages = [...prev, {
                  id: activeMessageRef.current.id,
                  role: 'assistant', // 確定時は常に assistant
                  content: activeMessageRef.current.content,
                }];
                console.log("[DEBUG] result:null received. messages after adding activeMessage:", newMessages); // 追加
                return newMessages;
              });
            } else {
              // thought の場合は確定しない（破棄）
              console.log(`[DEBUG] result:null received. activeMessage type is thought, not adding to messages. Content: "${activeMessageRef.current.content}"`);
            }
          }
          setActiveMessage(null);
        }
        // fetchHistory応答を処理
        if (historyState.current.pendingHistory.has(msg.id) && msg.result?.messages) {
          historyState.current.pendingHistory.delete(msg.id);
          const newMessages = msg.result.messages.filter((m: any) => !historyState.current.loadedIds.has(m.id));

          if (newMessages.length > 0) {
            // chat.js のスクロール位置保持ロジックを再現
            // messagesContainerRef は useChat の外にあるため、ここでは直接操作できない。
            // そのため、スクロール位置の調整は new-chat-panel.tsx 側で行う必要がある。
            // ここでは、メッセージの追加と oldestTs の更新のみを行う。

            // 必要に応じてタイムスタンプでメッセージをソート（chat.jsは古い順を仮定）
            newMessages.sort((a: any, b: any) => a.ts - b.ts);

            setMessages(prev => {
              const updatedMessages = [...newMessages.map((m: any) => {
                // 履歴メッセージ形式をMessageインターフェースに変換
                if (m.type === 'tool') {
                  // chat.js の renderMessages 関数内のツールカード生成ロジックを再現
                  let processedContent = '';
                  if (m.params?.content) {
                    const content = m.params.content;
                    if (content.type === 'markdown' && content.markdown) {
                      processedContent = marked.parse(content.markdown);
                    } else if (content.type === 'diff') {
                      processedContent = generateContextualDiffHtml(content.oldText, content.newText);
                    } else if (typeof content === 'string') {
                      processedContent = `<pre>${content}</pre>`;
                    } else {
                      processedContent = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
                    }
                  } else {
                    processedContent = '<span style="color:gray">（内容なし）</span>';
                  }

                  return {
                    id: m.id,
                    role: 'tool',
                    type: 'tool',
                    toolCallId: m.params.toolCallId ?? m.id,
                    icon: m.params.icon,
                    label: m.params.label,
                    command: m.params.confirmation?.command || m.params.locations?.[0]?.path || '',
                    status: m.params.status || 'finished', // 履歴からの場合は完了と仮定
                    content: processedContent, // marked.parse 済み
                  };
                } else {
                  return {
                    id: m.id,
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: marked.parse(m.text), // ここでmarked.parseを適用
                  };
                }
              }), ...prev];
              newMessages.forEach((m: any) => historyState.current.loadedIds.add(m.id));
              historyState.current.oldestTs = newMessages[0].ts;
              return updatedMessages;
            });
          }

          const limit = 20; // chat.jsの制限に合わせる
          if (newMessages.length < limit) {
            historyState.current.finished = true;
          }
          historyState.current.isFetchingHistory = false;
        }
      }
    }

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      ws.current?.close();
      ws.current = null; // WebSocketインスタンスをクリア
    };
  }, []); // 依存関係を空配列に変更

  // ユーザーメッセージを送信する関数
  const sendMessage = useCallback((text: string) => {
    if (!ws.current || isGeneratingResponse) return;

    const messageId = `user-${Date.now()}`;
    setMessages(prev => [...prev, { id: messageId, role: 'user', content: text }]);
    setIsGeneratingResponse(true);
    // chat.js の createTypingBubble() に相当する処理
    setActiveMessage({
      id: `thought-${Date.now()}`, // 新しいIDを生成
      type: 'thought',
      content: '…思考中…', // 初期コンテンツ
      thoughtMode: true, // 思考中モード
    });

    const reqId = requestIdCounter.current++;
    lastSentRequestId.current = reqId;

    const req = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'sendUserMessage',
      params: { chunks: [{ text }] }
    };
    ws.current.send(JSON.stringify(req));
  }, [isGeneratingResponse]);

  // 履歴を要求する関数
  const requestHistory = useCallback((isInitialLoad = false) => {
    console.log('[DEBUG] requestHistory called. isFetchingHistory:', historyState.current.isFetchingHistory, 'finished:', historyState.current.finished, 'isInitialLoad:', isInitialLoad);
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    console.log('[DEBUG] Sending fetchHistory request with id:', id, 'before:', historyState.current.oldestTs, 'limit:', limit);
    if (ws.current) {
      ws.current.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'fetchHistory',
        params: { limit: limit, before: historyState.current.oldestTs }
      }));
    }
  }, []);

  // 必要な状態と関数を公開
  return {
    messages,
    activeMessage,
    isGeneratingResponse,
    toolCardsData,
    sendMessage,
    requestHistory,
  };
};