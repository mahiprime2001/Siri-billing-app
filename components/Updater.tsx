'use client';

import { useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';

interface DownloadProgress {
  chunkLength: number;
  contentLength: number | null;
}

export default function Updater() {
  const currentUpdate = useRef<Update | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [downloadInProgress, setDownloadInProgress] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    notes: string;
  } | null>(null);
  const hasChecked = useRef(false);

  useEffect(() => {
    // Prevent double-checking in React strict mode
    if (hasChecked.current) return;
    hasChecked.current = true;

    const checkForUpdates = async () => {
      try {
        console.log('🔍 Checking for updates...');
        
        const update = await check();

        console.log('📦 Update check result:', {
          updateFound: !!update,
          available: update?.available,
          version: update?.version,
        });

        if (!update) {
          console.log('❌ No update object returned');
          return;
        }

        if (!update.available) {
          console.log('✅ No updates available - you are on the latest version');
          return;
        }

        console.log('🎉 Update available!', {
          currentVersion: 'Current',
          newVersion: update.version,
          notes: update.body,
        });

        currentUpdate.current = update;
        setUpdateAvailable(true);
        setUpdateInfo({
          version: update.version,
          notes: update.body || 'No release notes available.',
        });

        // Show update prompt immediately
        handleUpdatePrompt();
      } catch (error) {
        console.error('❌ Failed to check for updates:', error);
        console.error('Error details:', {
          message: error instanceof Error ? error.message : String(error),
          type: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    };

    // Check for updates 2 seconds after app loads
    const timer = setTimeout(() => {
      console.log('⏰ Starting update check...');
      checkForUpdates();
    }, 2000);

    // Optional: Check again every 30 minutes
    const interval = setInterval(() => {
      console.log('⏰ Periodic update check triggered');
      checkForUpdates();
    }, 30 * 60 * 1000);

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);

  async function handleUpdatePrompt() {
    if (!currentUpdate.current || !updateInfo) return;

    try {
      const shouldUpdate = await ask(
        `A new version ${updateInfo.version} is available!\n\nRelease notes:\n${updateInfo.notes}\n\nWould you like to install it now? (App will restart after update)`,
        {
          title: 'Update Available!',
          kind: 'info',
          okLabel: 'Install Update',
          cancelLabel: 'Later',
        }
      );

      if (shouldUpdate && !downloadInProgress) {
        console.log('✅ User accepted update');
        await downloadAndInstallUpdate();
      } else {
        console.log('⏭️ User postponed update');
        setUpdateAvailable(false);
      }
    } catch (error) {
      console.error('❌ Update prompt failed:', error);
    }
  }

  async function downloadAndInstallUpdate() {
    if (!currentUpdate.current) return;

    try {
      setDownloadInProgress(true);
      setDownloadProgress(0);

      console.log('⬇️ Starting download and installation...');

      await currentUpdate.current.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            console.log('📥 Download started');
            setDownloadProgress(0);
            break;

          case 'Progress':
            const progress = event.data as DownloadProgress;
            if (progress.contentLength) {
              const percent = Math.round(
                (progress.chunkLength / progress.contentLength) * 100
              );
              setDownloadProgress(percent);
              console.log(`📊 Download progress: ${percent}%`);
            }
            break;

          case 'Finished':
            console.log('✅ Download finished, installing...');
            setDownloadProgress(100);
            break;
        }
      });

      console.log('✅ Update installed successfully');

      await message('Update installed successfully! The app will now restart.', {
        title: 'Update Complete',
        kind: 'info',
        okLabel: 'Restart Now',
      });

      console.log('🔄 Restarting application...');
      await new Promise(resolve => setTimeout(resolve, 500));
      await relaunch();

    } catch (error) {
      console.error('❌ Update installation failed:', error);
      
      await message(
        `Update download failed: ${error instanceof Error ? error.message : String(error)}\n\nPlease try again later.`,
        {
          kind: 'error',
          title: 'Update Failed',
        }
      );

      setDownloadInProgress(false);
      setDownloadProgress(0);
    }
  }

  // Show download progress UI
  if (downloadInProgress) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-md w-full mx-4">
          <h3 className="text-lg font-semibold mb-4">Downloading Update...</h3>
          <div className="mb-4">
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2 text-center">
              {downloadProgress}% complete
            </p>
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
            Please don't close the application
          </p>
        </div>
      </div>
    );
  }

  // Optional: Show persistent banner if dialog is dismissed
  if (updateAvailable && updateInfo) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-blue-600 text-white px-4 py-3 shadow-lg">
        <div className="max-w-7xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-1">
            <div>
              <div className="font-semibold">Update Available!</div>
              <div className="text-sm opacity-90">Version {updateInfo.version}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={downloadAndInstallUpdate}
              className="bg-white text-blue-600 px-4 py-2 rounded-md hover:bg-gray-100 transition-colors text-sm font-medium"
            >
              Install Now
            </button>
            <button
              onClick={() => setUpdateAvailable(false)}
              className="bg-transparent border border-white px-4 py-2 rounded-md hover:bg-blue-700 transition-colors text-sm font-medium"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
