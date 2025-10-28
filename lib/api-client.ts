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
