// webnew/hooks/useChat.ts (修正後の完成形コード)
import { useState, useEffect, useRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { marked } from 'marked';
import * as Diff from 'diff';
import { useWebSocket } from '@/context/WebSocketContext';

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
  features?: { webSearch?: boolean };
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


// 追加: ツールステータス正規化ユーティリティ
function normalizeToolStatus(status?: string): 'running' | 'finished' | 'error' | undefined {
  if (!status) return undefined;
  const s = String(status).toLowerCase();
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished' || s === 'success' || s === 'succeeded') return 'finished';
  if (s === 'in_progress' || s === 'running' || s === 'pending' || s === 'started') return 'running';
  if (s === 'error' || s === 'failed' || s === 'failure') return 'error';
  return undefined;
}

export const useChat = ({ onMessageReceived }: { onMessageReceived?: () => void } = {}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const activeMessageRef = useRef<ActiveMessage | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const { ws, subscribe, sendMessage: sendWsMessage } = useWebSocket(); // WebSocketContextから取得
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);

  useEffect(() => {
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  const clearActiveThought = useCallback(() => {
    setActiveMessage(prev => (prev?.thoughtMode ? null : prev));
  }, []);

  const historyState = useRef({
    oldestTs: null as number | null,
    loadedIds: new Set<string>(),
    pendingHistory: new Set<number>(),
    finished: false,
    isFetchingHistory: false,
    histReqId: 10000,
    requestMeta: new Map<number, { mode: 'older' | 'newer' | 'initial' }>(),
  });
  const latestTsRef = useRef<number | null>(null);
  const hasLoadedOnceRef = useRef(false);

  // 追加: ターン終了時の最終確定処理
  const finalizeTurn = useCallback(() => {
    const am = activeMessageRef.current;
    // 1) activeMessage を確定（内容が空なら確定しない）
    if (am && am.content?.trim()) {
      setMessages(prev => {
        if (prev.some(m => m.id === am.id)) return prev; // 既に addMessage 済みならスキップ
        return [
          ...prev,
          { id: am.id, ts: Date.now(), role: 'assistant', content: am.content }
        ];
      });
    }
    setActiveMessage(null);

    // 2) 走っているツールカードをすべて finished にフォールバック
    setMessages(prev =>
      prev.map(m => {
        if ((m.role === 'tool' || m.type === 'tool') && (m.status === 'running' || m.status === 'in_progress' || !m.status)) {
          return { ...m, status: 'finished', ts: Date.now() } as any;
        }
        return m;
      })
    );

    setIsGeneratingResponse(false);
    onMessageReceived?.();
  }, [onMessageReceived]);

  useEffect(() => {
    if (!ws) return;

    const unsubscribe = subscribe((msg: any) => {
      // --- 追加: JSON-RPC 応答の stopReason をターン終了トリガとして扱う ---
      if (msg?.result && typeof msg.result === 'object' && (msg.result.stopReason === 'end_turn' || msg.result.stopReason === 'message_end')) {
        finalizeTurn();
        return;
      }

      // 既存: thought/assistant chunk 処理
      if (msg.method === 'streamAssistantThoughtChunk') {
        const { thought } = msg.params;
        setActiveMessage(prev => ({
          id: prev?.id || msg.id || `thought-${Date.now()}`,
          ts: prev?.ts || Date.now(),
          type: 'thought',
          content: thought.trim(),
          thoughtMode: true,
        }));
        onMessageReceived?.();
        return;
      }

      if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId; // 可能ならサーバIDを使用

        setActiveMessage(prevActiveMessage => {
          const currentIdFromServer = incomingMessageId || msg.id || `assistant-${Date.now()}`;
          let currentId = prevActiveMessage?.id ?? currentIdFromServer;
          let currentTs = prevActiveMessage?.ts || Date.now();
          let newContent = prevActiveMessage?.content || '';
          let newType = prevActiveMessage?.type || 'thought';
          let newThoughtMode = prevActiveMessage?.thoughtMode || false;

          if (chunk?.thought !== undefined) {
            newContent = chunk.thought.trim();
            newType = 'thought';
            newThoughtMode = true;
          }

          if (chunk?.text !== undefined) {
            // thought -> text の切り替えでサーバIDに乗り換え
            if (newType === 'thought' && incomingMessageId) {
              currentId = incomingMessageId;
            }
            if (newType === 'thought') {
              newContent = chunk.text.replace(/^\n+/, '');
            } else {
              newContent = (prevActiveMessage?.content || '') + chunk.text.replace(/^\n+/, '');
            }
            newType = 'assistant';
            newThoughtMode = false;
          }

          if (chunk?.ts) currentTs = chunk.ts;

          return {
            id: currentId || currentIdFromServer,
            ts: currentTs,
            type: newType as 'thought' | 'assistant',
            content: newContent,
            thoughtMode: newThoughtMode,
          };
        });

        if (msg.id !== undefined && ws) {
          sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: null });
        }
        onMessageReceived?.();
        return;
      }

      // 既存: メッセージ確定（メソッド版）
      if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        finalizeTurn();
        return;
      }

      // 既存: addMessage（assistant 到着時は active を即クリア）
      if (msg.method === 'addMessage') {
        const { message } = msg.params;

        flushSync(() => {
          setMessages(prev => {
            if (prev.some(m => m.id === message.id)) return prev;
            const converted = {
              id: message.id,
              ts: message.ts,
              role: message.role,
              content: message.text,
              files: message.files || [],
              goal: message.goal || null,
              session: message.session || null,
            };
            return [...prev, converted];
          });
        });

        if (message.role === 'assistant') {
          setActiveMessage(curr => (curr?.id === message.id ? null : curr));
        }
        // 最新 ts 更新は既存ロジックに任せる
        onMessageReceived?.();
        return;
      }

      // 既存: pushToolCall（前段本文を確定→カード）
      if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations } = msg.params;
        const command = locations?.[0]?.path ?? '';

        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];

            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const am = activeMessageRef.current;
              const partId = `${am.id}#pre#${toolId}`;
              if (!newMessages.some(m => m.id === partId)) {
                newMessages.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content });
              }
            }

            newMessages.push({
              id: toolId,
              ts: msg.ts || Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: 'ツールを実行中...',
            } as any);

            return newMessages;
          });
          setActiveMessage(null);
        });

        if (ws) {
          sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: { id: toolId } });
        }
        onMessageReceived?.();
        return;
      }

      // 既存: requestToolCallConfirmation（前段本文を確定→カード）
      if (msg.method === 'requestToolCallConfirmation') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, confirmation } = msg.params;
        const command = confirmation?.command ?? '';

        if (ws) {
          sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: { id: toolId, outcome: 'allow' } });
        }

        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];

            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const am = activeMessageRef.current;
              const partId = `${am.id}#pre#${toolId}`;
              if (!newMessages.some(m => m.id === partId)) {
                newMessages.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content });
              }
            }

            newMessages.push({
              id: toolId,
              ts: msg.ts || Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: confirmation?.details ?? 'ツールの確認を待っています...',
            } as any);

            return newMessages;
          });
          setActiveMessage(null);
        });
        onMessageReceived?.();
        return;
      }

      // 修正: updateToolCall（ステータス正規化＋先行updateのフォールバック）
      if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;
        const normalized = normalizeToolStatus(status) || undefined;

        setMessages(prevMessages => {
          const newMessages = [...prevMessages];
          let idx = newMessages.findIndex(m => m.id === toolId);

          if (idx === -1) {
            // カード未作成 → 前段本文確定してカード生成
            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const am = activeMessageRef.current;
              const partId = `${am.id}#pre#${toolId}`;
              if (!newMessages.some(m => m.id === partId)) {
                newMessages.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content });
              }
              setActiveMessage(null);
            }
            newMessages.push({
              id: toolId,
              ts: Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              status: normalized || 'running',
              content: '',
            } as any);
            idx = newMessages.length - 1;
          }

          const m: any = { ...newMessages[idx] };

          if (content?.__headerPatch) {
            const { icon, label, command } = content.__headerPatch;
            if (icon !== undefined) m.icon = icon;
            if (label !== undefined) m.label = label;
            if (command !== undefined) m.command = command;
          } else if (content) {
            if (content.type === 'markdown' && typeof content.markdown === 'string') {
              m.content = content.markdown;
            } else if (content.type === 'diff') {
              m.content = generateContextualDiffHtml(content.oldText, content.newText);
            } else if (typeof content === 'string') {
              m.content = `<pre>${content}</pre>`;
            } else {
              m.content = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
            }
          }

          if (normalized) m.status = normalized;
          m.ts = Date.now();
          newMessages[idx] = m;
          return newMessages;
        });

        onMessageReceived?.();
        return;
      }

      // 既存: pushChunk（tool からのストリーム増分）
      if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const textContent = msg.params.chunk.text;

        setMessages(prevMessages =>
          prevMessages.map(m => {
            if (m.id === toolId) {
              let newContent = m.content || '';
              if (msg.params.chunk.type === 'diff') {
                newContent += textContent.split('\n').map((line: string) => {
                  if (line.startsWith('+')) return `<span class="add">${line}</span>`;
                  if (line.startsWith('-')) return `<span class="del">${line}</span>`;
                  return line;
                }).join('\n');
              } else {
                newContent += textContent;
              }
              return { ...m, content: newContent } as any;
            }
            return m;
          })
        );
        return;
      }

      // ...（履歴ロード等の既存分岐）
    });

    return () => unsubscribe();
  }, [ws, subscribe, sendWsMessage, finalizeTurn, onMessageReceived]);

  const sendMessage = useCallback((messageData: SendMessageData) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || isGeneratingResponse) { // ws.current から ws に変更
      console.warn("WebSocket is not open or busy, cannot send message.");
      return;
    }

    setIsGeneratingResponse(true);

    const { text, files, goal, session, features } = messageData;

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
      params: { chunks: [{ text, files, goal, messageId: newMessage.id, session, features }] }
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
      historyState.current.requestMeta.set(id, { mode: isInitialLoad ? 'initial' : 'older' });
    } else {
      console.warn("WebSocket is not open, cannot fetch history.");
      historyState.current.isFetchingHistory = false;
    }
  }, [ws, sendWsMessage]); // wsとsendWsMessageを依存配列に追加

  const requestDelta = useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (historyState.current.isFetchingHistory) return;
    const after = latestTsRef.current;
    if (!after) return; // 初回は通常ロード
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    historyState.current.requestMeta.set(id, { mode: 'newer' });
    console.log('[useChat DEBUG] Sending fetchHistory delta with id:', id, 'after:', after);
    sendWsMessage({ jsonrpc: '2.0', id, method: 'fetchHistory', params: { after } });
  }, [ws, sendWsMessage]);

  const cancelSendMessage = useCallback(() => {
    if (!ws) return;

    const req = {
      jsonrpc: '2.0', // ← '20' になっていたのを修正
      id: lastSentRequestId.current,
      method: 'cancelSendMessage',
      params: {}
    };
    sendWsMessage(req);

    // フロント側フォールバック: 現在のストリームを確定させてからクリア
    setMessages(prev => {
      const am = activeMessageRef.current;
      if (!am || !am.content || !am.content.trim()) return prev;

      // 既に確定済みでない場合にだけ追加（idで重複排除）
      if (prev.some(m => m.id === am.id)) return prev;

      const finalized: Message = {
        id: am.id,
        ts: am.ts || Date.now(),
        role: 'assistant',
        content: am.content,
        type: 'text',
      };
      return [...prev, finalized];
    });

    setActiveMessage(null);
    setIsGeneratingResponse(false);
  }, [ws, sendWsMessage]);

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
      requestMeta: new Map<number, { mode: 'older' | 'newer' | 'initial' }>(),
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
      console.log('[useChat DEBUG] WebSocket is open. Loading history or delta.');
      if (hasLoadedOnceRef.current && (latestTsRef.current ?? 0) > 0 && messages.length > 0) {
        requestDelta();
      } else {
        requestHistory(true);
        hasLoadedOnceRef.current = true;
      }
    }
  }, [ws, requestHistory, requestDelta, messages.length]);

  useEffect(() => {
    // 最新tsの追跡
    const maxTs = messages.reduce((acc, m) => Math.max(acc, m.ts || 0), latestTsRef.current ?? 0);
    if (maxTs > (latestTsRef.current ?? 0)) latestTsRef.current = maxTs;
  }, [messages]);

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
};
