// webnew/hooks/useChat.ts
import { useState, useEffect, useRef, useCallback } from "react";

export type ChatMessage = {
  id: number | string;
  type: "user" | "bot" | "tool";
  content: string;
  timestamp: string;
  icon?: string;
  label?: string;
  command?: string;
  status?: "running" | "finished" | "error";
  isThinking?: boolean;
  toolBody?: string; // For tool card HTML content
  toolName?: string;
  toolId?: number;
  toolCallId?: number;
  toolCallConfirmationId?: number;
  toolCallConfirmationMessage?: string;
  toolCallConfirmationButtons?: { label: string; value: string }[];
};

function timestamp() {
  return new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export function useChat(isOpen: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reqId = useRef(1);
  const toolIndexMap = useRef<Map<number, number>>(new Map()); // toolId -> messages array index
  const pendingBodies = useRef<Map<number, any>>(new Map()); // toolId -> pending body

  const resetHistory = useCallback(() => {
    setMessages([]);
    toolIndexMap.current.clear();
    pendingBodies.current.clear();
  }, []);

  useEffect(() => {
    if (!isOpen) {
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }

    const ws = new WebSocket(`ws://${location.hostname}:3001/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id: reqId.current++, method: "fetchHistory", params: { limit: 30 }
      }));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      console.log("[WS Message]", msg);

      switch (msg.method) {
        case "pushToolCall": {
          const { toolId, toolName, command, description } = msg.params;
          const newToolMessage: ChatMessage = {
            id: `tool-${toolId}`,
            type: "tool",
            content: description || "",
            timestamp: timestamp(),
            toolId,
            toolName,
            command,
            status: "running",
          };
          setMessages(prev => {
            const newIndex = prev.length;
            toolIndexMap.current.set(toolId, newIndex);
            return [...prev, newToolMessage];
          });

          // Check for pending body
          if (pendingBodies.current.has(toolId)) {
            setMessages(prev => prev.map((m, idx) =>
              idx === toolIndexMap.current.get(toolId)
                ? { ...m, toolBody: pendingBodies.current.get(toolId) }
                : m
            ));
            pendingBodies.current.delete(toolId);
          }

          // Send ACK
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
          break;
        }
        case "updateToolCall": {
          const { toolId, body, status } = msg.params;
          if (toolIndexMap.current.has(toolId)) {
            setMessages(prev => prev.map((m, idx) =>
              idx === toolIndexMap.current.get(toolId)
                ? { ...m, toolBody: body, status: status || m.status }
                : m
            ));
          } else {
            // Tool message not yet pushed, buffer the body
            pendingBodies.current.set(toolId, body);
          }
          // Send ACK
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
          break;
        }
        case "streamAssistantThoughtChunk": {
          const { thought } = msg.params;
          setMessages(prev => {
            const lastBotMessageIndex = prev.findLastIndex(m => m.type === "bot");
            if (lastBotMessageIndex !== -1 && prev[lastBotMessageIndex].isThinking) {
              return prev.map((m, idx) =>
                idx === lastBotMessageIndex
                  ? { ...m, content: m.content + (thought || "") }
                  : m
              );
            } else {
              const newThinkingMessage: ChatMessage = {
                id: `thinking-${Date.now()}`,
                type: "bot",
                content: thought || "思考中...",
                timestamp: timestamp(),
                isThinking: true,
              };
              return [...prev, newThinkingMessage];
            }
          });
          break;
        }
        case "streamAssistantMessageChunk": {
          const { chunk } = msg.params;
          setMessages(prev => prev.map(m =>
            m.isThinking
              ? { ...m, content: m.content + (chunk?.text || ""), isThinking: false }
              : m
          ));
          break;
        }
        case "pushMessage":
        case "messageCompleted":
        case "agentMessageFinished": {
          const { message } = msg.params || msg; // messageCompleted/agentMessageFinished might send message directly
          if (message && message.role && message.text) {
            setMessages(prev => {
              // If there's an ongoing thinking message, update it
              const lastThinkingMessageIndex = prev.findLastIndex(m => m.isThinking);
              if (lastThinkingMessageIndex !== -1) {
                return prev.map((m, idx) =>
                  idx === lastThinkingMessageIndex
                    ? { ...m, content: message.text, isThinking: false, id: message.id || m.id }
                    : m
                );
              } else {
                // Otherwise, add as a new message
                return [...prev, {
                  id: message.id || `msg-${Date.now()}`,
                  type: message.role === "user" ? "user" : "bot",
                  content: message.text,
                  timestamp: timestamp(),
                }];
              }
            });
          }
          break;
        }
        case "historyCleared": {
          resetHistory();
          break;
        }
        case "fetchHistory": {
          const { messages: fetchedMessages } = msg.result;
          setMessages(prev => {
            // Filter out duplicates if any
            const newMessages = fetchedMessages.filter((fm: ChatMessage) => !prev.some(pm => pm.id === fm.id));
            return [...newMessages, ...prev];
          });
          // TODO: Maintain scroll position
          break;
        }
        case "requestToolCallConfirmation": {
          const { toolCallId, message, buttons } = msg.params;
          setMessages(prev => [...prev, {
            id: `confirm-${toolCallId}`,
            type: "tool",
            content: message,
            timestamp: timestamp(),
            toolCallId,
            toolCallConfirmationId: msg.id, // Store the ID for sending response
            toolCallConfirmationMessage: message,
            toolCallConfirmationButtons: buttons,
            status: "running", // Indicate awaiting confirmation
          }]);
          break;
        }
        default: {
          // Handle other messages if necessary, or log them
          console.warn("Unhandled WebSocket message method:", msg.method, msg);
          break;
        }
      }
    };

    ws.onclose = () => console.log("WebSocket disconnected");
    ws.onerror = (e) => console.error("WebSocket error:", e);

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [isOpen, resetHistory]);

  const sendUserMessage = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket not open.");
      return;
    }
    const messageId = `user-${Date.now()}`;
    setMessages(prev => [...prev, {
      id: messageId,
      type: "user",
      content: text,
      timestamp: timestamp(),
    }]);
    wsRef.current.send(JSON.stringify({
      jsonrpc: "2.0", id: reqId.current++, method: "sendUserMessage",
      params: { chunks: [{ text }] }
    }));
  }, []);

  const sendToolCallConfirmation = useCallback((toolCallConfirmationId: number, value: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket not open.");
      return;
    }
    wsRef.current.send(JSON.stringify({
      jsonrpc: "2.0",
      id: toolCallConfirmationId,
      result: { value: value }
    }));
    // Update the tool confirmation message status
    setMessages(prev => prev.map(m =>
      m.toolCallConfirmationId === toolCallConfirmationId
        ? { ...m, status: "finished", content: `${m.content}\n\n選択: ${value}` } // Indicate selection
        : m
    ));
  }, []);

  return { messages, sendUserMessage, sendToolCallConfirmation };
}