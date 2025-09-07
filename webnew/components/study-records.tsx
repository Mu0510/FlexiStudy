"use client"

import React, { useState, useEffect, useRef, useLayoutEffect } from "react"
import type { DateRange } from 'react-day-picker'
import { useIsMobile } from "@/hooks/use-mobile"
import { useToast } from "@/hooks/use-toast"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { DailyGoalsCard } from "@/components/daily-goals-card";
import { Skeleton } from "@/components/ui/skeleton"
import { Clock, BookOpen, Search, ChevronLeft, ChevronRight, Play, Pause, MessageSquare, ChevronDown, ChevronUp, AlertCircle, ClipboardList, Lightbulb, Calendar as CalendarIcon, SlidersHorizontal, ArrowUpDown, X, BookUser, Tag } from "lucide-react"

// Define the types for our data to ensure type safety
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

interface LogEntry {
  type: 'START' | 'BREAK' | 'RESUME';
  duration_minutes: number;
  content: string;
  start_time: string;
  end_time: string;
  id: number;
  memo?: string;
  impression?: string;
}

interface StudySession {
  session_id: number;
  subject: string;
  start_time: string;
  end_time: string;
  total_duration: number;
  summary: string;
  logs: LogEntry[];
}

interface DailySummary {
  date: string;
  total_duration: number;
  subjects: string[];
  summary: string;
  goals?: Goal[];
}

interface LogData {
  daily_summary: DailySummary;
  sessions: StudySession[];
}

interface StudyRecordsProps {
  logData: LogData | null;
  onDateChange: (newDate: string) => void;
  selectedDate: string;
  isLoading: boolean;
  error: string | null;
  subjectColors: Record<string, string>;
  onSelectGoal?: (goal: Goal) => void;
  onSelectSession?: (logEntry: LogEntry) => void;
  onRefresh?: () => void;
}

const RecordsSkeleton = () => (
  <div className="space-y-4">
    {[...Array(3)].map((_, i) => (
      <Card key={i} className="bg-white dark:bg-card border-0 shadow-lg rounded-lg overflow-hidden">
        <CardHeader className="p-4 flex flex-row items-center justify-between">
          <div className="flex items-center space-x-4 flex-1 min-w-0">
            <Skeleton className="h-8 w-16 rounded-full" />
            <div className="text-left flex-1 min-w-0 space-y-2">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-4 w-48 rounded" />
            </div>
          </div>
          <div className="flex items-center space-x-2 sm:space-x-4 ml-4">
            <Skeleton className="h-8 w-32 rounded-full" />
            <Skeleton className="h-5 w-5 rounded" />
          </div>
        </CardHeader>
      </Card>
    ))}
  </div>
);

import { useWebSocket } from "@/context/WebSocketContext";
import { getSubjectStyle, cn } from "@/lib/utils";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select";



export function StudyRecords({ logData, onDateChange, selectedDate, isLoading, error, subjectColors, onSelectGoal, onSelectSession, onRefresh }: StudyRecordsProps) {
  const { toast } = useToast();
  const [openSessions, setOpenSessions] = useState<Record<number, boolean>>({});
  const [isDatePickerOpen, setDatePickerOpen] = useState(false);
  const isMobile = useIsMobile();
  const isToday = new Date(selectedDate).toDateString() === new Date().toDateString();
  const { subscribe } = useWebSocket();

  // Compute-once width-based scaling without extra wrapper (to avoid flicker)
  const FitSubjectBadge = ({ text }: { text: string }) => {
    const badgeRef = useRef<HTMLSpanElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    if (!canvasRef.current && typeof document !== 'undefined') canvasRef.current = document.createElement('canvas');

    useLayoutEffect(() => {
      const el = badgeRef.current; const canvas = canvasRef.current;
      if (!el || !canvas) return;
      // Hide until scaled to final size to prevent visible jump
      el.style.visibility = 'hidden';
      const parent = el.parentElement as HTMLElement | null;
      const colWidth = parent ? parent.clientWidth : 56; // grid col width
      // Tuning knobs
      const MAX_OVERHANG = 6; // px per side max visual borrow into gap
      const OVERHANG_PER_CHAR = 2.5; // px per extra char (>=3rd)
      // Dynamic max scale by length: <=2:1.0, 3:0.90, 4:0.85, 5:0.80, ... (−0.05/char, floored)

      // Inner padding shrinks slightly with length (min 6px/side)
      const len = Array.from(text || '').length;
      const innerBase = 10; // px per side for 2–3 chars
      const reduceInner = Math.max(0, (len - 3)) * 1.0; // shrink 1px per extra char
      const innerPad = Math.max(6, Math.round(innerBase - reduceInner));
      el.style.paddingLeft = `${innerPad}px`;
      el.style.paddingRight = `${innerPad}px`;
      // Absolutely center the badge in its fixed-width column and allow
      // symmetric overhang across the grid gap on both sides.
      const maxOverhang = 16; // px (roughly gap-x-4)
      if (parent && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      el.style.position = 'absolute';
      el.style.left = '50%';
      const available = colWidth - innerPad * 2;
      const cs = window.getComputedStyle(el);
      const font = `${cs.fontWeight || '400'} ${cs.fontSize || '16px'} ${cs.fontFamily || 'sans-serif'}`;
      const ctx = canvas.getContext('2d');
      if (!ctx) { el.style.visibility = ''; return; }
      ctx.font = font;
      const w = ctx.measureText(text).width;
      const effective = available + MAX_OVERHANG * 2;
      let scale = w > 0 ? Math.min(1, effective / w) : 1;
      // Cap by length-based rule
      const allowedMaxScale = (len <= 2) ? 1.0 : Math.max(0.7, 1 - ((len - 2) * 0.05 + 0.05));
      scale = Math.min(scale, allowedMaxScale);
      el.style.transformOrigin = 'center center';
      el.style.whiteSpace = 'nowrap';
      el.style.transform = `translateX(-50%) scale(${scale})`;
      el.style.zIndex = '1';
      // Show after setting final transform
      el.style.visibility = '';
    }, [text]);

    return (
      <Badge
        ref={badgeRef as any}
        variant="outline"
        className="text-base h-fit"
        style={getSubjectStyle(text, subjectColors)}
      >
        {text}
      </Badge>
    );
  };

  

  // Heuristic scaling for subject badges to avoid overflow in narrow cells
  const getSubjectScale = (name?: string) => {
    const n = (name || '').trim().length;
    if (n <= 2) return 1;
    if (n === 3) return 0.9;
    if (n === 4) return 0.8;
    return 0.7; // 5+ chars
  };

  // --- Search states ---
  const [searchInput, setSearchInput] = useState("");
  const [searchType, setSearchType] = useState<'all'|'entry'|'goal'|'summary'>('all');
  const [sortOrder, setSortOrder] = useState<'relevance'|'newest'|'oldest'>('relevance');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [nextOffset, setNextOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [tagSuggestions, setTagSuggestions] = useState<Array<{name:string, source:string, count:number}>>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsTimer = useRef<any>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isRangeOpenSm, setIsRangeOpenSm] = useState(false);
  const [isRangeOpenMd, setIsRangeOpenMd] = useState(false);
  const latestSearchReqId = useRef(0);
  const [hasSearched, setHasSearched] = useState(false);
  const [lastQWords, setLastQWords] = useState<string[]>([]);
  const [lastTags, setLastTags] = useState<string[]>([]);
  const [pendingJump, setPendingJump] = useState<{ date: string; id?: any; logId?: number; kind?: string } | null>(null);
  const [highlightLogIds, setHighlightLogIds] = useState<Set<number>>(new Set());
  const [highlightGoalIds, setHighlightGoalIds] = useState<Set<string | number>>(new Set());
  const [highlightSummaryDate, setHighlightSummaryDate] = useState<string | null>(null);
  const [rangeAnchor, setRangeAnchor] = useState<{ mode: 'to' | 'from'; date: Date } | null>(null);
  const keepRangeOpen = !!rangeAnchor || (!!dateRange?.from && !dateRange?.to);
  const preventCloseUntilRef = useRef<number>(0);
  const [showQuickMd, setShowQuickMd] = useState(false);
  const [showQuickSm, setShowQuickSm] = useState(false);
  const [pendingRangeMd, setPendingRangeMd] = useState<DateRange | undefined>(undefined);
  const [pendingRangeSm, setPendingRangeSm] = useState<DateRange | undefined>(undefined);
  const mdCalRef = useRef<HTMLDivElement | null>(null);
  const smCalRef = useRef<HTMLDivElement | null>(null);
  const [mdCalWidth, setMdCalWidth] = useState<number | undefined>(undefined);
  const [smCalWidth, setSmCalWidth] = useState<number | undefined>(undefined);

  const sameDay = (a?: Date, b?: Date) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const MIN_DATE = new Date(1900, 0, 1);
  const MAX_DATE = new Date(9999, 11, 31);

  const formatRangeLabel = (rng?: DateRange) => {
    if (rng?.from && rng?.to) {
      const from = `${rng.from.getFullYear()}-${String(rng.from.getMonth()+1).padStart(2,'0')}-${String(rng.from.getDate()).padStart(2,'0')}`;
      const to = `${rng.to.getFullYear()}-${String(rng.to.getMonth()+1).padStart(2,'0')}-${String(rng.to.getDate()).padStart(2,'0')}`;
      // Single day: show just the date
      if (sameDay(rng.from as Date, rng.to as Date)) return from;
      // If using infinite sentinels, normalize label
      if (sameDay(rng.from as Date, MIN_DATE)) return `〜 ${to}`;
      if (sameDay(rng.to as Date, MAX_DATE)) return `${from} 〜`;
      return `${from} 〜 ${to}`;
    }
    if (rng?.from) {
      const from = `${rng.from.getFullYear()}-${String(rng.from.getMonth()+1).padStart(2,'0')}-${String(rng.from.getDate()).padStart(2,'0')}`;
      return `${from}〜`;
    }
    if ((rng as any)?.to) {
      const toD = (rng as any).to as Date;
      const to = `${toD.getFullYear()}-${String(toD.getMonth()+1).padStart(2,'0')}-${String(toD.getDate()).padStart(2,'0')}`;
      return `〜 ${to}`;
    }
    return '期間指定';
  };

  const isSingleDayRange = (rng?: DateRange) => !!rng?.from && (!rng?.to || sameDay(rng.from as Date, rng.to as Date));
  const isInfUntilRange = (rng?: DateRange) => !!rng?.from && sameDay(rng.from as Date, MIN_DATE);
  const isInfFromRange = (rng?: DateRange) => !!rng?.to && sameDay(rng.to as Date, MAX_DATE);

  const normalizeRange = (applied?: DateRange): DateRange | undefined => {
    if (!applied) return undefined;
    if (applied.from && !applied.to) {
      return { from: applied.from, to: applied.from } as any;
    }
    if (applied.from && applied.to) {
      if (sameDay(applied.from as Date, MIN_DATE)) {
        return { to: applied.to } as any;
      }
      if (sameDay(applied.to as Date, MAX_DATE)) {
        return { from: applied.from } as any;
      }
      return applied;
    }
    return undefined;
  };

  const applyPendingAndCloseMd = () => {
    const normalized = normalizeRange(pendingRangeMd);
    if (normalized) {
      setDateRange(normalized);
      fetchSearch(true, { range: normalized as any });
    }
    setIsRangeOpenMd(false);
  };

  const applyPendingAndCloseSm = () => {
    const normalized = normalizeRange(pendingRangeSm);
    if (normalized) {
      setDateRange(normalized);
      fetchSearch(true, { range: normalized as any });
    }
    setIsRangeOpenSm(false);
  };

  useEffect(() => {
    const node = mdCalRef.current;
    if (!node) return;
    const ro = new (window as any).ResizeObserver((entries: any) => {
      for (const e of entries) setMdCalWidth(Math.ceil(e.contentRect.width));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [isRangeOpenMd]);

  useEffect(() => {
    const node = smCalRef.current;
    if (!node) return;
    const ro = new (window as any).ResizeObserver((entries: any) => {
      for (const e of entries) setSmCalWidth(Math.ceil(e.contentRect.width));
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [isRangeOpenSm]);

  // 展開条件をまとめて判定
  const isExpanded = (
    isSearchFocused ||
    searchInput.trim().length > 0 ||
    !!dateRange?.from ||
    !!dateRange?.to ||
    searchType !== 'all' ||
    results.length > 0 ||
    isRangeOpenSm || isRangeOpenMd
  );

  // Quiet granular updates are handled in app/page.tsx via WebSocket events.
  // Avoid triggering panel-wide reloads from here.

  // フォーカス/可視化時の再取得は page.tsx 側で静かに実施（ここでは何もしない）

  const handleMoveGoal = async (goal: Goal) => {
    try {
      const response = await fetch('/api/goals/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ goal }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.details || '目標の移動に失敗しました。');
      }

      toast({
        title: "目標を移動しました",
        description: `「${goal.task}」を今日の目標に追加しました。`,
      });

      // 今日の日付のデータを再読み込み
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      onDateChange(todayStr);

    } catch (error: any) {
      console.error(error);
      toast({
        variant: "destructive",
        title: "エラー",
        description: error.message || '目標の移動中に不明なエラーが発生しました。',
      });
    }
  };

  const toggleSession = (sessionId: number) => {
    setOpenSessions(prev => ({ ...prev, [sessionId]: !prev[sessionId] }));
  };

  const handleDateChange = (direction: 'prev' | 'next', e: React.MouseEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    const currentDate = new Date(selectedDate);
    currentDate.setDate(currentDate.getDate() + (direction === 'prev' ? -1 : 1));
    const newDateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')}`;
    onDateChange(newDateStr);
    setTimeout(() => button.blur(), 0);
  };

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      onDateChange(`${year}-${month}-${day}`);
      setDatePickerOpen(false);
    }
  };

  // ---- Search helpers ----
  const extractTagsFromInput = (input: string) => {
    const tokens = input.split(/\s+/).filter(Boolean);
    const stripPunct = (s: string) => s.replace(/[、。.,!?:;)\]\}＞＞〉》」』】］）]+$/u, '');
    const isTagToken = (t: string) => t.startsWith('#') || t.startsWith('＃');
    const tags = tokens
      .filter(isTagToken)
      .map(t => stripPunct(t.substring(1)))
      .filter(Boolean);
    const q = tokens.filter(t => !isTagToken(t)).join(' ');
    return { q, tags };
  };

  const fetchSearch = async (reset = true, opts?: { type?: 'all'|'entry'|'goal'|'summary', range?: DateRange | undefined, input?: string, order?: 'relevance'|'newest'|'oldest' }) => {
    const reqId = ++latestSearchReqId.current;
    const effectiveType = opts?.type ?? searchType;
    // Use provided range even if undefined (to explicitly clear)
    const hasRangeKey = !!opts && Object.prototype.hasOwnProperty.call(opts, 'range');
    const effectiveRange = hasRangeKey ? opts!.range : dateRange;
    const rawInput = opts?.input ?? searchInput;
    const effectiveOrder = opts?.order ?? sortOrder;
    const { q, tags } = extractTagsFromInput(rawInput);
    const qWords = q ? q.split(/\s+/).filter(Boolean) : [];
    const params = new URLSearchParams();
    params.set('type', effectiveType);
    if (q) params.set('q', q);
    if (tags.length) params.set('tags', tags.join(','));
    const fmt = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${dd}`;
    };
    if (effectiveRange?.from) params.set('from', fmt(effectiveRange.from));
    if (effectiveRange?.to) params.set('to', fmt(effectiveRange.to));
    params.set('match', 'all');
    params.set('limit', '20');
    params.set('offset', reset ? '0' : String(nextOffset));
    params.set('order', effectiveOrder);

    setHasSearched(true);
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      // 応答の競合を防ぐ（最新のリクエストのみ反映）
      if (reqId === latestSearchReqId.current) {
        setLastQWords(qWords);
        setLastTags(tags);
        setTotalResults(data.total || 0);
        setHasMore(!!data.hasMore);
        setNextOffset(data.nextOffset || 0);
        setResults(reset ? (data.items || []) : [...results, ...(data.items || [])]);
      }
    } catch (e: any) {
      if (reqId === latestSearchReqId.current) {
        setSearchError(e.message || '検索に失敗しました');
      }
    } finally {
      if (reqId === latestSearchReqId.current) {
        setSearching(false);
      }
    }
  };

  // --- Highlight helpers ---
  const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const buildHighlightRegex = () => {
    const terms: string[] = [];
    // tags -> match with leading '#'
    lastTags.forEach(t => terms.push(`#${escapeReg(t)}`));
    // q words
    lastQWords.forEach(w => terms.push(escapeReg(w)));
    if (terms.length === 0) return null;
    return new RegExp(`(${terms.join('|')})`, 'g');
  };

  const renderHighlighted = (text: string) => {
    if (!text) return text;
    const re = buildHighlightRegex();
    if (!re) return text;
    const parts: Array<string|JSX.Element> = [];
    let lastIndex = 0;
    text.replace(re, (match, _p1, offset) => {
      if (offset > lastIndex) parts.push(text.slice(lastIndex, offset));
      parts.push(
        <mark key={`hl-${offset}`} className="bg-yellow-200 dark:bg-yellow-600/40 text-inherit rounded px-0.5">
          {match}
        </mark>
      );
      lastIndex = offset + match.length;
      return match;
    });
    if (lastIndex < text.length) parts.push(text.slice(lastIndex));
    return parts;
  };

  const formatJPMonthDay = (dateStr: string) => {
    try {
      const [y, m, d] = dateStr.split('-').map(Number);
      return `${m}月${d}日`;
    } catch { return dateStr; }
  };

  type SnippetField = 'title'|'session_summary'|'body'|'memo'|'impression'|'tags';
  const SnippetIcon: React.FC<{ field: SnippetField }> = ({ field }) => {
    switch (field) {
      case 'session_summary':
        return <MessageSquare className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
      case 'memo':
        return <ClipboardList className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
      case 'impression':
        return <Lightbulb className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
      case 'body':
        return <BookOpen className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
      case 'title':
      default:
        return <></>;
    }
  };

  const requestSuggestions = async (prefix: string) => {
    try {
      const res = await fetch(`/api/tags?prefix=${encodeURIComponent(prefix)}&limit=8`);
      if (!res.ok) return;
      const data = await res.json();
      setTagSuggestions(data.tags || []);
      setShowSuggestions(true);
    } catch {}
  };

  // Handle jump after data loads: expand session and scroll + temporary highlight
  useEffect(() => {
    if (!pendingJump) return;
    if (selectedDate !== pendingJump.date) return;
    if (!logData || !logData.sessions) return;

    if (pendingJump.kind === 'entry' && pendingJump.logId) {
      const target = pendingJump.logId;
      const targetSession = logData.sessions.find((s: any) => s.logs?.some((l: any) => l.id === target));
      if (!targetSession) return; // wait for data

      const ensureOpen = () => {
        setTimeout(() => {
          const el = document.getElementById(`log-${target}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setHighlightLogIds(prev => new Set(prev).add(target));
            setTimeout(() => {
              setHighlightLogIds(prev => {
                const n = new Set(prev);
                n.delete(target);
                return n;
              });
            }, 2000);
            setPendingJump(null);
          }
        }, 50);
      };

      if (!openSessions[targetSession.session_id]) {
        setOpenSessions(prev => ({ ...prev, [targetSession.session_id]: true }));
        ensureOpen();
      } else {
        ensureOpen();
      }
      return;
    }

    if (pendingJump.kind === 'goal' && pendingJump.id) {
      const gid = pendingJump.id;
      setTimeout(() => {
        const el = document.getElementById(`goal-${gid}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightGoalIds(prev => new Set(prev).add(gid));
          setTimeout(() => {
            setHighlightGoalIds(prev => {
              const n = new Set(prev);
              n.delete(gid);
              return n;
            });
          }, 2000);
          setPendingJump(null);
        }
      }, 50);
      return;
    }

    if (pendingJump.kind === 'summary') {
      setTimeout(() => {
        const el = document.getElementById(`summary-${pendingJump.date}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setHighlightSummaryDate(pendingJump.date);
          setTimeout(() => setHighlightSummaryDate(null), 2000);
          setPendingJump(null);
        }
      }, 50);
      return;
    }
  }, [logData, pendingJump, selectedDate, openSessions]);

  const onSearchInputChange = (v: string) => {
    setSearchInput(v);
    if (suggestionsTimer.current) clearTimeout(suggestionsTimer.current);
    const prefix = /(^|\s)[#＃]([\w\u0080-\uFFFF\-]*)$/.exec(v)?.[2] || null;
    if (prefix !== null) {
      suggestionsTimer.current = setTimeout(() => requestSuggestions(prefix), 150);
    } else {
      setShowSuggestions(false);
    }
  };

  const insertTagSuggestion = (name: string) => {
    const v = searchInput;
    const m = /(^|\s)[#＃]([\w\u0080-\uFFFF\-]*)$/.exec(v);
    if (!m) return;
    const start = v.slice(0, m.index) + (m[1] || '');
    const newVal = `${start}#${name} `;
    setSearchInput(newVal);
    setShowSuggestions(false);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  };

  // Label helper for type select (shows placeholder text for 'all')
  const getTypeLabel = (t: 'all'|'entry'|'goal'|'summary') => (
    t === 'entry' ? '学習ログ' : t === 'goal' ? '目標' : t === 'summary' ? 'サマリー' : '種別指定'
  );

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);

    const yearOptions: Intl.DateTimeFormatOptions = { year: 'numeric' };
    const monthDayOptions: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' };
    const weekdayOptions: Intl.DateTimeFormatOptions = { weekday: 'long' };

    const year = new Intl.DateTimeFormat('ja-JP', yearOptions).format(date);
    const monthDay = new Intl.DateTimeFormat('ja-JP', monthDayOptions).format(date);
    const weekday = new Intl.DateTimeFormat('ja-JP', weekdayOptions).format(date);

    return (
      <>
        <span className="hidden sm:inline">{year} </span>
        {monthDay} {weekday}
      </>
    );
  }

  const formatDuration = (minutes: number) => {
    if (isNaN(minutes)) return "0分";
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours > 0 ? `${hours}時間${remainingMinutes}分` : `${remainingMinutes}分`;
  }

  const renderContent = () => {
    if (isLoading) {
      return <RecordsSkeleton />;
    }

    if (error) {
      return (
        <Card className="border-destructive bg-destructive/10">
          <CardContent className="p-6 flex items-center space-x-4">
            <AlertCircle className="w-8 h-8 text-destructive" />
            <div>
              <h3 className="font-semibold text-destructive">エラーが発生しました</h3>
              <p className="text-sm text-destructive/80">{error}</p>
            </div>
          </CardContent>
        </Card>
      );
    }

    if (!logData || !logData.daily_summary) {
      return (
        <div className="text-center p-10 bg-white dark:bg-card rounded-lg shadow-lg">
          <h2 className="text-xl font-semibold">この日付の学習記録はありません</h2>
          <p className="text-slate-500 dark:text-muted-foreground mt-2">別の日付を選択するか、新しい学習を開始してください。</p>
        </div>
      );
    }

    return (
      <div className="space-y-4 pb-16">
        {logData.sessions.map((session) => (
          <Card key={session.session_id} className="bg-white dark:bg-slate-800 border-0 shadow-lg rounded-lg overflow-hidden">
            <CardHeader 
              className="p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50"
              onClick={() => toggleSession(session.session_id)}
            >
              <div className="grid grid-cols-[3.5rem_1fr] gap-x-4">
                <div className="row-span-2 flex items-center justify-center"><FitSubjectBadge text={session.subject} /></div>

                <div className="min-w-0">
                  <div className="flex items-center justify-between w-full">
                    <div className="w-24 text-left">
                      <span className="text-sm text-slate-500">(ID: {session.session_id})</span>
                    </div>
                    <div className="w-[8.8rem] text-center">
                      <span className="text-lg font-semibold text-slate-800 dark:text-slate-100 whitespace-nowrap">
                        {session.start_time} - {session.end_time}
                      </span>
                    </div>
                    <div className="w-[13.2rem] text-right">
                      <div className="flex items-center justify-end space-x-2">
                        <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700/50 text-base">
                          {formatDuration(session.total_duration)}
                        </Badge>
                        {openSessions[session.session_id] ? <ChevronUp className="w-5 h-5 text-slate-500" /> : <ChevronDown className="w-5 h-5 text-slate-500" />}
                      </div>
                    </div>
                  </div>

                  <div className="mt-1">
                    <p className="pl-6 text-slate-700 dark:text-slate-400 text-sm">
                      <MessageSquare className="mr-2 -ml-6 inline-block h-4 w-4 align-middle text-slate-400" />
                      <span className="align-middle">
                        {session.summary && (session.summary.startsWith(`${session.subject}：`) ? session.summary.substring(session.subject.length + 1) : session.summary)}
                      </span>
                    </p>
                  </div>
                </div>
              </div>
            </CardHeader>
            {openSessions[session.session_id] && (
              <CardContent className="p-6 pt-0">
                <div className="border-t border-slate-200 dark:border-slate-700 pt-4 mt-4">
                  <h4 className="font-semibold text-slate-800 dark:text-slate-100 mb-3">セッション詳細</h4>
                  <div className="space-y-3">
                    {session.logs.map((detail, index) => (
                      <div
                        id={`log-${detail.id}`}
                        key={index}
                        className={cn(
                          "flex items-center space-x-4 p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg transition-shadow duration-700",
                          highlightLogIds.has(detail.id) && "ring-2 ring-yellow-400 bg-yellow-50 dark:bg-yellow-900/30"
                        )}
                      >
                        <div className="flex items-center space-x-3 w-28 flex-shrink-0">
                          <div 
                            className="cursor-pointer hover:opacity-80 transition-opacity flex items-center space-x-2"
                            onClick={() => onSelectSession?.(detail)}
                            title="この学習セッションをチャットに送信"
                          >
                            {detail.type === "START" && <div className="p-2 bg-green-100 dark:bg-green-900/30 rounded-full flex-shrink-0"><Play className="w-4 h-4 text-green-600 dark:text-green-400" /></div>}
                            {detail.type === "BREAK" && <div className="p-2 bg-orange-100 dark:bg-orange-900/30 rounded-full flex-shrink-0"><Pause className="w-4 h-4 text-orange-600 dark:text-orange-400" /></div>}
                            {detail.type === "RESUME" && <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-full flex-shrink-0"><Play className="w-4 h-4 text-blue-600 dark:text-blue-400" /></div>}
                            <Badge
                              variant="outline"
                              className={
                                detail.type === "START" ? "border-green-200 text-green-700 dark:border-green-700/50 dark:text-green-300"
                                : detail.type === "BREAK" ? "border-orange-200 text-orange-700 dark:border-orange-700/50 dark:text-orange-300"
                                : "border-blue-200 text-blue-700 dark:border-blue-700/50 dark:text-blue-300"
                              }
                            >
                              {detail.type}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-800 dark:text-slate-100">{detail.content || "休憩"}</span>
                            <div className="flex items-center space-x-4 text-sm text-slate-600 dark:text-slate-400">
                              <span className="whitespace-nowrap">{formatDuration(detail.duration_minutes)}</span>
                              <span className="whitespace-nowrap">{detail.start_time} - {detail.end_time}</span>
                            </div>
                          </div>
                          {detail.memo && (
                            <div className="flex items-start text-slate-600 dark:text-slate-400 text-sm mt-1">
                              <ClipboardList className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
                              <span className="whitespace-pre-wrap flex-grow">{detail.memo}</span>
                            </div>
                          )}
                          {detail.impression && (
                            <div className="flex items-start text-slate-600 dark:text-slate-400 text-sm mt-1">
                              <Lightbulb className="w-4 h-4 mr-2 mt-0.5 text-slate-500 flex-shrink-0" />
                              <span className="whitespace-pre-wrap flex-grow">{detail.impression}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 dark:text-slate-100">学習記録</h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">あなたの学習履歴を詳細に確認できます</p>
        </div>
        <div className="flex items-center space-x-3 w-full md:w-auto">
          {/* Search block */}
          <div className="relative w-full max-w-[24rem] md:w-[clamp(14rem,30vw,24rem)] md:max-w-none md:flex-none">
            <div
              className={`group/search rounded-md border border-input bg-background transition-all py-0 px-1`}
              onFocusCapture={() => setIsSearchFocused(true)}
              onBlurCapture={(e) => {
                const rt = e.relatedTarget as Node | null;
                if (isRangeOpenSm || isRangeOpenMd) return;
                if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) {
                  setIsSearchFocused(false);
                }
              }}
            >
              <div className="relative">
                <button
                  type="button"
                  aria-label="検索"
                  title="検索"
                  className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-700/60"
                  onClick={() => { fetchSearch(true); searchInputRef.current?.focus(); }}
                >
                  <Search className="text-slate-400 dark:text-slate-400 w-4 h-4 pointer-events-none" />
                </button>
                <Input
                  ref={searchInputRef}
                  value={searchInput}
                  onChange={(e) => onSearchInputChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === 'Tab') && showSuggestions && tagSuggestions.length > 0) {
                  e.preventDefault();
                  insertTagSuggestion(tagSuggestions[0].name);
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  fetchSearch(true);
                }
              }}
               onFocus={() => setIsSearchFocused(true)}
                  placeholder="#タグ や キーワードで検索..."
              className="h-9 pl-10 pr-8 w-full bg-transparent border-0 shadow-none focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 focus:ring-0 focus:outline-none dark:text-slate-200 placeholder:text-slate-400"
                />
                {searchInput && (
                  <button
                    type="button"
                    aria-label="入力をクリア"
                    title="入力をクリア"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
                    onClick={() => {
                      setSearchInput('');
                      setShowSuggestions(false);
                      setTimeout(() => searchInputRef.current?.focus(), 0);
                    }}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
                {showSuggestions && tagSuggestions.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg max-h-60 overflow-auto">
                    {tagSuggestions.map((t, idx) => (
                      <button
                        key={t.name + idx}
                        type="button"
                        onClick={() => insertTagSuggestion(t.name)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-700/50"
                      >
                        <span className="text-slate-800 dark:text-slate-100">#{t.name}</span>
                        <span className="ml-2 text-xs text-slate-500">{t.count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

            </div>
          </div>
          {/* Filter button removed */}
        </div>
      </div>

      {/* Search results */}
      <div className="space-y-2">
        {(hasSearched || searching || results.length > 0 || searchError) && (
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardContent className="p-4">
              <div className="space-y-2">
                {/* Small screens: 1st row = count + close */}
                <div className="flex items-center justify-between md:hidden">
                  <div className="text-sm text-slate-600 dark:text-slate-400 mr-1">
                    {searchError ? (
                      <span className="text-destructive">検索エラー: {searchError}</span>
                    ) : (
                      <span>
                        {searching ? '検索中…' : `表示中 ${results.length}件 / 全 ${totalResults}件`}
                      </span>
                    )}
                  </div>
                  <Button
                    aria-label="検索結果を閉じる"
                    title="検索結果を閉じる"
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700"
                    onClick={() => {
                      setHasSearched(false);
                      setSearchError(null);
                      setResults([]);
                      setTotalResults(0);
                      setHasMore(false);
                      setNextOffset(0);
                    }}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>

                {/* Large screens: single-line layout (count + pills on left, close on right) */}
                <div className="hidden md:flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-slate-600 dark:text-slate-400 mr-1">
                      {searchError ? (
                        <span className="text-destructive">検索エラー: {searchError}</span>
                      ) : (
                        <span>
                          {searching ? '検索中…' : `表示中 ${results.length}件 / 全 ${totalResults}件`}
                        </span>
                      )}
                    </div>
                    {/* Type selector (pill) */}
                    <div className="order-1">
                    <Select
                      value={searchType as any}
                      onValueChange={(val) => { const v = (val as any) || 'all'; setSearchType(v); fetchSearch(true, { type: v }); }}
                    >
                      <SelectTrigger
                        className={cn(
                          "relative h-8 w-auto px-3 text-sm rounded-full justify-start gap-2 transition-colors duration-150 [&>svg]:hidden font-light focus:outline-none focus:ring-0 focus:ring-offset-0",
                          searchType !== 'all'
                            ? "pr-8 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                            : "border-transparent bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                        )}
                      >
                        <span className="inline-flex items-center"><SlidersHorizontal className="w-4 h-4" /></span>
                        <span>{getTypeLabel(searchType as any)}</span>
                        {searchType !== 'all' && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="種別指定をクリア"
                            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-slate-200/70 dark:hover:bg-slate-600/70 z-20 pointer-events-auto leading-none"
                            onPointerDownCapture={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSearchType('all');
                              fetchSearch(true, { type: 'all' });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                setSearchType('all');
                                fetchSearch(true, { type: 'all' });
                              }
                            }}
                          >
                            <span className="flex items-center justify-center w-full h-full pointer-events-none">
                              <X className="w-3 h-3" aria-hidden="true" />
                            </span>
                          </span>
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">すべて</SelectItem>
                        <SelectItem value="entry">学習ログ</SelectItem>
                        <SelectItem value="goal">目標</SelectItem>
                        <SelectItem value="summary">サマリー</SelectItem>
                      </SelectContent>
                    </Select>
                    </div>

                    {/* Order selector */}
                    <div className="order-3">
                    <Select
                      value={sortOrder}
                      onValueChange={(val) => {
                        const v = (val as any) as 'relevance'|'newest'|'oldest';
                        setSortOrder(v);
                        fetchSearch(true, { order: v });
                      }}
                    >
                      <SelectTrigger
                        className={cn(
                          "relative h-8 w-auto px-3 text-sm rounded-full justify-start gap-2 transition-colors duration-150 [&>svg]:hidden font-light focus:outline-none focus:ring-0 focus:ring-offset-0",
                          sortOrder !== 'relevance'
                            ? "pr-8 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                            : "border-transparent bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                        )}
                      >
                        <span className="inline-flex items-center"><ArrowUpDown className="w-4 h-4" /></span>
                        <span>{sortOrder === 'relevance' ? '関連度' : sortOrder === 'newest' ? '新しい順' : '古い順'}</span>
                        {sortOrder !== 'relevance' && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="並び替えをクリア"
                            className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-slate-200/70 dark:hover:bg-slate-600/70 z-20 pointer-events-auto leading-none"
                            onPointerDownCapture={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSortOrder('relevance');
                              fetchSearch(true, { order: 'relevance' });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                setSortOrder('relevance');
                                fetchSearch(true, { order: 'relevance' });
                              }
                            }}
                          >
                            <span className="flex items-center justify-center w-full h-full pointer-events-none">
                              <X className="w-3 h-3" aria-hidden="true" />
                            </span>
                          </span>
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="relevance">関連度</SelectItem>
                        <SelectItem value="newest">新しい順</SelectItem>
                        <SelectItem value="oldest">古い順</SelectItem>
                      </SelectContent>
                    </Select>
                    </div>

                    {/* Range picker (pill) */}
                    <div className="order-2">
                    <Popover
                      modal
                      open={isRangeOpenMd}
                      onOpenChange={(o) => {
                        // prevent implicit close; only close via OK or header X
                        if (o) setIsRangeOpenMd(true); else setIsRangeOpenMd(false);
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(
                            "group relative h-8 px-3 rounded-full justify-start gap-2 transition-colors duration-150 font-light",
                            (dateRange?.from || dateRange?.to)
                              ? "pr-6 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                              : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                          )}
                          onClick={() => { setPendingRangeMd(dateRange); setIsRangeOpenMd(true); }}
                        >
                          <CalendarIcon className="w-4 h-4 transition-colors duration-150 group-hover:text-gray-700 dark:group-hover:text-gray-300" />
                          {formatRangeLabel(dateRange as any)}
                          {(dateRange?.from || dateRange?.to) && (
                            <span
                              role="button"
                              aria-label="期間指定をクリア"
                              tabIndex={0}
                              className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center hover:bg-slate-200/70 dark:hover:bg-slate-600/70"
                              onPointerDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setPendingRangeMd(undefined);
                                setDateRange(undefined);
                                setRangeAnchor(null);
                                setShowQuickMd(false);
                                setIsRangeOpenMd(false);
                                fetchSearch(true, { range: undefined });
                              }}
                              onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                e.stopPropagation();
                                setPendingRangeMd(undefined);
                                setDateRange(undefined);
                                setShowQuickMd(false);
                                setRangeAnchor(null);
                                setIsRangeOpenMd(false);
                                fetchSearch(true, { range: undefined });
                              }
                            }}
                            >
                              <X className="w-3 h-3" />
                            </span>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="p-2 w-fit max-w-[95vw]"
                        align="start"
                        onInteractOutside={(e) => { applyPendingAndCloseMd(); }}
                      >
                        <div ref={mdCalRef}>
                          <Calendar
                            mode="range"
                            selected={pendingRangeMd as any}
                            onSelect={(range: any) => {
                            if (rangeAnchor && (range?.from || range?.to)) {
                              const anchor = rangeAnchor.date;
                              let picked: Date | undefined = undefined;
                              if (range?.from && range?.to) {
                                picked = sameDay(range.from, anchor) ? range.to : range.from;
                              } else {
                                picked = range.from || range.to;
                              }
                              if (picked) {
                                const from = rangeAnchor.mode === 'from' ? anchor : picked;
                                const to = rangeAnchor.mode === 'from' ? picked : anchor;
                                const f = new Date(Math.min(from.getTime(), to.getTime()));
                                const t = new Date(Math.max(from.getTime(), to.getTime()));
                                setPendingRangeMd({ from: f, to: t } as any);
                                setRangeAnchor(null);
                                return;
                              }
                            }
                            setPendingRangeMd(range);
                            }}
                            numberOfMonths={1}
                            captionLayout="dropdown-buttons"
                            initialFocus
                          />
                        </div>
                        {/* Anchor actions row (single day selection) */}
                        {(isSingleDayRange(pendingRangeMd) || rangeAnchor || isInfUntilRange(pendingRangeMd) || isInfFromRange(pendingRangeMd)) && (
                          <div className="mt-2 grid grid-cols-2 gap-2 w-full" style={{ width: mdCalWidth ? `${mdCalWidth}px` : undefined }}>
                            <Button
                              variant={(rangeAnchor?.mode === 'to' || isInfUntilRange(pendingRangeMd)) ? 'default' : 'outline'}
                              aria-pressed={rangeAnchor?.mode === 'to' || isInfUntilRange(pendingRangeMd)}
                              size="sm"
                              className="w-full text-xs"
                              onClick={() => {
                              const pr = pendingRangeMd;
                              // base day: for "until" infinite, use 'to'; otherwise prefer 'from'
                              const base = (pr && isInfUntilRange(pr)) ? (pr.to as Date) : ((pr?.from as Date) || (pr?.to as Date));
                              if (!base) return;
                              if (rangeAnchor?.mode === 'to' || isInfUntilRange(pr)) {
                                // toggle off -> single day
                                setRangeAnchor(null);
                                setPendingRangeMd({ from: base, to: base } as any);
                              } else {
                                setRangeAnchor({ mode: 'to', date: base });
                                setPendingRangeMd({ from: MIN_DATE, to: base } as any);
                              }
                            }}>〜この日まで</Button>
                            <Button
                              variant={(rangeAnchor?.mode === 'from' || isInfFromRange(pendingRangeMd)) ? 'default' : 'outline'}
                              aria-pressed={rangeAnchor?.mode === 'from' || isInfFromRange(pendingRangeMd)}
                              size="sm"
                              className="w-full text-xs"
                              onClick={() => {
                              const pr = pendingRangeMd;
                              // base day: if current is "until" infinite, use its concrete end (pr.to); otherwise prefer pr.from then pr.to
                              const base = (pr && isInfUntilRange(pr)) ? (pr.to as Date) : ((pr?.from as Date) || (pr?.to as Date));
                              if (!base) return;
                              if (rangeAnchor?.mode === 'from' || isInfFromRange(pr)) {
                                setRangeAnchor(null);
                                setPendingRangeMd({ from: base, to: base } as any);
                              } else {
                                setRangeAnchor({ mode: 'from', date: base });
                                setPendingRangeMd({ from: base, to: MAX_DATE } as any);
                              }
                            }}>この日から〜</Button>
                          </div>
                        )}
                        {/* Bottom row: Clear and OK */}
                        <div className="mt-2 grid grid-cols-2 gap-2 w-full" style={{ width: mdCalWidth ? `${mdCalWidth}px` : undefined }}>
                          <Button variant="ghost" size="sm" className="w-full" onClick={() => { setPendingRangeMd(undefined); setRangeAnchor(null); /* defer search until OK/outside */ }}>クリア</Button>
                          <Button variant="default" size="sm" className="w-full" onClick={() => {
                            let applied: DateRange | undefined = pendingRangeMd;
                            if (applied?.from && !applied?.to) {
                              applied = { from: applied.from, to: applied.from } as any;
                            }
                            let normalized: DateRange | undefined = applied;
                            if (applied?.from && applied?.to) {
                              if (sameDay(applied.from as Date, MIN_DATE)) {
                                normalized = { to: applied.to } as any;
                              } else if (sameDay(applied.to as Date, MAX_DATE)) {
                                normalized = { from: applied.from } as any;
                              }
                            }
                            setDateRange(normalized);
                            fetchSearch(true, { range: normalized as any });
                            setIsRangeOpenMd(false);
                          }}>OK</Button>
                        </div>
                      </PopoverContent>
                    </Popover>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      aria-label="検索結果を閉じる"
                      title="検索結果を閉じる"
                      variant="ghost"
                      size="icon"
                      className="w-8 h-8 rounded-full hover:bg-gray-100 dark:hover:bg-slate-700"
                      onClick={() => {
                        setHasSearched(false);
                        setSearchError(null);
                        setResults([]);
                        setTotalResults(0);
                        setHasMore(false);
                        setNextOffset(0);
                      }}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
              </div>

                {/* Small screens: 2nd row = pills */}
                <div className="flex items-center gap-2 flex-wrap md:hidden">
                  {/* Type selector (pill) */}
                  <div className="order-1">
                  <Select
                    value={searchType as any}
                    onValueChange={(val) => { const v = (val as any) || 'all'; setSearchType(v); fetchSearch(true, { type: v }); }}
                  >
                    <SelectTrigger
                      className={cn(
                        "relative h-8 w-auto px-3 text-sm rounded-full justify-start gap-2 transition-colors duration-150 [&>svg]:hidden font-light focus:outline-none focus:ring-0 focus:ring-offset-0",
                        searchType !== 'all'
                          ? "pr-8 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                          : "border-transparent bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                      )}
                    >
                      <span className="inline-flex items-center"><SlidersHorizontal className="w-4 h-4" /></span>
                      <span>{getTypeLabel(searchType as any)}</span>
                      {searchType !== 'all' && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label="種別指定をクリア"
                          className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-slate-200/70 dark:hover:bg-slate-600/70 z-20 pointer-events-auto leading-none"
                          onPointerDownCapture={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSearchType('all');
                            fetchSearch(true, { type: 'all' });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              setSearchType('all');
                              fetchSearch(true, { type: 'all' });
                            }
                          }}
                        >
                          <span className="flex items-center justify-center w-full h-full pointer-events-none">
                            <X className="w-3 h-3" aria-hidden="true" />
                          </span>
                        </span>
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">すべて</SelectItem>
                      <SelectItem value="entry">学習ログ</SelectItem>
                      <SelectItem value="goal">目標</SelectItem>
                      <SelectItem value="summary">サマリー</SelectItem>
                    </SelectContent>
                  </Select>
                  </div>

                  {/* Order selector */}
                  <div className="order-3">
                  <Select
                    value={sortOrder}
                    onValueChange={(val) => {
                      const v = (val as any) as 'relevance'|'newest'|'oldest';
                      setSortOrder(v);
                      fetchSearch(true, { order: v });
                    }}
                  >
                    <SelectTrigger
                      className={cn(
                        "relative h-8 w-auto px-3 text-sm rounded-full justify-start gap-2 transition-colors duration-150 [&>svg]:hidden font-light focus:outline-none focus:ring-0 focus:ring-offset-0",
                        sortOrder !== 'relevance'
                          ? "pr-8 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                          : "border-transparent bg-transparent text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                      )}
                    >
                      <span className="inline-flex items-center"><ArrowUpDown className="w-4 h-4" /></span>
                      <span>{sortOrder === 'relevance' ? '関連度' : sortOrder === 'newest' ? '新しい順' : '古い順'}</span>
                      {sortOrder !== 'relevance' && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label="並び替えをクリア"
                          className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-slate-200/70 dark:hover:bg-slate-600/70 z-20 pointer-events-auto leading-none"
                          onPointerDownCapture={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSortOrder('relevance');
                            fetchSearch(true, { order: 'relevance' });
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              setSortOrder('relevance');
                              fetchSearch(true, { order: 'relevance' });
                            }
                          }}
                        >
                          <span className="flex items-center justify-center w-full h-full pointer-events-none">
                            <X className="w-3 h-3" aria-hidden="true" />
                          </span>
                        </span>
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relevance">関連度</SelectItem>
                      <SelectItem value="newest">新しい順</SelectItem>
                      <SelectItem value="oldest">古い順</SelectItem>
                    </SelectContent>
                  </Select>
                  </div>

                  {/* Range picker (pill) */}
                  <div className="order-2">
                  <Popover
                    modal
                    open={isRangeOpenSm}
                    onOpenChange={(o) => { if (o) setIsRangeOpenSm(true); else setIsRangeOpenSm(false); }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                          "group relative h-8 px-3 rounded-full justify-start gap-2 transition-colors duration-150 font-light",
                          (dateRange?.from || dateRange?.to)
                            ? "pr-6 border text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-900/50 hover:bg-sky-50 dark:hover:bg-sky-900/50 bg-transparent"
                            : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-slate-700"
                        )}
                        onClick={() => { setPendingRangeSm(dateRange); setIsRangeOpenSm(true); }}
                      >
                        <CalendarIcon className="w-4 h-4 transition-colors duration-150 group-hover:text-gray-700 dark:group-hover:text-gray-300" />
                        {formatRangeLabel(dateRange as any)}
                        {(dateRange?.from || dateRange?.to) && (
                          <span
                            role="button"
                            aria-label="期間指定をクリア"
                            tabIndex={0}
                            className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center hover:bg-slate-200/70 dark:hover:bg-slate-600/70"
                            onPointerDownCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setPendingRangeSm(undefined);
                              setDateRange(undefined);
                              setShowQuickSm(false);
                              setRangeAnchor(null);
                              setIsRangeOpenSm(false);
                              fetchSearch(true, { range: undefined });
                            }}
                            onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              setPendingRangeSm(undefined);
                              setDateRange(undefined);
                              setShowQuickSm(false);
                              setRangeAnchor(null);
                              setIsRangeOpenSm(false);
                              fetchSearch(true, { range: undefined });
                            }
                          }}
                          >
                            <X className="w-3 h-3" />
                          </span>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="p-2 w-fit max-w-[95vw]"
                      align="start"
                      onInteractOutside={(e) => { applyPendingAndCloseSm(); }}
                    >
                      <div ref={smCalRef}>
                        <Calendar
                          mode="range"
                          selected={pendingRangeSm as any}
                          onSelect={(range: any) => {
                          if (rangeAnchor && (range?.from || range?.to)) {
                            const anchor = rangeAnchor.date;
                            let picked: Date | undefined = undefined;
                            if (range?.from && range?.to) {
                              picked = sameDay(range.from, anchor) ? range.to : range.from;
                            } else {
                              picked = range.from || range.to;
                            }
                            if (picked) {
                              const from = rangeAnchor.mode === 'from' ? anchor : picked;
                              const to = rangeAnchor.mode === 'from' ? picked : anchor;
                              const f = new Date(Math.min(from.getTime(), to.getTime()));
                              const t = new Date(Math.max(from.getTime(), to.getTime()));
                              setPendingRangeSm({ from: f, to: t } as any);
                              setRangeAnchor(null);
                              return;
                            }
                          }
                          setPendingRangeSm(range);
                        }}
                        numberOfMonths={1}
                        captionLayout="dropdown-buttons"
                        initialFocus
                        />
                      </div>
                      {/* Anchor actions row (single day selection) */}
                      {(isSingleDayRange(pendingRangeSm) || rangeAnchor || isInfUntilRange(pendingRangeSm) || isInfFromRange(pendingRangeSm)) && (
                        <div className="mt-2 grid grid-cols-2 gap-2 w-full" style={{ width: smCalWidth ? `${smCalWidth}px` : undefined }}>
                          <Button
                            variant={(rangeAnchor?.mode === 'to' || isInfUntilRange(pendingRangeSm)) ? 'default' : 'outline'}
                            aria-pressed={rangeAnchor?.mode === 'to' || isInfUntilRange(pendingRangeSm)}
                            size="sm"
                            className="w-full text-xs"
                            onClick={() => {
                            const pr = pendingRangeSm;
                            const base = (pr && isInfUntilRange(pr)) ? (pr.to as Date) : ((pr?.from as Date) || (pr?.to as Date));
                            if (!base) return;
                            if (rangeAnchor?.mode === 'to' || isInfUntilRange(pr)) {
                              setRangeAnchor(null);
                              setPendingRangeSm({ from: base, to: base } as any);
                            } else {
                              setRangeAnchor({ mode: 'to', date: base });
                              setPendingRangeSm({ from: MIN_DATE, to: base } as any);
                            }
                          }}>〜この日まで</Button>
                          <Button
                            variant={(rangeAnchor?.mode === 'from' || isInfFromRange(pendingRangeSm)) ? 'default' : 'outline'}
                            aria-pressed={rangeAnchor?.mode === 'from' || isInfFromRange(pendingRangeSm)}
                            size="sm"
                            className="w-full text-xs"
                            onClick={() => {
                            const pr = pendingRangeSm;
                            const base = (pr && isInfUntilRange(pr)) ? (pr.to as Date) : ((pr?.from as Date) || (pr?.to as Date));
                            if (!base) return;
                            if (rangeAnchor?.mode === 'from' || isInfFromRange(pr)) {
                              setRangeAnchor(null);
                              setPendingRangeSm({ from: base, to: base } as any);
                            } else {
                              setRangeAnchor({ mode: 'from', date: base });
                              setPendingRangeSm({ from: base, to: MAX_DATE } as any);
                            }
                          }}>この日から〜</Button>
                        </div>
                      )}
                      {/* Bottom row: Clear and OK */}
                      <div className="mt-2 grid grid-cols-2 gap-2 w-full" style={{ width: smCalWidth ? `${smCalWidth}px` : undefined }}>
                        <Button variant="ghost" size="sm" className="w-full" onClick={() => { setPendingRangeSm(undefined); setRangeAnchor(null); /* defer search until OK/outside */ }}>クリア</Button>
                        <Button variant="default" size="sm" className="w-full" onClick={() => {
                          let applied: DateRange | undefined = pendingRangeSm;
                          if (applied?.from && !applied?.to) {
                            applied = { from: applied.from, to: applied.from } as any;
                          }
                          let normalized: DateRange | undefined = applied;
                          if (applied?.from && applied?.to) {
                            if (sameDay(applied.from as Date, MIN_DATE)) {
                              normalized = { to: applied.to } as any;
                            } else if (sameDay(applied.to as Date, MAX_DATE)) {
                              normalized = { from: applied.from } as any;
                            }
                          }
                          setDateRange(normalized);
                          fetchSearch(true, { range: normalized as any });
                          setIsRangeOpenSm(false);
                        }}>OK</Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  </div>
                </div>

                {/* Quick actions are shown inside the popover footer */}
              </div>
              <div className="mt-3 space-y-2">
                {results.map((item, idx) => {
                  const mainTitle =
                    (item.kind === 'goal' && item.task) ||
                    (item.kind === 'entry' && (item.type === 'BREAK' ? '休憩' : item.content || item.subject || '(内容なし)')) ||
                    (item.kind === 'summary' && `${formatJPMonthDay(item.date)}のまとめ`) ||
                    item.preview ||
                    '(タイトルなし)';

                  const snippets = Array.isArray(item.snippets) && item.snippets.length > 0
                    ? item.snippets.slice(0, 2)
                    : null;
                  return (
                    <div key={idx} className="p-3 rounded-md bg-slate-50 dark:bg-slate-700/40 flex items-start justify-between">
                      <div className="pr-3 flex-grow min-w-0">
                        <div className="text-xs text-slate-500 mb-1">{item.kind.toUpperCase()} ・ {item.date}</div>
                        <div className="text-slate-800 dark:text-slate-100 font-medium truncate" title={mainTitle}>{renderHighlighted(mainTitle)}</div>

                        {/* Sub-contents: Subject and Tags */}
                        <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-slate-600 dark:text-slate-400">
                          {(() => {
                            const renderedSubject = item.subject ? renderHighlighted(item.subject) : null;
                            if (renderedSubject && Array.isArray(renderedSubject)) {
                              return (
                                <div className="flex items-center">
                                  <BookUser className="w-3.5 h-3.5 mr-1.5" />
                                  <span>{renderedSubject}</span>
                                </div>
                              );
                            }
                            return null;
                          })()}
                          {item.kind === 'goal' && item.tags && item.tags.length > 0 && (
                            <div className="flex items-center">
                              <Tag className="w-3.5 h-3.5 mr-1.5" />
                              <div className="flex flex-wrap gap-1">
                                {item.tags.map((tag: string, i: number) => (
                                  <Badge key={i} variant="secondary" className="px-1.5 py-0.5 text-xs font-normal">{renderHighlighted(`#${tag}`)}</Badge>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Snippets: memo and impression only */}
                        {snippets && (
                          <div className="mt-2 space-y-1">
                            {snippets
                              .filter((sn: any) => sn.field === 'memo' || sn.field === 'impression' || sn.field === 'session_summary')
                              .map((sn: any, i: number) => (
                                <div key={i} className="flex items-start text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                                  <SnippetIcon field={sn.field} />
                                  <span className="flex-1">{renderHighlighted(sn.text)}</span>
                                </div>
                              ))
                            }
                          </div>
                        )}

                        {item._expanded && (
                          <div className="mt-2 text-sm text-slate-700 dark:text-slate-300 space-y-2">
                            {item._loadingDetails && (
                              <div className="text-xs text-slate-500">詳細を取得中...</div>
                            )}
                            {!item._loadingDetails && item.kind === 'entry' && item._details && (
                              <div className="space-y-1">
                                <div><span className="text-xs text-slate-500">種別:</span> {item._details.event_type}</div>
                                <div><span className="text-xs text-slate-500">教科:</span> {item._details.subject || '(なし)'}</div>
                                <div><span className="text-xs text-slate-500">内容:</span> {item._details.content || '(なし)'}</div>
                                {item._details.summary && (<div><span className="text-xs text-slate-500">セッションサマリー:</span> {item._details.summary}</div>)}
                                {item._details.memo && (<div><span className="text-xs text-slate-500">メモ:</span> <span className="whitespace-pre-wrap">{item._details.memo}</span></div>)}
                                {item._details.impression && (<div><span className="text-xs text-slate-500">所感:</span> <span className="whitespace-pre-wrap">{item._details.impression}</span></div>)}
                                <div><span className="text-xs text-slate-500">開始:</span> {item._details.start_time || '(不明)'} / <span className="text-xs text-slate-500">終了:</span> {item._details.end_time || '(未設定)'}</div>
                                <div><span className="text-xs text-slate-500">学習時間:</span> {typeof item._details.duration_minutes === 'number' ? `${item._details.duration_minutes}分` : '(不明)'}</div>
                              </div>
                            )}
                            {!item._loadingDetails && item.kind === 'goal' && item._details && (
                              <div className="space-y-1">
                                <div><span className="text-xs text-slate-500">教科:</span> {item._details.subject || '(なし)'}</div>
                                <div><span className="text-xs text-slate-500">タスク:</span> {item._details.task}</div>
                                {item._details.details && (<div><span className="text-xs text-slate-500">詳細:</span> <span className="whitespace-pre-wrap">{item._details.details}</span></div>)}
                                {Array.isArray(item._details.tags) && item._details.tags.length > 0 && (
                                  <div className="flex items-center flex-wrap gap-1"><span className="text-xs text-slate-500 mr-1">タグ:</span>
                                    {item._details.tags.map((t: string, i: number) => (
                                      <Badge key={i} variant="secondary" className="px-1.5 py-0.5 text-xs font-normal">#{t}</Badge>
                                    ))}
                                  </div>
                                )}
                                {(item._details.total_problems != null) && (
                                  <div><span className="text-xs text-slate-500">問題数:</span> {item._details.completed_problems ?? 0}/{item._details.total_problems} 問</div>
                                )}
                                <div><span className="text-xs text-slate-500">完了:</span> {item._details.completed ? '済' : '未'}</div>
                              </div>
                            )}
                            {!item._loadingDetails && item.kind === 'summary' && (
                              <div className="space-y-1">
                                <div className="text-xs text-slate-500">この日のまとめ</div>
                                <div className="whitespace-pre-wrap">{item._details?.summary ?? '(サマリーなし)'}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={async () => {
                            const captured = { id: item.id, kind: item.kind, date: item.date };
                            // Step 1: toggle expand and, if needed, mark loading via functional update
                            let needFetch = false;
                            setResults(prev => {
                              const arr = [...prev];
                              const i = arr.findIndex((it: any) => it.id === captured.id && it.kind === captured.kind && it.date === captured.date);
                              if (i === -1) return prev;
                              const curI = { ...arr[i] } as any;
                              const expandTo = !curI._expanded;
                              curI._expanded = expandTo;
                              if (expandTo && !curI._details && !curI._loadingDetails) {
                                curI._loadingDetails = true;
                                needFetch = true;
                              }
                              arr[i] = curI;
                              return arr;
                            });

                            if (!needFetch) return;

                            // Step 2: fetch details outside setState, then commit via functional update
                            try {
                              if (captured.kind === 'entry') {
                                const res = await fetch(`/api/logs/entry/${captured.id}`);
                                const data = await res.json();
                                const entry = data?.entry || {};
                                setResults(prev => {
                                  const arr = [...prev];
                                  const i = arr.findIndex((it: any) => it.id === captured.id && it.kind === captured.kind && it.date === captured.date);
                                  if (i === -1) return prev;
                                  arr[i] = { ...arr[i], _details: entry, _loadingDetails: false };
                                  return arr;
                                });
                              } else if (captured.kind === 'goal') {
                                const res = await fetch(`/api/goals/${captured.id}`);
                                const data = await res.json();
                                let goal = data?.goal || data?.data || data || {};
                                try { if (goal && typeof goal.tags === 'string') goal.tags = JSON.parse(goal.tags); } catch {}
                                setResults(prev => {
                                  const arr = [...prev];
                                  const i = arr.findIndex((it: any) => it.id === captured.id && it.kind === captured.kind && it.date === captured.date);
                                  if (i === -1) return prev;
                                  arr[i] = { ...arr[i], _details: goal, _loadingDetails: false };
                                  return arr;
                                });
                              } else if (captured.kind === 'summary') {
                                const res = await fetch(`/api/logs/${captured.date}`);
                                const data = await res.json();
                                const summary = data?.daily_summary?.summary ?? null;
                                setResults(prev => {
                                  const arr = [...prev];
                                  const i = arr.findIndex((it: any) => it.id === captured.id && it.kind === captured.kind && it.date === captured.date);
                                  if (i === -1) return prev;
                                  arr[i] = { ...arr[i], _details: { summary }, _loadingDetails: false };
                                  return arr;
                                });
                              }
                            } catch {
                              setResults(prev => {
                                const arr = [...prev];
                                const i = arr.findIndex((it: any) => it.id === captured.id && it.kind === captured.kind && it.date === captured.date);
                                if (i === -1) return prev;
                                arr[i] = { ...arr[i], _loadingDetails: false };
                                return arr;
                              });
                            }
                          }}
                        >
                          詳細
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => {
                            setPendingJump({ date: item.date, id: item.id, logId: item.kind === 'entry' ? item.id : undefined, kind: item.kind });
                            onDateChange(item.date);
                          }}
                        >
                          該当へジャンプ
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {hasMore && (
                  <div className="flex justify-center mt-2">
                    <Button variant="outline" size="sm" disabled={searching} onClick={() => fetchSearch(false)}>
                      さらに読み込む
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Date Navigation & Summary */}
      <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <Button variant="ghost" size="sm" onClick={(e) => handleDateChange('prev', e)} disabled={isLoading} className="dark:text-slate-200">
              <ChevronLeft className="w-4 h-4 mr-1" />
              前日
            </Button>
            <div className="text-center">
              <Popover open={isDatePickerOpen} onOpenChange={setDatePickerOpen}>
                <PopoverTrigger asChild>
                   <Button variant="ghost" className="text-2xl font-bold text-slate-800 dark:text-slate-100" disabled={isLoading}>
                    {formatDate(selectedDate)}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="center">
                  <Calendar
                    mode="single"
                    selected={new Date(selectedDate)}
                    onSelect={handleDateSelect}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <Button variant="ghost" size="sm" onClick={(e) => handleDateChange('next', e)} disabled={isLoading} className="dark:text-slate-200">
              翌日
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>

          {isLoading ? (
            <div className="space-y-4 mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
              <div className="flex justify-center space-x-6">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-4 w-24 rounded" />
              </div>
              <Skeleton className="h-4 w-3/4 rounded mt-4" />
            </div>
          ) : logData && logData.daily_summary ? (
            <>
              <div className="flex items-center justify-center space-x-6 mt-2 h-5 mb-4">
                <div className="flex items-center space-x-2">
                  <Clock className="w-4 h-4 text-blue-600" />
                  <span className="text-sm text-slate-600 dark:text-slate-400">{!isMobile && '総学習時間: '}{formatDuration(logData.daily_summary.total_duration)}</span>
                </div>
                <div className="flex items-center space-x-2">
                  <BookOpen className="w-4 h-4 text-green-600" />
                  <span className="text-sm text-slate-600 dark:text-slate-400">{!isMobile && 'セッション数: '}{logData.sessions.length}</span>
                </div>
              </div>
              <div className="mt-4 pt-6 border-t border-slate-200 dark:border-slate-700">
                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100 mb-2 pl-1">この日のまとめ</h3>
                    <p id={`summary-${selectedDate}`} className={cn("text-slate-600 dark:text-slate-400 whitespace-pre-wrap pl-1 transition-colors transition-shadow duration-700", highlightSummaryDate === selectedDate && "bg-yellow-50 dark:bg-yellow-900/30 ring-2 ring-yellow-400 rounded")}>{logData.daily_summary.summary || 'サマリーはありません。'}</p>
                  </div>
                  <div className="flex flex-col justify-center space-y-4">
                    <div>
                      <h4 className="font-semibold text-slate-800 dark:text-slate-100 mb-2 text-center">学習した教科</h4>
                      <div className="flex flex-wrap gap-2 justify-center">
                        {logData.daily_summary.subjects.length > 0 ? (
                          logData.daily_summary.subjects.map((subject, index) => (
                            <Badge
                              key={index}
                              variant="outline"
                              className="text-base h-fit"
                              style={{
                                ...getSubjectStyle(subject, subjectColors),
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {subject}
                            </Badge>
                          ))
                        ) : (
                          <p className="text-sm text-slate-500 dark:text-slate-400">記録がありません</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-6">
                <DailyGoalsCard
                  title="この日の目標"
                  className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                  goals={logData.daily_summary.goals ?? []}
                  stats={{
                    completedGoals: logData.daily_summary.goals?.filter(g => g.completed).length ?? 0,
                    totalGoals: logData.daily_summary.goals?.length ?? 0,
                  }}
                  isToday={isToday}
                  onMoveGoal={handleMoveGoal}
                  onSelectGoal={onSelectGoal}
                  subjectColors={subjectColors}
                  highlightGoalIds={highlightGoalIds}
                />
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Content Area */}
      {renderContent()}
    </div>
  )
}
