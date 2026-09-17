// Settings and small local caches, persisted in localStorage.
import { DEFAULT_SETTINGS } from './config.js';

const SETTINGS_KEY = 'hr.settings.v1';

export const LOCAL_KEYS = {
  calibration: 'hr.calibration.v1',
  profiles: 'hr.profiles.v1',
  events: 'hr.events.v1',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    console.warn('Could not save settings', e);
    return false;
  }
}

export function localGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function localSet(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('Could not write', key, e);
    return false;
  }
}

/** Export everything stored locally (settings minus secrets, calibration, profiles, events) as JSON. */
export function exportLocalData() {
  const settings = loadSettings();
  const { supabaseAnonKey, lockWebhookToken, ...safeSettings } = settings;
  return {
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
    calibration: localGet(LOCAL_KEYS.calibration),
    profiles: localGet(LOCAL_KEYS.profiles, []),
    events: localGet(LOCAL_KEYS.events, []),
  };
}

export function importLocalData(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a valid export file');
  if (data.settings) saveSettings({ ...loadSettings(), ...data.settings });
  if (data.calibration !== undefined) localSet(LOCAL_KEYS.calibration, data.calibration);
  if (Array.isArray(data.profiles)) localSet(LOCAL_KEYS.profiles, data.profiles);
  if (Array.isArray(data.events)) localSet(LOCAL_KEYS.events, data.events);
}
