"use client"

import { useEffect, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { LogOut, Gem, RefreshCw, CloudOff, Cloud, Package } from "lucide-react" // Import Package icon
import BillingHistory from "@/components/billing-history"
import BillingAndCart from "@/components/billing-and-cart"
import PrintableInvoice from "@/components/printable-invoice" // Import PrintableInvoice
import ReturnsDialog from "@/components/returns-dialog" // Import ReturnsDialog
import { useToast } from "@/hooks/use-toast"
import Image from "next/image"



interface User {
  id: string
  name: string
  role: string
}

export default function BillingPage() {
  const [user, setUser] = useState<User | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null)
  const [isOnline, setIsOnline] = useState<boolean>(true) // Assume online initially
  const [isReturnsDialogOpen, setIsReturnsDialogOpen] = useState(false) // State for returns dialog
  const router = useRouter()
  const { toast } = useToast()

  const fetchUserData = useCallback(async () => {
    const adminLoggedIn = localStorage.getItem("adminLoggedIn")
    const adminUser = localStorage.getItem("adminUser")

    if (!adminLoggedIn || !adminUser) {
      router.push("/login")
      console.log("No admin user data found in localStorage. Redirecting to login.")
      return
    }

    try {
      const parsedUser = JSON.parse(adminUser)
      setUser(parsedUser)
      console.log("User data loaded from localStorage:", parsedUser)
    } catch (error) {
      console.error("Error parsing admin user data from localStorage:", error)
      router.push("/login")
    }
  }, [router])

  const fetchSyncStatus = useCallback(async () => {
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_API_URL}/api/sync/status`);
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

  useEffect(() => {
    fetchUserData()
    fetchSyncStatus()

    // Set up an interval to refresh sync status every minute
    const statusInterval = setInterval(fetchSyncStatus, 60 * 1000);

    return () => {
      clearInterval(statusInterval);
    }
  }, [fetchUserData, fetchSyncStatus])

  const handleLogout = () => {
    localStorage.removeItem("adminLoggedIn")
    localStorage.removeItem("adminUser")
    router.push("/login")
  }

  if (!user) {
    return <div>Loading...</div>
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-amber-100 rounded-lg">
                <Image src="/Logo.png" alt="Logo" width={55} height={55} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Siri Art Jewellers</h1>
                <p className="text-sm text-gray-500">Billing Management System</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <div className={`flex items-center text-sm ${isOnline ? 'text-green-600' : 'text-red-600'}`}>
                {isOnline ? <Cloud className="h-4 w-4 mr-1" /> : <CloudOff className="h-4 w-4 mr-1" />}
                {isOnline ? 'Online' : 'Offline'}
                {lastSyncTime && <span className="ml-2 text-gray-500">Last Sync: {lastSyncTime}</span>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <span className="text-sm text-gray-600">Welcome, {user?.name || 'Guest'}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Removed Sync Now button */}
                  <DropdownMenuItem onClick={() => setIsReturnsDialogOpen(true)}>
                    <Package className="h-4 w-4 mr-2" />
                    Returns
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleLogout}>
                    <LogOut className="h-4 w-4 mr-2" />
                    Logout
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Tabs defaultValue="billing" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="billing">Billing & Cart</TabsTrigger>
            <TabsTrigger value="history">Billing History</TabsTrigger>
          </TabsList>

          <TabsContent value="billing">
            <BillingAndCart />
          </TabsContent>

          <TabsContent value="history">
            <BillingHistory />
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
