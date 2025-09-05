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
  origin?: MessageOrigin;
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

  const finalizeTurn = useCallback(() => {
    const am = activeMessageRef.current;
    if (am && am.content?.trim()) {
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === am.id);
        if (idx !== -1) {
          const list = [...prev];
          const old = list[idx];
          list[idx] = { ...old, content: am.content, ts: am.ts ?? old.ts, role: 'assistant', origin: old.origin ?? 'shadow' };
          return list;
        }
        return [...prev, {
          id: am.id,
          ts: am.ts ?? Date.now(),
          role: 'assistant',
          content: am.content,
          origin: 'shadow' as const,
        }];
      });
    }
    setActiveMessage(null);

    setMessages(prev => prev.map(m => {
      if ((m.role === 'tool' || m.type === 'tool') && (m.status === 'running' || m.status === 'in_progress' || !m.status)) {
        if (m.status === 'finished') return m;
        return { ...m, status: 'finished' };
      }
      return m;
    }));

    setIsGeneratingResponse(false);
    onMessageReceived?.();
  }, [onMessageReceived]);

  useEffect(() => {
    if (!ws) return;

    const unsubscribe = subscribe((msg: any) => {
      if (msg?.result && typeof msg.result === 'object' && (msg.result.stopReason === 'end_turn' || msg.result.stopReason === 'message_end')) {
        finalizeTurn();
        return;
      }

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
            if (type === 'thought' && incomingMessageId) id = incomingMessageId;
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

      if (msg.method === 'addMessage') {
        const { message } = msg.params;

        flushSync(() => {
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === message.id);
            const updated = {
              id: message.id,
              ts: message.ts,
              role: message.role,
              content: message.text,
              files: message.files || [],
              goal: message.goal || null,
              session: message.session || null,
              origin: 'server' as const,
            } as Message;

            if (idx !== -1) {
              // サーバーが正とみなし、既存を置き換え（重複防止）
              const list = [...prev];
              list[idx] = { ...list[idx], ...updated };
              return list;
            }

            const next = [...prev, updated];
            return next;
          });
          // 重複履歴の再読込を防ぐ
          historyState.current.loadedIds.add(message.id);
        });

        if (message.role === 'assistant') {
          setActiveMessage(null);
          setIsGeneratingResponse(false);
        }
        onMessageReceived?.();
        return;
      }

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
                newMessages.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content, origin: 'shadow' as const });
              }
            }
            newMessages.push({
              id: toolId, ts: msg.ts || Date.now(), role: 'tool', type: 'tool', toolCallId: toolId,
              icon, label, command, status: 'running', content: 'ツールを実行中...',
            } as any);
            return newMessages;
          });
          setActiveMessage(null);
          // ツールIDも既読として記録（履歴との重複防止）
          historyState.current.loadedIds.add(toolId);
        });
        if (ws) sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: { id: toolId } });
        onMessageReceived?.();
        return;
      }

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
            list.push({
              id: toolId,
              ts: Date.now(),
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              status: normalized || 'running',
              content: ''
            } as any);
            idx = list.length - 1;
            historyState.current.loadedIds.add(toolId);
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
          list[idx] = m;
          return list;
        });
        onMessageReceived?.();
        return;
      }

      if (msg.id !== undefined && msg.result?.messages) {
        const meta = historyState.current.requestMeta.get(msg.id);
        const raw = msg.result.messages;

        const rawMessages = raw.filter((m: any) => !historyState.current.loadedIds.has(m.id));
        if (rawMessages.length > 0) {
          // サーバーからの配列順を信頼して並び替えしない（到着順維持）

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
            } else {
                historyState.current.newestTs = Math.max(historyState.current.newestTs ?? 0, ...raw.map((m:any) => m.ts));
                return [...prev, ...newUIMessages];
            }
          });
        }

        const reqMeta = historyState.current.requestMeta.get(msg.id);
        const reqLimit = reqMeta?.limit ?? (reqMeta?.mode === 'initial' ? 30 : 20);
        if (reqMeta?.mode === 'older' || reqMeta?.mode === 'initial') {
          if (raw.length < reqLimit) historyState.current.finished = true;
        }

        historyState.current.isFetchingHistory = false;
        historyState.current.pendingHistory.delete(msg.id);
        historyState.current.requestMeta.delete(msg.id);
        return;
      }

      if (msg.id !== undefined && msg.result === null) {
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
        origin: 'shadow',
      };
    setMessages(prev => [...prev, newMessage]);
    // 後続の履歴取り込みで重複しないよう記録
    historyState.current.loadedIds.add(newMessage.id);
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

  const requestHistory = useCallback((isInitialLoad = false) => {
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWsMessage({ jsonrpc: '2.0', id, method: 'fetchHistory', params: { limit, before: historyState.current.oldestTs ?? undefined } });
      historyState.current.requestMeta.set(id, { mode: isInitialLoad ? 'initial' : 'older', limit });
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
    const maxTsFromServer = messages
      .filter(m => m.origin === 'server')
      .reduce((acc, m) => Math.max(acc, m.ts || 0), latestTsRef.current ?? 0);
    if (maxTsFromServer > (latestTsRef.current ?? 0)) latestTsRef.current = maxTsFromServer;
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
