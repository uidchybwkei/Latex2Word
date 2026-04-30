import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter } from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolName, ToolVersionInfo, UserSettings } from '../../shared/src/index.js';

const DEFAULT_EXECUTABLES: Record<ToolName, string> = {
  pandoc: 'pandoc',
  python: 'python3',
  latexmk: 'latexmk',
};

const TOOL_FLAGS: Record<ToolName, string[]> = {
  pandoc: ['--version'],
  python: ['--version'],
  latexmk: ['-v'],
};

function resolveConfiguredPath(tool: ToolName, settings: UserSettings): string | undefined {
  if (tool === 'pandoc') return settings.pandocPath;
  if (tool === 'python') return settings.pythonPath;
  return settings.latexmkPath;
}

async function canAccessExecutable(path: string): Promise<boolean> {
  try {
    if (path.includes('/')) {
      await access(path, constants.X_OK);
      return true;
    }
    return true;
  } catch {
    return false;
  }
}

function commandExistsInPath(command: string): boolean {
  if (command.includes('/')) return true;
  const pathValue = process.env.PATH ?? '';
  return pathValue.split(delimiter).some(Boolean);
}

async function captureVersion(command: string, args: string[]): Promise<{ version?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on('error', (error: Error) => {
      resolve({ error: error.message });
    });

    child.on('close', (code: number | null) => {
      if (code === 0) {
        const text = (stdout || stderr).trim().split('\n')[0];
        resolve({ version: text });
        return;
      }
      resolve({ error: (stderr || stdout || `Exited with code ${code}`).trim() });
    });
  });
}

export async function detectTool(tool: ToolName, settings: UserSettings): Promise<ToolVersionInfo> {
  const checkedAt = new Date().toISOString();
  const configuredPath = resolveConfiguredPath(tool, settings);
  const command = configuredPath || DEFAULT_EXECUTABLES[tool];

  if (!commandExistsInPath(command)) {
    return {
      name: tool,
      detected: false,
      checkedAt,
      path: command,
      error: 'Command not found in PATH',
    };
  }

  if (!(await canAccessExecutable(command))) {
    return {
      name: tool,
      detected: false,
      checkedAt,
      path: command,
      error: 'Configured path is not executable',
    };
  }

  const result = await captureVersion(command, TOOL_FLAGS[tool]);
  return {
    name: tool,
    detected: !result.error,
    checkedAt,
    path: command,
    version: result.version,
    error: result.error,
  };
}

export async function detectTools(settings: UserSettings): Promise<ToolVersionInfo[]> {
  return Promise.all([
    detectTool('pandoc', settings),
    detectTool('python', settings),
    detectTool('latexmk', settings),
  ]);
}
