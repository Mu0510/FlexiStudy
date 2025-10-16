"use client"

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X, Mic, ArrowUp, Square, Plus, SlidersHorizontal, Globe, FolderPlus, File as FileIcon, Play, Pause, XCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/use-toast";
import { ChatTemplate } from '@/components/template-manager';

// Interfaces from NewChatPanelProps that are relevant to ChatInput
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

interface Session {
    type: 'START' | 'BREAK' | 'RESUME';
    content: string;
    start_time: string;
    duration_minutes: number;
}

// Helper function to format file size
const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

interface ChatInputProps {
  input: string;
  setInput: (input: string) => void;
  handleSendMessage: (message?: string) => void;
  handleCancel: () => void;
  isGeneratingResponse: boolean;
  isUploading: boolean;
  online: boolean;
  inputLocked?: boolean;
  lockMessage?: string;
  selectedFiles: File[];
  setSelectedFiles: (files: File[]) => void;
  uploadProgress: number;
  selectedGoal?: Goal | null;
  onClearSelectedGoal?: () => void;
  selectedSession?: Session | null;
  onClearSelectedSession?: () => void;
  templates: ChatTemplate[];
  insertTemplate: (template: ChatTemplate) => void;
  setTemplateManagerOpen: (open: boolean) => void;
  webSearchFlag: boolean;
  setWebSearchFlag: (flag: boolean) => void;
  isMobile: boolean;
  clearMessages: () => void;
}

const ChatInput = React.memo(({
  input,
  setInput,
  handleSendMessage,
  handleCancel,
  isGeneratingResponse,
  isUploading,
  online,
  inputLocked,
  lockMessage,
  selectedFiles,
  setSelectedFiles,
  uploadProgress,
  selectedGoal,
  onClearSelectedGoal,
  selectedSession,
  onClearSelectedSession,
  templates,
  insertTemplate,
  setTemplateManagerOpen,
  webSearchFlag,
  setWebSearchFlag,
  isMobile,
  clearMessages,
}: ChatInputProps) => {
  const { toast } = useToast();
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldSendMessageOnEndRef = useRef(false);
  const [needsToSend, setNeedsToSend] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const slashUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // --- Slash command suggestions ---
  type SlashItem = { cmd: string; label: string; action?: () => void; replaceWith?: string };
  const baseSlash: SlashItem[] = useMemo(() => ([
    { cmd: '/web', label: 'Web検索を有効化', action: () => setWebSearchFlag(true), replaceWith: '' },
    { cmd: '/clear', label: '履歴をクリア', replaceWith: '/clear' },
    { cmd: '/refresh', label: 'Geminiをリフレッシュ', replaceWith: '/refresh' },
    { cmd: '/handover', label: 'ハンドオーバースナップショットを保存', replaceWith: '/handover' },
    { cmd: '/debug', label: 'アプリ内ログを表示/切替', action: () => { try { const cur = localStorage.getItem('app.debug.console') === '1'; localStorage.setItem('app.debug.console', cur ? '0' : '1'); location.reload(); } catch {} }, replaceWith: '' },
  ]), [setWebSearchFlag]);
  const templateSlash: SlashItem[] = useMemo(() => (
    templates
      .filter(t => t.cmd && t.cmd.startsWith('/'))
      .map(t => ({
        cmd: t.cmd!,
        label: t.title,
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
    const m = before.match(/(^|[\s\n\t])[^\s\n\t]*$/);
    const tokenStart = m ? before.length - (m[0].trim().length) : before.length;
    const head = (input ?? '').slice(0, tokenStart);
    const newVal = head + text + after;
    setInput(newVal);
    requestAnimationFrame(() => {
      if (chatInputRef.current) {
        const np = (head + text).length;
        chatInputRef.current.selectionStart = chatInputRef.current.selectionEnd = np;
        chatInputRef.current.focus();
      }
    });
  };

  const _tryUpdateSlash = (val: string) => {
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

  const tryUpdateSlash = (val: string) => {
    if (slashUpdateTimeoutRef.current) {
      clearTimeout(slashUpdateTimeoutRef.current);
    }
    slashUpdateTimeoutRef.current = setTimeout(() => {
      _tryUpdateSlash(val);
    }, 150);
  };

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

  const onSendMessage = () => {
      if (isRecording) {
          shouldSendMessageOnEndRef.current = true;
          recognitionRef.current?.stop();
          return;
      }
      const finalMessage = (input + interimTranscript).trim();
      handleSendMessage(finalMessage);
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      onSendMessage();
    }
  };

  // --- File Handling ---
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const files = event.target.files;
    if (files && files.length > 0) {
      const newFilesArray = Array.from(files);
      const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0) + newFilesArray.reduce((acc, file) => acc + file.size, 0);
      const oneGB = 1024 * 1024 * 1024;

      if (totalSize > oneGB) {
        setUploadError("合計ファイルサイズが1GBを超えています。");
        if(fileInputRef.current) {
          fileInputRef.current.value = "";
        }
        return;
      }

      const updatedFiles = [...selectedFiles, ...newFilesArray];
      setSelectedFiles(updatedFiles);
    }
    if(fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [selectedFiles, setSelectedFiles]);

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
  }, [selectedFiles, setSelectedFiles]);

  const handleRemoveFile = useCallback((fileToRemove: File) => {
    setUploadError(null);
    setSelectedFiles(prevFiles => prevFiles.filter(file => file !== fileToRemove));
  }, [setSelectedFiles]);

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  useEffect(() => {
    if (needsToSend) {
      handleSendMessage();
      setNeedsToSend(false);
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
          setInterimTranscript('');
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
        if (shouldSendMessageOnEndRef.current) {
          shouldSendMessageOnEndRef.current = false;
          setNeedsToSend(true);
        }
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error', event.error);
        setIsRecording(false);
      };
      
      recognitionRef.current = recognition;
    }

    return () => {
        if (slashUpdateTimeoutRef.current) {
            clearTimeout(slashUpdateTimeoutRef.current);
        }
        if (recognitionRef.current) {
            recognitionRef.current.onend = null;
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }
    }
  }, [setInput]);

  const handleMicClick = () => {
    if (!recognitionRef.current) return;

    if (isRecording) {
      recognitionRef.current.stop();
      setIsRecording(false);
    } else {
      setInterimTranscript('');
      try {
        recognitionRef.current.start();
        setIsRecording(true);
      } catch (error) {
        console.error("Speech recognition could not start: ", error);
      }
    }
  };

  return (
    <div className="flex-shrink-0 px-4 pt-2 pb-4 flex justify-center">
        <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="hidden"
        />
      <div className="w-full max-w-prose">
          <div className="relative w-[95%] mx-auto flex flex-col rounded-2xl border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 p-2 transition-colors shadow-lg -mt-10">
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

            {(!online || inputLocked) && (
              <div className="mb-2 px-3 py-2 text-xs text-yellow-800 bg-yellow-100 border border-yellow-300 rounded-md flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                <span>{!online ? 'オフラインです。接続後に送信してください。' : (lockMessage || '処理中です。完了するまで送信できません。')}</span>
              </div>
            )}

            <Textarea
              ref={chatInputRef}
              value={input + interimTranscript}
              onChange={(e) => {
                setInput(e.target.value)
                if (isRecording) {
                  recognitionRef.current?.stop();
                }
                tryUpdateSlash(e.target.value)
              }}
              onKeyDown={(e) => {
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
              placeholder={online ? (inputLocked ? (lockMessage || "処理中（送信のみ不可）…") : "システムと対話... (Alt+Enterで送信)") : "オフライン中は送信できません"}
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700"
                    onClick={triggerFileSelect}
                    disabled={isUploading || !online}
                  >
                      <Plus className="w-5 h-5" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="h-8 px-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700 flex items-center gap-1" disabled={isUploading || !online || Boolean(inputLocked)}>
                        <SlidersHorizontal className="w-4 h-4" />
                        <span className="text-sm font-light">ツール</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl">
                      <DropdownMenuItem onClick={() => setWebSearchFlag(true)}>
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
                  onClick={(isGeneratingResponse || isUploading) ? handleCancel : onSendMessage}
                  disabled={
                    inputLocked ? true : ((isGeneratingResponse || isUploading)
                      ? false
                      : (!online || (!input.trim() && !interimTranscript.trim() && selectedFiles.length === 0)))
                  }
                  className="w-7 h-7 p-0 flex-shrink-0 bg-black dark:bg-white hover:bg-gray-800 dark:hover:bg-gray-200 text-white dark:text-black rounded-full flex items-center justify-center"
                >
                  {(isGeneratingResponse || isUploading) ? <Square className="w-2.5 h-2.5" fill="currentColor" /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
                </Button>
              </div>
            </div>
          </div>
      </div>
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
    </div>
  );
});

ChatInput.displayName = 'ChatInput';

export default ChatInput;
