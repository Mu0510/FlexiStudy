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
      <div className="bg-gradient-to-r from-primary to-primary/90 rounded-2xl p-6 text-primary-foreground">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold mb-2">おかえりなさい！</h2>
            <p className="text-primary-foreground/80">今日も頑張って学習を続けましょう</p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold">{studyStats.streak}</div>
            <div className="text-primary-foreground/80 text-sm">日連続</div>
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Clock className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold text-foreground">{studyStats.todayTime}分</div>
                <div className="text-sm text-muted-foreground">今日の学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-secondary/20 dark:bg-secondary/30 rounded-lg">
                <TrendingUp className="w-5 h-5 text-secondary-foreground/80" />
              </div>
              <div>
                <div className="text-2xl font-bold text-foreground">{studyStats.weeklyTime}分</div>
                <div className="text-sm text-muted-foreground">今週の学習時間</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-accent/10 rounded-lg">
                <Target className="w-5 h-5 text-accent" />
              </div>
              <div>
                <div className="text-2xl font-bold text-foreground">
                  {studyStats.completedGoals}/{studyStats.totalGoals}
                </div>
                <div className="text-sm text-muted-foreground">今日の目標達成</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Award className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="text-2xl font-bold text-foreground">{studyStats.streak}</div>
                <div className="text-sm text-muted-foreground">連続学習日数</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Today's Goals */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center space-x-2 text-foreground">
                  <Target className="w-5 h-5 text-primary" />
                  <span>今日の目標</span>
                </CardTitle>
                <Badge variant="secondary">
                  {studyStats.completedGoals}/{studyStats.totalGoals} 完了
                </Badge>
              </div>
              <Progress value={(studyStats.completedGoals / studyStats.totalGoals) * 100} className="h-2 mt-2" />
            </CardHeader>
            <CardContent className="space-y-3">
              {todayGoals.map((goal) => (
                <div
                  key={goal.id}
                  className="flex items-center space-x-3 p-3 rounded-lg hover:bg-muted/50 transition-colors"
                >
                  {goal.completed ? (
                    <CheckCircle2 className="w-5 h-5 text-success-600 dark:text-success-500" />
                  ) : (
                    <Circle className="w-5 h-5 text-muted-foreground" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-1">
                      <Badge
                        variant="outline"
                        className={
                          goal.subject === "物理"
                            ? "border-primary/50 text-primary"
                            : "border-secondary/50 text-secondary-foreground/80"
                        }
                      >
                        {goal.subject}
                      </Badge>
                      <span className="text-sm text-muted-foreground">{goal.problems}問</span>
                    </div>
                    <div
                      className={`font-medium ${goal.completed ? "text-muted-foreground line-through" : "text-foreground"}`}
                    >
                      {goal.task}
                    </div>
                  </div>
                  {!goal.completed && (
                    <Button
                      size="sm"
                      variant="outline"
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

        {/* Recent Activity & Quick Actions */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2 text-foreground">
                <BookOpen className="w-5 h-5 text-secondary-foreground/80" />
                <span>最近の学習</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {recentSessions.map((session, index) => (
                <div key={index} className="p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="border-primary/50 text-primary">
                      {session.subject}
                    </Badge>
                    <span className="text-sm font-medium text-muted-foreground">{session.duration}分</span>
                  </div>
                  <div className="text-sm text-muted-foreground mb-1">{session.time}</div>
                  <div className="text-sm text-foreground font-medium">{session.topic}</div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center space-x-2 text-foreground">
                <Zap className="w-5 h-5 text-accent" />
                <span>クイックアクション</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full justify-start">
                <Play className="w-4 h-4 mr-2" />
                集中モード開始
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
              >
                <Calendar className="w-4 h-4 mr-2" />
                今日の復習確認
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start"
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
