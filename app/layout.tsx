"use client"

import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useEffect } from 'react'
import Updater from '@/components/Updater'
import packageJson from '../package.json'

declare global {
  interface Window {
    isLoggingOut: boolean;
    __TAURI__?: unknown
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const online = useOnlineStatus()

  useEffect(() => {
    if (!online) {
      toast("You are offline", {
        description: "Please check your internet connection.",
        duration: Infinity,
      })
    }

    window.isLoggingOut = false
  }, [online])

  return (
    <html lang="en">
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
      </head>
      <body suppressHydrationWarning={true}>
        <Updater />
        {children}
        <Toaster position="top-right" />
        
        {/* Version display in footer */}
        <div className="fixed bottom-2 left-2 text-xs text-gray-400 pointer-events-none z-50">
          v{packageJson.version}
        </div>
      </body>
    </html>
  )
}
