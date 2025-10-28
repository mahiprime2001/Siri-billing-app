"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button" // Import Button
import { useToast } from "@/components/ui/use-toast"
import { apiClient } from "@/lib/api-client"; // Import apiClient

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export default function HomePage() {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const checkLoginStatus = async () => {
      const sessionToken = typeof window !== 'undefined' ? localStorage.getItem('session_token') : null;
      if (!sessionToken) {
        router.push("/login");
        return;
      }

      try {
        const response = await apiClient("/api/auth/me");
        if (response.ok) {
          const { user: userData } = await response.json();
          setUser(userData);
          router.push("/billing"); // Redirect to billing if logged in
        } else {
          localStorage.removeItem("session_token"); // Clear invalid token
          router.push("/login");
        }
      } catch (error) {
        console.error("Error checking login status:", error);
        localStorage.removeItem("session_token"); // Clear token on network error
        router.push("/login");
      } finally {
        setLoading(false);
      }
    };

    checkLoginStatus();
  }, [router, toast]);

  const handleLogout = async () => {
    try {
      await apiClient("/api/auth/logout", { method: "POST" });
      localStorage.removeItem("session_token");
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Loading...</h1>
          <p className="text-gray-600">Checking login status...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Welcome {user?.name || "User"}!</h1>
        <p className="text-gray-600">You should be redirected shortly.</p>
        <Button onClick={handleLogout} className="mt-4">Logout</Button>
      </div>
    </div>
  );
}
