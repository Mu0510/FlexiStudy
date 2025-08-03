// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react"
import { FixedSizeList } from 'react-window';
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Bot, User, CheckCircle, XCircle, Maximize, Minimize, Plus, SlidersHorizontal, Mic, ArrowUp, Square, File as FileIcon } from "lucide-react"
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils"
// import { useChat } from '@/hooks/useChat'; // useChatは親コンポーネントで管理
import { Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import { motion, AnimatePresence } from "framer-motion";

interface FileInfo {
  name: string;
  path: string;
  size: number;
}

interface Goal {
  id: string | number;
  completed: boolean;
  subject: string;
  task: string;
  details?: string;
  tags?: string[];
  total_problems?: number | null;
  completed_problems?: number | null;
}

interface Message {
  id: string;
  ts?: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  files?: FileInfo[];
  goal?: Goal | null;
  type?: 'text' | 'tool';
  toolCallId?: string;
  status?: 'running' | 'finished' | 'error';
  icon?: string;
  label?: string;
  command?: string;
}

interface ActiveMessage {
  id: string;
  ts: number;
  type: 'thought' | 'assistant';
  content: string;
  thoughtMode: boolean;
}

interface NewChatPanelProps {
  showAs?: 'floating' | 'embedded';
  // --- Floating mode props ---
  isOpen?: boolean;
  onClose?: () => void;
  isFullScreen?: boolean;
  setIsFullScreen?: (isFullScreen: boolean) => void;
  onMaximizeClick?: () => void;
  // --- Goal related props ---
  selectedGoal?: Goal | null;
  onClearSelectedGoal?: () => void;
  // --- useChat related props ---
  messages: Message[];
  activeMessage: ActiveMessage | null;
  isGeneratingResponse: boolean;
  sendMessage: (messageData: { text: string; files?: FileInfo[]; goal?: Goal | null; }) => void;
  cancelSendMessage: () => void;
  requestHistory: (isInitialLoad?: boolean) => void;
  isFetchingHistory: boolean;
  historyFinished: boolean;
  clearMessages: () => void;
  // --- Input related props ---
  input: string;
  setInput: (input: string) => void;
  // --- File related props ---
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
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

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};


export function NewChatPanel({ 
  showAs = 'floating',
  isOpen, 
  onClose, 
  isFullScreen, 
  setIsFullScreen,
  onMaximizeClick,
  selectedGoal,
  onClearSelectedGoal,
  // --- useChat related props ---
  messages,
  activeMessage,
  isGeneratingResponse,
  sendMessage,
  cancelSendMessage,
  requestHistory,
  isFetchingHistory,
  historyFinished,
  clearMessages,
  // --- Input related props ---
  input,
  setInput,
  // --- File related props ---
  selectedFiles,
  setSelectedFiles,
}: NewChatPanelProps) {
  const isFloating = showAs === 'floating';

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
          setContainerSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      });
      resizeObserver.observe(container);
      return () => resizeObserver.disconnect();
    }
  }, []);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // useChatフックの呼び出しを削除
  // const { messages, activeMessage, isGeneratingResponse, sendMessage, cancelSendMessage, requestHistory, isFetchingHistory, historyFinished, clearMessages } = useChat({
  //   onMessageReceived: () => {
  //     const container = messagesContainerRef.current;
  //     if (container) {
  //       const { scrollHeight, scrollTop, clientHeight } = container;
  //       const isAtBottom = scrollHeight - scrollTop <= clientHeight + 5; // 5pxの許容範囲
  //       if (isAtBottom) {
  //         shouldScrollToBottomRef.current = true;
  //       }
  //     }
  //   },
  // });

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null); // Ref for the scroll anchor
  const shouldScrollToBottomRef = useRef(true); // 初回ロード時はスクロールしたいのでtrueに初期化

  // Auto-resize textarea with max height
  useEffect(() => {
    const textarea = chatInputRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const lineHeight = 24;
      const maxScrollHeight = lineHeight * 6;
      if (textarea.scrollHeight > maxScrollHeight) {
        textarea.style.height = `${maxScrollHeight}px`;
        textarea.style.overflowY = "scroll";
      } else {
        textarea.style.height = `${textarea.scrollHeight}px`;
        textarea.style.overflowY = "hidden";
      }
    }
  }, [input]);

  const handleSendMessage = async () => {
    if (!input.trim() && selectedFiles.length === 0) return;

    // /clear コマンドの処理
    if (input.trim() === '/clear') {
      clearMessages();
      setInput("");
      setSelectedFiles([]);
      if (chatInputRef.current) {
        chatInputRef.current.focus();
      }
      return;
    }

    let uploadedFiles: { name: string, path: string, size: number }[] = [];

    // --- Phase 4: File Upload Logic with AbortController ---
    if (selectedFiles.length > 0) {
      const formData = new FormData();
      selectedFiles.forEach(file => {
        formData.append("files", file);
      });

      const controller = new AbortController();
      uploadAbortControllerRef.current = controller;
      setIsUploading(true);
      setUploadProgress(0);

      try {
        const result = await new Promise<{ success: boolean, files: { name: string, path: string, size: number }[] }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const controllerSignal = controller.signal;

          xhr.open('POST', '/api/upload', true);

          // Abort handling
          const abortHandler = () => {
            xhr.abort();
            reject(new DOMException('Aborted', 'AbortError'));
          };
          controllerSignal.addEventListener('abort', abortHandler);

          // Progress handling
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const percentComplete = (event.loaded / event.total) * 100;
              setUploadProgress(percentComplete);
            }
          };

          // Completion and error handling
          xhr.onload = () => {
            controllerSignal.removeEventListener('abort', abortHandler);
            if (xhr.status >= 200 && xhr.status < 300) {
              const response = JSON.parse(xhr.responseText);
              if (response.success) {
                resolve(response);
              } else {
                 reject(new Error(response.message || 'Upload failed'));
              }
            } else {
              console.error("File upload failed:", xhr.statusText);
              reject(new Error(xhr.statusText));
            }
          };

          xhr.onerror = () => {
            controllerSignal.removeEventListener('abort', abortHandler);
            console.error("An error occurred during file upload.", xhr.statusText);
            reject(new Error("Network error"));
          };

          xhr.send(formData);
        });

        if (result.success) {
          uploadedFiles = result.files;
        }

      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.log('File upload was aborted.');
        } else {
          console.error("An error occurred during file upload:", error);
        }
        return;
      } finally {
        // Clear the abort controller ref and uploading state
        uploadAbortControllerRef.current = null;
        setIsUploading(false);
        setUploadProgress(0);
      }
    }

    // Send message with text, file info, and goal info
    if (input.trim() || uploadedFiles.length > 0 || selectedGoal) {
      shouldScrollToBottomRef.current = true; // Force scroll to bottom on send
      sendMessage({ text: input, files: uploadedFiles, goal: selectedGoal });
    }

    // Reset inputs
    setInput("");
    setSelectedFiles([]);
    if (onClearSelectedGoal) {
      onClearSelectedGoal();
    }
    if (chatInputRef.current) {
      chatInputRef.current.focus();
    }
  };

  const handleCancel = () => {
    // Cancel the AI response generation
    cancelSendMessage();
    // Abort the file upload if it's in progress
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // --- File Handling ---
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null); // Clear previous errors
    const files = event.target.files;
    if (files && files.length > 0) {
      const newFilesArray = Array.from(files);
      const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0) + newFilesArray.reduce((acc, file) => acc + file.size, 0);
      const oneGB = 1024 * 1024 * 1024;

      if (totalSize > oneGB) {
        setUploadError("合計ファイルサイズが1GBを超えています。");
        // Reset the input value to allow selecting the same file again
        if(fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        return;
      }

      const updatedFiles = [...selectedFiles, ...newFilesArray];
      setSelectedFiles(updatedFiles);
    }
    // Reset the input value to allow selecting the same file again
    if(fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [selectedFiles]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }

    if (imageFiles.length > 0) {
      event.preventDefault();
      setUploadError(null);
      const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0) + imageFiles.reduce((acc, file) => acc + file.size, 0);
      const oneGB = 1024 * 1024 * 1024;

      if (totalSize > oneGB) {
        setUploadError("合計ファイルサイズが1GBを超えています。");
        return;
      }
      
      setSelectedFiles(prevFiles => [...prevFiles, ...imageFiles]);
    }
  }, [selectedFiles]);

  const handleRemoveFile = useCallback((fileToRemove: File) => {
    setUploadError(null); // Clear errors when a file is removed
    setSelectedFiles(prevFiles => prevFiles.filter(file => file !== fileToRemove));
  }, []);

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);


  // --- Scrolling Logic ---
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Handle history fetching on scroll to top
    if (!isFetchingHistory && !historyFinished) {
      const threshold = container.clientHeight * 0.5;
      if (container.scrollTop < threshold) {
        console.log("--- Reached scroll threshold, fetching history ---");
        requestHistory();
      }
    }

    // Update shouldScrollToBottomRef based on user scroll
    const { scrollHeight, scrollTop, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop <= clientHeight + 5; // 5px tolerance
    shouldScrollToBottomRef.current = isAtBottom;

  }, [isFetchingHistory, historyFinished, requestHistory]);

  const listRef = useRef<FixedSizeList>(null);

  // Effect to scroll to bottom when messages change
  useLayoutEffect(() => {
    if (shouldScrollToBottomRef.current && messages.length > 0) {
      listRef.current?.scrollToItem(messages.length - 1, "end");
    }
  }, [messages, activeMessage]); // Dependency on messages and activeMessage

  // Effect to scroll to bottom on initial open
  useEffect(() => {
    if (isOpen || !isFloating) {
      const container = messagesContainerRef.current;
      if (container) {
          // Force scroll to bottom on initial open
          shouldScrollToBottomRef.current = true;
          requestAnimationFrame(() => {
              container.scrollTop = container.scrollHeight;
          });
      }
    }
  }, [isOpen, isFloating]);


  const panelVariants = {
    open: {
      x: 0,
      opacity: 1,
      transition: { type: "spring", stiffness: 300, damping: 30 }
    },
    closed: {
      x: "100%",
      opacity: 0,
      transition: { type: "spring", stiffness: 300, damping: 30 }
    }
  };

  const handleToggleFullScreen = () => {
    if (onMaximizeClick) {
      onMaximizeClick();
    } else if (setIsFullScreen) {
      setIsFullScreen(!isFullScreen);
    }
  };

  const Row = ({ index, style }) => {
    const msg = messages[index];
    // Render tool messages
    if (msg.type === "tool") {
      return (
        <div style={style}>
          <Card key={`${msg.id}-${msg.ts}`} className={cn(
            "tool-card bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-gray-100 rounded-lg p-3 shadow-md",
            "w-11/12 mx-auto my-1 mb-3",
            msg.status === "running" && "tool-card--running",
            msg.status === "finished" && "tool-card--finished border-l-4 border-green-500",
            msg.status === "error" && "tool-card--error border-l-4 border-red-500"
          )}>
            <CardHeader className="flex flex-row items-center justify-between p-0 mb-1">
              <div className="flex items-center space-x-2 flex-shrink min-w-0">
                <span className="tool-card__icon-text text-xs border border-gray-500 dark:border-gray-400 rounded px-1 py-0.5">
                  {getToolIconText(msg.icon)}
                </span>
                <CardTitle className="tool-card__title text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                  {msg.label || "Tool Call"}
                </CardTitle>
              </div>
              <div className="tool-card__line-break"></div>
              <code className="tool-card__command text-xs text-gray-600 dark:text-gray-400 truncate flex-shrink min-w-0">
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
            <CardContent className="p-0 text-sm">
              <pre className="tool-card__body text-xs whitespace-pre-wrap break-words bg-gray-800 dark:bg-gray-900 p-2 rounded not-prose max-h-48 overflow-auto">
                <div className="text-gray-200 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: msg.content }} />
              </pre>
            </CardContent>
          </Card>
        </div>
      );
    } else {
      // Render user/assistant messages
      return (
        <div style={style}>
          <div key={`${msg.id}-${msg.ts}`} className={cn("flex flex-col", msg.role === "user" ? "items-end" : "items-start mx-auto w-[95%]")}>
            {/* File Cards for User Messages */}
            {msg.role === 'user' && msg.goal && (
              <div className="w-full max-w-[65%] flex flex-col items-end mb-4">
                <div className="bg-gray-100 dark:bg-slate-700 rounded-xl p-3 flex items-center space-x-2 text-sm w-auto max-w-full">
                  <Play className="h-5 w-5 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-700 dark:text-gray-300 truncate" title={msg.goal.task}>
                      {msg.goal.task}
                    </p>
                    <p className="text-gray-500 dark:text-gray-400 text-xs">
                      {msg.goal.subject}
                      {msg.goal.tags && msg.goal.tags.length > 0 && ` - ${msg.goal.tags.join(', ')}`}
                    </p>
                  </div>
                </div>
              </div>
            )}
            {msg.role === 'user' && msg.files && msg.files.length > 0 && (
              <div className="w-full max-w-[65%] flex flex-col items-end mb-2">
                <div className="w-full flex flex-col gap-2 items-end">
                  {msg.files.map((file, index) => (
                    <div key={index} className="bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm w-auto max-w-full">
                      <FileIcon className="h-5 w-5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                      <span className="font-medium text-gray-700 dark:text-gray-300 truncate">{file.name}</span>
                      <span className="text-gray-500 dark:text-gray-400 text-xs flex-shrink-0">{formatFileSize(file.size)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Message Bubble */}
            {msg.content && (
              <div
                  className={cn(
                    "prose prose-sm dark:prose-invert",
                    msg.role === "user" ? "ml-auto bg-gray-100 text-gray-900 dark:bg-blue-600 dark:text-white rounded-2xl px-4 py-1 max-w-[65%]" : "w-full",
                  )}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    rehypePlugins={[rehypeRaw]}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
            )}
          </div>
        </div>
      );
    }
  };

  const ChatContent = (
    <>
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
      />
      {isFloating && onClose && (
        <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-700 p-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200">Gemini Chat</h2>
          <div className="flex items-center space-x-2">
            <Button variant="ghost" size="sm" onClick={handleToggleFullScreen} className="p-2">
              {isFullScreen ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} className="p-2">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto max-w-full overflow-x-hidden">
        <div className="p-4 space-y-8 max-w-prose mx-auto pb-16">
        {isFetchingHistory && (
          <div className="flex justify-center items-center py-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
          </div>
        )}
        <FixedSizeList
          ref={listRef}
          height={containerSize.height}
          itemCount={messages.length}
          itemSize={150} // 仮のアイテムサイズ。後で調整します。
          width={containerSize.width}
          onScroll={handleScroll}
        >
          {Row}
        </FixedSizeList>

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
        <div ref={scrollAnchorRef} />
        </div>
      </div>

      <div className="flex-shrink-0 px-4 pt-2 pb-4 flex justify-center">
        <div className="w-full max-w-prose">
            <div className="relative w-[95%] mx-auto flex flex-col rounded-2xl border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-2 transition-colors shadow-lg -mt-10">
              {/* Selected Goal Section */}
              {selectedGoal && (
                <div className="mb-2 p-2 border-b border-gray-200 dark:border-slate-700">
                  <div className="bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm">
                    <Play className="h-5 w-5 text-primary-600 dark:text-primary-400 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-700 dark:text-gray-300 truncate" title={selectedGoal.task}>
                        {selectedGoal.task}
                      </p>
                      <p className="text-gray-500 dark:text-gray-400 text-xs">
                        {selectedGoal.subject}
                        {selectedGoal.tags && selectedGoal.tags.length > 0 && ` - ${selectedGoal.tags.join(', ')}`}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full flex-shrink-0"
                      onClick={onClearSelectedGoal}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              {/* File Preview Section */}
              {selectedFiles.length > 0 && (
                <div className="mb-2 p-2 border-b border-gray-200 dark:border-slate-700">
                  <div className="flex space-x-2 overflow-x-auto">
                    {selectedFiles.map((file, index) => (
                      <div key={index} className={cn(
                        "flex-shrink-0 bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm relative",
                        isUploading && "opacity-50"
                      )}>
                        <FileIcon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                        <span className="font-medium text-gray-700 dark:text-gray-300 truncate max-w-[100px]">{file.name}</span>
                        <span className="text-gray-500 dark:text-gray-400 text-xs">{formatFileSize(file.size)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 rounded-full disabled:pointer-events-none"
                          onClick={() => handleRemoveFile(file)}
                          disabled={isUploading}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                        {isUploading && (
                          <div className="absolute bottom-0 left-0 right-0 h-1">
                            <Progress value={uploadProgress} className="h-1" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Upload Error Message */}
              {uploadError && (
                <div className="mb-2 px-3 py-2 text-xs text-red-700 bg-red-100 border border-red-300 rounded-md flex items-center justify-between dark:bg-red-900/50 dark:text-red-400 dark:border-red-800">
                  <span>{uploadError}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-red-700 hover:bg-red-200"
                    onClick={() => setUploadError(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}

              <Textarea
                ref={chatInputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="システムと対話... (Alt+Enterで送信)"
                className="w-full min-h-0 resize-none border-none bg-transparent outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-gray-400 dark:placeholder:text-gray-500 placeholder:font-light px-2 py-1 text-base"
                rows={1}
                disabled={isUploading}
              />
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-0 text-gray-500 dark:text-gray-400">
                    <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700" onClick={triggerFileSelect} disabled={isUploading}>
                        <Plus className="w-5 h-5" />
                    </Button>
                    <Button variant="ghost" className="h-8 px-3 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-2" disabled={isUploading}>
                        <SlidersHorizontal className="w-4 h-4" />
                        <span className="text-sm font-light">ツール</span>
                    </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400" disabled={isGeneratingResponse || isUploading}>
                    <Mic className="w-5 h-5" />
                  </Button>
                  <Button
                    onClick={(isGeneratingResponse || isUploading) ? handleCancel : handleSendMessage}
                    disabled={!(isGeneratingResponse || isUploading) && !input.trim() && selectedFiles.length === 0}
                    className="w-7 h-7 p-0 flex-shrink-0 bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black rounded-full flex items-center justify-center"
                  >
                    {(isGeneratingResponse || isUploading) ? <Square className="w-2.5 h-2.5" fill="currentColor" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                  </Button>
                </div>
              </div>
            </div>
        </div>
      </div>
    </>
  );

  if (isFloating) {
    return (
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className={cn(
              "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl rounded-2xl flex flex-col z-50",
              isFullScreen 
                ? "fixed inset-0"
                : "fixed bottom-4 right-4 w-96 h-[600px]"
            )}
            variants={panelVariants}
            initial="closed"
            animate="open"
            exit="closed"
          >
            {ChatContent}
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  // Embedded mode
  return (
    <div className="h-full w-full flex flex-col bg-white dark:bg-slate-900 max-w-full overflow-x-hidden">
      {ChatContent}
    </div>
  );
}