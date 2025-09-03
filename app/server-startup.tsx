import { replayPendingSyncEvents, updateUserSessionOnStartup } from '@/lib/sync';
import { extractAllData } from '@/lib/script-functions';
import { logEvent, LogEventType } from '@/lib/log'; // Import logEvent and LogEventType

// This component will run only on the server
export default async function ServerStartup() {
  console.log('Running server startup tasks...');
  try {
    // Extract initial data (can be run periodically or on demand)
    await extractAllData();

    // Update user sessions on startup
    await updateUserSessionOnStartup();

    // Replay any pending sync events
    console.log('Attempting to replay pending sync events...');
    await replayPendingSyncEvents();
    console.log('Finished replaying pending sync events.');

    console.log('Server startup tasks completed.');
  } catch (error: any) {
    await logEvent("OTHER_EVENT", "system", {
      message: 'Error during server startup tasks',
      error: error.message,
    });
  }

  return null; // This component doesn't render any UI
}
