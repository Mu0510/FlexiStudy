"use client";

import React, { useMemo, useState } from "react";
import { Dot } from "lucide-react";
import { AppChrome } from "./AppChrome";
import { TerminalWindow, makeNewWindow, TerminalWindowModel } from "./TerminalWindow";

type ConnStatus = "connected" | "connecting" | "disconnected";

export default function RescueConsoleApp() {
  const [windows, setWindows] = useState<TerminalWindowModel[]>(() => [
    makeNewWindow({ x: 56, y: 24 })
  ]);
  const [zCounter, setZ] = useState(10);
  const [status, setStatus] = useState<ConnStatus>("connected"); // ← 実装側でWSに連動

  const minimized = useMemo(() => windows.filter(w => w.minimized), [windows]);
  const maxZ = useMemo(
    () => Math.max(0, ...windows.filter(w => !w.minimized).map(w => w.z)),
    [windows]
  );

  const bringFront = (id: string) => {
    setWindows(ws => ws.map(w => (w.id === id ? { ...w, z: zCounter + 1 } : w)));
    setZ(z => z + 1);
  };
  const patch = (id: string, p: Partial<TerminalWindowModel>) => {
    setWindows(ws => ws.map(w => (w.id === id ? { ...w, ...p } : w)));
  };
  const close = (id: string) => setWindows(ws => ws.filter(w => w.id !== id));
  const newWindow = () => {
    setWindows(ws => {
      const nx = 64 + (ws.length * 28) % 260;
      const ny = 36 + (ws.length * 24) % 160;
      return [...ws, makeNewWindow({ x: nx, y: ny, z: zCounter + 1 })];
    });
    setZ(z => z + 1);
  };

  return (
    <AppChrome
      onNewWindow={newWindow}
      footerLeft={
        <>
          {minimized.map(m => (
            <button
              key={m.id}
              onClick={() => patch(m.id, { minimized: false })}
              className="rounded px-2 py-0.5 border border-neutral-200 hover:bg-neutral-50 active:bg-neutral-100"
              title={m.title}
            >
              {m.title}
            </button>
          ))}
        </>
      }
      footerRight={
        <>
          <span className="text-slate-600">ステータス:</span>
          <span className="flex items-center gap-1 text-emerald-600">
            <Dot className="size-4 fill-emerald-500 stroke-emerald-500" /> 接続済み
          </span>
          <span className="text-slate-400">|</span>
          <span className="tabular-nums text-slate-700">00:15:42</span>
          <span className="text-slate-400">|</span>
          <span className="tabular-nums text-slate-700">CPU: 12%</span>
          <span className="text-slate-400">|</span>
          <span className="tabular-nums text-slate-700">RAM: 2.1GB</span>
        </>
      }
    >
      {/* デスクトップ面（ヘッダー/フッターの間で絶対配置） */}
      <div className="absolute inset-0 select-none">
        {windows.length === 0 && (
          <div className="h-full grid place-items-center">
            <button
              onClick={newWindow}
              className="rounded-md border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 active:bg-neutral-100"
            >
              新しいウィンドウを開く
            </button>
          </div>
        )}

        {windows.map(w => (
          <TerminalWindow
            key={w.id}
            model={w}
            isTop={w.z === maxZ && !w.minimized}
            onFocus={() => bringFront(w.id)}
            onChange={(p) => patch(w.id, p)}
            onClose={() => close(w.id)}
          />
        ))}
      </div>
    </AppChrome>
  );
}
