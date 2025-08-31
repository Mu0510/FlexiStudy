import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { ViewportController } from '@/components/viewport-controller'
import { ThemeProvider } from "@/components/theme-provider"
import { WebSocketProvider } from '@/context/WebSocketContext';
import { DevSWRegister } from '@/components/dev-sw-register';

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
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {process.env.NODE_ENV !== 'production' ? <DevSWRegister /> : null}
          <ViewportController />
          <WebSocketProvider>
            {children}
          </WebSocketProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
