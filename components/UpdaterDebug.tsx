'use client';

import { useState, useEffect } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { toast } from 'sonner';

export function UpdaterDebug() {
  const [logs, setLogs] = useState<string[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [`[${timestamp}] ${message}`, ...prev].slice(0, 50));
  };

  useEffect(() => {
    // Check if in Tauri environment
    if (typeof window !== 'undefined' && window.__TAURI__) {
      setIsVisible(true);
      
      const isDev = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' ||
                    window.location.port === '3000';
      
      if (isDev) {
        addLog('⚠️ Running in DEV mode');
        addLog('ℹ️ Updater disabled in development');
      } else {
        addLog('✅ Running in PRODUCTION mode');
        addLog('✅ Updater is enabled');
      }
      
      addLog(`📌 Current version: ${document.querySelector('[data-version]')?.getAttribute('data-version') || 'unknown'}`);
    }
  }, []);

  const checkUpdate = async () => {
    setIsChecking(true);
    addLog('🔍 Checking for updates...');

    try {
      const update = await check();
      
      addLog('📦 Update check complete');
      addLog(`Available: ${update?.available || false}`);
      addLog(`Current: ${update?.currentVersion || 'unknown'}`);
      addLog(`Latest: ${update?.version || 'unknown'}`);
      
      if (update?.body) {
        addLog(`Notes: ${update.body}`);
      }

      if (update?.available) {
        toast.success(`Update available: v${update.version}`, {
          description: 'Check the Updater component for install option',
          duration: 5000,
        });
      } else {
        toast.info('No updates available', {
          duration: 3000,
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      addLog(`❌ Error: ${errorMsg}`);
      
      if (errorMsg.includes('missing Origin header')) {
        addLog('ℹ️ Expected error in dev mode');
      } else {
        toast.error(`Update check failed: ${errorMsg}`);
      }
    } finally {
      setIsChecking(false);
    }
  };

  if (!isVisible) return null;

  if (isMinimized) {
    return (
      <button
        onClick={() => setIsMinimized(false)}
        className="fixed bottom-4 right-4 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg shadow-2xl z-[9999] font-medium transition-colors"
      >
        🔧 Debug
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 bg-gray-900 text-white rounded-lg shadow-2xl max-w-2xl w-full z-[9999] border border-gray-700">
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h3 className="font-bold text-lg flex items-center gap-2">
          🔧 Updater Debug Console
        </h3>
        <div className="flex gap-2">
          <button
            onClick={checkUpdate}
            disabled={isChecking}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isChecking ? '⏳ Checking...' : '🔍 Check Update'}
          </button>
          <button
            onClick={() => setIsMinimized(true)}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
          >
            ➖
          </button>
        </div>
      </div>
      
      <div className="p-4">
        <div className="bg-black rounded-lg p-3 max-h-96 overflow-y-auto font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <div className="text-gray-500">
              No logs yet. Click "Check Update" to test the updater.
            </div>
          ) : (
            logs.map((log, i) => (
              <div 
                key={i} 
                className={`
                  ${log.includes('❌') ? 'text-red-400' : ''}
                  ${log.includes('✅') ? 'text-green-400' : ''}
                  ${log.includes('⚠️') ? 'text-yellow-400' : ''}
                  ${log.includes('📦') || log.includes('🔍') ? 'text-blue-400' : ''}
                  ${!log.includes('❌') && !log.includes('✅') && !log.includes('⚠️') && !log.includes('📦') && !log.includes('🔍') ? 'text-gray-300' : ''}
                `}
              >
                {log}
              </div>
            ))
          )}
        </div>
        
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => setLogs([])}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Clear Logs
          </button>
          <button
            onClick={() => {
              const logText = logs.join('\n');
              navigator.clipboard.writeText(logText);
              toast.success('Logs copied to clipboard');
            }}
            className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Copy Logs
          </button>
          <div className="flex-1"></div>
          <span className="text-xs text-gray-400">
            {logs.length} log entries
          </span>
        </div>
      </div>
    </div>
  );
}
