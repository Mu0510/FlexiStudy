'use client'

import type { ReactNode } from 'react'
import { ThemeProvider } from '../../components/theme-provider'
import { WebSocketProvider } from '../../context/WebSocketContext'
import { ViewportController } from '../../components/viewport-controller'
import DebugConsole from '../../components/debug-console'
import { DevSWRegister } from '../../components/dev-sw-register'

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <ViewportController />
      <WebSocketProvider>{children}</WebSocketProvider>
      <DevSWRegister />
      <DebugConsole />
    </ThemeProvider>
  )
}
