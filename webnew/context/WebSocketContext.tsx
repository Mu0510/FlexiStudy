// webnew/context/WebSocketContext.tsx
"use client"
import React, { createContext, useContext, useEffect, useRef, useState, ReactNode, useCallback, useMemo } from 'react';

interface WebSocketContextType {
  ws: WebSocket | null;
  isConnected: boolean;
  // メッセージ購読のための関数
  subscribe: (handler: (message: any) => void) => () => void;
  // メッセージ送信のための関数（未接続時はキュー）
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
  // 再接続バックオフ
  const backoffRef = useRef(1000); // ms
  const MAX_BACKOFF_MS = 30000;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ハートビート
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HEARTBEAT_INTERVAL_MS = 25000;
  const HEARTBEAT_TIMEOUT_MS = 10000;
  // 送信キュー（未接続時にためる）
  const sendQueueRef = useRef<string[]>([]);

  const stopHeartbeat = () => {
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);
    if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
    pingTimerRef.current = null;
    pongTimeoutRef.current = null;
  };

  const startHeartbeat = (socket: WebSocket) => {
    stopHeartbeat();
    pingTimerRef.current = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {}
      if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
      pongTimeoutRef.current = setTimeout(() => {
        try { socket.close(4000, 'heartbeat-timeout'); } catch {}
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  };

  const flushQueue = () => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (sendQueueRef.current.length) {
      const msg = sendQueueRef.current.shift()!;
      try { socket.send(msg); } catch { sendQueueRef.current.unshift(msg); break; }
    }
  };

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return; // 既にスケジュール済み
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.min(backoffRef.current, MAX_BACKOFF_MS) * jitter;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectWebSocket();
    }, delay);
    backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    console.log(`[WS] scheduled reconnect in ${Math.round(delay)}ms`);
  }, []);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    if (isConnecting.current) return;

    isConnecting.current = true;
    console.log('Attempting to connect WebSocket from provider...');

    // Build WS URL based on current page protocol/host/port to avoid hardcoded 3000
    const isHttps = window.location.protocol === 'https:';
    const wsProto = isHttps ? 'wss' : 'ws';
    const host = window.location.hostname;
    const locPort = window.location.port; // e.g. "3000" or ""
    const url = `${wsProto}://${host}${locPort ? `:${locPort}` : ''}/ws`;
    const socket = new WebSocket(url);
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket connected from provider');
      setIsConnected(true);
      isConnecting.current = false;
      backoffRef.current = 1000; // バックオフをリセット
      startHeartbeat(socket);
      flushQueue();
    };

    socket.onmessage = (event) => {
      // 文字列以外は無視
      const data = event.data;
      try {
        const parsed = JSON.parse(data);
        // ハートビート応答は握りつぶす
        if (parsed && (parsed.type === 'pong' || parsed.method === 'pong')) {
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
          return;
        }
        eventEmitter.emit('message', parsed);
      } catch (e) {
        // 非JSONは無視（サーバが純テキストを返す可能性に備える）
        if (String(data).toLowerCase() === 'pong') {
          if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
          return;
        }
        console.warn('[Provider] Non-JSON message ignored:', data);
      }
    };

    socket.onclose = (event) => {
      console.log(`WebSocket disconnected from provider: Code=${event.code}, Reason=${event.reason}, WasClean=${event.wasClean}`);
      setIsConnected(false);
      isConnecting.current = false;
      wsRef.current = null;
      stopHeartbeat();
      scheduleReconnect();
    };

    socket.onerror = () => {
      // エラーは控えめにログに残し、oncloseで再接続
      console.warn('WebSocket error from provider');
      setIsConnected(false);
      isConnecting.current = false;
      try { socket.close(); } catch {}
    };
  }, [scheduleReconnect]);

  useEffect(() => {
    connectWebSocket();

    const onPageShow = () => { connectWebSocket(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') connectWebSocket(); };
    const onOnline = () => { connectWebSocket(); };
    const onPageHide = () => { if (wsRef.current) { try { wsRef.current.close(1001, 'pagehide'); } catch {} } };

    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        console.log('Cleaning up WebSocket connection from provider.');
        wsRef.current.close(1000, "Provider unmounting");
      }
      stopHeartbeat();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [connectWebSocket]);

  const subscribe = useCallback((handler: (message: any) => void) => {
    eventEmitter.on('message', handler);
    return () => eventEmitter.off('message', handler);
  }, []);

  const sendMessage = useCallback((message: any) => {
    const str = typeof message === 'string' ? message : JSON.stringify(message);
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      try { socket.send(str); } catch { sendQueueRef.current.push(str); }
    } else {
      // 未接続ならキューにため、次回接続時にflush
      sendQueueRef.current.push(str);
      // 速やかに接続トリガー（必要なら）
      connectWebSocket();
    }
  }, [connectWebSocket]);

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
