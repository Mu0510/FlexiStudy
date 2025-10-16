"use client"

import { Flag, CheckCircle2, Circle, Play, ArrowRightToLine, Target } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { getSubjectStyle, normalizeTags } from "@/lib/utils"

// 型定義
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

interface DailyGoalsStats {
  completedGoals: number;
  totalGoals: number;
}

interface DailyGoalsCardProps {
  goals: Goal[];
  stats: DailyGoalsStats;
  title?: string;
  className?: string;
  isToday?: boolean;
  onMoveGoal?: (goal: Goal) => void;
  onSelectGoal?: (goal: Goal) => void; // onStartGoal を onSelectGoal に変更
  subjectColors?: Record<string, string>;
  highlightGoalIds?: Set<string | number>;
}

export function DailyGoalsCard({ goals, stats, title = "今日の目標", className, isToday = true, onMoveGoal, onSelectGoal, subjectColors = {}, highlightGoalIds }: DailyGoalsCardProps) {
  if (!goals || goals.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-neutral-200">
            <Flag className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            <span>{title}</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-center text-neutral-500 dark:text-neutral-400 py-4">
            目標はまだ設定されていません。
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center space-x-2 text-neutral-800 dark:text-neutral-200">
            <Flag className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            <span>{title}</span>
          </CardTitle>
          <Badge variant="secondary" className="bg-primary-100 text-primary-700 dark:bg-primary-900/50 dark:text-primary-400">
            {stats.completedGoals}/{stats.totalGoals} 完了
          </Badge>
        </div>
        <Progress value={stats.totalGoals > 0 ? (stats.completedGoals / stats.totalGoals) * 100 : 0} className="h-2 mt-2" />
      </CardHeader>
      <CardContent className="space-y-3">
        {goals.map((goal, index) => (
          <div
            key={goal.id || index}
            id={`goal-${goal.id}`}
            className={`flex items-center space-x-3 p-3 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700/50 transition-colors transition-shadow duration-700 ${highlightGoalIds && highlightGoalIds.has(goal.id) ? 'bg-yellow-50 dark:bg-yellow-900/30 ring-2 ring-yellow-400' : ''}`}
          >
            {goal.completed ? (
              <CheckCircle2 className="w-5 h-5 text-success-700 dark:text-success-500" />
            ) : (
              <Circle className="w-5 h-5 text-neutral-400 dark:text-neutral-500" />
            )}
            <div className="flex-1 flex flex-col">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-2 mb-1 flex-wrap">
                    <Badge
                      variant="outline"
                      style={getSubjectStyle(goal.subject, subjectColors)}
                    >
                      {goal.subject}
                    </Badge>
                    {normalizeTags(goal.tags).map((tag, tagIndex) => (
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
                </div>
                <div className="flex space-x-2">
                  {!goal.completed && !isToday && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-sky-600 border-sky-200 hover:bg-sky-50 bg-transparent dark:text-sky-400 dark:border-sky-900/50 dark:hover:bg-sky-900/50 dark:bg-transparent"
                      onClick={() => onMoveGoal?.(goal)}
                    >
                      <ArrowRightToLine className="w-4 h-4 mr-1" />
                      今日に移動
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-primary-600 border-primary-200 hover:bg-primary-50 bg-transparent dark:text-primary-400 dark:border-primary-900/50 dark:hover:bg-primary-900/50 dark:bg-transparent"
                    onClick={() => onSelectGoal?.(goal)}
                  >
                    選択
                  </Button>
                </div>
              </div>
              {goal.total_problems != null && goal.completed_problems != null && goal.total_problems > 0 && (
                <Progress
                  value={(goal.completed_problems / goal.total_problems) * 100}
                  className="h-1.5 mt-2"
                />
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
