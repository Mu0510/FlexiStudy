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

// ToolCardData インターフェースは不要になったため削除

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
  const activeMessageRef = useRef<ActiveMessage | null>(null);
  const [isGeneratingResponse, setIsGeneratingResponse] = useState<boolean>(false);
  // toolCardsData は削除

  useEffect(() => {
    activeMessageRef.current = activeMessage;
  }, [activeMessage]);

  const ws = useRef<WebSocket | null>(null);
  const requestIdCounter = useRef<number>(1);
  const lastSentRequestId = useRef<number | null>(null);
  // pendingToolBodies は一旦削除し、ロジックを簡略化
  // const pendingToolBodies = useRef<Map<string, { status: string, content: any }>>(new Map());

  const historyState = useRef({
    oldestTs: null as number | null,
    loadedIds: new Set<string>(),
    pendingHistory: new Set<number>(),
    finished: false,
    isFetchingHistory: false,
    histReqId: 10000,
  });

  // updateToolCardData ヘルパーは不要になったため削除

  useEffect(() => {
    if (ws.current) return;

    ws.current = new WebSocket(`ws://${window.location.hostname}:3001/ws`);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      requestHistory(true);
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

      if (msg.method === 'streamAssistantThoughtChunk') {
        const { thought } = msg.params;
        setActiveMessage(prev => ({
          id: prev?.id || msg.id || `thought-${Date.now()}`,
          type: 'thought',
          content: thought.trim(),
          thoughtMode: true,
        }));
      } else if (msg.method === 'streamAssistantMessageChunk') {
        const { chunk } = msg.params;
        const currentId = activeMessageRef.current?.id || msg.id || `assistant-${Date.now()}`;

        let newContent = activeMessageRef.current?.content || '';
        let newType: 'thought' | 'assistant' = activeMessageRef.current?.type || 'thought';
        let newThoughtMode = activeMessageRef.current?.thoughtMode || false;

        if (chunk?.text !== undefined) {
          newType = 'assistant';
          newThoughtMode = false;
          if (activeMessageRef.current?.type !== 'assistant') {
            newContent = chunk.text.replace(/^\n+/, '');
          } else {
            newContent = newContent + chunk.text.replace(/^\n+/, '');
          }
        } else if (chunk?.thought !== undefined) {
          newContent = chunk.thought.trim();
          newType = 'thought';
          newThoughtMode = true;
        }

        setActiveMessage({
          id: currentId,
          type: newType,
          content: newContent.trimEnd(),
          thoughtMode: newThoughtMode,
        });
        if (msg.id !== undefined && ws.current) {
          ws.current.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
        }
      } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
        if (activeMessage) {
          setMessages(prev => [...prev, {
            id: activeMessage.id,
            role: 'assistant',
            content: activeMessage.content,
          }]);
          setActiveMessage(null);
        }
        setIsGeneratingResponse(false);
      } else if (msg.method === 'pushMessage') {
        setMessages(prev => [...prev, {
          id: `msg-${Date.now()}`,
          role: 'assistant',
          content: msg.params.content,
        }]);
        setActiveMessage(null);
        setIsGeneratingResponse(false);
      } else if (msg.method === 'pushToolCall') {
        const toolId = msg.params.toolCallId ?? msg.id;
        const { icon, label, locations } = msg.params;
        const command = locations?.[0]?.path ?? '';

        setMessages(prev => [...prev, {
          id: toolId,
          role: 'tool',
          type: 'tool',
          toolCallId: toolId,
          icon,
          label,
          command,
          status: 'running',
          content: '',
        }]);

        if (ws.current) {
          ws.current.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { id: toolId }
          }));
        }
        setActiveMessage(null);
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
                    processedContent = marked.parse(content.markdown);
                } else if (content.type === 'diff') {
                    processedContent = generateContextualDiffHtml(content.oldText, content.newText);
                } else if (typeof content === 'string') {
                    processedContent = `<pre>${content}</pre>`;
                } else {
                    processedContent = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
                }
            }
            
            toolMessage.status = status ?? toolMessage.status;
            toolMessage.content = processedContent;
            newMessages[toolMessageIndex] = toolMessage;

            return newMessages;
        });

        if (status === 'finished') {
          setActiveMessage(null);
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

      } else if (msg.id !== undefined) {
        if (msg.result === null && msg.id === lastSentRequestId.current) {
          setIsGeneratingResponse(false);
          if (activeMessageRef.current && activeMessageRef.current.type === 'assistant') {
            setMessages(prev => [...prev, {
              id: activeMessageRef.current!.id,
              role: 'assistant',
              content: activeMessageRef.current!.content,
            }]);
          }
          setActiveMessage(null);
        }
        if (historyState.current.pendingHistory.has(msg.id) && msg.result?.messages) {
          historyState.current.pendingHistory.delete(msg.id);
          const newMessages = msg.result.messages.filter((m: any) => !historyState.current.loadedIds.has(m.id));

          if (newMessages.length > 0) {
            newMessages.sort((a: any, b: any) => a.ts - b.ts);

            setMessages(prev => {
              const updatedMessages = [...newMessages.map((m: any) => {
                if (m.type === 'tool') {
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
                    status: m.params.status || 'finished',
                    content: processedContent,
                  };
                } else {
                  return {
                    id: m.id,
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: marked.parse(m.text),
                  };
                }
              }), ...prev];
              newMessages.forEach((m: any) => historyState.current.loadedIds.add(m.id));
              historyState.current.oldestTs = newMessages[0].ts;
              return updatedMessages;
            });
          }

          const limit = 20;
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
      ws.current = null;
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (!ws.current || isGeneratingResponse) return;

    const messageId = `user-${Date.now()}`;
    setMessages(prev => [...prev, { id: messageId, role: 'user', content: text }]);
    setIsGeneratingResponse(true);
    setActiveMessage({
      id: `thought-${Date.now()}`,
      type: 'thought',
      content: '…思考中…',
      thoughtMode: true,
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

  const requestHistory = useCallback((isInitialLoad = false) => {
    if (historyState.current.isFetchingHistory || historyState.current.finished) return;

    historyState.current.isFetchingHistory = true;
    const id = ++historyState.current.histReqId;
    historyState.current.pendingHistory.add(id);
    const limit = isInitialLoad ? 30 : 20;

    if (ws.current) {
      ws.current.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'fetchHistory',
        params: { limit: limit, before: historyState.current.oldestTs }
      }));
    }
  }, []);

  return {
    messages,
    activeMessage,
    isGeneratingResponse,
    // toolCardsData は削除
    sendMessage,
    requestHistory,
  };
};