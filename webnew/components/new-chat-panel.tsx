
// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Send, Bot, User } from "lucide-react"
import { cn } from "@/lib/utils"
import { useChat, ChatMessage } from "@/hooks/useChat";

interface NewChatPanelProps {
  isOpen: boolean
  onClose: () => void
}

export function NewChatPanel({ isOpen, onClose }: NewChatPanelProps) {
  const [input, setInput] = useState("")
  const { messages, sendUserMessage } = useChat(isOpen);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = () => {
    if (!input.trim()) return
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
          <div key={msg.id} className={cn("flex space-x-3", msg.type === "user" ? "justify-end" : "justify-start")}>
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
              <div className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</div>
            </div>
            {msg.type === "user" && (
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <User className="w-4 h-4 text-white" />
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
            placeholder="メッセージを入力..."
            className="flex-1 resize-none"
            rows={1}
          />
          <Button onClick={handleSendMessage}>
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
