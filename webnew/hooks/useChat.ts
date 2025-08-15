// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { marked } from 'marked';
import * as Diff from 'diff'; // jsdiff ライブラリをインポート
import { useWebSocket } from '@/context/WebSocketContext'; // WebSocketContextからuseWebSocketをインポート

interface FileInfo {
  name: string;
  path: string;
  size: number;
}

interface Goal {
  id: string | number;
  completed: boolean;
  subject: string;
  task: string;
  details?: string;
  tags?: string[];
  total_problems?: number | null;
  completed_problems?: number | null;
}

interface Message {
  id: string;
  ts?: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  files?: FileInfo[];
  goal?: Goal | null;
  type?: 'text' | 'tool'; // ユーザー/アシスタントは'text'、ツールメッセージは'tool'
  toolCallId?: string; // ツールメッセージ用
  status?: 'running' | 'finished' | 'error'; // ツールメッセージ用
  icon?: string; // ツールメッセージ用
  label?: string; // ツールメッセージ用
  command?: string; // ツールメッセージ用
  session?: { session: any; logEntry: any } | null;
}

interface ActiveMessage {
  id: string;
  ts: number; // タイムスタンプを必須プロパティにする
  type: 'thought' | 'assistant';
  content: string;
  thoughtMode: boolean; // chat.js の active.thoughtMode に対応
}

interface SendMessageData {
  text: string;
  files?: FileInfo[];
  goal?: Goal | null;
  session?: { session: any; logEntry: any } | null;
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
      let prefix = ' '; // Default prefix for context lines
      let content = line; // Content without prefix

      if (line.startsWith('+')) {
        lineClass = 'add';
        prefix = '+';
        content = line.substring(1); // Remove '+'
        oldNumHtml = `<span class="line-num"></span>`;
        newNumHtml = `<span class="line-num new">${newNum++}</span>`;
      } else if (line.startsWith('-')) {
        lineClass = 'del';
        prefix = '-';
        content = line.substring(1); // Remove '-'
        oldNumHtml = `<span class="line-num old">${oldNum++}</span>`;
        newNumHtml = `<span class="line-num"></span>`;
      } else {
        lineClass = 'context';
        prefix = ' '; // Keep the space for the prefix
        content = line.substring(1); // Remove the leading space from content
        oldNumHtml = `<span class="line-num old">${oldNum}</span>`;
        newNumHtml = `<span class="line-num new">${newNum}</span>`;
        oldNum++; newNum++;
      }

      const escContent = content.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      html += `<span class="${lineClass}">${oldNumHtml}${newNumHtml}<span class="diff-prefix">${prefix}</span>${escContent}</span>\n`;
    });
    if (hi !== patch.hunks.length - 1) html += '<hr class="diff-separator">\n';
  });
  html += '</pre>';
  return html;
}

export const useChat = ({ onMessageReceived }: { onMessageReceived?: () => void } = {}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const activeMessageRef = useRef<ActiveMessage | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const { ws, isConnected, subscribe, sendMessage: sendWsMessage } = useWebSocket(); // WebSocketContextから取得
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);

  useEffect(() => {
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  const historyState = useRef({
    oldestTs: null as number | null,
    loadedIds: new Set<string>(),
    pendingHistory: new Set<number>(),
    finished: false,
    isFetchingHistory: false,
    histReqId: 10000,
  });

  useEffect(() => {
    if (!ws) return; // WebSocketインスタンスがまだ利用可能でない場合は何もしない

    // WebSocketからのメッセージ処理ロジックをsubscribeで登録
    const unsubscribe = subscribe((msg: any) => {
      console.log('[DEBUG] Received WebSocket message:', msg);
      // let msg; // JSON.parseはWebSocketContextで行われるため不要
      // try {
      //   msg = JSON.parse(event.data);
      // } catch (err) {
      //   console.error('❌ JSON parse error on chunk:', err, event.data);
      //   return;
      // }

      if (msg.method === 'streamAssistantThoughtChunk') {
        const { thought } = msg.params;
        setActiveMessage(prev => ({
          id: prev?.id || msg.id || `thought-${Date.now()}`,
          ts: prev?.ts || Date.now(), // タイムスタンプを維持または新規作成
          type: 'thought',
          content: thought.trim(),
          thoughtMode: true,
        }));
        onMessageReceived?.();
      } else if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId; // ★ サーバーからの共通IDを取得

        setActiveMessage(prevActiveMessage => {
            // ★ 修正点: サーバーからのIDを最優先で使用する
            const currentId = prevActiveMessage?.id || incomingMessageId || msg.id || `assistant-${Date.now()}`;
            const currentTs = prevActiveMessage?.ts || Date.now(); // 既存のtsを使うか、なければ新規作成
            let newContent = prevActiveMessage?.content || '';
            let newType = prevActiveMessage?.type || 'thought';
            let newThoughtMode = prevActiveMessage?.thoughtMode || false;

            // If a thought arrives, update the thought content and set mode to thought.
            if (chunk?.thought !== undefined) {
                newContent = chunk.thought.trim();
                newType = 'thought';
                newThoughtMode = true;
            }

            // If text arrives, it might override the thought or append to existing text.
            if (chunk?.text !== undefined) {
                // If we were in thought mode, the new text replaces the thought content.
                // Otherwise, it appends to the existing assistant message.
                if (newType === 'thought') {
                    newContent = chunk.text.replace(/^\n+/, '');
                } else {
                    newContent = (prevActiveMessage?.content || '') + chunk.text.replace(/^\n+/, '');
                }
                newType = 'assistant';
                newThoughtMode = false;
            }

            return {
                id: currentId,
                ts: currentTs, // タイムスタンプを維持
                type: newType as 'thought' | 'assistant',
                content: newContent,
                thoughtMode: newThoughtMode,
            };
        });

        if (msg.id !== undefined && ws) { // ws.current から ws に変更
          sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: null }); // sendWsMessage を使用
        }
        onMessageReceived?.();
      } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        if (activeMessage) {
          setMessages(prev => {
            // ★ 修正点: 重複を避ける
            if (prev.some(m => m.id === activeMessage.id)) {
              return prev;
            }
            const newMessages = [...prev, {
              id: activeMessage.id,
              ts: activeMessage.ts, // activeMessageのタイムスタンプを利用
              role: 'assistant',
              content: activeMessage.content,
            }];
            newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            return newMessages;
          });
          setActiveMessage(null);
        }
        setIsGeneratingResponse(false);
        onMessageReceived?.();
      } else if (msg.method === 'addMessage') {
        const { message } = msg.params;
        
        // 新しい方針: このハンドラは他人からのメッセージのみを受け取る。
        // 自分のメッセージはsendMessageで先行表示済みのため、ID比較や置換は不要。
        // 単純に受け取ったメッセージをリストに追加する。
        flushSync(() => {
          setMessages(prev => {
            // 念のため重複をチェック
            if (prev.some(m => m.id === message.id)) {
              return prev;
            }
            const newMessages = [...prev, {
              id: message.id,
              ts: message.ts,
              role: message.role,
              content: message.text,
              files: message.files || [],
              goal: message.goal || null,
              session: message.session || null,
            }];
            // タイムスタンプでソートして順序を保証
            newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            return newMessages;
          });
        });
        onMessageReceived?.();
      } else if (msg.method === 'pushMessage') {
        setMessages(prev => {
          const newMessages = [...prev, {
            id: `msg-${Date.now()}`,
            ts: Date.now(), // タイムスタンプを追加
            role: 'assistant',
            content: msg.params.content,
          }];
          newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          return newMessages;
        });
        setActiveMessage(null);
        setIsGeneratingResponse(false);
        onMessageReceived?.();
      } else if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations } = msg.params;
        const command = locations?.[0]?.path ?? '';

        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];

            // activeMessage が存在し、それがアシスタントメッセージであれば確定させる
            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const currentActiveMessage = activeMessageRef.current;
              // 重複防止
              if (!newMessages.some(m => m.id === currentActiveMessage.id)) {
                newMessages.push({
                  id: currentActiveMessage.id,
                  ts: currentActiveMessage.ts,
                  role: 'assistant',
                  content: currentActiveMessage.content,
                });
              }
            }

            // 新しいツールメッセージを追加
            newMessages.push({
              id: toolId,
              ts: Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: 'ツールを実行中...',
              toolCallConfirmationId: msg.params.confirmation?.toolCallConfirmationId,
              toolCallConfirmationMessage: msg.params.confirmation?.toolCallConfirmationMessage,
              toolCallConfirmationButtons: msg.params.confirmation?.toolCallConfirmationButtons,
            });

            newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            return newMessages;
          });
          // 状態更新後、activeMessageをクリア
          setActiveMessage(null);
        });

        if (ws) { // ws.current から ws に変更
          sendWsMessage({
            jsonrpc: '2.0',
            id: msg.id,
            result: { id: toolId }
          });
        }
        onMessageReceived?.();
      } else if (msg.method === 'requestToolCallConfirmation') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, confirmation } = msg.params;
        const command = confirmation?.command ?? '';

        // 常に許可するため、すぐに許可の応答を返す
        if (ws) { // ws.current から ws に変更
          sendWsMessage({
            jsonrpc: '2.0',
            id: msg.id, // 受け取ったメッセージのIDをそのまま使う
            result: { id: toolId, outcome: 'allow' }
          });
        }

        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];

            // activeMessage が存在し、それがアシスタントメッセージであれば確定させる
            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const currentActiveMessage = activeMessageRef.current;
              // 重複防止
              if (!newMessages.some(m => m.id === currentActiveMessage.id)) {
                newMessages.push({
                  id: currentActiveMessage.id,
                  ts: currentActiveMessage.ts,
                  role: 'assistant',
                  content: currentActiveMessage.content,
                });
              }
            }

            // 新しいツールメッセージを追加
            newMessages.push({
              id: toolId,
              ts: Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: confirmation?.details ?? 'ツールの確認を待っています...',
              toolCallConfirmationId: confirmation?.toolCallConfirmationId,
              toolCallConfirmationMessage: confirmation?.toolCallConfirmationMessage,
              toolCallConfirmationButtons: confirmation?.toolCallConfirmationButtons,
            });

            newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
            return newMessages;
          });
          // 状態更新後、activeMessageをクリア
          setActiveMessage(null);
        });
        onMessageReceived?.();
      } else if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;

        setMessages(prevMessages => {
            const newMessages = [...prevMessages];
            const toolMessageIndex = newMessages.findIndex(m => m.id === toolId);

            if (toolMessageIndex === -1) {
                // まだメッセージが存在しない場合 (pushToolCallより先にupdateが来た場合)
                // ここで一旦保留するロジックも考えられるが、一旦何もしない
                console.warn(`[updateToolCall] Tool message with id ${toolId} not found.`);
                return prevMessages;
            }

            const toolMessage = { ...newMessages[toolMessageIndex] };

            // __headerPatch が存在する場合、ヘッダー情報を更新
            if (content?.__headerPatch) {
                const { icon, label, command } = content.__headerPatch;
                toolMessage.icon = icon ?? toolMessage.icon;
                toolMessage.label = label ?? toolMessage.label;
                toolMessage.command = command ?? toolMessage.command;
                newMessages[toolMessageIndex] = toolMessage;
                return newMessages;
            }

            let processedContent = '';
            if (content) {
                if (content.type === 'markdown') {
                    processedContent = content.markdown; // marked.parse を削除
                } else if (content.type === 'diff') {
                    processedContent = generateContextualDiffHtml(content.oldText, content.newText);
                } else if (typeof content === 'string') {
                    processedContent = `<pre>${content}</pre>`;
                } else {
                    processedContent = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
                }
            }
            toolMessage.status = status;
            toolMessage.content = processedContent;
            newMessages[toolMessageIndex] = toolMessage;
            return newMessages;
        });

        if (status === 'finished') {
          setActiveMessage(null);
        }
        onMessageReceived?.();
      } else if (msg.id !== undefined && msg.result?.messages) {
        if (historyState.current.pendingHistory.has(msg.id)) {
          historyState.current.pendingHistory.delete(msg.id);
          const rawMessages = msg.result.messages.filter((m: any) => !historyState.current.loadedIds.has(m.id));

          if (rawMessages.length > 0) {
            rawMessages.sort((a: any, b: any) => a.ts - b.ts);

            // ツール呼び出しをマージする処理
            const mergedMessages: any[] = [];
            const toolCalls = new Map<string, any>();

            for (const m of rawMessages) {
              if (m.type === 'tool' && (m.method === 'pushToolCall' || m.method === 'requestToolCallConfirmation')) {
                const toolCallId = m.params.toolCallId ?? m.id;
                toolCalls.set(toolCallId, {
                  id: toolCallId,
                  ts: m.ts,
                  role: 'tool',
                  type: 'tool',
                  toolCallId: toolCallId,
                  icon: m.params.icon,
                  label: m.params.label,
                  command: m.params.confirmation?.command || m.params.locations?.[0]?.path || '',
                  status: 'running', // 初期状態
                  content: '', // 初期状態
                });
              } else if (m.type === 'tool' && m.method === 'updateToolCall') {
                const toolCallId = m.params.toolCallId ?? m.params.callId;
                if (toolCalls.has(toolCallId)) {
                  const existingTool = toolCalls.get(toolCallId);
                  existingTool.status = m.params.status || existingTool.status;
                  if (m.params.content) {
                    const content = m.params.content;
                     if (content.type === 'markdown' && content.markdown) {
                      existingTool.content = marked.parse(content.markdown);
                    } else if (content.type === 'diff') {
                      existingTool.content = generateContextualDiffHtml(content.oldText, content.newText);
                    } else if (typeof content === 'string') {
                      existingTool.content = `<pre>${content}</pre>`;
                    } else {
                      existingTool.content = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
                    }
                  }
                }
              } else {
                // ツール呼び出し以外のメッセージ
                mergedMessages.push(m);
              }
            }

            // マージされたツール呼び出しをメッセージリストに追加
            mergedMessages.push(...Array.from(toolCalls.values()));

            // タイムスタンプで最終ソート
            mergedMessages.sort((a: any, b: any) => a.ts - b.ts);

            setMessages(prev => {
              const updatedMessages = [...mergedMessages.map((m: any) => {
                // 既にツール呼び出しは処理済みなので、ここでは通常のメッセージを処理
                if (m.role === 'user' || m.role === 'assistant') {
                   return {
                    id: m.id,
                    ts: m.ts, // タイムスタンプを正しく渡す
                    role: m.role,
                    content: m.text || '',
                    files: m.files || [],
                    goal: m.goal || null,
                    session: m.session || null,
                  };
                } else if (m.role === 'tool') {
                    // マージ済みのツールオブジェクトをそのまま返す
                    return m;
                }
                return null; // 万が一のためのnullチェック
              }).filter(Boolean), ...prev]; // nullを除外
              
              rawMessages.forEach((m: any) => historyState.current.loadedIds.add(m.id));
              if (rawMessages.length > 0) {
                historyState.current.oldestTs = rawMessages[0].ts;
              }
              updatedMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
              return updatedMessages;
            });
          }

          const limit = 20;
          if (rawMessages.length < limit) {
            historyState.current.finished = true;
          }
          historyState.current.isFetchingHistory = false;
        }
      } else if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        let textContent = msg.params.chunk.text;

        setMessages(prevMessages => prevMessages.map(m => {
          if (m.id === toolId) {
            let newContent = m.content || '';
            // タイプが'diff'の場合のdiffカラーリングを処理
            if (msg.params.chunk.type === 'diff') {
              newContent += textContent.split('\n').map((line: string) => {
                if (line.startsWith('+')) return `<span class="add">${line}</span>`;
                if (line.startsWith('-')) return `<span class="del">${line}</span>`;
                return line;
              }).join('\n');
            } else {
              newContent += textContent;
            }
            return { ...m, content: newContent };
          }
          return m;
        }));

      } else if (msg.id !== undefined && msg.result === null) {
        // ACPモードでは、sendUserMessage への応答 (result:null) がストリーム全体の完了を示す
        // ★ 修正点: lastSentRequestId のチェックを外す
        console.log(`[DEBUG] Completion signal received (id: ${msg.id}). Finalizing active message.`);

        // 関数型アップデートを使い、ref のタイミング問題を起こさずに activeMessage を確定させる
        setActiveMessage(prevActiveMessage => {
          if (prevActiveMessage && prevActiveMessage.type === 'assistant') {
            setMessages(p => {
              if (p.some(m => m.id === prevActiveMessage.id)) {
                return p;
              }
              const newMessages = [...p, { id: prevActiveMessage.id, ts: prevActiveMessage.ts, role: 'assistant', content: prevActiveMessage.content }];
              newMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
              return newMessages;
            });
          }
          // thought モードのまま完了した場合や、activeMessage がない場合は何もせずバブルを消すだけ
          return null; // activeMessage をクリア
        });

        setIsGeneratingResponse(false);
      }
    }); // subscribeの閉じ括弧

    // クリーンアップ関数は、ws インスタンスが変更されたり、コンポーネントがアンマウントされたりする際に実行される
    return () => {
      // ここでは ws.close() を直接呼ばない
      // WebSocketProvider が接続のライフサイクルを管理するため
      console.log('Cleaning up useChat WebSocket listeners.');
      unsubscribe(); // subscribeで返されたunsubscribe関数を呼び出す
    };
  }, [ws, subscribe, activeMessage]); // wsとsubscribeを依存配列に追加

  const sendMessage = useCallback((messageData: SendMessageData) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || isGeneratingResponse) { // ws.current から ws に変更
      console.warn("WebSocket is not open or busy, cannot send message.");
      return;
    }

    setIsGeneratingResponse(true);

    const { text, files, goal, session } = messageData;

    const newMessage: Message = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2)}`, // Unique ID for the message
        ts: Date.now(),
        role: "user",
        content: text,
        files: files || [],
        goal: goal || null,
        session: session || null,
        type: "text",
      };

    setMessages(prev => [...prev, newMessage]);

    const reqId = requestIdCounter.current++;
    lastSentRequestId.current = reqId;

    const req = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'sendUserMessage',
      params: { chunks: [{ text, files, goal, messageId: newMessage.id, session }] }
    };
    sendWsMessage(req); // sendWsMessage を使用
  }, [ws, isGeneratingResponse, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  const sendToolConfirmation = useCallback((toolCallId: string, result: boolean) => {
    if (!ws) return; // ws.current から ws に変更

    const req = {
      jsonrpc: '2.0',
      id: requestIdCounter.current++,
      method: 'confirmToolCall',
      params: { toolCallId, result }
    };
    sendWsMessage(req); // sendWsMessage を使用

    // 確認後はツールメッセージのステータスを更新
    setMessages(prev => prev.map(m => {
      if (m.id === toolCallId) {
        return { ...m, status: 'finished' }; // または 'confirmed' など、適切なステータスに更新
      }
      return m;
    }));

  }, [ws, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  const requestHistory = useCallback((isInitialLoad = false) => {
    console.log('[useChat DEBUG] requestHistory called. isFetchingHistory:', historyState.current.isFetchingHistory, 'finished:', historyState.current.finished); // 追加
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[useChat DEBUG] Sending fetchHistory request with id:', id, 'limit:', limit, 'before:', historyState.current.oldestTs); // 追加
      sendWsMessage({
        jsonrpc: '2.0',
        id,
        method: 'fetchHistory',
        params: { limit: limit, before: historyState.current.oldestTs }
      });
    } else {
      console.warn("WebSocket is not open, cannot fetch history.");
      historyState.current.isFetchingHistory = false;
    }
  }, [ws, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  const cancelSendMessage = useCallback(() => {
    if (!ws || !lastSentRequestId.current) return; // ws.current から ws に変更

    const req = {
      jsonrpc: '20',
      id: lastSentRequestId.current,
      method: 'cancelSendMessage',
      params: {}
    };
    sendWsMessage(req); // sendWsMessage を使用
    setIsGeneratingResponse(false); // UIを即座にリセット
  }, [ws, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  const clearMessages = useCallback(() => {
    setMessages([]);
    setActiveMessage(null);
    historyState.current = {
      oldestTs: null,
      loadedIds: new Set<string>(),
      pendingHistory: new Set<number>(),
      finished: false,
      isFetchingHistory: false,
      histReqId: 10000,
    };
    // サーバーにもクリアを通知するWebSocketメッセージを送信
    if (ws && ws.readyState === WebSocket.OPEN) { // ws.current から ws に変更
      sendWsMessage({
        jsonrpc: '2.0',
        method: 'clearHistory',
        params: {}
      });
    }
  }, [ws, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[useChat DEBUG] WebSocket is open. Requesting initial history.'); // 追加
      requestHistory(true);
    }
  }, [ws, requestHistory]); // wsとrequestHistoryを依存配列に追加

  return {
    messages,
    activeMessage,
    isGeneratingResponse,
    isFetchingHistory: historyState.current.isFetchingHistory,
    historyFinished: historyState.current.finished,
    sendMessage,
    cancelSendMessage,
    requestHistory,
    sendToolConfirmation,
    clearMessages, // clearMessages をエクスポートに追加
  };
}
