"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { z } from 'zod';

// Zod スキーマ定義
const MessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
});

const ToolCallSchema = z.object({
    id: z.string(),
    ts: z.number(),
    type: z.literal('tool'),
    method: z.string(),
    params: z.any(),
});

const HistoryMessageSchema = z.union([MessageSchema, ToolCallSchema]);
type HistoryMessage = z.infer<typeof HistoryMessageSchema>;

export type Message = HistoryMessage;

export interface ToolCardState {
    callId: string;
    icon?: string;
    label?: string;
    command?: string;
    status: 'running' | 'finished' | 'error';
    content: string;
    isConfirmed: boolean;
}

const WEBSOCKET_URL = `ws://${typeof window !== 'undefined' ? location.host : 'localhost'}/ws`;

export const useChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCards, setToolCards] = useState<Map<string, ToolCardState>>(new Map());
  const [isConnected, setIsConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const requestIdCounter = useRef(1);

  const connect = useCallback(() => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) return;

    ws.current = new WebSocket(WEBSOCKET_URL);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
      ws.current?.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 'get_history',
          method: 'getHistory',
          params: {},
      }));
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('Received:', data);

      if (data.id === 'get_history' && data.result) {
          // History handling logic can be added here
          return;
      }

      if (data.method === 'addMessage') {
          const message = data.params.message;
          setMessages(prev => [...prev, message]);
      } else if (data.method === 'streamAssistantMessageChunk') {
          const { chunk } = data.params;
          setMessages(prevMessages => {
              const lastMessage = prevMessages[prevMessages.length - 1];
              if (lastMessage && lastMessage.role === 'assistant' && 'text' in lastMessage) {
                  return prevMessages.map((msg, index) =>
                      index === prevMessages.length - 1 ? { ...msg, text: msg.text + chunk.text } : msg
                  );
              } else {
                  return [...prevMessages, { id: String(Date.now()), ts: Date.now(), role: 'assistant', text: chunk.text || '' }];
              }
          });
      } else if (data.method === 'addToolCall') {
          const toolCall = data.params.toolCall;
          const newToolCard: ToolCardState = {
              callId: toolCall.id,
              label: `Tool: ${toolCall.method}`,
              command: JSON.stringify(toolCall.params, null, 2),
              status: 'running',
              content: 'Waiting for confirmation...',
              isConfirmed: false,
          };
          setToolCards(prev => new Map(prev).set(toolCall.id, newToolCard));
          setMessages(prev => [...prev, { id: toolCall.id, ts: toolCall.ts, type: 'tool', method: toolCall.method, params: toolCall.params }]);
      } else if (data.method === 'updateToolStatus') {
          const { callId, status, content } = data.params;
          setToolCards(prev => {
              const newCards = new Map(prev);
              const card = newCards.get(callId);
              if (card) {
                  card.status = status;
                  card.content = content;
              }
              return newCards;
          });
      }
    };

  }, []);

  useEffect(() => {
    connect();
    return () => {
      ws.current?.close();
    };
  }, [connect]);

  const sendMessage = (text: string) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      const id = `user-${requestIdCounter.current++}`;
      const message = {
        jsonrpc: '2.0',
        id: id,
        method: 'sendUserMessage',
        params: { chunks: [{ text }] },
      };
      ws.current.send(JSON.stringify(message));

      const userMessage: Message = {
          id: id,
          ts: Date.now(),
          role: 'user',
          text: text,
      };
      setMessages(prev => [...prev, userMessage]);
    }
  };

  const confirmTool = (callId: string) => {
      if (ws.current?.readyState === WebSocket.OPEN) {
          const message = {
              jsonrpc: '2.0',
              id: `confirm-${callId}`,
              method: 'confirmToolExecution',
              params: { callId },
          };
          ws.current.send(JSON.stringify(message));

          setToolCards(prev => {
              const newCards = new Map(prev);
              const card = newCards.get(callId);
              if (card) {
                  card.isConfirmed = true;
                  card.content = "Confirmed. Executing...";
              }
              return newCards;
          });
      }
  };

  return { messages, toolCards, isConnected, sendMessage, confirmTool };
};
