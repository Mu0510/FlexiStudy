"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
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
  
  const chartConfig = {
    minutes: {
      label: "Minutes",
      color: "#2563eb",
    },
    subject: {
      label: "Subject",
    },
  }

  return (
    <ChartContainer config={chartConfig} className="min-h-[200px] w-full">
      <BarChart accessibilityLayer data={chartData}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="subject"
          tickLine={false}
          tickMargin={10}
          axisLine={false}
        />
        <YAxis />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="minutes" fill="var(--color-minutes)" radius={4} />
      </BarChart>
    </ChartContainer>
  )
}
