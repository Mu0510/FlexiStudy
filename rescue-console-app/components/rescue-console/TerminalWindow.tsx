"use client";

import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { AttachAddon } from "xterm-addon-attach";
import "xterm/css/xterm.css";

export type TerminalWindowModel = {
  id: string;
  title: string;
  x: number; y: number; w: number; h: number; z: number;
  minimized: boolean; maximized: boolean;
  tabs: { id: string; title: string }[];
  activeTabId: string;
  prev?: { x: number; y: number; w: number; h: number };
};

export function makeNewWindow(opts?: Partial<TerminalWindowModel>): TerminalWindowModel {
  const id = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
  const tabId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
  return {
    id, title: "Rescue Console",
    x: opts?.x ?? 80, y: opts?.y ?? 36,
    w: opts?.w ?? 860, h: opts?.h ?? 520,
    z: opts?.z ?? 10,
    minimized: false, maximized: false,
    tabs: [{ id: tabId, title: "メイン" }],
    activeTabId: tabId,
  };
}

type Props = {
  model: TerminalWindowModel;
  isTop: boolean;
  onChange: (patch: Partial<TerminalWindowModel>) => void;
  onClose: () => void;
  onFocus: () => void;
};

const TAB_H = 32;
const TERM_BG = "#f5f7fa";           // 端末 & アクティブタブの灰
const TOP_GUARD = 0;                 // デスクトップ内の最上端（= ヘッダー下）

export function TerminalWindow({ model, isTop, onChange, onClose, onFocus }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const terminals = useRef<Map<string, { term: Terminal, fitAddon: FitAddon, ws: WebSocket }>>(new Map());
  const resizeRef = useRef<null | {
    mode: 'e'|'s'|'se';
    baseX: number; baseY: number;
    baseW: number; baseH: number;
  }>(null);
  const MIN_W = 640, MIN_H = 360;

  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const host = termHostRef.current;
    if (!host) return;
  
    // 新しいタブが追加されたか確認
    model.tabs.forEach(tab => {
      if (!terminals.current.has(tab.id)) {
        // 新しいTerminalインスタンスを作成
        const term = new Terminal({
          convertEol: true,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 13,
          allowTransparency: true,
          theme: { background: TERM_BG, foreground: "#222", selection: "#cde3ffaa", cursor: "#555", cursorAccent: TERM_BG },
        });
        const fitAddon = new FitAddon();
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${window.location.host}/ws`;
        const ws = new WebSocket(wsUrl);
        const attachAddon = new AttachAddon(ws);
  
        term.loadAddon(fitAddon);
        term.loadAddon(attachAddon);
  
        ws.onopen = () => term.writeln("\x1b[1mRescue Console v2\x1b[0m へようこそ。");
        ws.onerror = (e) => term.writeln(`\r\n\x1b[31mWebSocket Error: ${e.type}\x1b[0m`);
        ws.onclose = () => term.writeln('\r\n\x1b[31mConnection closed.\x1b[0m');
  
        terminals.current.set(tab.id, { term, fitAddon, ws });
      }
    });
  
    // 削除されたタブのインスタンスを破棄
    const currentTabIds = new Set(model.tabs.map(t => t.id));
    for (const [tabId, { term, ws }] of terminals.current.entries()) {
      if (!currentTabIds.has(tabId)) {
        term.dispose();
        ws.close();
        terminals.current.delete(tabId);
      }
    }
  
    // アクティブなタブのターミナルをホストにアタッチ
    const activeTerminal = terminals.current.get(model.activeTabId);
    if (activeTerminal && host) {
      // 既存の子要素をクリア
      while (host.firstChild) {
        host.removeChild(host.firstChild);
      }
      activeTerminal.term.open(host);
      activeTerminal.fitAddon.fit();
      activeTerminal.term.focus();
    }
  
    // ウィンドウリサイズ時の追従
    const resizeObserver = new ResizeObserver(() => {
      const active = terminals.current.get(model.activeTabId);
      if (active) {
        requestAnimationFrame(() => active.fitAddon.fit());
      }
    });
    if (host) {
      resizeObserver.observe(host);
    }
  
    return () => {
      if (host) {
        resizeObserver.unobserve(host);
      }
    };
  }, [model.tabs, model.activeTabId]);
  
  // コンポーネントのアンマウント時にすべてのターミナルを破棄
  useEffect(() => {
    return () => {
      for (const { term, ws } of terminals.current.values()) {
        term.dispose();
        ws.close();
      }
      terminals.current.clear();
    };
  }, []);


  /* Z順 */
  const onPointerDown = () => onFocus();

  /* ドラッグ（タブ帯の余白） */
  useEffect(() => {
    const el = tabbarRef.current;
    if (!el) return;
    let startX = 0, startY = 0, baseX = 0, baseY = 0, raf = 0;

    const down = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if ((target as HTMLElement).closest("[data-drag-cancel='true']")) return;
      if (model.maximized || model.minimized) return;
      setDragging(true);
      startX = e.clientX; startY = e.clientY; baseX = model.x; baseY = model.y;
      (document.activeElement as HTMLElement | null)?.blur?.();
      const move = (e: PointerEvent) => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const nx = baseX + (e.clientX - startX);                 // x は自由
          const ny = Math.max(TOP_GUARD, baseY + (e.clientY - startY)); // y はヘッダー下まで
          rootRef.current!.style.left = nx + "px";
          rootRef.current!.style.top  = ny + "px";
        });
      };
      const up = (e: PointerEvent) => {
        setDragging(false);
        cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const nx = baseX + (e.clientX - startX);
        const ny = Math.max(TOP_GUARD, baseY + (e.clientY - startY));
        onChange({ x: nx, y: ny });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    };

    el.addEventListener("pointerdown", down);
    return () => el.removeEventListener("pointerdown", down);
  }, [model.x, model.y, model.maximized, model.minimized, onChange]);

  function startResizeListeners() {
    const onMove = (e: PointerEvent) => {
      const rs = resizeRef.current; if (!rs) return;
      let w = rs.baseW, h = rs.baseH;
      if (rs.mode === 'e' || rs.mode === 'se') w = Math.max(MIN_W, rs.baseW + (e.clientX - rs.baseX));
      if (rs.mode === 's' || rs.mode === 'se') h = Math.max(MIN_H, rs.baseH + (e.clientY - rs.baseY));
      // 反映は style 直書き（描画滑らか）→ pointerup で state 反映
      if (rootRef.current) {
        rootRef.current.style.width  = w + 'px';
        rootRef.current.style.height = h + 'px';
      }
    };
    const onUp = (e: PointerEvent) => {
      const rs = resizeRef.current; if (!rs) return;
      resizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // 最終値をcommit
      const dx = e.clientX - rs.baseX;
      const dy = e.clientY - rs.baseY;
      const w = Math.max(MIN_W, rs.baseW + (rs.mode !== 's' ? dx : 0));
      const h = Math.max(MIN_H, rs.baseH + (rs.mode !== 'e' ? dy : 0));
      onChange({ w, h });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  /* ヘッダーボタン（−／□／×） */
  const minimize = () => onChange({ minimized: true });
  const maximize = () => {
    if (model.maximized) return;
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    onChange({
      prev: { x: model.x, y: model.y, w: model.w, h: model.h },   // ← 保存
      maximized: true,
      minimized: false,
      x: 0, y: TOP_GUARD,
      w: parent.clientWidth,
      h: parent.clientHeight,
    });
  };

  // 復元
  const restore = () => {
    const parent = rootRef.current?.parentElement;
    const pv = model.prev;
    if (!parent || !pv) { onChange({ maximized: false, minimized: false }); return; }
    const w = Math.min(pv.w, parent.clientWidth);
    const h = Math.min(pv.h, parent.clientHeight);
    const x = pv.x;                          // 左右・下はみ出しOK
    const y = Math.max(TOP_GUARD, pv.y);     // 上だけガード
    onChange({ maximized: false, minimized: false, x, y, w, h, prev: null });
  };

  /* タブ */
  const activateTab = (id: string) => onChange({ activeTabId: id });
  const closeTab = (id: string) => {
    if (model.tabs.length === 1) { onClose(); return; }
    const next = model.tabs.filter(t => t.id !== id);
    onChange({ tabs: next, activeTabId: next[0].id });
  };
  const newTab = () => {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    onChange({ tabs: [...model.tabs, { id, title: "Terminal" }], activeTabId: id });
  };

  /* グローバルメニュー → 最前面ウィンドウだけ反応 */
  useEffect(() => {
    const handler = (e: Event) => {
      const { detail } = e as CustomEvent<{ kind: string }>;
      if (!isTop) return;
      openModal(detail.kind);
    };
    window.addEventListener("rc-global", handler as EventListener);
    return () => window.removeEventListener("rc-global", handler as EventListener);
  }, [isTop]);

  if (model.minimized) return null;

  const isMax = model.maximized;
  const style: React.CSSProperties = isMax
    ? { left: 0, top: 0, width: "100%", height: "100%" }
    : { left: model.x, top: model.y, width: model.w, height: model.h };

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      style={{ ...style, zIndex: model.z, transform: "translateZ(0)", willChange: "transform" }}
      className="absolute rounded-lg border border-neutral-200 bg-white shadow-md overflow-hidden"
    >
      {/* タブ帯（ウィンドウヘッダーは作らない） */}
      <div ref={tabbarRef} className="relative flex items-center h-8 border-b border-slate-200 bg-white">
        {/* タブ列：コントロールの左まで広がる。空き部分クリックでもドラッグ可能 */}
        <div className="flex items-end pl-4 gap-2 min-w-0 flex-auto overflow-hidden">
          {model.tabs.map(t => {
            const active = t.id === model.activeTabId;
            const base = active
              ? "text-slate-900 -mb-px border-x border-t border-b-0 border-slate-300"
              : "bg-white text-slate-700 hover:text-slate-900";
            return (
              <div
                key={t.id}
                className={`group relative flex items-center rounded-t-md h-7 text-[13px] select-none ${base}
                       flex-[0_1_220px] min-w-[84px] max-w-[260px] px-3 cursor-pointer`}
                style={active ? { backgroundColor: TERM_BG } : undefined}   // ← 必ず灰
                data-drag-cancel="true"                                     // ← ここはドラッグしない
                onClick={() => activateTab(t.id)}                           // ← タブ全体クリックで切替
              >
                <span className="truncate max-w-full select-none">{t.title}</span>
                <button
                  className="ml-auto -mr-1 size-5 grid place-items-center rounded hover:bg-slate-200 active:bg-slate-300"
                  onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
                  aria-label="Close tab" title="Close tab"
                  data-drag-cancel="true"
                >
                  <X className="size-3.5" />
                </button>

                {!active && <span className="pointer-events-none absolute inset-y-1 -left-1 w-px bg-slate-200/50 first:hidden" />}
                {active && <span className="pointer-events-none absolute left-0 right-0 -bottom-px h-px" style={{ background: TERM_BG }} />}
              </div>
            );
          })}
          <button className="ml-1 h-7 px-2 rounded-t-md text-slate-700 hover:bg-slate-100 active:bg-slate-200" onClick={newTab} data-drag-cancel="true">＋</button>
        </div>

        {/* ドラッグ余白：タブが満杯でもここで掴める（常時 56px 以上） */}
        <div className="flex-none w-14 sm:w-16 md:w-20 h-full" title="ドラッグで移動"></div>

        <div className="h-8 flex flex-none" data-drag-cancel="true">
          <WinBtn label="最小化" onClick={minimize} />
          {isMax ? (
            <WinBtn label="元に戻す" onClick={restore} symbol="restore" />
          ) : (
            <WinBtn label="最大化" onClick={maximize} symbol="max" />
          )}
          <WinBtn label="閉じる" onClick={onClose} danger />
        </div>
      </div>

      {/* 本体：ターミナル（アクティブタブと同色で境界ゼロ） */}
      <div className="relative" style={{ height: `calc(100% - ${TAB_H}px)` }}>
        <div ref={termHostRef} className="absolute inset-0" style={{ background: TERM_BG }} />
        {!isMax && (
          <>
            <div
              className="resize-e absolute right-0 top-0 h-full w-1.5 cursor-ew-resize"
              onPointerDown={(e) => {
                e.preventDefault();
                resizeRef.current = { mode:'e', baseX:e.clientX, baseY:e.clientY, baseW:model.w, baseH:model.h };
                startResizeListeners();
              }}
            />
            {/* 下（S） */}
            <div
              className="resize-s absolute left-0 bottom-0 h-1.5 w-full cursor-ns-resize"
              onPointerDown={(e) => {
                e.preventDefault();
                resizeRef.current = { mode:'s', baseX:e.clientX, baseY:e.clientY, baseW:model.w, baseH:model.h };
                startResizeListeners();
              }}
            />
            {/* 右下（SE） */}
            <div
              className="resize-se absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize"
              onPointerDown={(e) => {
                e.preventDefault();
                resizeRef.current = { mode:'se', baseX:e.clientX, baseY:e.clientY, baseW:model.w, baseH:model.h };
                startResizeListeners();
              }}
            />
          </>
        )}
      </div>

      {/* モーダル（簡易） */}
      
    </div>
  );

  /* ---------- モーダル ---------- */
  function openModal(kind: string) {
    const host = rootRef.current!;
    host.querySelectorAll(".rc-modal").forEach(el => el.remove());
    const modal = document.createElement("div");
    modal.className = "rc-modal absolute inset-0 bg-black/10 grid place-items-center";
    modal.innerHTML = `
      <div class="rounded-lg border border-neutral-200 bg-white shadow-xl w-[min(560px,90vw)]">
        <div class="flex items-center justify-between h-10 px-3 border-b border-neutral-200">
          <div class="text-sm font-medium">${titleOf(kind)}</div>
          <button class="rc-close px-2 py-1 rounded hover:bg-neutral-100">×</button>
        </div>
        <div class="p-3 text-sm text-neutral-800">
          ${contentOf(kind)}
        </div>
        <div class="flex items-center justify-end gap-2 h-12 px-3 border-t border-neutral-200">
          <button class="rc-close rounded px-3 py-1.5 border border-neutral-200 hover:bg-neutral-50">閉じる</button>
          <button class="rounded px-3 py-1.5 bg-neutral-900 text-white hover:brightness-95">OK</button>
        </div>
      </div>`;
    modal.querySelectorAll(".rc-close").forEach(b => b.addEventListener("click", () => modal.remove()));
    host.appendChild(modal);
  }
}

/* ---------- ボタン類 ---------- */
function WinBtn({ label, onClick, symbol, danger }: { label: string; onClick: () => void; symbol?: "max"|"restore"; danger?: boolean; }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={[
        "h-8 w-9 grid place-items-center",
        danger ? "hover:bg-red-50 active:bg-red-100" : "hover:bg-slate-50 active:bg-slate-200"
      ].join(" ")}
    >
      {danger ? (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
        </svg>
      ) : symbol === "max" ? (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="2.5" y="2.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.25" fill="none"/>
        </svg>
      ) : symbol === "restore" ? (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="3.5" y="1.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.25" fill="none"/>
          <rect x="1.5" y="3.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.25" fill="none"/>
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12">
          <line x1="2" y1="9.5" x2="10" y2="9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
        </svg>
      )}
    </button>
  );
}

/* ---------- モーダル内容 ---------- */
const titleOf = (k: string) => ({
  "git-menu": "Git",
  "backup-menu": "Backup",
  "restore-menu": "Restore",
}[k] ?? "Action");

const contentOf = (k: string) => {
  switch (k) {
    case "git-menu":
      return `<ul class="space-y-1">
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">git status</button></li>
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">git pull</button></li>
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">git commit…</button></li>
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">git push</button></li>
      </ul>`;
    case "backup-menu":
      return `<ul class="space-y-1">
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">List backups</button></li>
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">Create backup…</button></li>
      </ul>`;
    case "restore-menu":
      return `<ul class="space-y-1">
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">Restore latest</button></li>
        <li><button class="px-2 py-1 rounded border border-neutral-200 hover:bg-neutral-50">Choose backup…</button></li>
      </ul>`;
    default:
      return `…`;
  }
};