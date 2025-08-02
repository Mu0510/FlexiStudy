"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Target, Clock, TrendingUp, BookOpen, Calendar, Award, Zap, CheckCircle2, Circle, Play } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"

export function Dashboard({ dashboardData }) {
  const { studyStats, todayGoals, recentSessions } = dashboardData || {};

  if (!dashboardData) {
    return (
      <div className="space-y-6 pt-16 lg:pt-0">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Skeleton className="h-96 w-full" />
          </div>
          <div className="space-y-6">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Welcome Section */}
      <div className="bg-gradient-to-r from-primary-800 to-primary-700 rounded-2xl p-6 text-neutral-100 dark:from-primary-600 dark:to-primary-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold mb-2">おかえりなさい！</h2>
            <p className="text-neutral-200 dark:text-neutral-300">今日も頑張って学習を続けましょう</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold">{studyStats.streak}</div>
            <div className="text-neutral-200 dark:text-neutral-300 text-sm">日連続</div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 shadow-md bg-neutral-100 dark:bg-neutral-800">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-100 dark:bg-primary-900/50 rounded-lg">
                <Clock className="w-5 h-5 text-primary-700 dark:text-primary-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800 dark:text-neutral-100">{studyStats.todayTime}分</div>
                <div className="text-sm text-primary-700 dark:text-neutral-400">今日の学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-secondary-50 dark:bg-neutral-800">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-secondary-200 dark:bg-secondary-900/50 rounded-lg">
                <TrendingUp className="w-5 h-5 text-secondary-700 dark:text-secondary-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-secondary-800 dark:text-neutral-100">{studyStats.weeklyTime}分</div>
                <div className="text-sm text-secondary-700 dark:text-neutral-400">今週の学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-accent-50 dark:bg-neutral-800">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-accent-200 dark:bg-accent-900/50 rounded-lg">
                <Target className="w-5 h-5 text-accent-700 dark:text-accent-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-accent-800 dark:text-neutral-100">
                  {studyStats.completedGoals}/{studyStats.totalGoals}
                </div>
                <div className="text-sm text-accent-700 dark:text-neutral-400">今日の目標達成</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-primary-50 dark:bg-neutral-800">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-200 dark:bg-primary-900/50 rounded-lg">
                <Award className="w-5 h-5 text-primary-700 dark:text-primary-400" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800 dark:text-neutral-100">{studyStats.streak}</div>
                <div className="text-sm text-primary-700 dark:text-neutral-400">連続学習日数</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Today's Goals */}
        <div className="lg:col-span-2">
          <Card className="border-0 shadow-lg bg-white dark:bg-neutral-800">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-neutral-200">
                  <Target className="w-5 h-5 text-primary-600 dark:text-primary-400" />
                  <span>今日の目標</span>
                </CardTitle>
                <Badge variant="secondary" className="bg-primary-100 text-primary-700 dark:bg-primary-900/50 dark:text-primary-400">
                  {studyStats.completedGoals}/{studyStats.totalGoals} 完了
                </Badge>
              </div>
              <Progress value={studyStats.totalGoals > 0 ? (studyStats.completedGoals / studyStats.totalGoals) * 100 : 0} className="h-2 mt-2" />
            </CardHeader>
            <CardContent className="space-y-3">
              {todayGoals && todayGoals.length > 0 ? (
                todayGoals.map((goal, index) => (
                  <div
                    key={goal.id || index}
                    className="flex items-center space-x-3 p-3 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700/50 transition-colors"
                  >
                    {goal.completed ? (
                      <CheckCircle2 className="w-5 h-5 text-success-700 dark:text-success-500" />
                    ) : (
                      <Circle className="w-5 h-5 text-neutral-400 dark:text-neutral-500" />
                    )}
                    <div className="flex-1">
                      <div className="flex items-center space-x-2 mb-1">
                        <Badge
                          variant="outline"
                          className={
                            goal.subject === "物理"
                              ? "border-primary-200 text-primary-700 dark:border-primary-900/50 dark:text-primary-400"
                              : "border-secondary-200 text-secondary-700 dark:border-secondary-900/50 dark:text-secondary-400"
                          }
                        >
                          {goal.subject}
                        </Badge>
                        {goal.tags && goal.tags.map((tag, tagIndex) => (
                          <Badge key={tagIndex} variant="outline" className="border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                            {tag}
                          </Badge>
                        ))}
                        {goal.total_problems != null && goal.completed_problems != null && (
                          <span className="text-sm text-neutral-500 dark:text-neutral-400">
                            {goal.completed_problems}/{goal.total_problems}問
                          </span>
                        )}
                      </div>
                      <div
                        className={`font-medium ${goal.completed ? "text-neutral-500 line-through dark:text-neutral-400" : "text-neutral-800 dark:text-neutral-200"}`}
                      >
                        {goal.task}
                      </div>
                      {goal.details && (
                        <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">{goal.details}</p>
                      )}
                      {goal.total_problems != null && goal.completed_problems != null && goal.total_problems > 0 && (
                        <Progress
                          value={(goal.completed_problems / goal.total_problems) * 100}
                          className="h-1.5 mt-2"
                        />
                      )}
                    </div>
                    {!goal.completed && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-primary-600 border-primary-200 hover:bg-primary-50 bg-transparent dark:text-primary-400 dark:border-primary-900/50 dark:hover:bg-primary-900/50 dark:bg-transparent"
                      >
                        <Play className="w-4 h-4 mr-1" />
                        開始
                      </Button>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-center text-neutral-500 dark:text-neutral-400 py-4">今日の目標はまだ設定されていません。</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity & Quick Actions */}
        <div className="space-y-6">
          <Card className="border-0 shadow-lg bg-white dark:bg-neutral-800">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-neutral-200">
                <BookOpen className="w-5 h-5 text-secondary-600 dark:text-secondary-400" />
                <span>最近の学習</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {recentSessions.map((session, index) => (
                <div key={index} className="p-3 bg-neutral-100 dark:bg-neutral-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="border-primary-200 text-primary-700 dark:border-primary-900/50 dark:text-primary-400">
                      {session.subject}
                    </Badge>
                    <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{session.duration}分</span>
                  </div>
                  <div className="text-sm text-neutral-600 dark:text-neutral-400 mb-1">{session.time}</div>
                  <div className="text-sm text-neutral-800 dark:text-neutral-200 font-medium">{session.topic}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg bg-white dark:bg-neutral-800">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-neutral-200">
                <Zap className="w-5 h-5 text-accent-600 dark:text-accent-400" />
                <span>クイックアクション</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full justify-start bg-gradient-to-r from-primary-800 to-primary-700 hover:from-primary-900 hover:to-primary-800 dark:from-primary-600 dark:to-primary-700 dark:hover:from-primary-700 dark:hover:to-primary-800">
                <Play className="w-4 h-4 mr-2" />
                集中モード開始
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-secondary-200 text-secondary-700 hover:bg-secondary-50 bg-transparent dark:border-secondary-900/50 dark:text-secondary-400 dark:hover:bg-secondary-900/50 dark:bg-transparent"
              >
                <Calendar className="w-4 h-4 mr-2" />
                今日の復習確認
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-accent-200 text-accent-700 hover:bg-accent-50 bg-transparent dark:border-accent-900/50 dark:text-accent-400 dark:hover:bg-accent-900/50 dark:bg-transparent"
              >
                <TrendingUp className="w-4 h-4 mr-2" />
                学習分析を見る
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
