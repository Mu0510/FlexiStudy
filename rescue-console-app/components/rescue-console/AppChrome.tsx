"use client";

import { Dot, Plus, GitBranch, RotateCcw, Database } from "lucide-react";

export function AppChrome({
  onNewWindow,
  footerLeft,
  footerRight,
  children,
}: {
  onNewWindow: () => void;
  footerLeft: React.ReactNode;
  footerRight: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative h-dvh w-dvw bg-white text-neutral-900">
      {/* Header */}
      <header className="fixed inset-x-0 top-0 h-12 z-50 bg-slate-900 text-white border-b border-slate-800/50">
        <div className="h-full px-4 flex items-center gap-3">
          {/* 左アイコン（端末感のあるプレースホルダ） */}
          <span className="font-mono text-[14px] opacity-90 mr-1">›_</span>
          <span className="font-medium tracking-tight">Rescue Console</span>
          <span className="text-[12px] text-slate-300 flex items-center gap-1">
            <Dot className="size-4 fill-emerald-500 stroke-emerald-500" />
            システム監視中
          </span>
          <div className="ml-auto flex items-center gap-1">
            <div className="w-px h-5 bg-white/15 mx-1" />
            <ToolBtn icon={<GitBranch className="size-4" />} label="Git"          onClick={() => dispatchGlobal("git-menu")} />
            <ToolBtn icon={<Database  className="size-4" />} label="バックアップ"  onClick={() => dispatchGlobal("backup-menu")} />
            <ToolBtn icon={<RotateCcw className="size-4" />} label="復元"          onClick={() => dispatchGlobal("restore-menu")} />
            <div className="w-px h-5 bg-white/15 mx-1" />
            <ToolBtn icon={<Plus className="size-4" />} label="新規" onClick={onNewWindow} />
          </div>
        </div>
      </header>

      {/* Desktop layer (header / footer の間) */}
      <div className="absolute left-0 right-0 overflow-hidden" style={{ top: 48, bottom: 28 }}>
        {children}
      </div>

      {/* Footer */}
      <footer className="fixed inset-x-0 bottom-0 h-7 border-t border-neutral-200 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/60 z-50">
        <div className="flex h-full items-center px-2 text-xs">
          <div className="flex items-center gap-1 overflow-x-auto pr-2">{footerLeft}</div>
          <div className="ml-auto flex items-center gap-2">{footerRight}</div>
        </div>
      </footer>
    </div>
  );
}

function ToolBtn({
  icon, label, onClick,
}: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-2 h-8 text-white
            hover:bg-white/10 active:bg-white/15 text-sm
            focus:outline-none focus:ring-2 focus:ring-white/20"
      title={label}
    >
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  );
}

// ヘッダーから“仮メニュー”を開かせるための簡易ブロードキャスト
function dispatchGlobal(kind: string) {
  window.dispatchEvent(new CustomEvent("rc-global", { detail: { kind } }));
}
