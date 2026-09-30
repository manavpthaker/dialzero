import cron from 'node-cron';
import { getTimezone } from '../config.js';

/** node-cron on the assistant's local clock (getTimezone()). */
export function scheduleCron(
  expression: string,
  fn: () => void | Promise<void>,
  options: Record<string, unknown> = {},
): ReturnType<typeof cron.schedule> {
  return cron.schedule(expression, fn as any, { ...options, timezone: getTimezone() } as any);
}
