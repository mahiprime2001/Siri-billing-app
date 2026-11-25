'use client';

import { useEffect, useState } from 'react';

/**
 * A small note above "Check for updates" (bottom-left) when bills made with no internet are still waiting to be sent,
 * or need a person to look at them. The app's Rust side answers /api/offline/status (Rust offline mode); on a PC
 * without it the route does not exist and nothing is shown.
 */
interface OfflineStatus {
  online: boolean;
  waiting: number;
  needs_attention: number;
  bills_needing_attention: { bill_id: string; error?: string | null }[];
}

const STATUS_URL = 'http://localhost:8080/api/offline/status';

export default function OfflineQueueNote() {
  const [status, setStatus] = useState<OfflineStatus | null>(null);

  useEffect(() => {
    let stopped = false;
    const look = async () => {
      try {
        const r = await fetch(STATUS_URL, { cache: 'no-store' });
        if (!r.ok) {
          if (!stopped) setStatus(null);
          return;
        }
        const body = (await r.json()) as OfflineStatus;
        if (!stopped && typeof body?.waiting === 'number') setStatus(body);
      } catch {
        /* the local service is restarting: try again on the next look */
      }
    };
    void look();
    const timer = setInterval(() => void look(), 30_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  if (!status || (status.waiting === 0 && status.needs_attention === 0)) return null;

  const attention = status.needs_attention > 0;
  const title = attention
    ? `Bills that need a person: ${status.bills_needing_attention.map((b) => b.bill_id).join(', ')}`
    : status.online
      ? 'Sending now; they will disappear from here once saved.'
      : 'No internet: they will be sent automatically when it is back.';

  return (
    <div
      className={`fixed bottom-5 left-2 z-40 text-[11px] font-medium ${attention ? 'text-red-600' : 'text-amber-600'}`}
      title={title}
      role="status"
      aria-live="polite"
    >
      {status.waiting > 0 && `${status.waiting} bill${status.waiting === 1 ? '' : 's'} waiting to send`}
      {status.waiting > 0 && attention && ' · '}
      {attention && `${status.needs_attention} bill${status.needs_attention === 1 ? '' : 's'} need${status.needs_attention === 1 ? 's' : ''} attention`}
    </div>
  );
}
