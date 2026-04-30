import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppBootstrapResult } from '@latex2docx/shared';
import { bootstrapRuntime, type RuntimeContext } from './bootstrap.js';
import { registerIpcHandlers } from './ipc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.VITE_DEV_SERVER_URL;
const rendererHtml = join(__dirname, '../../dist/index.html');

function findProjectRoot(): string {
  const candidates = [
    process.env.LATEX2DOCX_PROJECT_ROOT,
    process.cwd(),
    app.getAppPath(),
    join(app.getAppPath(), '..', '..'),
    join(__dirname, '..', '..', '..', '..', '..'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    let current = resolve(candidate);
    for (let depth = 0; depth < 8; depth += 1) {
      const packageJsonPath = join(current, 'package.json');
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
          if (packageJson.name === 'latex2docx') {
            return current;
          }
        } catch {
          // Keep walking if package.json is not readable JSON.
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return resolve(process.cwd(), '..', '..');
}

let mainWindow: BrowserWindow | null = null;
let runtimeContext: RuntimeContext;
let bootstrapResult: AppBootstrapResult;
const projectRoot = findProjectRoot();
const isDev = Boolean(rendererUrl);
const userDataDir = isDev ? join(projectRoot, '.latex2docx-data', 'dev') : app.getPath('userData');
const electronSessionDir = isDev ? join(userDataDir, 'electron-session') : app.getPath('sessionData');

app.setPath('userData', userDataDir);
app.setPath('sessionData', electronSessionDir);
mkdirSync(join(electronSessionDir, 'Shared Dictionary', 'cache'), { recursive: true });
mkdirSync(electronSessionDir, { recursive: true });

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0b1020',
    webPreferences: {
      preload: join(app.getAppPath(), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    return;
  }

  await mainWindow.loadFile(rendererHtml);
}

async function main(): Promise<void> {
  await app.whenReady();

  const bootstrapped = await bootstrapRuntime(userDataDir);
  runtimeContext = bootstrapped.runtime;
  bootstrapResult = bootstrapped.result;

  registerIpcHandlers(() => runtimeContext, () => bootstrapResult);
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

void main();
