// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Send, Bot, User, CheckCircle, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
// Import Message interface directly from useChat
import { useChat, Message, ActiveMessage, ToolCardData } from "@/hooks/useChat";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { marked } from 'marked';

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
  // Destructure activeMessage and toolCardsData
  const { messages, activeMessage, isGeneratingResponse, toolCardsData, sendMessage, requestHistory } = useChat(); // Removed isOpen from useChat arguments

  const messagesContainerRef = useRef<HTMLDivElement>(null); // Reference to the scrollable messages container
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  // --- Scrolling Logic ---
  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return false;
    const { scrollHeight, scrollTop, clientHeight } = container;
    // chat.js uses +5 for threshold
    return scrollHeight - scrollTop <= clientHeight + 5;
  }, []);

  const scrollBottom = useCallback((force = false) => {
    const container = messagesContainerRef.current;
    if (!container) return;

    if (force || isNearBottom()) {
      container.scrollTop = container.scrollHeight;
    }
  }, [isNearBottom]);

  // Scroll to bottom when messages or activeMessage change
  useEffect(() => {
    scrollBottom();
  }, [messages, activeMessage, scrollBottom]);

  // 履歴読み込み時のスクロール位置維持
  const prevMessagesLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMessagesLength.current) {
      // メッセージが追加された場合（特に履歴読み込み時）
      const container = messagesContainerRef.current;
      if (container) {
        const newScrollTop = container.scrollTop + (container.scrollHeight - container.clientHeight);
        // requestAnimationFrame を2回ネストしてDOM更新後に実行
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            container.scrollTop = newScrollTop;
          });
        });
      }
    }
    prevMessagesLength.current = messages.length;
  }, [messages]);


  // Initial history load and scroll to bottom
  useEffect(() => {
    if (isOpen) {
      // requestHistory(true); // Request initial history when panel opens
      scrollBottom(true); // Force scroll to bottom on initial open
    }
  }, [isOpen, requestHistory, scrollBottom]);


  const handleSendMessage = () => {
    if (!input.trim() || isGeneratingResponse) return;
    sendMessage(input); // Use sendMessage from useChat
    setInput("")
    if (chatInputRef.current) {
      chatInputRef.current.focus();
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt+Enter for send, Enter for newline (as per chat.js)
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      if (!isGeneratingResponse) {
        handleSendMessage();
      }
    } else if (e.key === "Enter") {
      // Allow default Enter behavior for newline if Alt is not pressed
      // No need to preventDefault here unless we want to suppress default newline
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

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4"> {/* Added ref here */}
        {messages.map((msg) => {
          // Render tool messages
          if (msg.type === "tool") {
            const toolCard = toolCardsData.get(msg.toolCallId || ''); // Get data from toolCardsData
            if (!toolCard) return null; // Should not happen if data is consistent

            return (
              <Card key={msg.id} className={cn(
                "tool-card bg-gray-800 text-white rounded-lg p-3 shadow-md",
                "w-11/12 mx-auto my-1 mb-3",
                toolCard.status === "running" && "tool-card--running", // running クラスを追加
                toolCard.status === "finished" && "tool-card--finished border-l-4 border-green-500", // finished クラスとボーダー
                toolCard.status === "error" && "tool-card--error border-l-4 border-red-500" // error クラスとボーダー
              )}>
                <CardHeader className="flex flex-row items-center justify-between p-0 mb-1">
                  <div className="flex items-center space-x-2">
                    <span className="tool-card__icon-text text-xs border border-gray-500 rounded px-1 py-0.5">
                      {getToolIconText(toolCard.icon)}
                    </span>
                    <CardTitle className="tool-card__title text-sm font-medium text-gray-800">
                      {toolCard.label || "Tool Call"}
                    </CardTitle>
                  </div>
                  {/* chat.js の tool-card__line-break と tool-card__command に相当 */}
                  <div className="tool-card__line-break"></div>
                  <code className="tool-card__command text-xs text-gray-600">
                    {getRelativePath(toolCard.command)}
                  </code>
                  <div className="tool-card__status-indicator">
                    {toolCard.status === "finished" && <CheckCircle className="h-4 w-4 text-green-500" />}
                    {toolCard.status === "error" && <XCircle className="h-4 w-4 text-red-500" />}
                    {toolCard.status === "running" && (
                      <span className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500"></span>
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="p-0 text-sm text-gray-700">
                  {/* Removed toolCallConfirmation logic for now, focusing on content */}
                  <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-900 p-2 rounded">
                    <div dangerouslySetInnerHTML={{ __html: toolCard.content }} /> {/* Use toolCard.content */}
                  </pre>
                </CardContent>
              </Card>
            );
          } else {
            // Render user/assistant messages
            return (
              <div key={msg.id} className={cn("flex space-x-3", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role === "assistant" && (
                  <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                )}
                <div
                  className={cn(
                    "rounded-2xl px-4 py-3",
                    msg.role === "user" ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-800",
                  )}
                >
                  <div className="text-sm leading-relaxed whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) }} />
                  {/* Removed timestamp for now, not in Message interface */}
                </div>
                {msg.role === "user" && (
                  <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-white" />
                  </div>
                )}
              </div>
            );
          }
        })}

        {/* Render activeMessage (thinking bubble or streaming assistant message) */}
        {activeMessage && (
          <div className={cn("flex space-x-3", "justify-start")}>
            <div className="w-8 h-8 bg-gradient-to-br from-accent-500 to-accent-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div
              className={cn(
                "rounded-2xl px-4 py-3",
                "bg-gray-200 text-gray-800",
                activeMessage.thoughtMode && "animate-pulse" // Apply pulse for thought mode
              )}
            >
              <div className="text-sm leading-relaxed whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: marked.parse(activeMessage.content) }} />
              {console.log("Active Message Content:", activeMessage.content)} {/* ここにログを追加 */}
            </div>
          </div>
        )}
        {/* <div ref={messagesEndRef} /> を削除 */}
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
