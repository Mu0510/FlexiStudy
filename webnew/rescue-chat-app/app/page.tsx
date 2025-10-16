'use client'

import { useState, useCallback } from 'react'
import { useChat } from '../../hooks/useChat'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { NewChatPanel } from '../../components/new-chat-panel'

interface Goal {
  id: string | number
  completed: boolean
  subject: string
  task: string
  details?: string
  tags?: string[]
  total_problems?: number | null
  completed_problems?: number | null
}

type ChatSession = any | null

const buildLockMessage = (
  isNotifyBusy: boolean,
  notifyBusyReason: string | null,
  isModelRestarting: boolean,
  modelRestartReason: string | null,
) => {
  if (isModelRestarting) {
    if (modelRestartReason === 'refresh') return 'Geminiをリフレッシュしています…'
    if (modelRestartReason === 'model-change') return 'モデルを切り替えています…'
    if (modelRestartReason === 'handover') return 'ハンドオーバー要約を作成しています…'
    return 'Geminiを再起動中です…'
  }
  if (!isNotifyBusy) {
    return undefined
  }
  switch (notifyBusyReason) {
    case 'reminder':
      return 'リマインダーを処理中です…'
    case 'context_pending':
      return 'コンテキスト保留を処理中です…'
    case 'context_active':
      return 'モード切り替えを反映中です…'
    default:
      return '通知を生成中です…'
  }
}

export default function RescueChatPage() {
  const [input, setInput] = useState('')
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null)
  const [selectedSession, setSelectedSession] = useState<ChatSession>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])

  const {
    messages,
    activeMessage,
    isGeneratingResponse,
    isNotifyBusy,
    notifyBusyReason,
    isModelRestarting,
    modelRestartReason,
    sendMessage,
    refreshChat,
    handoverSnapshot,
    cancelSendMessage,
    requestHistory,
    isFetchingHistory,
    historyFinished,
    clearMessages,
    sendToolApproval,
  } = useChat({ onMessageReceived: () => {} })

  const online = useOnlineStatus()

  const lockMessage = buildLockMessage(isNotifyBusy, notifyBusyReason, isModelRestarting, modelRestartReason)
  const handleClearGoal = useCallback(() => setSelectedGoal(null), [])
  const handleClearSession = useCallback(() => setSelectedSession(null), [])

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {!online && (
        <div className="z-10 border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-900 dark:border-amber-600 dark:bg-amber-500/10 dark:text-amber-100">
          オフラインです。Geminiへの送信は復帰まで保留されます。
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <NewChatPanel
          showAs="embedded"
          messages={messages as any}
          activeMessage={activeMessage as any}
          isGeneratingResponse={isGeneratingResponse}
          sendMessage={sendMessage as any}
          cancelSendMessage={cancelSendMessage}
          requestHistory={requestHistory}
          isFetchingHistory={isFetchingHistory}
          historyFinished={historyFinished}
          refreshChat={refreshChat}
          handoverSnapshot={handoverSnapshot}
          clearMessages={clearMessages}
          sendToolApproval={sendToolApproval as any}
          input={input}
          setInput={setInput}
          selectedFiles={selectedFiles}
          setSelectedFiles={setSelectedFiles}
          inputLocked={isNotifyBusy || isModelRestarting}
          lockMessage={lockMessage}
          selectedGoal={selectedGoal}
          onClearSelectedGoal={handleClearGoal}
          selectedSession={selectedSession}
          onClearSelectedSession={handleClearSession}
        />
      </div>
    </div>
  )
}
