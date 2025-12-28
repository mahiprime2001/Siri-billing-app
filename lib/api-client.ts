// lib/api-client.ts
import { toast } from "sonner";
import { authManager } from "./auth";

const FLASK_BASE_URL = "http://localhost:8080";
const MAX_RETRIES = 2; // Retry twice for token issues

export async function apiClient(
  path: string, 
  options: RequestInit = {}, 
  retryCount = 0
): Promise<Response> {
  const url = `${FLASK_BASE_URL}${path}`;
  
  // ✅ Get token with retry delay on first attempt
  let token = authManager.getToken();
  
  // ✅ If no token and first attempt, wait a bit
  if (!token && retryCount === 0) {
    console.warn('⚠️ [API-CLIENT] No token on first attempt, waiting 100ms');
    await new Promise(resolve => setTimeout(resolve, 100));
    token = authManager.getToken();
  }
  
  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  
  // ✅ Add Authorization header if token exists
  if (token) {
    // Validate token format before using it
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) {
      console.error(`❌ [API-CLIENT] Invalid token format: ${tokenParts.length} parts (expected 3)`);
      console.error(`❌ [API-CLIENT] Token: ${token.substring(0, 20)}...`);
      
      // Clear corrupted token
      authManager.clearAuth();
      
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
      
      throw new Error('Invalid token format');
    }
    
    defaultHeaders["Authorization"] = `Bearer ${token}`;
  } else {
    console.warn('⚠️ [API-CLIENT] No valid token available after wait');
  }

  const defaultOptions: RequestInit = {
    headers: defaultHeaders,
    credentials: "include",
    ...options,
  };

  try {
    const response = await fetch(url, defaultOptions);

    // ✅ Handle 401 errors
    if (response.status === 401) {
      let message = "Session expired";
      try {
        const data = await response.json();
        if (data && typeof data === "object" && "message" in data) {
          message = (data as { message?: string }).message || message;
        }
      } catch {
        // Ignore JSON parse errors
      }

      console.error(`❌ [API-CLIENT] 401 Unauthorized on ${path}`);
      console.error(`❌ [API-CLIENT] Message: ${message}`);
      console.error(`❌ [API-CLIENT] Token present: ${!!token}`);
      console.error(`❌ [API-CLIENT] Retry count: ${retryCount}/${MAX_RETRIES}`);
      
      // ✅ Retry with fresh token
      if (retryCount < MAX_RETRIES) {
        console.log(`🔄 [API-CLIENT] Retrying request (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        
        // Wait longer on subsequent retries
        const waitTime = 100 * (retryCount + 1);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Get fresh token
        const freshToken = authManager.getToken();
        console.log(`🔄 [API-CLIENT] Fresh token obtained: ${!!freshToken}`);
        
        return apiClient(path, options, retryCount + 1);
      }
      
      // ✅ Max retries reached, show error and redirect
      toast.error(message);
      authManager.clearAuth();
      
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        console.log('❌ [API-CLIENT] Max retries reached, redirecting to login');
        window.location.href = '/login';
      }
      
      return response;
    }

    return response;
  } catch (error) {
    console.error("❌ [API-CLIENT] Network error:", error);
    
    // ✅ Retry on network errors too
    if (retryCount < MAX_RETRIES) {
      console.log(`🔄 [API-CLIENT] Retrying after network error (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, 200));
      return apiClient(path, options, retryCount + 1);
    }
    
    throw error;
  }
}
