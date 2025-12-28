"use client"

import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useEffect, useState, useRef } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Updater from '@/components/Updater'
import packageJson from '../package.json'
import { apiClient } from '@/lib/api-client'
import VersionDisplay from '@/components/VersionDisplay'
import { UpdaterDebug } from '@/components/UpdaterDebug'

declare global {
  interface Window {
    isLoggingOut: boolean
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
  const [authChecked, setAuthChecked] = useState(false)
  const isCheckingAuth = useRef(false)
  const [showUpdaterDebug, setShowUpdaterDebug] = useState(false)

  // Online status handler
  useEffect(() => {
    if (!online) {
      toast("You are offline", {
        description: "Please check your internet connection.",
        duration: Infinity,
      })
    }

    if (typeof window !== 'undefined') {
      window.isLoggingOut = false
      if ((window as any).__TAURI__) {
        setShowUpdaterDebug(true)
      }
    }
  }, [online])

  // 🔥 INTERCEPT router.push to prevent unwanted redirects
  useEffect(() => {
    const originalPush = router.push
    router.push = function(href: string, options?: any) {
      console.log('🔀 [ROUTER] Attempting navigation to:', href)
      
      // ❌ BLOCK redirects to /login when user is already authenticated
      if (href === '/login' && authChecked && pathname !== '/login') {
        console.warn('🛑 [BLOCKED] Prevented redirect to /login - user is authenticated!')
        return Promise.resolve(true)
      }

      return originalPush.call(this, href, options)
    }

    return () => {
      router.push = originalPush
    }
  }, [router, pathname, authChecked])

  // Authentication check
  useEffect(() => {
    // Skip auth check for login page
    if (pathname === "/login") {
      setAuthChecked(true)
      return
    }

    // Prevent multiple simultaneous auth checks
    if (isCheckingAuth.current) {
      return
    }

    // If already checked, don't check again
    if (authChecked) {
      return
    }

    const checkAuth = async () => {
      isCheckingAuth.current = true

      try {
        const response = await apiClient("/api/auth/me")

        if (response.status === 401) {
          console.log('❌ [AUTH] User not authenticated, redirecting to login')
          if (pathname !== '/login') {
            router.push("/login")
          }
        } else if (response.ok) {
          const data = await response.json()
          console.log('✅ [AUTH] User authenticated:', data.email || data.user?.email)
          setAuthChecked(true)
        } else {
          console.log('⚠️ [AUTH] Auth check failed with status:', response.status)
          if (pathname !== '/login') {
            router.push("/login")
          }
        }
      } catch (error) {
        console.error('💥 [AUTH] Auth check error:', error)
        
        if (pathname !== "/billing" && pathname !== '/login') {
          router.push("/login")
        } else if (pathname === "/billing") {
          console.log('⚠️ [AUTH] Auth check failed on /billing, allowing page load')
          setAuthChecked(true)
        }
      } finally {
        isCheckingAuth.current = false
      }
    }

    const timer = setTimeout(checkAuth, 200)
    return () => {
      clearTimeout(timer)
    }
  }, [pathname, router, authChecked])

  // Show loading screen while checking auth
  if (!authChecked && pathname !== '/login') {
    return (
      <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <body>
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-900 mx-auto mb-4"></div>
              <p className="text-gray-600">Checking authentication...</p>
            </div>
          </div>
        </body>
      </html>
    )
  }

  // ✅ MAIN RETURN - THIS WAS MISSING!
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <Toaster />
        
        {/* ✅ UPDATER COMPONENT - THIS IS CRITICAL! */}
        <Updater/>
        
        {/* Optional: Version display */}
        {typeof VersionDisplay !== 'undefined' && (
          <VersionDisplay version={packageJson.version} />
        )}
        
        {/* Optional: Updater debug panel (visible in installed Tauri app) */}
        {showUpdaterDebug && typeof UpdaterDebug !== 'undefined' && (
          <UpdaterDebug />
        )}
      </body>
    </html>
  )
}
