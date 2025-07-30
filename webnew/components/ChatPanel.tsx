// webnew/components/ChatPanel.tsx
"use client";

import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Send, Bot, User, X, Maximize2, Minimize2, CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChat, ChatMessage } from "@/hooks/useChat";
import { Textarea } from "@/components/ui/textarea";

interface ChatPanelProps {
  // isOpen: boolean;
  // mode: "normal" | "fullscreen" | "hidden";
  // onClose: () => void;
  // onModeChange: (mode: "normal" | "fullscreen" | "hidden") => void;
}

export default function ChatPanel({}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [isOpen, setIsOpen] = useState(true); // Always open for now
  const [mode, setMode] = useState<"normal" | "fullscreen" | "hidden">("normal");
  const { messages, sendUserMessage, sendToolCallConfirmation } = useChat(isOpen);
  const endRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    sendUserMessage(input);
    setInput("");
    if (chatInputRef.current) {
      chatInputRef.current.focus();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleFullscreen = () => {
    setMode(prev => (prev === "fullscreen" ? "normal" : "fullscreen"));
  };

  const handleClose = () => {
    setIsOpen(false);
    setMode("hidden");
  };

  const handleOpen = () => {
    setIsOpen(true);
    setMode("normal");
  };

  if (!isOpen && mode === "hidden") {
    return (
      <Button
        id="chatOpenBtn"
        className="fixed bottom-4 right-4 p-4 rounded-full shadow-lg bg-blue-500 text-white"
        onClick={handleOpen}
      >
        Chat
      </Button>
    );
  }

  const panelClasses = cn(
    "fixed bottom-0 right-0 flex flex-col bg-white shadow-lg rounded-lg overflow-hidden",
    "transition-all duration-300 ease-in-out",
    mode === "normal" && "w-96 h-3/4",
    mode === "fullscreen" && "w-full h-full top-0 left-0 rounded-none",
    mode === "hidden" && "hidden"
  );

  return (
    <Card className={panelClasses}>
      <CardHeader className="flex flex-row items-center justify-between p-4 border-b bg-gray-100">
        <CardTitle className="text-lg font-semibold">Gemini Chat</CardTitle>
        <div className="flex space-x-2">
          <Button variant="ghost" size="icon" onClick={toggleFullscreen} title="全画面">
            {mode === "fullscreen" ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClose} title="閉じる">
            <X className="h-5 w-5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
        {messages.map((m: ChatMessage) => (
          <MessageBubble key={m.id} msg={m} sendToolCallConfirmation={sendToolCallConfirmation} />
        ))}
        <div ref={endRef} />
      </CardContent>
      <div className="p-4 border-t bg-white flex space-x-2">
        <Textarea
          ref={chatInputRef}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyPress={handleKeyPress}
          placeholder="メッセージを入力…"
          className="flex-1 resize-none"
          rows={1}
        />
        <Button onClick={handleSend} size="icon">
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </Card>
  );
}

interface MessageBubbleProps {
  msg: ChatMessage;
  sendToolCallConfirmation: (toolCallConfirmationId: number, value: string) => void;
}

function MessageBubble({ msg, sendToolCallConfirmation }: MessageBubbleProps) {
  if (msg.type === "tool") {
    const isRunning = msg.status === "running";
    const isFinished = msg.status === "finished";
    const isError = msg.status === "error";

    return (
      <Card className={cn(
        "tool-card bg-gray-100 border border-gray-200 shadow-sm",
        isRunning && "tool-card--running",
        isFinished && "tool-card--finished",
        isError && "tool-card--error"
      )}>
        <CardHeader className="flex flex-row items-center justify-between p-3 border-b">
          <div className="flex items-center space-x-2">
            <span className="tool-card__icon-text text-gray-600">🛠️</span>
            <CardTitle className="tool-card__title text-sm font-medium text-gray-800">
              {msg.toolName || "Tool Call"}
            </CardTitle>
          </div>
          <div className="tool-card__status-indicator">
            {isFinished && <CheckCircle className="h-4 w-4 text-green-500" />}
            {isError && <XCircle className="h-4 w-4 text-red-500" />}
            {isRunning && (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-3 text-sm text-gray-700">
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
                    disabled={!isRunning} // Disable buttons if not running (i.e., already confirmed)
                  >
                    {button.label}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: msg.toolBody || msg.content }} />
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      className={cn(
        "flex space-x-3 items-start",
        msg.type === "user" ? "justify-end" : "justify-start"
      )}
    >
      {msg.type === "bot" && (
        <div className="flex-shrink-0">
          <Bot className="h-8 w-8 text-blue-500" />
        </div>
      )}
      <div
        className={cn(
          "p-3 rounded-lg max-w-[70%]",
          msg.type === "user"
            ? "bg-blue-500 text-white rounded-br-none"
            : "bg-gray-200 text-gray-800 rounded-bl-none",
          msg.isThinking && "animate-pulse"
        )}
      >
        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
        <div className="text-xs mt-1 opacity-75">{msg.timestamp}</div>
      </div>
      {msg.type === "user" && (
        <div className="flex-shrink-0">
          <User className="h-8 w-8 text-green-500" />
        </div>
      )}
    </div>
  );
}
