import {
  deleteMemory,
  getMemory,
  getRecentMemory,
  listFamilyListItems,
  setMemory,
} from './db.js';
import { sendMessage } from './channels/imessage.js';
import {
  FAMILY_GROUP_KEY,
  startFamilyScheduler,
  type FamilySchedulerDependencies,
  type FamilySchedulerHandles,
} from './family-scheduler.js';
import { listFamilyCalendarEventsRaw } from './tools/family-calendar.js';
import { getProfileConfig, getTimezone } from './config.js';
import { resolveGroup } from './group-resolver.js';
import { verifySharedAudience } from './family-membership.js';

const OPEN_METEO_GEOCODING_ORIGIN = 'https://geocoding-api.open-meteo.com';
const OPEN_METEO_FORECAST_ORIGIN = 'https://api.open-meteo.com';
const WEATHER_TIMEOUT_MS = 8_000;
const WEATHER_RESPONSE_LIMIT = 256_000;

interface OpenMeteoLocationResponse {
  results?: Array<{
    latitude?: number;
    longitude?: number;
  }>;
}

interface OpenMeteoForecastResponse {
  current?: {
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
}

async function fetchFixedWeatherJson<T>(url: URL): Promise<T> {
  if (url.origin !== OPEN_METEO_GEOCODING_ORIGIN && url.origin !== OPEN_METEO_FORECAST_ORIGIN) {
    throw new Error('Family weather may only use the fixed Open-Meteo providers.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`weather provider returned HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > WEATHER_RESPONSE_LIMIT) throw new Error('weather provider response was too large');
    return JSON.parse(body) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function weatherCodeSummary(code: number | undefined): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Cloudy';
  if (code === 45 || code === 48) return 'Foggy';
  if (code !== undefined && code >= 51 && code <= 57) return 'Drizzle';
  if (code !== undefined && code >= 61 && code <= 67) return 'Rain';
  if (code !== undefined && code >= 71 && code <= 77) return 'Snow';
  if (code !== undefined && code >= 80 && code <= 82) return 'Rain showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code !== undefined && code >= 95) return 'Thunderstorms';
  return 'Weather conditions unavailable';
}

function rounded(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** Resolve an operator-provided place name or postal code through one fixed
 * public provider, then fetch a one-day forecast from that provider only. */
export async function getFamilyWeatherSummary(locationInput: string): Promise<{ summary: string } | null> {
  const location = locationInput.replace(/\s+/g, ' ').trim();
  if (location.length < 2 || location.length > 160 || /[\r\n\0]/.test(locationInput)) {
    throw new Error('FAMILY_WEATHER_LOCATION must be a city/state or postal code from 2 to 160 characters.');
  }

  const geocodingUrl = new URL('/v1/search', OPEN_METEO_GEOCODING_ORIGIN);
  geocodingUrl.searchParams.set('name', location);
  geocodingUrl.searchParams.set('count', '1');
  geocodingUrl.searchParams.set('language', 'en');
  geocodingUrl.searchParams.set('format', 'json');
  const geocoding = await fetchFixedWeatherJson<OpenMeteoLocationResponse>(geocodingUrl);
  const match = geocoding.results?.[0];
  if (!match || !Number.isFinite(match.latitude) || !Number.isFinite(match.longitude)) return null;

  const forecastUrl = new URL('/v1/forecast', OPEN_METEO_FORECAST_ORIGIN);
  forecastUrl.searchParams.set('latitude', String(match.latitude));
  forecastUrl.searchParams.set('longitude', String(match.longitude));
  forecastUrl.searchParams.set(
    'current',
    'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
  );
  forecastUrl.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  forecastUrl.searchParams.set('temperature_unit', 'fahrenheit');
  forecastUrl.searchParams.set('wind_speed_unit', 'mph');
  forecastUrl.searchParams.set('timezone', getTimezone());
  forecastUrl.searchParams.set('forecast_days', '1');
  const forecast = await fetchFixedWeatherJson<OpenMeteoForecastResponse>(forecastUrl);

  const current = rounded(forecast.current?.temperature_2m);
  const feels = rounded(forecast.current?.apparent_temperature);
  const high = rounded(forecast.daily?.temperature_2m_max?.[0]);
  const low = rounded(forecast.daily?.temperature_2m_min?.[0]);
  const rain = rounded(forecast.daily?.precipitation_probability_max?.[0]);
  const wind = rounded(forecast.current?.wind_speed_10m);
  const details: string[] = [];
  if (current !== null) details.push(`${current}\u00b0F now${feels !== null ? `, feels ${feels}\u00b0` : ''}`);
  if (high !== null && low !== null) details.push(`high ${high}\u00b0, low ${low}\u00b0`);
  if (rain !== null) details.push(`rain chance ${rain}%`);
  if (wind !== null) details.push(`wind ${wind} mph`);

  return {
    summary: `${weatherCodeSummary(forecast.current?.weather_code)}${details.length ? `; ${details.join('; ')}` : ''}.`,
  };
}

function requireFamilyGroup(groupId: string): void {
  if (groupId !== FAMILY_GROUP_KEY) {
    throw new Error('Family scheduled data may only be read from the Family namespace.');
  }
}

export function createFamilySchedulerDependencies(): FamilySchedulerDependencies {
  const profile = getProfileConfig();
  const nameById = new Map(
    [profile.owner, ...profile.members].map((user) => [user.id, user.name]),
  );

  return {
    data: {
      listFamilyCalendarEvents: async (range) => {
        requireFamilyGroup(range.groupId);
        return listFamilyCalendarEventsRaw({
          startDate: range.startDate,
          endDateExclusive: range.endDateExclusive,
          timeZone: range.timeZone,
        });
      },
      listOpenFamilyItems: (query) => {
        requireFamilyGroup(query.groupId);
        return listFamilyListItems({
          status: 'open',
          include_archived: false,
          limit: 500,
        }).map((item) => ({
          id: item.id,
          listName: item.list_name,
          text: item.text,
          quantity: item.quantity,
          dueDate: item.due_date,
          assignees: item.assignee
            ? [item.assignee === 'both' ? 'Both' : (nameById.get(item.assignee) || item.assignee)]
            : [],
          status: item.status,
          archived: Boolean(item.archived_at),
        }));
      },
      listOpenFamilyCoordinationNotes: (query) => {
        requireFamilyGroup(query.groupId);
        return getRecentMemory(FAMILY_GROUP_KEY, {
          prefix: 'coordination_open_',
          limit: 50,
        }).map((entry) => ({
          id: entry.key,
          text: entry.value,
          resolved: false,
          updatedAt: entry.updated_at,
        }));
      },
      getFamilyWeather: getFamilyWeatherSummary,
    },
    memory: {
      get: (groupId, key) => {
        requireFamilyGroup(groupId);
        return getMemory(FAMILY_GROUP_KEY, key);
      },
      set: (groupId, key, value) => {
        requireFamilyGroup(groupId);
        setMemory(FAMILY_GROUP_KEY, key, value);
      },
      delete: (groupId, key) => {
        requireFamilyGroup(groupId);
        deleteMemory(FAMILY_GROUP_KEY, key);
      },
    },
    authorizeTarget: async (recipient) => {
      const group = resolveGroup(recipient);
      return Boolean(
        group
        && group.key === FAMILY_GROUP_KEY
        && await verifySharedAudience(recipient, group),
      );
    },
    sendMessage,
  };
}

export function startFamilyRuntimeScheduler(): FamilySchedulerHandles | null {
  if (
    !process.env.GROUP_FAMILY?.trim()
    || !process.env.FAMILY_CALENDAR_ID?.trim()
    || !process.env.FAMILY_CALENDAR_ACCOUNT?.trim()
  ) {
    console.log('[FamilyScheduler] Disabled until GROUP_FAMILY, FAMILY_CALENDAR_ID, and FAMILY_CALENDAR_ACCOUNT are configured');
    return null;
  }
  return startFamilyScheduler(createFamilySchedulerDependencies());
}
