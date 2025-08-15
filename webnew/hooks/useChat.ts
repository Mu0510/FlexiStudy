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
  seq?: number; // ★連番を追加
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
  seq?: number; // ★連番を追加
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

const sortMessages = (a: Message | ActiveMessage, b: Message | ActiveMessage) => {
  const tsA = a.ts || 0;
  const tsB = b.ts || 0;
  if (tsA !== tsB) {
    return tsA - tsB;
  }
  return (a.seq || 0) - (b.seq || 0);
};


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

      if (msg.method === 'streamAssistantThoughtChunk') {
        const { thought } = msg.params;
        setActiveMessage(prev => ({
          id: prev?.id || msg.id || `thought-${Date.now()}`,
          ts: prev?.ts || Date.now(), // タイムスタンプを維持または新規作成
          seq: prev?.seq || msg.seq, // ★ seqを維持または設定
          type: 'thought',
          content: thought.trim(),
          thoughtMode: true,
        }));
        onMessageReceived?.();
      } else if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const incomingMessageId = msg.params.messageId; // ★ サーバーからの共通IDを取得

        setActiveMessage(prevActiveMessage => {
            const currentId = prevActiveMessage?.id || incomingMessageId || msg.id || `assistant-${Date.now()}`;
            const currentTs = prevActiveMessage?.ts || Date.now(); // 既存のtsを使うか、なければ新規作成
            const currentSeq = prevActiveMessage?.seq || msg.seq; // ★ seqを維持または設定
            let newContent = prevActiveMessage?.content || '';
            let newType = prevActiveMessage?.type || 'thought';
            let newThoughtMode = prevActiveMessage?.thoughtMode || false;

            if (chunk?.thought !== undefined) {
                newContent = chunk.thought.trim();
                newType = 'thought';
                newThoughtMode = true;
            }

            if (chunk?.text !== undefined) {
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
                ts: currentTs,
                seq: currentSeq, // ★ seqを返す
                type: newType as 'thought' | 'assistant',
                content: newContent,
                thoughtMode: newThoughtMode,
            };
        });

        if (msg.id !== undefined && ws) {
          sendWsMessage({ jsonrpc: '2.0', id: msg.id, result: null });
        }
        onMessageReceived?.();
      } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        if (activeMessage) {
          setMessages(prev => {
            if (prev.some(m => m.id === activeMessage.id)) {
              return prev;
            }
            const newMessages = [...prev, {
              id: activeMessage.id,
              ts: activeMessage.ts,
              seq: activeMessage.seq, // ★ seqを追加
              role: 'assistant',
              content: activeMessage.content,
            }];
            newMessages.sort(sortMessages); // ★ 共通ソート関数を使用
            return newMessages;
          });
          setActiveMessage(null);
        }
        setIsGeneratingResponse(false);
        onMessageReceived?.();
      } else if (msg.method === 'addMessage') {
        flushSync(() => {
          setActiveMessage(prev => {
            if (prev && prev.type === 'assistant') {
              setMessages(p => {
                if (p.some(m => m.id === prev.id)) return p;
                const newMessages = [...p, { id: prev.id, ts: prev.ts, seq: prev.seq, role: 'assistant', content: prev.content }];
                newMessages.sort(sortMessages);
                return newMessages;
              });
              return null;
            }
            return prev;
          });
        });

        const { message } = msg.params;
        flushSync(() => {
          setMessages(prev => {
            if (prev.some(m => m.id === message.id)) {
              return prev;
            }
            const newMessages = [...prev, {
              id: message.id,
              ts: message.ts,
              seq: msg.seq, // ★ seqを追加
              role: message.role,
              content: message.text,
              files: message.files || [],
              goal: message.goal || null,
              session: message.session || null,
            }];
            newMessages.sort(sortMessages); // ★ 共通ソート関数を使用
            return newMessages;
          });
        });
        onMessageReceived?.();
      } else if (msg.method === 'pushMessage') {
        setMessages(prev => {
          const newMessages = [...prev, {
            id: `msg-${Date.now()}`,
            ts: Date.now(),
            seq: msg.seq, // ★ seqを追加
            role: 'assistant',
            content: msg.params.content,
          }];
          newMessages.sort(sortMessages);
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

            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const currentActiveMessage = activeMessageRef.current;
              if (!newMessages.some(m => m.id === currentActiveMessage.id)) {
                newMessages.push({
                  id: currentActiveMessage.id,
                  ts: currentActiveMessage.ts,
                  seq: currentActiveMessage.seq, // ★ seqを追加
                  role: 'assistant',
                  content: currentActiveMessage.content,
                });
              }
            }

            newMessages.push({
              id: toolId,
              ts: Date.now(),
              seq: msg.seq, // ★ seqを追加
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: 'ツールを実行中...',
            });

            newMessages.sort(sortMessages);
            return newMessages;
          });
          setActiveMessage(null);
        });

        if (ws) {
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

        if (ws) {
          sendWsMessage({
            jsonrpc: '2.0',
            id: msg.id,
            result: { id: toolId, outcome: 'allow' }
          });
        }

        flushSync(() => {
          setMessages(prev => {
            const newMessages = [...prev];

            if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
              const currentActiveMessage = activeMessageRef.current;
              if (!newMessages.some(m => m.id === currentActiveMessage.id)) {
                newMessages.push({
                  id: currentActiveMessage.id,
                  ts: currentActiveMessage.ts,
                  seq: currentActiveMessage.seq, // ★ seqを追加
                  role: 'assistant',
                  content: currentActiveMessage.content,
                });
              }
            }

            newMessages.push({
              id: toolId,
              ts: Date.now(),
              seq: msg.seq, // ★ seqを追加
              role: 'tool',
              type: 'tool',
              toolCallId: toolId,
              icon,
              label,
              command,
              status: 'running',
              content: confirmation?.details ?? 'ツールの確認を待っています...',
            });

            newMessages.sort(sortMessages);
            return newMessages;
          });
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
                console.warn(`[updateToolCall] Tool message with id ${toolId} not found.`);
                return prevMessages;
            }

            const toolMessage = { ...newMessages[toolMessageIndex] };
            toolMessage.seq = msg.seq; // ★ seqを更新

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
      } else if (msg.id !== undefined && msg.result?.messages) {
        if (historyState.current.pendingHistory.has(msg.id)) {
          historyState.current.pendingHistory.delete(msg.id);
          const rawMessages = msg.result.messages.filter((m: any) => !historyState.current.loadedIds.has(m.id));

          if (rawMessages.length > 0) {
            rawMessages.sort((a: any, b: any) => {
              if (a.ts !== b.ts) return a.ts - b.ts;
              return (a.seq || 0) - (b.seq || 0);
            });

            const mergedMessages: any[] = [];
            const toolCalls = new Map<string, any>();

            for (const m of rawMessages) {
              if (m.type === 'tool' && (m.method === 'pushToolCall' || m.method === 'requestToolCallConfirmation')) {
                const toolCallId = m.params.toolCallId ?? m.id;
                toolCalls.set(toolCallId, {
                  id: toolCallId,
                  ts: m.ts,
                  seq: m.seq, // ★ seqを追加
                  role: 'tool',
                  type: 'tool',
                  toolCallId: toolCallId,
                  icon: m.params.icon,
                  label: m.params.label,
                  command: m.params.confirmation?.command || m.params.locations?.[0]?.path || '',
                  status: 'running',
                  content: '',
                });
              } else if (m.type === 'tool' && m.method === 'updateToolCall') {
                const toolCallId = m.params.toolCallId ?? m.params.callId;
                if (toolCalls.has(toolCallId)) {
                  const existingTool = toolCalls.get(toolCallId);
                  existingTool.status = m.params.status || existingTool.status;
                  existingTool.seq = m.seq || existingTool.seq; // ★ seqを更新
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
                mergedMessages.push(m);
              }
            }

            mergedMessages.push(...Array.from(toolCalls.values()));
            mergedMessages.sort(sortMessages);

            setMessages(prev => {
              const updatedMessages = [...mergedMessages.map((m: any) => {
                if (m.role === 'user' || m.role === 'assistant') {
                   return {
                    id: m.id,
                    ts: m.ts,
                    seq: m.seq, // ★ seqを追加
                    role: m.role,
                    content: m.text || '',
                    files: m.files || [],
                    goal: m.goal || null,
                    session: m.session || null,
                  };
                } else if (m.role === 'tool') {
                    return m;
                }
                return null;
              }).filter(Boolean), ...prev];
              
              rawMessages.forEach((m: any) => historyState.current.loadedIds.add(m.id));
              if (rawMessages.length > 0) {
                historyState.current.oldestTs = rawMessages[0].ts;
              }
              updatedMessages.sort(sortMessages);
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
            if (msg.params.chunk.type === 'diff') {
              newContent += textContent.split('\n').map((line: string) => {
                if (line.startsWith('+')) return `<span class="add">${line}</span>`;
                if (line.startsWith('-')) return `<span class="del">${line}</span>`;
                return line;
              }).join('\n');
            } else {
              newContent += textContent;
            }
            return { ...m, content: newContent, seq: msg.seq || m.seq }; // ★ seqを更新
          }
          return m;
        }));

      } else if (msg.id !== undefined && msg.result === null) {
        console.log(`[DEBUG] Completion signal received (id: ${msg.id}). Finalizing active message.`);

        setActiveMessage(prevActiveMessage => {
          if (prevActiveMessage && prevActiveMessage.type === 'assistant') {
            setMessages(p => {
              if (p.some(m => m.id === prevActiveMessage.id)) {
                return p;
              }
              const newMessages = [...p, { id: prevActiveMessage.id, ts: prevActiveMessage.ts, seq: prevActiveMessage.seq, role: 'assistant', content: prevActiveMessage.content }];
              newMessages.sort(sortMessages);
              return newMessages;
            });
          }
          return null;
        });

        setIsGeneratingResponse(false);
      }
    });

    return () => {
      console.log('Cleaning up useChat WebSocket listeners.');
      unsubscribe();
    };
  }, [ws, subscribe, activeMessage]);

  const sendMessage = useCallback((messageData: SendMessageData) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || isGeneratingResponse) {
      console.warn("WebSocket is not open or busy, cannot send message.");
      return;
    }

    setIsGeneratingResponse(true);

    const { text, files, goal, session } = messageData;

    const newMessage: Message = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2)}`,
        ts: Date.now(),
        // seq はサーバーで付与されるため、ここでは不要
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
    sendWsMessage(req);
  }, [ws, isGeneratingResponse, sendWsMessage]);

  const sendToolConfirmation = useCallback((toolCallId: string, result: boolean) => {
    if (!ws) return;

    const req = {
      jsonrpc: '2.0',
      id: requestIdCounter.current++,
      method: 'confirmToolCall',
      params: { toolCallId, result }
    };
    sendWsMessage(req);

    setMessages(prev => prev.map(m => {
      if (m.id === toolId) {
        return { ...m, status: 'finished' };
      }
      return m;
    }));

  }, [ws, sendWsMessage]);

  const requestHistory = useCallback((isInitialLoad = false) => {
    console.log('[useChat DEBUG] requestHistory called. isFetchingHistory:', historyState.current.isFetchingHistory, 'finished:', historyState.current.finished);
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[useChat DEBUG] Sending fetchHistory request with id:', id, 'limit:', limit, 'before:', historyState.current.oldestTs);
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
  }, [ws, sendWsMessage]);

  const cancelSendMessage = useCallback(() => {
    if (!ws || !lastSentRequestId.current) return;

    const req = {
      jsonrpc: '20',
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
    };
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWsMessage({
        jsonrpc: '2.0',
        method: 'clearHistory',
        params: {}
      });
    }
  }, [ws, sendWsMessage]);

  useEffect(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[useChat DEBUG] WebSocket is open. Requesting initial history.');
      requestHistory(true);
    }
  }, [ws, requestHistory]);

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
}
