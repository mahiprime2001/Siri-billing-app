"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { LogOut, Gem, RefreshCw, CloudOff, Cloud, Package, Download, Database, Menu } from "lucide-react" // Added Download, Database, and Menu icons
import BillingHistory from "@/components/billing-history"
import BillingAndCart from "@/components/billing-and-cart"
import PrintableInvoice from "@/components/printable-invoice"
import ReturnsDialog from "@/components/returns-dialog"
import ReturnsManagement from "@/components/returns-management"
import { useToast } from "@/hooks/use-toast"
import { useIsMobile } from "@/hooks/use-mobile" // Import useIsMobile hook
import Image from "next/image"
import { apiClient } from "@/lib/api-client"
import { check } from '@tauri-apps/plugin-updater' // Import updater check
import { ask, message } from '@tauri-apps/plugin-dialog' // Import dialog functions
import { relaunch } from '@tauri-apps/plugin-process' // Import relaunch


interface User {
  id: string
  name: string
  role: string
}

export default function BillingPage() {
  const [user, setUser] = useState<User | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(true)
  const [isReturnsDialogOpen, setIsReturnsDialogOpen] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false) // State for sync operation
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false) // State for update check
  const [pendingReturnsCount, setPendingReturnsCount] = useState(0) // State for pending returns count
  const isMobile = useIsMobile() // Use the hook
  const router = useRouter()
  const { toast } = useToast()

  const fetchUserData = useCallback(async () => {
    // With HTTP-only cookies, the browser automatically sends the session cookie.
    // The apiClient is configured to include credentials.
    // If the session is invalid, apiClient will handle the 401 and redirect.
    try {
      console.log("Fetching user data...");
      const response = await apiClient("/api/auth/me");
      
      if (response.ok) {
        const data = await response.json();
        console.log("User data received:", data);
        setUser(data.user);
      } else {
        console.error("Failed to fetch user data. Redirecting to login.");
        // apiClient should handle the redirect for 401, but as a fallback:
        router.push("/login");
      }
    } catch (error) {
      console.error("Error fetching user data:", error);
      // apiClient is designed to handle 401 errors and redirect.
      // Other errors might be network issues, which shouldn't immediately redirect.
    }
  }, [router]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const response = await apiClient("/api/sync/status");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const statusData = await response.json();
      setIsOnline(statusData.database_connected);
      if (statusData.last_sync) {
        setLastSyncTime(new Date(statusData.last_sync).toLocaleString());
      }
    } catch (error) {
      console.error("Error fetching sync status:", error);
      setIsOnline(false);
      setLastSyncTime("N/A (Offline)");
    }
  }, []);

  const fetchPendingReturnsCount = useCallback(async () => {
    try {
      const response = await apiClient("/api/returns/pending/count");
      if (response.ok) {
        const data = await response.json();
        setPendingReturnsCount(data.count);
      }
    } catch (error) {
      console.error("Error fetching pending returns count:", error);
    }
  }, []);

  useEffect(() => {
    fetchUserData()
    fetchSyncStatus()
    fetchPendingReturnsCount()

    // Set up intervals to refresh sync status and pending returns count
    const statusInterval = setInterval(fetchSyncStatus, 60 * 1000);
    const returnsInterval = setInterval(fetchPendingReturnsCount, 30 * 1000); // Check every 30 seconds

    return () => {
      clearInterval(statusInterval);
      clearInterval(returnsInterval);
    }
  }, [fetchUserData, fetchSyncStatus, fetchPendingReturnsCount])

  const handleLogout = async () => {
    try {
      await apiClient("/api/auth/logout", { method: "POST" })
      toast({
        title: "Logout Successful",
        description: "You have been successfully logged out.",
        variant: "default",
      })
      router.push("/login")
    } catch (error) {
      console.error("Error during logout:", error)
      toast({
        title: "Logout Failed",
        description: "An error occurred during logout. Please try again.",
        variant: "destructive",
      })
    }
  }

  // Handle Check for Updates
  const handleCheckForUpdates = async () => {
    if (isCheckingUpdate) return
    
    setIsCheckingUpdate(true)
    toast({
      title: "Checking for Updates",
      description: "Please wait while we check for updates...",
    })

    try {
      const update = await check()
      
      if (!update || !update.available) {
        await message('You are using the latest version!', {
          title: 'No Updates Available',
          kind: 'info',
        })
        toast({
          title: "Up to Date",
          description: "You are already using the latest version.",
        })
        return
      }

      // Update available
      const shouldUpdate = await ask(
        `A new version ${update.version} is available!\n\nRelease notes:\n${update.body || 'No release notes available.'}\n\nWould you like to install it now? (App will restart after update)`,
        {
          title: 'Update Available!',
          kind: 'info',
          okLabel: 'Install Update',
          cancelLabel: 'Later',
        }
      )

      if (shouldUpdate) {
        toast({
          title: "Downloading Update",
          description: "Please wait while the update is being downloaded and installed...",
        })

        // Download and install update
        let downloadProgress = 0
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              console.log('Download started')
              break
            case 'Progress':
              const progress = event.data as { chunkLength: number; contentLength: number | null }
              if (progress.contentLength) {
                downloadProgress = Math.round((progress.chunkLength / progress.contentLength) * 100)
                console.log(`Download progress: ${downloadProgress}%`)
              }
              break
            case 'Finished':
              console.log('Download finished, installing...')
              break
          }
        })

        await message('Update installed successfully! The app will now restart.', {
          title: 'Update Complete',
          kind: 'info',
          okLabel: 'Restart Now',
        })

        // Restart the app
        await relaunch()
      }
    } catch (error) {
      console.error('Update check failed:', error)
      toast({
        title: "Update Check Failed",
        description: "Failed to check for updates. Please try again later.",
        variant: "destructive",
      })
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  // Handle Sync Now
  const handleSyncNow = async () => {
    if (isSyncing) return
    
    setIsSyncing(true)
    toast({
      title: "Syncing Data",
      description: "Pulling data from database and saving to JSON files...",
    })

    try {
      const response = await apiClient("/api/sync/pull", { method: "POST" })
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }

      const result = await response.json()
      
      toast({
        title: "Sync Complete",
        description: `Successfully synced data to JSON files.`,
      })

      // Refresh sync status and pending returns count
      await fetchSyncStatus()
      await fetchPendingReturnsCount()
    } catch (error) {
      console.error("Sync failed:", error)
      toast({
        title: "Sync Failed",
        description: "Failed to sync data. Please check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setIsSyncing(false)
    }
  }

  if (!user) {
    return <div>Loading...</div>
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className={`max-w-7xl mx-auto px-4 ${isMobile ? "py-2" : "py-4"} flex justify-between items-center`}>
          <div className="flex items-center space-x-3">
            <Image src="/logo.png" alt="Company Logo" width={isMobile ? 32 : 40} height={isMobile ? 32 : 40} className="rounded-lg" />
            <h1 className={`font-bold text-gray-900 dark:text-white ${isMobile ? "text-xl" : "text-2xl"}`}>Siri Billing</h1>
          </div>

          <div className="flex items-center space-x-4">
            {/* Online/Offline Status Indicator */}
            {!isMobile && (
              <div className="flex items-center space-x-2 text-sm">
                {isOnline ? (
                  <>
                    <Cloud className="h-5 w-5 text-green-500" />
                    <span className="text-green-600 dark:text-green-400 font-medium">Online</span>
                  </>
                ) : (
                  <>
                    <CloudOff className="h-5 w-5 text-red-500" />
                    <span className="text-red-600 dark:text-red-400 font-medium">Offline</span>
                  </>
                )}
              </div>
            )}

            {/* Last Sync Time */}
            {!isMobile && lastSyncTime && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Last sync: {lastSyncTime}
              </div>
            )}

            {/* User Dropdown Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="flex items-center space-x-2">
                  {isMobile ? <Menu className="h-5 w-5" /> : <Gem className="h-5 w-5" />}
                  {!isMobile && <span className="font-medium">{user.name}</span>}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={handleCheckForUpdates} disabled={isCheckingUpdate}>
                  <Download className="mr-2 h-4 w-4" />
                  <span>{isCheckingUpdate ? "Checking..." : "Check for Updates"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleSyncNow} disabled={isSyncing || !isOnline}>
                  <Database className="mr-2 h-4 w-4" />
                  <span>{isSyncing ? "Syncing..." : "Sync Now"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setIsReturnsDialogOpen(true)}>
                  <Package className="mr-2 h-4 w-4" />
                  <span>Returns</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Logout</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 ${isMobile ? "py-4" : "py-8"}`}>
        <Tabs defaultValue="billing" className="space-y-6">
          <TabsList className={`grid w-full ${isMobile ? "grid-cols-3 text-sm" : "grid-cols-3"}`}>
            <TabsTrigger value="billing">Billing & Cart</TabsTrigger>
            <TabsTrigger value="history">Billing History</TabsTrigger>
            <TabsTrigger value="returns" className="relative">
              Returns
              {pendingReturnsCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center font-semibold">
                  {pendingReturnsCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="billing">
            <BillingAndCart />
          </TabsContent>

          <TabsContent value="history">
            <BillingHistory />
          </TabsContent>

          <TabsContent value="returns">
            <ReturnsManagement onCountChange={fetchPendingReturnsCount} />
          </TabsContent>
        </Tabs>
      </main>

      {user && (
        <ReturnsDialog
          isOpen={isReturnsDialogOpen}
          onClose={() => setIsReturnsDialogOpen(false)}
          user={user}
        />
      )}
    </div>
  )
}
