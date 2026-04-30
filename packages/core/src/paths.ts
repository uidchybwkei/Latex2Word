import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from '../../shared/src/index.js';

export async function ensureAppPaths(userDataDir: string): Promise<AppPaths> {
  const templatesDir = join(userDataDir, 'templates');
  const jobsDir = join(userDataDir, 'jobs');
  const cacheDir = join(userDataDir, 'cache');
  const logsDir = join(userDataDir, 'logs');
  const databasePath = join(userDataDir, 'metadata.sqlite');

  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(templatesDir, { recursive: true }),
    mkdir(jobsDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
  ]);

  return {
    userDataDir,
    templatesDir,
    jobsDir,
    cacheDir,
    logsDir,
    databasePath,
  };
}
