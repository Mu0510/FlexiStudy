"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BarChart3, TrendingUp, Clock, Target, Calendar, Award, BookOpen, Zap, AlertTriangle, Flame } from "lucide-react"
import { SubjectStudyTimeChart } from "@/components/subject-study-time-chart"
import { useEffect, useState } from "react"

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

  useEffect(() => {
    Promise.all([
      fetch("/api/analytics/weekly-study-time").then((res) => res.json()),
      fetch("/api/dashboard").then((res) => res.json()),
    ])
      .then(([weekly, dashboard]) => {
        setWeeklyData(weekly)
        setDashboardData(dashboard)
        setIsLoading(false)
      })
      .catch((error) => {
        console.error("Failed to fetch analytics data:", error)
        setIsLoading(false)
      })
  }, [])

  const subjectData = [
    { subject: "数学", time: 420, sessions: 12, avgScore: 78, trend: "up" },
    { subject: "物理", time: 380, sessions: 15, avgScore: 82, trend: "up" },
    { subject: "化学", time: 290, sessions: 8, avgScore: 75, trend: "down" },
    { subject: "英語", time: 250, sessions: 10, avgScore: 88, trend: "stable" },
  ]

  const maxTime = weeklyData.length > 0 ? Math.max(...weeklyData.map((d) => d.time)) : 0

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m > 0 ? `${m}m` : ''}`.trim();
  };

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
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
                <div className="text-sm text-primary-700 dark:text-slate-400">今週の総学習時間</div>
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
                <div className="text-sm text-neutral-700 dark:text-slate-400">今月の総学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Weekly Study Time Chart */}
        <div className="lg:col-span-2">
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
                <BarChart3 className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                <span>週間学習時間</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div>Loading...</div>
              ) : (
                <div className="space-y-4">
                  {weeklyData.map((day, index) => (
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
        </div>

        {/* Subject Analysis */}
        <div>
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
                <BookOpen className="w-5 h-5 text-secondary-600 dark:text-secondary-400" />
                <span>科目別分析</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SubjectStudyTimeChart />
              {subjectData.map((subject, index) => (
                <div key={index} className="p-4 bg-neutral-100 dark:bg-slate-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 rounded-full bg-primary-500 dark:bg-primary-400" />
                      <span className="font-medium text-neutral-800 dark:text-slate-100">{subject.subject}</span>
                      {subject.trend === "down" && <AlertTriangle className="w-4 h-4 text-alert-600 dark:text-alert-400" />}
                    </div>
                    <Badge variant="outline" className="border-neutral-300 text-neutral-600 dark:border-slate-600 dark:text-slate-400">
                      {Math.floor(subject.time / 60)}h {subject.time % 60}m
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-neutral-500 dark:text-slate-400">セッション数</div>
                      <div className="font-medium text-neutral-800 dark:text-slate-100">{subject.sessions}回</div>
                    </div>
                    <div>
                      <div className="text-neutral-500 dark:text-slate-400">平均得点</div>
                      <div className="font-medium text-neutral-800 dark:text-slate-100">{subject.avgScore}点</div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Learning Insights - 機能色を適切に使用 */}
      <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-slate-100">
            <Zap className="w-5 h-5 text-accent-600 dark:text-accent-400" />
            <span>学習インサイト</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid lg:grid-cols-3 gap-6">
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
    </div>
  )
}
