'use client'

import type React from "react"
import { useState, useEffect, useRef, useCallback } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Terminal as TerminalIcon, Wifi, WifiOff, GitBranch, Database, RefreshCw, Plus, Minus, X, Square, Copy } from "lucide-react"
import { cn } from "@/lib/utils"
// xterm関連のimportを削除

// --- Interfaces ---
interface TerminalTab {
  id: string
  title: string
  isActive: boolean
}

interface TerminalWindow {
  id: string
  title: string
  isMaximized: boolean
  isMinimized: boolean
  tabs: TerminalTab[]
  activeTabId: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  zIndex: number
}

interface DragState {
  isDragging: boolean
  isResizing: boolean
  dragStart: { x: number; y: number }
  windowStart: { x: number; y: number; width: number; height: number }
  resizeHandle: string | null
}

// --- Component ---
export default function RescueConsole() {
  // --- State ---
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "connecting">("disconnected")
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [nextWindowId, setNextWindowId] = useState(1)
  const [nextTabId, setNextTabId] = useState(1)
  const [dragState, setDragState] = useState<DragState>({ isDragging: false, isResizing: false, dragStart: { x: 0, y: 0 }, windowStart: { x: 0, y: 0, width: 0, height: 0 }, resizeHandle: null })
  const [maxZIndex, setMaxZIndex] = useState(1)
  const [showGitMenu, setShowGitMenu] = useState(false)
  const [showBackupMenu, setShowBackupMenu] = useState(false)
  const [showRestoreMenu, setShowRestoreMenu] = useState(false)
  const [showGitPopup, setShowGitPopup] = useState(false)
  const [showBackupPopup, setShowBackupPopup] = useState(false)
  const [showRestorePopup, setShowRestorePopup] = useState(false)
  const [popupContent, setPopupContent] = useState("")
  
  // --- Refs ---
  const ws = useRef<WebSocket | null>(null);
  const xtermInstances = useRef<Map<string, {term: any, fitAddon: any}>>(new Map()); // Use any for dynamic import types
  const terminalContainerRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const animationFrameRef = useRef<number>()

  // --- WebSocket Connection ---
  useEffect(() => {
    const connect = () => {
      setConnectionStatus("connecting");
      const socket = new WebSocket(`ws://${window.location.hostname}:3001/ws`);

      socket.onopen = () => {
        console.log('WebSocket connected');
        setConnectionStatus("connected");
        ws.current = socket;
        if (windows.length === 0) {
            createNewWindow(true);
        }
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const { type, tabId, data } = message;
          const terminalInfo = xtermInstances.current.get(tabId);
          if (terminalInfo) {
            if (type === 'OUTPUT') {
                terminalInfo.term.write(data);
            } else if (type === 'CLOSE') {
                closeTab(windows.find(w => w.tabs.some(t => t.id === tabId))!.id, tabId, true);
            }
          }
        } catch (e) {
            console.error("Invalid message from server:", event.data);
        }
      };

      socket.onclose = () => {
        console.log('WebSocket disconnected');
        setConnectionStatus("disconnected");
        ws.current = null;
        xtermInstances.current.forEach(({ term }) => term.dispose());
        xtermInstances.current.clear();
      };

      socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        setConnectionStatus("disconnected");
        if(socket.readyState === 1) socket.close();
      };
    }

    connect();

    return () => {
      ws.current?.close();
    }
  }, []);

  // --- Terminal Management ---
  const terminalRefCallback = useCallback(async (el: HTMLDivElement | null, tabId: string) => {
    if (el && !xtermInstances.current.has(tabId)) {
        const { Terminal } = await import('xterm');
        const { FitAddon } = await import('xterm-addon-fit');
        await import('xterm/css/xterm.css');

        terminalContainerRefs.current.set(tabId, el);

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'monospace',
            theme: {
                background: '#f9fafb',
                foreground: '#111827',
                cursor: '#111827',
            },
            allowProposedApi: true,
        });
        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(el);
        
        try {
            fitAddon.fit();
        } catch(e) {
            console.error("Fit addon failed:", e);
        }

        xtermInstances.current.set(tabId, { term, fitAddon });

        ws.current?.send(JSON.stringify({ 
            type: 'CREATE', 
            tabId, 
            data: { cols: term.cols, rows: term.rows }
        }));

        term.onData((data) => {
            ws.current?.send(JSON.stringify({ type: 'INPUT', tabId, data }));
        });

        term.onResize(({ cols, rows }) => {
            ws.current?.send(JSON.stringify({ type: 'RESIZE', tabId, data: { cols, rows } }));
        });
    }
  }, []);

  // --- Window & Tab Handlers ---
  const createNewWindow = (isInitial = false) => {
    const newTabId = `tab-${nextTabId}`;
    const newTab: TerminalTab = {
      id: newTabId,
      title: isInitial ? "メイン" : "新規",
      isActive: true,
    }

    const newWindowId = `window-${nextWindowId}`;
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const windowWidth = Math.min(800, viewportWidth - 100)
    const windowHeight = Math.min(500, viewportHeight - 150)
    const offsetX = Math.min(50 + (nextWindowId - 1) * 30, viewportWidth - windowWidth - 50)
    const offsetY = Math.min(50 + (nextWindowId - 1) * 30, viewportHeight - windowHeight - 100)

    const newWindow: TerminalWindow = {
      id: newWindowId,
      title: isInitial ? "Rescue Console" : `Terminal ${nextWindowId}`,
      isMaximized: false,
      isMinimized: false,
      tabs: [newTab],
      activeTabId: newTab.id,
      position: { x: offsetX, y: offsetY },
      size: { width: windowWidth, height: windowHeight },
      zIndex: maxZIndex + 1,
    }

    setWindows((prev) => [...prev, newWindow]);
    setNextWindowId((prev) => prev + 1);
    setNextTabId((prev) => prev + 1);
    setMaxZIndex((prev) => prev + 1);
  };

  const createNewTab = (windowId: string) => {
    const newTabId = `tab-${nextTabId}`;
    const newTab: TerminalTab = {
      id: newTabId,
      title: `タブ ${nextTabId}`,
      isActive: true,
    }

    setWindows((prev) =>
      prev.map((window) => {
        if (window.id === windowId) {
          return {
            ...window,
            tabs: window.tabs.map((tab) => ({ ...tab, isActive: false })).concat(newTab),
            activeTabId: newTab.id,
          }
        }
        return window
      }),
    )
    setNextTabId((prev) => prev + 1)
  };
  
  const closeTab = (windowId: string, tabId: string, fromServer = false) => {
    const termInfo = xtermInstances.current.get(tabId);
    if (termInfo) {
        termInfo.term.dispose();
        xtermInstances.current.delete(tabId);
        terminalContainerRefs.current.delete(tabId);
    }

    if (!fromServer && ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'CLOSE', tabId }));
    }

    setWindows(prev => prev.map(w => {
        if (w.id === windowId) {
            const newTabs = w.tabs.filter(t => t.id !== tabId);
            if (newTabs.length === 0) return null;
            
            let newActiveTabId = w.activeTabId;
            if (w.activeTabId === tabId) {
                newActiveTabId = newTabs[newTabs.length - 1].id;
            }
            
            return {
                ...w,
                tabs: newTabs.map(t => ({...t, isActive: t.id === newActiveTabId})),
                activeTabId: newActiveTabId
            };
        }
        return w;
    }).filter(Boolean) as TerminalWindow[]);
  };

  const closeWindow = (windowId: string) => {
    const windowToClose = windows.find(w => w.id === windowId);
    if (windowToClose) {
        windowToClose.tabs.forEach(tab => closeTab(windowId, tab.id));
    }
  };

  const switchTab = (windowId: string, tabId: string) => {
    setWindows((prev) =>
      prev.map((window) => {
        if (window.id === windowId) {
          return {
            ...window,
            tabs: window.tabs.map((tab) => ({ ...tab, isActive: tab.id === tabId })),
            activeTabId: tabId,
          }
        }
        return window
      }),
    )
  };

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, windowId: string, action: "drag" | "resize", handle?: string) => {
      e.preventDefault()
      const window = windows.find((w) => w.id === windowId)
      if (!window || window.isMaximized) return

      setWindows((prev) => prev.map((w) => (w.id === windowId ? { ...w, zIndex: maxZIndex + 1 } : w)))
      setMaxZIndex((prev) => prev + 1)

      setDragState({
        isDragging: action === "drag",
        isResizing: action === "resize",
        dragStart: { x: e.clientX, y: e.clientY },
        windowStart: {
          x: window.position.x,
          y: window.position.y,
          width: window.size.width,
          height: window.size.height,
        },
        resizeHandle: handle || null,
      })
    },
    [windows, maxZIndex],
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.isDragging && !dragState.isResizing) return

      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }

      animationFrameRef.current = requestAnimationFrame(() => {
        const deltaX = e.clientX - dragState.dragStart.x
        const deltaY = e.clientY - dragState.dragStart.y

        if (dragState.isDragging) {
          const newX = Math.max(0, dragState.windowStart.x + deltaX)
          const newY = Math.max(0, dragState.windowStart.y + deltaY)
          setWindows((prev) => prev.map((w) => (w.zIndex === maxZIndex ? { ...w, position: { x: newX, y: newY } } : w)))
        } else if (dragState.isResizing) {
          let newWidth = dragState.windowStart.width
          let newHeight = dragState.windowStart.height
          let newX = dragState.windowStart.x
          let newY = dragState.windowStart.y

          if (dragState.resizeHandle?.includes("right")) newWidth = Math.max(400, dragState.windowStart.width + deltaX)
          if (dragState.resizeHandle?.includes("left")) {
            const constrainedDelta = Math.min(deltaX, dragState.windowStart.width - 400)
            newWidth = dragState.windowStart.width - constrainedDelta
            newX = dragState.windowStart.x + constrainedDelta
          }
          if (dragState.resizeHandle?.includes("bottom")) newHeight = Math.max(300, dragState.windowStart.height + deltaY)
          if (dragState.resizeHandle?.includes("top")) {
            const constrainedDelta = Math.min(deltaY, dragState.windowStart.height - 300)
            newHeight = dragState.windowStart.height - constrainedDelta
            newY = dragState.windowStart.y + constrainedDelta
          }
          setWindows((prev) => prev.map((w) => w.zIndex === maxZIndex ? { ...w, position: { x: newX, y: newY }, size: { width: newWidth, height: newHeight } } : w))
        }
      })
    }

    const handleMouseUp = () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      setDragState({ isDragging: false, isResizing: false, dragStart: { x: 0, y: 0 }, windowStart: { x: 0, y: 0, width: 0, height: 0 }, resizeHandle: null })
      
      if(dragState.isResizing) {
        const activeWindow = windows.find(w => w.zIndex === maxZIndex);
        if(activeWindow) {
            const termInfo = xtermInstances.current.get(activeWindow.activeTabId);
            try {
                termInfo?.fitAddon.fit();
            } catch(e) {
                console.error(e);
            }
        }
      }
    }

    if (dragState.isDragging || dragState.isResizing) {
      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = dragState.isDragging ? "move" : (dragState.resizeHandle || '') + "-resize"
      document.body.style.userSelect = "none"
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    }
  }, [dragState, maxZIndex, windows])

  const toggleMaximize = (windowId: string) => {
    setWindows((prev) =>
      prev.map((window) => (window.id === windowId ? { ...window, isMaximized: !window.isMaximized } : window)),
    )
    setTimeout(() => {
        const activeWindow = windows.find(w => w.id === windowId);
        if(activeWindow) {
            activeWindow.tabs.forEach(t => {
                const termInfo = xtermInstances.current.get(t.id);
                try {
                    termInfo?.fitAddon.fit();
                } catch(e) { console.error(e); }
            })
        }
    }, 250);
  }

  const toggleMinimize = (windowId: string) => setWindows((prev) => prev.map((window) => (window.id === windowId ? { ...window, isMinimized: !window.isMinimized } : window)))
  const restoreWindow = (windowId: string) => setWindows((prev) => prev.map((window) => (window.id === windowId ? { ...window, isMinimized: false } : window)))
  
  const visibleWindows = windows.filter((window) => !window.isMinimized)
  const minimizedWindows = windows.filter((window) => window.isMinimized)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Card className="rounded-none border-x-0 border-t-0 shadow-sm bg-primary text-primary-foreground z-[100]">
        {/* Header content... */}
      </Card>

      <div className="flex-1 relative overflow-hidden">
        {visibleWindows.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <TerminalIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-sm text-muted-foreground mb-4">アクティブなターミナルウィンドウがありません</p>
              <Button onClick={() => createNewWindow()} className="gap-2">
                <Plus className="h-4 w-4" />
                新しいウィンドウを開く
              </Button>
            </div>
          </div>
        )}

        {visibleWindows.map((window) => (
          <Card
            key={window.id}
            className={cn("shadow-lg border transition-all duration-200 rounded-lg overflow-hidden select-none bg-white flex flex-col", window.isMaximized ? "fixed inset-0 z-50 rounded-none" : "absolute")}
            style={window.isMaximized ? { top: '45px', bottom: "28px" } : { left: window.position.x, top: window.position.y, width: window.size.width, height: window.size.height, zIndex: window.zIndex }}
          >
            {!window.isMaximized && (
              <>
                <div className="absolute top-0 left-0 w-2 h-2 cursor-nw-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "nw")} />
                <div className="absolute top-0 right-0 w-2 h-2 cursor-ne-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "ne")} />
                <div className="absolute bottom-0 left-0 w-2 h-2 cursor-sw-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "sw")} />
                <div className="absolute bottom-0 right-0 w-2 h-2 cursor-se-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "se")} />
                <div className="absolute top-2 left-2 right-2 h-1 cursor-n-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "n")} />
                <div className="absolute bottom-2 left-2 right-2 h-1 cursor-s-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "s")} />
                <div className="absolute top-2 bottom-2 left-0 w-1 cursor-w-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "w")} />
                <div className="absolute top-2 bottom-2 right-0 w-1 cursor-e-resize" onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "e")} />
              </>
            )}
            
            <div className="flex items-stretch bg-white border-b cursor-move h-8 relative" onMouseDown={(e) => { if (!(e.target as HTMLElement).closest(".no-drag")) { handleMouseDown(e, window.id, "drag") } }}>
                <div className="flex items-center flex-1">
                    {window.tabs.map((tab) => (
                      <button key={tab.id} onClick={() => switchTab(window.id, tab.id)} className={cn("px-3 py-1.5 text-sm flex items-center gap-2 group h-8 relative border-r no-drag", tab.isActive ? "bg-gray-50" : "hover:bg-gray-50")}>
                        <span>{tab.title}</span>
                        <button onClick={(e) => { e.stopPropagation(); closeTab(window.id, tab.id); }} className="hover:bg-gray-200 rounded-sm p-0.5 w-4 h-4 flex items-center justify-center"><X className="h-3 w-3" /></button>
                      </button>
                    ))}
                    <button onClick={() => createNewTab(window.id)} className="px-2 py-1.5 h-8 hover:bg-gray-100 flex items-center justify-center no-drag"><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <div className="flex items-center no-drag">
                    <button onClick={() => toggleMinimize(window.id)} className="h-8 w-12 flex items-center justify-center hover:bg-gray-100"><Minus className="h-4 w-4" /></button>
                    <button onClick={() => toggleMaximize(window.id)} className="h-8 w-12 flex items-center justify-center hover:bg-gray-100"><Square className="h-3 w-3" /></button>
                    <button onClick={() => closeWindow(window.id)} className="h-8 w-12 flex items-center justify-center hover:bg-red-500 hover:text-white"><X className="h-4 w-4" /></button>
                </div>
            </div>

            <div className="flex-1 overflow-hidden p-1 bg-gray-50">
                {window.tabs.map(tab => (
                    <div key={tab.id} className="h-full w-full" style={{ display: tab.isActive ? 'block' : 'none' }}>
                        <div ref={(el) => terminalRefCallback(el, tab.id)} className="h-full w-full" />
                    </div>
                ))}
            </div>
          </Card>
        ))}
      </div>

      <div className="px-4 py-1 border-t bg-muted/20 h-7 flex items-center z-[100]">
        {/* Footer content... */}
      </div>
    </div>
  )
}
