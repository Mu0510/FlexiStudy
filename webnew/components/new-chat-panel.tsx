// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Bot, User, CheckCircle, XCircle, Maximize, Minimize, Plus, SlidersHorizontal, Mic, ArrowUp } from "lucide-react"
import { cn } from "@/lib/utils"
// Import Message interface directly from useChat
import { useChat } from "@/hooks/useChat";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";

interface NewChatPanelProps {
  isOpen: boolean
  onClose: () => void
  isFullScreen: boolean
  setIsFullScreen: (isFullScreen: boolean) => void
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

export function NewChatPanel({ isOpen, onClose, isFullScreen, setIsFullScreen }: NewChatPanelProps) {
  const [input, setInput] = useState("")
  // Destructure activeMessage and toolCardsData
  const { messages, activeMessage, isGeneratingResponse, sendMessage, requestHistory } = useChat(); // Removed isOpen from useChat arguments

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isGeneratingResponse) {
        handleSendMessage();
      }
    }
  };

  if (!isOpen) return null

  return (
    <div className={cn(
      "bg-white border border-slate-200 shadow-2xl rounded-2xl flex flex-col z-50",
      isFullScreen 
        ? "fixed inset-0"
        : "fixed bottom-4 right-4 w-96 h-[600px]"
    )}>
      <div className="flex-shrink-0 border-b p-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Gemini Chat</h2>
        <div className="flex items-center space-x-2">
          <Button variant="ghost" size="sm" onClick={() => setIsFullScreen(!isFullScreen)} className="p-2">
            {isFullScreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="p-2">
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto"> {/* Added ref here */}
        <div className="p-4 space-y-8 max-w-prose mx-auto">
        {messages.map((msg) => {
          // Render tool messages
          if (msg.type === "tool") {
            // const toolCard = toolCardsData.get(msg.toolCallId || ''); // Get data from toolCardsData
            // if (!toolCard) return null; // Should not happen if data is consistent
            // データソースを msg オブジェクトに一本化
            return (
              <Card key={msg.id} className={cn(
                "tool-card bg-gray-100 text-gray-900 rounded-lg p-3 shadow-md", // 薄いグレーのパネルに変更
                "w-11/12 mx-auto my-1 mb-3",
                msg.status === "running" && "tool-card--running", // running クラスを追加
                msg.status === "finished" && "tool-card--finished border-l-4 border-green-500", // finished クラスとボーダー
                msg.status === "error" && "tool-card--error border-l-4 border-red-500" // error クラスとボーダー
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
                  {/* chat.js の tool-card__line-break と tool-card__command に相当 */}
                  <div className="tool-card__line-break"></div>
                  <code className="tool-card__command text-xs text-gray-600">
                    {getRelativePath(msg.command)}
                  </code>
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
                <CardContent className="p-0 text-sm text-white">
                  {/* Removed toolCallConfirmation logic for now, focusing on content */}
                  <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-800 p-2 rounded not-prose max-h-48 overflow-auto">
                    <div className="text-white" dangerouslySetInnerHTML={{ __html: msg.content }} /> {/* Use msg.content */}
                  </pre>
                </CardContent>
              </Card>
            );
          } else {
            // Render user/assistant messages
            return (
              <div key={msg.id} className={cn("flex justify-end", msg.role === "user" ? "" : "mx-auto w-[95%]")}>
                <div
                    className={cn(
                      "prose prose-sm dark:prose-invert",
                      msg.role === "user" ? "ml-auto bg-gray-100 text-gray-900 rounded-2xl px-4 py-1 max-w-[65%]" : "mx-auto w-[95%]",
                    )}
                  >
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkBreaks]}
                      rehypePlugins={[rehypeRaw]}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>
              </div>
            );
          }
        })}

        {/* Render activeMessage (thinking bubble or streaming assistant message) */}
        {activeMessage && (
          <div className={cn("flex space-x-3", "justify-start")}>
            <div
              className={cn(
                "prose prose-sm dark:prose-invert mx-auto w-[95%]",
                activeMessage.thoughtMode && "animate-pulse" // Apply pulse for thought mode
              )}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                rehypePlugins={[rehypeRaw]}
              >
                {activeMessage.content}
              </ReactMarkdown>
              {console.log("Active Message Content:", activeMessage.content)} {/* ここにログを追加 */}
            </div>
          </div>
        )}
        </div>
      </div>

      <div className="flex-shrink-0 p-4 border-t">
        <div className="flex flex-col rounded-2xl border border-gray-200 bg-white p-2">
          <Textarea
            ref={chatInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={isGeneratingResponse ? "応答を生成中..." : "メッセージを入力... (Shift+Enterで改行)"}
            className="w-full resize-none border-none focus:ring-0 bg-transparent"
            rows={1}
            disabled={isGeneratingResponse}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="flex items-center gap-2 text-gray-500">
              <Button variant="ghost" size="icon" className="rounded-full">
                <Plus className="w-5 h-5" strokeWidth={2} />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full">
                <SlidersHorizontal className="w-5 h-5" strokeWidth={2} />
              </Button>
              <Button variant="ghost" size="icon" className="rounded-full">
                <Mic className="w-5 h-5" strokeWidth={2} />
              </Button>
            </div>
            <Button
              onClick={handleSendMessage}
              disabled={isGeneratingResponse || !input.trim()}
              className="bg-black hover:bg-gray-800 text-white rounded-full p-2"
            >
              <ArrowUp className="w-4 h-4" strokeWidth={2} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
