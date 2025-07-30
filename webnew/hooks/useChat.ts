// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';

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
  // bubbleRef: React.RefObject<HTMLDivElement>; // これはレンダリングコンポーネントで処理されるかもしれません
}

interface ToolCardData {
  callId: string;
  icon: string;
  label: string;
  command: string;
  status: 'running' | 'finished' | 'error';
  content: any; // これは文字列、マークダウン、diffなどになります。
}

// diffレンダリングのためのヘルパー関数（chat.jsから移植）
// これにはDiffライブラリ（例: diff-match-patchなど）が必要です。
// 今のところ、簡略化されたプレースホルダーを使用するか、Diffライブラリが利用可能であると仮定します。
// Diffライブラリが利用できない場合、これはゼロから実装するか、依存関係を追加する必要があります。
// （chat.jsのように）'Diff'オブジェクトがグローバルに利用可能であるか、インポートされていると仮定します。
// 実際のReactアプリでは、通常、'diff'や'react-diff-viewer'のようなライブラリを使用します。
// 今のところ、基本的な表現を返します。
// 完全に正確にするには、chat.jsで使用されている'diff'ライブラリ（おそらくhttps://github.com/kpdecker/jsdiff）を統合する必要があります。
function generateContextualDiffHtml(oldText: string, newText: string, ctx = 3): string {
  // プレースホルダーの実装 - これは実際のdiffロジックに置き換える必要があります
  // 今のところ、古いテキストと新しいテキストを表示するだけです
  return `<pre>--- Old Text ---
${oldText}
--- New Text ---
${newText}</pre>`;
}

export const useChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const [toolCardsData, setToolCardsData] = useState<Map<string, ToolCardData>>(new Map());

  const ws = useRef<WebSocket | null>(null);
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);
  const pendingToolBodies = useRef<Map<string, { status: string, content: any }>>(new Map());

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
      // requestHistory(true); // requestHistoryを実装する必要があります
      setIsGeneratingResponse(false);
    };

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
          content: marked.parse(thought.trim()),
        }));
      } else if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        // 既存のactiveMessageのIDを保持
        const currentId = activeMessage?.id || msg.id || `assistant-${Date.now()}`;

        // chunk.thought が存在する場合は、thought として処理
        if (chunk?.thought !== undefined) {
          setActiveMessage(prev => ({
            id: currentId, // IDは変更しない
            type: 'thought', // タイプをthoughtに設定
            content: marked.parse(chunk.thought.trim()),
          }));
        }
        // chunk.textが存在するかどうかを確認
        if (chunk?.text !== undefined) {
          setActiveMessage(prev => {
            const currentContent = prev?.content || '';
            const newContent = currentContent + chunk.text.replace(/^\n+/, '');
            return {
              id: currentId, // IDは変更しない
              type: 'assistant', // タイプをassistantに設定
              content: marked.parse(newContent.trimEnd()),
            };
          });
        }
        // msg.idが存在する場合はACK
        if (msg.id !== undefined && ws.current) {
          ws.current.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
          console.log('[DEBUG] Sent ACK for streamAssistantMessageChunk');
        }
      } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        if (activeMessage) {
          // アクティブなメッセージを確定し、メッセージに追加
          setMessages(prev => [...prev, {
            id: activeMessage.id,
            role: activeMessage.type === 'thought' ? 'assistant' : 'assistant', // 思考もアシスタントから
            content: activeMessage.content,
          }]);
        }
        setActiveMessage(null);
        setIsGeneratingResponse(false); // 完了は応答生成の終了を意味すると仮定
      } else if (msg.method === 'pushMessage') {
        // ツール完了後のアシスタントメッセージ
        setMessages(prev => [...prev, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: msg.params.content,
        }]);
        setActiveMessage(null); // アクティブなメッセージがあればリセット
        setIsGeneratingResponse(false); // これも応答生成の終了を意味すると仮定
      } else if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations } = msg.params;
        const command = locations?.[0]?.path ?? '';

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
          console.log('[DEBUG] Sent ACK for pushToolCall'); // 追加
        }
        setActiveMessage(null); // アクティブなメッセージがあればリセット
      } else if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;

        // ヘッダーパッチが存在するか確認
        if (content?.__headerPatch) {
          const { icon, label, command } = content.__headerPatch;
          updateToolCardData(toolId, { icon, label, command });
        } else {
          let processedContent = '';
          if (content) {
            if (content.type === 'markdown') {
              processedContent = marked.parse(content.markdown); // ここでmarked.parseを適用
            } else if (content.type === 'diff') {
              processedContent = generateContextualDiffHtml(content.oldText, content.newText);
            } else {
              processedContent = JSON.stringify(content, null, 2);
            }
          }

          updateToolCardData(toolId, { status, content: processedContent });
          // メインのメッセージ配列のメッセージも更新
          setMessages(prevMessages => prevMessages.map(m =>
            m.id === toolId ? { ...m, status, content: processedContent } : m
          ));
        }
        // 保留中のボディがあれば処理
        const pending = pendingToolBodies.current.get(toolId);
        if (pending) {
          // 保留中のボディが存在する場合、それはpushToolCallの前にupdateToolCallが呼び出されたことを意味します。
          // ツールカードデータが初期化されたので、保留中の内容を適用します。
          let processedPendingContent = '';
          if (pending.content) {
            if (pending.content.type === 'markdown') {
              processedPendingContent = marked.parse(pending.content.markdown); // ここでmarked.parseを適用
            } else if (pending.content.type === 'diff') {
              processedPendingContent = generateContextualDiffHtml(pending.content.oldText, pending.content.newText);
            } else {
              processedPendingContent = JSON.stringify(pending.content, null, 2);
            }
          }
          updateToolCardData(toolId, { status: pending.status, content: processedPendingContent });
          setMessages(prevMessages => prevMessages.map(m =>
            m.id === toolId ? { ...m, status: pending.status, content: processedPendingContent } : m
          ));
          pendingToolBodies.current.delete(toolId);
        }
      } else if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        let textContent = msg.params.chunk.text;

        // タイプが'diff'の場合のdiffカラーリングを処理
        if (msg.params.chunk.type === 'diff') {
          // この部分は完全なdiffライブラリがないと難しいです。
          // chat.jsはspanタグでinnerHTMLを直接操作しています。
          // Reactでは、通常、生のdiffを渡し、コンポーネントがそれをレンダリングします。
          // 今のところ、生のテキストを追加するだけです。
          // 適切な解決策は、diffをパースし、Reactコンポーネントでレンダリングすることです。
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
        setMessages(prevMessages => prevMessages.map(m =>
          m.id === toolId ? { ...m, content: (m.content || '') + textContent } : m
        ));
      } else if (msg.id !== undefined) {
        // RPC応答ハンドリング（sendUserMessage、fetchHistoryなど）
        if (msg.result === null) {
          setIsGeneratingResponse(false);
          setActiveMessage(null);
        }
        // fetchHistory応答を処理
        if (historyState.current.pendingHistory.has(msg.id) && msg.result?.messages) {
          historyState.current.pendingHistory.delete(msg.id);
          const newMessages = msg.result.messages.filter((m: any) => !historyState.current.loadedIds.has(m.id));

          if (newMessages.length > 0) {
            // 必要に応じてタイムスタンプでメッセージをソート（chat.jsは古い順を仮定）
            newMessages.sort((a: any, b: any) => a.ts - b.ts);

            setMessages(prev => {
              const updatedMessages = [...newMessages.map((m: any) => {
                // 履歴メッセージ形式をMessageインターフェースに変換
                if (m.type === 'tool') {
                  return {
                    id: m.id,
                    role: 'tool',
                    type: 'tool',
                    toolCallId: m.params.toolCallId ?? m.id,
                    icon: m.params.icon,
                    label: m.params.label,
                    command: m.params.confirmation?.command || m.params.locations?.[0]?.path || '',
                    status: m.params.status || 'finished', // 履歴からの場合は完了と仮定
                    content: m.params.content ? (marked.parse(m.params.content.markdown || m.params.content.text) || JSON.stringify(m.params.content)) : '',
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
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    return () => {
      ws.current?.close();
    };
  }, []); // 依存関係を空配列に変更

  // ユーザーメッセージを送信する関数
  const sendMessage = useCallback((text: string) => {
    if (!ws.current || isGeneratingResponse) return;

    const messageId = `user-${Date.now()}`;
    setMessages(prev => [...prev, { id: messageId, role: 'user', content: text }]);
    setIsGeneratingResponse(true);
    setActiveMessage(null); // ここでactiveMessageをリセット

    const reqId = requestIdCounter.current++;
    lastSentRequestId.current = reqId;

    const req = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'sendUserMessage',
      params: { chunks: [{ text }] }
    };
    ws.current.send(JSON.stringify(req));
    console.log('[DEBUG] Sent sendUserMessage'); // 追加
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
      console.log('[DEBUG] Sent fetchHistory request'); // 追加
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