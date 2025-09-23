// webnew/components/tool-card-item.tsx
"use client"

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolCardItemProps {
  msg: any; // TODO: 型を厳密にする
  getToolIconText: (iconName?: string) => string;
  getRelativePath: (absolutePath?: string) => string;
}

function adjustToolCardBodyHeight(headerHeight: number, chatPanelHeight: number): string {
  const maxHeightThreshold = chatPanelHeight * 0.50; // チャットパネルの50%に変更
  const bodyPadding = 20; // tool-card__bodyの上下パディングを考慮

  const calculatedMaxHeight = maxHeightThreshold - headerHeight - bodyPadding;
  return `${calculatedMaxHeight}px`;
}

export function ToolCardItem({ msg, getToolIconText, getRelativePath }: ToolCardItemProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const [bodyMaxHeight, setBodyMaxHeight] = useState<string>('auto');

  const calculateBodyMaxHeight = useCallback(() => {
    if (headerRef.current && bodyRef.current) { // bodyRef.current もここでチェック
      const headerHeight = headerRef.current.offsetHeight;
      // messagesContainerRef の代わりに、親要素の高さ（ここではウィンドウの高さ）を暫定的に使用
      // 最終的には、messagesContainerRef の高さを ToolCardItem に渡す必要がある
      const chatPanelHeight = window.innerHeight; // 仮の高さ。後で修正
      const calculatedHeight = adjustToolCardBodyHeight(headerHeight, chatPanelHeight);
      setBodyMaxHeight(calculatedHeight);
      console.log(`[DEBUG] ToolCardItem - headerHeight: ${headerHeight}, chatPanelHeight: ${chatPanelHeight}, calculatedHeight: ${calculatedHeight}`);
    }
  }, []);

  useEffect(() => {
    calculateBodyMaxHeight(); // Initial calculation

    const resizeObserver = new ResizeObserver(() => {
      calculateBodyMaxHeight();
    });

    // messagesContainerRef の代わりに bodyRef.current を監視
    if (bodyRef.current) {
      resizeObserver.observe(bodyRef.current);
    }

    return () => {
      if (bodyRef.current) {
        resizeObserver.unobserve(bodyRef.current);
      }
    };
  }, [calculateBodyMaxHeight]);

  return (
    <div key={msg.id} className={cn("flex", "justify-start")}>
      <Card className={cn(
        "tool-card bg-gray-100 dark:bg-slate-800 rounded-lg p-3 shadow-md mx-auto w-[95%]", // AIメッセージと同じ幅と中央揃え
        msg.status === "running" && "tool-card--running", // running クラスを追加
        msg.status === "finished" && "tool-card--finished border-l-4 border-green-500", // finished クラスとボーダー
        msg.status === "error" && "tool-card--error border-l-4 border-red-500" // error クラスとボーダー
      )}>
        <CardHeader ref={headerRef} className="flex flex-row items-center justify-between p-0 mb-1">
          <div className="flex items-center space-x-2">
            <span className="tool-card__icon-text text-xs border border-gray-500 dark:border-gray-400 rounded px-1 py-0.5">
              {getToolIconText(msg.icon)}
            </span>
            <CardTitle className="tool-card__title text-sm font-medium text-slate-800 dark:text-slate-200">
              {msg.label || "Tool Call"}
            </CardTitle>
          </div>
          {/* chat.js の tool-card__line-break に相当 */}
          <div className="tool-card__line-break"></div>
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
        <CardContent className="p-0 text-sm text-gray-800 dark:text-gray-200">
          {/* Removed toolCallConfirmation logic for now, focusing on content */}
          <div ref={bodyRef} className="tool-card__body text-xs whitespace-pre font-mono bg-gray-100 dark:bg-slate-700/50 p-2 rounded not-prose overflow-y-auto overflow-x-auto" style={{ maxHeight: bodyMaxHeight }}>
            <div className="text-gray-800 dark:text-gray-200" dangerouslySetInnerHTML={{ __html: msg.content }} /> {/* Use msg.content */}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
