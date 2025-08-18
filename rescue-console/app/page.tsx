"use client"

import type React from "react"

import { useState, useEffect, useRef, useCallback } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Terminal, Wifi, WifiOff, GitBranch, Database, RefreshCw, Plus, Minus, X, Square, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

interface TerminalTab {
  id: string
  title: string
  isActive: boolean
  output: string[]
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

export default function RescueConsole() {
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "disconnected" | "connecting">("disconnected")
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [nextWindowId, setNextWindowId] = useState(1)
  const [nextTabId, setNextTabId] = useState(1)
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    isResizing: false,
    dragStart: { x: 0, y: 0 },
    windowStart: { x: 0, y: 0, width: 0, height: 0 },
    resizeHandle: null,
  })
  const [maxZIndex, setMaxZIndex] = useState(1)
  const [showGitMenu, setShowGitMenu] = useState(false)
  const [showBackupMenu, setShowBackupMenu] = useState(false)
  const [showRestoreMenu, setShowRestoreMenu] = useState(false)
  const [showGitPopup, setShowGitPopup] = useState(false)
  const [showBackupPopup, setShowBackupPopup] = useState(false)
  const [showRestorePopup, setShowRestorePopup] = useState(false)
  const [popupContent, setPopupContent] = useState("")
  const terminalRef = useRef<HTMLDivElement>(null)
  const animationFrameRef = useRef<number>()

  useEffect(() => {
    const connectWebSocket = () => {
      setConnectionStatus("connecting")

      setTimeout(() => {
        setConnectionStatus("connected")
        const initialTab: TerminalTab = {
          id: "tab-1",
          title: "メイン",
          isActive: true,
          output: [
            "Rescue Console v2.1.0 - Professional Recovery Tool",
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
            "✓ WebSocket接続が確立されました",
            "✓ アプリケーション状態を監視中...",
            "✓ バックアップシステムが利用可能です",
            "✓ Git統合が有効です",
            "",
            "ヘルプが必要な場合は 'help' と入力してください",
            "利用可能なコマンド: status, backup, restore, git-status, logs",
            "",
          ],
        }

        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const windowWidth = Math.min(800, viewportWidth - 100)
        const windowHeight = Math.min(500, viewportHeight - 150)

        const initialWindow: TerminalWindow = {
          id: "window-1",
          title: "Rescue Console",
          isMaximized: false,
          isMinimized: false,
          tabs: [initialTab],
          activeTabId: "tab-1",
          position: { x: 50, y: 50 },
          size: { width: windowWidth, height: windowHeight },
          zIndex: 1,
        }

        setWindows([initialWindow])
        setNextWindowId(2)
        setNextTabId(2)
      }, 1500)
    }

    connectWebSocket()
  }, [])

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight
    }
  }, [windows])

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
          const newX = Math.max(0, Math.min(window.innerWidth - 400, dragState.windowStart.x + deltaX))
          const newY = Math.max(0, Math.min(window.innerHeight - 200, dragState.windowStart.y + deltaY))

          setWindows((prev) => prev.map((w) => (w.zIndex === maxZIndex ? { ...w, position: { x: newX, y: newY } } : w)))
        } else if (dragState.isResizing) {
          let newWidth = dragState.windowStart.width
          let newHeight = dragState.windowStart.height
          let newX = dragState.windowStart.x
          let newY = dragState.windowStart.y

          if (dragState.resizeHandle?.includes("right")) {
            newWidth = Math.max(400, Math.min(window.innerWidth - newX, dragState.windowStart.width + deltaX))
          }
          if (dragState.resizeHandle?.includes("left")) {
            const maxDelta = dragState.windowStart.width - 400
            const constrainedDelta = Math.min(deltaX, maxDelta)
            newWidth = dragState.windowStart.width - constrainedDelta
            newX = dragState.windowStart.x + constrainedDelta
          }
          if (dragState.resizeHandle?.includes("bottom")) {
            newHeight = Math.max(300, Math.min(window.innerHeight - newY, dragState.windowStart.height + deltaY))
          }
          if (dragState.resizeHandle?.includes("top")) {
            const maxDelta = dragState.windowStart.height - 300
            const constrainedDelta = Math.min(deltaY, maxDelta)
            newHeight = dragState.windowStart.height - constrainedDelta
            newY = dragState.windowStart.y + constrainedDelta
          }

          setWindows((prev) =>
            prev.map((w) =>
              w.zIndex === maxZIndex
                ? {
                    ...w,
                    position: { x: newX, y: newY },
                    size: { width: newWidth, height: newHeight },
                  }
                : w,
            ),
          )
        }
      })
    }

    const handleMouseUp = () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      setDragState({
        isDragging: false,
        isResizing: false,
        dragStart: { x: 0, y: 0 },
        windowStart: { x: 0, y: 0, width: 0, height: 0 },
        resizeHandle: null,
      })
    }

    if (dragState.isDragging || dragState.isResizing) {
      document.addEventListener("mousemove", handleMouseMove)
      document.addEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = dragState.isDragging ? "move" : "nw-resize"
      document.body.style.userSelect = "none"
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [dragState, maxZIndex])

  useEffect(() => {
    const handleClickOutside = () => {
      setShowGitMenu(false)
      setShowBackupMenu(false)
      setShowRestoreMenu(false)
    }

    if (showGitMenu || showBackupMenu || showRestoreMenu) {
      document.addEventListener("click", handleClickOutside)
    }

    return () => {
      document.removeEventListener("click", handleClickOutside)
    }
  }, [showGitMenu, showBackupMenu, showRestoreMenu])

  const getStatusColor = () => {
    switch (connectionStatus) {
      case "connected":
        return "text-green-600"
      case "connecting":
        return "text-yellow-500"
      case "disconnected":
        return "text-destructive"
      default:
        return "text-muted-foreground"
    }
  }

  const getStatusText = () => {
    switch (connectionStatus) {
      case "connected":
        return "接続済み"
      case "connecting":
        return "接続中..."
      case "disconnected":
        return "切断済み"
      default:
        return "不明"
    }
  }

  const getStatusIcon = () => {
    switch (connectionStatus) {
      case "connected":
        return <Wifi className="h-3 w-3" />
      case "connecting":
        return <Wifi className="h-3 w-3 animate-pulse" />
      case "disconnected":
        return <WifiOff className="h-3 w-3" />
      default:
        return <WifiOff className="h-3 w-3" />
    }
  }

  const createNewWindow = () => {
    const newTab: TerminalTab = {
      id: `tab-${nextTabId}`,
      title: "新規",
      isActive: true,
      output: ["新しいターミナルセッションが開始されました", ""],
    }

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const windowWidth = Math.min(800, viewportWidth - 100)
    const windowHeight = Math.min(500, viewportHeight - 150)
    const offsetX = Math.min(50 + (nextWindowId - 1) * 30, viewportWidth - windowWidth - 50)
    const offsetY = Math.min(50 + (nextWindowId - 1) * 30, viewportHeight - windowHeight - 100)

    const newWindow: TerminalWindow = {
      id: `window-${nextWindowId}`,
      title: `Terminal ${nextWindowId}`,
      isMaximized: false,
      isMinimized: false,
      tabs: [newTab],
      activeTabId: newTab.id,
      position: { x: offsetX, y: offsetY },
      size: { width: windowWidth, height: windowHeight },
      zIndex: maxZIndex + 1,
    }

    setWindows((prev) => [...prev, newWindow])
    setNextWindowId((prev) => prev + 1)
    setNextTabId((prev) => prev + 1)
    setMaxZIndex((prev) => prev + 1)
  }

  const createNewTab = (windowId: string) => {
    const newTab: TerminalTab = {
      id: `tab-${nextTabId}`,
      title: `タブ ${nextTabId}`,
      isActive: true,
      output: ["新しいタブが作成されました", ""],
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
  }

  const toggleMaximize = (windowId: string) => {
    setWindows((prev) =>
      prev.map((window) => (window.id === windowId ? { ...window, isMaximized: !window.isMaximized } : window)),
    )
  }

  const toggleMinimize = (windowId: string) => {
    setWindows((prev) =>
      prev.map((window) => (window.id === windowId ? { ...window, isMinimized: !window.isMinimized } : window)),
    )
  }

  const restoreWindow = (windowId: string) => {
    setWindows((prev) => prev.map((window) => (window.id === windowId ? { ...window, isMinimized: false } : window)))
  }

  const closeWindow = (windowId: string) => {
    setWindows((prev) => prev.filter((window) => window.id !== windowId))
  }

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
  }

  const closeTab = (windowId: string, tabId: string) => {
    setWindows(
      (prev) =>
        prev
          .map((window) => {
            if (window.id === windowId) {
              if (window.tabs.length === 1) {
                return null
              }
              const remainingTabs = window.tabs.filter((tab) => tab.id !== tabId)
              const newActiveTab = remainingTabs[0] || remainingTabs[remainingTabs.length - 1]
              return {
                ...window,
                tabs: remainingTabs.map((tab) => ({ ...tab, isActive: tab.id === newActiveTab.id })),
                activeTabId: newActiveTab.id,
              }
            }
            return window
          })
          .filter(Boolean) as TerminalWindow[],
    )
  }

  const openGitPopup = (action: string) => {
    setPopupContent(action)
    setShowGitPopup(true)
    setShowGitMenu(false)
  }

  const openBackupPopup = (action: string) => {
    setPopupContent(action)
    setShowBackupPopup(true)
    setShowBackupMenu(false)
  }

  const openRestorePopup = (action: string) => {
    setPopupContent(action)
    setShowRestorePopup(true)
    setShowRestoreMenu(false)
  }

  const visibleWindows = windows.filter((window) => !window.isMinimized)
  const minimizedWindows = windows.filter((window) => window.isMinimized)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Card className="rounded-none border-x-0 border-t-0 shadow-sm bg-primary text-primary-foreground">
        <div className="px-4 py-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4" />
                <h1 className="text-sm font-heading font-bold">Rescue Console</h1>
              </div>
              <div className="h-3 w-px bg-primary-foreground/20" />
              <div className="flex items-center gap-1.5 text-xs text-primary-foreground/80">
                <div className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                <span>監視中</span>
              </div>
            </div>

            <div className="flex items-center gap-1 relative">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowGitMenu(!showGitMenu)
                    setShowBackupMenu(false)
                    setShowRestoreMenu(false)
                  }}
                  className="text-primary-foreground hover:bg-primary-foreground/10 h-6 px-2 text-xs"
                >
                  <GitBranch className="h-3 w-3 mr-1" />
                  Git
                </Button>
                {showGitMenu && (
                  <div className="absolute top-full left-0 mt-1 bg-white border rounded-md shadow-lg z-50 min-w-[160px]">
                    <div className="py-1">
                      <button
                        onClick={() => openGitPopup("ブランチ状態")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <GitBranch className="h-3 w-3" />
                        ブランチ状態
                      </button>
                      <button
                        onClick={() => openGitPopup("コミット")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Plus className="h-3 w-3" />
                        コミット
                      </button>
                      <button
                        onClick={() => openGitPopup("プル")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <RefreshCw className="h-3 w-3" />
                        プル
                      </button>
                      <button
                        onClick={() => openGitPopup("プッシュ")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Copy className="h-3 w-3" />
                        プッシュ
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowBackupMenu(!showBackupMenu)
                    setShowGitMenu(false)
                    setShowRestoreMenu(false)
                  }}
                  className="text-primary-foreground hover:bg-primary-foreground/10 h-6 px-2 text-xs"
                >
                  <Database className="h-3 w-3 mr-1" />
                  バックアップ
                </Button>
                {showBackupMenu && (
                  <div className="absolute top-full left-0 mt-1 bg-white border rounded-md shadow-lg z-50 min-w-[160px]">
                    <div className="py-1">
                      <button
                        onClick={() => openBackupPopup("完全バックアップ")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Database className="h-3 w-3" />
                        完全バックアップ
                      </button>
                      <button
                        onClick={() => openBackupPopup("増分バックアップ")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <RefreshCw className="h-3 w-3" />
                        増分バックアップ
                      </button>
                      <button
                        onClick={() => openBackupPopup("設定バックアップ")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Terminal className="h-3 w-3" />
                        設定バックアップ
                      </button>
                      <div className="border-t my-1"></div>
                      <button
                        onClick={() => openBackupPopup("バックアップ履歴")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 text-gray-600"
                      >
                        バックアップ履歴
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="relative">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowRestoreMenu(!showRestoreMenu)
                    setShowGitMenu(false)
                    setShowBackupMenu(false)
                  }}
                  className="text-primary-foreground hover:bg-primary-foreground/10 h-6 px-2 text-xs"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  復元
                </Button>
                {showRestoreMenu && (
                  <div className="absolute top-full left-0 mt-1 bg-white border rounded-md shadow-lg z-50 min-w-[160px]">
                    <div className="py-1">
                      <button
                        onClick={() => openRestorePopup("最新バックアップ")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <RefreshCw className="h-3 w-3" />
                        最新バックアップ
                      </button>
                      <button
                        onClick={() => openRestorePopup("特定の日時")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Database className="h-3 w-3" />
                        特定の日時
                      </button>
                      <button
                        onClick={() => openRestorePopup("設定のみ復元")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-900"
                      >
                        <Terminal className="h-3 w-3" />
                        設定のみ復元
                      </button>
                      <div className="border-t my-1"></div>
                      <button
                        onClick={() => openRestorePopup("緊急復元モード")}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 text-red-600"
                      >
                        緊急復元モード
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="h-3 w-px bg-primary-foreground/20 mx-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={createNewWindow}
                className="text-primary-foreground hover:bg-primary-foreground/10 h-6 w-6 p-0"
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <div className="flex-1 relative overflow-hidden">
        {visibleWindows.length === 0 && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <Terminal className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <p className="text-sm text-muted-foreground mb-4">アクティブなターミナルウィンドウがありません</p>
              <Button onClick={createNewWindow} className="gap-2">
                <Plus className="h-4 w-4" />
                新しいウィンドウを開く
              </Button>
            </div>
          </div>
        )}

        {visibleWindows.map((window) => (
          <Card
            key={window.id}
            className={cn(
              "shadow-lg border transition-all duration-200 rounded-lg overflow-hidden select-none bg-white",
              window.isMaximized ? "fixed inset-0 z-50 rounded-none" : "absolute",
            )}
            style={
              window.isMaximized
                ? { bottom: "28px" }
                : {
                    left: window.position.x,
                    top: window.position.y,
                    width: window.size.width,
                    height: window.size.height,
                    zIndex: window.zIndex,
                  }
            }
          >
            {!window.isMaximized && (
              <>
                <div
                  className="absolute top-0 left-0 w-2 h-2 cursor-nw-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "top-left")}
                />
                <div
                  className="absolute top-0 right-0 w-2 h-2 cursor-ne-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "top-right")}
                />
                <div
                  className="absolute bottom-0 left-0 w-2 h-2 cursor-sw-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "bottom-left")}
                />
                <div
                  className="absolute bottom-0 right-0 w-2 h-2 cursor-se-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "bottom-right")}
                />
                <div
                  className="absolute top-0 left-2 right-2 h-1 cursor-n-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "top")}
                />
                <div
                  className="absolute bottom-0 left-2 right-2 h-1 cursor-s-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "bottom")}
                />
                <div
                  className="absolute left-0 top-2 bottom-2 w-1 cursor-w-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "left")}
                />
                <div
                  className="absolute right-0 top-2 bottom-2 w-1 cursor-e-resize"
                  onMouseDown={(e) => handleMouseDown(e, window.id, "resize", "right")}
                />
              </>
            )}

            <div className="h-full flex flex-col">
              <div
                className="flex items-stretch bg-white border-b cursor-move h-8 relative"
                onMouseDown={(e) => {
                  const target = e.target as HTMLElement
                  if (!target.closest(".tab-area") && !target.closest("button")) {
                    handleMouseDown(e, window.id, "drag")
                  }
                }}
              >
                <div className="flex items-center flex-1">
                  <div className="w-2"></div>
                  <div className="flex items-stretch tab-area">
                    {window.tabs.map((tab, index) => (
                      <button
                        key={tab.id}
                        onClick={() => switchTab(window.id, tab.id)}
                        className={cn(
                          "px-3 py-1.5 text-sm flex items-center gap-2 group h-8 relative border-r border-gray-200 rounded-t-md",
                          tab.isActive ? "bg-gray-50 border-b-0" : "bg-white hover:bg-gray-50 border-b",
                        )}
                      >
                        <span className="text-gray-900">{tab.title}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            closeTab(window.id, tab.id)
                          }}
                          className="hover:bg-gray-200 rounded-sm p-1 w-6 h-6 flex items-center justify-center transition-colors"
                        >
                          <X className="h-4 w-4 text-gray-600" />
                        </button>
                      </button>
                    ))}
                    <button
                      onClick={() => createNewTab(window.id)}
                      className="px-2 py-1.5 h-8 hover:bg-gray-100 flex items-center justify-center"
                    >
                      <Plus className="h-3.5 w-3.5 text-gray-600" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center">
                  <button
                    onClick={() => toggleMinimize(window.id)}
                    className="h-8 w-12 flex items-center justify-center hover:bg-gray-200/50 transition-colors"
                  >
                    <Minus className="h-4 w-4 text-gray-700" />
                  </button>
                  <button
                    onClick={() => toggleMaximize(window.id)}
                    className="h-8 w-12 flex items-center justify-center hover:bg-gray-200/50 transition-colors"
                  >
                    {window.isMaximized ? (
                      <div className="relative">
                        <Square className="h-3 w-3 text-gray-700" />
                        <Square className="h-3 w-3 text-gray-700 absolute -top-0.5 -left-0.5" />
                      </div>
                    ) : (
                      <Square className="h-3 w-3 text-gray-700" />
                    )}
                  </button>
                  <button
                    onClick={() => closeWindow(window.id)}
                    className="h-8 w-12 flex items-center justify-center hover:bg-red-500 hover:text-white transition-colors rounded-tr-lg"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-hidden">
                {connectionStatus !== "connected" ? (
                  <div className="h-full flex items-center justify-center">
                    <div className="text-center">
                      <Terminal className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-xs text-muted-foreground">
                        {connectionStatus === "connecting" ? "接続中..." : "接続待機中"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div
                    ref={terminalRef}
                    className="h-full font-mono text-xs text-foreground overflow-auto leading-relaxed bg-gray-50 px-3 py-2 border-t-0"
                  >
                    {window.tabs
                      .find((tab) => tab.isActive)
                      ?.output.map((line, index) => (
                        <div key={index} className="whitespace-pre-wrap">
                          {line}
                        </div>
                      ))}
                    <div className="flex items-center mt-1">
                      <span className="text-accent font-semibold">rescue@console:~$</span>
                      <span className="ml-1 animate-pulse">_</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {(showGitPopup || showBackupPopup || showRestorePopup) && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
          <Card className="w-96 max-h-[80vh] overflow-auto">
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">{popupContent}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowGitPopup(false)
                    setShowBackupPopup(false)
                    setShowRestorePopup(false)
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {showGitPopup && (
                <div className="space-y-4">
                  {popupContent === "ブランチ状態" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">現在のGitブランチ状態:</p>
                      <div className="bg-gray-50 p-3 rounded font-mono text-xs">
                        <div>* main (現在のブランチ)</div>
                        <div> develop</div>
                        <div> feature/new-ui</div>
                      </div>
                      <div className="mt-3 text-sm">
                        <p>変更されたファイル: 3</p>
                        <p>コミット待ち: 2</p>
                      </div>
                    </div>
                  )}
                  {popupContent === "コミット" && (
                    <div>
                      <label className="block text-sm font-medium mb-2">コミットメッセージ:</label>
                      <textarea
                        className="w-full p-2 border rounded text-sm"
                        rows={3}
                        placeholder="変更内容を入力してください..."
                      ></textarea>
                      <Button className="mt-3 w-full">コミット実行</Button>
                    </div>
                  )}
                  {popupContent === "プル" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">リモートリポジトリから最新の変更を取得します。</p>
                      <Button className="w-full">プル実行</Button>
                    </div>
                  )}
                  {popupContent === "プッシュ" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">ローカルの変更をリモートリポジトリにプッシュします。</p>
                      <Button className="w-full">プッシュ実行</Button>
                    </div>
                  )}
                </div>
              )}

              {showBackupPopup && (
                <div className="space-y-4">
                  {popupContent === "完全バックアップ" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">アプリケーション全体の完全バックアップを作成します。</p>
                      <div className="space-y-2">
                        <label className="flex items-center">
                          <input type="checkbox" className="mr-2" defaultChecked />
                          データベース
                        </label>
                        <label className="flex items-center">
                          <input type="checkbox" className="mr-2" defaultChecked />
                          設定ファイル
                        </label>
                        <label className="flex items-center">
                          <input type="checkbox" className="mr-2" defaultChecked />
                          アップロードファイル
                        </label>
                      </div>
                      <Button className="mt-3 w-full">バックアップ開始</Button>
                    </div>
                  )}
                  {popupContent === "バックアップ履歴" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">過去のバックアップ履歴:</p>
                      <div className="space-y-2">
                        <div className="p-2 border rounded text-sm">
                          <div className="font-medium">2024-01-15 14:30</div>
                          <div className="text-gray-600">完全バックアップ (2.1GB)</div>
                        </div>
                        <div className="p-2 border rounded text-sm">
                          <div className="font-medium">2024-01-14 09:15</div>
                          <div className="text-gray-600">増分バックアップ (156MB)</div>
                        </div>
                        <div className="p-2 border rounded text-sm">
                          <div className="font-medium">2024-01-13 18:45</div>
                          <div className="text-gray-600">設定バックアップ (12MB)</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {showRestorePopup && (
                <div className="space-y-4">
                  {popupContent === "最新バックアップ" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">最新のバックアップから復元します。</p>
                      <div className="bg-yellow-50 p-3 rounded text-sm text-yellow-800 mb-3">
                        ⚠️ 現在のデータは上書きされます。この操作は元に戻せません。
                      </div>
                      <Button variant="destructive" className="w-full">
                        復元実行
                      </Button>
                    </div>
                  )}
                  {popupContent === "緊急復元モード" && (
                    <div>
                      <p className="text-sm text-gray-600 mb-3">
                        緊急時の復元モードです。システムを安全な状態に戻します。
                      </p>
                      <div className="bg-red-50 p-3 rounded text-sm text-red-800 mb-3">
                        🚨 この操作により、最近の変更は失われる可能性があります。
                      </div>
                      <Button variant="destructive" className="w-full">
                        緊急復元実行
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      <div className="px-4 py-1 border-t bg-muted/20 h-7 flex items-center">
        <div className="flex items-center justify-between text-xs w-full">
          <div className="flex items-center gap-2">
            {minimizedWindows.map((window) => (
              <Button
                key={window.id}
                variant="ghost"
                size="sm"
                onClick={() => restoreWindow(window.id)}
                className="h-5 px-2 text-xs hover:bg-muted"
              >
                <Terminal className="h-3 w-3 mr-1" />
                {window.title}
              </Button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">ステータス:</span>
              <div className={cn("flex items-center gap-1", getStatusColor())}>
                {getStatusIcon()}
                <span className="font-medium">{getStatusText()}</span>
              </div>
            </div>
            <div className="h-3 w-px bg-border" />
            <div className="text-muted-foreground">00:15:42</div>
            <div className="text-muted-foreground">CPU: 12% | RAM: 2.1GB</div>
          </div>
        </div>
      </div>
    </div>
  )
}
