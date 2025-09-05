"use client"

import { Dashboard } from './dashboard';

export function DashboardContainer({ dashboardData, subjectColors, onRefresh, onSelectGoal }) {
  // Live updates are handled centrally in page.tsx to avoid duplicate fetches
  return <Dashboard dashboardData={dashboardData} subjectColors={subjectColors} onSelectGoal={onSelectGoal} />;
}
