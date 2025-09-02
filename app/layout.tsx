"use client"

import type { Metadata } from 'next'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { toast } from 'sonner'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { useEffect, useRef } from 'react'
import ServerStartup from './server-startup';

// Declare a global variable to track explicit logout
declare global {
  interface Window {
    isLoggingOut: boolean;
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const online = useOnlineStatus()
  const isExplicitlyLoggingOut = useRef(false);

  useEffect(() => {
    if (!online) {
      toast("You are offline", {
        description: "Please check your internet connection.",
        duration: Infinity,
      })
    }

    // Set a global flag when an explicit logout is initiated
    window.isLoggingOut = false;

    const handleBeforeUnload = async () => {
      // Only trigger automatic logout if not explicitly logging out
      if (window.isLoggingOut) {
        return;
      }

      const userId = localStorage.getItem('userId'); // Assuming userId is stored in localStorage on login

      if (userId) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ userId }),
          keepalive: true,
        });
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
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
      <body>
        <ServerStartup />
        {children}
        <Toaster position="top-right" />
      </body>
    </html>
  )
}
