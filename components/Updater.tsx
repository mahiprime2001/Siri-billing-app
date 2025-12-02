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

  useEffect(() => {
    // Check for updates on component mount (app load)
    if (window.__TAURI__) { // Only check for updates if running in a Tauri environment
      checkForUpdates();
    }
  }, []);

  async function checkForUpdates() {
    try {
      const update = await check();
      
      if (!update || !update.available) {
        console.log('No updates available.');
        return;
      }

      currentUpdate.current = update;
      setUpdateAvailable(true);
      setUpdateInfo({
        version: update.version,
        notes: update.body || 'No release notes available.',
      });

      // Automatically prompt user about update
      handleUpdateAvailable();
    } catch (error) {
      console.error('Failed to check for updates:', error);
    }
  }

  async function handleUpdateAvailable() {
    if (!updateAvailable || !currentUpdate.current) return;

    try {
      const shouldUpdate = await ask(
        `A new version ${updateInfo?.version} is available!\n\nRelease notes:\n${updateInfo?.notes}\n\nWould you like to install it now? (App will restart after update)`,
        {
          title: 'Update Available!',
          kind: 'info',
          okLabel: 'Install Update',
          cancelLabel: 'Later',
        }
      );

      if (shouldUpdate && !downloadInProgress) {
        await downloadAndInstallUpdate();
      } else {
        // User declined, hide the update notification
        setUpdateAvailable(false);
      }
    } catch (error) {
      console.error('Prompt failed:', error);
    }
  }

  async function downloadAndInstallUpdate() {
    if (!currentUpdate.current) return;

    try {
      setDownloadInProgress(true);
      setDownloadProgress(0);

      // Download and install with progress callback
      await currentUpdate.current.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            console.log('Download started');
            setDownloadProgress(0);
            break;
          case 'Progress':
            const progress = event.data as DownloadProgress;
            if (progress.contentLength) {
              const percent = Math.round(
                (progress.chunkLength / progress.contentLength) * 100
              );
              setDownloadProgress(percent);
              console.log(`Download progress: ${percent}%`);
            }
            break;
          case 'Finished':
            console.log('Download finished, installing...');
            setDownloadProgress(100);
            break;
        }
      });

      // Installation complete, show success message
      await message('Update installed successfully! The app will now restart.', {
        title: 'Update Complete',
        kind: 'info',
        okLabel: 'Restart Now',
      });

      // Restart the app
      await relaunch();
    } catch (error) {
      console.error('Update installation failed:', error);
      await message('Update download failed. Please try again later.', {
        kind: 'error',
        title: 'Update Failed',
      });
      setDownloadInProgress(false);
      setDownloadProgress(0);
    }
  }

  // Render progress UI if download is in progress
  if (downloadInProgress) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Downloading Update...
            </h3>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 mb-4">
              <div
                className="bg-blue-600 h-4 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              ></div>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {downloadProgress}% complete
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-500 mt-2">
              Please don't close the application
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Render update notification banner
  if (updateAvailable && updateInfo) {
    return (
      <div className="fixed bottom-4 right-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 rounded-lg shadow-2xl max-w-sm z-50 animate-slide-in">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <svg
                className="w-6 h-6 text-yellow-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <p className="font-semibold text-lg">Update Available!</p>
            </div>
            <button
              onClick={() => setUpdateAvailable(false)}
              className="text-white hover:text-gray-200 transition-colors"
              aria-label="Close"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          </div>
          
          <div>
            <p className="text-sm font-medium">Version {updateInfo.version}</p>
            <p className="text-xs text-blue-100 mt-1 line-clamp-2">
              {updateInfo.notes}
            </p>
          </div>

          <div className="flex gap-2">
            <button
              onClick={downloadAndInstallUpdate}
              disabled={downloadInProgress}
              className="bg-white text-blue-600 px-4 py-2 rounded-md hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed flex-1 font-medium transition-colors text-sm"
            >
              Install Now
            </button>
            <button
              onClick={() => setUpdateAvailable(false)}
              className="bg-transparent border border-white px-4 py-2 rounded-md hover:bg-blue-800 transition-colors text-sm font-medium"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    );
  }

  // No update available, render nothing
  return null;
}
