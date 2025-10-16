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

const CHAT_SERVER_ORIGIN = process.env.NEXT_PUBLIC_CHAT_SERVER_ORIGIN;
const CHAT_SERVER_PROTOCOL = process.env.NEXT_PUBLIC_CHAT_SERVER_PROTOCOL;
const CHAT_SERVER_HOST = process.env.NEXT_PUBLIC_CHAT_SERVER_HOST;
const CHAT_SERVER_PORT = process.env.NEXT_PUBLIC_CHAT_SERVER_PORT;
const RAW_CHAT_SERVER_WS_PATH = process.env.NEXT_PUBLIC_CHAT_SERVER_WS_PATH;

type OverrideCandidate = {
  origin?: string;
  protocol?: string;
  hostname?: string;
  port?: string | number;
};

const RESOLVED_CHAT_SERVER_WS_PATH = (() => {
  if (!RAW_CHAT_SERVER_WS_PATH) return '/ws';
  return RAW_CHAT_SERVER_WS_PATH.startsWith('/') ? RAW_CHAT_SERVER_WS_PATH : `/${RAW_CHAT_SERVER_WS_PATH}`;
})();

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
  const HEARTBEAT_TIMEOUT_MS = 30000;
  // 送信キュー（未接続時にためる）
  const sendQueueRef = useRef<string[]>([]);
  const reloadInProgressRef = useRef(false);
  const reloadPendingReasonRef = useRef<string | null>(null);
  const reloadFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const RELOAD_FALLBACK_TIMEOUT_MS = 30000;

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

  const triggerHardReload = useCallback((delayMs = 0) => {
    if (reloadInProgressRef.current) return;
    reloadInProgressRef.current = true;
    const execute = () => {
      try {
        window.location.reload();
      } catch (err) {
        console.error('[WS] Failed to reload page after server restart:', err);
      }
    };
    if (delayMs > 0) {
      setTimeout(execute, delayMs);
    } else {
      execute();
    }
  }, []);

  const clearReloadFallbackTimer = useCallback(() => {
    if (reloadFallbackTimerRef.current) {
      clearTimeout(reloadFallbackTimerRef.current);
      reloadFallbackTimerRef.current = null;
    }
  }, []);

  const finalizePendingReload = useCallback(() => {
    clearReloadFallbackTimer();
    const reason = reloadPendingReasonRef.current;
    reloadPendingReasonRef.current = null;
    return reason;
  }, [clearReloadFallbackTimer]);

  const markReloadPending = useCallback((reason: string) => {
    const normalizedReason = reason || 'server-reload';
    if (!reloadPendingReasonRef.current) {
      reloadPendingReasonRef.current = normalizedReason;
    }
    if (!reloadFallbackTimerRef.current) {
      reloadFallbackTimerRef.current = setTimeout(() => {
        reloadFallbackTimerRef.current = null;
        reloadPendingReasonRef.current = null;
        triggerHardReload();
      }, RELOAD_FALLBACK_TIMEOUT_MS);
    }
  }, [triggerHardReload]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;
    if (isConnecting.current) return;

    isConnecting.current = true;
    console.log('Attempting to connect WebSocket from provider...');

    const { protocol, hostname, port: locationPort } = window.location;
    let targetProtocol: string = protocol;
    let targetHostname: string = hostname;
    let targetPort: string = locationPort;

    const baseUrl = `${protocol}//${hostname}${locationPort ? `:${locationPort}` : ''}`;
    const applyOriginOverride = (value: string) => {
      if (!value) return;
      try {
        const resolved = new URL(value, baseUrl);
        if (resolved.protocol) targetProtocol = resolved.protocol;
        if (resolved.hostname) targetHostname = resolved.hostname;
        targetPort = resolved.port;
      } catch (err) {
        console.warn('[WS] Invalid chat server origin override:', value, err);
      }
    };

    const overrideCandidate: OverrideCandidate | null = (() => {
      if (typeof window === 'undefined') return null;
      const raw = (window as any).__flexiChatServerOverride;
      if (!raw) return null;
      if (typeof raw === 'string') return { origin: raw };
      if (typeof raw === 'object') return raw as OverrideCandidate;
      return null;
    })();

    if (overrideCandidate?.origin) {
      applyOriginOverride(String(overrideCandidate.origin));
    } else if (overrideCandidate) {
      if (overrideCandidate.protocol) {
        const proto = String(overrideCandidate.protocol);
        const normalized = proto.endsWith(':') ? proto : `${proto}:`;
        targetProtocol = normalized;
      }
      if (overrideCandidate.hostname) {
        targetHostname = String(overrideCandidate.hostname);
      }
      if (overrideCandidate.port !== undefined && overrideCandidate.port !== null && overrideCandidate.port !== '') {
        targetPort = String(overrideCandidate.port);
      }
    } else if (CHAT_SERVER_ORIGIN) {
      applyOriginOverride(CHAT_SERVER_ORIGIN);
    } else {
      if (CHAT_SERVER_PROTOCOL) {
        const normalized = CHAT_SERVER_PROTOCOL.endsWith(':')
          ? CHAT_SERVER_PROTOCOL
          : `${CHAT_SERVER_PROTOCOL}:`;
        targetProtocol = normalized;
      }
      if (CHAT_SERVER_HOST) {
        targetHostname = CHAT_SERVER_HOST;
      }
      if (CHAT_SERVER_PORT !== undefined && CHAT_SERVER_PORT !== null && CHAT_SERVER_PORT !== '') {
        targetPort = String(CHAT_SERVER_PORT);
      }
    }

    const normalizedProtocol = (targetProtocol || '').toLowerCase().replace(/:.*$/, '');
    const wsProtocol = normalizedProtocol === 'https' || normalizedProtocol === 'wss' ? 'wss' : 'ws';
    const portSegment = targetPort ? `:${targetPort}` : '';
    const socketUrl = `${wsProtocol}://${targetHostname}${portSegment}${RESOLVED_CHAT_SERVER_WS_PATH}`;
    const socket = new WebSocket(socketUrl);
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket connected from provider');
      setIsConnected(true);
      isConnecting.current = false;
      backoffRef.current = 1000; // バックオフをリセット
      startHeartbeat(socket);
      flushQueue();
      const pendingReason = finalizePendingReload();
      if (pendingReason) {
        const delay = pendingReason.includes('signal') ? 400 : 250;
        triggerHardReload(delay);
      }
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
        // サーバー再起動シグナルを受信したら、クリーンに接続を閉じてページをリロード
        if (parsed && parsed.method === 'serverReload') {
          console.log('[WS] Server reload signal received. Waiting for restart to complete before reloading.');
          try { socket.close(1012, 'server-reload'); } catch {}
          markReloadPending('server-reload-signal');
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
      const reason = (event.reason || '').toLowerCase();
      const restartClose = (
        event.code === 1012 ||
        reason.includes('server restart') ||
        reason.includes('server-reload')
      );
      if (restartClose) {
        console.log('[WS] Connection closed due to server restart. Waiting for restart to finish before reloading.');
        markReloadPending('server-restart-close');
      }
      scheduleReconnect();
      if (restartClose) {
        return;
      }
    };

    socket.onerror = () => {
      // エラーは控えめにログに残し、oncloseで再接続
      console.warn('WebSocket error from provider');
      setIsConnected(false);
      isConnecting.current = false;
      try { socket.close(); } catch {}
    };
  }, [scheduleReconnect, triggerHardReload, finalizePendingReload, markReloadPending]);

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
      clearReloadFallbackTimer();
    };
  }, [connectWebSocket, clearReloadFallbackTimer]);

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
