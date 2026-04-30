const { contextBridge, ipcRenderer } = require('electron');

const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  detectTools: () => ipcRenderer.invoke('tools:detect'),
  queueBootstrapJob: () => ipcRenderer.invoke('jobs:queue-bootstrap'),
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  importTemplate: () => ipcRenderer.invoke('templates:import'),
  onTemplateImportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('templates:import-progress', listener);
    return () => ipcRenderer.off('templates:import-progress', listener);
  },
  listTemplates: () => ipcRenderer.invoke('templates:list'),
  generateFixedLatexTemplate: (templateId) => ipcRenderer.invoke('templates:generate-fixed-latex', templateId),
  convertLatexWithTemplate: (templateId) => ipcRenderer.invoke('jobs:convert-latex', templateId),
  deleteTemplateHistory: (templateId) => ipcRenderer.invoke('templates:delete', templateId),
  clearTemplateHistory: () => ipcRenderer.invoke('templates:clear-history'),
};

contextBridge.exposeInMainWorld('api', api);
