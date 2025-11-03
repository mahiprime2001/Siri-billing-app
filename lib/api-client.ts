import { toast } from "sonner";

const FLASK_BASE_URL = 'http://127.0.0.1:8080'; // Hardcoded Flask server URL

export async function apiClient(path: string, options: RequestInit = {}) {
  const url = `${FLASK_BASE_URL}${path}`;
  const sessionToken = typeof window !== 'undefined' ? localStorage.getItem('session_token') : null;

  const defaultOptions: RequestInit = {
    // credentials: 'include', // No longer needed with Authorization header
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken && { 'Authorization': `Bearer ${sessionToken}` }), // Add Authorization header
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(url, defaultOptions);

    // ✅ Check for 401 (authentication required)
    if (response.status === 401) {
      const data = await response.json();
      
      // Check if we just logged in successfully
      const justLoggedIn = typeof window !== 'undefined' && localStorage.getItem('just_logged_in') === 'true';

      if (justLoggedIn) {
        // If just logged in, clear the flag and don't redirect immediately.
        // This gives the app a chance to make subsequent authenticated calls.
        localStorage.removeItem('just_logged_in');
        console.warn("401 received shortly after login. Preventing immediate redirect.");
        throw new Error(data.message || "Session expired, but redirect prevented due to recent login.");
      }

      // Prevent redirect if already logging out or on login page
      if (typeof window !== 'undefined' && (window.isLoggingOut || window.location.pathname === '/login')) {
        console.warn("401 received but preventing redirect due to isLoggingOut or already on login page.");
        throw new Error(data.message || "Session expired, but redirect prevented.");
      }

      // Show toast and redirect to login
      toast.error(data.message || "Session expired");
      
      // Clear any old localStorage data
      localStorage.clear();
      
      // Redirect to login
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
      
      throw new Error(data.message);
    }

    return response;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}
