"use client"

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { useOnlineStatus } from "@/hooks/useOnlineStatus"
import { Paperclip, X, Send, MessageSquare, Code, Bot, User, File as FileIcon, Maximize, Minimize, CheckCircle, XCircle, SlidersHorizontal, Play, Pause } from 'lucide-react';
import { cn } from "@/lib/utils"
import { MessageList } from "@/components/chat/MessageList"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import remarkBreaks from "remark-breaks";
import { motion, AnimatePresence } from "framer-motion";
import { useIsMobile } from "@/hooks/use-mobile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import TemplateManagerDialog, { ChatTemplate } from '@/components/template-manager';
import ChatInput from './chat-input'; // Import the new component

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
  session?: any | null;
  type?: 'text' | 'tool';
  toolCallId?: string;
  status?: 'running' | 'finished' | 'error';
  icon?: string;
  label?: string;
  command?: string;
  cmdKey?: string;
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
  // --- Session related props ---
  selectedSession?: any | null;
  onClearSelectedSession?: () => void;
  // --- useChat related props ---
  messages: Message[];
  activeMessage: ActiveMessage | null;
  isGeneratingResponse: boolean;
  sendMessage: (messageData: { text: string; files?: FileInfo[]; goal?: Goal | null; session?: any | null; features?: { webSearch?: boolean } }) => boolean;
  cancelSendMessage: () => void;
  requestHistory: (isInitialLoad?: boolean) => void;
  isFetchingHistory: boolean;
  historyFinished: boolean;
  clearMessages: () => void;
  refreshChat: () => boolean;
  handoverSnapshot: () => boolean;
  // tool approvals (optional)
  sendToolApproval?: (toolCallId: string, decision: 'allow_once'|'allow_always'|'deny'|'deny_always') => void;
  // --- Input related props ---
  input: string;
  setInput: (input: string) => void;
  // --- File related props ---
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
  // --- Lock input while notification decision is running ---
  inputLocked?: boolean;
  lockMessage?: string;
}

const PROJECT_ROOT_HINT = process.env.NEXT_PUBLIC_PROJECT_ROOT?.replace(/\\/g, '/') || '';
const PROJECT_ROOT_BASENAME = process.env.NEXT_PUBLIC_PROJECT_ROOT_BASENAME || 'GeminiCLI';

function stripRootPrefix(pathname: string, root: string): string | null {
  if (!root) return null;
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  if (pathname.startsWith(normalizedRoot)) {
    return pathname.slice(normalizedRoot.length);
  }
  return null;
}

function getRelativePath(absolutePath?: string) {
  if (!absolutePath) return '';
  const normalized = absolutePath.replace(/\\/g, '/');
  const fromHint = stripRootPrefix(normalized, PROJECT_ROOT_HINT);
  if (fromHint !== null) return fromHint;
  const marker = `/${PROJECT_ROOT_BASENAME}/`;
  const idx = normalized.indexOf(marker);
  if (idx !== -1) {
    return normalized.slice(idx + marker.length);
  }
  return normalized;
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
  selectedSession,
  onClearSelectedSession,
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
  refreshChat,
  handoverSnapshot,
  sendToolApproval,
  // --- Input related props ---
  input,
  setInput,
  // --- File related props ---
  selectedFiles,
  setSelectedFiles,
  inputLocked,
  lockMessage,
}: NewChatPanelProps) {
  const isFloating = showAs === 'floating';
  const isMobile = useIsMobile();
  const online = useOnlineStatus();

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const { toast } = useToast();
  const formatCmdKey = useCallback((key?: string, command?: string): string | null => {
    try {
      const k0 = key ? String(key) : '';
      const cmd = command ? String(command) : '';
      const hasManage = /(^|[\/])manage_log\.py(\s|$)/.test(cmd);
      if (hasManage) {
        if (k0 === 'python3' || k0 === 'python' || k0 === 'shell:python3') {
          return (k0.includes('python3') ? 'python3' : 'python') + ': manage_log.py';
        }
        if (k0 === 'python3:manage_log' || k0 === 'python:manage_log') return k0.replace(':manage_log', ': manage_log.py');
      }
      if (!k0) return null;
      if (k0.includes(':')) return k0.replace(':', ': ');
      return k0;
    } catch {
      return key ?? null;
    }
  }, []);

  // --- Templates (server-synced; falls back to local on first run) ---
  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings?keys=chat.templates.v1', { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          const v = data?.settings?.['chat.templates.v1'];
          if (v) {
            try {
              if (Array.isArray(v)) {
                setTemplates(v);
              } else if (typeof v === 'string') {
                setTemplates(JSON.parse(v));
              } else {
                setTemplates([]);
              }
            } catch { setTemplates([]); }
          } else {
            // migrate from localStorage if any
            try {
              const raw = localStorage.getItem('chat.templates.v1');
              if (raw) {
                const arr = JSON.parse(raw);
                setTemplates(arr);
                await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'chat.templates.v1', value: arr })});
              }
            } catch {}
          }
        }
      } catch {}
    })();
  }, []);

  const saveTemplates = async (list: ChatTemplate[]) => {
    setTemplates(list);
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'chat.templates.v1', value: list })});
    } catch {}
    try { localStorage.setItem('chat.templates.v1', JSON.stringify(list)); } catch {}
  };

  const insertTemplate = (t: ChatTemplate) => {
    setInput((prev) => (prev ? prev + "\n" + t.content : t.content));
  };

  // --- Tool actions / flags ---
  const [webSearchFlag, setWebSearchFlag] = useState(false);

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const shouldScrollToBottomRef = useRef(true);

  const handleSendMessage = useCallback(async (finalMessage?: string) => {
    if (!online) {
      toast({ description: 'オフラインです。接続後に再試行してください。' });
      return;
    }

    const message = (finalMessage !== undefined ? finalMessage : input).trim();

    if (!message && selectedFiles.length === 0) {
      return;
    }

    if (message === '/clear') {
      setInput('');
      clearMessages();
      setSelectedFiles([]);
      return;
    }

    if (message === '/refresh') {
      const ok = refreshChat();
      if (ok) {
        setInput('');
        setSelectedFiles([]);
        if (onClearSelectedGoal) onClearSelectedGoal();
        if (onClearSelectedSession) onClearSelectedSession();
      } else {
        toast({ description: '接続準備中です。数秒後にもう一度お試しください。' });
      }
      return;
    }

    if (message === '/handover') {
      const ok = handoverSnapshot();
      if (ok) {
        setInput('');
        setSelectedFiles([]);
        if (onClearSelectedGoal) onClearSelectedGoal();
        if (onClearSelectedSession) onClearSelectedSession();
      } else {
        toast({ description: '接続準備中です。数秒後にもう一度お試しください。' });
      }
      return;
    }

    let uploadedFiles: { name: string, path: string, size: number }[] = [];

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

          const abortHandler = () => {
            xhr.abort();
            reject(new DOMException('Aborted', 'AbortError'));
          };
          controllerSignal.addEventListener('abort', abortHandler);

          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const percentComplete = (event.loaded / event.total) * 100;
              setUploadProgress(percentComplete);
            }
          };

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
        uploadAbortControllerRef.current = null;
        setIsUploading(false);
        setUploadProgress(0);
      }
    }

    let sentOk = false;
    if (message || uploadedFiles.length > 0 || selectedGoal || selectedSession) {
      shouldScrollToBottomRef.current = true;
      const features = webSearchFlag ? { webSearch: true } : undefined;
      sentOk = sendMessage({ text: message, files: uploadedFiles, goal: selectedGoal, session: selectedSession, features });
      if (webSearchFlag) setWebSearchFlag(false);
    }

    if (sentOk) {
      setInput('');
      setSelectedFiles([]);
      if (onClearSelectedGoal) onClearSelectedGoal();
      if (onClearSelectedSession) onClearSelectedSession();
    } else {
      toast({ description: '接続準備中です。数秒後にもう一度お試しください。' });
    }
    
  }, [online, toast, input, selectedFiles, selectedGoal, selectedSession, clearMessages, refreshChat, handoverSnapshot, sendMessage, setInput, setSelectedFiles, onClearSelectedGoal, onClearSelectedSession, webSearchFlag]);

  const handleCancel = () => {
    cancelSendMessage();
    if (uploadAbortControllerRef.current) {
      uploadAbortControllerRef.current.abort();
    }
  };

  // --- Scrolling Logic ---
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    if (!isFetchingHistory && !historyFinished) {
      const threshold = container.clientHeight * 0.5;
      if (container.scrollTop < threshold) {
        console.log("--- Reached scroll threshold, fetching history ---");
        requestHistory();
      }
    }

    const { scrollHeight, scrollTop, clientHeight } = container;
    const isAtBottom = scrollHeight - scrollTop <= clientHeight + 5;
    shouldScrollToBottomRef.current = isAtBottom;

  }, [isFetchingHistory, historyFinished, requestHistory]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const { scrollHeight, scrollTop, clientHeight } = container;
    const NEAR_BOTTOM_TOLERANCE = 24;
    const nearBottom = scrollHeight - scrollTop <= clientHeight + NEAR_BOTTOM_TOLERANCE;
    if (nearBottom) {
      shouldScrollToBottomRef.current = true;
    }
    if (shouldScrollToBottomRef.current) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }, [messages, activeMessage]);

  useEffect(() => {
    const handler = () => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const { scrollHeight, scrollTop, clientHeight } = container;
      const NEAR_BOTTOM_TOLERANCE = 24;
      const nearBottom = scrollHeight - scrollTop <= clientHeight + NEAR_BOTTOM_TOLERANCE;
      shouldScrollToBottomRef.current = nearBottom;
    };
    window.addEventListener('chat:pre-mutate', handler as any);
    return () => window.removeEventListener('chat:pre-mutate', handler as any);
  }, []);

  useEffect(() => {
    if (isOpen || !isFloating) {
      const container = messagesContainerRef.current;
      if (container) {
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
      transition: { type: "tween", duration: 0.24, ease: "easeOut" }
    },
    closed: {
      x: "100%",
      opacity: 0,
      transition: { type: "tween", duration: 0.18, ease: "easeIn" }
    }
  };

  const handleToggleFullScreen = () => {
    if (onMaximizeClick) {
      onMaximizeClick();
    } else if (setIsFullScreen) {
      setIsFullScreen(!isFullScreen);
    }
  };

  const ChatContent = (
    <>
      {isFloating && onClose && (
        <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-700 p-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-200">{process.env.NEXT_PUBLIC_CHAT_TITLE || 'AI Chat'}</h2>
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

          <MessageList
      messages={messages as any}
      tools={{ getToolIconText, getRelativePath, formatFileSize, formatCmdKey, sendToolApproval }}
    />
          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <ChatInput
        input={input}
        setInput={setInput}
        handleSendMessage={handleSendMessage}
        handleCancel={handleCancel}
        isGeneratingResponse={isGeneratingResponse}
        isUploading={isUploading}
        online={online}
        inputLocked={inputLocked}
        lockMessage={lockMessage}
        selectedFiles={selectedFiles}
        setSelectedFiles={setSelectedFiles}
        uploadProgress={uploadProgress}
        selectedGoal={selectedGoal}
        onClearSelectedGoal={onClearSelectedGoal}
        selectedSession={selectedSession}
        onClearSelectedSession={onClearSelectedSession}
        templates={templates}
        insertTemplate={insertTemplate}
        setTemplateManagerOpen={setTemplateManagerOpen}
        webSearchFlag={webSearchFlag}
        setWebSearchFlag={setWebSearchFlag}
        isMobile={isMobile}
        clearMessages={clearMessages}
      />
    </>
  );

  if (isFloating) {
    return (
      <>
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key="chat-panel"
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
        <TemplateManagerDialog
          open={templateManagerOpen}
          onOpenChange={setTemplateManagerOpen}
          templates={templates}
          onChange={(list) => saveTemplates(list)}
        />
      </>
    );
  }

  // Embedded mode
  return (
    <div className="h-full w-full flex flex-col bg-white dark:bg-slate-900 max-w-full overflow-x-hidden">
      {ChatContent}
      <TemplateManagerDialog
        open={templateManagerOpen}
        onOpenChange={setTemplateManagerOpen}
        templates={templates}
        onChange={(list) => saveTemplates(list)}
      />
    </div>
  );
}
