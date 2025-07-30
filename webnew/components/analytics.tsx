"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BarChart3, TrendingUp, Clock, Target, Calendar, Award, BookOpen, Zap, AlertTriangle } from "lucide-react"

export function Analytics() {
  const weeklyData = [
    { day: "月", time: 112, efficiency: 85, status: "good" },
    { day: "火", time: 95, efficiency: 78, status: "warning" },
    { day: "水", time: 140, efficiency: 92, status: "excellent" },
    { day: "木", time: 88, efficiency: 76, status: "warning" },
    { day: "金", time: 156, efficiency: 89, status: "good" },
    { day: "土", time: 203, efficiency: 94, status: "excellent" },
    { day: "日", time: 167, efficiency: 87, status: "good" },
  ]

  const subjectData = [
    { subject: "数学", time: 420, sessions: 12, avgScore: 78, trend: "up" },
    { subject: "物理", time: 380, sessions: 15, avgScore: 82, trend: "up" },
    { subject: "化学", time: 290, sessions: 8, avgScore: 75, trend: "down" },
    { subject: "英語", time: 250, sessions: 10, avgScore: 88, trend: "stable" },
  ]

  const maxTime = Math.max(...weeklyData.map((d) => d.time))

  const getEfficiencyBadge = (efficiency: number) => {
    if (efficiency >= 90) return "border-success-200 text-success-700 bg-success-50"
    if (efficiency >= 80) return "border-primary-200 text-primary-700 bg-primary-50"
    if (efficiency >= 70) return "border-warning-200 text-warning-700 bg-warning-50"
    return "border-alert-200 text-alert-700 bg-alert-50"
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-neutral-800">グラフ分析</h1>
          <p className="text-neutral-600 mt-1">学習データを可視化して効率的な学習をサポート</p>
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

      {/* Summary Cards - メインカラーパレットのみ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 shadow-md bg-gradient-to-br from-primary-50 to-primary-100">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-200 rounded-lg">
                <Clock className="w-5 h-5 text-primary-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800">18.5h</div>
                <div className="text-sm text-primary-700">今週の総学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-secondary-50 to-secondary-100">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-secondary-200 rounded-lg">
                <TrendingUp className="w-5 h-5 text-secondary-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-secondary-800">87%</div>
                <div className="text-sm text-secondary-700">平均学習効率</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-accent-50 to-accent-100">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-accent-200 rounded-lg">
                <Target className="w-5 h-5 text-accent-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-accent-800">92%</div>
                <div className="text-sm text-accent-700">目標達成率</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-neutral-100 to-neutral-200">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-neutral-300 rounded-lg">
                <Award className="w-5 h-5 text-neutral-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-neutral-800">81</div>
                <div className="text-sm text-neutral-700">平均得点</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Weekly Study Time Chart */}
        <div className="lg:col-span-2">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <BarChart3 className="w-5 h-5 text-primary-600" />
                <span>週間学習時間</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {weeklyData.map((day, index) => (
                  <div key={index} className="flex items-center space-x-4">
                    <div className="w-8 text-sm font-medium text-neutral-600">{day.day}</div>
                    <div className="flex-1 relative">
                      <div className="h-8 bg-neutral-200 rounded-lg overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-primary-600 to-primary-700 rounded-lg transition-all duration-500"
                          style={{ width: `${(day.time / maxTime) * 100}%` }}
                        />
                      </div>
                      <div className="absolute inset-0 flex items-center px-3">
                        <span className="text-sm font-medium text-white">{day.time}分</span>
                      </div>
                    </div>
                    <div className="w-16 text-right">
                      <Badge variant="outline" className={getEfficiencyBadge(day.efficiency)}>
                        {day.efficiency}%
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Subject Analysis */}
        <div>
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <BookOpen className="w-5 h-5 text-secondary-600" />
                <span>科目別分析</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {subjectData.map((subject, index) => (
                <div key={index} className="p-4 bg-neutral-100 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-2">
                      <div className="w-3 h-3 rounded-full bg-primary-500" />
                      <span className="font-medium text-neutral-800">{subject.subject}</span>
                      {subject.trend === "down" && <AlertTriangle className="w-4 h-4 text-alert-600" />}
                    </div>
                    <Badge variant="outline" className="border-neutral-300 text-neutral-600">
                      {Math.floor(subject.time / 60)}h {subject.time % 60}m
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <div className="text-neutral-500">セッション数</div>
                      <div className="font-medium text-neutral-800">{subject.sessions}回</div>
                    </div>
                    <div>
                      <div className="text-neutral-500">平均得点</div>
                      <div className="font-medium text-neutral-800">{subject.avgScore}点</div>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Learning Insights - 機能色を適切に使用 */}
      <Card className="border-0 shadow-lg bg-white">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Zap className="w-5 h-5 text-accent-600" />
            <span>学習インサイト</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid lg:grid-cols-3 gap-6">
            <div className="p-4 bg-success-50 rounded-lg border border-success-200">
              <h4 className="font-semibold text-success-800 mb-2">最も効率的な時間帯</h4>
              <p className="text-success-700 text-sm">
                午後2時〜4時の学習効率が最も高く、平均92%の集中度を記録しています。
              </p>
            </div>
            <div className="p-4 bg-primary-50 rounded-lg border border-primary-200">
              <h4 className="font-semibold text-primary-800 mb-2">得意科目</h4>
              <p className="text-primary-700 text-sm">英語の理解度が最も高く、継続的な成績向上が見られます。</p>
            </div>
            <div className="p-4 bg-warning-50 rounded-lg border border-warning-200">
              <h4 className="font-semibold text-warning-800 mb-2">改善提案</h4>
              <p className="text-warning-700 text-sm">
                化学の学習時間を20%増やすことで、全体的なバランスが向上します。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
