"use client"

import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Updater from '@/components/Updater'
import packageJson from '../package.json'
import { apiClient } from '@/lib/api-client';

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
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!online) {
      toast("You are offline", {
        description: "Please check your internet connection.",
        duration: Infinity,
      })
    }

    if (typeof window !== 'undefined') {
      window.isLoggingOut = false
    }

    const checkAuthAndRedirect = async () => {
      // Skip auth check on login page
      if (pathname === "/login") {
        return;
      }

      try {
        const response = await apiClient("/api/auth/me");
        
        if (!response.ok) {
          // Not authenticated, redirect to login
          router.push("/login");
        }
        // If OK, user is authenticated, stay on current page
      } catch (error) {
        console.error("Error checking authentication status:", error);
        // On error, redirect to login (unless already there)
        if (pathname !== "/login") {
          router.push("/login");
        }
      }
    };

    checkAuthAndRedirect();
  }, [online, pathname, router])

  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <meta name="version" content={packageJson.version} />
      </head>
      <body>
        {children}
        <Toaster />
        <Updater />
      </body>
    </html>
  )
}
