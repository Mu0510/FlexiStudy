'use client';
import React, { useMemo, useState } from "react";
import { AppChrome } from "./AppChrome";
import { TerminalWindow, makeNewWindow, TerminalWindowModel } from "./TerminalWindow";
import { Dot } from 'lucide-react';

type PanelState = null | { kind:'git'|'backup'|'restore'|'settings'; view?:string };
type ConnStatus = "connected" | "connecting" | "disconnected";

export default function RescueConsoleApp() {
  const [windows, setWindows] = useState<TerminalWindowModel[]>(() => [
    makeNewWindow({ x: 56, y: 24 })
  ]);
  const [zCounter, setZ] = useState(10);
  const [status, setStatus] = useState<ConnStatus>("connected"); // ← 実装側でWSに連動
  const [panel, setPanel] = useState<PanelState>(null);
  const [animationEnabled, setAnimationEnabled] = useState(true);

  const taskbarItems = useMemo(() => windows.filter(w => w.minimized || w.minimizing || w.restoring), [windows]);
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
      onOpenPanel={(k, view) => setPanel({ kind:k, view })}
      footerLeft={
        <>
          {taskbarItems.map(m => (
            <button
              key={m.id}
              id={`minimized-btn-${m.id}`}
              onClick={() => {
                patch(m.id, { minimized: false, restoring: true });
                setTimeout(() => {
                  patch(m.id, { restoring: false });
                }, 150); // アニメーションの時間に合わせる
              }}
              className={`rounded px-2 py-0.5 border border-neutral-200 hover:bg-neutral-50 active:bg-neutral-100 taskbar-btn ${m.minimizing ? 'will-appear' : ''} ${m.restoring ? 'will-disappear' : ''}`}
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
      {/* デスクトップ面 */}
      <div className="absolute inset-0 select-none">
        {windows.length === 0 && (<div className="h-full grid place-items-center">
            <button
              onClick={newWindow}
              className="rounded-md border border-neutral-200 px-4 py-2 text-sm hover:bg-neutral-50 active:bg-neutral-100"
            >
              新しいウィンドウを開く
            </button>
          </div>)}
        {windows.map(w => (<TerminalWindow
            key={w.id}
            model={w}
            isTop={w.z === maxZ && !w.minimized}
            animationEnabled={animationEnabled}
            onFocus={() => bringFront(w.id)}
            onChange={(p) => patch(w.id, p)}
            onClose={() => close(w.id)}
            onMinimize={() => {
              // まず `minimizing` フラグを立ててタスクバーボタンをレンダリングさせる
              patch(w.id, { minimizing: true });
              
              // DOM更新後（次のフレーム）にボタン位置を取得してアニメーションを開始
              requestAnimationFrame(() => {
                const btn = document.getElementById(`minimized-btn-${w.id}`);
                if (btn) {
                  patch(w.id, { animationTargetRect: btn.getBoundingClientRect() });
                } else {
                  // ターゲットが見つからない場合はアニメーションなしで最小化
                  patch(w.id, { minimizing: false, minimized: true });
                }
              });
            }}
           />))}
      </div>

     {/* 画面全体ポップアップ（最前面 / ヘッダーも覆う） */}
      {panel && (
        <FullScreenPanel
          kind={panel.kind}
          initialView={panel.view}
          onClose={() => setPanel(null)}
          animationEnabled={animationEnabled}
          onAnimationSettingChange={setAnimationEnabled}
        />
      )}
    </AppChrome>
  );
}

function FullScreenPanel({ kind, initialView, onClose, animationEnabled, onAnimationSettingChange }: {
  kind: 'git' | 'backup' | 'restore' | 'settings';
  initialView?: string;
  onClose: () => void;
  animationEnabled: boolean;
  onAnimationSettingChange: (enabled: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-[70]">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="absolute inset-0 grid place-items-center p-4">
        <div className="w-[min(880px,92vw)] rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          {/* ヘッダー */}
          <div className="h-14 flex items-center justify-between px-5 border-b border-slate-200">
            <div className="text-xl font-semibold">
              {kind === 'git' ? 'Git' : kind === 'backup' ? 'バックアップ' : kind === 'settings' ? '設定' : '復元'}
            </div>
            <button
              onClick={onClose}
              className="h-8 w-8 grid place-items-center rounded hover:bg-slate-100 active:bg-slate-200"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>

          {/* 本文（アクションの“メニュー→フォーム”をここで切替） */}
          <div className="p-5">
            {kind === 'git' && <GitPanel initialView={initialView} />}
            {kind === 'backup' && <BackupPanel />}
            {kind === 'restore' && <RestorePanel />}
            {kind === 'settings' && <SettingsPanel animationEnabled={animationEnabled} onAnimationSettingChange={onAnimationSettingChange} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- 各パネル（ダミーUI） ---- */

function SectionTitle({children}:{children:React.ReactNode}) {
  return <div className="text-sm font-semibold text-slate-600 mb-2">{children}</div>;
}
function ActionItem({icon, label, onClick}:{icon:React.ReactNode;label:string;onClick:()=>void}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50 active:bg-slate-100 text-left"
    >
      <span className="opacity-70">{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function GitPanel({initialView}:{initialView?:string}) {
  const [view, setView] = useState<'menu'|'commit'|'status'>((initialView==='commit' || initialView==='status') ? (initialView as any) : 'menu');
  return view === 'menu' ? (
    <div className="space-y-3">
      <SectionTitle>Git 操作</SectionTitle>
      <ActionItem icon="⎇" label="ブランチ状態" onClick={() => setView('status')} />
      <ActionItem icon="＋" label="コミット" onClick={() => setView('commit')} />
      <ActionItem icon="⟳" label="プル" onClick={() => alert('pull: 未実装')} />
      <ActionItem icon="⧉" label="プッシュ" onClick={() => alert('push: 未実装')} />
    </div>
  ) : view === 'commit' ? (
    <div className="space-y-4">
      <SectionTitle>コミットメッセージ</SectionTitle>
      <textarea
        placeholder="変更内容を入力してください…"
        className="w-full h-36 rounded-md border border-slate-200 bg-slate-50/50 p-3 outline-none focus:ring-2 focus:ring-slate-300"
      />
      <div className="flex items-center justify-end">
        <button className="rounded-md px-5 py-2 bg-slate-900 text-white hover:brightness-95">コミット実行</button>
      </div>
    </div>
  ) : (
    <div className="space-y-4">
      <SectionTitle>現在のブランチ</SectionTitle>
      <div className="rounded-md border border-slate-200 p-3 text-sm bg-slate-50/50">
        main（ダミー）<br/> 直近コミット: abcdef…（ダミー）
      </div>
    </div>
  );
}

function BackupPanel() {
  return (
    <div className="space-y-3">
      <SectionTitle>バックアップ</SectionTitle>
      <ActionItem icon="☰" label="バックアップ一覧" onClick={() => alert('list backups: 未実装')} />
      <ActionItem icon="＋" label="バックアップ作成…" onClick={() => alert('create backup: 未実装')} />
    </div>
  );
}

function RestorePanel() {
  return (
    <div className="space-y-3">
      <SectionTitle>復元</SectionTitle>
      <ActionItem icon="⟲" label="最新に復元" onClick={() => alert('restore latest: 未実装')} />
      <ActionItem icon="…" label="バックアップを選択…" onClick={() => alert('choose: 未実装')} />
    </div>
  );
}

function SettingsPanel({ animationEnabled, onAnimationSettingChange }: {
  animationEnabled: boolean;
  onAnimationSettingChange: (enabled: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <SectionTitle>設定</SectionTitle>
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 hover:bg-slate-50 text-left cursor-pointer">
        <span className="font-medium">ウィンドウのアニメーション</span>
        <input
          type="checkbox"
          checked={animationEnabled}
          onChange={(e) => onAnimationSettingChange(e.target.checked)}
          className="ml-auto h-5 w-5 rounded-md"
        />
      </label>
    </div>
  );
}
