
// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Send, Bot, User, CheckCircle, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChat, ChatMessage } from "@/hooks/useChat";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface NewChatPanelProps {
  isOpen: boolean
  onClose: () => void
}

const PROJECT_ROOT_PATH = '/home/geminicli/GeminiCLI/';

function getRelativePath(absolutePath?: string) {
  if (!absolutePath) return '';
  if (absolutePath.startsWith(PROJECT_ROOT_PATH)) {
    return absolutePath.substring(PROJECT_ROOT_PATH.length);
  }
  return absolutePath;
}

function getToolIconText(iconName?: string) {
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
}

export function NewChatPanel({ isOpen, onClose }: NewChatPanelProps) {
  const [input, setInput] = useState("")
  const { messages, sendUserMessage, sendToolCallConfirmation, isGeneratingResponse } = useChat(isOpen);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = () => {
    if (!input.trim() || isGeneratingResponse) return;
    sendUserMessage(input);
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

  return (
    <div className="fixed bottom-4 right-4 w-96 h-[600px] bg-white border border-slate-200 shadow-2xl rounded-2xl flex flex-col z-50">
      <div className="flex-shrink-0 border-b p-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Gemini Chat</h2>
        <Button variant="ghost" size="sm" onClick={onClose} className="p-2">
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
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
                            onClick={() => sendToolCallConfirmation(msg.toolCallConfirmationId!, button.value)}
                            disabled={msg.status !== "running"} // Disable buttons if not running (i.e., already confirmed)
                          >
                            {button.label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-900 p-2 rounded">
                      <div dangerouslySetInnerHTML={{ __html: msg.toolBody || msg.content }} />
                    </pre>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className={cn("flex space-x-3", msg.type === "user" ? "justify-end" : "justify-start")}>
                {msg.type === "bot" && (
                  <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                )}
                <div
                  className={cn(
                    "rounded-2xl px-4 py-3",
                    msg.type === "user" ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-800",
                    msg.isThinking && "animate-pulse"
                  )}
                >
                  <div className="text-sm leading-relaxed whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: msg.content }} />
                  <div className="text-xs mt-2 text-gray-500">
                    {msg.timestamp}
                  </div>
                </div>
                {msg.type === "user" && (
                  <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-white" />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="flex-shrink-0 p-4 border-t">
        <div className="flex space-x-2">
          <Textarea
            ref={chatInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={isGeneratingResponse ? "応答を生成中..." : "メッセージを入力..."}
            className="flex-1 resize-none"
            rows={1}
            disabled={isGeneratingResponse}
          />
          <Button onClick={handleSendMessage} disabled={isGeneratingResponse}>
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
