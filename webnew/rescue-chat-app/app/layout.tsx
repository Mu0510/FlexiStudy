import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Providers } from './providers'

export const metadata: Metadata = {
  title: 'FlexiStudy Rescue Chat',
  description: 'メインUIが落ちたときに同じGeminiセッションへアクセスするためのレスキューコンソール。',
}

const backendOrigin = process.env.RESCUE_BACKEND_ORIGIN || process.env.RESCUE_PROXY_ORIGIN

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const overrideScript = backendOrigin
    ? `window.__flexiChatServerOverride = { origin: ${JSON.stringify(backendOrigin)} };`
    : ''

  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        {overrideScript ? (
          <script dangerouslySetInnerHTML={{ __html: overrideScript }} />
        ) : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
