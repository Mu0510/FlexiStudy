// webnew/context/WebSocketContext.tsx
"use client"
import React, { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback, useMemo } from 'react';

interface WebSocketContextType {
  ws: WebSocket | null;
  isConnected: boolean;
  // メッセージ購読のための関数
  subscribe: (handler: (message: any) => void) => () => void;
  // メッセージ送信のための関数
  sendMessage: (message: any) => void;
}

const WebSocketContext = createContext<WebSocketContextType | undefined>(undefined);

// シンプルなイベントエミッター
class EventEmitter {
  private events: { [key: string]: Function[] } = {};

  on(eventName: string, handler: Function) {
    if (!this.events[eventName]) {
      this.events[eventName] = [];
    }
    this.events[eventName].push(handler);
    return () => this.off(eventName, handler); // unsubscribe function
  }

  off(eventName: string, handler: Function) {
    if (!this.events[eventName]) return;
    this.events[eventName] = this.events[eventName].filter(h => h !== handler);
  }

  emit(eventName: string, ...args: any[]) {
    if (!this.events[eventName]) return;
    this.events[eventName].forEach(handler => handler(...args));
  }
}

const eventEmitter = new EventEmitter();

export const WebSocketProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const isConnecting = useRef(false);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 10;
  const RECONNECT_INTERVAL_MS = 3000; // 3 seconds

  const connectWebSocket = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (isConnecting.current) {
      return;
    }
    if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('Max reconnect attempts reached. Not attempting to reconnect WebSocket.');
      return;
    }

    isConnecting.current = true;
    console.log('Attempting to connect WebSocket from provider...');

    // window.location.hostname を使用
    const socket = new WebSocket(`wss://${window.location.hostname}:443/ws`);
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket connected from provider');
      setIsConnected(true);
      isConnecting.current = false;
      reconnectAttempts.current = 0; // 接続成功でリセット
    };

    socket.onmessage = (event) => {
      // 受信したメッセージをEventEmitter経由でブロードキャスト
      eventEmitter.emit('message', JSON.parse(event.data));
    };

    socket.onclose = (event) => {
      console.log(`WebSocket disconnected from provider: Code=${event.code}, Reason=${event.reason}, WasClean=${event.wasClean}`);
      setIsConnected(false);
      isConnecting.current = false;
      wsRef.current = null;

      // 異常終了の場合のみ再接続を試みる
      if (!event.wasClean && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts.current++;
        console.log(`Attempting to reconnect in ${RECONNECT_INTERVAL_MS / 1000} seconds (attempt ${reconnectAttempts.current}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(connectWebSocket, RECONNECT_INTERVAL_MS);
      }
    };

    socket.onerror = (event) => {
      console.error('WebSocket error from provider:', event);
      setIsConnected(false);
      isConnecting.current = false;
      wsRef.current = null;
      // onerrorの後はoncloseが呼ばれるので、再接続ロジックはoncloseに集約
    };
  }, []);

  useEffect(() => {
    connectWebSocket();

    return () => {
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        console.log('Cleaning up WebSocket connection from provider.');
        wsRef.current.close(1000, "Provider unmounting");
      }
    };
  }, [connectWebSocket]);

  const subscribe = useCallback((handler: (message: any) => void) => {
    eventEmitter.on('message', handler);
    return () => eventEmitter.off('message', handler);
  }, []);

  const sendMessage = useCallback((message: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket is not open, cannot send message:', message);
    }
  }, []);

  const contextValue = useMemo(() => ({
    ws: wsRef.current,
    isConnected,
    subscribe,
    sendMessage,
  }), [wsRef.current, isConnected, subscribe, sendMessage]);

  return (
    <WebSocketContext.Provider value={contextValue}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (context === undefined) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};
