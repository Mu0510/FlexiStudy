"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { FileText, TrendingUp, BarChart3, AlertCircle, Plus } from "lucide-react"

export function ExamAnalysis() {
  const examResults = [
    {
      id: 1,
      name: "第1回全国模試",
      date: "2025-07-15",
      totalScore: 456,
      maxScore: 600,
      rank: 1250,
      totalParticipants: 15000,
      subjects: [
        { name: "数学", score: 78, max: 100, average: 65, rank: 890 },
        { name: "物理", score: 82, max: 100, average: 58, rank: 650 },
        { name: "化学", score: 71, max: 100, average: 62, rank: 1200 },
        { name: "英語", score: 89, max: 100, average: 72, rank: 420 },
        { name: "国語", score: 136, max: 200, average: 118, rank: 980 },
      ],
    },
    {
      id: 2,
      name: "第2回全国模試",
      date: "2025-06-20",
      totalScore: 432,
      maxScore: 600,
      rank: 1580,
      totalParticipants: 14500,
      subjects: [
        { name: "数学", score: 72, max: 100, average: 63, rank: 1100 },
        { name: "物理", score: 79, max: 100, average: 56, rank: 780 },
        { name: "化学", score: 68, max: 100, average: 61, rank: 1350 },
        { name: "英語", score: 85, max: 100, average: 70, rank: 520 },
        { name: "国語", score: 128, max: 200, average: 115, rank: 1200 },
      ],
    },
  ]

  const weakAreas = [
    { subject: "化学", topic: "有機化合物の反応", accuracy: 45, priority: "high" },
    { subject: "数学", topic: "微分積分の応用", accuracy: 58, priority: "medium" },
    { subject: "物理", topic: "電磁気学", accuracy: 62, priority: "medium" },
    { subject: "国語", topic: "古文読解", accuracy: 55, priority: "high" },
  ]

  const getScoreColor = (score: number, max: number) => {
    const percentage = (score / max) * 100
    if (percentage >= 80) return "text-green-600"
    if (percentage >= 70) return "text-blue-600"
    if (percentage >= 60) return "text-orange-600"
    return "text-red-600"
  }

  const getProgressColor = (score: number, max: number) => {
    const percentage = (score / max) * 100
    if (percentage >= 80) return "bg-green-500"
    if (percentage >= 70) return "bg-blue-500"
    if (percentage >= 60) return "bg-orange-500"
    return "bg-red-500"
  }

  return (
    <div className="space-y-6 pt-16 lg:pt-0">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between space-y-4 lg:space-y-0">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">模試分析</h1>
          <p className="text-slate-600 mt-1">模試結果を詳細に分析して弱点を克服しましょう</p>
        </div>

        <div className="flex items-center space-x-3">
          <Button className="bg-gradient-to-r from-blue-600 to-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            新しい結果を追加
          </Button>
          <Button variant="outline" size="sm">
            <BarChart3 className="w-4 h-4 mr-2" />
            レポート出力
          </Button>
        </div>
      </div>

      {/* Latest Exam Overview */}
      <Card className="border-0 shadow-lg bg-gradient-to-r from-blue-50 to-cyan-50 dark:bg-slate-800">
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-800">{examResults[0].name}</h2>
              <p className="text-slate-600">{examResults[0].date}</p>
            </div>
            <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-lg px-4 py-2">
              総合得点: {examResults[0].totalScore}/{examResults[0].maxScore}
            </Badge>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-700">{examResults[0].rank}</div>
              <div className="text-sm text-slate-600">全国順位</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-green-700">
                {Math.round((examResults[0].totalScore / examResults[0].maxScore) * 100)}%
              </div>
              <div className="text-sm text-slate-600">得点率</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-purple-700">
                {examResults[0].totalParticipants.toLocaleString()}
              </div>
              <div className="text-sm text-slate-600">受験者数</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-orange-700">
                {examResults[0].rank - examResults[1].rank > 0 ? "+" : ""}
                {examResults[0].rank - examResults[1].rank}
              </div>
              <div className="text-sm text-slate-600">前回比</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Subject Breakdown */}
        <div className="lg:col-span-2">
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <BarChart3 className="w-5 h-5 text-blue-600" />
                <span>科目別詳細分析</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {examResults[0].subjects.map((subject, index) => (
                <div key={index} className="p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center space-x-3">
                      <h4 className="font-semibold text-slate-800">{subject.name}</h4>
                      <Badge variant="outline" className="border-slate-200 text-slate-600">
                        順位: {subject.rank}位
                      </Badge>
                    </div>
                    <div className={`text-2xl font-bold ${getScoreColor(subject.score, subject.max)}`}>
                      {subject.score}/{subject.max}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-sm text-slate-600">
                      <span>得点率: {Math.round((subject.score / subject.max) * 100)}%</span>
                      <span>平均: {subject.average}点</span>
                    </div>
                    <Progress value={(subject.score / subject.max) * 100} className="h-2" />
                    <div className="flex justify-between text-xs text-slate-500">
                      <span>
                        平均との差: {subject.score > subject.average ? "+" : ""}
                        {subject.score - subject.average}点
                      </span>
                      <span>偏差値: {Math.round(50 + ((subject.score - subject.average) / 10) * 10)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        {/* Weak Areas */}
        <div>
          <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <AlertCircle className="w-5 h-5 text-orange-600" />
                <span>重点改善分野</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {weakAreas.map((area, index) => (
                <div key={index} className="p-3 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <Badge
                      variant="outline"
                      className={
                        area.priority === "high"
                          ? "border-red-200 text-red-700 bg-red-50"
                          : "border-orange-200 text-orange-700 bg-orange-50"
                      }
                    >
                      {area.subject}
                    </Badge>
                    <span className="text-sm font-medium text-slate-600">{area.accuracy}%</span>
                  </div>
                  <div className="text-sm text-slate-800 font-medium mb-2">{area.topic}</div>
                  <Progress value={area.accuracy} className="h-1" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full mt-2 text-xs border-blue-200 text-blue-700 hover:bg-blue-50 bg-transparent"
                  >
                    対策問題を開始
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Exam History */}
      <Card className="border-0 shadow-lg bg-white dark:bg-slate-800">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <TrendingUp className="w-5 h-5 text-green-600" />
            <span>成績推移</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {examResults.map((exam, index) => (
              <div key={exam.id} className="flex items-center space-x-4 p-4 bg-slate-50 rounded-lg">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                    <FileText className="w-6 h-6 text-blue-600" />
                  </div>
                </div>

                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="font-semibold text-slate-800">{exam.name}</h4>
                    <Badge variant="outline" className="border-slate-200 text-slate-600">
                      {exam.date}
                    </Badge>
                  </div>
                  <div className="flex items-center space-x-6 text-sm text-slate-600">
                    <span>
                      総合: {exam.totalScore}/{exam.maxScore}
                    </span>
                    <span>順位: {exam.rank}位</span>
                    <span>得点率: {Math.round((exam.totalScore / exam.maxScore) * 100)}%</span>
                  </div>
                </div>

                <div className="flex-shrink-0">
                  {index === 0 && <Badge className="bg-green-100 text-green-800 border-green-200">最新</Badge>}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
