// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { X, Bot, User, CheckCircle, XCircle, Maximize, Minimize, Plus, SlidersHorizontal, Mic, ArrowUp, Square, File as FileIcon } from "lucide-react"
import { Progress } from "@/components/ui/progress";
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

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};


export function NewChatPanel({ isOpen, onClose, isFullScreen, setIsFullScreen }: NewChatPanelProps) {
  const [input, setInput] = useState("")
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const { messages, activeMessage, isGeneratingResponse, sendMessage, cancelSendMessage, requestHistory, isFetchingHistory, historyFinished } = useChat();

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null); // Ref for the scroll anchor

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
            console.error("An error occurred during file upload.");
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

    // Send message with text and file info
    if (input.trim() || uploadedFiles.length > 0) {
      sendMessage({ text: input, files: uploadedFiles });
      scrollBottom(true); // Force scroll to bottom on send
    }

    // Reset inputs
    setInput("");
    setSelectedFiles([]);
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
    if (!container || isFetchingHistory || historyFinished) return;

    // Threshold: 1.5 times the container's client height from the top
    const threshold = container.clientHeight * 0.5;

    if (container.scrollTop < threshold) {
      console.log("--- Reached scroll threshold, fetching history ---");
      requestHistory();
    }
  }, [isFetchingHistory, historyFinished, requestHistory]);


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
      // Use requestAnimationFrame to ensure scrolling happens after the DOM has been updated.
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [isNearBottom]);

  const prevMessagesLength = useRef(messages.length);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const isNewMessageAdded = messages.length > prevMessagesLength.current;
    const isActiveMessageUpdating = !!activeMessage;

    if (!isFetchingHistory && (isNewMessageAdded || isActiveMessageUpdating)) {
      if (isNearBottom()) {
        scrollBottom(true);
      }
    }

    prevMessagesLength.current = messages.length;
  }, [messages, activeMessage, isFetchingHistory, isNearBottom, scrollBottom]);

  // Initial history load and scroll to bottom
  useEffect(() => {
    if (isOpen) {
      scrollBottom(true); // Force scroll to bottom on initial open
    }
  }, [isOpen, scrollBottom]);


  if (!isOpen) return null

  return (
    <div className={cn(
      "bg-white border border-slate-200 shadow-2xl rounded-2xl flex flex-col z-50",
      isFullScreen 
        ? "fixed inset-0"
        : "fixed bottom-4 right-4 w-96 h-[600px]"
    )}>
      <input
        type="file"
        multiple
        ref={fileInputRef}
        onChange={handleFileSelect}
        className="hidden"
      />
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

      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto"> {/* Added ref and onScroll here */}
        <div className="p-4 space-y-8 max-w-prose mx-auto pb-16">
        {isFetchingHistory && (
          <div className="flex justify-center items-center py-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          </div>
        )}
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
              <div key={msg.id} className={cn("flex flex-col", msg.role === "user" ? "items-end" : "items-start mx-auto w-[95%]")}>
                {/* File Cards for User Messages */}
                {msg.role === 'user' && msg.files && msg.files.length > 0 && (
                  <div className="w-full max-w-[65%] flex flex-col items-end mb-2">
                    <div className="w-full flex flex-col gap-2 items-end">
                      {msg.files.map((file, index) => (
                        <div key={index} className="bg-gray-100 rounded-lg p-2 flex items-center space-x-2 text-sm w-auto max-w-full">
                          <FileIcon className="h-5 w-5 text-gray-500 flex-shrink-0" />
                          <span className="font-medium text-gray-700 truncate">{file.name}</span>
                          <span className="text-gray-500 text-xs flex-shrink-0">{formatFileSize(file.size)}</span>
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
                        msg.role === "user" ? "ml-auto bg-gray-100 text-gray-900 rounded-2xl px-4 py-1 max-w-[65%]" : "w-full",
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

      <div className="flex-shrink-0 px-4 pt-2 pb-4 flex justify-center">
        <div className="w-full max-w-prose">
            <div className="relative w-[95%] mx-auto flex flex-col rounded-2xl border border-gray-300 bg-white p-2 transition-colors shadow-lg -mt-10">
              {/* File Preview Section */}
              {selectedFiles.length > 0 && (
                <div className="mb-2 p-2 border-b border-gray-200">
                  <div className="flex space-x-2 overflow-x-auto">
                    {selectedFiles.map((file, index) => (
                      <div key={index} className={cn(
                        "flex-shrink-0 bg-gray-100 rounded-lg p-2 flex items-center space-x-2 text-sm relative", // Added relative positioning
                        isUploading && "opacity-50"
                      )}>
                        <FileIcon className="h-5 w-5 text-gray-500" />
                        <span className="font-medium text-gray-700 truncate max-w-[100px]">{file.name}</span>
                        <span className="text-gray-500 text-xs">{formatFileSize(file.size)}</span>
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
                <div className="mb-2 px-3 py-2 text-xs text-red-700 bg-red-100 border border-red-300 rounded-md flex items-center justify-between">
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
                placeholder="システムと対話... (Alt+Enterで送信)"
                className="w-full min-h-0 resize-none border-none bg-transparent outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-gray-400 placeholder:font-light px-2 py-1"
                rows={1}
                disabled={isGeneratingResponse || isUploading}
              />
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-0 text-gray-500">
                    <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full hover:bg-gray-100" onClick={triggerFileSelect} disabled={isGeneratingResponse || isUploading}>
                        <Plus className="w-5 h-5" />
                    </Button>
                    <Button variant="ghost" className="h-8 px-3 rounded-full hover:bg-gray-100 flex items-center gap-2" disabled={isGeneratingResponse || isUploading}>
                        <SlidersHorizontal className="w-4 h-4" />
                        <span className="text-sm font-light">ツール</span>
                    </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full hover:bg-gray-100 text-gray-500" disabled={isGeneratingResponse || isUploading}>
                    <Mic className="w-5 h-5" />
                  </Button>
                  <Button
                    onClick={(isGeneratingResponse || isUploading) ? handleCancel : handleSendMessage}
                    disabled={!(isGeneratingResponse || isUploading) && !input.trim() && selectedFiles.length === 0}
                    className="w-7 h-7 p-0 flex-shrink-0 bg-black hover:bg-gray-800 text-white rounded-full flex items-center justify-center"
                  >
                    {(isGeneratingResponse || isUploading) ? <Square className="w-2.5 h-2.5" fill="white" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                  </Button>
                </div>
              </div>
            </div>
        </div>
      </div>
    </div>
  )
}
