"use client"
import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export type ChatTemplate = { id: string; title: string; content: string; cmd?: string }

interface TemplateManagerProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  templates: ChatTemplate[]
  onChange: (next: ChatTemplate[]) => void
}

const RESERVED = new Set<string>(['/web', '/clear', '/debug']);
function validateCmd(cmd?: string, existing: ChatTemplate[], currentId?: string): string | null {
  if (!cmd) return null
  const norm = cmd.startsWith('/') ? cmd : `/${cmd}`
  if (!/^\/[a-zA-Z0-9\-]+$/.test(norm)) return 'コマンドは / で始まり、英数字・ハイフンのみ使用できます'
  if (RESERVED.has(norm)) return 'そのコマンドは予約済みです'
  const dup = existing.find(t => t.cmd === norm && t.id !== currentId)
  if (dup) return '同じコマンドが既に存在します'
  return null
}

export default function TemplateManagerDialog({ open, onOpenChange, templates, onChange }: TemplateManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = useMemo(() => templates.find(t => t.id === editingId) || null, [templates, editingId])

  const [title, setTitle] = useState('')
  const [cmd, setCmd] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (editing) {
      setTitle(editing.title)
      setCmd(editing.cmd || '')
      setContent(editing.content)
      setError(null)
    } else {
      setTitle('')
      setCmd('')
      setContent('')
      setError(null)
    }
  }, [editingId, editing])

  const handleSave = () => {
    const normCmd = cmd ? (cmd.startsWith('/') ? cmd : `/${cmd}`) : undefined
    const err = validateCmd(normCmd, templates, editing?.id)
    if (err) { setError(err); return }
    if (!title.trim()) { setError('タイトルは必須です'); return }
    if (!content.trim()) { setError('本文は必須です'); return }

    if (editing) {
      const next = templates.map(t => t.id === editing.id ? { ...t, title: title.trim(), content, cmd: normCmd } : t)
      onChange(next)
    } else {
      const t: ChatTemplate = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title: title.trim(),
        content,
        cmd: normCmd,
      }
      onChange([t, ...templates].slice(0, 200))
    }
    setEditingId(null)
  }

  const handleDelete = () => {
    if (!editing) return
    onChange(templates.filter(t => t.id !== editing.id))
    setEditingId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>テンプレート管理</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* List */}
          <div className="border rounded-md p-2 h-[360px] overflow-auto bg-white dark:bg-slate-900">
            {templates.length === 0 ? (
              <div className="text-sm text-slate-500 p-2">テンプレートはまだありません。右側のフォームから作成できます。</div>
            ) : (
              <ul className="space-y-1">
                {templates.map(t => (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={cn('w-full text-left px-2 py-2 rounded hover:bg-slate-100 dark:hover:bg-slate-700', editingId === t.id && 'bg-slate-100 dark:bg-slate-700')}
                      onClick={() => setEditingId(t.id)}
                      title={t.content}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate">
                          <div className="font-medium truncate">{t.title}</div>
                          {t.cmd && <div className="text-xs text-slate-500 font-mono truncate">{t.cmd}</div>}
                        </div>
                        <div className="text-xs text-slate-400">{Math.max(1, t.content.length)}文字</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Editor */}
          <div className="space-y-3">
            <div>
              <Label htmlFor="tpl-title">タイトル</Label>
              <Input id="tpl-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 要約テンプレ" />
            </div>
            <div>
              <Label htmlFor="tpl-cmd">スラッシュコマンド（任意）</Label>
              <Input id="tpl-cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="例: /summary" />
              <p className="mt-1 text-xs text-slate-500">/ から始まる英数字・ハイフンのみ。重複は不可。</p>
            </div>
            <div>
              <Label htmlFor="tpl-content">本文</Label>
              <Textarea id="tpl-content" value={content} onChange={(e) => setContent(e.target.value)} rows={8} placeholder="テンプレート本文" />
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
            <DialogFooter className="gap-2">
              {editing && (
                <Button variant="destructive" onClick={handleDelete}>削除</Button>
              )}
              <div className="flex-1" />
              <Button variant="secondary" onClick={() => { setEditingId(null); }}>クリア</Button>
              <Button onClick={handleSave}>{editing ? '更新' : '追加'}</Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
