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
  updatedTs?: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  files?: FileInfo[];
  goal?: Goal | null;
  type?: 'text' | 'tool';
  toolCallId?: string;
  status?: 'pending' | 'running' | 'finished' | 'error' | 'in_progress';
  icon?: string;
  label?: string;
  command?: string;
  cmdKey?: string;
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

function normalizeToolStatus(status?: string): 'pending' | 'running' | 'finished' | 'error' | undefined {
  if (!status) return undefined;
  const s = String(status).toLowerCase();
  if (['completed','complete','done','finished','success','succeeded'].includes(s)) return 'finished';
  if (['pending'].includes(s)) return 'pending';
  if (['in_progress','running','started'].includes(s)) return 'running';
  if (['error','failed','failure'].includes(s)) return 'error';
  return undefined;
}

const historyRequestTimeoutMs = 8000;

export const useChat = ({ onMessageReceived }: { onMessageReceived?: () => void } = {}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeMessage, setActiveMessage] = useState<ActiveMessage | null>(null);
  const activeMessageRef = useRef<ActiveMessage | null>(null);
  // ツール開始時に残したスナップショット（同一 messageId の直前本文）を保持
  const snapshotContentRef = useRef<Map<string, string>>(new Map());
  // 直前に確定した assistant 本文のプレフィクスを、次のストリーム先頭で一度だけトリム
  const pendingTrimPrefixRef = useRef<string | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  const [isNotifyBusy, setIsNotifyBusy] = useState<boolean>(false);
  const [notifyBusyReason, setNotifyBusyReason] = useState<string | null>(null);
  const [isModelRestarting, setIsModelRestarting] = useState<boolean>(false);
  const [modelRestartReason, setModelRestartReason] = useState<string | null>(null);
  const { ws, subscribe, sendMessage: sendWsMessage, isConnected } = useWebSocket();
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);
  const deltaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the assistant message id for the current visible turn
  const currentAssistantIdRef = useRef<string | null>(null);
  const pendingRequests = useRef<Map<number, { method: string }>>(new Map());
  const pendingUserByReqId = useRef<Map<number, string>>(new Map());
  const refreshInFlightRef = useRef<boolean>(false);
  const handoverInFlightRef = useRef<boolean>(false);

  useEffect(() => {
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  useEffect(() => {
    const onModelChangeStart = () => {
      refreshInFlightRef.current = true;
      setIsModelRestarting(true);
      setModelRestartReason('model-change');
    };
    const onModelChangeCancel = () => {
      refreshInFlightRef.current = false;
      if (!handoverInFlightRef.current) {
        setIsModelRestarting(false);
        setModelRestartReason(null);
      }
    };
    try {
      window.addEventListener('chat:model-change-start', onModelChangeStart as any);
      window.addEventListener('chat:model-change-cancel', onModelChangeCancel as any);
    } catch {}
    return () => {
      try {
        window.removeEventListener('chat:model-change-start', onModelChangeStart as any);
        window.removeEventListener('chat:model-change-cancel', onModelChangeCancel as any);
      } catch {}
    };
  }, []);

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
        const last = prev[prev.length - 1];
        const sameContentAlready = !!last && last.role === 'assistant' && typeof last.content === 'string' && last.content.trim() === am.content.trim();
        if (sameContentAlready) return prev;
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

    onMessageReceived?.();
    // このターンのスナップショットは忘れる（同一IDの重複トリム不要に）
    if (am?.id) snapshotContentRef.current.delete(am.id);
    // 直前確定のプレフィクスもクリア
    pendingTrimPrefixRef.current = null;
  }, [onMessageReceived]);

  useEffect(() => {
    if (!ws) return;

    const unsubscribe = subscribe((msg: any) => {
      // サーバーからAIの状態を受信
      if (msg?.method === 'aiStatus') {
        setIsGeneratingResponse(Boolean(msg?.params?.active));
        return;
      }
      // サーバーが思考クリアを指示した場合は、思考中のアクティブメッセージを破棄
      if (msg?.method === 'clearActiveThought') {
        // アクティブな思考表示を消す + タイムライン上の思考バブルも除去
        setActiveMessage(prev => (prev && prev.type === 'thought') ? null : prev);
        setMessages(prev => prev.filter(m => !m.thoughtMode));
        return;
      }

      // 通知生成のビジーフラグ（送信ガード用）
      if (msg?.method === 'notifyBusy') {
        const active = Boolean(msg?.params?.active);
        setIsNotifyBusy(active);
        setNotifyBusyReason(active ? (typeof msg?.params?.reason === 'string' ? msg.params.reason : null) : null);
        return;
      }

      if (msg?.method === 'historyCleared') {
        const reason = (msg?.params as any)?.reason ?? null;
        if (reason === 'refresh' || reason === 'model-change') {
          refreshInFlightRef.current = false;
          setIsModelRestarting(false);
          setModelRestartReason(null);
        }
        handoverInFlightRef.current = false;
        setMessages([]);
        setActiveMessage(null);
        historyState.current = {
          oldestTs: null,
          newestTs: null,
          loadedIds: new Set<string>(),
          pendingHistory: new Set<number>(),
          finished: false,
          isFetchingHistory: false,
          histReqId: 10000,
          requestMeta: new Map<number, { mode: 'older' | 'newer' | 'initial', limit?: number }>(),
        };
        return;
      }

      if (msg?.method === 'geminiRestarting') {
        const params = (msg?.params as any) || {};
        const scope = params.scope || 'main';
        const reason = typeof params.reason === 'string' ? params.reason : null;
        if (scope === 'main') {
          if (reason === 'refresh' || reason === 'model-change') {
            refreshInFlightRef.current = true;
          } else if (reason === 'handover') {
            handoverInFlightRef.current = true;
          }
          if (reason) setModelRestartReason(reason);
          setIsModelRestarting(true);
        }
        return;
      }
      if (msg?.method === 'geminiReady') {
        const params = (msg?.params as any) || {};
        const scope = params.scope || 'main';
        const reason = typeof params.reason === 'string' ? params.reason : null;
        if (scope === 'main') {
          if (reason === 'refresh-complete' || reason === 'refresh-error') {
            refreshInFlightRef.current = false;
            setIsModelRestarting(false);
            setModelRestartReason(null);
          } else if (reason === 'model-change-complete' || reason === 'model-change-error') {
            refreshInFlightRef.current = false;
            setIsModelRestarting(false);
            setModelRestartReason(null);
          } else if (reason === 'handover-complete' || reason === 'handover-error') {
            handoverInFlightRef.current = false;
            setIsModelRestarting(false);
            setModelRestartReason(null);
          } else if (!refreshInFlightRef.current && !handoverInFlightRef.current) {
            setIsModelRestarting(false);
            setModelRestartReason(null);
          }
        }
        return;
      }

      // ストリーム完了通知（ターン終端）。確定処理を実行
      if (msg?.id !== undefined && msg?.error && typeof msg.error?.message === 'string') {
        const reqId = Number(msg.id);
        const pendingReq = pendingRequests.current.get(reqId);
        // Roll back optimistic user message if server rejected (e.g., notify_busy)
        const mid = pendingUserByReqId.current.get(reqId);
        if (mid) {
          pendingUserByReqId.current.delete(reqId);
          setMessages(prev => prev.filter(m => m.id !== mid));
        }
        if (pendingReq?.method === 'chat.refresh') {
          refreshInFlightRef.current = false;
          setIsModelRestarting(false);
          setModelRestartReason(null);
        }
        if (pendingReq?.method === 'chat.handover') {
          handoverInFlightRef.current = false;
        }
        pendingRequests.current.delete(reqId);
        return;
      }

      if (msg?.id !== undefined && msg?.result !== undefined) {
        const reqId = Number(msg.id);
        const pendingReq = pendingRequests.current.get(reqId);
        if (pendingReq?.method === 'requestAiStatus') {
          setIsGeneratingResponse(Boolean((msg.result as any)?.active));
          pendingRequests.current.delete(reqId);
          pendingUserByReqId.current.delete(reqId);
          return;
        }

        if (pendingReq?.method === 'chat.refresh') {
          refreshInFlightRef.current = false;
          setIsModelRestarting(false);
          setModelRestartReason(null);
          pendingRequests.current.delete(reqId);
          pendingUserByReqId.current.delete(reqId);
          return;
        }
        if (pendingReq?.method === 'chat.handover') {
          handoverInFlightRef.current = false;
          pendingRequests.current.delete(reqId);
          pendingUserByReqId.current.delete(reqId);
          return;
        }

        if (pendingUserByReqId.current.has(reqId)) {
          pendingUserByReqId.current.delete(reqId);
        }
        if (pendingReq) {
          pendingRequests.current.delete(reqId);
        }
      }

      if (msg?.method === 'messageCompleted') {
        // After a turn completes, reconcile with server to heal any missed chunks
        if (deltaTimerRef.current) clearTimeout(deltaTimerRef.current);
        deltaTimerRef.current = setTimeout(() => {
          try { requestDelta(); } catch {}
        }, 150);
        // Only finalize if this completion corresponds to the current assistant stream
        const mid = (msg as any)?.params?.messageId as string | undefined;
        if (mid && currentAssistantIdRef.current && mid === currentAssistantIdRef.current) {
          finalizeTurn();
          currentAssistantIdRef.current = null;
        }

        // messageCompleted の params に stopReason が含まれている場合、それが真の終了
        if (msg?.params?.stopReason === 'end_turn' || msg?.params?.stopReason === 'message_end' || msg?.params?.stopReason === 'canceled') {
          setIsGeneratingResponse(false);
        }
        return;
      }
      if (msg?.result && typeof msg.result === 'object' && (msg.result.stopReason === 'end_turn' || msg.result.stopReason === 'message_end')) {
        finalizeTurn();
        setIsGeneratingResponse(false);
        return;
      }

      if (msg.method === 'streamAssistantMessageChunk') {
        try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:pre-mutate', { detail: { kind: 'text', action: 'chunk', messageId: msg.params?.messageId } })); } catch {}
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId;
        const fallbackId = msg.id || `assistant-${Date.now()}`;
        const previousActiveId = activeMessageRef.current?.id;
        const resolvedId = incomingMessageId ?? previousActiveId ?? fallbackId;
        const idChanged = Boolean(incomingMessageId && previousActiveId && incomingMessageId !== previousActiveId);
        const previousThoughtId = previousActiveId ? `${previousActiveId}#thought` : undefined;
        const nextThoughtId = resolvedId ? `${resolvedId}#thought` : undefined;

        setActiveMessage(prevActiveMessage => {
          let id = resolvedId;
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
            const incoming = chunk.text.replace(/^\n+/, '');
            if (type === 'thought') {
              content = incoming;
            } else {
              content = (prevActiveMessage?.content || '') + incoming;
            }
            type = 'assistant';
            thoughtMode = false;
          }

          if (chunk?.ts) ts = chunk.ts;

          return { id, ts, type: type as any, content, thoughtMode };
        });

        // Track current assistant stream id as soon as we know it
        if (resolvedId) currentAssistantIdRef.current = resolvedId;

        // タイムライン内に仮のアシスタントメッセージを配置・更新（受信順を維持）
        const textId = resolvedId;
        const thoughtId = nextThoughtId;
        if (textId) {
          flushSync(() => {
            setMessages(prev => {
              const list = [...prev];
              if (idChanged && previousActiveId && previousActiveId !== textId) {
                const prevIdx = list.findIndex(m => m.id === previousActiveId);
                if (prevIdx !== -1) {
                  list[prevIdx] = { ...list[prevIdx], id: textId };
                }
                if (previousThoughtId && thoughtId && previousThoughtId !== thoughtId) {
                  const prevThoughtIdx = list.findIndex(m => m.id === previousThoughtId);
                  if (prevThoughtIdx !== -1) {
                    list[prevThoughtIdx] = { ...list[prevThoughtIdx], id: thoughtId };
                  }
                }
              }

              const idxText = list.findIndex(m => m.id === textId);
              const idxThought = thoughtId ? list.findIndex(m => m.id === thoughtId) : -1;
              const nowTs = (chunk?.ts) || Date.now();
              if (chunk?.thought !== undefined && chunk?.text === undefined && thoughtId) {
                const thoughtContent = String(chunk.thought || '').trim();
                const thoughtEntry: any = {
                  id: thoughtId,
                  ts: nowTs,
                  role: 'assistant',
                  content: thoughtContent,
                  origin: 'shadow',
                  type: 'text',
                  thoughtMode: true,
                };
                if (idxThought !== -1) list[idxThought] = { ...list[idxThought], ...thoughtEntry };
                else if (thoughtContent) list.push(thoughtEntry);
              }

              if (chunk?.text !== undefined) {
                const incoming = String(chunk.text || '').replace(/^\n+/, '');
                const baseText = idxText !== -1 ? (list[idxText]?.content || '') : '';
                // テキストが始まったら、対応する thought バブルは消す
                if (idxThought !== -1) list.splice(idxThought, 1);
                let textPart = '';
                if (baseText) {
                  textPart = baseText + incoming;
                } else {
                  // 新規テキスト開始。直前確定やスナップショットと重複する先頭をトリム
                  const incTrim = incoming.trimStart();
                  const pendingPrefix = pendingTrimPrefixRef.current?.trim() || '';
                  const tryTrim = (prefix: string | undefined) => {
                    if (!prefix) return null as string | null;
                    const p = prefix.trim();
                    if (!p) return null;
                    if (incTrim.startsWith(p)) return incTrim.slice(p.length);
                    if (p.startsWith(incTrim)) return '';
                    return null;
                  };
                  let trimmed: string | null = tryTrim(pendingPrefix);
                  if (trimmed !== null) {
                    textPart = trimmed;
                    pendingTrimPrefixRef.current = null;
                  } else {
                    textPart = incoming;
                  }
                }

                const textEntry: any = {
                  id: textId,
                  ts: nowTs,
                  role: 'assistant',
                  content: textPart,
                  origin: 'shadow',
                  type: 'text',
                  thoughtMode: false,
                };
                if (idxText !== -1) list[idxText] = { ...list[idxText], ...textEntry };
                else if (textPart) list.push(textEntry);
              }
              return list;
            });
          });
        }

        if (msg.id !== undefined && ws) sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: null });
        onMessageReceived?.();
        return;
      }

      if (msg.method === 'addMessage') {
        try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:pre-mutate', { detail: { kind: 'text', action: 'add', messageId: msg.params?.message?.id } })); } catch {}
        const { message } = msg.params;

        // If this is the assistant's final message being added (no stream chunks case),
        // capture its id so that the upcoming messageCompleted can finalize the correct turn.
        if (isGeneratingResponse && message?.role === 'assistant' && typeof message?.id === 'string') {
          currentAssistantIdRef.current = message.id;
        }

        flushSync(() => {
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === message.id);
            const updated = {
              id: message.id,
              ts: message.ts,
              updatedTs: (message as any).updatedTs,
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

            const provisionalId = currentAssistantIdRef.current || activeMessageRef.current?.id;
            if (provisionalId && provisionalId !== message.id) {
              const provisionalIdx = prev.findIndex(m => m.id === provisionalId);
              if (provisionalIdx !== -1) {
                const list = [...prev];
                list[provisionalIdx] = { ...list[provisionalIdx], ...updated };
                currentAssistantIdRef.current = message.id;
                return list;
              }
            }

            const next = [...prev, updated];
            return next;
          });
          // 重複履歴の再読込を防ぐ
          historyState.current.loadedIds.add(message.id);
        });

        if (message.role === 'assistant') {
          if (typeof (message as any).text === 'string' && (message as any).text.trim()) {
            try { pendingTrimPrefixRef.current = (message as any).text.trim(); } catch {}
          }
          // サーバーからの addMessage（部分確定または確定）は、生成中フラグを落とさない。
          // 真のターン終了は messageCompleted/stopReason で finalizeTurn し、そこで isGeneratingResponse を false にする。
          setActiveMessage(null);
        }
        onMessageReceived?.();
        return;
      }

      if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations, status, cmdKey } = msg.params;
        const command = locations?.[0]?.path ?? '';

        try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:pre-mutate', { detail: { kind: 'tool', action: 'add', toolId } })); } catch {}
        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];
            const am = activeMessageRef.current;
            if (am) {
              // 進行中の仮エントリ（am.id）は残す。順序維持のため削除しない
              // 思考バブルも除去
              const thoughtIdx = newMessages.findIndex(m => m.id === `${am.id}#thought`);
              if (thoughtIdx !== -1) newMessages.splice(thoughtIdx, 1);
            }
            newMessages.push({
              id: toolId, ts: msg.ts || Date.now(), role: 'tool', type: 'tool', toolCallId: toolId,
              icon, label, command, cmdKey, status: (status as any) || 'running', content: (status === 'pending' ? '' : 'ツールを実行中...'),
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
        const { status, content, icon, label, command, cmdKey } = msg.params;
        const normalized = normalizeToolStatus(status) || undefined;

        try { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('chat:pre-mutate', { detail: { kind: 'tool', action: 'update', toolId } })); } catch {}
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
              content: '',
              icon: icon ?? 'tool',
              label: label ?? 'Tool',
              command: command ?? '',
              cmdKey: cmdKey ?? undefined,
            } as any);
            idx = list.length - 1;
            historyState.current.loadedIds.add(toolId);
          }

          const m: any = { ...list[idx] };
          if (icon !== undefined) m.icon = icon;
          if (label !== undefined) m.label = label;
          if (command !== undefined) m.command = command;
          if (cmdKey !== undefined) m.cmdKey = cmdKey;
          const prevContent: any = list[idx]?.content;
          const prevLooksLikeDiff = typeof prevContent === 'string' && prevContent.includes('diff-prefix');
          if (content?.__headerPatch) {
            const { icon, label, command } = content.__headerPatch;
            if (icon !== undefined) m.icon = icon;
            if (label !== undefined) m.label = label;
            if (command !== undefined) m.command = command;
          } else if (content) {
            // If we already show a diff, do not overwrite it unless a new diff arrives
            if (content.type === 'diff') {
              m.content = generateContextualDiffHtml(content.oldText, content.newText);
            } else if (!prevLooksLikeDiff) {
              if (content.type === 'markdown' && typeof content.markdown === 'string') m.content = content.markdown;
              else if (typeof content === 'string') m.content = `<pre>${content}</pre>`;
              else m.content = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
            }
          }
          if (normalized) m.status = normalized;
          list[idx] = m;
          return list;
        });
        // If tool finished, reconcile to ensure we didn't miss any updates
        if (normalized === 'finished') {
          if (deltaTimerRef.current) clearTimeout(deltaTimerRef.current);
          deltaTimerRef.current = setTimeout(() => {
            try { requestDelta(); } catch {}
          }, 150);
        }
        onMessageReceived?.();
        return;
      }

      if (msg.id !== undefined && msg.result?.messages) {
        const meta = historyState.current.requestMeta.get(msg.id);
        const raw = msg.result.messages;

        // サーバーが同一 id を重複して返すケース（途中確定→最終確定など）に備え、
        // 同一 id は「最後に現れたもの」を採用してバッチ内重複を除去する。
        const idOrder: string[] = [];
        const lastById = new Map<string, any>();
        for (const r of raw as any[]) {
          if (!lastById.has(r.id)) idOrder.push(r.id);
          lastById.set(r.id, r);
        }
        const uniqueRaw = idOrder.map(id => lastById.get(id));

        // サーバーからの順序を尊重しつつ、既存の shadow をサーバー値で置換する
        setMessages(prev => {
          const list = [...prev];
          const converted = (uniqueRaw as any[]).map((rm: any) => {
            // Normalize tool content for history (render diff/markdown as in live updates)
            let normalizedContent: any = rm.text ?? rm.content;
            if (rm.role === 'tool') {
              try {
                let obj = normalizedContent;
                if (typeof obj === 'string') {
                  const s = obj.trim();
                  if (s.startsWith('{') || s.startsWith('[')) {
                    try { obj = JSON.parse(s); } catch {}
                  }
                }
                if (obj && typeof obj === 'object') {
                  if (obj.type === 'diff') normalizedContent = generateContextualDiffHtml(obj.oldText || '', obj.newText || '');
                  else if (obj.type === 'markdown' && typeof obj.markdown === 'string') normalizedContent = obj.markdown;
                }
              } catch {}
            }
            const msg: Message = {
              id: rm.id,
              ts: rm.ts,
              updatedTs: rm.updatedTs,
              role: rm.role,
              content: normalizedContent,
              files: rm.files || [],
              goal: rm.goal || null,
              session: rm.session || null,
              type: rm.type,
              toolCallId: rm.toolCallId,
              status: rm.status,
              icon: rm.icon,
              label: rm.label,
              command: rm.command,
              cmdKey: (rm as any).cmdKey,
              origin: 'server' as const,
            };
            return msg;
          });

        const toInsert: Message[] = [];
        for (const m of converted) {
          const idx = list.findIndex(x => x.id === m.id);
          if (idx !== -1) {
            list[idx] = { ...list[idx], ...m };
          } else {
            // 未表示のものだけ挿入（list が真実のソース）
            toInsert.push(m);
          }
          historyState.current.loadedIds.add(m.id);
        }

        if (meta?.mode === 'older' || meta?.mode === 'initial') {
          historyState.current.oldestTs = Math.min(
            historyState.current.oldestTs ?? Infinity,
            ...uniqueRaw.map((m:any) => Math.max(Number(m.updatedTs || 0), Number(m.ts || 0)))
          );
          return [...toInsert, ...list];
        } else {
          historyState.current.newestTs = Math.max(
            historyState.current.newestTs ?? 0,
            ...uniqueRaw.map((m:any) => Math.max(Number(m.updatedTs || 0), Number(m.ts || 0)))
          );
          return [...list, ...toInsert];
        }
        });

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

  const sendMessage = useCallback((messageData: SendMessageData): boolean => {
    if (isGeneratingResponse || isNotifyBusy || isModelRestarting) {
      console.warn("Gemini is busy, cannot send message right now.");
      return false;
    }

    const socketReady = ws && ws.readyState === WebSocket.OPEN;
    if (!socketReady) {
      console.info('[useChat] WebSocket not ready yet, queueing message.');
    }
    setIsGeneratingResponse(true);
    // New user turn starts: clear previous assistant id tracking
    currentAssistantIdRef.current = null;
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
    // map req -> messageId for rollback on error
    pendingUserByReqId.current.set(reqId, newMessage.id);
    pendingRequests.current.set(reqId, { method: 'sendUserMessage' });
    sendWsMessage(req);
    return true;
  }, [ws, isGeneratingResponse, isNotifyBusy, isModelRestarting, sendWsMessage]);

  const refreshChat = useCallback((): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[useChat] WebSocket not ready for refresh.');
      return false;
    }
    if (refreshInFlightRef.current) {
      return false;
    }
    refreshInFlightRef.current = true;
    setIsModelRestarting(true);
    setModelRestartReason('refresh');
    const reqId = requestIdCounter.current++;
    pendingRequests.current.set(reqId, { method: 'chat.refresh' });
    sendWsMessage({ jsonrpc: '2.0', id: reqId, method: 'chat.refresh', params: {} });
    return true;
  }, [ws, sendWsMessage]);

  const handoverSnapshot = useCallback((): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[useChat] WebSocket not ready for handover.');
      return false;
    }
    if (handoverInFlightRef.current) {
      return false;
    }
    handoverInFlightRef.current = true;
    setIsModelRestarting(true);
    setModelRestartReason('handover');
    const reqId = requestIdCounter.current++;
    pendingRequests.current.set(reqId, { method: 'chat.handover' });
    sendWsMessage({ jsonrpc: '2.0', id: reqId, method: 'chat.handover', params: {} });
    return true;
  }, [ws, sendWsMessage]);

  const sendToolConfirmation = useCallback((toolCallId: string, result: boolean) => {
    if (!ws) return;
    // ツール確認時も、進行中ストリームを整理（思考は捨て、本文はスナップショット）
    flushSync(() => {
      const am = activeMessageRef.current;
      if (am) {
        setMessages(prev => {
          const list = [...prev];
          const idx = list.findIndex(m => m.id === am.id);
          if (idx !== -1) list.splice(idx, 1);
          if (am.type === 'assistant') {
            const partId = `${am.id}#pre#${toolCallId}`;
            if (!list.some(m => m.id === partId)) list.push({ id: partId, ts: am.ts, role: 'assistant', content: am.content, origin: 'shadow' });
          }
          return list;
        });
        setActiveMessage(null);
      }
    });
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

  // Advanced approval: 'allow_once' | 'allow_always' | 'deny' | 'deny_always'
  const sendToolApproval = useCallback((toolCallId: string, decision: 'allow_once'|'allow_always'|'deny'|'deny_always') => {
    if (!ws) return;
    const req = {
      jsonrpc: '2.0', id: requestIdCounter.current++, method: 'confirmToolCall',
      params: { toolCallId, result: decision !== 'deny' && decision !== 'deny_always', mode: decision }
    } as any;
    sendWsMessage(req);
    setMessages(prev => prev.map(m => (m.id === toolCallId ? { ...m, status: decision.startsWith('allow') ? 'running' : 'error' } : m)));
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
    if (!ws) return;
    const req = { jsonrpc: '2.0', id: requestIdCounter.current++, method: 'cancelSendMessage', params: {} };
    sendWsMessage(req);
    // Immediately clear any in-flight thought so it won't be promoted
    flushSync(() => {
      const am = activeMessageRef.current;
      if (am) {
        setMessages(prev => prev.filter(m => !m.thoughtMode));
        setActiveMessage(null);
      }
      pendingTrimPrefixRef.current = null;
    });
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
      const id = requestIdCounter.current++;
      sendWsMessage({ jsonrpc: '2.0', id, method: 'clearHistory', params: {} });
    }
  }, [ws, sendWsMessage]);

  // 接続断時に generating フラグや activeMessage を強制クリアしない。
  // ツール実行中やストリーミング中に一時的な切断が起きると、
  // 停止ボタンが送信ボタンに戻ってしまうため。
  useEffect(() => {
    if (isConnected === false) {
      // 進行中フラグは維持し、必要最低限のフラグのみ解除
      historyState.current.isFetchingHistory = false;
      // ADDED: Explicitly set isGeneratingResponse to false on disconnection
      setIsGeneratingResponse(false);
    }
  }, [isConnected]);

  // ADDED: Ensure send is not blocked by a stale generating flag on connection
  useEffect(() => {
    if (isConnected) {
      setIsGeneratingResponse(false);
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
      // Request AI status on connection
      const reqId = requestIdCounter.current++;
      pendingRequests.current.set(reqId, { method: 'requestAiStatus' });
      sendWsMessage({ jsonrpc: '2.0', id: reqId, method: 'requestAiStatus' });
    }
  }, [ws, requestHistory, requestDelta, messages.length]);

  useEffect(() => {
    const maxTsFromServer = messages
      .filter(m => m.origin === 'server')
      .reduce((acc, m) => Math.max(acc, m.updatedTs || 0, m.ts || 0), latestTsRef.current ?? 0);
    if (maxTsFromServer > (latestTsRef.current ?? 0)) latestTsRef.current = maxTsFromServer;
  }, [messages]);

  return {
    messages,
    activeMessage,
    isGeneratingResponse,
    isNotifyBusy,
    notifyBusyReason,
    isModelRestarting,
    modelRestartReason,
    isFetchingHistory: historyState.current.isFetchingHistory,
    historyFinished: historyState.current.finished,
    sendMessage,
    refreshChat,
    handoverSnapshot,
    cancelSendMessage,
    requestHistory,
    sendToolConfirmation,
    sendToolApproval,
    clearMessages,
  };
};
