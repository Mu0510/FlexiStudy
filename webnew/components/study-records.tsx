"use client"

import { useState } from "react"
import { useIsMobile } from "@/hooks/use-mobile"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import { Skeleton } from "@/components/ui/skeleton"
import { Clock, BookOpen, Search, Filter, ChevronLeft, ChevronRight, Play, Pause, MessageSquare, ChevronDown, ChevronUp, AlertCircle } from "lucide-react"

// Define the types for our data to ensure type safety
interface LogEntry {
  type: 'START' | 'BREAK' | 'RESUME';
  duration_minutes: number;
  content: string;
  start_time: string;
  end_time: string;
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
}

const RecordsSkeleton = () => (
  <div className="space-y-4">
    {[...Array(3)].map((_, i) => (
      <Card key={i} className="bg-white border-0 shadow-lg rounded-lg overflow-hidden">
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


export function StudyRecords({ logData, onDateChange, selectedDate, isLoading, error }: StudyRecordsProps) {
  const [openSessions, setOpenSessions] = useState<Record<number, boolean>>({});
  const [isDatePickerOpen, setDatePickerOpen] = useState(false);
  const isMobile = useIsMobile();

  const toggleSession = (sessionId: number) => {
    setOpenSessions(prev => ({ ...prev, [sessionId]: !prev[sessionId] }));
  };

  const handleDateChange = (direction: 'prev' | 'next') => {
    const currentDate = new Date(selectedDate);
    currentDate.setDate(currentDate.getDate() + (direction === 'prev' ? -1 : 1));
    onDateChange(currentDate.toISOString().split('T')[0]);
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

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    const formattedDate = new Intl.DateTimeFormat('ja-JP', options).format(date);
    // "2025年7月20日日曜日" -> "2025年 7月20日 日曜日"
    return formattedDate.replace(/(\d+)年(\d+)月(\d+)日(.*)/, '$1年 $2月$3日 $4');
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
        <div className="text-center p-10 bg-white rounded-lg shadow-lg">
          <h2 className="text-xl font-semibold">この日付の学習記録はありません</h2>
          <p className="text-slate-500 mt-2">別の日付を選択するか、新しい学習を開始してください。</p>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {logData.sessions.map((session) => (
          <Card key={session.session_id} className="bg-white border-0 shadow-lg rounded-lg overflow-hidden">
            <CardHeader 
              className="p-4 cursor-pointer hover:bg-slate-50"
              onClick={() => toggleSession(session.session_id)}
            >
              <div className="flex flex-col">
                <div className="flex items-center justify-between w-full">
                  <div className="flex items-center space-x-2">
                    <Badge variant="outline" className="border-blue-200 text-blue-700 bg-blue-50 text-base">
                      {session.subject}
                    </Badge>
                    <span className="text-sm text-slate-500">(ID: {session.session_id})</span>
                  </div>
                  <span className="text-lg font-semibold text-slate-800 whitespace-nowrap">
                    {session.start_time} - {session.end_time}
                  </span>
                  <div className="flex items-center space-x-2">
                    <Badge className="bg-green-100 text-green-800 border-green-200 text-base">
                      {formatDuration(session.total_duration)}
                    </Badge>
                    {openSessions[session.session_id] ? <ChevronUp className="w-5 h-5 text-slate-500" /> : <ChevronDown className="w-5 h-5 text-slate-500" />}
                  </div>
                </div>
                {!isMobile && (
                  <div className="mt-2">
                    <p className="text-slate-700 flex items-center text-sm">
                      <MessageSquare className="w-4 h-4 mr-2 text-slate-400 flex-shrink-0" />
                      <span className="truncate">{session.summary.startsWith(`${session.subject}：`) ? session.summary.substring(session.subject.length + 1) : session.summary}</span>
                    </p>
                  </div>
                )}
              </div>
            </CardHeader>
            {openSessions[session.session_id] && (
              <CardContent className="p-6 pt-0">
                <div className="border-t pt-4 mt-4">
                  {isMobile && (
                    <div className="mb-4">
                      <h4 className="font-semibold text-slate-800 mb-2">セッション概要</h4>
                      <p className="text-slate-700 flex items-start">
                        <MessageSquare className="w-4 h-4 mr-2 text-slate-400 flex-shrink-0 mt-1" />
                        <span>{session.summary.startsWith(`${session.subject}：`) ? session.summary.substring(session.subject.length + 1) : session.summary}</span>
                      </p>
                    </div>
                  )}
                  <h4 className="font-semibold text-slate-800 mb-3">セッション詳細</h4>
                  <div className="space-y-3">
                    {session.logs.map((detail, index) => (
                      <div key={index} className="flex items-center space-x-4 p-3 bg-slate-50 rounded-lg">
                        <div className="flex items-center space-x-3">
                          {detail.type === "START" && <div className="p-2 bg-green-100 rounded-full"><Play className="w-4 h-4 text-green-600" /></div>}
                          {detail.type === "BREAK" && <div className="p-2 bg-orange-100 rounded-full"><Pause className="w-4 h-4 text-orange-600" /></div>}
                          {detail.type === "RESUME" && <div className="p-2 bg-blue-100 rounded-full"><Play className="w-4 h-4 text-blue-600" /></div>}
                          <Badge
                            variant="outline"
                            className={
                              detail.type === "START" ? "border-green-200 text-green-700"
                              : detail.type === "BREAK" ? "border-orange-200 text-orange-700"
                              : "border-blue-200 text-blue-700"
                            }
                          >
                            {detail.type}
                          </Badge>
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-slate-800">{detail.content || "休憩"}</span>
                            <div className="flex items-center space-x-4 text-sm text-slate-600">
                              <span className="whitespace-nowrap">{formatDuration(detail.duration_minutes)}</span>
                              <span className="whitespace-nowrap">{detail.start_time} - {detail.end_time}</span>
                            </div>
                          </div>
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
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">学習記録</h1>
          <p className="text-slate-600 mt-1">あなたの学習履歴を詳細に確認できます</p>
        </div>
        <div className="flex items-center space-x-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
            <Input placeholder="学習内容を検索..." className="pl-10 w-64" />
          </div>
          <Button variant="outline" size="sm">
            <Filter className="w-4 h-4 mr-2" />
            フィルター
          </Button>
        </div>
      </div>

      {/* Date Navigation & Summary */}
      <Card className="border-0 shadow-lg">
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => handleDateChange('prev')} disabled={isLoading}>
              <ChevronLeft className="w-4 h-4 mr-1" />
              前日
            </Button>
            <div className="text-center">
              <Popover open={isDatePickerOpen} onOpenChange={setDatePickerOpen}>
                <PopoverTrigger asChild>
                   <Button variant="ghost" className="text-2xl font-bold text-slate-800" disabled={isLoading}>
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
              <div className="flex items-center justify-center space-x-6 mt-2 h-5">
                {isLoading ? (
                  <>
                    <Skeleton className="h-4 w-32 rounded" />
                    <Skeleton className="h-4 w-24 rounded" />
                  </>
                ) : logData ? (
                  <>
                    <div className="flex items-center space-x-2">
                      <Clock className="w-4 h-4 text-blue-600" />
                      <span className="text-sm text-slate-600">総学習時間: {formatDuration(logData.daily_summary.total_duration)}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <BookOpen className="w-4 h-4 text-green-600" />
                      <span className="text-sm text-slate-600">セッション数: {logData.sessions.length}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center space-x-2">
                      <Clock className="w-4 h-4 text-slate-400" />
                      <span className="text-sm text-slate-500">総学習時間: --</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <BookOpen className="w-4 h-4 text-slate-400" />
                      <span className="text-sm text-slate-500">セッション数: --</span>
                    </div>
                  </>
                )}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => handleDateChange('next')} disabled={isLoading}>
              翌日
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Content Area */}
      {renderContent()}
    </div>
  )
}
