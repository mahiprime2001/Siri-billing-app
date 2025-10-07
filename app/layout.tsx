"use client"

import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useEffect } from 'react'

// Correct import for Tauri v2 updater plugin
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

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

    async function setupUpdater() {
      // Only run updater logic if in Tauri environment
      if (typeof window === 'undefined' || !window.__TAURI__) {
        return
      }

      try {
        // Check for updates
        const update = await check()
        
        if (update?.available) {
          toast("Update available", {
            description: `Update to ${update.version} available!`,
            action: { 
              label: "Install now", 
              onClick: async () => {
                try {
                  await update.downloadAndInstall()
                  await relaunch()
                } catch (error) {
                  console.error("Update failed:", error)
                  toast("Update failed", {
                    description: "Failed to install the update."
                  })
                }
              }
            },
          })
        }
      } catch (error) {
        console.error("Update check failed:", error)
      }
    }

    setupUpdater()
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
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  )
}
