import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { ViewportController } from '@/components/viewport-controller'
import { ThemeProvider } from "@/components/theme-provider"
import { WebSocketProvider } from '@/context/WebSocketContext';
import DebugConsole from '@/components/debug-console'
import { DevSWRegister } from '@/components/dev-sw-register'

export const metadata: Metadata = {
  title: 'FlexiStudy',
  description: 'Your personalized study management assistant.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
        <link rel="manifest" href="/manifest.json" />
        {/* Favicon: prefer ICO for broad compatibility */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        {/* Optional: SVG for modern browsers */}
        <link rel="icon" href="/FlexiStudy_icon.svg" type="image/svg+xml" />
        {/* Apple touch icon (PNG) */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <ViewportController />
          <WebSocketProvider>
            {children}
          </WebSocketProvider>
          <DevSWRegister />
          {/* In-app logs enabled via ?debug=1 or localStorage('app.debug.console'='1') */}
          <DebugConsole />
        </ThemeProvider>
      </body>
    </html>
  )
}
