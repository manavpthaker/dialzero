// Back-compat shim. The clock is no longer Eastern-only: these names now read
// the configured timezone via lib/time.ts. New code should import from there.

export {
  localHour as etHour,
  isQuietHours,
  startOfTodayLocal as startOfTodayET,
  startOfWeekLocal as startOfWeekET,
  todayLocal as todayET,
} from './time.js';
