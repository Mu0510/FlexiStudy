"use client"

import { useState } from "react"
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

export function ChatPanel({ isOpen, mode, onClose, onModeChange }: ChatPanelProps) {
  const [message, setMessage] = useState("")
  const [messages, setMessages] = useState([
    {
      id: 1,
      type: "bot" as const,
      content: "承知いたしました。直近のコミットにリセットします。",
      timestamp: "14:32",
    },
    {
      id: 2,
      type: "user" as const,
      content: "git reset --hard HEAD",
      timestamp: "14:33",
    },
    {
      id: 3,
      type: "bot" as const,
      content:
        "HEAD is now at 56e7b4c fix: チャットパネルのリサイズ状態をローカルストレージに保存\n\n関数に、リサイズ後のチャットパネルとテキストエリアをローカルストレージに保存する処理を追加。\n\n全画面切り替え時の復元もリサイズ後の値が反映されるよう、、も更新。",
      timestamp: "14:33",
    },
    {
      id: 4,
      type: "bot" as const,
      content: "直近のコミットにリセットしました。\nこれで、style.cssとchat.cssの変更は元に戻っています。",
      timestamp: "14:34",
    },
  ])

  const quickActions = [
    { icon: Database, label: "データベース操作", color: "text-blue-600" },
    { icon: BarChart3, label: "学習分析", color: "text-green-600" },
    { icon: Code, label: "コード実行", color: "text-purple-600" },
    { icon: Settings, label: "設定変更", color: "text-orange-600" },
  ]

  const handleSendMessage = () => {
    if (!message.trim()) return

    const newMessage = {
      id: messages.length + 1,
      type: "user" as const,
      content: message,
      timestamp: new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
    }

    setMessages([...messages, newMessage])
    setMessage("")
  }

  if (!isOpen) return null

  const panelClasses = cn("fixed bg-white border border-slate-200 shadow-2xl transition-all duration-300 z-50", {
    "top-4 right-4 w-96 h-[600px] rounded-2xl": mode === "floating",
    "top-0 right-0 w-96 h-full rounded-none border-l": mode === "sidebar",
    "inset-0 w-full h-full rounded-none border-none": mode === "fullscreen",
  })

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
            <div key={msg.id} className={cn("flex space-x-3", msg.type === "user" ? "justify-end" : "justify-start")}>
              {msg.type === "bot" && (
                <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Bot className="w-5 h-5 text-white" />
                </div>
              )}

              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-4 py-3",
                  msg.type === "user" ? "bg-primary-800 text-neutral-100" : "bg-neutral-200 text-neutral-900",
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
          ))}
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
