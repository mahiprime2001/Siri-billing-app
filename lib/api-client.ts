import { toast } from "sonner";

const FLASK_BASE_URL = "http://localhost:8080";

export async function apiClient(path: string, options: RequestInit = {}) {
  const url = `${FLASK_BASE_URL}${path}`;

  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const defaultOptions: RequestInit = {
    headers: defaultHeaders,
    credentials: "include", // CRITICAL: Send session cookies
    ...options,
  };

  try {
    const response = await fetch(url, defaultOptions);

    // Check for 401 (authentication required)
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

      toast.error(message);
      // Return the 401 response so caller can decide what to do
      return response;
    }

    return response;
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
}
