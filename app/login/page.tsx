"use client"

import type React from "react"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Eye, EyeOff, Mail, ArrowLeft, CheckCircle, AlertTriangle } from "lucide-react"
import Image from "next/image"
import { toast } from "sonner"
import { apiClient } from "@/lib/api-client"; // Import apiClient

interface ForgotPasswordState {
  email: string
  loading: boolean
  error: string
  success: boolean
  message: string
}

export default function LoginPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false)
  const [forgotPassword, setForgotPassword] = useState<ForgotPasswordState>({
    email: "",
    loading: false,
    error: "",
    success: false,
    message: ""
  })
  const router = useRouter()

const handleLogin = async (e: React.FormEvent) => {
  e.preventDefault();
  setLoading(true);
  setError('');

  try {
    const response = await fetch('http://localhost:8080/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include', // CRITICAL: Allow cookies
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (response.ok) {
      // DO NOT store anything in localStorage - session cookie handles it
      toast("Login Successful", {
        description: "Welcome back!",
        duration: 3000,
      });

      // Redirect to billing
      router.push('/billing');
    } else {
      setError(data.message || 'Login failed');
      toast("Login Failed", {
        description: data.message || "Invalid credentials.",
        duration: 3000,
      });
    }
  } catch (error) {
    setError('An error occurred during login');
    toast("Error", {
      description: "Something went wrong. Please try again.",
      duration: 3000,
    });
  } finally {
    setLoading(false);
  }
};

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(email)
  }

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!forgotPassword.email) {
      setForgotPassword(prev => ({ 
        ...prev, 
        error: "Email is required" 
      }))
      return
    }

    if (!validateEmail(forgotPassword.email)) {
      setForgotPassword(prev => ({ 
        ...prev, 
        error: "Please enter a valid email address" 
      }))
      return
    }

    setForgotPassword(prev => ({ 
      ...prev, 
      loading: true, 
      error: "", 
      message: "" 
    }))

    try {
      // Use apiClient for forgot password proxy
      const response = await apiClient("/api/auth/forgot-password-proxy", {
        method: "POST",
        body: JSON.stringify({ email: forgotPassword.email }),
      })

      const data = await response.json()

      if (data.success) {
        setForgotPassword(prev => ({
          ...prev,
          success: true,
          message: data.message,
          email: "" // Clear email for security
        }))

        toast("📧 Reset Link Sent", {
          description: "Check your email for password reset instructions.",
          duration: 5000,
        })
      } else {
        setForgotPassword(prev => ({ 
          ...prev, 
          error: data.message 
        }))
        
        toast("❌ Request Failed", {
          description: data.message,
          duration: 4000,
        })
      }
    } catch (error) {
      setForgotPassword(prev => ({ 
        ...prev, 
        error: "Network error. Please check your connection and try again." 
      }))
      
      toast("⚠️ Connection Error", {
        description: "Please check your internet connection.",
        duration: 4000,
      })
    } finally {
      setForgotPassword(prev => ({ 
        ...prev, 
        loading: false 
      }))
    }
  }

  const resetForgotPasswordForm = () => {
    setForgotPassword({
      email: "",
      loading: false,
      error: "",
      success: false,
      message: ""
    })
  }

  const handleForgotPasswordModalChange = (open: boolean) => {
    setForgotPasswordOpen(open)
    if (!open) {
      // Reset form when modal closes
      setTimeout(() => {
        resetForgotPasswordForm()
      }, 200) // Small delay to allow modal animation
    }
  }

  return (
    <div 
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{
        backgroundImage: "url('/Logo.png')",
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      <div className="absolute inset-0 bg-black bg-opacity-50 backdrop-blur-sm"></div> {/* Overlay for blur and dimming */}
      <Card className="w-full max-w-md relative z-10"> {/* Ensure card is above the background */}
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="p-3 bg-amber-100 rounded-full">
              <Image 
                src="/Logo.png" 
                alt="Siri Art Jewellers Logo" 
                width={32} 
                height={32} 
                className="h-8 w-8" 
              />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold text-gray-900">Siri Art Jewellers</CardTitle>
          <CardDescription>Sign in to access the billing system</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="Enter your email"
              />
            </div>

            {/* Password with toggle */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <Label htmlFor="password">Password</Label>
                <Dialog open={forgotPasswordOpen} onOpenChange={handleForgotPasswordModalChange}>
                  <DialogTrigger asChild>
                    <Button 
                      variant="link" 
                      className="p-0 h-auto text-sm text-amber-600 hover:text-amber-800"
                    >
                      Forgot Password?
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <Mail className="h-5 w-5 text-amber-600" />
                        Reset Password
                      </DialogTitle>
                      <DialogDescription>
                        {forgotPassword.success 
                          ? "Check your email for reset instructions"
                          : "Enter your email address to receive a password reset link"
                        }
                      </DialogDescription>
                    </DialogHeader>

                    {forgotPassword.success ? (
                      // Success State
                      <div className="space-y-4">
                        <div className="flex items-center justify-center p-6">
                          <div className="text-center space-y-3">
                            <div className="mx-auto flex items-center justify-center w-12 h-12 bg-green-100 rounded-full">
                              <CheckCircle className="w-6 h-6 text-green-600" />
                            </div>
                            <div>
                              <h3 className="text-lg font-medium text-gray-900">Email Sent!</h3>
                              <p className="text-sm text-gray-600 mt-1">
                                {forgotPassword.message}
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={resetForgotPasswordForm}
                            className="flex-1"
                          >
                            <ArrowLeft className="w-4 h-4 mr-2" />
                            Send Another
                          </Button>
                          <Button
                            type="button"
                            onClick={() => setForgotPasswordOpen(false)}
                            className="flex-1"
                          >
                            Close
                          </Button>
                        </div>
                      </div>
                    ) : (
                      // Form State
                      <form onSubmit={handleForgotPassword} className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="forgot-email">Email Address</Label>
                          <Input
                            id="forgot-email"
                            type="email"
                            value={forgotPassword.email}
                            onChange={(e) => setForgotPassword(prev => ({ 
                              ...prev, 
                              email: e.target.value, 
                              error: "" 
                            }))}
                            placeholder="Enter your email address"
                            disabled={forgotPassword.loading}
                            className="w-full"
                          />
                        </div>

                        {forgotPassword.error && (
                          <Alert variant="destructive">
                            <AlertTriangle className="h-4 w-4" />
                            <AlertDescription>{forgotPassword.error}</AlertDescription>
                          </Alert>
                        )}

                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setForgotPasswordOpen(false)}
                            disabled={forgotPassword.loading}
                            className="flex-1"
                          >
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            disabled={forgotPassword.loading || !forgotPassword.email}
                            className="flex-1"
                          >
                            {forgotPassword.loading ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                                Sending...
                              </>
                            ) : (
                              <>
                                <Mail className="w-4 h-4 mr-2" />
                                Send Link
                              </>
                            )}
                          </Button>
                        </div>
                      </form>
                    )}
                  </DialogContent>
                </Dialog>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-3 flex items-center text-gray-500 hover:text-gray-700 focus:outline-none"
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Submit */}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>

          {/* Additional Links */}
          <div className="mt-6 text-center">
            <p className="text-sm text-gray-600">
              Having trouble signing in?{" "}
              <Dialog open={forgotPasswordOpen} onOpenChange={handleForgotPasswordModalChange}>
                <DialogTrigger asChild>
                  <Button variant="link" className="p-0 h-auto text-sm text-amber-600 hover:text-amber-800">
                    Reset your password
                  </Button>
                </DialogTrigger>
              </Dialog>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
