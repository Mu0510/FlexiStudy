"use client"

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

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
  mode = 'parent',
}: {
  enabled?: boolean;
  title?: string;
  message?: string;
  bullets?: string[];
  requestChatPrompt?: string;
  buttonLabel?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  // 固定方法: 'fixed' はビューポート中央固定、'parent' は親要素中央固定
  mode?: 'fixed' | 'parent';
}) {
  if (!enabled) return null;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelCenter, setPanelCenter] = useState<number | null>(null);

  useEffect(() => {
    const update = () => {
      try {
        const rect = rootRef.current?.getBoundingClientRect();
        if (rect) setPanelCenter(rect.left + rect.width / 2);
      } catch {}
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, { passive: true } as any);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update as any);
    };
  }, []);
  // パネル（親要素）内だけを覆い、ページ全体（サイドバー等）は操作可能に保つ
  return (
    <div ref={rootRef} className="absolute inset-0 z-30">
      {/* Mist layer only within the panel area (sidebarは覆わない) */}
      <div className="absolute inset-0 bg-white/80 dark:bg-slate-900/70 backdrop-blur-[1px]" />
      {/* Card: 配置モードに応じて中央配置 */}
      <div className="absolute inset-0 pointer-events-none">
        {mode === 'fixed' ? (
          <div
            className="fixed -translate-x-1/2 -translate-y-1/2 transform p-4"
            style={{ left: panelCenter ?? '50%', top: '50%' }}
          >
            <div className="pointer-events-auto max-w-xl w-[min(90vw,40rem)] rounded-2xl border bg-white/95 dark:bg-slate-800/95 shadow-xl p-5 text-slate-800 dark:text-slate-100">
              <div className="text-lg font-bold mb-2 flex items-center">
                <AlertTriangle className="w-5 h-5 text-amber-600 mr-2" />
                <span>{title}</span>
              </div>
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
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="pointer-events-auto max-w-xl w-[min(90vw,40rem)] rounded-2xl border bg-white/95 dark:bg-slate-800/95 shadow-xl p-5 text-slate-800 dark:text-slate-100">
              <div className="text-lg font-bold mb-2 flex items-center">
                <AlertTriangle className="w-5 h-5 text-amber-600 mr-2" />
                <span>{title}</span>
              </div>
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
        )}
      </div>
    </div>
  );
}
