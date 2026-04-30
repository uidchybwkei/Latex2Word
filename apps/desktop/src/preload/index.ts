import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './api.js';
import type { TemplateImportProgress, UserSettings } from '@latex2docx/shared';

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: UserSettings) => ipcRenderer.invoke('settings:save', settings),
  detectTools: () => ipcRenderer.invoke('tools:detect'),
  queueBootstrapJob: () => ipcRenderer.invoke('jobs:queue-bootstrap'),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  importTemplate: () => ipcRenderer.invoke('templates:import'),
  onTemplateImportProgress: (callback: (progress: TemplateImportProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: TemplateImportProgress) => callback(progress);
    ipcRenderer.on('templates:import-progress', listener);
    return () => ipcRenderer.off('templates:import-progress', listener);
  },
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  generateFixedLatexTemplate: (templateId: string) => ipcRenderer.invoke('templates:generate-fixed-latex', templateId),
  convertLatexWithTemplate: (templateId: string) => ipcRenderer.invoke('jobs:convert-latex', templateId),
  deleteTemplateHistory: (templateId: string) => ipcRenderer.invoke('templates:delete', templateId),
  clearTemplateHistory: () => ipcRenderer.invoke('templates:clear-history'),
};

contextBridge.exposeInMainWorld('api', api);
