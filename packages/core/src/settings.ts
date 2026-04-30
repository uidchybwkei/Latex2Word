import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UserSettings } from '../../shared/src/index.js';

export function buildDefaultSettings(): UserSettings {
  const now = new Date().toISOString();
  return {
    ai: {
      enabled: false,
      timeoutMs: 30000,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadOrCreateSettings(userDataDir: string): Promise<UserSettings> {
  const settingsPath = join(userDataDir, 'settings.json');

  try {
    const raw = await readFile(settingsPath, 'utf8');
    return JSON.parse(raw) as UserSettings;
  } catch {
    const settings = buildDefaultSettings();
    await saveSettings(userDataDir, settings);
    return settings;
  }
}

export async function saveSettings(userDataDir: string, settings: UserSettings): Promise<UserSettings> {
  const settingsPath = join(userDataDir, 'settings.json');
  const nextSettings: UserSettings = {
    ...settings,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(settingsPath, JSON.stringify(nextSettings, null, 2), 'utf8');
  return nextSettings;
}
