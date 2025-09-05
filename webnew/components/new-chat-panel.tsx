// webnew/components/new-chat-panel.tsx
"use client"

import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useOnlineStatus } from "@/hooks/useOnlineStatus"
import { X, Bot, User, CheckCircle, XCircle, Maximize, Minimize, Plus, SlidersHorizontal, Mic, ArrowUp, Square, File as FileIcon, Pause, Globe, FolderPlus } from "lucide-react"
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
import { useIsMobile } from "@/hooks/use-mobile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import TemplateManagerDialog, { ChatTemplate } from '@/components/template-manager';

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
  sendMessage: (messageData: { text: string; files?: FileInfo[]; goal?: Goal | null; session?: any | null; features?: { webSearch?: boolean } }) => void;
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
  // --- Input related props ---
  input,
  setInput,
  // --- File related props ---
  selectedFiles,
  setSelectedFiles,
}: NewChatPanelProps) {
  const isFloating = showAs === 'floating';
  const isMobile = useIsMobile();
  const online = useOnlineStatus();

  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const { toast } = useToast();

  // --- Templates (server-synced; falls back to local on first run) ---
  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
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
  const addTemplate = () => {
    const title = window.prompt('テンプレート名');
    if (!title) return;
    const content = window.prompt('テンプレート本文');
    if (content == null) return;
    let cmd = window.prompt('スラッシュコマンド名（例: /summary）（省略可）') || undefined;
    if (cmd) {
      cmd = cmd.trim();
      if (!cmd.startsWith('/')) cmd = '/' + cmd;
      // 簡易バリデーション: 半角英数と-/のみ
      if (!/^\/[a-zA-Z0-9\-]+$/.test(cmd)) {
        alert('コマンドは \/, 英数字, ハイフンのみ使用できます');
        cmd = undefined;
      } else if (templates.some(t => t.cmd === cmd)) {
        alert('同じコマンドが既に存在します');
        cmd = undefined;
      }
    }
    const t: Template = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, content, cmd };
    const list = [t, ...templates].slice(0, 50);
    saveTemplates(list);
    toast({ description: 'テンプレートを追加しました' });
  };
  const insertTemplate = (t: ChatTemplate) => {
    setInput((prev) => (prev ? prev + "\n" + t.content : t.content));
  };

  // --- Tool actions / flags ---
  const [webSearchFlag, setWebSearchFlag] = useState(false);
  const enableWebSearch = () => {
    setWebSearchFlag(true);
    toast({ description: 'Web検索を有効化しました' });
  };
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
  const shouldSendMessageOnEndRef = useRef(false);
  const [needsToSend, setNeedsToSend] = useState(false);

  // --- Slash command suggestions ---
  type SlashItem = { cmd: string; label: string; action?: () => void; replaceWith?: string };
  const baseSlash: SlashItem[] = useMemo(() => ([
    { cmd: '/web', label: 'Web検索を有効化', action: () => setWebSearchFlag(true), replaceWith: '' },
    { cmd: '/clear', label: '履歴をクリア', replaceWith: '/clear' },
    { cmd: '/debug', label: 'アプリ内ログを表示/切替', action: () => { try { const cur = localStorage.getItem('app.debug.console') === '1'; localStorage.setItem('app.debug.console', cur ? '0' : '1'); location.reload(); } catch {} }, replaceWith: '' },
  ]), []);
  const templateSlash: SlashItem[] = useMemo(() => (
    templates
      .filter(t => t.cmd && t.cmd.startsWith('/'))
      .map(t => ({
        cmd: t.cmd!,
        label: t.title,
        // スラッシュ選択時はその場に本文を挿入（コマンドは残さない）
        replaceWith: t.content,
      }))
  ), [templates]);
  const slashItems: SlashItem[] = useMemo(() => ([...baseSlash, ...templateSlash]), [baseSlash, templateSlash]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const filteredSlashRaw = slashItems.filter(i => i.cmd.startsWith('/' + slashQuery) || i.label.includes(slashQuery));
  const filteredSlash = useMemo(() => {
    const seen = new Set<string>();
    const out: SlashItem[] = [];
    for (const it of filteredSlashRaw) {
      if (!it.cmd) continue;
      if (seen.has(it.cmd)) continue;
      seen.add(it.cmd);
      out.push(it);
    }
    return out;
  }, [filteredSlashRaw]);

  const replaceCurrentToken = (text: string) => {
    const ta = chatInputRef.current; if (!ta) return;
    const pos = ta.selectionStart ?? (input?.length || 0);
    const before = (input ?? '').slice(0, pos);
    const after = (input ?? '').slice(pos);
    // token start = last whitespace before caret
    const m = before.match(/(^|[\s\n\t])[^\s\n\t]*$/);
    const tokenStart = m ? before.length - (m[0].trim().length) : before.length;
    const head = (input ?? '').slice(0, tokenStart);
    const newVal = head + text + after;
    setInput(newVal);
    // move caret to end of inserted text
    requestAnimationFrame(() => {
      if (chatInputRef.current) {
        const np = (head + text).length;
        chatInputRef.current.selectionStart = chatInputRef.current.selectionEnd = np;
        chatInputRef.current.focus();
      }
    });
  };

  const tryUpdateSlash = (val: string) => {
    const ta = chatInputRef.current; if (!ta) { setSlashOpen(false); return; }
    const pos = ta.selectionStart ?? val.length;
    const before = val.slice(0, pos);
    const token = before.split(/\s|\n|\t/).pop() || '';
    if (token.startsWith('/')) {
      setSlashOpen(true);
      setSlashQuery(token.slice(1));
      setSlashIndex(0);
    } else {
      setSlashOpen(false);
    }
  };

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
  }, [input, interimTranscript]);

  const handleSendMessage = useCallback(async () => {
    if (!online) {
      toast({ description: 'オフラインです。接続後に再試行してください。' });
      return;
    }
    // If recording, stop it. The onend event will trigger the send.
    if (isRecording) {
      shouldSendMessageOnEndRef.current = true;
      recognitionRef.current?.stop();
      return;
    }

    // If not recording, send immediately.
    const finalMessage = (input + interimTranscript).trim();

    // Clear inputs immediately
    setInput('');
    setInterimTranscript('');

    if (!finalMessage && selectedFiles.length === 0) {
      // If there's nothing to send, just return.
      return;
    }

    // /clear コマンドの処理
    if (finalMessage === '/clear') {
      clearMessages();
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
    if (finalMessage || uploadedFiles.length > 0 || selectedGoal || selectedSession) {
      shouldScrollToBottomRef.current = true; // Force scroll to bottom on send
      const features = webSearchFlag ? { webSearch: true } : undefined;
      sendMessage({ text: finalMessage, files: uploadedFiles, goal: selectedGoal, session: selectedSession, features });
      if (webSearchFlag) setWebSearchFlag(false);
    }

    // Reset other states
    setSelectedFiles([]);
    if (onClearSelectedGoal) {
      onClearSelectedGoal();
    }
    if (onClearSelectedSession) {
      onClearSelectedSession();
    }

    if (chatInputRef.current) {
      if (isMobile) {
        chatInputRef.current.blur();
      } else {
        chatInputRef.current.focus();
      }
    }
    
  }, [online, toast, isRecording, input, interimTranscript, selectedFiles, selectedGoal, selectedSession, clearMessages, sendMessage, setInput, setInterimTranscript, setSelectedFiles, onClearSelectedGoal, onClearSelectedSession, isMobile]);

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

  // Effect to scroll to bottom when messages (including tool cards) change
  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    // Re-evaluate bottom proximity on every change
    const { scrollHeight, scrollTop, clientHeight } = container;
    const NEAR_BOTTOM_TOLERANCE = 24; // px
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

  // Effect to send message when triggered from recognition.onend
  useEffect(() => {
    if (needsToSend) {
      // The regular handleSendMessage function will handle the logic
      // for sending, as isRecording will be false.
      handleSendMessage();
      setNeedsToSend(false); // Reset the trigger
    }
  }, [needsToSend, handleSendMessage]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'ja-JP';

      recognition.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }

        setInterimTranscript(interim);

        if (final) {
          setInput(prevInput => prevInput ? prevInput + ' ' + final : prevInput + final);
          setInterimTranscript(''); // Clear interim when final is received
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
        if (shouldSendMessageOnEndRef.current) {
          shouldSendMessageOnEndRef.current = false;
          setNeedsToSend(true); // Trigger the send effect
        }
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
      };
      
      recognitionRef.current = recognition;
    }

    return () => {
        if (recognitionRef.current) {
            recognitionRef.current.onend = null; // prevent onend from firing on unmount
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }
    }
  }, [setInput]);


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

  const handleMicClick = () => {
    if (!recognitionRef.current) return;

    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      setInterimTranscript(''); // Clear previous interim results
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (error) {
        console.error("Speech recognition could not start: ", error);
      }
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

      {/* Removed inline offline banner per user request. Page header + input notice are sufficient. */}

      <div ref={messagesContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto max-w-full overflow-x-hidden">
        <div className="p-4 space-y-8 max-w-prose mx-auto pb-16">
          {isFetchingHistory && (
            <div className="flex justify-center items-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100"></div>
            </div>
          )}

          {useMemo(() => {
            // サーバー到着順（useChat内の配列順）を維持する。アクティブなストリームはタイムライン内（messages）に反映。
            return [...(messages || [])];
          }, [messages]).map((msg: any, idx: number) => {
            // ツールカード（role===tool も許容）
            if (msg.type === "tool" || msg.role === "tool") {
              return (
                <Card key={`${msg.id}-${idx}`} className={cn(
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
                    <div className="tool-card__body text-xs whitespace-pre font-mono bg-gray-800 dark:bg-gray-900 p-2 rounded not-prose max-h-48 overflow-y-auto overflow-x-auto">
                      <div className="text-gray-200 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: msg.content }} />
                    </div>
                  </CardContent>
                </Card>
              );
            }

            // 通常メッセージ（ユーザー/アシスタント/ストリーミング中）
            return (
              <div key={`${msg.id}-${idx}`} className={cn("flex flex-col", msg.role === "user" ? "items-end" : "items-start mx-auto w-[95%]")}>
                {msg.content && (
                  <div
                    className={cn(
                      "prose prose-sm dark:prose-invert",
                      msg.role === "user"
                        ? "ml-auto bg-gray-100 text-gray-900 dark:bg-blue-600 dark:text-white rounded-2xl px-4 py-1 max-w-[65%]"
                        : "w-full",
                      msg.thoughtMode && "animate-pulse"
                    )}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            );
          })}

          {/* 統合済みのため、activeMessage の別描画ブロックは削除 */}
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

              {/* Selected Session Section */}
              {selectedSession && (
                <div className="mb-2 p-2 border-b border-gray-200 dark:border-slate-700">
                  <div className="bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm">
                    {selectedSession.type === "START" && <Play className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />}
                    {selectedSession.type === "BREAK" && <Pause className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />}
                    {selectedSession.type === "RESUME" && <Play className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-700 dark:text-gray-300 truncate" title={selectedSession.content || "休憩"}>
                        {selectedSession.content || "休憩"}
                      </p>
                      <p className="text-gray-500 dark:text-gray-400 text-xs">
                        {selectedSession.start_time} ({selectedSession.duration_minutes}分)
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-full flex-shrink-0"
                      onClick={onClearSelectedSession}
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

              {/* Offline notice inside input area */}
              {!online && (
                <div className="mb-2 px-3 py-2 text-xs text-yellow-800 bg-yellow-100 border border-yellow-300 rounded-md flex items-center gap-2">
                  <XCircle className="h-4 w-4" />
                  <span>オフラインです。接続後に送信してください。</span>
                </div>
              )}

              <Textarea
                ref={chatInputRef}
                value={input + interimTranscript}
                onChange={(e) => {
                  setInput(e.target.value)
                  // Stop recognition if user types
                  if (isRecording) {
                    recognitionRef.current?.stop();
                  }
                  tryUpdateSlash(e.target.value)
                }}
                onKeyDown={(e) => {
                  // Slash menu keyboard handling
                  if (slashOpen) {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, Math.max(0, filteredSlash.length - 1))); return; }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
                    if (e.key === 'Escape') { setSlashOpen(false); return; }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault();
                      const sel = filteredSlash[slashIndex];
                      if (sel) {
                        if (sel.action) sel.action();
                        replaceCurrentToken(sel.replaceWith ?? sel.cmd);
                      }
                      setSlashOpen(false);
                      return;
                    }
                  }
                  handleKeyDown(e);
                }}
                onPaste={handlePaste}
                placeholder={online ? "システムと対話... (Alt+Enterで送信)" : "オフライン中は送信できません"}
                className="w-full min-h-0 resize-none border-none bg-transparent outline-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-gray-400 dark:placeholder:text-gray-500 placeholder:font-light px-2 py-1 text-base"
                rows={1}
                disabled={isUploading || !online}
              />
              {slashOpen && filteredSlash.length > 0 && (
                <div className="absolute -top-2 translate-y-[-100%] left-2 z-50 w-64 rounded-md border bg-popover text-popover-foreground shadow-md">
                  <ul className="py-1 max-h-60 overflow-auto">
                    {filteredSlash.map((it, idx) => (
                      <li key={it.cmd}
                          className={cn('px-3 py-2 text-sm cursor-pointer flex items-center gap-2', idx === slashIndex ? 'bg-slate-100 dark:bg-slate-700' : 'hover:bg-slate-100 dark:hover:bg-slate-700')}
                          onMouseEnter={() => setSlashIndex(idx)}
                          onMouseDown={(e) => { e.preventDefault(); }}
                          onClick={() => { if (it.action) it.action(); replaceCurrentToken(it.replaceWith ?? it.cmd); setSlashOpen(false); }}
                      >
                        <span className="font-mono text-sky-700 dark:text-sky-400">{it.cmd}</span>
                        <span className="text-slate-600 dark:text-slate-300">{it.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex items-center justify-between mt-2">
                <div className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
                    <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700" onClick={triggerFileSelect} disabled={isUploading || !online}>
                        <Plus className="w-5 h-5" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 px-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-1" disabled={isUploading || !online}>
                          <SlidersHorizontal className="w-4 h-4" />
                          <span className="text-sm font-light">ツール</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-64 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl">
                        <DropdownMenuItem onClick={enableWebSearch}>
                          <Globe className="w-4 h-4 mr-2" /> Web検索
                        </DropdownMenuItem>
                        {isMobile ? (
                          <DropdownMenuItem onClick={() => setTemplatePickerOpen(true)}>
                            <FolderPlus className="w-4 h-4 mr-2" /> テンプレート
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <FolderPlus className="w-4 h-4 mr-2" /> テンプレート
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-80 max-h-[60vh] overflow-auto bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl">
                              {templates.length === 0 && (
                                <DropdownMenuItem onClick={() => setTemplateManagerOpen(true)}>テンプレートを追加…</DropdownMenuItem>
                              )}
                              {templates.map(t => (
                                <DropdownMenuItem key={t.id} onClick={() => insertTemplate(t)} title={t.content}>
                                  <div className="flex items-center gap-2">
                                    <span>{t.title}</span>
                                    {t.cmd && <span className="text-xs font-mono text-slate-500">{t.cmd}</span>}
                                  </div>
                                </DropdownMenuItem>
                              ))}
                              {templates.length > 0 && <DropdownMenuSeparator />}
                              <DropdownMenuItem onClick={() => setTemplateManagerOpen(true)}>テンプレートを管理…</DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>その他</DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-64 max-h-[60vh] overflow-auto bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl">
                            <DropdownMenuItem onClick={() => {
                              if (confirm('会話履歴をクリアします。よろしいですか？')) {
                                clearMessages();
                              }
                            }}>履歴をクリア…</DropdownMenuItem>
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {webSearchFlag && (
                      <div className={cn(
                        "relative inline-flex items-center h-8 px-3 rounded-full select-none cursor-default text-sm font-light",
                        "pr-6 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                      )}>
                        <span className="inline-flex items-center"><Globe className="w-4 h-4 mr-1" /></span>
                        <span>Web検索</span>
                        <button
                          type="button"
                          aria-label="Web検索無効化"
                          className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-slate-200/70 dark:hover:bg-slate-600/70"
                          onClick={(e) => { e.stopPropagation(); setWebSearchFlag(false); }}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-500 dark:text-gray-400",
                      isRecording && "bg-red-500/20 text-red-500 hover:bg-red-500/30 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30"
                    )}
                    disabled={isGeneratingResponse || isUploading || !online}
                    onClick={handleMicClick}
                  >
                    <Mic className="w-5 h-5" />
                  </Button>
                  <Button
                    onClick={(isGeneratingResponse || isUploading) ? handleCancel : handleSendMessage}
                    disabled={
                      (isGeneratingResponse || isUploading)
                        ? false // 生成中・アップロード中はキャンセルボタンとして常に有効
                        : (!online || (!input.trim() && !interimTranscript.trim() && selectedFiles.length === 0)) // オフラインまたは入力なしで無効
                    }
                    className="w-7 h-7 p-0 flex-shrink-0 bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black rounded-full flex items-center justify-center"
                  >
                    {(isGeneratingResponse || isUploading) ? <Square className="w-2.5 h-2.5" fill="currentColor" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                  </Button>
                </div>
              </div>
            </div>
        </div>
      </div>
      {/* Mobile Template Picker (Bottom Sheet) */}
      <Sheet open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <SheetContent side="bottom" className="h-[75vh] p-0">
          <SheetHeader className="px-4 pt-4">
            <SheetTitle>テンプレート</SheetTitle>
          </SheetHeader>
          <div className="px-2 pb-4 overflow-auto max-h-[calc(75vh-3rem)]">
            {templates.length === 0 ? (
              <div className="text-sm text-slate-500 px-2 py-4">テンプレートはまだありません。</div>
            ) : (
              <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                {templates.map(t => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className="w-full text-left px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between"
                      onClick={() => { insertTemplate(t); setTemplatePickerOpen(false); }}
                    >
                      <span className="truncate mr-2">{t.title}</span>
                      {t.cmd && <span className="text-xs font-mono text-slate-500">{t.cmd}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="px-4 py-3">
              <Button className="w-full" variant="secondary" onClick={() => { setTemplatePickerOpen(false); setTemplateManagerOpen(true); }}>テンプレートを管理…</Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
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
        {/* Keep manager dialog outside AnimatePresence to avoid key issues */}
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
