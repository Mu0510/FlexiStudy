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

// 追加: メッセージの出所タグ（重複掃除に使う）
type MessageOrigin = 'server' | 'shadow';

interface Message {
  id: string;
  ts?: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  files?: FileInfo[];
  goal?: Goal | null;
  type?: 'text' | 'tool';
  toolCallId?: string;
  status?: 'running' | 'finished' | 'error' | 'in_progress';
  icon?: string;
  label?: string;
  command?: string;
  session?: { session: any; logEntry: any } | null;
  origin?: MessageOrigin; // ← 追加
}

interface ActiveMessage {
  id: string;
  ts: number;
  type: 'thought' | 'assistant';
  content: string;
  thoughtMode: boolean;
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
      let prefix = ' ';
      let content = line;

      if (line.startsWith('+')) {
        lineClass = 'add';
        prefix = '+';
        content = line.substring(1);
        oldNumHtml = `<span class="line-num"></span>`;
        newNumHtml = `<span class="line-num new">${newNum++}</span>`;
      } else if (line.startsWith('-')) {
        lineClass = 'del';
        prefix = '-';
        content = line.substring(1);
        oldNumHtml = `<span class="line-num old">${oldNum++}</span>`;
        newNumHtml = `<span class="line-num"></span>`;
      } else {
        lineClass = 'context';
        prefix = ' ';
        content = line.substring(1);
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

// 追加: ツールステータス正規化
function normalizeToolStatus(status?: string): 'running' | 'finished' | 'error' | undefined {
  if (!status) return undefined;
  const s = String(status).toLowerCase();
  if (['completed','complete','done','finished','success','succeeded'].includes(s)) return 'finished';
  if (['in_progress','running','pending','started'].includes(s)) return 'running';
  if (['error','failed','failure'].includes(s)) return 'error';
  return undefined;
}

const historyRequestTimeoutMs = 8000;

export const useChat = ({ onMessageReceived }: { onMessageReceived?: () => void } = {}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const activeMessageRef = useRef<ActiveMessage | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const { ws, subscribe, sendMessage: sendWsMessage, isConnected } = useWebSocket();
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);

  useEffect(() => {
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  const historyState = useRef({
    oldestTs: null as number | null,
    newestTs: null as number | null,
    loadedIds: new Set<string>(),
    pendingHistory: new Set<number>(),
    finished: false,
    isFetchingHistory: false,
    histReqId: 10000,
    requestMeta: new Map<number, { mode: 'older' | 'newer' | 'initial'; limit?: number }>(),
  });
  const latestTsRef = useRef<number | null>(null);
  const hasLoadedOnceRef = useRef(false);

  // finalize: シャドウ確定＋ツールのフォールバック終了
  const finalizeTurn = useCallback(() => {
    const am = activeMessageRef.current;
    if (am && am.content?.trim()) {
      setMessages(prev => {
        // 既に同一IDが確定済なら追加しない
        if (prev.some(m => m.id === am.id)) return prev;
        return [...prev, { id: am.id, ts: Date.now(), role: 'assistant', content: am.content, origin: 'shadow' }];
      });
    }
    setActiveMessage(null);

    // 走っているツールを finished に落とす（表示側の整合のため）
    setMessages(prev => prev.map(m => {
      if ((m.role === 'tool' || m.type === 'tool') && (m.status === 'running' || m.status === 'in_progress' || !m.status)) {
        return { ...m, status: 'finished', ts: Date.now() };
      }
      return m;
    }));

    setIsGeneratingResponse(false);
    onMessageReceived?.();
  }, [onMessageReceived]);

  useEffect(() => {
    if (!ws) return;

    const unsubscribe = subscribe((msg: any) => {
      // WebSocket受信内: stopReason によるターン終了を確定
      if (msg?.result && typeof msg.result === 'object' && (msg.result.stopReason === 'end_turn' || msg.result.stopReason === 'message_end')) {
        finalizeTurn();
        return;
      }

      // streamAssistantMessageChunk: thought→text 切替で server の messageId に乗り換え
      if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId;

        setActiveMessage(prevActiveMessage => {
          const fallbackId = msg.id || `assistant-${Date.now()}`;
          let id = prevActiveMessage?.id ?? incomingMessageId ?? fallbackId;
          let ts = prevActiveMessage?.ts || Date.now();
          let content = prevActiveMessage?.content || '';
          let type = prevActiveMessage?.type || 'thought';
          let thoughtMode = prevActiveMessage?.thoughtMode || false;

          if (chunk?.thought !== undefined) {
            content = chunk.thought.trim();
            type = 'thought';
            thoughtMode = true;
          }

          if (chunk?.text !== undefined) {
            if (type === 'thought' && incomingMessageId) id = incomingMessageId; // 正式IDへ
            content = (type === 'thought')
              ? chunk.text.replace(/^\n+/, '')
              : (prevActiveMessage?.content || '') + chunk.text.replace(/^\n+/, '');
            type = 'assistant';
            thoughtMode = false;
          }

          if (chunk?.ts) ts = chunk.ts;

          return { id, ts, type: type as any, content, thoughtMode };
        });

        if (msg.id !== undefined && ws) sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: null });
        onMessageReceived?.();
        return;
      }

      // addMessage: サーバ確定が来たらシャドウを掃除しスピナー停止
      if (msg.method === 'addMessage') {
        const { message } = msg.params;

        flushSync(() => {
          setMessages(prev => {
            // 既に同じIDがあれば追加しない
            if (prev.some(m => m.id === message.id)) return prev;

            const next = [...prev, {
              id: message.id,
              ts: message.ts,
              role: message.role,
              content: message.text,
              files: message.files || [],
              goal: message.goal || null,
              session: message.session || null,
              origin: 'server' as const,
            }];

            // 直近のシャドウ確定で内容が一致するものがあれば掃除
            if (message.role === 'assistant' && message.text?.trim()) {
              for (let i = next.length - 2; i >= 0 && i >= next.length - 6; i--) {
                const m = next[i];
                if (m.role === 'assistant' && m.origin === 'shadow' && (m.content || '').trim() === message.text.trim()) {
                  next.splice(i, 1);
                  break;
                }
              }
            }
            return next;
          });
        });

        if (message.role === 'assistant') {
          setActiveMessage(null);
          setIsGeneratingResponse(false); // スピナー停止
        }
        onMessageReceived?.();
        return;
      }

      // 既存の pushToolCall と requestToolCallConfirmation は、
      // updateToolCall のフォールバックでカバーされるため、ここでは特に変更しない
      // (元のコードベースにこれらのハンドラがあれば、それは維持される)
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
              id: toolId, ts: msg.ts || Date.now(), role: 'tool', type: 'tool', toolCallId: toolId,
              icon, label, command, status: 'running', content: 'ツールを実行中...',
            } as any);
            return newMessages;
          });
          setActiveMessage(null);
        });
        if (ws) sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: { id: toolId } });
        onMessageReceived?.();
        return;
      }

      // updateToolCall: ステータス正規化
      if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;
        const normalized = normalizeToolStatus(status) || undefined;

        setMessages(prevMessages => {
          const list = [...prevMessages];
          let idx = list.findIndex(m => m.id === toolId);

          if (idx === -1) {
            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const am = activeMessageRef.current;
              const partId = `${am.id}#pre#${toolId}`;
              if (!list.some(m => m.id === partId)) list.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content, origin: 'shadow' });
              setActiveMessage(null);
            }
            list.push({ id: toolId, ts: Date.now(), role: 'tool', type: 'tool', toolCallId: toolId, status: normalized || 'running', content: '' } as any);
            idx = list.length - 1;
          }

          const m: any = { ...list[idx] };
          if (content?.__headerPatch) {
            const { icon, label, command } = content.__headerPatch;
            if (icon !== undefined) m.icon = icon;
            if (label !== undefined) m.label = label;
            if (command !== undefined) m.command = command;
          } else if (content) {
            if (content.type === 'markdown' && typeof content.markdown === 'string') m.content = content.markdown;
            else if (content.type === 'diff') m.content = generateContextualDiffHtml(content.oldText, content.newText);
            else if (typeof content === 'string') m.content = `<pre>${content}</pre>`;
            else m.content = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
          }
          if (normalized) m.status = normalized;
          m.ts = Date.now();
          list[idx] = m;
          return list;
        });
        onMessageReceived?.();
        return;
      }

      // fetchHistory 応答（result.messages）は pendingHistory を問わず処理し、必ず解除
      if (msg.id !== undefined && msg.result?.messages) {
        const meta = historyState.current.requestMeta.get(msg.id);
        const raw = msg.result.messages;

        const rawMessages = raw.filter((m: any) => !historyState.current.loadedIds.has(m.id));
        if (rawMessages.length > 0) {
          rawMessages.sort((a: any, b: any) => a.ts - b.ts);

          setMessages(prev => {
            const prevIds = new Set(prev.map(p => p.id));
            const newUIMessages = rawMessages
              .map((m: any) => {
                  historyState.current.loadedIds.add(m.id);
                  return {
                      id: m.id, ts: m.ts, role: m.role, content: m.text || m.content,
                      files: m.files || [], goal: m.goal || null, session: m.session || null,
                      type: m.type, toolCallId: m.toolCallId, status: m.status, icon: m.icon,
                      label: m.label, command: m.command, origin: 'server'
                  };
              })
              .filter((m: Message) => !prevIds.has(m.id));

            if (meta?.mode === 'older' || meta?.mode === 'initial') {
                historyState.current.oldestTs = Math.min(historyState.current.oldestTs ?? Infinity, ...raw.map((m:any) => m.ts));
                return [...newUIMessages, ...prev];
            } else { // newer
                historyState.current.newestTs = Math.max(historyState.current.newestTs ?? 0, ...raw.map((m:any) => m.ts));
                return [...prev, ...newUIMessages];
            }
          });
        }

        // 取りきり判定（依頼時に記録した limit を使う）
        const reqMeta = historyState.current.requestMeta.get(msg.id);
        const reqLimit = reqMeta?.limit ?? (reqMeta?.mode === 'initial' ? 30 : 20);
        if (reqMeta?.mode === 'older' || reqMeta?.mode === 'initial') {
          if (raw.length < reqLimit) historyState.current.finished = true;
        }

        // 必ず解除
        historyState.current.isFetchingHistory = false;
        historyState.current.pendingHistory.delete(msg.id);
        historyState.current.requestMeta.delete(msg.id);
        return;
      }

      // result:null ACK は完了扱いにしない（既存の finalize ロジックに任せる）
      if (msg.id !== undefined && msg.result === null) {
        // no-op
        return;
      }

    });

    return () => unsubscribe();
  }, [ws, subscribe, sendWsMessage, finalizeTurn, onMessageReceived]);

  const sendMessage = useCallback((messageData: SendMessageData) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || isGeneratingResponse) {
      console.warn("WebSocket is not open or busy, cannot send message.");
      return;
    }
    setIsGeneratingResponse(true);
    const { text, files, goal, session, features } = messageData;
    const newMessage: Message = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2)}`,
        ts: Date.now(), role: "user", content: text, files: files || [],
        goal: goal || null, session: session || null, type: "text",
      };
    setMessages(prev => [...prev, newMessage]);
    const reqId = requestIdCounter.current++;
    lastSentRequestId.current = reqId;
    const req = {
      jsonrpc: '2.0', id: reqId, method: 'sendUserMessage',
      params: { chunks: [{ text, files, goal, messageId: newMessage.id, session, features }] }
    };
    sendWsMessage(req);
  }, [ws, isGeneratingResponse, sendWsMessage]);

  const sendToolConfirmation = useCallback((toolCallId: string, result: boolean) => {
    if (!ws) return;
    const req = {
      jsonrpc: '2.0', id: requestIdCounter.current++, method: 'confirmToolCall',
      params: { toolCallId, result }
    };
    sendWsMessage(req);
    setMessages(prev => prev.map(m => {
      if (m.id === toolCallId) {
        return { ...m, status: 'finished' };
      }
      return m;
    }));
  }, [ws, sendWsMessage]);

  // requestHistory: タイムアウト保険を追加、メタに mode と limit を保存
  const requestHistory = useCallback((isInitialLoad = false) => {
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWsMessage({ jsonrpc: '2.0', id, method: 'fetchHistory', params: { limit, before: historyState.current.oldestTs ?? undefined } });
      historyState.current.requestMeta.set(id, { mode: isInitialLoad ? 'initial' : 'older', limit });
      // タイムアウトで解除（保険）
      setTimeout(() => {
        if (historyState.current.pendingHistory.has(id)) {
          console.warn('[useChat] fetchHistory timeout; forcing release.');
          historyState.current.pendingHistory.delete(id);
          historyState.current.isFetchingHistory = false;
        }
      }, historyRequestTimeoutMs);
    } else {
      console.warn('WebSocket not open, cannot fetch history');
      historyState.current.isFetchingHistory = false;
    }
  }, [ws, sendWsMessage]);

  const requestDelta = useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (historyState.current.isFetchingHistory) return;
    const after = latestTsRef.current;
    if (!after) return;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    historyState.current.requestMeta.set(id, { mode: 'newer' });
    sendWsMessage({ jsonrpc: '2.0', id, method: 'fetchHistory', params: { after } });
  }, [ws, sendWsMessage]);

  // cancelSendMessage: jsonrpc を修正
  const cancelSendMessage = useCallback(() => {
    if (!ws || !lastSentRequestId.current) return;
    const req = { jsonrpc: '2.0', id: lastSentRequestId.current, method: 'cancelSendMessage', params: {} };
    sendWsMessage(req);
    setIsGeneratingResponse(false);
  }, [ws, sendWsMessage]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    setActiveMessage(null);
    historyState.current = {
      oldestTs: null, newestTs: null, loadedIds: new Set<string>(),
      pendingHistory: new Set<number>(), finished: false, isFetchingHistory: false,
      histReqId: 10000,
      requestMeta: new Map<number, { mode: 'older' | 'newer' | 'initial', limit?: number }>(),
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWsMessage({ jsonrpc: '2.0', method: 'clearHistory', params: {} });
    }
  }, [ws, sendWsMessage]);

  // 接続断時の保険
  useEffect(() => {
    if (isConnected === false) {
      setIsGeneratingResponse(false);
      setActiveMessage(null);
      historyState.current.isFetchingHistory = false;
    }
  }, [isConnected]);

  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (hasLoadedOnceRef.current && (latestTsRef.current ?? 0) > 0 && messages.length > 0) {
        requestDelta();
      } else {
        requestHistory(true);
        hasLoadedOnceRef.current = true;
      }
    }
  }, [ws, requestHistory, requestDelta, messages.length]);

  useEffect(() => {
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
    clearMessages,
  };
};
