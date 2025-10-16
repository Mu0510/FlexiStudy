"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";

interface PwaBackHeaderProps {
  label?: string;
  fallbackHref?: string;
}

export function PwaBackHeader({ label = "戻る", fallbackHref = "/" }: PwaBackHeaderProps) {
  const router = useRouter();
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      // Detect standalone (PWA) modes across platforms
      const mql = window.matchMedia && window.matchMedia("(display-mode: standalone)");
      const standalone = (mql && mql.matches) || (window as any).navigator?.standalone === true;
      setShow(Boolean(standalone));
      const handler = () => setShow((mql && mql.matches) || (window as any).navigator?.standalone === true);
      mql?.addEventListener?.("change", handler as any);
      return () => mql?.removeEventListener?.("change", handler as any);
    } catch {
      setShow(false);
    }
  }, []);

  if (!show) return null;

  const goBack = () => {
    if (history.length > 1) {
      router.back();
    } else {
      router.push(fallbackHref);
    }
  };

  return (
    <div className="sticky top-0 z-50 -mx-6 px-6 py-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      <button
        onClick={goBack}
        className="inline-flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        aria-label={label}
      >
        <ArrowLeft className="w-4 h-4" />
        {label}
      </button>
    </div>
  );
}

