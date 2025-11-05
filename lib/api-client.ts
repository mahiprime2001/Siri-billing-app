import { toast } from "sonner";

const FLASK_BASE_URL = 'http://localhost:8080';

export async function apiClient(path: string, options: RequestInit = {}) {
  const url = `${FLASK_BASE_URL}${path}`;
  
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  const defaultOptions: RequestInit = {
    headers: defaultHeaders,
    credentials: 'include', // CRITICAL: Send session cookies
    ...options,
  };

  try {
    const response = await fetch(url, defaultOptions);

    // Check for 401 (authentication required)
    if (response.status === 401) {
      const data = await response.json();
      
      // Only prevent redirect if on login page
      if (typeof window !== 'undefined' && window.location.pathname === '/login') {
        console.warn("401 received on login page, not redirecting");
        throw new Error(data.message || "Authentication required");
      }

      // Prevent redirect if logging out
      if (typeof window !== 'undefined' && window.isLoggingOut) {
        console.warn("401 received during logout, not redirecting");
        throw new Error(data.message || "Session expired");
      }

      // Show toast and redirect to login
      toast.error(data.message || "Session expired");
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
