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
      try {
        const response = await apiClient('/api/auth/me');
        
        if (response.ok) {
          const userData = await response.json();
          setUser(userData.user);
          router.push('/billing'); // Redirect to billing if logged in
        } else {
          router.push('/login');
        }
      } catch (error) {
        console.error('Error checking login status:', error);
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    checkLoginStatus();
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Loading...</p>
      </div>
    );
  }

  return null; // Or a loading spinner, or redirect logic
}
