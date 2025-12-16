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
import { apiClient } from "@/lib/api-client"

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
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await fetch('http://localhost:8080/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })

      const data = await response.json()

      if (response.ok && data.auth_ok) {
        toast("Login Successful", {
          description: "Welcome back!",
          duration: 2000,
        })

        // ✅ Use window.location for hard navigation (ensures cookies are set properly)
        // This avoids Next.js HMR issues in development
        window.location.href = '/billing'
      } else {
        setError(data.message || 'Login failed')
        toast("Login Failed", {
          description: data.message || "Invalid credentials.",
          duration: 3000,
        })
      }
    } catch (error) {
      console.error('Login error:', error)
      setError('An error occurred during login')
      toast("Error", {
        description: "Something went wrong. Please try again.",
        duration: 3000,
      })
    } finally {
      setLoading(false)
    }
  }

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
          email: ""
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
      setTimeout(() => {
        resetForgotPasswordForm()
      }, 200)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md shadow-2xl">
        <CardHeader className="space-y-4 text-center pb-6">
          <div className="mx-auto w-24 h-24 relative">
            <Image
              src="/logo.png"
              alt="Siri Art Jewellers Logo"
              fill
              className="object-contain"
              priority
            />
          </div>
          <div>
            <CardTitle className="text-3xl font-bold text-gray-900">
              Siri Art Jewellers
            </CardTitle>
            <CardDescription className="text-base mt-2">
              Sign in to access the billing system
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="Enter your email"
                  className="pl-10 h-11"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="text-sm font-medium">
                  Password
                </Label>
                <Dialog open={forgotPasswordOpen} onOpenChange={handleForgotPasswordModalChange}>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className="text-sm text-primary hover:underline focus:outline-none"
                    >
                      Forgot Password?
                    </button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2">
                        <Mail className="h-5 w-5 text-primary" />
                        Reset Password
                      </DialogTitle>
                      <DialogDescription>
                        {forgotPassword.success
                          ? "Check your email for reset instructions"
                          : "Enter your email address to receive a password reset link"}
                      </DialogDescription>
                    </DialogHeader>

                    {forgotPassword.success ? (
                      <div className="space-y-4 py-4">
                        <Alert className="bg-green-50 border-green-200">
                          <CheckCircle className="h-4 w-4 text-green-600" />
                          <AlertDescription className="text-green-800">
                            {forgotPassword.message}
                          </AlertDescription>
                        </Alert>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={resetForgotPasswordForm}
                            className="flex-1"
                          >
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
                      <form onSubmit={handleForgotPassword} className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="forgot-email">Email Address</Label>
                          <Input
                            id="forgot-email"
                            type="email"
                            value={forgotPassword.email}
                            onChange={(e) =>
                              setForgotPassword(prev => ({
                                ...prev,
                                email: e.target.value,
                                error: ""
                              }))
                            }
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

                        <div className="flex gap-2 pt-2">
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
                            disabled={forgotPassword.loading}
                            className="flex-1"
                          >
                            {forgotPassword.loading ? (
                              <>
                                <Mail className="mr-2 h-4 w-4 animate-pulse" />
                                Sending...
                              </>
                            ) : (
                              <>
                                <Mail className="mr-2 h-4 w-4" />
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
                  className="pr-10 h-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-3 flex items-center text-gray-500 hover:text-gray-700 focus:outline-none"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full h-11" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-600">
            Having trouble signing in?{" "}
            <button
              type="button"
              onClick={() => setForgotPasswordOpen(true)}
              className="text-primary hover:underline"
            >
              Reset your password
            </button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
