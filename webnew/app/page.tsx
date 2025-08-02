"use client"

import { useState, useEffect } from "react"
import { Sidebar } from "@/components/sidebar"
import { Dashboard } from "@/components/dashboard"
import dynamic from "next/dynamic"
import { Button } from "@/components/ui/button"
import Image from "next/image"

const StudyRecords = dynamic(() => import("@/components/study-records").then(mod => mod.StudyRecords), {
  ssr: false,
});
import { Analytics } from "@/components/analytics"
import { ExamAnalysis } from "@/components/exam-analysis"
import { Settings } from "@/components/settings"

import { NewChatPanel } from "@/components/new-chat-panel"
import { MobileHeader } from "@/components/mobile-header"

export default function StudyApp() {
  const [activeView, setActiveView] = useState("records")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  
  const [isNewChatOpen, setIsNewChatOpen] = useState(false)
  const [isFullScreen, setIsFullScreen] = useState(false); // 全画面表示用の state
  
  const [logData, setLogData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const date = new Date();
    return date.toISOString().split('T')[0]; // Get YYYY-MM-DD format
  });

  useEffect(() => {
    const fetchLogData = async (date: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/logs/${date}`);
        if (!response.ok) {
          if (response.status === 404) {
            setLogData(null); // No data for this date
          } else {
            const errorData = await response.json();
            throw new Error(errorData.details || `HTTP error! status: ${response.status}`);
          }
        } else {
          const rawData = await response.json();
          
          // Transform the data to fit the frontend's expected structure
          const transformedData = {
            daily_summary: {
              date: date, // Use the date we fetched for
              total_duration: rawData.total_day_study_minutes,
              subjects: rawData.subjects_studied,
              summary: rawData.daily_summary,
            },
            sessions: rawData.sessions.map((session: any) => ({
            session_id: session.session_id,
            subject: session.subject,
            start_time: session.session_start_time,
            end_time: session.session_end_time,
            total_duration: session.total_study_minutes, // Rename key
            summary: session.summary,
            logs: session.details.map((detail: any) => ({
              ...detail,
              type: detail.event_type, // Rename key
            })),
          })),
          };
          
          setLogData(transformedData);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setIsLoading(false);
      }
    };

    fetchLogData(selectedDate);
  }, [selectedDate]);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
  };

  const renderActiveView = () => {
    // isLoading and error checks are now handled inside the specific components
    switch (activeView) {
      case "dashboard":
        return <Dashboard />;
      case "records":
        return <StudyRecords 
                  logData={logData} 
                  onDateChange={handleDateChange} 
                  selectedDate={selectedDate}
                  isLoading={isLoading}
                  error={error} 
               />;
      case "analytics":
        return <Analytics />;
      case "exams":
        return <ExamAnalysis />;
      case "settings":
        return <Settings />;
      case "system-chat":
        return <NewChatPanel showAs="embedded" />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div className={`min-h-screen bg-background ${isFullScreen ? 'overflow-hidden' : ''}`}>
      <div className={isFullScreen ? 'hidden' : ''}>
        <MobileHeader
          onMenuClick={() => setIsMobileMenuOpen(true)}
          onChatClick={() => setIsNewChatOpen(true)}
        />
      </div>

      <div className="flex h-screen">
        <div className={isFullScreen ? 'hidden' : ''}>
          <Sidebar
            activeView={activeView}
            onViewChange={setActiveView}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            isMobileMenuOpen={isMobileMenuOpen}
            setIsMobileMenuOpen={setIsMobileMenuOpen}
          />
        </div>

        <main
          className={`flex-1 transition-all duration-300 flex flex-col ${
            sidebarCollapsed ? "lg:ml-16" : "lg:ml-64"
          } ${isFullScreen ? 'hidden' : ''}`}
        >
          <div className="flex-1 p-6 pt-20 lg:pt-6 overflow-y-auto">
            <div className="max-w-7xl mx-auto h-full">{renderActiveView()}</div>
          </div>
        </main>

        {/* Floating Chat Button for Desktop */}
        {!isNewChatOpen && (
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
        
        <NewChatPanel 
          showAs="floating"
          isOpen={isNewChatOpen} 
          onClose={() => {
            setIsNewChatOpen(false);
            setIsFullScreen(false); // 全画面表示もリセット
          }} 
          isFullScreen={isFullScreen}
          setIsFullScreen={setIsFullScreen}
        />
      </div>
    </div>
  )
}
