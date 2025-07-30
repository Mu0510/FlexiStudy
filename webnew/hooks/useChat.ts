// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from 'react';

export interface ChatMessage {
  id: string;
  type: 'user' | 'bot' | 'tool';
  content: string; // For user/bot messages, or initial content for tool messages
  timestamp: string;
  isThinking?: boolean; // For bot messages during generation
  
  // For tool messages
  toolCallId?: string;
  icon?: string;
  label?: string;
  command?: string;
  status?: 'running' | 'finished' | 'error';
  toolBody?: string; // For tool output (can be HTML string for diffs/preformatted text)
  toolCallConfirmationId?: string;
  toolCallConfirmationMessage?: string;
  toolCallConfirmationButtons?: { label: string; value: string }[];
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

// Simplified generateContextualDiffHtml for now. A proper diff library would be needed.
function generateContextualDiffHtml(oldText: string, newText: string) {
  // This is a placeholder. In a real scenario, you'd use a library like `diff-match-patch`.
  // For now, we'll just show a basic representation.
  const linesOld = oldText.split('\n');
  const linesNew = newText.split('\n');

  let html = '';
  // Simple line-by-line comparison for demonstration
  for (let i = 0; i < Math.max(linesOld.length, linesNew.length); i++) {
    const oldLine = linesOld[i] || '';
    const newLine = linesNew[i] || '';

    if (oldLine === newLine) {
      html += `<span class="diff-context">${oldLine}</span>\n`;
    } else {
      if (oldLine) html += `<span class="diff-del">- ${oldLine}</span>\n`;
      if (newLine) html += `<span class="diff-add">+ ${newLine}</span>\n`;
    }
  }
  return `<pre>${html}</pre>`;
}

export const useChat = (isOpen: boolean) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const ws = useRef<WebSocket | null>(null);
  const requestId = useRef(1);
  const lastSentRequestId = useRef<number | null>(null);
  const isGeneratingResponse = useRef(false);

  // Mimic chat.js's active/typing bubble state
  const activeAssistantMessageId = useRef<string | null>(null);

  // Mimic chat.js's toolCards and pendingBodies for tool output streaming
  const toolCardOutputs = useRef<Map<string, string>>(new Map()); // toolCallId -> accumulated output
  const pendingToolCardUpdates = useRef<Map<string, any>>(new Map()); // toolCallId -> {status, content}

  // History management
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
    if (activeAssistantMessageId.current) {
      updateMessage(activeAssistantMessageId.current, { isThinking: false }); // Ensure thinking state is off
      activeAssistantMessageId.current = null;
    }
    // Remove the thinking bubble if it's still there and not a full message
    setMessages(prevMessages => prevMessages.filter(msg => msg.id !== 'thinking-bubble' || !msg.isThinking));
  }, [updateMessage]);

  const sendUserMessage = useCallback((text: string) => {
    if (isGeneratingResponse.current) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      type: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    appendMessage(userMessage);

    // Create a thinking bubble immediately, similar to chat.js
    const thinkingBubbleId = 'thinking-bubble';
    const thinkingBubble: ChatMessage = {
      id: thinkingBubbleId,
      type: 'bot',
      content: '…思考中…',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      isThinking: true,
    };
    appendMessage(thinkingBubble);
    activeAssistantMessageId.current = thinkingBubbleId;

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
      ws.current = new WebSocket(`ws://${window.location.hostname}:3001/ws`);

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

        // --- Message Handling Logic (mimicking chat.js) ---

        if (msg.method === 'streamAssistantThoughtChunk') {
          const thoughtContent = msg.params.thought.trim();
          if (!activeAssistantMessageId.current) {
            // If no active message, create a new thinking bubble
            const newThinkingBubbleId = 'thinking-bubble';
            appendMessage({
              id: newThinkingBubbleId,
              type: 'bot',
              content: '',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              isThinking: true,
            });
            activeAssistantMessageId.current = newThinkingBubbleId;
          }
          updateMessage(activeAssistantMessageId.current!, { content: thoughtContent, isThinking: true });
        } else if (msg.method === 'streamAssistantMessageChunk') {
          const chunk = msg.params.chunk;
          if (!activeAssistantMessageId.current) {
            // If no active message, create a new bot message
            const newBotMessageId = `bot-${Date.now()}`;
            appendMessage({
              id: newBotMessageId,
              type: 'bot',
              content: '',
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            });
            activeAssistantMessageId.current = newBotMessageId;
          }
          // Append chunk to the active message's content
          setMessages(prevMessages =>
            prevMessages.map(m => {
              if (m.id === activeAssistantMessageId.current) {
                return { ...m, content: (m.content || '') + chunk.text, isThinking: false };
              }
              return m;
            })
          );

          if (msg.id !== undefined) {
            ws.current?.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }));
          }
        } else if (msg.method === 'agentMessageFinished' || msg.method === 'messageCompleted') {
          // Finalize the active assistant message
          if (activeAssistantMessageId.current) {
            updateMessage(activeAssistantMessageId.current, { isThinking: false });
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
            toolBody: '', // Initialize toolBody
          };
          appendMessage(toolMessage);
          resetActiveAssistantMessage(); // Clear thinking bubble

          // Check for pending body updates for this toolCallId
          if (pendingToolCardUpdates.current.has(toolCallId)) {
            const pending = pendingToolCardUpdates.current.get(toolCallId);
            updateMessage(toolCallId, { status: pending.status, toolBody: pending.content });
            pendingToolCardUpdates.current.delete(toolCallId);
          }

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

          // If pushToolCall hasn't arrived yet, store as pending
          if (!messages.some(m => m.id === toolCallId)) {
            pendingToolCardUpdates.current.set(toolCallId, { status, content: toolBodyContent });
          } else {
            updateMessage(toolCallId, {
              status: status,
              toolBody: toolBodyContent,
              // Handle header patch if it comes later (though this logic might need refinement)
              label: content?.__headerPatch?.label || undefined,
              icon: content?.__headerPatch?.icon || undefined,
              command: content?.__headerPatch?.command ? getRelativePath(content.__headerPatch.command) : undefined,
            });
          }
        } else if (msg.method === 'pushChunk' && msg.params?.chunk?.sender === 'tool') {
          const toolCallId = msg.params.callId ?? msg.params.toolCallId;
          const textContent = msg.params.chunk.text;

          // Append chunk to the toolBody of the corresponding tool message
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
          // This is a final assistant message after tool execution
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
                    toolCallId: m.id,
                    icon: m.params.icon,
                    label: m.params.label,
                    command: getRelativePath(m.params.confirmation?.command || m.params.locations?.[0]?.path || ''),
                    status: m.params.status || 'finished', // Assume finished if not specified
                    content: m.params.content?.markdown || m.params.content?.text || JSON.stringify(m.params.content) || '',
                    toolBody: m.params.content ? (m.params.content.type === 'markdown' ? m.params.content.markdown : (m.params.content.type === 'diff' ? generateContextualDiffHtml(m.params.content.oldText, m.params.content.newText) : JSON.stringify(m.params.content))) : '',
                    timestamp: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    toolCallConfirmationId: m.params.confirmation ? m.id : undefined,
                    toolCallConfirmationMessage: m.params.confirmation ? m.params.confirmation.message : undefined,
                    toolCallConfirmationButtons: m.params.confirmation ? m.params.confirmation.buttons : undefined,
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