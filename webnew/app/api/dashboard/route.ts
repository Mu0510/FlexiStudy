import { NextResponse } from "next/server";

export async function GET() {
  // 今後、ここでデータベースからデータを取得します
  const dashboardData = {
    studyStats: {
      todayTime: 86,
      weeklyTime: 420,
      streak: 12,
      completedGoals: 2,
      totalGoals: 5,
    },
    todayGoals: [
      { id: 1, subject: "物理", task: "落下運動 基本問題 38~42", completed: true, problems: 5 },
      { id: 2, subject: "物理", task: "落下運動 発展問題 43~53", completed: true, problems: 11 },
      { id: 3, subject: "物理", task: "力のつりあい 基本問題 61~69", completed: false, problems: 9 },
      { id: 4, subject: "数学", task: "関数の極限 78~98", completed: false, problems: 21 },
      { id: 5, subject: "数学", task: "三角関数と極限 99~103", completed: false, problems: 5 },
    ],
    recentSessions: [
      { subject: "物理", duration: 63, time: "14:44-15:47", topic: "セミナー物理 落下運動 発展問題 43~51" },
      { subject: "物理", duration: 23, time: "15:59-16:22", topic: "セミナー物理 落下運動 発展問題 43~51" },
    ],
  };

  return NextResponse.json(dashboardData);
}
