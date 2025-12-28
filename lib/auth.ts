// lib/auth.ts
const TOKEN_KEY = 'access_token'
const USER_KEY = 'user'
const LAST_ACTIVITY_KEY = 'last_activity'
const IDLE_TIMEOUT = 2 * 60 * 60 * 1000 // 2 hours in milliseconds

export interface User {
  id: string
  email: string
  name: string
  role?: string
}

export const authManager = {
  // Store token and user
  setAuth(token: string, user: User) {
    try {
      if (!token || !user) {
        console.error('❌ [AUTH] Cannot set auth with empty token or user')
        return
      }
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
      this.updateActivity()
      console.log('✅ [AUTH] Token and user stored successfully')
    } catch (error) {
      console.error('❌ [AUTH] Error storing auth:', error)
    }
  },

  // Get token
  getToken(): string | null {
    try {
      if (this.isTokenExpired()) {
        console.log('⏰ [AUTH] Token expired due to idle timeout')
        this.clearAuth()
        return null
      }
      this.updateActivity()
      const token = localStorage.getItem(TOKEN_KEY)
      
      // Validate token format (should be JWT with 3 parts)
      if (token) {
        const parts = token.split('.')
        if (parts.length !== 3) {
          console.error('❌ [AUTH] Invalid token format, clearing...')
          this.clearAuth()
          return null
        }
      }
      
      return token
    } catch (error) {
      console.error('❌ [AUTH] Error getting token:', error)
      return null
    }
  },

  // Get user
  getUser(): User | null {
    try {
      const userStr = localStorage.getItem(USER_KEY)
      if (!userStr) return null
      return JSON.parse(userStr)
    } catch (error) {
      console.error('❌ [AUTH] Error getting user:', error)
      return null
    }
  },

  // Update last activity timestamp
  updateActivity() {
    try {
      localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString())
    } catch (error) {
      console.error('❌ [AUTH] Error updating activity:', error)
    }
  },

  // Check if token is expired due to idle time
  isTokenExpired(): boolean {
    try {
      const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY)
      if (!lastActivity) return true

      const timeSinceActivity = Date.now() - parseInt(lastActivity, 10)
      return timeSinceActivity > IDLE_TIMEOUT
    } catch (error) {
      console.error('❌ [AUTH] Error checking expiry:', error)
      return true
    }
  },

  // Clear all auth data
  clearAuth() {
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      localStorage.removeItem(LAST_ACTIVITY_KEY)
      console.log('✅ [AUTH] Auth data cleared')
    } catch (error) {
      console.error('❌ [AUTH] Error clearing auth:', error)
    }
  },

  // Check if user is authenticated
  isAuthenticated(): boolean {
    return !!this.getToken()
  },

  // Get time remaining until expiry (in milliseconds)
  getTimeUntilExpiry(): number {
    try {
      const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY)
      if (!lastActivity) return 0

      const timeSinceActivity = Date.now() - parseInt(lastActivity, 10)
      const remaining = IDLE_TIMEOUT - timeSinceActivity
      return remaining > 0 ? remaining : 0
    } catch (error) {
      console.error('❌ [AUTH] Error getting time until expiry:', error)
      return 0
    }
  }
}
