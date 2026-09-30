// Process-wide mutex for the Chrome bridge. funnel.ts and growth.ts both drive
// the same browser through browser-bridge.ts on independent crons — their
// per-module `inFlight` gates serialize motions within a module, but nothing
// stopped a funnel browser leg and a growth send window from interleaving
// clicks in one Chrome session. Everything runs in the one assistant process,
// so a promise-chain lock is sufficient: holders run FIFO, waiters queue.

let tail: Promise<unknown> = Promise.resolve();
let holder: string | null = null;

/** Run `fn` with exclusive access to the Chrome bridge. Queues if held. */
export function withBrowserLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const prev = tail;
  if (holder) console.log(`[BrowserLock] ${label} waiting (held by ${holder})`);
  const run = (async () => {
    await prev.catch(() => { /* a failed holder must not poison the queue */ });
    holder = label;
    console.log(`[BrowserLock] ${label} acquired`);
    try {
      return await fn();
    } finally {
      holder = null;
      console.log(`[BrowserLock] ${label} released`);
    }
  })();
  tail = run.catch(() => { /* tracked only for ordering */ });
  return run;
}
