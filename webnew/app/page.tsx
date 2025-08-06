"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Sidebar } from "@/components/sidebar"
import { Dashboard } from "@/components/dashboard"
import { DashboardContainer } from "@/components/dashboard-container"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import Image from "next/image"
import { useChat } from '@/hooks/useChat';

const StudyRecords = dynamic(() => import("@/components/study-records").then(mod => mod.StudyRecords), {
  ssr: false,
});
import { Analytics } from "@/components/analytics"
import { ExamAnalysis } from "@/components/exam-analysis"
import { Settings } from "@/components/settings"

import { NewChatPanel } from "@/components/new-chat-panel"
import { MobileHeader } from "@/components/mobile-header"

// Define Goal type, ideally this would be in a shared types file
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

export default function StudyApp() {
  const [activeView, setActiveView] = useState("records")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  
  const [isNewChatOpen, setIsNewChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState("")
  const [isFullScreen, setIsFullScreen] = useState(false);
  
  const [logData, setLogData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });
  const [uniqueSubjects, setUniqueSubjects] = useState<string[]>([]);
  const [subjectColors, setSubjectColors] = useState<Record<string, string>>({});
  const [dashboardData, setDashboardData] = useState(null);
  const [selectedGoalForChat, setSelectedGoalForChat] = useState<Goal | null>(null);
  const [selectedFilesForChat, setSelectedFilesForChat] = useState<File[]>([]);

  const chatStateBeforeSystemView = useRef(false);

  const { messages, activeMessage, isGeneratingResponse, sendMessage, cancelSendMessage, requestHistory, isFetchingHistory, historyFinished, clearMessages } = useChat({
    onMessageReceived: () => {
      // messagesContainerRef は NewChatPanel 内にあるため、ここでは直接操作できない
      // NewChatPanel 内でスクロールロジックを維持する
    },
  });

  const fetchLogData = useCallback(async (date: string) => {
    console.log(`[page.tsx] fetchLogData triggered for date: ${date}`);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/logs/${date}`, { cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 404) {
          setLogData(null);
        } else {
          const errorData = await response.json();
          throw new Error(errorData.details || `HTTP error! status: ${response.status}`);
        }
      } else {
        const rawData = await response.json();
        const transformedData = {
          ...rawData,
          sessions: rawData.sessions.map((session: any) => ({
            ...session,
            start_time: session.session_start_time,
            end_time: session.session_end_time,
            total_duration: session.total_study_minutes,
            logs: session.details.map((detail: any) => ({ ...detail, type: detail.event_type })),
          })),
        };
        setLogData(transformedData);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }, []); // 依存配列は空でOK

  const handleViewChange = (view: string) => {
    if (view === 'system-chat') {
      chatStateBeforeSystemView.current = isNewChatOpen;
      setIsNewChatOpen(false);
    } else if (activeView === 'system-chat') {
      setIsNewChatOpen(chatStateBeforeSystemView.current);
    }
    setActiveView(view);
  };

  const handleMaximizeClick = () => {
    handleViewChange('system-chat');
  };

  useEffect(() => {
    fetchLogData(selectedDate);
  }, [selectedDate, fetchLogData]);

  useEffect(() => {
    const fetchDashboardData = async () => {
      const weeklyPeriod = localStorage.getItem('weeklyPeriod') || 'this_week';
      const weeklyPeriodDays = weeklyPeriod === '7_days' ? 7 : null;
      
      try {
        const apiUrl = weeklyPeriodDays 
          ? `/api/dashboard?weekly_period=${weeklyPeriodDays}`
          : '/api/dashboard';
        const response = await fetch(apiUrl);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setDashboardData(data);
      } catch (e) {
        console.error("Failed to fetch dashboard data:", e);
      }
    };

    fetchDashboardData();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'weeklyPeriod') {
        fetchDashboardData();
      }
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };

  }, []);

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        // Fetch unique subjects
        const subjectsResponse = await fetch('/api/subjects');
        if (!subjectsResponse.ok) {
          throw new Error(`HTTP error! status: ${subjectsResponse.status}`);
        }
        const subjects = await subjectsResponse.json();
        setUniqueSubjects(subjects);

        // Fetch subject colors
        const colorsResponse = await fetch('/api/colors');
        if (!colorsResponse.ok) {
          throw new Error(`HTTP error! status: ${colorsResponse.status}`);
        }
        const colors = await colorsResponse.json();
        setSubjectColors(colors);

      } catch (e) {
        console.error("Failed to fetch initial data:", e);
        // Handle error appropriately in a real app
      }
    };
    fetchInitialData();
  }, []);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
  };

  const handleColorChange = (subject: string, color: string) => {
    setSubjectColors(prevColors => ({
      ...prevColors,
      [subject]: color,
    }));
  };

  const handleSaveColors = async () => {
    try {
      const response = await fetch('/api/colors', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(subjectColors),
      });

      if (!response.ok) {
        throw new Error('Failed to save color settings');
      }
    } catch (error) {
      console.error(error);
      throw error; // Re-throw to be caught in the Settings component
    }
  };

  const handleSelectGoal = (goal: Goal) => {
    setSelectedGoalForChat(goal);
    setIsNewChatOpen(true);
  };

  const handleClearSelectedGoal = () => {
    setSelectedGoalForChat(null);
    setSelectedFilesForChat([]);
  };

  const renderActiveView = () => {
    switch (activeView) {
      case "dashboard":
        return <DashboardContainer 
                  dashboardData={dashboardData} 
                  subjectColors={subjectColors} 
                  onRefresh={fetchDashboardData} 
               />;
      case "records":
        return <StudyRecords 
                  logData={logData} 
                  onDateChange={handleDateChange} 
                  selectedDate={selectedDate}
                  isLoading={isLoading}
                  error={error}
                  subjectColors={subjectColors}
                  onSelectGoal={handleSelectGoal}
                  onRefresh={fetchLogData}
               />;
      case "analytics":
        return <Analytics />;
      case "exams":
        return <ExamAnalysis />;
      case "settings":
        return <Settings 
                  uniqueSubjects={uniqueSubjects} 
                  subjectColors={subjectColors}
                  onColorChange={handleColorChange}
                  onSaveColors={handleSaveColors}
                />;
      case "system-chat":
        return <NewChatPanel 
                  showAs="embedded"
                  messages={messages}
                  activeMessage={activeMessage}
                  isGeneratingResponse={isGeneratingResponse}
                  sendMessage={sendMessage}
                  cancelSendMessage={cancelSendMessage}
                  requestHistory={requestHistory}
                  isFetchingHistory={isFetchingHistory}
                  historyFinished={historyFinished}
                  clearMessages={clearMessages}
                  input={chatInput}
                  setInput={setChatInput}
                  selectedFiles={selectedFilesForChat}
                  setSelectedFiles={setSelectedFilesForChat}
                  selectedGoal={selectedGoalForChat}
                  onClearSelectedGoal={handleClearSelectedGoal}
                />;
      default:
        return <Dashboard />;
    }
  }

  return (
    <div className={`min-h-screen bg-background ${isFullScreen && activeView !== 'system-chat' ? 'overflow-hidden' : ''}`}>
      <div className={isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}>
        <MobileHeader
          onMenuClick={() => setIsMobileMenuOpen(true)}
          onChatClick={() => setIsNewChatOpen(true)}
        />
      </div>

      <div className="flex h-screen">
        <div className={isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}>
          <Sidebar
            activeView={activeView}
            onViewChange={handleViewChange}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            isMobileMenuOpen={isMobileMenuOpen}
            setIsMobileMenuOpen={setIsMobileMenuOpen}
          />
        </div>

        <main
          className={`flex-1 transition-all duration-300 flex flex-col max-w-[100vw] ${
            sidebarCollapsed ? "lg:ml-16" : "lg:ml-64"
          } ${isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}`}
        >
          <div className="flex-1 p-6 pt-20 lg:pt-6 overflow-y-auto overflow-x-hidden">
            <div className="max-w-7xl mx-auto h-full">{renderActiveView()}</div>
          </div>
        </main>

        {/* Floating Chat Button for Desktop */}
        {!isNewChatOpen && activeView !== 'system-chat' && (
          <div className="hidden lg:block fixed bottom-8 right-8 z-50">
            <Button
              onClick={() => setIsNewChatOpen(true)}
              className="rounded-2xl w-14 h-14 bg-white shadow-lg hover:scale-110 transition-transform p-0 flex items-center justify-center focus-visible:ring-0 focus-visible:ring-offset-0"
            >
              <Image
                src="/images/app-icon.png"
                alt="Chat"
                width={48}
                height={48}
                className="rounded-xl"
              />
            </Button>
          </div>
        )}
        
        {activeView !== 'system-chat' && (
          <NewChatPanel 
            showAs="floating"
            isOpen={isNewChatOpen} 
            onClose={() => {
              setIsNewChatOpen(false);
              setIsFullScreen(false);
              setSelectedGoalForChat(null);
            }} 
            isFullScreen={isFullScreen}
            setIsFullScreen={setIsFullScreen}
            onMaximizeClick={handleMaximizeClick}
            selectedGoal={selectedGoalForChat}
            onClearSelectedGoal={handleClearSelectedGoal}
            // useChat related props
            messages={messages}
            activeMessage={activeMessage}
            isGeneratingResponse={isGeneratingResponse}
            sendMessage={sendMessage}
            cancelSendMessage={cancelSendMessage}
            requestHistory={requestHistory}
            isFetchingHistory={isFetchingHistory}
            historyFinished={historyFinished}
            clearMessages={clearMessages}
            input={chatInput}
            setInput={setChatInput}
            selectedFiles={selectedFilesForChat}
            setSelectedFiles={setSelectedFilesForChat}
          />
        )}
      </div>
    </div>
  )
}
