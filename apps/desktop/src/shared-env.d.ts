/// <reference types="vite/client" />

declare global {
  interface Window {
    api: import('./preload/api.js').DesktopApi;
  }
}

export {};
