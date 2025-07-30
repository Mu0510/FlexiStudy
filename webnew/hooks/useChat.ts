
// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';

export interface ChatMessage {
  id: string;
  type: 'user' | 'bot' | 'tool';
  content: string;
  timestamp: string;
  isThinking?: boolean;
  // For tool messages
  toolName?: string;
  toolCallId?: string;
  icon?: string;
  label?: string;
  command?: string;
  status?: 'running' | 'finished' | 'error';
  toolBody?: string; // For tool output
  toolCallConfirmationId?: string;
  toolCallConfirmationMessage?: string;
  toolCallConfirmationButtons?: { label: string; value: string }[];
}

interface ToolCardEntry {
  cardElem: HTMLElement; // Not directly used in React, but conceptually represents the tool card
  bodyElem: HTMLElement; // Conceptually represents the body of the tool card
}

const PROJECT_ROOT_PATH = '/home/geminicli/GeminiCLI/';

function getRelativePath(absolutePath?: string) {
  if (!absolutePath) return '';
  if (absolutePath.startsWith(PROJECT_ROOT_PATH)) {
    return absolutePath.substring(PROJECT_ROOT_PATH.length);
  }
  return absolutePath;
}

function getToolIconText(iconName?: string) {
  switch (iconName) {
    case 'pencil': return 'Edit';
    case 'search': return 'Search';
    case 'terminal': return 'Shell';
    case 'file': return 'File';
    case 'code': return 'Code';
    case 'web': return 'Web';
    case 'folder': return 'Dir';
    case 'info': return 'Info';
    default: return iconName || 'Tool';
  }
}

// Simple diff HTML generation (simplified from chat.js)
function generateContextualDiffHtml(oldText: string, newText: string, ctx = 3) {
  // This is a placeholder. A proper diff library would be needed for full functionality.
  // For now, just show old and new text.
  return `<pre class="diff-old">${oldText}</pre><pre class="diff-new">${newText}</pre>`;
}

export const useChat = (isOpen: boolean) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const ws = useRef<WebSocket | null>(null);
  const requestId = useRef(1);
  const lastSentRequestId = useRef<number | null>(null);
  const activeAssistantMessage = useRef<ChatMessage | null>(null);
  const isGeneratingResponse = useRef(false);
  const toolCards = useRef<Map<string, ToolCardEntry>>(new Map());
  const pendingBodies = useRef<Map<string, { status: string; content: any }>>(new Map());
  const oldestTs = useRef<number | null>(null);
  const finishedHistory = useRef(false);
  const isFetchingHistory = useRef(false);
  const loadedIds = useRef<Set<string>>(new Set());

  const appendMessage = useCallback((newMessage: ChatMessage) => {
    setMessages((prevMessages) => {
      // If it's an update to an existing message (e.g., tool card update or thinking bubble)
      if (newMessage.id && prevMessages.some(msg => msg.id === newMessage.id)) {
        return prevMessages.map(msg => msg.id === newMessage.id ? { ...msg, ...newMessage } : msg);
      }
      // If it's a new message, append it
      return [...prevMessages, newMessage];
    });
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<ChatMessage>) => {
    setMessages(prevMessages =>
      prevMessages.map(msg => (msg.id === id ? { ...msg, ...updates } : msg))
    );
  }, []);

  const resetActiveAssistantMessage = useCallback(() => {
    activeAssistantMessage.current = null;
    setMessages(prevMessages => prevMessages.filter(msg => msg.id !== 'thinking-bubble'));
  }, []);

  const sendUserMessage = useCallback((text: string) => {
    if (isGeneratingResponse.current) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    appendMessage(userMessage);

    // Create a thinking bubble immediately
    const thinkingBubble: ChatMessage = {
      id: 'thinking-bubble',
      type: 'bot',
      content: '…思考中…',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isThinking: true,
    };
    appendMessage(thinkingBubble);
    activeAssistantMessage.current = thinkingBubble;

    isGeneratingResponse.current = true;

    const req = {
      jsonrpc: '2.0',
      id: ++requestId.current,
      method: 'sendUserMessage',
      params: { chunks: [{ text }] },
    };
    lastSentRequestId.current = req.id;
    ws.current?.send(JSON.stringify(req));
  }, [appendMessage]);

  const cancelSendMessage = useCallback(() => {
    const req = {
      jsonrpc: '2.0',
      id: lastSentRequestId.current,
      method: 'cancelSendMessage',
      params: {},
    };
    ws.current?.send(JSON.stringify(req));
    isGeneratingResponse.current = false;
    resetActiveAssistantMessage();
  }, [resetActiveAssistantMessage]);

  const sendToolCallConfirmation = useCallback((toolCallId: string, outcome: string) => {
    const response = {
      jsonrpc: '2.0',
      id: toolCallId, // Use the toolCallId as the ID for the response
      result: { id: toolCallId, outcome },
    };
    ws.current?.send(JSON.stringify(response));
    // Update the tool message to reflect confirmation
    updateMessage(toolCallId, {
      toolCallConfirmationId: undefined, // Remove confirmation UI
      toolCallConfirmationMessage: undefined,
      toolCallConfirmationButtons: undefined,
      status: outcome === 'allow' ? 'running' : 'error', // Set status based on outcome
      toolBody: outcome === 'allow' ? 'Tool execution allowed.' : 'Tool execution rejected.',
    });
  }, [updateMessage]);

  const requestHistory = useCallback((isInitialLoad = false) => {
    if (isFetchingHistory.current || finishedHistory.current) return;
    isFetchingHistory.current = true;

    const id = ++requestId.current;
    const limit = isInitialLoad ? 30 : 20;

    ws.current?.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'fetchHistory',
      params: { limit: limit, before: oldestTs.current },
    }));
  }, []);

  useEffect(() => {
    if (!isOpen) {
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
      return;
    }

    if (!ws.current) {
      ws.current = new WebSocket(`wss://${window.location.host}/ws`);

      ws.current.onopen = () => {
        console.log('WebSocket connected');
        requestHistory(true); // Initial history load
      };

      ws.current.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('❌ JSON parse error on chunk:', err, event.data);
          return;
        }

        console.log('[DEBUG] Received WebSocket message:', msg);

        if (msg.method === 'streamAssistantThoughtChunk') {
          const thoughtContent = msg.params.thought.trim();
          if (!activeAssistantMessage.current) {
            activeAssistantMessage.current = {
              id: 'thinking-bubble',
              type: 'bot',
              content: '',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isThinking: true,
            };
            appendMessage(activeAssistantMessage.current);
          }
          updateMessage(activeAssistantMessage.current.id, { content: thoughtContent, isThinking: true });
        } else if (msg.method === 'streamAssistantMessageChunk') {
          const chunk = msg.params.chunk;
          if (!activeAssistantMessage.current) {
            activeAssistantMessage.current = {
              id: `bot-${Date.now()}`, // Assign a unique ID for the actual message
              type: 'bot',
              content: '',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            };
            appendMessage(activeAssistantMessage.current);
          }
          // Ensure it's no longer a thinking bubble
          updateMessage(activeAssistantMessage.current.id, {
            isThinking: false,
            content: (activeAssistantMessage.current.content || '') + chunk.text,
          });

          if (msg.id !== undefined) {
            ws.current?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
          }
        } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
          if (activeAssistantMessage.current) {
            updateMessage(activeAssistantMessage.current.id, { isThinking: false });
          }
          isGeneratingResponse.current = false;
          resetActiveAssistantMessage();
        } else if (msg.method === 'pushToolCall') {
          const toolCallId = msg.params.toolCallId ?? msg.id;
          const { icon, label, locations, confirmation } = msg.params;
          const command = locations?.[0]?.path ?? '';

          const toolMessage: ChatMessage = {
            id: toolCallId,
            type: 'tool',
            toolName: label,
            toolCallId: toolCallId,
            icon: icon,
            label: label,
            command: getRelativePath(command),
            status: 'running',
            content: confirmation ? confirmation.message : '', // Initial content for confirmation
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            toolCallConfirmationId: confirmation ? toolCallId : undefined,
            toolCallConfirmationMessage: confirmation ? confirmation.message : undefined,
            toolCallConfirmationButtons: confirmation ? confirmation.buttons : undefined,
          };
          appendMessage(toolMessage);
          resetActiveAssistantMessage(); // Clear thinking bubble

          // Agent へ ACK を返す
          ws.current?.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { id: toolCallId },
          }));
        } else if (msg.method === 'updateToolCall') {
          const toolCallId = msg.params.callId ?? msg.params.toolCallId;
          const { status, content } = msg.params;

          let toolBodyContent = '';
          if (content) {
            if (content.type === 'markdown' && content.markdown) {
              toolBodyContent = content.markdown;
            } else if (content.type === 'diff') {
              toolBodyContent = generateContextualDiffHtml(content.oldText, content.newText);
            } else if (typeof content === 'string') {
              toolBodyContent = `<pre>${content}</pre>`;
            } else {
              toolBodyContent = `<pre>${JSON.stringify(content, null, 2)}</pre>`;
            }
          }

          updateMessage(toolCallId, {
            status: status,
            toolBody: toolBodyContent,
            // Handle header patch if it comes later
            toolName: content?.__headerPatch?.label || undefined,
            icon: content?.__headerPatch?.icon || undefined,
            command: content?.__headerPatch?.command ? getRelativePath(content.__headerPatch.command) : undefined,
          });
        } else if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
          const toolCallId = msg.params.callId ?? msg.params.toolCallId;
          const textContent = msg.params.chunk.text;

          setMessages(prevMessages =>
            prevMessages.map(m => {
              if (m.id === toolCallId && m.type === 'tool') {
                let currentToolBody = m.toolBody || '';
                // Simple append for now, diff coloring would need more complex logic
                currentToolBody += textContent;
                return { ...m, toolBody: currentToolBody };
              }
              return m;
            })
          );
        } else if (msg.method === 'pushMessage') {
          const assistantMessage: ChatMessage = {
            id: `bot-${Date.now()}`,
            type: 'bot',
            content: msg.params.content,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          appendMessage(assistantMessage);
          resetActiveAssistantMessage();
        } else if (msg.method === 'historyCleared') {
          setMessages([]);
          loadedIds.current.clear();
          oldestTs.current = null;
          finishedHistory.current = false;
          isFetchingHistory.current = false;
        } else if (msg.id !== undefined && msg.result?.messages) { // fetchHistory response
          const historyMessages = msg.result.messages;
          if (historyMessages && historyMessages.length > 0) {
            const newMessages: ChatMessage[] = [];
            historyMessages.forEach((m: any) => {
              if (!loadedIds.current.has(m.id)) {
                let chatMsg: ChatMessage;
                if (m.type === 'tool') {
                  chatMsg = {
                    id: m.id,
                    type: 'tool',
                    toolName: m.params.label,
                    toolCallId: m.id,
                    icon: m.params.icon,
                    label: m.params.label,
                    command: getRelativePath(m.params.confirmation?.command || m.params.locations?.[0]?.path || ''),
                    status: m.params.status || 'finished', // Assume finished if not specified
                    content: m.params.content?.markdown || m.params.content?.text || JSON.stringify(m.params.content) || '',
                    toolBody: m.params.content ? (m.params.content.type === 'markdown' ? m.params.content.markdown : (m.params.content.type === 'diff' ? generateContextualDiffHtml(m.params.content.oldText, m.params.content.newText) : JSON.stringify(m.params.content))) : '',
                    timestamp: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  };
                } else {
                  chatMsg = {
                    id: m.id,
                    type: m.role === 'user' ? 'user' : 'bot',
                    content: m.text,
                    timestamp: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  };
                }
                newMessages.push(chatMsg);
                loadedIds.current.add(m.id);
              }
            });

            // Prepend new messages to the beginning of the list
            setMessages(prevMessages => [...newMessages.reverse(), ...prevMessages]);

            if (historyMessages.length < (msg.params?.limit || 20)) {
              finishedHistory.current = true;
            }
            oldestTs.current = historyMessages[0]?.ts || null; // Oldest message is first in the array
          } else {
            finishedHistory.current = true;
          }
          isFetchingHistory.current = false;
        } else if (msg.id !== undefined && msg.error) {
          console.error('RPC Error:', msg.error);
          const errorMessage: ChatMessage = {
            id: `error-${Date.now()}`,
            type: 'bot',
            content: `エラーが発生しました: ${msg.error.message || JSON.stringify(msg.error)}`,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          appendMessage(errorMessage);
          isGeneratingResponse.current = false;
          resetActiveAssistantMessage();
        }
      };

      ws.current.onclose = () => {
        console.log('WebSocket disconnected');
        isGeneratingResponse.current = false;
        resetActiveAssistantMessage();
      };

      ws.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        isGeneratingResponse.current = false;
        resetActiveAssistantMessage();
      };
    }

    // Cleanup on unmount or isOpen becomes false
    return () => {
      if (!isOpen && ws.current) {
        ws.current.close();
        ws.current = null;
      }
    };
  }, [isOpen, appendMessage, updateMessage, resetActiveAssistantMessage, requestHistory]);

  return {
    messages,
    sendUserMessage,
    cancelSendMessage,
    sendToolCallConfirmation,
    isGeneratingResponse: isGeneratingResponse.current,
  };
};
