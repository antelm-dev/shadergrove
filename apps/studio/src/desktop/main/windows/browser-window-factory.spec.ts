import { beforeEach, describe, expect, it, vi } from 'vitest';

const constructed: Electron.BrowserWindowConstructorOptions[] = [];

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(function (this: unknown, options: Electron.BrowserWindowConstructorOptions) {
    constructed.push(options);
  }),
  shell: { openExternal: vi.fn() },
}));

const { createSecureBrowserWindow } = await import('./browser-window-factory');

describe('createSecureBrowserWindow', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('gives a window the native frame unless it asks to be frameless', () => {
    createSecureBrowserWindow({ width: 800, height: 600, webPreferences: { preload: 'p.js' } });
    createSecureBrowserWindow({
      width: 800,
      height: 600,
      frame: false,
      webPreferences: { preload: 'p.js' },
    });

    expect(constructed.map((options) => options.frame)).toEqual([true, false]);
  });

  it('keeps every window sandboxed and isolated', () => {
    createSecureBrowserWindow({ width: 800, height: 600, webPreferences: { preload: 'p.js' } });

    expect(constructed[0]?.webPreferences).toEqual({
      preload: 'p.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
  });
});
