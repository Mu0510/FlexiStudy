"use client"

import { useEffect } from 'react';
import { Dashboard } from './dashboard';
import { useWebSocket } from '@/context/WebSocketContext';

export function DashboardContainer({ dashboardData, subjectColors, onRefresh, onSelectGoal }) {
  const { subscribe } = useWebSocket();

  useEffect(() => {
    const unsubscribe = subscribe((message: any) => {
      if (message.method === 'databaseUpdated') {
        console.log('Database update notification received in DashboardContainer, refetching data...');
        onRefresh();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [subscribe, onRefresh]);

  return <Dashboard dashboardData={dashboardData} subjectColors={subjectColors} onSelectGoal={onSelectGoal} />;
}
