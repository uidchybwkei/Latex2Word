import { dialog, ipcMain } from 'electron';
import type { AppBootstrapResult, UserSettings } from '../../../../packages/shared/src/index.js';
import * as coreModule from '../../../../packages/core/src/index.js';
import * as dbModule from '../../../../packages/db/src/index.js';
import type { RuntimeContext } from './bootstrap.js';
import { convertLatexToDocx, generateDeterministicLatexTemplate } from './latex-phase3.js';
import { createTemplateImportLogger, importTemplateFromFile } from './template-import.js';

async function requireTemplateSummary(runtime: RuntimeContext, templateId: string) {
  const templates = await dbModule.listImportedTemplates(runtime.database);
  const summary = templates.find((item) => item.template.id === templateId);
  if (!summary) {
    throw new Error(`Template ${templateId} was not found.`);
  }
  return summary;
}

export function registerIpcHandlers(getRuntime: () => RuntimeContext, getBootstrap: () => AppBootstrapResult): void {
  ipcMain.handle('app:bootstrap', () => getBootstrap());

  ipcMain.handle('settings:get', async () => {
    const runtime = getRuntime();
    const settings = await coreModule.loadOrCreateSettings(runtime.paths.userDataDir);
    runtime.settings = settings;
    return settings;
  });

  ipcMain.handle('settings:save', async (_event, settings: UserSettings) => {
    const runtime = getRuntime();
    const nextSettings = await coreModule.saveSettings(runtime.paths.userDataDir, settings);
    runtime.settings = nextSettings;
    return nextSettings;
  });

  ipcMain.handle('tools:detect', async () => {
    const runtime = getRuntime();
    return coreModule.detectTools(runtime.settings);
  });

  ipcMain.handle('jobs:queue-bootstrap', async () => {
    const runtime = getRuntime();
    return runtime.jobRunner.enqueue({ stage: 'bootstrap' });
  });

  ipcMain.handle('jobs:list', () => {
    const runtime = getRuntime();
    return runtime.jobRunner.list();
  });

  ipcMain.handle('templates:list', async () => {
    const runtime = getRuntime();
    return dbModule.listImportedTemplates(runtime.database);
  });

  ipcMain.handle('templates:delete', async (_event, templateId: string) => {
    const runtime = getRuntime();
    await dbModule.deleteImportedTemplate(runtime.database, templateId);
  });

  ipcMain.handle('templates:clear-history', async () => {
    const runtime = getRuntime();
    await dbModule.clearImportedTemplateHistory(runtime.database);
  });

  ipcMain.handle('templates:generate-fixed-latex', async (_event, templateId: string) => {
    const runtime = getRuntime();
    const summary = await requireTemplateSummary(runtime, templateId);
    const result = await generateDeterministicLatexTemplate(summary);
    await dbModule.saveTemplateAsset(runtime.database, result.asset);
    return result;
  });

  ipcMain.handle('jobs:convert-latex', async (_event, templateId: string) => {
    const runtime = getRuntime();
    const summary = await requireTemplateSummary(runtime, templateId);
    const selection = await dialog.showOpenDialog({
      title: 'Select LaTeX manuscript',
      properties: ['openFile'],
      filters: [{ name: 'LaTeX Files', extensions: ['tex'] }],
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    return convertLatexToDocx({
      summary,
      latexInputPath: selection.filePaths[0],
      settings: runtime.settings,
      jobRunner: runtime.jobRunner,
    });
  });

  ipcMain.handle('templates:import', async (event) => {
    const runtime = getRuntime();
    const selection = await dialog.showOpenDialog({
      title: 'Import Word template',
      properties: ['openFile'],
      filters: [{ name: 'Word Documents', extensions: ['doc', 'docx'] }],
    });

    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    const logger = await createTemplateImportLogger(runtime.paths, (progress) => {
      event.sender.send('templates:import-progress', progress);
    });

    try {
      const summary = await importTemplateFromFile(runtime.paths, selection.filePaths[0], logger);
      await logger.mark('database save started', 'started', {
        filePath: runtime.paths.databasePath,
        fileSizeBytes: undefined,
        paragraphCount: summary.schema.rawExtraction.paragraphCount,
        styleCount: summary.schema.rawExtraction.styleCount,
      });
      await dbModule.saveImportedTemplate(runtime.database, summary);
      await logger.mark('database save finished', 'finished', {
        filePath: runtime.paths.databasePath,
        paragraphCount: summary.schema.rawExtraction.paragraphCount,
        styleCount: summary.schema.rawExtraction.styleCount,
      });
      await logger.mark('import finished', 'finished', {
        filePath: summary.schemaVersion.path,
        paragraphCount: summary.schema.rawExtraction.paragraphCount,
        styleCount: summary.schema.rawExtraction.styleCount,
      });
      return summary;
    } catch (error) {
      await logger.mark('import finished', 'failed', {
        filePath: selection.filePaths[0],
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });
}
