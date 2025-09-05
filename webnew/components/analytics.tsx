"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BarChart3, TrendingUp, Clock, Target, Calendar, Award, BookOpen, Zap, AlertTriangle, Flame } from "lucide-react"
import { SubjectStudyTimeChart } from "@/components/subject-study-time-chart"
import { useEffect, useState } from "react"
import { FeatureOverlay } from "@/components/feature-overlay"

interface WeeklyData {
  day: string;
  time: number;
}

interface DashboardData {
  studyStats: {
    todayTime: number;
    weeklyTime: number;
    monthlyTime: number;
    streak: number;
    goalAchievementRate: number;
    completedGoals: number;
    totalGoals: number;
  };
  todayGoals: any[];
  recentSessions: any[];
}

export function Analytics() {
  const [weeklyData, setWeeklyData] = useState<WeeklyData[]>([])
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [weeklyPeriod, setWeeklyPeriod] = useState<string>(() => {
    if (typeof window === 'undefined') return 'this_week';
    try { return localStorage.getItem('weeklyPeriod') || 'this_week'; } catch { return 'this_week'; }
  });
  const [weekStart, setWeekStart] = useState<string>(() => {
    if (typeof window === 'undefined') return 'sunday';
    try { return localStorage.getItem('weekStart') || 'sunday'; } catch { return 'sunday'; }
  });
  const weeklyLabel = weeklyPeriod === '7_days' ? '過去7日間' : '今週の学習時間';
  const weeklyPeriodDays = weeklyPeriod === '7_days' ? 7 : null;

  const fetchAll = () => {
    // 週次チャート（weekly-study-time）は week_start 非対応の可能性があるため、
    // 互換性の高い形に戻す: 7日間の時だけ weekly_period を付与し、this_week の時はパラメータ無し。
    const weeklyParams = new URLSearchParams();
    if (weeklyPeriodDays) {
      weeklyParams.set('mode', 'last_7');
    } else {
      weeklyParams.set('mode', 'this_week');
      if (weekStart) weeklyParams.set('week_start', weekStart);
    }
    const dashboardParams = new URLSearchParams();
    if (weeklyPeriodDays) dashboardParams.set('weekly_period', String(weeklyPeriodDays));
    if (weekStart) dashboardParams.set('week_start', weekStart);
    const qsWeekly = weeklyParams.toString() ? `?${weeklyParams.toString()}` : '';
    const qsDashboard = dashboardParams.toString() ? `?${dashboardParams.toString()}` : '';
    setIsLoading(true);
    Promise.all([
      fetch(`/api/analytics/weekly-study-time${qsWeekly}`).then((res) => res.json()),
      fetch(`/api/dashboard${qsDashboard}`).then((res) => res.json()),
    ])
      .then(([weekly, dashboard]) => {
        // 週次データは配列のみ受け付ける（エラー時などは空配列へ）
        const weeklyArr = Array.isArray(weekly)
          ? weekly
          : (Array.isArray(weekly?.data) ? weekly.data : []);
        setWeeklyData(weeklyArr)
        setDashboardData(dashboard && typeof dashboard === 'object' ? dashboard : null)
        setIsLoading(false)
      })
      .catch((error) => {
        console.error("Failed to fetch analytics data:", error)
        setIsLoading(false)
      })
  };

  useEffect(() => {
    fetchAll();
  }, [weeklyPeriod, weekStart]);

  // アナリティクスはDBライブ更新不要。

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'weeklyPeriod') {
        setWeeklyPeriod(e.newValue || 'this_week');
      } else if (e.key === 'weekStart') {
        setWeekStart(e.newValue || 'sunday');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const subjectData = [
    { subject: "数学", time: 420, sessions: 12, avgScore: 78, trend: "up" },
    { subject: "物理", time: 380, sessions: 15, avgScore: 82, trend: "up" },
    { subject: "化学", time: 290, sessions: 8, avgScore: 75, trend: "down" },
    { subject: "英語", time: 250, sessions: 10, avgScore: 88, trend: "stable" },
  ]

  // 表示用に並べ替え：this_week は設定の日曜/月曜始まりに回転、7日間はそのまま
  const rotateOrder = (data: WeeklyData[], start: 'sunday'|'monday'): WeeklyData[] => {
    const order = start === 'monday'
      ? ['月','火','水','木','金','土','日']
      : ['日','月','火','水','木','金','土'];
    const map: Record<string, WeeklyData> = Object.fromEntries(data.map(d => [String(d.day), d]));
    return order.map(label => map[label] || { day: label, time: 0 });
  };
  const displayWeeklyData: WeeklyData[] = weeklyPeriodDays ? weeklyData : rotateOrder(weeklyData, (weekStart as 'sunday'|'monday'));
  const maxTime = displayWeeklyData.length > 0 ? Math.max(...displayWeeklyData.map((d) => d.time)) : 0

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m > 0 ? `${m}m` : ''}`.trim();
  };

  const [showInsightsOverlay, setShowInsightsOverlay] = useState(true);

  return (
    <div className="space-y-6 pt-16 lg:pt-0 relative">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-neutral-800 dark:text-slate-100">グラフ分析</h1>
          <p className="text-neutral-600 dark:text-slate-400 mt-1">学習データを可視化して効率的な学習をサポート</p>
        </div>

        <div className="flex items-center space-x-3">
          <Button variant="outline" size="sm" className="border-neutral-300 text-neutral-700 bg-transparent">
            <Calendar className="w-4 h-4 mr-2" />
            期間選択
          </Button>
          <Button variant="outline" size="sm" className="border-neutral-300 text-neutral-700 bg-transparent">
            <BarChart3 className="w-4 h-4 mr-2" />
            エクスポート
          </Button>
        </div>
      </div>

      

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 shadow-md bg-gradient-to-br from-primary-50 to-primary-100 dark:bg-slate-800 dark:from-slate-800 dark:to-slate-900">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-200 rounded-lg dark:bg-primary-900/50">
                <Clock className="w-5 h-5 text-primary-700 dark:text-primary-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800 dark:text-slate-100">
                  {isLoading ? '...' : formatTime(dashboardData?.studyStats.weeklyTime ?? 0)}
                </div>
                <div className="text-sm text-primary-700 dark:text-slate-400">{weeklyLabel}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-secondary-50 to-secondary-100 dark:bg-slate-800 dark:from-slate-800 dark:to-slate-900">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-secondary-200 rounded-lg dark:bg-secondary-900/50">
                <Flame className="w-5 h-5 text-secondary-700 dark:text-secondary-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-secondary-800 dark:text-slate-100">
                  {isLoading ? '...' : `${dashboardData?.studyStats.streak ?? 0}日`}
                </div>
                <div className="text-sm text-secondary-700 dark:text-slate-400">連続学習日数</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-accent-50 to-accent-100 dark:bg-slate-800 dark:from-slate-800 dark:to-slate-900">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-accent-200 rounded-lg dark:bg-accent-900/50">
                <Target className="w-5 h-5 text-accent-700 dark:text-accent-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-accent-800 dark:text-slate-100">
                  {isLoading ? '...' : `${Math.round(dashboardData?.studyStats.goalAchievementRate ?? 0)}%`}
                </div>
                <div className="text-sm text-accent-700 dark:text-slate-400">目標達成率</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-neutral-100 to-neutral-200 dark:bg-slate-800 dark:from-slate-800 dark:to-slate-900">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-neutral-300 rounded-lg dark:bg-neutral-700/50">
                <Calendar className="w-5 h-5 text-neutral-700 dark:text-slate-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-neutral-800 dark:text-slate-100">
                  {isLoading ? '...' : formatTime(dashboardData?.studyStats.monthlyTime ?? 0)}
                </div>
                <div className="text-sm text-neutral-700 dark:text-slate-400">直近30日間</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="lg:col-span-1 space-y-6">
          {/* Weekly Study Time Chart */}
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
                <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                <span>{weeklyLabel}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div>Loading...</div>
              ) : (
                <div className="space-y-4">
                  {displayWeeklyData.length === 0 ? (
                    <div className="text-sm text-neutral-500 dark:text-slate-400">データがありません</div>
                  ) : displayWeeklyData.map((day, index) => (
                    <div key={index} className="flex items-center space-x-4">
                      <div className="w-8 text-sm font-medium text-neutral-600 dark:text-slate-400">{day.day}</div>
                      <div className="flex-1 relative">
                        <div className="h-8 bg-neutral-200 dark:bg-slate-700 rounded-lg overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-primary-600 to-primary-700 dark:from-primary-400 dark:to-primary-500 rounded-lg transition-all duration-500"
                            style={{ width: `${maxTime > 0 ? (day.time / maxTime) * 100 : 0}%` }}
                          />
                        </div>
                        <div className="absolute inset-0 flex items-center px-3">
                          <span className="text-sm font-medium text-white">{day.time}分</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Subject Analysis (グラフのみ) */}
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
                <BookOpen className="w-5 h-5 text-secondary-600 dark:text-secondary-400" />
                <span>累計 教科別学習時間</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SubjectStudyTimeChart />
            </CardContent>
          </Card>
        </div>

        {/* Learning Insights を右側のカラムに移動 */}
        <div className="lg:col-span-1">
          <div className="relative">
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
                <Zap className="w-5 h-5 text-accent-600 dark:text-accent-400" />
                <span>学習インサイト</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-6">
                <div className="p-4 bg-success-50 rounded-lg border border-success-200 dark:bg-success-900/30 dark:border-success-700">
                  <h4 className="font-semibold text-success-800 dark:text-success-300 mb-2">最も効率的な時間帯</h4>
                  <p className="text-success-700 dark:text-success-400 text-sm">
                    午後2時〜4時の学習効率が最も高く、平均92%の集中度を記録しています。
                  </p>
                </div>
                <div className="p-4 bg-primary-50 rounded-lg border border-primary-200 dark:bg-primary-900/30 dark:border-primary-700">
                  <h4 className="font-semibold text-primary-800 dark:text-primary-300 mb-2">得意科目</h4>
                  <p className="text-primary-700 dark:text-primary-400 text-sm">英語の理解度が最も高く、継続的な成績向上が見られます。</p>
                </div>
                <div className="p-4 bg-warning-50 rounded-lg border border-warning-200 dark:bg-warning-900/30 dark:border-warning-700">
                  <h4 className="font-semibold text-warning-800 dark:text-warning-300 mb-2">改善提案</h4>
                  <p className="text-warning-700 dark:text-warning-400 text-sm">
                    化学の学習時間を20%増やすことで、全体的なバランスが向上します。
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
          {/* 学習インサイトは未実装扱い（カード領域内のみミスト＋中央カード）。サンプルを見るで一時的に非表示 */}
          <FeatureOverlay
            enabled={(process.env.NEXT_PUBLIC_SHOW_IDEA_OVERLAYS ?? '1') !== '0' && showInsightsOverlay}
            title="この機能は未実装です"
            message={'学習インサイトは、あなたとAIの協働で少しずつ作るのがコツです。まずは「どんな気づきが欲しいか」を短く共有して、一緒に小さく作っていきましょう。'}
            buttonLabel="Geminiと一緒に実装を始める"
            requestChatPrompt={'この「学習インサイト」を一緒に設計・実装したい。まず欲しい気づきを短く決め、その後、小さなタスクに分解して進めよう。'}
            secondaryLabel="サンプルを見る"
            onSecondary={() => setShowInsightsOverlay(false)}
          />
          </div>
        </div>
      </div>

      {/* 下部にアイディアカード */}
      {((process.env.NEXT_PUBLIC_SHOW_IDEA_OVERLAYS ?? '1') !== '0') && (
        <div className="mt-10">
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="text-neutral-800 dark:text-slate-100">グラフを増やしたい方へ（アイディア）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-neutral-700 dark:text-slate-300">
              <p>
                『こんなグラフが欲しい』を短く伝えて、必要に応じてAIと対話しながら決めていきましょう。次の分解が助けになります。
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>知りたいことを1文で（例：教科×直近8週の推移、曜日×時間帯の集中度）</li>
                <li>必要なデータ項目（期間・科目・合計時間・平均スコア など）</li>
                <li>集計の粒度と並び順（週/日/時間帯、降順など）</li>
                <li>グラフ型（棒/折れ線/ヒートマップ/ドーナツ）と注釈（目標ライン/前週比）</li>
                <li>操作（絞り込み・並べ替え・比較の追加）</li>
              </ul>
              <div>
                <Button
                  onClick={() => window.dispatchEvent(new CustomEvent('chat:open-with-prompt', {
                    detail: { text: 'この「グラフ分析」を一緒に設計・実装したい。まず目的と最小のグラフから短く決め、その後、小さなタスクに分解して進めよう。' }
                  }))}
                  className="bg-blue-600 text-white hover:bg-blue-700"
                  size="sm"
                >
                  Geminiと一緒に実装を始める
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
