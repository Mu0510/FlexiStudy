// webnew/hooks/useChat.ts (修正後の完成形コード)
import { useState, useEffect, useRef, useCallback } from 'react';
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

  useEffect(() => {
    if (!ws) return; // WebSocketインスタンスがまだ利用可能でない場合は何もしない

    // WebSocketからのメッセージ処理ロジックをsubscribeで登録
    const unsubscribe = subscribe((msg: any) => {
      // 1) ストリーム（既存）: activeMessage にだけ反映
      if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId;

        setActiveMessage(prev => {
          const id = prev?.id || incomingMessageId || msg.id || `assistant-${Date.now()}`;
          const ts = prev?.ts || Date.now();
          let content = prev?.content || '';
          let type = prev?.type || 'thought';
          let thoughtMode = prev?.thoughtMode || false;

          if (chunk?.thought !== undefined) {
            content = chunk.thought.trim();
            type = 'thought';
            thoughtMode = true;
          }
          if (chunk?.text !== undefined) {
            if (thoughtMode) {
              content = chunk.text;
            } else {
              content += chunk.text;
            }
            type = 'assistant';
            thoughtMode = false;
          }

          return { id, ts, type, content, thoughtMode };
        });
        onMessageReceived?.();
        return;
      }

      // 2) ツールカード（ライブ）
      if (msg.method === 'pushToolCall') {
        const params = msg.params || {};
        const toolId = params.toolCallId || `tool-${Date.now()}`;
        setMessages(prev => ([
          ...prev,
          {
            id: toolId,
            ts: Date.now(),
            role: 'tool',
            type: 'tool',
            toolCallId: toolId,
            icon: params.icon,
            label: params.label,
            command: params.confirmation?.command || params.locations?.[0]?.path || '',
            status: 'running',
            content: '',
          }
        ]));
        onMessageReceived?.();
        return;
      }

      // 3) ツール更新（既存・必要ならそのまま）
      if (msg.method === 'updateToolCall') {
        const toolId = msg.params.callId ?? msg.params.toolCallId;
        const { status, content } = msg.params;

        setMessages(prevMessages => {
          const newMessages = [...prevMessages];
          const toolMessageIndex = newMessages.findIndex(m => m.id === toolId);
          if (toolMessageIndex === -1) {
            console.warn(`[updateToolCall] Tool message with id ${toolId} not found.`);
            return prevMessages;
          }
          const toolMessage = { ...newMessages[toolMessageIndex] };

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
              processedContent = content.markdown;
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
        return;
      }

      // 4) サーバ確定メッセージ（addMessage）を重複無しで反映
      if (msg.method === 'addMessage' && msg.params?.message) {
        const m = msg.params.message;
        setMessages(prev => {
          if (prev.some(x => x.id === m.id)) return prev; // 重複防止
          return [...prev, m];
        });
        // 追加で最新タイムスタンプを更新（履歴delta用）
        if (typeof m.ts === 'number') {
          latestTsRef.current = Math.max(latestTsRef.current ?? 0, m.ts);
        }
        onMessageReceived?.();
        return;
      }

      // 5) 完了通知（ここで activeMessage を消す。messages への追加は addMessage に任せる）
      if (msg.method === 'messageCompleted' || msg.method === 'agentMessageFinished') {
        setActiveMessage(null);
        setIsGeneratingResponse(false);
        return;
      }

      // 6) 履歴（既存）
      if (msg.id !== undefined && msg.result?.messages) {
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
              const prevIds = new Set(prev.map(p => p.id));
              const mergedMapped = mergedMessages.map((m: any) => {
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
              }).filter(Boolean) as Message[]; // nullを除外
              // 既存と重複するIDを除外
              const dedup = mergedMapped.filter(m => !prevIds.has(m.id));
              const meta = historyState.current.requestMeta.get(msg.id);
              let updatedMessages: Message[];
              if (meta?.mode === 'newer') {
                // 差分は末尾に追加（受信順を維持）
                updatedMessages = [...prev, ...dedup];
              } else {
                // 初回/過去ページングは先頭に追加（過去→現在の順で追加）
                updatedMessages = [...dedup, ...prev];
              }
              
              rawMessages.forEach((m: any) => historyState.current.loadedIds.add(m.id));
              // リクエストモード別に状態更新
              if (rawMessages.length > 0) {
                if (meta?.mode === 'older' || meta?.mode === 'initial') {
                  // 古い履歴をロードした場合のみ oldestTs を更新
                  historyState.current.oldestTs = Math.min(historyState.current.oldestTs ?? rawMessages[0].ts, rawMessages[0].ts);
                }
                // 最新tsを更新（どのモードでも）
                const newest = rawMessages[rawMessages.length - 1].ts;
                latestTsRef.current = Math.max(latestTsRef.current ?? 0, newest);
              }
              return updatedMessages;
            });
          }
          // 取りきり判定は過去取得のときのみ
          const meta = historyState.current.requestMeta.get(msg.id);
          const limit = 20;
          if (meta?.mode === 'older' || meta?.mode === 'initial') {
            if (rawMessages.length < limit) {
              historyState.current.finished = true;
            }
          }
          historyState.current.isFetchingHistory = false;
          historyState.current.requestMeta.delete(msg.id);
        }
        return;
      }

      // 7) 注意: result:null はACKなので無視（完了扱いしない）
      if (msg.id !== undefined && msg.result === null) {
        // 以前はここで activeMessage を messages に確定していたが重複の原因になるため無視する
        console.log(`[DEBUG] Ignoring result:null (id:${msg.id})`);
        return;
      }
    });

    // クリーンアップ関数は、ws インスタンスが変更されたり、コンポーネントがアンマウントされたりする際に実行される
    return () => {
      // ここでは ws.close() を直接呼ばない
      // WebSocketProvider が接続のライフサイクルを管理するため
      console.log('Cleaning up useChat WebSocket listeners.');
      unsubscribe(); // subscribeで返されたunsubscribe関数を呼び出す
    };
  }, [ws, subscribe]);

  /* 重複定義と不要なクリーンアップ useEffect を削除しました。
     sendToolConfirmation / requestHistory / requestDelta / cancelSendMessage は
     この後方に定義されているものを正とします。 */

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
    if (!ws || !lastSentRequestId.current) return;

    const req = {
      jsonrpc: '2.0', // ← '20' から修正
      id: lastSentRequestId.current,
      method: 'cancelSendMessage',
      params: {}
    };
    sendWsMessage(req);
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
}