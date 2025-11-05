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
import { apiClient } from "@/lib/api-client"; // Import apiClient


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

  useEffect(() => {
    fetchUserData()
    fetchSyncStatus()

    // Set up an interval to refresh sync status every minute
    const statusInterval = setInterval(fetchSyncStatus, 60 * 1000);

    return () => {
      clearInterval(statusInterval);
    }
  }, [fetchUserData, fetchSyncStatus])

  const handleLogout = async () => {
    try {
      await apiClient("/api/auth/logout", { method: "POST" });
      // Session is managed by HTTP-only cookies, no need to remove from localStorage
      toast({
        title: "Logout Successful",
        description: "You have been successfully logged out.",
        variant: "default",
      });
      router.push("/login");
    } catch (error) {
      console.error("Error during logout:", error);
      toast({
        title: "Logout Failed",
        description: "An error occurred during logout. Please try again.",
        variant: "destructive",
      });
    }
  };

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
