'use client';

import { Dot, Plus, GitBranch, RotateCcw, Database, GitCommit, GitPullRequest, Upload, List } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

 export function AppChrome({
   onNewWindow,
   onOpenPanel,          // 追加：パネルを開く（kind, view）
   footerLeft,
   footerRight,
   children,
 }: {
   onNewWindow: () => void;
   onOpenPanel: (k: 'git' | 'backup' | 'restore', view?: string) => void;
   footerLeft: React.ReactNode;
   footerRight: React.ReactNode;
   children: React.ReactNode;
 }) {
  const [menu, setMenu] = useState<null | { kind:'git'|'backup'|'restore'; x:number; y:number }>(null);
  const openMenu = (kind:'git'|'backup'|'restore', el:HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ kind, x: r.left, y: r.bottom + 8 });
  };
  const closeMenu = () => setMenu(null);

   return (
    <div className="relative h-dvh w-dvw bg-white text-neutral-900">
       {/* Header */}
       <header className="fixed inset-x-0 top-0 h-12 border-b border-slate-800/40 bg-slate-900 text-white z-50">
         <div className="h-full px-4 flex items-center gap-3">
           <span className="font-medium">Rescue Console</span>
           <span className="text-[12px] text-slate-300 flex items-center gap-1">
             <Dot className="size-4 fill-emerald-500 stroke-emerald-500" />
             システム監視中
           </span>
           <div className="ml-auto flex items-center gap-1">
             <div className="w-px h-5 bg-white/15 mx-1" />
            <ToolBtn icon={<GitBranch className="size-4" />} label="Git"
              onClick={(e) => openMenu('git', e.currentTarget as HTMLElement)} />
            <ToolBtn icon={<Database  className="size-4" />} label="バックアップ"
              onClick={(e) => openMenu('backup', e.currentTarget as HTMLElement)} />
            <ToolBtn icon={<RotateCcw className="size-4" />} label="復元"
              onClick={(e) => openMenu('restore', e.currentTarget as HTMLElement)} />
             <div className="w-px h-5 bg-white/15 mx-1" />
             <ToolBtn icon={<Plus className="size-4" />} label="新規" onClick={onNewWindow} />
           </div>
         </div>
       </header>

       {/* Desktop layer (header / footer の間) */}
       <div className="absolute left-0 right-0 overflow-hidden" style={{ top: 48, bottom: 28 }}>
         {children}
       </div>
      {/* アンカードロップダウン */}
      {menu && (
        <Dropdown
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={
            menu.kind === 'git'
              ? [
                  { icon:<GitBranch className="size-4" />, label:'ブランチ状態', onSelect:()=>{ closeMenu(); onOpenPanel('git','status'); } },
                  { icon:<GitCommit  className="size-4" />, label:'コミット',     onSelect:()=>{ closeMenu(); onOpenPanel('git','commit'); } },
                  { icon:<GitPullRequest className="size-4" />, label:'プル',    onSelect:()=>{ closeMenu(); onOpenPanel('git','pull'); } },
                  { icon:<Upload className="size-4" />, label:'プッシュ',        onSelect:()=>{ closeMenu(); onOpenPanel('git','push'); } },
                ]
              : menu.kind === 'backup'
              ? [
                  { icon:<List className="size-4" />, label:'バックアップ一覧', onSelect:()=>{ closeMenu(); onOpenPanel('backup','list'); } },
                  { icon:<Plus className="size-4" />, label:'バックアップ作成…', onSelect:()=>{ closeMenu(); onOpenPanel('backup','create'); } },
                ]
              : [
                  { icon:<RotateCcw className="size-4" />, label:'最新に復元',      onSelect:()=>{ closeMenu(); onOpenPanel('restore','latest'); } },
                  { icon:<List className="size-4" />,      label:'バックアップを選択…', onSelect:()=>{ closeMenu(); onOpenPanel('restore','choose'); } },
                ]
          }
        />
      )}

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

 function ToolBtn({ icon, label, onClick }:{
  icon: React.ReactNode; label: string; onClick: (e:React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-2 h-8 text-white hover:bg-white/10 active:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/20"
      title={label}
    >
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  );
}
function Dropdown({
  x, y, items, onClose,
}:{
  x:number; y:number;
  items:{icon:React.ReactNode; label:string; onSelect:()=>void;}[];
  onClose:()=>void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e:KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e:MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick); };
  }, [onClose]);
  // 画面端ガード
  const left = Math.min(x, window.innerWidth - 280);
  return (
    <div className="fixed z-[60]" style={{ left, top: y }}>
      <div ref={ref} className="w-[260px] rounded-xl bg-white shadow-xl border border-slate-200 p-1">
        {items.map((it, i) => (
          <button key={i}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 active:bg-slate-100 text-slate-900 text-[15px]"
            onClick={it.onSelect}
          >
            <span className="text-slate-700">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
