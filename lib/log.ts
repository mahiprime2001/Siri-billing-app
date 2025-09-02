'use server';

import fs from 'fs/promises';
import path from 'path';

const LOG_FILE_PATH = path.join(process.cwd(), 'logs', 'events.log');

export type LogEventType = "USER_LOGIN" | "BILL_CREATED" | "OTHER_EVENT" | "USER_LOGOUT" | "USER_UNGRACEFUL_LOGOUT";

interface LogEntry {
  timestamp: string;
  eventType: LogEventType;
  userId: string;
  details?: Record<string, any>;
}

export async function logEvent(
  eventType: LogEventType,
  userId: string,
  details?: Record<string, any>
): Promise<void> {
  const logEntry: LogEntry = {
    timestamp: new Date().toISOString(),
    eventType,
    userId,
    details,
  };

  const logMessage = JSON.stringify(logEntry) + '\n';

  try {
    // Ensure the logs directory exists
    await fs.mkdir(path.dirname(LOG_FILE_PATH), { recursive: true });
    await fs.appendFile(LOG_FILE_PATH, logMessage);
    console.log(`Log event recorded: ${eventType} by user ${userId}`);
  } catch (error) {
    console.error('Failed to write log event:', error);
  }
}
