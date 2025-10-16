"use client";

import { useEffect, useState } from "react";
import { PwaBackHeader } from "@/components/pwa-back";

type Item = { name: string; version?: string; license?: any; licenseText?: string };

export default function LicensesPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/licenses', { cache: 'no-store' });
        if (!res.ok) throw new Error(`failed: ${res.status}`);
        const data = await res.json();
        setItems(data.items || []);
      } catch (e: any) {
        setError(e?.message || 'failed to load');
      }
    })();
  }, []);

  return (
    <div className="max-w-4xl mx-auto px-6 py-10 space-y-6">
      <PwaBackHeader />
      <h1 className="text-2xl font-bold">サードパーティライセンス</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        本アプリは以下のオープンソースソフトウェアを利用しています。各ライブラリのライセンスは下記のとおりです。
      </p>
      {error && (
        <p className="text-sm text-red-600">読み込みに失敗しました: {error}</p>
      )}
      <div className="space-y-4">
        {items.map((it) => (
          <details key={it.name} className="rounded border border-slate-200 dark:border-slate-700">
            <summary className="px-3 py-2 cursor-pointer select-none">
              <span className="font-medium">{it.name}</span>
              {it.version && <span className="ml-2 text-xs text-slate-500">v{it.version}</span>}
              {it.license && (
                <span className="ml-2 text-xs text-slate-500">{typeof it.license === 'string' ? it.license : JSON.stringify(it.license)}</span>
              )}
            </summary>
            <div className="px-3 py-2 bg-slate-50 dark:bg-slate-900/40 overflow-x-auto">
              {it.licenseText ? (
                <pre className="text-xs whitespace-pre-wrap">{it.licenseText}</pre>
              ) : (
                <p className="text-xs text-slate-500">ライセンス本文が見つかりませんでした。</p>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
