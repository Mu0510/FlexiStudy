"use client"

import { useState, useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CardHeader, CardTitle } from "@/components/ui/card"
import { X, Maximize2, Minimize2, Send, Bot, User, Code, Database, BarChart3, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

interface ChatPanelProps {
  isOpen: boolean
  mode: "floating" | "sidebar" | "fullscreen"
  onClose: () => void
  onModeChange: (mode: "floating" | "sidebar" | "fullscreen") => void
}

interface ChatMessage {
  id: number | string;
  type: "user" | "bot" | "tool";
  content: string;
  timestamp: string;
  // tool-specific properties
  icon?: string;
  label?: string;
  command?: string;
  status?: "running" | "finished" | "error";
  isThinking?: boolean; // 新しく追加
}

export function ChatPanel({ isOpen, mode, onClose, onModeChange }: ChatPanelProps) {
  const [message, setMessage] = useState("")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isThinkingMessageId, setIsThinkingMessageId] = useState<string | number | null>(null);
  const ws = useRef<WebSocket | null>(null)
  const requestId = useRef(1)
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      if (ws.current) {
        ws.current.close()
        ws.current = null
      }
      return
    }

    if (!ws.current) {
      ws.current = new WebSocket(`ws://${location.host.split(':')[0]}:3001/ws`)

      ws.current.onopen = () => {
        console.log("WebSocket connected")
        ws.current?.send(JSON.stringify({
          jsonrpc: "2.0",
          id: requestId.current++,
          method: "fetchHistory",
          params: { limit: 30 }
        }))
      }

      ws.current.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        console.log("Received:", msg)

        if (msg.method === "streamAssistantThoughtChunk") {
          setMessages((prevMessages) => {
            if (isThinkingMessageId) {
              // 既存の思考中メッセージを更新
              return prevMessages.map((m) =>
                m.id === isThinkingMessageId
                  ? { ...m, content: msg.params.thought || "...思考中...", isThinking: true }
                  : m
              );
            } else {
              // 新しい思考中メッセージとして追加
              const newId = Date.now();
              setIsThinkingMessageId(newId);
              return [
                ...prevMessages,
                {
                  id: newId,
                  type: "bot",
                  content: msg.params.thought || "...思考中...",
                  timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
                  isThinking: true,
                },
              ];
            }
          });
        } else if (msg.method === "streamAssistantMessageChunk") {
          setMessages((prevMessages) => {
            if (isThinkingMessageId) {
              // 既存の思考中メッセージを更新し、思考中フラグを解除
              return prevMessages.map((m) =>
                m.id === isThinkingMessageId
                  ? { ...m, content: m.content + (msg.params.chunk.text || ""), isThinking: false }
                  : m
              );
            } else {
              // 新しいメッセージとして追加 (思考中メッセージがなかった場合)
              return [
                ...prevMessages,
                {
                  id: Date.now(),
                  type: "bot",
                  content: msg.params.chunk.text || "",
                  timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
                  isThinking: false,
                },
              ];
            }
          });
        } else if (msg.method === "addMessage") {
          setMessages((prevMessages) => {
            let updatedMessages = prevMessages;
            if (isThinkingMessageId) {
              // 思考中メッセージを削除
              updatedMessages = prevMessages.filter((m) => m.id !== isThinkingMessageId);
              setIsThinkingMessageId(null); // 思考中メッセージIDをリセット
            }

            // 新しいメッセージを追加
            return [
              ...updatedMessages,
              {
                id: msg.params.message.id,
                type: msg.params.message.role === "user" ? "user" : "bot",
                content: msg.params.message.text,
                timestamp: new Date(msg.params.message.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
                status: "finished",
                isThinking: false,
              },
            ];
          });
        } else if (msg.method === "pushToolCall") {
          setMessages((prevMessages) => {
            let updatedMessages = prevMessages;
            if (isThinkingMessageId) {
              // 思考中メッセージを削除
              updatedMessages = prevMessages.filter((m) => m.id !== isThinkingMessageId);
              setIsThinkingMessageId(null); // 思考中メッセージIDをリセット
            }

            return [
              ...updatedMessages,
              {
                id: msg.params.toolCallId || msg.id,
                type: "tool",
                content: "",
                timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
                icon: msg.params.icon,
                label: msg.params.label,
                command: msg.params.locations?.[0]?.path || "",
                status: "running",
              },
            ];
          });
          ws.current?.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { id: msg.params.toolCallId || msg.id }
          }))
        } else if (msg.method === "updateToolCall") {
          setMessages((prevMessages) =>
            prevMessages.map((m) =>
              m.id === (msg.params.toolCallId || msg.params.callId)
                ? {
                    ...m,
                    content: msg.params.content?.markdown || JSON.stringify(msg.params.content, null, 2),
                    status: msg.params.status,
                  }
                : m
            )
          )
        } else if (msg.method === "historyCleared") {
          setMessages([]);
        } else if (msg.result && msg.result.messages) {
          const historyMessages = msg.result.messages.map((m: any) => ({
            id: m.id,
            type: m.role === "user" ? "user" : m.type === "tool" ? "tool" : "bot",
            content: m.text || m.content?.markdown || JSON.stringify(m.content, null, 2),
            timestamp: new Date(m.ts).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
            icon: m.type === "tool" ? m.params.icon : undefined,
            label: m.type === "tool" ? m.params.label : undefined,
            command: m.type === "tool" ? m.params.locations?.[0]?.path || "" : undefined,
            status: m.type === "tool" ? m.params.status : "finished",
            isThinking: false,
          }));
          setMessages((prevMessages) => [...historyMessages, ...prevMessages]);
        }
      }

      ws.current.onclose = () => {
        console.log("WebSocket disconnected")
      }

      ws.current.onerror = (error) => {
        console.error("WebSocket error:", error)
      }
    }

    return () => {
      if (ws.current) {
        ws.current.close()
        ws.current = null
      }
    }
  }, [isOpen])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const quickActions = [
    { icon: Database, label: "データベース操作", color: "text-blue-600" },
    { icon: BarChart3, label: "学習分析", color: "text-green-600" },
    { icon: Code, label: "コード実行", color: "text-purple-600" },
    { icon: Settings, label: "設定変更", color: "text-orange-600" },
  ]

  const handleSendMessage = () => {
    if (!message.trim() || !ws.current) return

    const userMessage: ChatMessage = {
      id: Date.now(),
      type: "user",
      content: message,
      timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
    }
    setMessages((prevMessages) => [...prevMessages, userMessage])

    ws.current.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId.current++,
        method: "sendUserMessage",
        params: { chunks: [{ text: message }] },
      })
    )
    setMessage("")
  }

  if (!isOpen) return null

  const panelClasses = cn("fixed bg-white border border-slate-200 shadow-2xl transition-all duration-300 z-50", {
    "top-4 right-4 w-96 h-[600px] rounded-2xl": mode === "floating",
    "top-0 right-0 w-96 h-full rounded-none border-l": mode === "sidebar",
    "inset-0 w-full h-full rounded-none border-none": mode === "fullscreen",
  })

  const getToolIconText = (iconName?: string) => {
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
  };

  const PROJECT_ROOT_PATH = '/home/geminicli/GeminiCLI/';

  const getRelativePath = (absolutePath?: string) => {
    if (!absolutePath) return '';
    if (absolutePath.startsWith(PROJECT_ROOT_PATH)) {
      return absolutePath.substring(PROJECT_ROOT_PATH.length);
    }
    return absolutePath;
  };

  return (
    <div className={panelClasses}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <CardHeader className="flex-shrink-0 border-b bg-gradient-to-r from-accent-50 to-secondary-50">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg">Gemini Chat</span>
            </CardTitle>

            <div className="flex items-center space-x-2">
              {mode !== "fullscreen" && (
                <Button variant="ghost" size="sm" onClick={() => onModeChange("fullscreen")} className="p-2">
                  <Maximize2 className="w-4 h-4" />
                </Button>
              )}

              {mode === "fullscreen" && (
                <Button variant="ghost" size="sm" onClick={() => onModeChange("floating")} className="p-2">
                  <Minimize2 className="w-4 h-4" />
                </Button>
              )}

              <Button variant="ghost" size="sm" onClick={onClose} className="p-2">
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Quick Actions */}
        <div className="flex-shrink-0 p-4 border-b bg-slate-50">
          <div className="grid grid-cols-2 gap-2">
            {quickActions.map((action, index) => {
              const Icon = action.icon
              return (
                <Button
                  key={index}
                  variant="outline"
                  size="sm"
                  className="justify-start text-xs border-slate-200 hover:bg-white bg-transparent"
                >
                  <Icon className={`w-3 h-3 mr-2 ${action.color}`} />
                  {action.label}
                </Button>
              )
            })}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg) => (
            <div key={msg.id}>
              {msg.type === "tool" ? (
                <div className={cn(
                  "tool-card bg-gray-800 text-white rounded-lg p-3 shadow-md",
                  "w-11/12 mx-auto my-1 mb-3",
                  msg.status === "finished" && "border-l-4 border-green-500",
                  msg.status === "error" && "border-l-4 border-red-500"
                )}>
                  <div className="tool-card__header flex items-center gap-2 font-semibold text-sm mb-1">
                    <span className="tool-card__icon-text text-xs border border-gray-500 rounded px-1 py-0.5">
                      {getToolIconText(msg.icon)}
                    </span>
                    <span className="tool-card__title flex-grow">{msg.label}</span>
                    <code className="tool-card__command text-gray-400 text-xs">
                      {getRelativePath(msg.command)}
                    </code>
                  </div>
                  <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-900 p-2 rounded">
                    {msg.content}
                  </pre>
                </div>
              ) : (
                <div className={cn("flex space-x-3", msg.type === "user" ? "justify-end" : "justify-start")}>
                  {msg.type === "bot" && (
                    <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Bot className="w-5 h-5 text-white" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "rounded-2xl",
                      msg.type === "user" ? "bg-primary-800 text-neutral-100 max-w-[70%] px-4 py-3 my-2" : "w-[90%] bg-transparent text-neutral-900 p-0 my-1 mb-5",
                      msg.type === "bot" && msg.isThinking && "animate-pulse"
                    )}
                  >
                    <div className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
                    <div className={cn("text-xs mt-2", msg.type === "user" ? "text-neutral-100" : "text-neutral-500")}>
                      {msg.timestamp}
                    </div>
                  </div>

                  {msg.type === "user" && (
                    <div className="w-8 h-8 bg-primary-800 rounded-lg flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-white" />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="flex-shrink-0 p-4 border-t bg-white">
          <div className="flex space-x-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="メッセージを入力..."
              className="flex-1"
              onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
            />
            <Button
              onClick={handleSendMessage}
              className="bg-gradient-to-r from-accent-500 to-accent-600 hover:from-accent-600 hover:to-accent-700"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}