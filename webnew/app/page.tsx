"use client"

import { useState, useEffect, useRef } from "react"
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
  const [isFullScreen, setIsFullScreen] = useState(false);
  
  const [logData, setLogData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const date = new Date();
    return date.toISOString().split('T')[0];
  });
  const [uniqueSubjects, setUniqueSubjects] = useState<string[]>([]);

  const chatStateBeforeSystemView = useRef(false);

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
    const fetchLogData = async (date: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/logs/${date}`);
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
            daily_summary: {
              date: date,
              total_duration: rawData.total_day_study_minutes,
              subjects: rawData.subjects_studied,
              summary: rawData.daily_summary,
            },
            sessions: rawData.sessions.map((session: any) => ({
              session_id: session.session_id,
              subject: session.subject,
              start_time: session.session_start_time,
              end_time: session.session_end_time,
              total_duration: session.total_study_minutes,
              summary: session.summary,
              logs: session.details.map((detail: any) => ({
                ...detail,
                type: detail.event_type,
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

  useEffect(() => {
    const fetchUniqueSubjects = async () => {
      try {
        const response = await fetch('/api/subjects');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const subjects = await response.json();
        setUniqueSubjects(subjects);
      } catch (e) {
        console.error("Failed to fetch unique subjects:", e);
      }
    };
    fetchUniqueSubjects();
  }, []);

  const handleDateChange = (newDate: string) => {
    setSelectedDate(newDate);
  };

  const renderActiveView = () => {
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
        return <Settings uniqueSubjects={uniqueSubjects} />;
      case "system-chat":
        return <NewChatPanel showAs="embedded" />;
      default:
        return <Dashboard />;
    }
  };

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
          className={`flex-1 transition-all duration-300 flex flex-col ${
            sidebarCollapsed ? "lg:ml-16" : "lg:ml-64"
          } ${isFullScreen && activeView !== 'system-chat' ? 'hidden' : ''}`}
        >
          <div className="flex-1 p-6 pt-20 lg:pt-6 overflow-y-auto">
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
            }} 
            isFullScreen={isFullScreen}
            setIsFullScreen={setIsFullScreen}
            onMaximizeClick={handleMaximizeClick}
          />
        )}
      </div>
    </div>
  )
}
