"use client"

import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Menu, MessageSquare } from "lucide-react"

interface MobileHeaderProps {
  onMenuClick: () => void
  onChatClick: () => void
}

export function MobileHeader({ onMenuClick, onChatClick }: MobileHeaderProps) {
  return (
    <header className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-white dark:bg-background border-b z-50">
      <div className="flex items-center justify-between h-full px-4">
        <div className="flex items-center space-x-3">
          <Button variant="ghost" size="sm" onClick={onMenuClick} className="p-2">
            <Menu className="w-5 h-5" />
          </Button>
          <div className="flex items-center space-x-2">
            <Image src="/images/logo.svg" alt="FlexiStudy Logo" width={28} height={28} />
            <h1 className="text-lg font-bold text-foreground">
              FlexiStudy
            </h1>
          </div>
        </div>

        <Button variant="ghost" size="sm" onClick={onChatClick} className="p-2">
          <MessageSquare className="w-5 h-5 text-accent" />
        </Button>
      </div>
    </header>
  )
}
