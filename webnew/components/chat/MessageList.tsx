"use client"

import React, { useMemo } from "react"
import { MessageItem, ChatMessage } from "./MessageItem"

interface Props {
  messages: ChatMessage[]
  tools: any
}

function MessageListInner({ messages, tools }: Props) {
  const dedupedMessages = useMemo(() => {
    if (!Array.isArray(messages) || messages.length === 0) return messages

    const seen = new Set<string>()
    let hasDuplicate = false
    for (const msg of messages) {
      const id = typeof msg?.id === "string" ? msg.id : undefined
      if (!id) continue
      if (seen.has(id)) {
        hasDuplicate = true
        break
      }
      seen.add(id)
    }

    if (!hasDuplicate) return messages

    seen.clear()
    const deduped: ChatMessage[] = []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      const id = typeof msg?.id === "string" ? msg.id : undefined
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      deduped.push(msg)
    }

    return deduped.reverse()
  }, [messages])

  // メッセージ配列が同一参照の間は再構築しない
  const children = useMemo(
    () => dedupedMessages.map((m) => <MessageItem key={m.id} msg={m as any} tools={tools} />),
    [dedupedMessages, tools],
  )
  return <>{children}</>
}

export const MessageList = React.memo(MessageListInner)