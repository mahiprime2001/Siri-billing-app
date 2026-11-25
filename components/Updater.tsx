'use client';

import { useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import {
  ANNOUNCE_EVERY_MS,
  MUTE_AFTER_LATER_MS,
  RETRY_AFTER_CHECK_FAILURE_MS,
  RETRY_AFTER_INSTALL_FAILURE_MS,
  localDay,
  shouldAnnounceUpdate,
  shouldRunMorningUpdate,
} from '@/lib/update-policy';
import { isUpdateBusy } from '@/lib/update-busy';
import OfflineQueueNote from '@/components/OfflineQueueNote';

/**
 * How updates reach a store (the rule lives in lib/update-policy.ts):
 *   - the FIRST time the app is opened each day, a new version (if any) is installed by itself, with a
 *     "please wait" screen and an automatic restart;
 *   - after that nothing is installed by itself. Every 30 minutes the app quietly looks, and when a newer version
 *     exists it shows the blue "Update Available" box (Install Now / Later); "Later" hides that version for 4 hours.
 *     "Check for updates" looks at once.
 */
const DAY_KEY = 'siri-auto-update-day';

function readDoneDay(): string | null {
  try {
    return window.localStorage.getItem(DAY_KEY);
  } catch {
    return null;
  }
}

function writeDoneDay(day: string | null) {
  try {
    if (day) window.localStorage.setItem(DAY_KEY, day);
    else window.localStorage.removeItem(DAY_KEY);
  } catch {
    /* private mode etc.: the update just runs again next time */
  }
}

interface DownloadProgress {
  chunkLength: number;
  contentLength: number | null;
}

export default function Updater() {
  const currentUpdate = useRef<Update | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [downloadInProgress, setDownloadInProgress] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [automatic, setAutomatic] = useState(false); // the install in progress is the morning one
  const [appVersion, setAppVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    notes: string;
  } | null>(null);

  const downloading = useRef(false);
  const running = useRef(false); // a morning check/install is under way
  const retryNotBefore = useRef(0);
  const nextAnnounceAt = useRef(0); // the next time the app may quietly look for a newer version to offer
  const mutedUntil = useRef<Record<string, number>>({}); // version -> "Later" was pressed, hide until then

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) {
      console.log('Not running in Tauri environment, skipping update check');
      return;
    }

    getVersion().then(setAppVersion).catch(() => undefined);

    // ---- the once-a-day automatic update
    const morningCheck = async () => {
      const now = Date.now();
      const today = localDay(new Date());
      if (
        !shouldRunMorningUpdate({
          today,
          lastDoneDay: readDoneDay(),
          busy: isUpdateBusy(),
          running: running.current || downloading.current,
          now,
          retryNotBefore: retryNotBefore.current,
        })
      ) {
        return;
      }
      running.current = true;
      try {
        const update = await check();
        writeDoneDay(today); // the check itself worked: no more automatic checks today, whatever it found
        nextAnnounceAt.current = Date.now() + ANNOUNCE_EVERY_MS;
        if (!update || !update.available) return;

        currentUpdate.current = update;
        setUpdateInfo({ version: update.version, notes: update.body || '' });
        setAutomatic(true);
        await install(update, true);
      } catch (error) {
        console.error('Automatic update check failed:', error);
        retryNotBefore.current = Date.now() + RETRY_AFTER_CHECK_FAILURE_MS;
      } finally {
        running.current = false;
      }
    };

    // After the morning update: look now and then for a NEWER version and offer it (blue box, never installed by itself).
    const announceCheck = async () => {
      const now = Date.now();
      if (
        !shouldAnnounceUpdate({
          today: localDay(new Date()),
          lastDoneDay: readDoneDay(),
          running: running.current || downloading.current,
          now,
          nextAnnounceAt: nextAnnounceAt.current,
        })
      ) {
        return;
      }
      nextAnnounceAt.current = now + ANNOUNCE_EVERY_MS;
      running.current = true;
      try {
        const update = await check();
        if (!update || !update.available) return;
        if (Date.now() < (mutedUntil.current[update.version] ?? 0)) return; // "Later" was pressed for this version
        currentUpdate.current = update;
        setUpdateInfo({ version: update.version, notes: update.body || 'No release notes available.' });
        setUpdateAvailable(true);
      } catch (error) {
        console.error('Background update look failed:', error); // quiet: the next look is in 30 minutes
      } finally {
        running.current = false;
      }
    };

    // Look when the app starts, and again whenever the window comes back to the front or a minute passes (so an app
    // left open overnight updates when it is used the next morning). The once-a-day rule decides whether to act.
    const lookNow = async () => {
      await morningCheck();
      await announceCheck();
    };
    void lookNow();
    const timer = setInterval(() => void lookNow(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void lookNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function postpone() {
    // "Later": the box closes and this version stays hidden for a few hours; "Check for updates" brings it back at once.
    if (updateInfo) mutedUntil.current[updateInfo.version] = Date.now() + MUTE_AFTER_LATER_MS;
    setUpdateAvailable(false);
  }

  /** Download + install. `auto` = the morning install: no questions asked, restarts by itself. */
  async function install(update: Update, auto: boolean) {
    try {
      downloading.current = true;
      setDownloadInProgress(true);
      setDownloadProgress(0);

      let total = 0;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = (event.data as { contentLength?: number }).contentLength ?? 0;
            received = 0;
            setDownloadProgress(0);
            break;
          case 'Progress': {
            const progress = event.data as DownloadProgress;
            received += progress.chunkLength;
            if (total > 0) setDownloadProgress(Math.min(100, Math.round((received / total) * 100)));
            break;
          }
          case 'Finished':
            setDownloadProgress(100);
            break;
        }
      });

      if (!auto) {
        await message('Update installed successfully! The app will now restart.', {
          title: 'Update Complete',
          kind: 'info',
          okLabel: 'Restart Now',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500)); // let everything shut down cleanly
      await relaunch();
    } catch (error) {
      console.error('Update installation failed:', error);
      downloading.current = false;
      setDownloadInProgress(false);
      setDownloadProgress(0);
      setAutomatic(false);
      if (auto) {
        // Try again later today instead of waiting for tomorrow; no pop-up for the cashier.
        writeDoneDay(null);
        retryNotBefore.current = Date.now() + RETRY_AFTER_INSTALL_FAILURE_MS;
      } else {
        await message('Update download failed. Please try again later.', {
          kind: 'error',
          title: 'Update Failed',
        });
      }
    }
  }

  async function downloadAndInstallUpdate() {
    if (!currentUpdate.current) return;
    if (isUpdateBusy()) {
      // the app restarts to install: never in the middle of a bill, an invoice edit or a replacement
      await message('A bill is open. Please finish or close it first, then press Install Now.', { title: 'Update', kind: 'info' });
      return;
    }
    await install(currentUpdate.current, false);
  }

  /** "Check for updates": looks right now (and brings back a version that was put off with "Later"). */
  async function checkNow() {
    if (downloading.current || running.current) return;
    running.current = true;
    try {
      const update = await check();
      if (!update || !update.available) {
        await message(`You are up to date${appVersion ? ` (version ${appVersion})` : ''}.`, { title: 'Updates', kind: 'info' });
        return;
      }
      currentUpdate.current = update;
      delete mutedUntil.current[update.version];
      setUpdateInfo({ version: update.version, notes: update.body || 'No release notes available.' });
      setUpdateAvailable(true);
    } catch (error) {
      console.error('Manual update check failed:', error);
      await message('Could not check for updates. Please check the internet connection.', { title: 'Updates', kind: 'error' });
    } finally {
      running.current = false;
    }
  }

  // Render progress UI if download is in progress
  if (downloadInProgress) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
          <div className="text-center">
            <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">
              {automatic && updateInfo ? `Updating to version ${updateInfo.version}...` : 'Downloading Update...'}
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
              {automatic
                ? 'Please wait. The app will restart by itself in a moment.'
                : "Please don't close the application"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* bills made with no internet that are still waiting to be sent (Rust offline mode) */}
      <OfflineQueueNote />

      {/* a small, quiet way to look for an update by hand */}
      <button
        onClick={checkNow}
        className="fixed bottom-1 left-2 z-40 text-[11px] text-gray-400 hover:text-gray-600 underline-offset-2 hover:underline"
        aria-label="Check for updates"
      >
        {appVersion ? `v${appVersion} · ` : ''}Check for updates
      </button>

      {updateAvailable && updateInfo && (
        <div className="fixed bottom-4 right-4 bg-gradient-to-r from-blue-600 to-blue-700 text-white p-4 rounded-lg shadow-2xl max-w-sm z-50 animate-slide-in">
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-6 h-6 text-yellow-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <p className="font-semibold text-lg">Update Available!</p>
              </div>
              <button onClick={postpone} className="text-white hover:text-gray-200 transition-colors" aria-label="Close">
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
              <p className="text-xs text-blue-100 mt-1 line-clamp-2">{updateInfo.notes}</p>
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
                onClick={postpone}
                className="bg-transparent border border-white px-4 py-2 rounded-md hover:bg-blue-800 transition-colors text-sm font-medium"
              >
                Later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
