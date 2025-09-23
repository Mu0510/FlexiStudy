"use client"

import { useEffect, useState } from "react"

interface SubjectStudyTime {
  subject: string
  minutes: number
}

export function SubjectStudyTimeChart() {
  const [chartData, setChartData] = useState<SubjectStudyTime[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetch("/api/analytics/study-time-by-subject")
      .then((res) => res.json())
      .then((data) => {
        setChartData(data)
        setIsLoading(false)
      })
      .catch((error) => {
        console.error("Failed to fetch chart data:", error)
        setIsLoading(false)
      })
  }, [])

  if (isLoading) {
    return <div>Loading...</div>
  }

  if (!chartData || chartData.length === 0) {
    return <div>No data available</div>
  }
  
  const maxMinutes = Math.max(...chartData.map((d) => d.minutes))

  return (
    <div className="space-y-4">
      {chartData.map((subject, index) => (
        <div key={index} className="flex items-center space-x-4">
          <div className="w-16 text-sm font-medium text-neutral-600 dark:text-slate-400">{subject.subject}</div>
          <div className="flex-1 relative">
            <div className="h-8 bg-neutral-200 dark:bg-slate-700 rounded-lg overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary-600 to-primary-700 dark:from-primary-400 dark:to-primary-500 rounded-lg transition-all duration-500"
                style={{ width: `${(subject.minutes / maxMinutes) * 100}%` }}
              />
            </div>
            <div className="absolute inset-0 flex items-center px-3">
              <span className="text-sm font-medium text-white">{subject.minutes}分</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
