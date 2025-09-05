"use client"

import React from "react";

type Action = { label: string; onClick?: () => void };

export function FeatureOverlay({
  enabled = true,
  title = "未実装です",
  message,
  bullets = [],
  requestChatPrompt,
  buttonLabel = "Geminiと一緒に実装を始める",
  secondaryLabel,
  onSecondary,
}: {
  enabled?: boolean;
  title?: string;
  message?: string;
  bullets?: string[];
  requestChatPrompt?: string;
  buttonLabel?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  if (!enabled) return null;
  // パネル（親要素）内だけを覆い、ページ全体（サイドバー等）は操作可能に保つ
  return (
    <div className="absolute inset-0 z-30">
      {/* Mist layer only within the panel area (sidebarは覆わない) */}
      <div className="absolute inset-0 bg-white/80 dark:bg-slate-900/70 backdrop-blur-[1px]" />
      {/* Card: パネル内のスクロールに追従しつつ、表示領域の中央に留まる（sticky） */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="sticky top-1/2 -translate-y-1/2 transform flex justify-center p-4">
          <div className="pointer-events-auto max-w-xl w-full rounded-2xl border bg-white/95 dark:bg-slate-800/95 shadow-xl p-5 text-slate-800 dark:text-slate-100">
          <div className="text-lg font-bold mb-2">{title}</div>
          {message && <p className="text-sm leading-6 mb-3 whitespace-pre-wrap">{message}</p>}
          {bullets.length > 0 && (
            <ul className="list-disc pl-5 space-y-1 text-sm mb-3">
              {bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => {
                try {
                  const text = requestChatPrompt || '今からここを機能実装したい。まずは実装前にどんな機能にするか計画を話し合いたい。';
                  window.dispatchEvent(new CustomEvent('chat:open-with-prompt', { detail: { text } }));
                } catch {}
              }}
              className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 active:opacity-90"
            >
              {buttonLabel}
            </button>
            {secondaryLabel && (
              <button
                onClick={onSecondary}
                className="px-3 py-1.5 text-sm rounded-md bg-neutral-200 text-neutral-800 hover:bg-neutral-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
              >
                {secondaryLabel}
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
