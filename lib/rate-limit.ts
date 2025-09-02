// lib/rate-limit.ts
import { LRUCache } from 'lru-cache';

// Configuration for the rate limiter
const MAX_ATTEMPTS = 10; // Max login attempts
const WINDOW_SIZE_IN_SECONDS = 15 * 60; // 15 minutes

// Cache to store login attempts per IP address
// Using LRUCache to automatically prune old entries
const loginAttemptsCache = new LRUCache<string, { count: number; firstAttempt: number }>({
  max: 500, // Max number of IP addresses to track
  ttl: WINDOW_SIZE_IN_SECONDS * 1000, // Time to live for each entry (15 minutes)
});

export function checkRateLimit(ip: string): { allowed: boolean; remaining: number; reset: number } {
  const now = Date.now();
  let entry = loginAttemptsCache.get(ip);

  if (!entry || (now - entry.firstAttempt) > (WINDOW_SIZE_IN_SECONDS * 1000)) {
    // If no entry or window has expired, reset
    entry = { count: 0, firstAttempt: now };
    loginAttemptsCache.set(ip, entry);
  }

  const remainingAttempts = MAX_ATTEMPTS - entry.count;
  const resetTime = entry.firstAttempt + (WINDOW_SIZE_IN_SECONDS * 1000);

  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, remaining: 0, reset: resetTime };
  }

  return { allowed: true, remaining: remainingAttempts, reset: resetTime };
}

export function recordAttempt(ip: string, success: boolean) {
  let entry = loginAttemptsCache.get(ip);

  if (!entry) {
    // This should ideally not happen if checkRateLimit is called first, but as a fallback
    entry = { count: 0, firstAttempt: Date.now() };
  }

  if (!success) {
    entry.count++;
  } else {
    // On successful login, reset attempts for this IP
    entry.count = 0;
    entry.firstAttempt = Date.now(); // Reset window
  }
  loginAttemptsCache.set(ip, entry);
}

export function getRemainingAttempts(ip: string): number {
  const entry = loginAttemptsCache.get(ip);
  if (!entry || (Date.now() - entry.firstAttempt) > (WINDOW_SIZE_IN_SECONDS * 1000)) {
    return MAX_ATTEMPTS;
  }
  return Math.max(0, MAX_ATTEMPTS - entry.count);
}
