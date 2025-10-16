"use client"

import React, { useMemo } from "react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { CheckCircle, XCircle, File as FileIcon, Play, Pause, SlidersHorizontal } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"

type FileInfo = { name: string; path: string; size?: number }
type Goal = { id: string | number; task: string; subject: string; tags?: string[] }
type Session = any

export interface ChatMessage {
  id: string
  ts?: number
  updatedTs?: number
  role: "user" | "assistant" | "tool" | "system"
  type?: "text" | "tool"
  content: any
  files?: FileInfo[]
  goal?: Goal | null
  session?: Session | null
  status?: "running" | "finished" | "error" | "in_progress"
  icon?: string
  label?: string
  command?: string
  cmdKey?: string
  thoughtMode?: boolean
}

export interface ToolHelpers {
  getToolIconText: (iconName?: string) => string
  getRelativePath: (absolutePath?: string) => string
  formatFileSize: (bytes: number) => string
  formatCmdKey: (key?: string, command?: string) => string | null
  sendToolApproval?: (toolCallId: string, decision: 'allow_once' | 'allow_always' | 'deny' | 'deny_always') => void;
}

function MessageItemInner({ msg, tools }: { msg: ChatMessage; tools: ToolHelpers }) {
  if (msg.type === "tool" || msg.role === "tool") {
    const looksLikeDiff = typeof msg.content === "string" && msg.content.includes("diff-prefix")
    return (
      <Card className={cn(
        "tool-card bg-gray-100 dark:bg-slate-800 text-gray-900 dark:text-gray-100 rounded-lg p-3 shadow-md",
        "w-11/12 mx-auto my-1 mb-3",
        msg.status === "running" && "tool-card--running",
        msg.status === "finished" && "tool-card--finished border-l-4 border-green-500",
        msg.status === "error" && "tool-card--error border-l-4 border-red-500",
      )}>
        <CardHeader className="flex flex-row items-center justify-between p-0 mb-1">
          <div className="flex items-center space-x-2 flex-shrink min-w-0">
            <span className="tool-card__icon-text text-xs border border-gray-500 dark:border-gray-400 rounded px-1 py-0.5">
              {tools.getToolIconText(msg.icon)}
            </span>
            <CardTitle className="tool-card__title text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
              {msg.label || "Tool Call"}
              {msg.status === "pending" && msg.cmdKey && (
                <span className="ml-2 text-xs font-normal text-gray-600 dark:text-gray-400">
                  {tools.formatCmdKey(msg.cmdKey, msg.command) || ""}
                </span>
              )}
            </CardTitle>
          </div>
          <div className="tool-card__line-break" />
          <div className="tool-card__status-indicator">
            {msg.status === "finished" && <CheckCircle className="h-4 w-4 text-green-500" />}
            {msg.status === "error" && <XCircle className="h-4 w-4 text-red-500" />}
            {(msg.status === "running" || msg.status === undefined) && (
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-sky-500" />
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0 text-sm">
          <div className={cn(
            "tool-card__body text-xs whitespace-pre font-mono p-2 rounded not-prose max-h-48 overflow-y-auto overflow-x-auto",
            // 統一トーン: ツールはダーク面
            "bg-gray-800 dark:bg-gray-900"
          )}>
            {/* ツール結果は既に HTML 文字列（diff など）なのでそのまま表示 */}
            <div className="text-gray-200 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: String(msg.content || "") }} />
          </div>
          {msg.status === 'pending' && (
            <div className="p-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-gray-700 dark:text-gray-300 font-mono truncate">
                  {tools.formatCmdKey(msg.cmdKey, msg.command) || ''}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="bg-[#213358] hover:bg-[#1a2a46] text-white" onClick={() => tools.sendToolApproval?.(msg.id, 'allow_once')}>許可</Button>
                  <Button size="sm" variant="outline" onClick={() => tools.sendToolApproval?.(msg.id, 'deny')}>拒否</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" className="px-2">
                        <SlidersHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => tools.sendToolApproval?.(msg.id, 'allow_always')}>常に許可</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => tools.sendToolApproval?.(msg.id, 'deny_always')}>常に拒否</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  // ユーザー/アシスタントの本文は Markdown。パースをメモ化
  const markdown = useMemo(() => {
    const text = typeof msg.content === "string" ? msg.content : ""
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
        {text}
      </ReactMarkdown>
    )
    // msg.id + updatedTs または content の変化で再生成
  }, [msg.id, msg.updatedTs, msg.content])

  return (
    <div className={cn("flex flex-col", msg.role === "user" ? "items-end" : "items-start mx-auto w-[95%]")}>
      {(msg.files?.length || msg.goal || msg.session) ? (
        <div className={cn("mb-2 space-y-1", msg.role === "user" ? "ml-auto max-w-[65%]" : "w-full")}>
          {msg.goal && (
            <div className="bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm">
              <Play className="h-5 w-5 text-primary-600 dark:text-primary-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-700 dark:text-gray-300 truncate" title={msg.goal.task}>{msg.goal.task}</p>
                <p className="text-gray-500 dark:text-gray-400 text-xs">
                  {msg.goal.subject}
                  {msg.goal.tags && msg.goal.tags.length > 0 && ` - ${msg.goal.tags.join(", ")}`}
                </p>
              </div>
            </div>
          )}
          {msg.session && (
            <div className="bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm">
              {msg.session.type === "START" && <Play className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0" />}
              {msg.session.type === "BREAK" && <Pause className="h-5 w-5 text-orange-600 dark:text-orange-400 flex-shrink-0" />}
              {(!msg.session.type || msg.session.type === "RESUME") && <Play className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-700 dark:text-gray-300 truncate" title={msg.session.content || "学習記録"}>
                  {msg.session.content || "学習記録"}
                </p>
                <p className="text-gray-500 dark:text-gray-400 text-xs">
                  {msg.session.start_time}
                  {msg.session.duration_minutes ? ` (${msg.session.duration_minutes}分)` : ""}
                </p>
              </div>
            </div>
          )}
          {Array.isArray(msg.files) && msg.files.length > 0 && (
            <div className="flex space-x-2 overflow-x-auto">
              {msg.files.map((f, i) => (
                <div key={i} className="flex-shrink-0 bg-gray-100 dark:bg-slate-700 rounded-lg p-2 flex items-center space-x-2 text-sm relative">
                  <FileIcon className="h-5 w-5 text-gray-500 dark:text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300 truncate max-w-[100px]" title={f.name || tools.getRelativePath(f.path)}>
                    {f.name || tools.getRelativePath(f.path)}
                  </span>
                  {typeof f.size === "number" && (
                    <span className="text-gray-500 dark:text-gray-400 text-xs">{tools.formatFileSize(f.size)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
      {msg.content ? (
        <div className={cn(
          "prose prose-sm dark:prose-invert",
          msg.role === "user"
            ? "ml-auto bg-gray-100 text-gray-900 dark:bg-blue-600 dark:text-white rounded-2xl px-4 py-1 max-w-[65%]"
            : "w-full",
          msg.thoughtMode && "animate-pulse"
        )}>
          {markdown}
        </div>
      ) : null}
    </div>
  )
}

export const MessageItem = React.memo(MessageItemInner, (prev, next) => {
  // id と updatedTs / content が変わらない限りスキップ
  return (
    prev.msg.id === next.msg.id &&
    prev.msg.updatedTs === next.msg.updatedTs &&
    prev.msg.content === next.msg.content &&
    prev.msg.status === next.msg.status
  )
})
