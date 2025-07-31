// webnew/components/chat-panel.tsx
"use client"

import { useState, useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CardHeader, CardTitle, Card, CardContent } from "@/components/ui/card"
import { X, Maximize2, Minimize2, Send, Bot, User, Code, Database, BarChart3, Settings, CheckCircle, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChat, ChatMessage } from "@/hooks/useChat"; // Import useChat and ChatMessage
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

interface ChatPanelProps {
  isOpen: boolean
  mode: "floating" | "sidebar" | "fullscreen"
  onClose: () => void
  onModeChange: (mode: "floating" | "sidebar" | "fullscreen") => void
}

export function ChatPanel({ isOpen, mode, onClose, onModeChange }: ChatPanelProps) {
  const [input, setInput] = useState("")
  const { messages, sendMessage, sendToolConfirmation } = useChat(); // Use the custom hook
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

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
    if (!input.trim()) return
    sendMessage(input); // Use sendMessage from the hook
    setInput("")
    if (chatInputRef.current) {
      chatInputRef.current.focus();
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

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
          {messages.map((msg: ChatMessage) => (
            <div key={msg.id}>
              {msg.type === "tool" ? (
                <Card className={cn(
                  "tool-card bg-gray-800 text-white rounded-lg p-3 shadow-md",
                  "w-11/12 mx-auto my-1 mb-3",
                  msg.status === "finished" && "border-l-4 border-green-500",
                  msg.status === "error" && "border-l-4 border-red-500"
                )}>
                  <CardHeader className="flex flex-row items-center justify-between p-0 mb-1">
                    <div className="flex items-center space-x-2">
                      <span className="tool-card__icon-text text-xs border border-gray-500 rounded px-1 py-0.5">
                        {getToolIconText(msg.icon)}
                      </span>
                      <CardTitle className="tool-card__title text-sm font-medium text-gray-800">
                        {msg.label || "Tool Call"}
                      </CardTitle>
                    </div>
                    <div className="tool-card__status-indicator">
                      {msg.status === "finished" && <CheckCircle className="h-4 w-4 text-green-500" />}
                      {msg.status === "error" && <XCircle className="h-4 w-4 text-red-500" />}
                      {msg.status === "running" && (
                        <span className="relative flex h-3 w-3">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="p-0 text-sm text-gray-700">
                    {msg.toolCallConfirmationId ? (
                      <div className="space-y-2">
                        <p>{msg.toolCallConfirmationMessage}</p>
                        <div className="flex flex-wrap gap-2">
                          {msg.toolCallConfirmationButtons?.map((button) => (
                            <Button
                              key={button.value}
                              variant="outline"
                              size="sm"
                              onClick={() => sendToolConfirmation(msg.toolCallId!, button.value === "true")} // sendToolConfirmation を使用
                              disabled={msg.status !== "running"} // Disable buttons if not running (i.e., already confirmed)
                            >
                              {button.label}
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-900 p-2 rounded">
                        <div dangerouslySetInnerHTML={{ __html: msg.content }} />
                      </pre>
                    )}
                  </CardContent>
                </Card>
              ) : (
                <div className={cn("flex space-x-3", msg.role === "user" ? "justify-end" : "justify-start")}>
                  {msg.role === "assistant" && (
                    <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Bot className="w-5 h-5 text-white" />
                    </div>
                  )}

                  <div
                    className={cn(
                      "prose prose-sm dark:prose-invert max-w-none",
                      msg.role === "user"
                        ? "bg-primary-800 text-neutral-100 rounded-2xl px-4 py-3 max-w-[70%] my-2"
                        : "w-[90%] bg-transparent text-neutral-900 mb-5",
                      msg.role === "assistant" && "animate-pulse"
                    )}
                  >
                    {console.log("msg.content:", msg.content)}
					<ReactMarkdown
					  remarkPlugins={[remarkGfm]}
					  rehypePlugins={[rehypeRaw]}
					>
					  {msg.content}
					</ReactMarkdown>

                    <div className={cn("text-xs mt-2", msg.role === "user" ? "text-neutral-100" : "text-neutral-500")}>
                      {/* msg.timestamp は存在しないため削除 */}
                    </div>
                  </div>

                  {msg.role === "user" && (
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
            <Textarea
              ref={chatInputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="メッセージを入力..."
              className="flex-1 resize-none"
              rows={1}
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