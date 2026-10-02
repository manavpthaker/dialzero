// Plain-code heartbeat calendar check.  npm run test:calendar-alerts
import assert from 'node:assert/strict';
import { calendarAlerts } from '../src/lib/calendar-alerts.js';

const now = Date.parse('2026-10-02T14:00:00Z'); // 10:00 ET
const at = (min: number) => new Date(now + min * 60_000).toISOString();
const a = calendarAlerts([
  { id: 'dent', title: 'Dentist', start: at(20), end: at(80), location: '12 Main St, Springfield' },
  { id: 'zoom', title: 'Standup', start: at(20), end: at(35), location: 'https://zoom.us/j/1' },
  { id: 'late', title: 'Lunch', start: at(60), end: at(120), location: 'Corner Cafe, Springfield' },
  { id: 'nope', title: 'Declined thing', start: at(30), end: at(50), declined: true },
  { id: 'free', title: 'Focus block', start: at(30), end: at(90), free: true },
], now);
assert.deepEqual(a.map((x) => x.subject), ['heartbeat:leave:dent', 'heartbeat:conflict:dent:zoom', 'heartbeat:conflict:dent:late']);
assert.match(a[0].text, /^🚗 Dentist at 10:20 AM, 12 Main St, Springfield\. Time to head out\.$/);
assert.equal(calendarAlerts([{ id: 'x', title: 'Call', start: at(20), end: at(30), location: 'Phone' }], now).length, 0, 'no leave alert for a call');
assert.equal(calendarAlerts([], now).length, 0);
console.log('Calendar alert tests passed: 4 checks.');
