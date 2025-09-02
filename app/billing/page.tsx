"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { LogOut, Gem } from "lucide-react"
import BillingHistory from "@/components/billing-history"
import BillingAndCart from "@/components/billing-and-cart"

interface User {
  id: string
  name: string // Changed from username to name
  role: string
}

export default function BillingPage() {
  const [user, setUser] = useState<User | null>(null)
  const router = useRouter()

  useEffect(() => {
    const fetchUserData = async () => {
      const loggedInUser = localStorage.getItem("user")
      if (!loggedInUser) {
        router.push("/login")
        console.log("No user data found in localStorage. Redirecting to login.")
        return
      }

      const { id: loggedInUserId } = JSON.parse(loggedInUser)

      try {
        const response = await fetch("/api/users")
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }
        const data = await response.json()
        const foundUser = data.users.find((u: User) => u.id === loggedInUserId)

        if (foundUser) {
          setUser(foundUser)
          console.log("User data fetched from API:", foundUser)
        } else {
          router.push("/login")
          console.log("Logged-in user not found in API response. Redirecting to login.")
        }
      } catch (error) {
        console.error("Error fetching user data:", error)
        router.push("/login") // Redirect on API error
      }
    }

    fetchUserData()
  }, [router])

  const handleLogout = () => {
    localStorage.removeItem("user")
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
                <Gem className="h-6 w-6 text-amber-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Siri Art Jewellers</h1>
                <p className="text-sm text-gray-500">Billing Management System</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">Welcome, {user?.name || 'Guest'}</span>
              <Button variant="outline" size="sm" onClick={handleLogout}>
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
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
    </div>
  )
}
