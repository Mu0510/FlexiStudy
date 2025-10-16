"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Sidebar } from "@/components/sidebar"
import { Dashboard } from "@/components/dashboard"
import { DashboardContainer } from "@/components/dashboard-container"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import { useChat } from '@/hooks/useChat';

const StudyRecords = dynamic(() => import("@/components/study-records").then(mod => mod.StudyRecords), {
  ssr: false,
});
import { Analytics } from "@/components/analytics"
import { ExamAnalysis } from "@/components/exam-analysis"
import { Settings } from "@/components/settings"

import { NewChatPanel } from "@/components/new-chat-panel"
import { toast } from "sonner"
import { useDbLiveSync } from "@/hooks/useDbLiveSync"
import { reconcileDashboard, reconcileLogData } from "@/lib/reconcile"
import { MobileHeader } from "@/components/mobile-header"
import { useWebSocket } from "@/context/WebSocketContext"
import { useOnlineStatus } from "@/hooks/useOnlineStatus"

// Define Goal type, ideally this would be in a shared types file
interface Goal {
  id: string | number;
  completed: boolean;
  subject: string;
  task: string;
  details?: string;
  tags?: string[];
  total_problems?: number | null;
  completed_problems?: number | null;
}

export default function StudyApp() {
  const [activeView, setActiveView] = useState("records")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  
  const [isNewChatOpen, setIsNewChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [isFullScreen, setIsFullScreen] = useState(false);
  
  const [logData, setLogData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });
  const [uniqueSubjects, setUniqueSubjects] = useState<string[]>([]);
  const [subjectColors, setSubjectColors] = useState<Record<string, string>>({});
  const [dashboardData, setDashboardData] = useState(null);
  const [selectedGoalForChat, setSelectedGoalForChat] = useState<Goal | null>(null);
  const [selectedFilesForChat, setSelectedFilesForChat] = useState<File[]>([]);
  const [selectedSessionForChat, setSelectedSessionForChat] = useState<any | null>(null);

  const chatStateBeforeSystemView = useRef(false);
  const restartInFlightRef = useRef<Set<string>>(new Set());
  const online = useOnlineStatus();
  const { subscribe } = useWebSocket();

  const { messages, activeMessage, isGeneratingResponse, isNotifyBusy, notifyBusyReason, isModelRestarting, modelRestartReason, sendMessage, refreshChat, handoverSnapshot, cancelSendMessage, requestHistory, isFetchingHistory, historyFinished, clearMessages, sendToolApproval } = useChat({
    onMessageReceived: () => {
      // messagesContainerRef は NewChatPanel 内にあるため、ここでは直接操作できない
      // NewChatPanel 内でスクロールロジックを維持する
    },
  });
  // expose tool approval via ws from useChat (ts loose cast)
  const chatApprove = (useChat as any) ? (null as any) : null;

  const notifyLockMessage = isNotifyBusy
    ? notifyBusyReason === 'reminder'
      ? 'リマインダーを処理中です…'
      : notifyBusyReason === 'context_pending'
        ? 'コンテキスト保留を処理中です…'
        : notifyBusyReason === 'context_active'
          ? 'モード切り替えを反映中です…'
          : '通知を生成中です…'
    : undefined;

  const restartLockMessage = modelRestartReason === 'refresh'
    ? 'Geminiをリフレッシュしています…'
    : modelRestartReason === 'model-change'
      ? 'モデルを切り替えています…'
      : modelRestartReason === 'handover'
        ? 'ハンドオーバー要約を作成しています…'
        : 'Geminiを再起動中です…';

  const fetchDashboardData = useCallback(async () => {
    const weeklyPeriod = localStorage.getItem('weeklyPeriod') || 'this_week';
    const weeklyPeriodDays = weeklyPeriod === '7_days' ? 7 : null;
    const weekStart = localStorage.getItem('weekStart') || 'sunday';
    
    try {
      let apiUrl = '/api/dashboard';
      const params = new URLSearchParams();
      if (weeklyPeriodDays) params.set('weekly_period', String(weeklyPeriodDays));
      if (weekStart) params.set('week_start', weekStart);
      const qs = params.toString();
      if (qs) apiUrl += `?${qs}`;
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      setDashboardData((prev: any) => reconcileDashboard(prev, data));
    } catch (e) {
      console.error("Failed to fetch dashboard data:", e);
    }
  }, []);

  // On first mount, sync server settings into localStorage then fetch dashboard
  useEffect(() => {
    const sync = async () => {
      try {
        const r = await fetch('/api/settings?keys=weeklyPeriod,weekStart,tools.yolo');
        const data = await r.json();
        const s = data?.settings || {};
        let changed = false;
        if (s['weeklyPeriod']) { try { localStorage.setItem('weeklyPeriod', String(s['weeklyPeriod'])); changed = true; } catch {} }
        if (s['weekStart']) { try { localStorage.setItem('weekStart', String(s['weekStart'])); changed = true; } catch {} }
        if (typeof s['tools.yolo'] === 'boolean') { try { localStorage.setItem('tools.yolo', String(Boolean(s['tools.yolo']))); } catch {} }
        if (changed) fetchDashboardData();
      } catch {}
    };
    sync();
  }, [fetchDashboardData]);

  const fetchLogData = useCallback(async (date: string) => {
    console.log(`[page.tsx] fetchLogData triggered for date: ${date}`);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/logs/${date}`, { cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 404) {
          setLogData(null);
        } else {
          const errorText = await response.text();
          let errorDetails = `HTTP error! status: ${response.status}`;
          try {
            const errorData = JSON.parse(errorText);
            errorDetails = errorData.details || errorDetails;
          } catch (e) {
            console.error("Failed to parse error response as JSON:", errorText);
            errorDetails = errorText;
          }
          throw new Error(errorDetails);
        }
      } else {
        const rawData = await response.json();
        const transformedData = {
          ...rawData,
          sessions: rawData.sessions.map((session: any) => ({
            ...session,
            start_time: session.session_start_time,
            end_time: session.session_end_time,
            total_duration: session.total_study_minutes,
            logs: session.details
              .map((detail: any) => ({ ...detail, type: detail.event_type }))
              .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
          })),
        };
        setLogData((prev: any) => reconcileLogData(prev, transformedData));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Quiet refresh without toggling loading state or error banners
  const fetchLogDataQuiet = useCallback(async (date: string) => {
    try {
      const response = await fetch(`/api/logs/${date}`, { cache: 'no-store' });
      if (!response.ok) return;
      const rawData = await response.json();
      const transformedData = {
        ...rawData,
        sessions: rawData.sessions.map((session: any) => ({
          ...session,
          start_time: session.session_start_time,
          end_time: session.session_end_time,
          total_duration: session.total_study_minutes,
          logs: session.details
            .map((detail: any) => ({ ...detail, type: detail.event_type }))
            .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()),
        })),
      };
      setLogData((prev: any) => reconcileLogData(prev, transformedData));
    } catch {}
  }, []);

  // Debounced schedulers to coalesce rapid events
  const dashFetchTimerRef = useRef<any>(null);
  const logFetchTimerRef = useRef<any>(null);
  const scheduleFetchDashboard = useCallback(() => {
    if (dashFetchTimerRef.current) clearTimeout(dashFetchTimerRef.current);
    dashFetchTimerRef.current = setTimeout(() => {
      dashFetchTimerRef.current = null;
      fetchDashboardData();
    }, 250);
  }, [fetchDashboardData]);
  const scheduleFetchLogsQuiet = useCallback((date: string) => {
    if (logFetchTimerRef.current) clearTimeout(logFetchTimerRef.current);
    logFetchTimerRef.current = setTimeout(() => {
      logFetchTimerRef.current = null;
      fetchLogDataQuiet(date);
    }, 250);
  }, [fetchLogDataQuiet]);

  const handleViewChange = (view: string) => {
    if (view === 'system-chat') {
      chatStateBeforeSystemView.current = isNewChatOpen;
      setIsNewChatOpen(false);
    } else if (activeView === 'system-chat') {
      setIsNewChatOpen(chatStateBeforeSystemView.current);
    }
    setActiveView(view);
  };

  const handleMaximizeClick = () => {
    handleViewChange('system-chat');
  };

  useEffect(() => {
    fetchLogData(selectedDate);
  }, [selectedDate, fetchLogData]);

  useEffect(() => {
    fetchDashboardData();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'weeklyPeriod' || e.key === 'weekStart') {
        fetchDashboardData();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };

  }, [fetchDashboardData]);

  // DB更新を検出してダッシュボードを自動更新
  // Poll fallback (WS不通時の保険)。間隔を延ばしてサーバ負荷を下げる
  useDbLiveSync(() => scheduleFetchDashboard(), { intervalMs: 30000 });

  // フォーカス復帰・可視化時: ダッシュボードは差分適用、学習記録は静かに再取得
  useEffect(() => {
    const onFocus = () => {
      scheduleFetchDashboard();
      scheduleFetchLogsQuiet(selectedDate);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        scheduleFetchDashboard();
        scheduleFetchLogsQuiet(selectedDate);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchDashboardData, fetchLogDataQuiet, selectedDate]);

  // Open chat with a pre-filled prompt from overlays
  useEffect(() => {
    const onOpenWithPrompt = (e: any) => {
      try {
        const text = String(e?.detail?.text || '').trim();
        if (text) setChatInput(text);
        setIsNewChatOpen(true);
      } catch {
        setIsNewChatOpen(true);
      }
    };
    window.addEventListener('chat:open-with-prompt', onOpenWithPrompt as any);
    const onClearHistory = () => {
      try { clearMessages(); } catch {}
    };
    window.addEventListener('chat:clear-history', onClearHistory as any);
    return () => {
      window.removeEventListener('chat:open-with-prompt', onOpenWithPrompt as any);
      window.removeEventListener('chat:clear-history', onClearHistory as any);
    };
  }, []);

  const requestModelRestart = useCallback(async (scope: string) => {
    const normalizedScope = scope === 'background' ? 'background' : 'main';
    if (restartInFlightRef.current.has(normalizedScope)) return;
    restartInFlightRef.current.add(normalizedScope);
    const toastId = `gemini-error-${normalizedScope}`;
    const loadingMessage = normalizedScope === 'background'
      ? 'バックグラウンドGeminiを再初期化しています…'
      : 'Geminiを再起動しています…';
    toast.loading(loadingMessage, { id: toastId, duration: Infinity });
    try {
      const res = await fetch('/api/chat/restart', { method: 'POST' });
      let data: any = null;
      try {
        data = await res.json();
      } catch {}
      const ok = data?.ok ?? res.ok;
      if (!ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      toast.success('再起動リクエストを送信しました', { id: toastId, duration: 5000 });
    } catch (error: any) {
      const message = error?.message || '再起動に失敗しました';
      toast.error(message, {
        id: toastId,
        duration: Infinity,
        action: {
          label: '再試行',
          onClick: () => requestModelRestart(normalizedScope),
        },
      });
    } finally {
      restartInFlightRef.current.delete(normalizedScope);
    }
  }, [restartInFlightRef]);

  // ---- Granular DB events: apply minimal patches ----
  useEffect(() => {
    // helper for YYYY-MM-DD in local time
    const toYMD = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    const todayStr = toYMD(new Date());

    const parseTagsIfNeeded = (tags: any): string[] | undefined => {
      // Keep undefined as undefined to avoid accidentally adding empty arrays everywhere
      if (tags === undefined) return undefined;
      try {
        if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
        if (typeof tags === 'string') {
          const s = tags.trim();
          if (!s) return [];
          try {
            const parsed = JSON.parse(s);
            if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
          } catch {}
          return s.split(',').map((t) => t.trim()).filter(Boolean);
        }
      } catch {}
      return [];
    };

    const unsub = subscribe((msg: any) => {
      const { method, params } = msg || {};
      if (!method) return;

      if (method === 'geminiRestarting') {
        const scope = params?.scope || 'main';
        const message = scope === 'background'
          ? 'バックグラウンドGeminiを再初期化しています…'
          : 'Geminiを再起動中…';
        try { toast.loading(message, { id: `gemini-restart-${scope}`, duration: Infinity }); } catch {}
        return;
      }
      if (method === 'geminiReady') {
        const scope = params?.scope || 'main';
        const message = scope === 'background'
          ? 'バックグラウンドGeminiの初期化が完了しました'
          : 'Geminiの再起動が完了しました';
        try { toast.success(message, { id: `gemini-restart-${scope}`, duration: 4000 }); } catch {}
        try { toast.dismiss(`gemini-error-${scope}`); } catch {}
        return;
      }
      if (method === 'geminiError') {
        const scope = params?.scope || 'main';
        const message = params?.message || 'Geminiでエラーが発生しました';
        const scopeLabel = scope === 'background' ? 'バックグラウンドGemini' : 'Gemini';
        try {
          toast.error(`${scopeLabel}でエラーが発生しました: ${message}`, {
            id: `gemini-error-${scope}`,
            duration: Infinity,
            action: {
              label: '再起動',
              onClick: () => requestModelRestart(scope),
            },
          });
        } catch {}
        return;
      }

      if (!params) return;

      // Server-initiated notification: show via Service Worker
      if (method === 'notify') {
        const n = params?.notification || {};
        (async () => {
          try {
            if (!('Notification' in window)) return;
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') return;
            if ('serviceWorker' in navigator) {
              const reg = await navigator.serviceWorker.ready;
              await reg.showNotification(n.title || '通知', {
                body: n.body || '', icon: '/FlexiStudy_icon.svg', badge: '/FlexiStudy_icon.svg',
                tag: n.tag || 'general', data: { url: n.action_url || '/' }, requireInteraction: false,
              });
            } else {
              new Notification(n.title || '通知', { body: n.body || '' });
            }
          } catch {}
        })();
        return;
      }

      // Goals → Dashboard.todayGoals を最小パッチ + StudyRecords.daily_summary.goals をピンポイント更新
      if (method === 'goalAdded' || method === 'goalUpdated' || method === 'goalDeleted') {
        const g = params.data || {};
        const id = params.rowId ?? g.id;
        const date = g.date;
        // 今日の目標（ダッシュボード）
        if (date === todayStr) {
          setDashboardData((prev: any) => {
            if (!prev) return prev;
            const list: any[] = Array.isArray(prev.todayGoals) ? prev.todayGoals : [];
            let nextList = list;
            if (method === 'goalDeleted') {
              nextList = list.filter(it => it.id !== id);
            } else {
              const idx = list.findIndex(it => it.id === id);
              const normalized = { ...g, tags: parseTagsIfNeeded(g?.tags) };
              const item = idx >= 0 ? { ...list[idx], ...normalized } : normalized;
              nextList = idx >= 0 ? list.map((it, i) => (i === idx ? item : it)) : [...list, item];
            }
            if (nextList === list) return prev;
            return { ...prev, todayGoals: nextList };
          });
        }

        // 選択日の目標（学習記録パネル）
        if (date === selectedDate) {
          setLogData((prev: any) => {
            if (!prev || !prev.daily_summary) return prev;
            if (prev.daily_summary?.date !== selectedDate) return prev;
            const goals: any[] = Array.isArray(prev.daily_summary.goals) ? prev.daily_summary.goals : [];
            let nextGoals = goals;
            if (method === 'goalDeleted') {
              nextGoals = goals.filter(it => it.id !== id);
            } else {
              const idx = goals.findIndex(it => it.id === id);
              const normalized = { ...g, tags: parseTagsIfNeeded(g?.tags) };
              const item = idx >= 0 ? { ...goals[idx], ...normalized } : normalized;
              nextGoals = idx >= 0 ? goals.map((it, i) => (i === idx ? item : it)) : [...goals, item];
            }
            if (nextGoals === goals) return prev;
            return { ...prev, daily_summary: { ...prev.daily_summary, goals: nextGoals } };
          });
        }
        return;
      }

      // Logs: 作成/削除は静かに再取得、更新はピンポイント更新
      if (method === 'logCreated' || method === 'logDeleted') {
        const l = params.data || {};
        const ts: string = String(l.start_time || '');
        const ymd = ts ? ts.slice(0, 10) : '';
        if (ymd && ymd === selectedDate) scheduleFetchLogsQuiet(selectedDate);
        // ダッシュボードの today stats も更新されうるので軽く再取得（差分適用される）
        if (ymd && ymd === todayStr) scheduleFetchDashboard();
        return;
      }

      if (method === 'logUpdated') {
        const l = params.data || {};
        const ts: string = String(l.start_time || '');
        const ymd = ts ? ts.slice(0, 10) : '';
        if (!(ymd && ymd === selectedDate)) return;

        const toHHMM = (s?: string) => {
          try { if (!s) return undefined as any; const d = new Date(s); const hh = String(d.getHours()).padStart(2,'0'); const mm = String(d.getMinutes()).padStart(2,'0'); return `${hh}:${mm}`; } catch { return undefined as any; }
        };

        setLogData((prev: any) => {
          if (!prev || !Array.isArray(prev.sessions)) return prev;
          let changed = false;
          const nextSessions = prev.sessions.map((sess: any) => {
            // 1) START行のsubject/summary更新 → セッション直値をピンポイント更新
            if (l.event_type === 'START' && Number(sess.session_id) === Number(l.id)) {
              const nextSubject = (l.subject !== undefined ? l.subject : sess.subject);
              const nextSummary = (l.summary !== undefined ? l.summary : sess.summary);
              if (nextSubject !== sess.subject || nextSummary !== sess.summary) {
                changed = true;
                // 後でsubjects再計算
                return { ...sess, subject: nextSubject, summary: nextSummary };
              }
            }

            // 2) セッション内の詳細ログも同期（content/times/durationなど）
            const idx = Array.isArray(sess.logs) ? sess.logs.findIndex((d: any) => Number(d.id) === Number(l.id)) : -1;
            if (idx >= 0) {
              const oldDetail = sess.logs[idx];
              const newStart = toHHMM(l.start_time) ?? oldDetail.start_time;
              const newEnd = (l.end_time ? ` ${toHHMM(l.end_time)}` : (l.end_time === null ? '' : oldDetail.end_time));
              const newDuration = (typeof l.duration_minutes === 'number') ? l.duration_minutes : oldDetail.duration_minutes;
              const updatedDetail = {
                ...oldDetail,
                type: l.event_type || oldDetail.type,
                content: (l.content !== undefined ? l.content : oldDetail.content),
                start_time: newStart,
                end_time: newEnd,
                duration_minutes: newDuration,
              };
              const logs = sess.logs.map((it: any, i: number) => (i === idx ? updatedDetail : it));
              let total = sess.total_duration;
              if (updatedDetail.type === 'START' || updatedDetail.type === 'RESUME') {
                const old = oldDetail.duration_minutes || 0;
                const neu = newDuration || 0;
                if (neu !== old) total = (total || 0) + (neu - old);
              }
              changed = true;
              return { ...sess, logs, total_duration: total };
            }
            return sess;
          });

          if (!changed) return prev;
          // subjects（学習した教科）を再計算
          const subjects = Array.from(new Set(nextSessions.map((s: any) => s.subject))).sort();
          const nextDaily = prev.daily_summary ? { ...prev.daily_summary, subjects } : prev.daily_summary;
          return { ...prev, sessions: nextSessions, daily_summary: nextDaily };
        });

        // ダッシュボード（today）への影響は必要なときだけ軽く再取得
        if (ymd === todayStr) scheduleFetchDashboard();
        return;
      }

      // Undo/Redo等でイベントが取りこぼされるケース: DB全体変更の合図
      if (method === 'databaseUpdated') {
        scheduleFetchDashboard();
        scheduleFetchLogsQuiet(selectedDate);
        return;
      }

      // Daily summary のピンポイント更新
      if (method === 'summaryAdded' || method === 'summaryUpdated' || method === 'summaryDeleted') {
        const s = params.data || {};
        const date = s.date;
        if (date === selectedDate) {
          setLogData((prev: any) => {
            if (!prev || !prev.daily_summary) return prev;
            if (prev.daily_summary?.date !== selectedDate) return prev;
            const nextSummary = (method === 'summaryDeleted') ? null : (s.summary ?? null);
            if (prev.daily_summary.summary === nextSummary) return prev;
            return { ...prev, daily_summary: { ...prev.daily_summary, summary: nextSummary } };
          });
        }
        return;
      }
    });

    return () => unsub();
  }, [subscribe, selectedDate, fetchLogDataQuiet, fetchDashboardData, scheduleFetchDashboard, scheduleFetchLogsQuiet, requestModelRestart]);

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Fetch unique subjects
        const subjectsResponse = await fetch('/api/subjects');
        if (!subjectsResponse.ok) {
          throw new Error(`HTTP error! status: ${subjectsResponse.status}`);
        }
        const subjects = await subjectsResponse.json();
        setUniqueSubjects(subjects);

        // Fetch subject colors
        const colorsResponse = await fetch('/api/colors');
        if (!colorsResponse.ok) {
          throw new Error(`HTTP error! status: ${colorsResponse.status}`);
        }
        const colors = await colorsResponse.json();
        setSubjectColors(colors);

      } catch (e) {
        console.error("Failed to fetch initial data:", e);
        // Handle error appropriately in a real app
      }
    };
    fetchInitialData();
  }, []);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
  };

  const handleColorChange = (subject: string, color: string) => {
    setSubjectColors(prevColors => ({
      ...prevColors,
      [subject]: color,
    }));
  };

  const handleSaveColors = async () => {
    try {
      const response = await fetch('/api/colors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(subjectColors),
      });

      if (!response.ok) {
        throw new Error('Failed to save color settings');
      }
    } catch (error) {
      console.error(error);
      throw error; // Re-throw to be caught in the Settings component
    }
  };

  const handleSelectGoal = (goal: Goal) => {
    setSelectedGoalForChat(goal);
    setIsNewChatOpen(true);
  };

  const handleSelectSession = (logEntry: any) => {
    setSelectedSessionForChat(logEntry);
    setIsNewChatOpen(true);
  };

  const handleClearSelectedGoal = () => {
    setSelectedGoalForChat(null);
    setSelectedFilesForChat([]);
  };

  const handleClearSelectedSession = () => {
    setSelectedSessionForChat(null);
  };

  const handleRefresh = useCallback(() => {
    fetchLogData(selectedDate);
  }, [fetchLogData, selectedDate]);

  const renderActiveView = () => {
    switch (activeView) {
      case "dashboard":
        return <DashboardContainer 
                  dashboardData={dashboardData} 
                  subjectColors={subjectColors} 
                  onRefresh={fetchDashboardData} 
                  onSelectGoal={handleSelectGoal}
               />;
      case "records":
        return <StudyRecords
                  logData={logData}
                  onDateChange={handleDateChange}
                  selectedDate={selectedDate}
                  isLoading={isLoading}
                  error={error}
                  subjectColors={subjectColors}
                  onSelectGoal={handleSelectGoal}
                  onSelectSession={handleSelectSession}
                  onRefresh={handleRefresh}
               />;
      case "analytics":
        return <Analytics />;
      case "exams":
        return <ExamAnalysis />;
      case "settings":
        return <Settings 
                  uniqueSubjects={uniqueSubjects} 
                  subjectColors={subjectColors}
                  onColorChange={handleColorChange}
                  onSaveColors={handleSaveColors}
                />;
      case "system-chat":
        return <NewChatPanel 
                  showAs="embedded"
                  messages={messages}
                  activeMessage={activeMessage}
                  isGeneratingResponse={isGeneratingResponse}
                  sendMessage={sendMessage}
                  cancelSendMessage={cancelSendMessage}
                  requestHistory={requestHistory}
                  isFetchingHistory={isFetchingHistory}
                  historyFinished={historyFinished}
                  clearMessages={clearMessages}
                  refreshChat={refreshChat}
                  handoverSnapshot={handoverSnapshot}
                  sendToolApproval={sendToolApproval as any}
                  input={chatInput}
                  setInput={setChatInput}
                  selectedFiles={selectedFilesForChat}
                  setSelectedFiles={setSelectedFilesForChat}
                  inputLocked={isNotifyBusy || isModelRestarting}
                  lockMessage={isModelRestarting ? restartLockMessage : notifyLockMessage}
                  selectedGoal={selectedGoalForChat}
                  onClearSelectedGoal={handleClearSelectedGoal}
                  selectedSession={selectedSessionForChat}
                  onClearSelectedSession={handleClearSelectedSession}
                />;
      default:
        return <Dashboard 
                  dashboardData={dashboardData} 
                  subjectColors={subjectColors} 
                  onSelectGoal={handleSelectGoal}
               />;
    }
  }

  return (
    <div className={`min-h-screen bg-background ${isFullScreen && activeView !== 'system-chat' ? 'overflow-hidden' : ''}`}>
      <div className={isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}>
        <MobileHeader
          onMenuClick={() => setIsMobileMenuOpen(true)}
          onChatClick={() => setIsNewChatOpen(true)}
        />
      </div>

      {/* Mobile: fixed offline banner directly under the header */}
      <div className="lg:hidden">
        {!online && (
          <div className="fixed top-16 left-0 right-0 z-40">
            <div className="w-full bg-yellow-100 text-yellow-800 px-4 py-2 border-y border-yellow-300 text-sm text-center">
              オフラインです。チャット送信は無効化されています。
            </div>
          </div>
        )}
      </div>

      <div className="flex h-screen">
        <div className={isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}>
          <Sidebar
            activeView={activeView}
            onViewChange={handleViewChange}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            isMobileMenuOpen={isMobileMenuOpen}
            setIsMobileMenuOpen={setIsMobileMenuOpen}
          />
        </div>

        <main
          className={`flex-1 transition-all duration-300 flex flex-col max-w-[100vw] ${
            sidebarCollapsed ? "lg:ml-16" : "lg:ml-64"
          } ${isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}`}
        >
          {/* Desktop: header-attached offline banner (outside content panel) */}
          <div className="hidden lg:block">
            {!online && (
              <div className="w-full bg-yellow-100 text-yellow-800 px-4 py-2 border-b border-yellow-300 text-sm text-center">
                オフラインです。チャット送信は無効化されています。
              </div>
            )}
          </div>

          <div className={`flex-1 p-6 ${online ? 'pt-12' : 'pt-24'} lg:pt-6 overflow-y-auto overflow-x-hidden`}>
            <div className="max-w-7xl mx-auto h-full">{renderActiveView()}</div>
          </div>
        </main>

        {/* Floating Chat Button for Desktop */}
        {!isNewChatOpen && activeView !== 'system-chat' && (
          <div className="hidden lg:block fixed bottom-8 right-8 z-50">
            <Button
              onClick={() => setIsNewChatOpen(true)}
              className="rounded-2xl w-14 h-14 bg-white shadow-lg hover:scale-110 transition-transform p-0 flex items-center justify-center focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              <Image
                src="/images/app-icon.png"
                alt="Chat"
                width={48}
                height={48}
                className="rounded-xl"
              />
            </Button>
          </div>
        )}
        
        {activeView !== 'system-chat' && (
          <NewChatPanel
            showAs="floating"
            isOpen={isNewChatOpen} 
            onClose={() => {
              setIsNewChatOpen(false);
              setIsFullScreen(false);
              setSelectedGoalForChat(null);
              setSelectedSessionForChat(null);
            }} 
            isFullScreen={isFullScreen}
            setIsFullScreen={setIsFullScreen}
            onMaximizeClick={handleMaximizeClick}
            selectedGoal={selectedGoalForChat}
            onClearSelectedGoal={handleClearSelectedGoal}
            selectedSession={selectedSessionForChat}
            onClearSelectedSession={handleClearSelectedSession}
            // useChat related props
            messages={messages}
            activeMessage={activeMessage}
            isGeneratingResponse={isGeneratingResponse}
            sendMessage={sendMessage}
            cancelSendMessage={cancelSendMessage}
            requestHistory={requestHistory}
            isFetchingHistory={isFetchingHistory}
            historyFinished={historyFinished}
            clearMessages={clearMessages}
            refreshChat={refreshChat}
            handoverSnapshot={handoverSnapshot}
            sendToolApproval={sendToolApproval as any}
            input={chatInput}
            setInput={setChatInput}
            selectedFiles={selectedFilesForChat}
            setSelectedFiles={setSelectedFilesForChat}
            inputLocked={isNotifyBusy || isModelRestarting}
            lockMessage={isModelRestarting ? restartLockMessage : notifyLockMessage}
          />
        )}
      </div>
    </div>
  )
}
      
