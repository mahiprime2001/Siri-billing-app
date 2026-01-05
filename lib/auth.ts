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

// Safe localStorage wrapper that avoids accessing `window`/`localStorage` during SSR
const safeStorage = {
  isAvailable(): boolean {
    try {
      return typeof window !== 'undefined' && !!window.localStorage
    } catch (e) {
      return false
    }
  },
  getItem(key: string): string | null {
    try {
      if (!this.isAvailable()) return null
      return window.localStorage.getItem(key)
    } catch (e) {
      return null
    }
  },
  setItem(key: string, value: string) {
    try {
      if (!this.isAvailable()) return
      window.localStorage.setItem(key, value)
    } catch (e) {
      // noop
    }
  },
  removeItem(key: string) {
    try {
      if (!this.isAvailable()) return
      window.localStorage.removeItem(key)
    } catch (e) {
      // noop
    }
  }
}

export const authManager = {
  setAuth(token: string, user: User) {
    try {
      if (!token || !user) return
      safeStorage.setItem(TOKEN_KEY, token)
      safeStorage.setItem(USER_KEY, JSON.stringify(user))
      this.updateActivity()
    } catch (error) {
      // ignore in non-browser environments
    }
  },

  getToken(): string | null {
    try {
      if (this.isTokenExpired()) {
        this.clearAuth()
        return null
      }
      this.updateActivity()
      const token = safeStorage.getItem(TOKEN_KEY)
      if (token) {
        const parts = token.split('.')
        if (parts.length !== 3) {
          this.clearAuth()
          return null
        }
      }
      return token
    } catch (error) {
      return null
    }
  },

  getUser(): User | null {
    try {
      const userStr = safeStorage.getItem(USER_KEY)
      if (!userStr) return null
      return JSON.parse(userStr)
    } catch (error) {
      return null
    }
  },

  updateActivity() {
    try {
      safeStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString())
    } catch (error) {
      // noop
    }
  },

  isTokenExpired(): boolean {
    try {
      const lastActivity = safeStorage.getItem(LAST_ACTIVITY_KEY)
      if (!lastActivity) return true
      const timeSinceActivity = Date.now() - parseInt(lastActivity, 10)
      return timeSinceActivity > IDLE_TIMEOUT
    } catch (error) {
      return true
    }
  },

  clearAuth() {
    try {
      safeStorage.removeItem(TOKEN_KEY)
      safeStorage.removeItem(USER_KEY)
      safeStorage.removeItem(LAST_ACTIVITY_KEY)
    } catch (error) {
      // noop
    }
  },

  isAuthenticated(): boolean {
    return !!this.getToken()
  },

  getTimeUntilExpiry(): number {
    try {
      const lastActivity = safeStorage.getItem(LAST_ACTIVITY_KEY)
      if (!lastActivity) return 0
      const timeSinceActivity = Date.now() - parseInt(lastActivity, 10)
      const remaining = IDLE_TIMEOUT - timeSinceActivity
      return remaining > 0 ? remaining : 0
    } catch (error) {
      return 0
    }
  }
}
