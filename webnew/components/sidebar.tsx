"use client"

import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import {
  LayoutDashboard,
  BookOpen,
  BarChart3,
  FileText,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface SidebarProps {
  activeView: string
  onViewChange: (view: string) => void
  collapsed: boolean
  onToggleCollapse: () => void
  isMobileMenuOpen: boolean
  setIsMobileMenuOpen: (isOpen: boolean) => void
}

const menuItems = [
  { id: "dashboard", label: "ダッシュボード", icon: LayoutDashboard },
  { id: "records", label: "学習記録", icon: BookOpen },
  { id: "system-chat", label: "システムチャット", icon: MessageSquare },
  { id: "analytics", label: "グラフ分析", icon: BarChart3 },
  { id: "exams", label: "模試分析", icon: FileText },
  { id: "settings", label: "設定", icon: SettingsIcon },
]

// Component for the navigation links, used by both desktop and mobile sidebars
function SidebarNavContent({ activeView, onViewChange, onLinkClick, collapsed = false }: any) {
  const handleViewChange = (view: string) => {
    onViewChange(view)
    onLinkClick?.() // Close mobile sheet on navigation
  }

  return (
    <div className={cn("flex flex-col flex-1", collapsed ? "pt-2" : "pt-0")}>
      <nav className="flex-1 px-2 space-y-2">
        {menuItems.map((item) => {
          const Icon = item.icon
          return (
            <Button
              key={item.id}
              variant={activeView === item.id ? "default" : "ghost"}
              className={cn(
                "w-full justify-start h-12 transition-all duration-200",
                collapsed ? "px-3 justify-center" : "px-4"
              )}
              onClick={() => handleViewChange(item.id)}
              title={item.label} // Tooltip for collapsed view
            >
              <Icon className={cn("w-5 h-5", !collapsed && "mr-3")} />
              {!collapsed && <span className="font-medium">{item.label}</span>}
            </Button>
          )
        })}
      </nav>
    </div>
  )
}

export function Sidebar({ 
  activeView, 
  onViewChange, 
  collapsed, 
  onToggleCollapse, 
  isMobileMenuOpen, 
  setIsMobileMenuOpen, 
}: SidebarProps) {
  return (
    <>
      {/* --- Desktop Sidebar --- */}
      <aside
        className={cn(
          "fixed left-0 top-0 h-screen border-r transition-all duration-300 z-40 hidden lg:flex flex-col bg-background",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Desktop Header */}
        <div className="p-4 border-b h-[65px] bg-white dark:bg-background">
            <div className="flex items-center justify-between h-full">
              {!collapsed && (
                <div className="flex items-center space-x-3">
                  <Image src="/images/logo.svg" alt="FlexiStudy Logo" width={32} height={32} />
                  <h1 className="text-xl font-bold text-foreground">
                    FlexiStudy
                  </h1>
                </div>
              )}
               <Button variant="ghost" size="sm" onClick={onToggleCollapse} className="p-2">
                {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
              </Button>
            </div>
        </div>
        <SidebarNavContent 
            activeView={activeView} 
            onViewChange={onViewChange} 
            collapsed={collapsed}
        />
      </aside>

      {/* --- Mobile Sidebar (Sheet) --- */}
      <div className="lg:hidden">
        <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
          <SheetContent side="left" className="w-64 bg-background p-0 flex flex-col">
            {/* Mobile Header */}
            <div className="p-4 border-b bg-white dark:bg-background">
                <div className="flex items-center space-x-3">
                    <Image src="/images/logo.svg" alt="FlexiStudy Logo" width={32} height={32} />
                    <h1 className="text-xl font-bold text-foreground">FlexiStudy</h1>
                </div>
            </div>
            <SidebarNavContent 
              activeView={activeView} 
              onViewChange={onViewChange} 
              onLinkClick={() => setIsMobileMenuOpen(false)}
            />
          </SheetContent>
        </Sheet>
      </div>
    </>
  )
}

