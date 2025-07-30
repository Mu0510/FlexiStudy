"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Target, Clock, TrendingUp, BookOpen, Calendar, Award, Zap, CheckCircle2, Circle, Play } from "lucide-react"

export function Dashboard() {
  const todayGoals = [
    { id: 1, subject: "物理", task: "落下運動 基本問題 38~42", completed: true, problems: 5 },
    { id: 2, subject: "物理", task: "落下運動 発展問題 43~53", completed: true, problems: 11 },
    { id: 3, subject: "物理", task: "力のつりあい 基本問題 61~69", completed: false, problems: 9 },
    { id: 4, subject: "数学", task: "関数の極限 78~98", completed: false, problems: 21 },
    { id: 5, subject: "数学", task: "三角関数と極限 99~103", completed: false, problems: 5 },
  ]

  const studyStats = {
    todayTime: 86,
    weeklyTime: 420,
    streak: 12,
    completedGoals: 2,
    totalGoals: 5,
  }

  const recentSessions = [
    { subject: "物理", duration: 63, time: "14:44-15:47", topic: "セミナー物理 落下運動 発展問題 43~51" },
    { subject: "物理", duration: 23, time: "15:59-16:22", topic: "セミナー物理 落下運動 発展問題 43~51" },
  ]

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Welcome Section */}
      <div className="bg-gradient-to-r from-primary-800 to-primary-700 rounded-2xl p-6 text-neutral-100">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold mb-2">おかえりなさい！</h2>
            <p className="text-neutral-200">今日も頑張って学習を続けましょう</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold">{studyStats.streak}</div>
            <div className="text-neutral-200 text-sm">日連続</div>
          </div>
        </div>
      </div>

      {/* Quick Stats - メインカラーパレットのみ使用 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-0 shadow-md bg-gradient-to-br from-neutral-100 to-neutral-200">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-100 rounded-lg">
                <Clock className="w-5 h-5 text-primary-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800">{studyStats.todayTime}分</div>
                <div className="text-sm text-primary-700">今日の学習時間</div>
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
                <div className="text-2xl font-bold text-secondary-800">{studyStats.weeklyTime}分</div>
                <div className="text-sm text-secondary-700">今週の学習時間</div>
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
                <div className="text-2xl font-bold text-accent-800">
                  {studyStats.completedGoals}/{studyStats.totalGoals}
                </div>
                <div className="text-sm text-accent-700">今日の目標達成</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 shadow-md bg-gradient-to-br from-primary-50 to-primary-100">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary-200 rounded-lg">
                <Award className="w-5 h-5 text-primary-700" />
              </div>
              <div>
                <div className="text-2xl font-bold text-primary-800">{studyStats.streak}</div>
                <div className="text-sm text-primary-700">連続学習日数</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Today's Goals */}
        <div className="lg:col-span-2">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2">
                  <Target className="w-5 h-5 text-primary-600" />
                  <span>今日の目標</span>
                </CardTitle>
                <Badge variant="secondary" className="bg-primary-100 text-primary-700">
                  {studyStats.completedGoals}/{studyStats.totalGoals} 完了
                </Badge>
              </div>
              <Progress value={(studyStats.completedGoals / studyStats.totalGoals) * 100} className="h-2" />
            </CardHeader>
            <CardContent className="space-y-3">
              {todayGoals.map((goal) => (
                <div
                  key={goal.id}
                  className="flex items-center space-x-3 p-3 rounded-lg hover:bg-neutral-100 transition-colors"
                >
                  {goal.completed ? (
                    <CheckCircle2 className="w-5 h-5 text-success-700" />
                  ) : (
                    <Circle className="w-5 h-5 text-neutral-400" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-1">
                      <Badge
                        variant="outline"
                        className={
                          goal.subject === "物理"
                            ? "border-primary-200 text-primary-700"
                            : "border-secondary-200 text-secondary-700"
                        }
                      >
                        {goal.subject}
                      </Badge>
                      <span className="text-sm text-neutral-500">{goal.problems}問</span>
                    </div>
                    <div
                      className={`font-medium ${goal.completed ? "text-neutral-500 line-through" : "text-neutral-800"}`}
                    >
                      {goal.task}
                    </div>
                  </div>
                  {!goal.completed && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-primary-600 border-primary-200 hover:bg-primary-50 bg-transparent"
                    >
                      <Play className="w-4 h-4 mr-1" />
                      開始
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity */}
        <div className="space-y-6">
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2">
                <BookOpen className="w-5 h-5 text-secondary-600" />
                <span>最近の学習</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {recentSessions.map((session, index) => (
                <div key={index} className="p-3 bg-neutral-100 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="border-primary-200 text-primary-700">
                      {session.subject}
                    </Badge>
                    <span className="text-sm font-medium text-neutral-600">{session.duration}分</span>
                  </div>
                  <div className="text-sm text-neutral-600 mb-1">{session.time}</div>
                  <div className="text-sm text-neutral-800 font-medium">{session.topic}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="border-0 shadow-lg bg-white">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2">
                <Zap className="w-5 h-5 text-accent-600" />
                <span>クイックアクション</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full justify-start bg-gradient-to-r from-primary-800 to-primary-700 hover:from-primary-900 hover:to-primary-800">
                <Play className="w-4 h-4 mr-2" />
                集中モード開始
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-secondary-200 text-secondary-700 hover:bg-secondary-50 bg-transparent"
              >
                <Calendar className="w-4 h-4 mr-2" />
                今日の復習確認
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-accent-200 text-accent-700 hover:bg-accent-50 bg-transparent"
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
