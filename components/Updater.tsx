'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';

interface DownloadProgress {
  chunkLength: number;
  contentLength: number | null;
}

interface UpdaterProps {
  currentVersion: string;
}

export default function Updater({ currentVersion }: UpdaterProps) {
  const currentUpdate = useRef<Update | null>(null);
  const [downloadInProgress, setDownloadInProgress] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const hasShownUpdateToast = useRef(false);

  // Check for updates function
  const checkForUpdates = useCallback(async (silent = false) => {
    // Don't check if download is in progress
    if (downloadInProgress) return;

    try {
      console.log('🔍 Checking for updates... Current version:', currentVersion);
      const update = await check();
      
      console.log('📦 Update check result:', update);

      if (!update) {
        console.log('❌ No update object returned');
        if (!silent) {
          toast.info('You are on the latest version', {
            duration: 3000,
          });
        }
        return;
      }

      if (!update.available) {
        console.log('✅ No updates available. Current version is latest.');
        if (!silent) {
          toast.success('You are on the latest version', {
            duration: 3000,
          });
        }
        return;
      }

      console.log('🎉 Update available!', {
        currentVersion,
        newVersion: update.version,
        body: update.body,
      });

      currentUpdate.current = update;

      // Only show toast if we haven't shown it yet for this update
      if (!hasShownUpdateToast.current) {
        hasShownUpdateToast.current = true;
        
        // Show persistent toast with action buttons
        toast.info(`Update available: v${update.version}`, {
          description: update.body || 'A new version is ready to install',
          duration: Infinity, // Keep toast visible until user acts
          action: {
            label: 'Install Now',
            onClick: () => handleInstallUpdate(),
          },
          cancel: {
            label: 'Later',
            onClick: () => {
              toast.dismiss();
              hasShownUpdateToast.current = false; // Allow showing again later
            },
          },
        });
      }
    } catch (error) {
      console.error('❌ Failed to check for updates:', error);
      if (!silent) {
        toast.error('Failed to check for updates', {
          description: 'Please check your internet connection',
          duration: 4000,
        });
      }
    }
  }, [currentVersion, downloadInProgress]);

  // Initial check on mount
  useEffect(() => {
    if (window.__TAURI__) {
      console.log('🚀 Updater mounted, checking for updates...');
      checkForUpdates(true); // Silent on first check

      // Set up periodic checking every 30 minutes
      checkIntervalRef.current = setInterval(() => {
        console.log('⏰ Periodic update check triggered');
        checkForUpdates(true); // Silent periodic checks
      }, 30 * 60 * 1000); // 30 minutes

      // Cleanup interval on unmount
      return () => {
        if (checkIntervalRef.current) {
          clearInterval(checkIntervalRef.current);
        }
      };
    }
  }, [checkForUpdates]);

  // Handle install update
  const handleInstallUpdate = async () => {
    if (!currentUpdate.current) {
      toast.error('Update information not available');
      return;
    }

    try {
      setDownloadInProgress(true);
      setDownloadProgress(0);

      toast.dismiss(); // Dismiss the update notification toast

      // Show download progress toast
      const downloadToastId = toast.loading('Downloading update...', {
        description: '0% complete',
        duration: Infinity,
      });

      console.log('⬇️ Starting download...');

      // Download and install with progress callback
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
              
              // Update toast with progress
              toast.loading('Downloading update...', {
                id: downloadToastId,
                description: `${percent}% complete`,
                duration: Infinity,
              });
            }
            break;
          case 'Finished':
            console.log('✅ Download finished, installing...');
            setDownloadProgress(100);
            toast.loading('Installing update...', {
              id: downloadToastId,
              description: 'Please wait...',
              duration: Infinity,
            });
            break;
        }
      });

      // Dismiss loading toast
      toast.dismiss(downloadToastId);

      // Installation complete, show success message
      await message('Update installed successfully! The app will now restart.', {
        title: 'Update Complete',
        kind: 'info',
        okLabel: 'Restart Now',
      });

      console.log('🔄 Restarting app...');
      // Restart the app
      await relaunch();
    } catch (error) {
      console.error('❌ Update installation failed:', error);
      
      toast.error('Update installation failed', {
        description: 'Please try again later',
        duration: 5000,
      });

      await message('Update download failed. Please try again later.', {
        kind: 'error',
        title: 'Update Failed',
      });

      setDownloadInProgress(false);
      setDownloadProgress(0);
      hasShownUpdateToast.current = false; // Allow showing toast again
    }
  };

  // Render progress UI if download is in progress
  if (downloadInProgress) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              Downloading Update...
            </h3>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 mb-4">
              <div
                className="bg-blue-600 h-4 rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress}%` }}
              />
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

  // No visible UI when not downloading - toast handles notifications
  return null;
}
