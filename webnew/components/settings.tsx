"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import type { MouseEvent } from "react"
import { createPortal } from "react-dom"
import Link from "next/link"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { getSubjectStyle } from "@/lib/utils";
import { Bell, Palette, Shield, Save, Loader2, CheckCircle, XCircle, HelpCircle, RefreshCcw, Clock, BellRing, History, CalendarClock, FileText, ServerCog } from "lucide-react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { formatDistanceToNow } from "date-fns"


interface SettingsProps {
  uniqueSubjects: string[];
  subjectColors: Record<string, string>;
  onColorChange: (subject: string, color: string) => void;
  onSaveColors: () => Promise<void>;
}

type ContextMode = {
  mode_id: string;
  display_name: string;
  description?: string | null;
  ai_notes?: string | null;
  knowledge_refs: string[];
  presentation?: Record<string, any> | null;
  created_at?: string;
  updated_at?: string;
};

type ContextPending = {
  id: string;
  mode_id: string;
  source?: string | null;
  payload?: any;
  entered_at: string;
  expires_at?: string | null;
  status: string;
  resolved_at?: string | null;
  resolution?: string | null;
  reason?: string | null;
};

type ContextStateInfo = {
  active_mode_id: string;
  manual_override_mode_id?: string | null;
  active_since?: string;
  updated_at?: string;
};

type ContextStateResponse = {
  state: ContextStateInfo;
  pending: ContextPending[];
};

type NotifyLogEntry = {
  id: number;
  user_id: string;
  decision?: string | null;
  reason?: string | null;
  source?: string | null;
  mode_id?: string | null;
  payload?: any;
  context?: any;
  triggered_at?: string | null;
  created_at: string;
  resend_of?: number | null;
  test?: boolean;
  manual_send?: boolean;
};

type NotifyLogResponse = {
  entries: NotifyLogEntry[];
  total: number;
  limit: number;
  offset: number;
};

type ReminderEntry = {
  id: string;
  user_id: string;
  fire_at: string;
  status: string;
  context?: any;
  purpose?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  meta?: any;
};

export function Settings({ uniqueSubjects, subjectColors, onColorChange, onSaveColors }: SettingsProps) {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  const [notifications, setNotifications] = useState(true)
  const [studyReminders, setStudyReminders] = useState(true)
  const [weeklyReports, setWeeklyReports] = useState(true)
  
  const [todayCount, setTodayCount] = useState<number>(0)
  const [todayCap, setTodayCap] = useState<number>(0)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<null | { decision: string; reason?: string; notification?: { title?: string; body?: string; action_url?: string; tag?: string; category?: string }; sent?: boolean }>(null)
  const [weeklyPeriod, setWeeklyPeriod] = useState('this_week');
  const [weekStart, setWeekStart] = useState<'sunday' | 'monday'>('sunday');
  const SHOW_INTENT_SWITCHES = false; // 学習リマインダー/週次レポートのスイッチは現状未実装のため非表示
  const [appInfo, setAppInfo] = useState<{ version: string | null; lastCommitDate: string | null; git: { branch?: string | null; commit?: string | null } | null } | null>(() => {
    if (typeof window === 'undefined') return null;
    try { const raw = localStorage.getItem('app.info'); return raw ? JSON.parse(raw) : null; } catch { return null; }
  })
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  // Tools / YOLO mode（ローカルキャッシュ優先で即表示。サーバ同期で上書き）
  const [yoloMode, setYoloMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { const v = localStorage.getItem('tools.yolo'); return v === null ? false : v === 'true'; } catch { return false; }
  });
  const [rulesOpen, setRulesOpen] = useState(false);
  const [allowAlways, setAllowAlways] = useState<string[]>([]);
  const [denyAlways, setDenyAlways] = useState<string[]>([]);
  const SHOW_TEMPLATES = false; // 将来的に使うテンプレート群は非表示
  // Chat model selection
  const [chatModel, setChatModel] = useState<'gemini-2.5-flash'|'gemini-2.5-pro'>('gemini-2.5-pro');
  const [initialChatModel, setInitialChatModel] = useState<'gemini-2.5-flash'|'gemini-2.5-pro'>('gemini-2.5-pro');
  const [showModelOverlay, setShowModelOverlay] = useState(false);
  const [isApplyingModel, setIsApplyingModel] = useState(false);
  const [activeTab, setActiveTab] = useState<'context' | 'notify' | 'chat' | 'appearance' | 'info'>('context');
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [reminderDialogOpen, setReminderDialogOpen] = useState(false);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [remindersLoaded, setRemindersLoaded] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [serverRestarting, setServerRestarting] = useState(false);
  const [serverRestartError, setServerRestartError] = useState<string | null>(null);

  const [contextState, setContextState] = useState<ContextStateResponse | null>(null);
  const [contextModes, setContextModes] = useState<ContextMode[]>([]);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextActionPending, setContextActionPending] = useState(false);
  const [notifyLogState, setNotifyLogState] = useState<NotifyLogResponse | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [notifyLogSearch, setNotifyLogSearch] = useState('');
  const [reminders, setReminders] = useState<ReminderEntry[]>([]);
  const [reminderLoading, setReminderLoading] = useState(false);
  const [reminderStatusFilter, setReminderStatusFilter] = useState<'scheduled' | 'queued' | 'dispatched' | 'all'>('scheduled');

  const modesById = useMemo(() => {
    const map = new Map<string, ContextMode>();
    for (const mode of contextModes) {
      if (mode?.mode_id) {
        map.set(mode.mode_id, mode);
      }
    }
    return map;
  }, [contextModes]);

  const activeMode = useMemo(() => {
    const id = contextState?.state?.active_mode_id;
    if (!id) return null;
    return modesById.get(id) || null;
  }, [contextState, modesById]);

  const openChatWithPrompt = useCallback((text: string) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('chat:open-with-prompt', { detail: { text } }));
  }, []);

  const fetchContextState = useCallback(async () => {
    const res = await fetch('/api/context/state', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`context state status ${res.status}`);
    }
    const data = await res.json();
    if (!data?.ok) {
      throw new Error(data?.error || 'コンテキスト状態を取得できませんでした');
    }
    setContextState({
      state: data.state || null,
      pending: Array.isArray(data.pending) ? data.pending : [],
    });
    setContextError(null);
  }, []);

  const fetchContextModes = useCallback(async () => {
    const res = await fetch('/api/context/modes', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`context modes status ${res.status}`);
    }
    const data = await res.json();
    if (!data?.ok) {
      throw new Error(data?.error || 'コンテキストモード一覧を取得できませんでした');
    }
    const modes = Array.isArray(data.modes) ? data.modes : [];
    setContextModes(modes);
  }, []);

  const refreshContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);
    try {
      await Promise.all([fetchContextModes(), fetchContextState()]);
    } catch (error: any) {
      const message = error?.message || 'コンテキスト情報の取得に失敗しました';
      setContextError(message);
      console.error('[Settings] refreshContext failed:', message);
      toast.error(message);
    } finally {
      setContextLoading(false);
    }
  }, [fetchContextModes, fetchContextState]);

  const fetchNotifyLogs = useCallback(async (searchTerm?: string) => {
    setLogLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '10');
      if (searchTerm && searchTerm.trim().length > 0) params.set('search', searchTerm.trim());
      const qs = params.toString();
      const url = qs ? `/api/notify/logs?${qs}` : '/api/notify/logs?limit=10';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`notify logs status ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || '通知履歴を取得できませんでした');
      setNotifyLogState({
        entries: Array.isArray(data.entries) ? data.entries : [],
        total: Number(data.total || 0),
        limit: Number(data.limit || 10),
        offset: Number(data.offset || 0),
      });
      setLogsLoaded(true);
    } catch (error: any) {
      console.error('[Settings] fetchNotifyLogs failed:', error?.message || error);
      toast.error(error?.message || '通知履歴の取得に失敗しました');
    } finally {
      setLogLoading(false);
    }
  }, []);

  const fetchReminders = useCallback(async (status: 'scheduled' | 'queued' | 'dispatched' | 'all') => {
    setReminderLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (status !== 'all') params.set('status', status);
      const qs = params.toString();
      const url = qs ? `/api/notify/reminders?${qs}` : '/api/notify/reminders';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`reminders status ${res.status}`);
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error || 'リマインダー一覧を取得できませんでした');
      setReminders(Array.isArray(data.reminders) ? data.reminders : []);
      setRemindersLoaded(true);
    } catch (error: any) {
      console.error('[Settings] fetchReminders failed:', error?.message || error);
      toast.error(error?.message || 'リマインダーの取得に失敗しました');
    } finally {
      setReminderLoading(false);
    }
  }, []);

  const handleServerRestartRequest = useCallback(async (event?: MouseEvent<HTMLButtonElement>) => {
    if (event) event.preventDefault();
    if (serverRestarting) return;
    setServerRestarting(true);
    setServerRestartError(null);
    try {
      const res = await fetch('/api/server/restart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'dashboard' }),
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {}
      const ok = data?.ok ?? res.ok;
      if (!ok) {
        throw new Error(data?.error || 'HTTPサーバーの再起動に失敗しました');
      }
      if (data?.status === 'in-progress') {
        toast.info('HTTPサーバーの再起動は現在進行中です。接続が復帰するまでお待ちください。');
      } else {
        toast.success('HTTPサーバーの再起動をリクエストしました。数秒後に接続が復帰します。');
      }
      setRestartDialogOpen(false);
    } catch (error: any) {
      const message = error?.message || '再起動のリクエストに失敗しました';
      setServerRestartError(message);
      toast.error(message);
    } finally {
      setServerRestarting(false);
    }
  }, [serverRestarting]);

  const handleRestartDialogOpenChange = useCallback((open: boolean) => {
    if (open) {
      setServerRestartError(null);
    }
    setRestartDialogOpen(open);
  }, []);

  const handleRefreshContext = useCallback(async () => {
    await refreshContext();
    toast.info('コンテキスト情報を更新しました');
  }, [refreshContext]);

  const handleActivateMode = useCallback(async (
    modeId: string,
    options?: { manual?: boolean; pendingId?: string | null; reason?: string | null; resolution?: string | null }
  ) => {
    setContextActionPending(true);
    try {
      const res = await fetch('/api/context/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modeId,
          manual: options?.manual ?? false,
          pendingId: options?.pendingId,
          reason: options?.reason,
          resolution: options?.resolution,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'モード切り替えに失敗しました');
      }
      const label = modesById.get(modeId)?.display_name || modeId;
      toast.success(`「${label}」に切り替えました`);
      await refreshContext();
    } catch (error: any) {
      console.error('[Settings] handleActivateMode failed:', error?.message || error);
      toast.error(error?.message || 'モード切り替えに失敗しました');
    } finally {
      setContextActionPending(false);
    }
  }, [modesById, refreshContext]);

  const handleClearManualOverride = useCallback(async () => {
    const current = contextState?.state?.active_mode_id;
    if (!current) return;
    await handleActivateMode(current, { manual: false, reason: 'manual_override_cleared' });
  }, [contextState, handleActivateMode]);

  const handleConfirmPending = useCallback(async (pending: ContextPending) => {
    await handleActivateMode(pending.mode_id, { manual: false, pendingId: pending.id, resolution: 'confirmed_by_user' });
  }, [handleActivateMode]);

  const handleDismissPending = useCallback(async (pending: ContextPending) => {
    setContextActionPending(true);
    try {
      const res = await fetch('/api/context/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modeId: pending.mode_id,
          event: 'exit',
          source: 'settings-dismiss',
          payload: { pendingId: pending.id, initiated_by: 'settings' },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || '保留を解除できませんでした');
      }
      toast.info('保留状態を解除しました');
      await refreshContext();
    } catch (error: any) {
      console.error('[Settings] handleDismissPending failed:', error?.message || error);
      toast.error(error?.message || '保留状態の解除に失敗しました');
    } finally {
      setContextActionPending(false);
    }
  }, [refreshContext]);

  const handleResendNotification = useCallback(async (entryId: number) => {
    setLogLoading(true);
    try {
      const res = await fetch('/api/notify/logs/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: entryId, userId: 'local' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || '通知を再送できませんでした');
      }
      toast.success('通知を再送しました');
      await fetchNotifyLogs(notifyLogSearch);
    } catch (error: any) {
      console.error('[Settings] handleResendNotification failed:', error?.message || error);
      toast.error(error?.message || '通知の再送に失敗しました');
    } finally {
      setLogLoading(false);
    }
  }, [fetchNotifyLogs, notifyLogSearch]);

  const handleCancelReminder = useCallback(async (id: string) => {
    setReminderLoading(true);
    try {
      const res = await fetch('/api/notify/reminders/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || 'リマインダーを取り消せませんでした');
      }
      toast.success('リマインダーを取り消しました');
      await fetchReminders(reminderStatusFilter);
    } catch (error: any) {
      console.error('[Settings] handleCancelReminder failed:', error?.message || error);
      toast.error(error?.message || 'リマインダーの取り消しに失敗しました');
    } finally {
      setReminderLoading(false);
    }
  }, [fetchReminders, reminderStatusFilter]);

  const handleReminderStatusChange = useCallback((value: string) => {
    setReminderStatusFilter((value as any) || 'scheduled');
  }, []);

  const manualOverrideMode = useMemo(() => {
    const id = contextState?.state?.manual_override_mode_id;
    if (!id) return null;
    return modesById.get(id) || null;
  }, [contextState, modesById]);

  const pendingItems = contextState?.pending || [];
  const logEntries = notifyLogState?.entries || [];
  const reminderFilters = [
    { value: 'scheduled', label: '予定' },
    { value: 'queued', label: '待機' },
    { value: 'dispatched', label: '完了' },
    { value: 'all', label: 'すべて' },
  ] as const;

  const reminderSummary = useMemo(() => {
    const summary = { scheduled: 0, queued: 0, dispatched: 0 };
    for (const reminder of reminders) {
      if (reminder.status === 'scheduled') summary.scheduled += 1;
      else if (reminder.status === 'queued') summary.queued += 1;
      else if (reminder.status === 'dispatched') summary.dispatched += 1;
    }
    return { ...summary, total: reminders.length };
  }, [reminders]);

  const latestLogEntry = useMemo(() => (logEntries.length ? logEntries[0] : null), [logEntries]);
  const panelClass = "rounded-lg border border-slate-200 bg-white/90 p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900/60 space-y-6";
  const panelHeaderClass = "flex flex-col gap-2 md:flex-row md:items-center md:justify-between";

  const parseTimestamp = useCallback((value?: string | null) => {
    if (!value) return null;
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }, []);

  const formatRelativeTime = useCallback((value?: string | null) => {
    const date = parseTimestamp(value);
    if (!date) return null;
    try {
      return formatDistanceToNow(date, { addSuffix: true });
    } catch {
      return null;
    }
  }, [parseTimestamp]);

  const formatLocalDateTime = useCallback((value?: string | null) => {
    const date = parseTimestamp(value);
    if (!date) return value || '';
    try {
      return date.toLocaleString();
    } catch {
      return value || '';
    }
  }, [parseTimestamp]);

  useEffect(() => {
    // Load server-side settings first; fallback to localStorage
    const load = async () => {
      try {
        const r = await fetch('/api/settings?keys=weeklyPeriod,weekStart,tools.yolo,chat.model');
        const data = await r.json();
        const s = data?.settings || {};
        const p = (s['weeklyPeriod'] as string) || localStorage.getItem('weeklyPeriod') || 'this_week';
        const w = (s['weekStart'] as 'sunday'|'monday') || (localStorage.getItem('weekStart') as any) || 'sunday';
        if (typeof s['tools.yolo'] === 'boolean') {
          const v = Boolean(s['tools.yolo']);
          setYoloMode(v);
          try { localStorage.setItem('tools.yolo', String(v)); } catch {}
        }
        // chat model
        const cm = (s['chat.model'] as any) || (localStorage.getItem('chat.model') as any) || 'gemini-2.5-pro';
        const safeModel = (cm === 'gemini-2.5-flash' ? 'gemini-2.5-flash' : 'gemini-2.5-pro') as 'gemini-2.5-flash'|'gemini-2.5-pro';
        setChatModel(safeModel);
        setInitialChatModel(safeModel);
        try { localStorage.setItem('chat.model', safeModel); } catch {}
        setWeeklyPeriod(p);
        setWeekStart(w);
        try { localStorage.setItem('weeklyPeriod', p); localStorage.setItem('weekStart', w); } catch {}
        setSettingsLoaded(true);
      } catch {
        const savedPeriod = localStorage.getItem('weeklyPeriod') || 'this_week';
        setWeeklyPeriod(savedPeriod);
        const savedStart = (localStorage.getItem('weekStart') as 'sunday' | 'monday') || 'sunday';
        setWeekStart(savedStart);
        const cm = (localStorage.getItem('chat.model') as any) || 'gemini-2.5-pro';
        const safeModel = (cm === 'gemini-2.5-flash' ? 'gemini-2.5-flash' : 'gemini-2.5-pro') as 'gemini-2.5-flash'|'gemini-2.5-pro';
        setChatModel(safeModel);
        setInitialChatModel(safeModel);
        setSettingsLoaded(true);
      }
    };
    load();
  }, []);

  const handleWeeklyPeriodChange = (value: string) => {
    setWeeklyPeriod(value);
    localStorage.setItem('weeklyPeriod', value);
    try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'weeklyPeriod', value }) }); } catch {}
    toast.info(`集計期間を「${value === 'this_week' ? '今週' : '過去7日間'}」に変更しました。`);
  };
  const handleWeekStartChange = (value: 'sunday' | 'monday') => {
    setWeekStart(value);
    localStorage.setItem('weekStart', value);
    try { fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'weekStart', value }) }); } catch {}
    toast.info(`週の開始曜日を「${value === 'sunday' ? '日曜' : '月曜'}」に変更しました。`);
  };

  const handleTabChange = useCallback((value: string) => {
    if (value === 'context' || value === 'notify' || value === 'chat' || value === 'appearance' || value === 'info') {
      setActiveTab(value);
    }
  }, []);
  
  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    refreshContext();
  }, [refreshContext]);

  useEffect(() => {
    if (!logDialogOpen) return;
    const timer = setTimeout(() => {
      fetchNotifyLogs(notifyLogSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [logDialogOpen, fetchNotifyLogs, notifyLogSearch]);

  useEffect(() => {
    if (!reminderDialogOpen) return;
    fetchReminders(reminderStatusFilter);
  }, [reminderDialogOpen, reminderStatusFilter, fetchReminders]);

  // Fetch today's count/cap
  const refreshTodayCount = async () => {
    try {
      const r = await fetch('/api/notify/admin/today-count?userId=local', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok) {
        setTodayCount(Number(j.count || 0));
        setTodayCap(Number(j.cap || 0));
      }
    } catch {}
  };
  useEffect(() => { refreshTodayCount(); }, []);

  // Push notifications subscribe/unsubscribe on toggle
  const pushEffectReady = useRef(false);

  const enablePush = useCallback(async () => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast.error('通知の許可が必要です');
      setNotifications(false);
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    try {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', subscription: existing }) });
        toast.info('既存のプッシュ購読を使用します');
        return;
      }
    } catch {}
    try {
      const keyRes = await fetch('/api/push/vapidPublicKey');
      const keyJson = await keyRes.json();
      const pub = keyJson?.key;
      if (!pub) {
        toast.error('通知キーが未設定です');
        setNotifications(false);
        return;
      }
      const urlB64ToUint8Array = (base64String: string) => {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = typeof window !== 'undefined' ? window.atob(base64) : Buffer.from(base64, 'base64').toString('binary');
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
        return outputArray;
      };
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(pub) });
      await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', subscription: sub }) });
      toast.success('プッシュ通知を有効化しました');
    } catch (e: any) {
      console.error('Push subscribe failed:', e);
      toast.error(`Push登録に失敗しました: ${e?.message || e}`);
      setNotifications(false);
    }
  }, []);

  const disablePush = useCallback(async () => {
    try {
      if (!('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
    } catch {}
    toast.info('プッシュ通知を無効化しました');
  }, []);

  useEffect(() => {
    let cancelled = false;
    const detectExistingSubscription = async () => {
      try {
        if (!('serviceWorker' in navigator)) {
          if (!cancelled) {
            setNotifications(false);
            pushEffectReady.current = true;
          }
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setNotifications(Boolean(sub));
      } catch {}
      if (!cancelled) pushEffectReady.current = true;
    };
    detectExistingSubscription();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pushEffectReady.current) return;
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    const run = async () => {
      if (notifications) await enablePush();
      else await disablePush();
    };
    run();
  }, [notifications, enablePush, disablePush]);
  useEffect(() => {
    // Fetch app and git info for display（ローカルキャッシュ→上書き）
    fetch('/api/app-info')
      .then((r) => r.json())
      .then((data) => { setAppInfo(data); try { localStorage.setItem('app.info', JSON.stringify(data)); } catch {} })
      .catch(() => {/* keep cached */})
  }, [])

  const handleSave = async () => {
    try {
      await onSaveColors();
      toast.success("色の設定を保存しました。");
    } catch (error) {
      toast.error("色の設定の保存に失敗しました。");
    }
  };

  const handleToggleYolo = async (on: boolean) => {
    setYoloMode(on);
    try { localStorage.setItem('tools.yolo', String(on)); } catch {}
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'tools.yolo', value: on }) });
      toast.success(on ? 'YOLOモードを有効化（自動許可）' : 'YOLOモードを無効化（実行前に確認）');
    } catch (e) {
      toast.error('設定の保存に失敗しました');
    }
  };

  const handleApplyChatModel = async () => {
    try {
      setIsApplyingModel(true);
      // 1) Save model to settings
      try {
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'chat.model', value: chatModel }) });
        try { localStorage.setItem('chat.model', chatModel); } catch {}
      } catch (e) {
        toast.error('モデル設定の保存に失敗しました');
        setIsApplyingModel(false);
        return;
      }
      try { window.dispatchEvent(new CustomEvent('chat:model-change-start')); } catch {}
      // 2) Ask server to restart chat backend and clear history
      try {
        const r = await fetch('/api/chat/restart', { method: 'POST' });
        if (!r.ok) throw new Error('restart failed');
      } catch (e) {
        toast.error('チャットの再起動に失敗しました');
        setIsApplyingModel(false);
        try { window.dispatchEvent(new CustomEvent('chat:model-change-cancel')); } catch {}
        return;
      }
      setInitialChatModel(chatModel);
      setShowModelOverlay(false);
      setIsApplyingModel(false);
      toast.success('モデルを切り替え、要約を引き継ぎました');
    } catch {
      setIsApplyingModel(false);
    }
  };

  const loadToolRules = async () => {
    try {
      const res = await fetch('/api/settings?keys=tools.allowAlways,tools.denyAlways');
      const data = await res.json();
      const s = data?.settings || {};
      setAllowAlways(Array.isArray(s['tools.allowAlways']) ? s['tools.allowAlways'] : []);
      setDenyAlways(Array.isArray(s['tools.denyAlways']) ? s['tools.denyAlways'] : []);
    } catch {}
  };
  const openRules = async () => { await loadToolRules(); setRulesOpen(true); };
  const removeRule = async (list: 'allow'|'deny', key: string) => {
    const arr = (list === 'allow' ? allowAlways : denyAlways).filter(k => k !== key);
    list === 'allow' ? setAllowAlways(arr) : setDenyAlways(arr);
    try {
      await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: list === 'allow' ? 'tools.allowAlways' : 'tools.denyAlways', value: arr }) });
    } catch {}
  };

  if (!mounted || !settingsLoaded) {
    return null
  }

  return (
    <div className="space-y-10 pt-16 lg:pt-0">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold text-slate-800 dark:text-slate-100">設定</h1>
        <p className="text-slate-600 dark:text-slate-400">アプリの設定をカスタマイズしましょう。</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-8">
        <TabsList className="flex h-auto w-full flex-wrap items-stretch justify-start gap-2 rounded-xl border border-slate-200 bg-white/80 px-1 py-1 shadow-sm dark:border-slate-700 dark:bg-slate-900/60">
          <TabsTrigger value="context" className="flex h-10 flex-[1_1_150px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:hover:text-slate-100">
            <CalendarClock className="h-4 w-4" />コンテキスト
          </TabsTrigger>
          <TabsTrigger value="notify" className="flex h-10 flex-[1_1_150px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:hover:text-slate-100">
            <Bell className="h-4 w-4" />通知・リマインダー
          </TabsTrigger>
          <TabsTrigger value="chat" className="flex h-10 flex-[1_1_140px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:hover:text-slate-100">
            <History className="h-4 w-4" />チャット
          </TabsTrigger>
          <TabsTrigger value="appearance" className="flex h-10 flex-[1_1_140px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:hover:text-slate-100">
            <Palette className="h-4 w-4" />表示
          </TabsTrigger>
          <TabsTrigger value="info" className="flex h-10 flex-[1_1_150px] items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 text-sm font-medium text-slate-600 transition-colors duration-150 hover:text-slate-900 data-[state=active]:bg-slate-900 data-[state=active]:text-white data-[state=active]:shadow-sm dark:text-slate-300 dark:hover:text-slate-100">
            <FileText className="h-4 w-4" />アプリ情報
          </TabsTrigger>
        </TabsList>

        <TabsContent value="context" className="space-y-6">
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <CalendarClock className="mt-1 h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">コンテキスト切り替え</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">モードの状態と保留中のシグナルを確認します。</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRefreshContext}
                  disabled={contextLoading}
                >
                  <RefreshCcw className="mr-1 h-4 w-4" />再読み込み
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openChatWithPrompt('モードの使い分け例を教えて')}
                >
                  <HelpCircle className="mr-1 h-4 w-4" />活用例を聞く
                </Button>
              </div>
            </div>

            {contextError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
                {contextError}
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">現在のモード</div>
                <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{activeMode?.display_name ?? 'デフォルト'}</div>
                {activeMode?.description && (
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-400 whitespace-pre-line">
                    {activeMode.description}
                  </p>
                )}
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  切替時刻: {formatLocalDateTime(contextState?.state?.active_since) || '—'}
                  {formatRelativeTime(contextState?.state?.active_since) && (
                    <span className="ml-1">({formatRelativeTime(contextState?.state?.active_since)})</span>
                  )}
                </div>
                {manualOverrideMode && (
                  <div className="mt-3 inline-flex items-center gap-2 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                    <History className="h-3 w-3" />手動固定中: {manualOverrideMode.display_name}
                  </div>
                )}
                {manualOverrideMode && (
                  <div className="mt-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleClearManualOverride}
                      disabled={contextActionPending}
                    >
                      <History className="mr-1 h-4 w-4" />自動判断に戻す
                    </Button>
                  </div>
                )}
              </div>

              <div className="rounded-md border border-slate-200/80 bg-white/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                  <Clock className="h-4 w-4" />保留中のシグナル
                  <Badge variant="outline" className="text-xs">
                    {pendingItems.length}
                  </Badge>
                </div>
                {pendingItems.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">保留中の切り替え候補はありません。</p>
                ) : (
                  <ul className="mt-3 space-y-3 text-sm text-slate-600 dark:text-slate-300">
                    {pendingItems.map((pending) => {
                      const mode = modesById.get(pending.mode_id);
                      const relative = formatRelativeTime(pending.entered_at);
                      return (
                        <li key={pending.id} className="rounded-md border border-slate-200/70 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-900/50">
                          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-slate-800 dark:text-slate-100">{mode?.display_name || pending.mode_id}</span>
                                <Badge variant="outline" className="text-xs text-slate-500 dark:text-slate-300">{pending.status}</Badge>
                              </div>
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                受付: {formatLocalDateTime(pending.entered_at)}
                                {relative && <span className="ml-1">({relative})</span>}
                              </div>
                              {pending.reason && (
                                <div className="text-xs text-slate-500 dark:text-slate-400">理由: {pending.reason}</div>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="default"
                                size="sm"
                                onClick={() => handleConfirmPending(pending)}
                                disabled={contextActionPending}
                              >
                                <CheckCircle className="mr-1 h-4 w-4" />承認
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDismissPending(pending)}
                                disabled={contextActionPending}
                              >
                                <XCircle className="mr-1 h-4 w-4" />保留解除
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleActivateMode(pending.mode_id, { manual: true })}
                                disabled={contextActionPending}
                              >
                                <BellRing className="mr-1 h-4 w-4" />このモードに切り替え
                              </Button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium text-slate-700 dark:text-slate-300">登録済みモード</div>
              {contextModes.length === 0 ? (
                <div className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400">
                  まだカスタムモードはありません。ショートカットや AI から作成できます。
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {contextModes.map((mode) => {
                    const isActive = contextState?.state?.active_mode_id === mode.mode_id;
                    const isManual = manualOverrideMode?.mode_id === mode.mode_id;
                    return (
                      <div key={mode.mode_id} className="rounded-md border border-slate-200/80 bg-white/70 p-3 dark:border-slate-700 dark:bg-slate-900/50">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-800 dark:text-slate-100">{mode.display_name}</span>
                          {isActive && <Badge variant="secondary" className="text-xs">現在</Badge>}
                          {isManual && <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-200">手動</Badge>}
                        </div>
                        {mode.ai_notes && (
                          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-line line-clamp-3">
                            {mode.ai_notes}
                          </p>
                        )}
                        {mode.knowledge_refs && mode.knowledge_refs.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {mode.knowledge_refs.slice(0, 4).map((ref, idx) => (
                              <Badge key={`${mode.mode_id}-ref-${idx}`} variant="outline" className="text-xs">
                                {ref}
                              </Badge>
                            ))}
                            {mode.knowledge_refs.length > 4 && (
                              <Badge variant="outline" className="text-xs">+{mode.knowledge_refs.length - 4}件</Badge>
                            )}
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleActivateMode(mode.mode_id, { manual: true })}
                            disabled={contextActionPending}
                          >
                            <BellRing className="mr-1 h-4 w-4" />手動で切り替え
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openChatWithPrompt(`モード「${mode.display_name}」の役割を整理したい`)}
                          >
                            AI に相談
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="notify" className="space-y-6">
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <Bell className="mt-1 h-5 w-5 text-green-600 dark:text-green-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">通知設定</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">通知の有効化やテスト送信を管理します。</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="notifications" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    プッシュ通知
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">アプリからの通知を受け取る</p>
                </div>
                <Switch id="notifications" checked={notifications} onCheckedChange={setNotifications} />
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-slate-700 dark:text-slate-300">今日の送信数</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{todayCap ? `${todayCount} / ${todayCap}` : `${todayCount}`}</div>
                </div>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      const r = await fetch('/api/notify/admin/reset-today-count', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local' }) });
                      const j = await r.json();
                      if (j?.ok) {
                        toast.success('今日の通知カウントをリセットしました');
                        refreshTodayCount();
                      } else {
                        toast.error('リセットに失敗しました');
                      }
                    } catch {
                      toast.error('リセットに失敗しました');
                    }
                  }}
                >リセット</Button>
              </div>

              {SHOW_INTENT_SWITCHES && (
                <>
                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="studyReminders" className="text-base font-medium text-slate-800 dark:text-slate-200">
                        学習リマインダー
                      </Label>
                      <p className="text-sm text-slate-600 dark:text-slate-400">設定した時間に学習を促す通知</p>
                    </div>
                    <Switch id="studyReminders" checked={studyReminders} onCheckedChange={setStudyReminders} />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label htmlFor="weeklyReports" className="text-base font-medium text-slate-800 dark:text-slate-200">
                        週次レポート
                      </Label>
                      <p className="text-sm text-slate-600 dark:text-slate-400">毎週の学習サマリーを受け取る</p>
                    </div>
                    <Switch id="weeklyReports" checked={weeklyReports} onCheckedChange={setWeeklyReports} />
                  </div>
                </>
              )}

              <div className="rounded-md border border-dashed border-slate-300 px-3 py-3 dark:border-slate-600">
                <div className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">通知テスト（目的自動判定）</div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="default"
                    disabled={isTesting}
                    onClick={async () => {
                      setIsTesting(true);
                      setTestResult(null);
                      try {
                        const r = await fetch('/api/notify/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { userId: 'local' } }) });
                        if (r.status === 409) {
                          setTestResult({ decision: 'skip', reason: 'busy (chat/notify in progress)' });
                          toast.info('現在は生成中のためテストを実行できません');
                          return;
                        }
                        const j = await r.json();
                        const p = j?.payload || null;
                        if (p?.decision === 'send' && p?.notification) {
                          await fetch('/api/notify/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', notification: p.notification, test: true }) });
                          setTestResult({ decision: 'send', notification: p.notification, sent: true });
                          toast.success('テスト通知を送信しました');
                          refreshTodayCount();
                        } else {
                          setTestResult({ decision: String(p?.decision || 'skip'), reason: p?.reason || 'no_reason' });
                          toast.info(`送信スキップ: ${p?.reason || 'no_reason'}`);
                        }
                      } catch (e) {
                        setTestResult({ decision: 'error', reason: 'request_failed' });
                        toast.error('通知テストに失敗しました');
                      } finally {
                        setIsTesting(false);
                      }
                    }}
                  >
                    {isTesting ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> 実行中...</span>
                    ) : (
                      '通知をテスト'
                    )}
                  </Button>
                </div>
                {testResult && (
                  <div className="mt-3 space-y-2 rounded-md border border-slate-200 bg-white/80 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/40">
                    <div className="flex items-center gap-2">
                      {testResult.decision === 'send' ? <CheckCircle className="h-4 w-4 text-green-600" /> : testResult.decision === 'error' ? <XCircle className="h-4 w-4 text-red-600" /> : <XCircle className="h-4 w-4 text-slate-400" />}
                      <span className="font-medium">結果: {testResult.decision}</span>
                      {testResult.sent ? <span className="text-green-600">送信済み</span> : null}
                    </div>
                    {testResult.reason && <div className="text-slate-600 dark:text-slate-300">理由: {testResult.reason}</div>}
                    {testResult.notification && (
                      <div className="rounded bg-slate-50 p-2 dark:bg-slate-900/60">
                        <div className="font-semibold text-slate-800 dark:text-slate-100">{testResult.notification.title || '(タイトル未設定)'}</div>
                        <div className="text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{testResult.notification.body || '(本文未設定)'}</div>
                        {testResult.notification.action_url && (
                          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">action: {testResult.notification.action_url}</div>
                        )}
                      </div>
                    )}
                    {testResult.decision !== 'send' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isTesting}
                        onClick={async () => {
                          setIsTesting(true)
                          try {
                            const r = await fetch('/api/notify/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: { userId: 'local', force: true } }) });
                            const j = await r.json();
                            const p = j?.payload || null;
                            if (p?.decision === 'send' && p?.notification) {
                              await fetch('/api/notify/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'local', notification: p.notification, test: true }) });
                              setTestResult({ decision: 'send', notification: p.notification, sent: true });
                              toast.success('テスト通知（強制）を送信しました');
                              refreshTodayCount();
                            } else {
                              toast.error('強制生成に失敗しました');
                            }
                          } catch (e) {
                            toast.error('強制通知の送信に失敗しました');
                          } finally {
                            setIsTesting(false)
                          }
                        }}
                      >{isTesting ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> 実行中...</span> : '強制生成して送信'}</Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <History className="mt-1 h-5 w-5 text-purple-600 dark:text-purple-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">通知判断ログ</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">最新の通知判断結果を確認します。</p>
                </div>
              </div>
              <Button size="sm" onClick={() => { setLogDialogOpen(true); if (!logsLoaded) { fetchNotifyLogs(notifyLogSearch); } }}>
                詳細を見る
              </Button>
            </div>
            <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
              {logLoading && logDialogOpen ? (
                <div className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
                </div>
              ) : latestLogEntry ? (
                <>
                  <div className="flex items-center gap-2">
                    <Badge variant={latestLogEntry.decision === 'send' ? 'default' : 'outline'} className="text-xs uppercase">
                      {latestLogEntry.decision ?? 'unknown'}
                    </Badge>
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {latestLogEntry.payload?.notification?.title || latestLogEntry.payload?.notification?.body || latestLogEntry.reason || '通知判定'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">判定時刻: {formatLocalDateTime(latestLogEntry.created_at)}</div>
                  {latestLogEntry.reason && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">理由: {latestLogEntry.reason}</div>
                  )}
                </>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-400">ログはまだ読み込まれていません。</p>
              )}
            </div>
          </section>

          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <BellRing className="mt-1 h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">AIリマインダー</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">再通知キューの概要を表示します。</p>
                </div>
              </div>
              <Button size="sm" onClick={() => { setReminderDialogOpen(true); if (!remindersLoaded) { fetchReminders(reminderStatusFilter); } }}>
                詳細を見る
              </Button>
            </div>
            <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
              {reminderLoading && reminderDialogOpen ? (
                <div className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
                </div>
              ) : remindersLoaded ? (
                <>
                  <div className="text-xs">合計: {reminderSummary.total} 件</div>
                  <div className="text-xs">予定: {reminderSummary.scheduled} / 待機: {reminderSummary.queued} / 送信済み: {reminderSummary.dispatched}</div>
                </>
              ) : (
                <p className="text-xs text-slate-500 dark:text-slate-400">ボタンを押して最新のリマインダーを確認します。</p>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="chat" className="space-y-6">
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <History className="mt-1 h-5 w-5 text-blue-600 dark:text-blue-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">チャットモデル</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">応答品質と速度のバランスを選択します。</p>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <Label className="text-base font-medium text-slate-800 dark:text-slate-200">使用するモデル</Label>
                <RadioGroup
                  value={chatModel}
                  onValueChange={(v) => {
                    const next = (v === 'gemini-2.5-flash' ? 'gemini-2.5-flash' : 'gemini-2.5-pro') as 'gemini-2.5-flash'|'gemini-2.5-pro';
                    if (next === chatModel) return;
                    setChatModel(next);
                    setShowModelOverlay(true);
                  }}
                  className="mt-2 space-y-2"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="gemini-2.5-flash" id="model_flash" />
                    <Label htmlFor="model_flash" className="text-slate-700 dark:text-slate-300">gemini-2.5-flash（高速・軽量）</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="gemini-2.5-pro" id="model_pro" />
                    <Label htmlFor="model_pro" className="text-slate-700 dark:text-slate-300">gemini-2.5-pro（高品質）</Label>
                  </div>
                </RadioGroup>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">保存すると現在の会話履歴は消去され、モデル再起動後に新しい会話が始まります。</p>
              </div>
            </div>
          </section>

          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <Shield className="mt-1 h-5 w-5 text-red-600 dark:text-red-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">ツール許可の既定値</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">モデルがツールを自動実行するかを制御します。</p>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="yolo" className="text-base font-medium text-slate-800 dark:text-slate-200">
                    YOLOモード（自動許可）
                  </Label>
                  <p className="text-sm text-slate-600 dark:text-slate-400">オフにすると各ツール実行前に確認します</p>
                </div>
                <Switch id="yolo" checked={yoloMode} onCheckedChange={handleToggleYolo} />
              </div>
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={openRules}>常時許可/拒否ルールを管理</Button>
              </div>
              {rulesOpen && (
                <div className="space-y-3 rounded-md border border-slate-200 bg-white/80 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/50">
                  <div>
                    <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">常に許可</div>
                    <div className="flex flex-wrap gap-2">
                      {allowAlways.length === 0 && <span className="text-sm text-slate-500">（なし）</span>}
                      {allowAlways.map((k) => (
                        <span key={`allow-${k}`} className="inline-flex items-center gap-1 rounded bg-green-100 px-2 py-1 text-sm text-green-800 dark:bg-green-900/40 dark:text-green-300">
                          {k.replace(/:/, ': ')}
                          <button onClick={() => removeRule('allow', k)} className="ml-1 text-green-700 hover:opacity-80 dark:text-green-300">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">常に拒否</div>
                    <div className="flex flex-wrap gap-2">
                      {denyAlways.length === 0 && <span className="text-sm text-slate-500">（なし）</span>}
                      {denyAlways.map((k) => (
                        <span key={`deny-${k}`} className="inline-flex items-center gap-1 rounded bg-red-100 px-2 py-1 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-300">
                          {k.replace(/:/, ': ')}
                          <button onClick={() => removeRule('deny', k)} className="ml-1 text-red-700 hover:opacity-80 dark:text-red-300">×</button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setRulesOpen(false)}>閉じる</Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="appearance" className="space-y-6">
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <Palette className="mt-1 h-5 w-5 text-purple-600 dark:text-purple-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">表示設定</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">ダッシュボードの期間や週の開始曜日を調整します。</p>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <Label className="text-base font-medium text-slate-800 dark:text-slate-200">「今週の学習時間」の集計期間</Label>
                <RadioGroup value={weeklyPeriod} onValueChange={handleWeeklyPeriodChange} className="mt-2 space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="this_week" id="this_week" />
                    <Label htmlFor="this_week" className="font-normal">今週（週次）</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="7_days" id="7_days" />
                    <Label htmlFor="7_days" className="font-normal">過去7日間</Label>
                  </div>
                </RadioGroup>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  週次カードとグラフは上記の設定に連動します。月次カードは「直近30日間」の学習時間として表示されます（暦の月ではありません）。
                </p>
              </div>
              <div>
                <Label className="text-base font-medium text-slate-800 dark:text-slate-200">週の開始曜日</Label>
                <RadioGroup value={weekStart} onValueChange={(v) => handleWeekStartChange(v as any)} className="mt-2 space-y-2">
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="sunday" id="start_sun" />
                    <Label htmlFor="start_sun" className="font-normal">日曜始まり</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="monday" id="start_mon" />
                    <Label htmlFor="start_mon" className="font-normal">月曜始まり</Label>
                  </div>
                </RadioGroup>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">「今週」を選択中の集計に適用されます。</p>
              </div>
            </div>
          </section>

          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <Palette className="mt-1 h-5 w-5 text-purple-600 dark:text-purple-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">教科ごとの色</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">タイムラインで使うカラーを調整します。</p>
                </div>
              </div>
              <Button onClick={handleSave} size="sm" className="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
                <Save className="mr-2 h-4 w-4" />保存
              </Button>
            </div>
            <div className="space-y-4">
              {uniqueSubjects.length > 0 ? (
                uniqueSubjects.map((subject) => (
                  <div key={subject} className="flex items-center justify-between">
                    <Badge
                      variant="outline"
                      className="text-base"
                      style={getSubjectStyle(subject, subjectColors)}
                    >
                      {subject}
                    </Badge>
                    <Input
                      id={`color-${subject}`}
                      type="color"
                      value={subjectColors[subject] || '#000000'}
                      onChange={(e) => onColorChange(subject, e.target.value)}
                      className="h-10 w-16 cursor-pointer rounded-md border border-slate-200 p-1 dark:border-slate-700"
                      style={{ backgroundColor: subjectColors[subject] || '#000000' }}
                    />
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500 dark:text-slate-400">まだ学習記録がありません。学習を開始すると教科が表示されます。</p>
              )}
            </div>
          </section>
        </TabsContent>

        <TabsContent value="info" className="space-y-6">
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <ServerCog className="mt-1 h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">サーバー管理</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">HTTPレイヤーのみを再起動し、Geminiプロセスは維持します。</p>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                再起動を実行すると、数秒間ダッシュボードへの接続が切断されます。バックグラウンドのGeminiセッションや通知ウォッチャーは維持されるため、必要に応じて安全にリロードできます。
              </p>
              <AlertDialog open={restartDialogOpen} onOpenChange={handleRestartDialogOpenChange}>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="default"
                    className="gap-2 shadow-sm"
                    onClick={() => setRestartDialogOpen(true)}
                    disabled={serverRestarting}
                  >
                    {serverRestarting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-4 w-4" />
                    )}
                    HTTPサーバーを再起動
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>HTTPサーバーを再起動しますか？</AlertDialogTitle>
                    <AlertDialogDescription>
                      現在のWebソケット接続とHTTPセッションが切断され、数秒後に自動的に復帰します。Geminiプロセスは再起動せず、処理中のタスクは保持されます。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  {serverRestartError && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
                      {serverRestartError}
                    </div>
                  )}
                  <AlertDialogFooter className="mt-4 flex flex-row gap-2">
                    <AlertDialogCancel disabled={serverRestarting}>キャンセル</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(event) => handleServerRestartRequest(event)}
                      disabled={serverRestarting}
                      className="gap-2 shadow-sm"
                    >
                      {serverRestarting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="h-4 w-4" />
                      )}
                      再起動する
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                GeminiからのCLI操作でも <code className="rounded bg-slate-100 px-1 py-0.5 text-xs dark:bg-slate-800">npm run server:restart</code> で同じ再起動を指示できます。
              </p>
            </div>
          </section>
          <section className={panelClass}>
            <div className={panelHeaderClass}>
              <div className="flex items-start gap-3">
                <FileText className="mt-1 h-5 w-5 text-slate-600 dark:text-slate-300" />
                <div>
                  <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">アプリ情報</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">バージョンやライセンス情報を確認できます。</p>
                </div>
              </div>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">バージョン</span>
                <span className="text-slate-800 dark:text-slate-200">{appInfo?.version ?? '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">最終更新</span>
                <span className="text-slate-800 dark:text-slate-200">{appInfo?.lastCommitDate ?? '—'}</span>
              </div>
              {appInfo?.git && (
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">Git</span>
                  <span className="text-slate-800 dark:text-slate-200">{`${appInfo.git.branch ?? '—'} @ ${appInfo.git.commit ?? '—'}`}</span>
                </div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                <Link href="/legal/terms" className="text-blue-600 hover:underline dark:text-blue-400">利用規約</Link>
                <span className="text-slate-400">/</span>
                <Link href="/legal/privacy" className="text-blue-600 hover:underline dark:text-blue-400">プライバシーポリシー</Link>
                <span className="text-slate-400">/</span>
                <Link href="/legal/licenses" className="text-blue-600 hover:underline dark:text-blue-400">ライセンス</Link>
              </div>
            </div>
          </section>
        </TabsContent>
      </Tabs>

      <Dialog open={logDialogOpen} onOpenChange={(open) => setLogDialogOpen(open)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>通知判断ログ</DialogTitle>
            <DialogDescription>直近10件の判定履歴を検索・確認できます。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-1 items-center gap-2">
                <Input
                  value={notifyLogSearch}
                  onChange={(event) => setNotifyLogSearch(event.target.value)}
                  placeholder="キーワード検索"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchNotifyLogs(notifyLogSearch)}
                  disabled={logLoading}
                >
                  <RefreshCcw className="mr-1 h-4 w-4" />更新
                </Button>
              </div>
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              直近10件の判断結果を表示します。送信済み通知はここから再送できます。
            </p>

            {logLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />読み込み中...
              </div>
            )}

            {!logLoading && logEntries.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400">
                該当するログがありません。
              </div>
            )}

            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {logEntries.map((entry) => {
                const isSend = entry.decision === 'send';
                const isSkip = entry.decision === 'skip';
                const title = entry.payload?.notification?.title || entry.payload?.notification?.body || entry.reason || '通知判定';
                return (
                  <div
                    key={entry.id}
                    className="rounded-md border border-slate-200 bg-white/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/50"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={isSend ? 'default' : 'outline'}
                            className={`text-xs uppercase tracking-wide ${isSend ? 'bg-emerald-600 hover:bg-emerald-600 text-white' : isSkip ? 'border-slate-300 text-slate-600 dark:border-slate-500 dark:text-slate-300' : ''}`}
                          >
                            {entry.decision ?? 'unknown'}
                          </Badge>
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{title}</span>
                        </div>
                        {entry.reason && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">理由: {entry.reason}</div>
                        )}
                        <div className="text-xs text-slate-500 dark:text-slate-400">判定時刻: {formatLocalDateTime(entry.created_at)}</div>
                        {entry.mode_id && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">参照モード: {modesById.get(entry.mode_id)?.display_name || entry.mode_id}</div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 items-start justify-end min-w-[8rem]">
                        {isSend && entry.payload?.notification && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleResendNotification(entry.id)}
                            disabled={logLoading}
                          >
                            <BellRing className="mr-1 h-4 w-4" />再送
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500 dark:text-slate-400">
                      {entry.source && <Badge variant="outline" className="text-xs">source: {entry.source}</Badge>}
                      {entry.manual_send && <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-300">手動送信</Badge>}
                      {entry.test && <Badge variant="outline" className="text-xs text-slate-600 dark:text-slate-300">test</Badge>}
                      {entry.resend_of && <Badge variant="outline" className="text-xs">再送元: #{entry.resend_of}</Badge>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reminderDialogOpen} onOpenChange={(open) => setReminderDialogOpen(open)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>AIリマインダー</DialogTitle>
            <DialogDescription>自動再通知のキューを確認・管理できます。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {reminderFilters.map((filter) => (
                <Button
                  key={filter.value}
                  variant={reminderStatusFilter === filter.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => handleReminderStatusChange(filter.value)}
                  disabled={reminderLoading && reminderStatusFilter === filter.value}
                >
                  {filter.label}
                </Button>
              ))}
            </div>

            <p className="text-xs text-slate-500 dark:text-slate-400">
              AI が再通知を予約したタスクの一覧です。手動でキャンセルすることもできます。
            </p>

            {reminderLoading && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />読み込み中...
              </div>
            )}

            {!reminderLoading && reminders.length === 0 && (
              <div className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400">
                表示するリマインダーはありません。
              </div>
            )}

            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {reminders.map((reminder) => {
                const fireAt = formatLocalDateTime(reminder.fire_at);
                const relative = formatRelativeTime(reminder.fire_at);
                const cancelable = reminder.status === 'scheduled' || reminder.status === 'queued';
                return (
                  <div
                    key={reminder.id}
                    className="rounded-md border border-slate-200 bg-white/80 px-3 py-3 dark:border-slate-700 dark:bg-slate-900/50"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                            {reminder.purpose || 'リマインダー'}
                          </span>
                          <Badge variant="outline" className="text-xs uppercase tracking-wide">
                            {reminder.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          予定: {fireAt || reminder.fire_at}
                          {relative && <span className="ml-1">({relative})</span>}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          作成: {formatLocalDateTime(reminder.created_at)}
                        </div>
                        {reminder.created_by && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            作成者: {reminder.created_by}
                          </div>
                        )}
                      </div>
                      {cancelable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCancelReminder(reminder.id)}
                          disabled={reminderLoading}
                        >
                          <XCircle className="mr-1 h-4 w-4" />取消
                        </Button>
                      )}
                    </div>
                    {(reminder.context || reminder.meta) && (
                      <details className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        <summary className="cursor-pointer">詳細</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-slate-100/70 p-2 dark:bg-slate-900/60">
                          {JSON.stringify({ context: reminder.context, meta: reminder.meta }, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {showModelOverlay && typeof window !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
          <div className="mx-4 w-full max-w-xl rounded-xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-800">
            <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">会話の要約を引き継いでモデルを切り替えますか？</div>
            <div className="mt-2 text-sm text-slate-700 dark:text-slate-300">
              これまでの会話内容は要約され、新しいモデルに引き継がれます。この操作は取り消せません。<br />
              なお、学習記録のデータやメモリー、GEMINI.md 等ファイルに保存されているコンテキストや設定は保持されます。
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => { setChatModel(initialChatModel); setShowModelOverlay(false); }}
                disabled={isApplyingModel}
              >キャンセル</Button>
              <Button className="bg-red-600 text-white hover:bg-red-700" onClick={handleApplyChatModel} disabled={isApplyingModel}>
                {isApplyingModel ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> 要約中…</span> : '要約して切り替え'}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
