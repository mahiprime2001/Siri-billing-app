'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { 
  LogOut, RefreshCw, CloudOff, Cloud, Download, Menu, Bell, BellRing 
} from 'lucide-react'
import {BillingHistory} from '@/components/billing-history'
import BillingAndCart from '@/components/billing-and-cart'
import ReturnsManagement from '@/components/returns-management'
import { useToast } from '@/hooks/use-toast'
import { useIsMobile } from '@/hooks/use-mobile'
import Image from 'next/image'
import { apiClient } from '@/lib/api-client'
import { check } from '@tauri-apps/plugin-updater'
import { ask, message } from '@tauri-apps/plugin-dialog'
import { relaunch } from '@tauri-apps/plugin-process'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"

interface User {
  id: string
  name: string
  role: string
  email: string
}

interface Notification {
  id: number
  type: string
  notification: string
  related_id: string | null
  is_read: boolean
  created_at: string
}

export default function BillingPage() {
  const [user, setUser] = useState<User | null>(null)
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [pendingReturnsCount, setPendingReturnsCount] = useState(0)
  const [currentStore, setCurrentStore] = useState<{ id: string; name: string } | null>(null)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [activeTab, setActiveTab] = useState('billing')
  
  const isMobile = useIsMobile()
  const router = useRouter()
  const { toast } = useToast()

  const fetchUserData = useCallback(async () => {
    try {
      console.log('Fetching user data...')
      const response = await apiClient('/api/auth/me')
      if (response.ok) {
        const data = await response.json()
        console.log('✅ User data received:', data)
        setUser(data)
      } else {
        console.error('Failed to fetch user data. Redirecting to login.')
        router.push('/login')
      }
    } catch (error) {
      console.error('Error fetching user data:', error)
    }
  }, [router])

  const fetchCurrentStore = useCallback(async () => {
    try {
      console.log('📍 Fetching current user store...')
      const response = await apiClient('/api/stores/current')
      if (response.ok) {
        const storeData = await response.json()
        console.log('✅ Store data received:', storeData)
        setCurrentStore({
          id: storeData.id,
          name: storeData.name
        })
      } else {
        console.error('❌ Failed to fetch store data')
        toast({
          title: 'Store Not Found',
          description: 'No store is assigned to your account. Please contact admin.',
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('❌ Error fetching store:', error)
      toast({
        title: 'Store Error',
        description: 'Could not fetch store information.',
        variant: 'destructive',
      })
    }
  }, [toast])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const response = await apiClient('/api/sync/status')
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
      const statusData = await response.json()
      setIsOnline(statusData.database_connected)
      if (statusData.last_sync) {
        setLastSyncTime(new Date(statusData.last_sync).toLocaleString())
      }
    } catch (error) {
      console.error('Error fetching sync status:', error)
      setIsOnline(false)
      setLastSyncTime('N/A - Offline')
    }
  }, [])

  const fetchPendingReturnsCount = useCallback(async () => {
    try {
      const response = await apiClient('/api/returns/pending/count')
      if (response.ok) {
        const data = await response.json()
        setPendingReturnsCount(data.count)
      }
    } catch (error) {
      console.error('Error fetching pending returns count:', error)
    }
  }, [])

  // ✅ Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      const response = await apiClient('/api/notifications')
      if (response.ok) {
        const data = await response.json()
        setNotifications(data)
        
        // Fetch unread count
        const countResponse = await apiClient('/api/notifications/unread/count')
        if (countResponse.ok) {
          const countData = await countResponse.json()
          setUnreadCount(countData.count)
        }
      }
    } catch (error) {
      console.error('Error fetching notifications:', error)
    }
  }, [])

  // ✅ Mark notification as read and navigate
  const handleNotificationClick = async (notification: Notification) => {
    try {
      // Mark as read
      await apiClient(`/api/notifications/${notification.id}/read`, { method: 'POST' })
      
      // Refresh notifications
      await fetchNotifications()
      
      // Navigate to returns tab if it's a return notification
      if (notification.type === 'return_approved') {
        setActiveTab('returns')
        
        toast({
          title: 'Navigated to Returns',
          description: 'View your approved return request.',
        })
      }
    } catch (error) {
      console.error('Error handling notification:', error)
    }
  }

  // ✅ Mark all as read
  const handleMarkAllAsRead = async () => {
    try {
      await apiClient('/api/notifications/read-all', { method: 'POST' })
      await fetchNotifications()
      
      toast({
        title: 'All Read',
        description: 'All notifications marked as read.',
      })
    } catch (error) {
      console.error('Error marking all as read:', error)
    }
  }

  useEffect(() => {
    fetchUserData()
    fetchCurrentStore()
    fetchSyncStatus()
    fetchPendingReturnsCount()
    fetchNotifications()

    // Set up intervals
    const statusInterval = setInterval(fetchSyncStatus, 60 * 1000)
    const returnsInterval = setInterval(fetchPendingReturnsCount, 30 * 1000)
    const notificationsInterval = setInterval(fetchNotifications, 30 * 1000)

    return () => {
      clearInterval(statusInterval)
      clearInterval(returnsInterval)
      clearInterval(notificationsInterval)
    }
  }, [fetchUserData, fetchCurrentStore, fetchSyncStatus, fetchPendingReturnsCount, fetchNotifications])

  const handleLogout = async () => {
    try {
      await apiClient('/api/auth/logout', { method: 'POST' })
      toast({
        title: 'Logout Successful',
        description: 'You have been successfully logged out.',
        variant: 'default',
      })
      router.push('/login')
    } catch (error) {
      console.error('Error during logout:', error)
      toast({
        title: 'Logout Failed',
        description: 'An error occurred during logout. Please try again.',
        variant: 'destructive',
      })
    }
  }

  const handleCheckForUpdates = async () => {
    if (isCheckingUpdate) return
    setIsCheckingUpdate(true)
    toast({
      title: 'Checking for Updates',
      description: 'Please wait while we check for updates...',
    })

    try {
      const update = await check()

      if (!update || !update.available) {
        await message('You are using the latest version!', {
          title: 'No Updates Available',
          kind: 'info',
        })
        toast({
          title: 'Up to Date',
          description: 'You are already using the latest version.',
        })
        return
      }

      const shouldUpdate = await ask(
        `A new version ${update.version} is available!\n\n${update.body || 'No release notes available.'}\n\nWould you like to install it now? App will restart after update.`,
        {
          title: 'Update Available!',
          kind: 'info',
          okLabel: 'Install Update',
          cancelLabel: 'Later',
        }
      )

      if (shouldUpdate) {
        toast({
          title: 'Downloading Update',
          description: 'Please wait while the update is being downloaded and installed...',
        })

        await update.downloadAndInstall((event) => {
          // Handle download events
        })

        await message('Update installed successfully! The app will now restart.', {
          title: 'Update Complete',
          kind: 'info',
          okLabel: 'Restart Now',
        })

        await relaunch()
      }
    } catch (error) {
      console.error('Update check failed:', error)
      toast({
        title: 'Update Check Failed',
        description: 'Failed to check for updates. Please try again later.',
        variant: 'destructive',
      })
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const handleSyncNow = async () => {
    if (isSyncing) return
    setIsSyncing(true)
    toast({
      title: 'Syncing Data',
      description: 'Pulling data from database and saving to JSON files...',
    })

    try {
      const response = await apiClient('/api/sync/pull', { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)

      toast({
        title: 'Sync Complete',
        description: 'Successfully synced data to JSON files.',
      })

      await fetchSyncStatus()
      await fetchPendingReturnsCount()
    } catch (error) {
      console.error('Sync failed:', error)
      toast({
        title: 'Sync Failed',
        description: 'Failed to sync data. Please check your connection and try again.',
        variant: 'destructive',
      })
    } finally {
      setIsSyncing(false)
    }
  }

  if (!user) {
    return <div>Loading...</div>
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center space-x-4">
            <Image src="/logo.png" alt="Siri Logo" width={40} height={40} />
            <div>
              <h1 className="text-2xl font-bold">Siri Billing</h1>
              <p className="text-sm text-muted-foreground">
                Welcome, {user.name} {currentStore && `• ${currentStore.name}`}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Sync Status */}
            <div className="flex items-center space-x-2 text-sm">
              {isOnline ? (
                <Cloud className="h-4 w-4 text-green-500" />
              ) : (
                <CloudOff className="h-4 w-4 text-red-500" />
              )}
              <span className="text-muted-foreground">
                {isOnline ? 'Online' : 'Offline'}
              </span>
            </div>

            {/* Sync Button */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleSyncNow}
              disabled={isSyncing || !isOnline}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
              {isSyncing ? 'Syncing...' : 'Sync'}
            </Button>

            {/* ✅ Notifications Bell */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="relative">
                  {unreadCount > 0 ? (
                    <BellRing className="h-4 w-4" />
                  ) : (
                    <Bell className="h-4 w-4" />
                  )}
                  {unreadCount > 0 && (
                    <Badge className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center p-0 bg-red-500">
                      {unreadCount}
                    </Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Notifications</h3>
                  {unreadCount > 0 && (
                    <Button variant="ghost" size="sm" onClick={handleMarkAllAsRead}>
                      Mark all read
                    </Button>
                  )}
                </div>
                <ScrollArea className="h-[300px]">
                  {notifications.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No notifications
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {notifications.map((notif) => (
                        <div
                          key={notif.id}
                          className={`p-3 rounded-lg cursor-pointer hover:bg-accent ${
                            !notif.is_read ? 'bg-accent/50' : ''
                          }`}
                          onClick={() => handleNotificationClick(notif)}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="text-sm">{notif.notification}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {new Date(notif.created_at).toLocaleString()}
                              </p>
                            </div>
                            {!notif.is_read && (
                              <div className="h-2 w-2 rounded-full bg-blue-500 mt-1" />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </PopoverContent>
            </Popover>

            {/* More Menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Menu className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleCheckForUpdates} disabled={isCheckingUpdate}>
                  <Download className="h-4 w-4 mr-2" />
                  {isCheckingUpdate ? 'Checking...' : 'Check for Updates'}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="billing">Billing & Cart</TabsTrigger>
          <TabsTrigger value="billing-history">Billing History</TabsTrigger>
          <TabsTrigger value="returns" className="relative">
            Returns
            {pendingReturnsCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                {pendingReturnsCount}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="billing" className="flex-1 overflow-auto p-4">
          <BillingAndCart />
        </TabsContent>

        <TabsContent value="billing-history" className="flex-1 overflow-auto p-4">
          {currentStore ? (
            <BillingHistory currentStore={currentStore} />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-muted-foreground">Loading store information...</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="returns" className="flex-1 overflow-auto p-4">
          <ReturnsManagement user={user} onCountChange={fetchPendingReturnsCount}  />
        </TabsContent>
      </Tabs>
    </div>
  )
}
