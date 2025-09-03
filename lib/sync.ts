import getPool from './db'; // Assuming lib/db.ts exports the mysql2 pool
import { promises as fs } from 'fs';
import path from 'path';
import { logEvent, LogEventType } from './log'; // Import logEvent and LogEventType

const JSON_DATA_DIR = path.join(process.cwd(), 'data', 'json');
const PENDING_SYNC_FILE = path.join(JSON_DATA_DIR, 'pending_sync.json');

export type ChangeType = "USER_LOGIN" | "BILL_CREATED" | "PRODUCT_UPDATED" | "CUSTOMER_UPDATED" | "OTHER_CHANGE" | "USER_LOGOUT" | "USER_UNGRACEFUL_LOGOUT" | "APP_STARTUP";

// Helper function to strip sensitive data
function sanitizeChangeData(changeType: ChangeType, data: Record<string, any>): Record<string, any> {
  const sanitizedData = { ...data };

  // Define sensitive keys that should be removed or masked
  const sensitiveKeys = ['password', 'secret', 'token', 'jwt', 'privateKey', 'apiKey'];

  for (const key of sensitiveKeys) {
    if (sanitizedData.hasOwnProperty(key)) {
      sanitizedData[key] = '[REDACTED]'; // Mask sensitive data
    }
  }

  // Specific sanitization based on changeType if needed
  if (changeType === "USER_LOGIN" || changeType === "USER_UNGRACEFUL_LOGOUT") {
    // Ensure no full user objects are logged, only IDs or non-sensitive info
    if (sanitizedData.user && typeof sanitizedData.user === 'object') {
      const { password, ...userWithoutSensitiveInfo } = sanitizedData.user;
      sanitizedData.user = userWithoutSensitiveInfo;
    }
  }

  return sanitizedData;
}

export async function logSyncEvent(
  changeType: ChangeType,
  changeData: Record<string, any>
): Promise<void> {
  let connection;
  const syncTime = new Date(); // Moved declaration outside try block
  const sanitizedData = sanitizeChangeData(changeType, changeData); // Moved declaration outside try block
    const changeDataJson = JSON.stringify(sanitizedData); // Moved declaration outside try block

  try {
    const pool = getPool(); // Get the pool at runtime
    connection = await pool.getConnection();

    await connection.query(
      "INSERT INTO sync_table (sync_time, change_type, change_data) VALUES (?, ?, ?)",
      [syncTime, changeType, changeDataJson]
    );
    console.log(`Sync event recorded: ${changeType}`);
  } catch (error: any) { // Re-added 'any' for easier error handling, will log to file
    await logEvent("OTHER_EVENT", "system", {
      message: 'Failed to write sync event to DB',
      error: error.message,
      changeType,
      changeData: sanitizedData,
    });
    // If DB is offline, write to a local JSON file
    // Check if error is an object and has a 'code' property
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ENOTFOUND')) { // Common DB connection errors
      console.log('Database connection failed. Writing sync event to pending_sync.json');
      await writePendingSyncEvent({ syncTime: syncTime, changeType: changeType, changeData: sanitizedData });
    } else {
      // This case is already covered by the logEvent above, but keeping console.error for immediate visibility
      console.error('An unexpected error occurred during sync event logging:', error);
    }
  } finally {
    if (connection) connection.release();
  }
}

async function writePendingSyncEvent(event: { syncTime: Date; changeType: ChangeType; changeData: Record<string, any> }): Promise<void> {
  try {
    let pendingEvents: any[] = [];
    try {
      const data = await fs.readFile(PENDING_SYNC_FILE, 'utf8');
      pendingEvents = JSON.parse(data);
    } catch (readError: any) {
      if (readError.code !== 'ENOENT') { // Ignore file not found error
        await logEvent("OTHER_EVENT", "system", {
          message: 'Error reading pending_sync.json',
          error: readError.message,
          filePath: PENDING_SYNC_FILE,
        });
      }
    }
    pendingEvents.push(event);
    await fs.writeFile(PENDING_SYNC_FILE, JSON.stringify(pendingEvents, null, 2), 'utf8');
    console.log('Sync event written to pending_sync.json');
  } catch (error: any) {
    await logEvent("OTHER_EVENT", "system", {
      message: 'Failed to write pending sync event to file',
      error: error.message,
      filePath: PENDING_SYNC_FILE,
      event: event,
    });
  }
}

export async function replayPendingSyncEvents(): Promise<void> {
  let connection;
  try {
    const data = await fs.readFile(PENDING_SYNC_FILE, 'utf8');
    let pendingEvents: any[] = JSON.parse(data);

    if (pendingEvents.length === 0) {
      console.log('No pending sync events to replay.');
      return;
    }

    const pool = getPool(); // Get the pool at runtime
    connection = await pool.getConnection();
    console.log(`Attempting to replay ${pendingEvents.length} pending sync events...`);

    const successfullyReplayed: any[] = [];
    const failedToReplay: any[] = [];

    for (const event of pendingEvents) {
      try {
        await connection.query(
          "INSERT INTO sync_table (sync_time, change_type, change_data) VALUES (?, ?, ?)",
          [event.syncTime, event.changeType, JSON.stringify(event.changeData)]
        );
        successfullyReplayed.push(event);
      } catch (eventError: any) {
        const userId = event.changeData?.userId || "system";
        await logEvent("OTHER_EVENT", userId, {
          message: `Failed to replay event ${event.changeType} at ${event.syncTime}`,
          error: eventError.message,
          event: event,
        });
        failedToReplay.push(event);
      }
    }

    // Overwrite pending_sync.json with only the events that failed to replay
    await fs.writeFile(PENDING_SYNC_FILE, JSON.stringify(failedToReplay, null, 2), 'utf8');

    if (successfullyReplayed.length > 0) {
      console.log(`Successfully replayed ${successfullyReplayed.length} sync events.`);
    }
    if (failedToReplay.length > 0) {
      console.warn(`${failedToReplay.length} sync events failed to replay and remain in pending_sync.json.`);
    } else {
      console.log('All pending sync events replayed successfully. pending_sync.json is now empty.');
    }

  } catch (error: any) {
    if (error.code === 'ENOENT') {
      console.log('No pending_sync.json file found. No events to replay.');
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ENOTFOUND') {
      console.warn('Database is still offline. Cannot replay pending sync events at this time.');
    } else {
      await logEvent("OTHER_EVENT", "system", {
        message: 'Failed to replay pending sync events',
        error: error.message,
      });
    }
  } finally {
    if (connection) connection.release();
  }
}


export async function fetchDataAndSaveToJson(tableName: string, fileName: string): Promise<void> {
  let connection;
  try {
    const pool = getPool(); // Get the pool at runtime
    connection = await pool.getConnection();
    const [rows] = await connection.query<any[]>(`SELECT * FROM ${tableName}`);
    await fs.writeFile(path.join(JSON_DATA_DIR, fileName), JSON.stringify(rows, null, 2), 'utf8');
    console.log(`Data from ${tableName} saved to ${fileName}`);
  } catch (error: any) {
    await logEvent("OTHER_EVENT", "system", {
      message: `Failed to fetch and save data for ${tableName}`,
      error: error.message,
      tableName,
      fileName,
    });
  } finally {
    if (connection) connection.release();
  }
}

export async function updateUserSessionOnStartup(): Promise<void> {
  let connection;
  try {
    const pool = getPool(); // Get the pool at runtime
    connection = await pool.getConnection();
    const startupTime = new Date();

    // 1. Log APP_STARTUP event
    await logSyncEvent("APP_STARTUP", { message: "Application started up" });

    // 2. Find users who were logged in at the time of the crash/shutdown
    const [users] = await connection.query<any[]>(
      `SELECT id, lastLogin, totalSessionDuration FROM Users WHERE lastLogin IS NOT NULL AND (lastLogout IS NULL OR lastLogin > lastLogout)`
    );

    for (const user of users) {
      const lastLoginTime = new Date(user.lastLogin);
      const sessionDurationMs = startupTime.getTime() - lastLoginTime.getTime();
      const sessionDurationSeconds = Math.floor(sessionDurationMs / 1000);

      // Update user's total session duration and lastLogout
      await connection.query(
        `UPDATE Users SET totalSessionDuration = totalSessionDuration + ?, lastLogout = ? WHERE id = ?`,
        [sessionDurationSeconds, startupTime, user.id]
      );

      // Log an ungraceful logout event
      await logSyncEvent(
        "USER_UNGRACEFUL_LOGOUT",
        {
          userId: user.id,
          lastLogin: user.lastLogin,
          ungracefulLogoutTime: startupTime,
          sessionDuration: sessionDurationSeconds,
        }
      );
      console.log(`User ${user.id} session updated due to ungraceful logout.`);
    }
    console.log('User sessions updated on application startup.');
  } catch (error: any) {
    await logEvent("OTHER_EVENT", "system", {
      message: 'Failed to update user sessions on startup',
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}
// A small change to trigger a new push
