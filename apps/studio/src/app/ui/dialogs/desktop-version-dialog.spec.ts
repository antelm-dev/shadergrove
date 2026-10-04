import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateState } from '../../../desktop/contracts/contracts';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { DesktopUpdater } from '../../desktop/desktop-updater';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences, type WorkspacePreferences } from '../../prefs/preferences';
import { AboutShadergroveDialog, DesktopVersionDialog } from './desktop-version-dialog';

describe('DesktopVersionDialog', () => {
  const platform = { available: true };
  const language = signal(speaking('en'));
  const updateState = signal<UpdateState>({
    status: 'up-to-date',
    currentVersion: '1.2.3',
  });
  const check = vi.fn(async () => undefined);
  const update = vi.fn();

  beforeEach(async () => {
    language.set(speaking('en'));
    updateState.set({ status: 'up-to-date', currentVersion: '1.2.3' });
    platform.available = true;
    check.mockReset();
    update.mockReset();

    TestBed.configureTestingModule({
      imports: [DesktopVersionDialog],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        {
          provide: Preferences,
          useValue: {
            value: language.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) => {
              language.update((value) => ({ ...value, ...patch }));
            },
          },
        },
        { provide: DesktopPlatform, useValue: platform },
        {
          provide: DesktopUpdater,
          useValue: {
            state: updateState.asReadonly(),
            check,
            update,
          },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const mount = async (locale: 'en' | 'fr' = 'en') => {
    language.set(speaking(locale));
    const fixture = TestBed.createComponent(DesktopVersionDialog);
    fixture.detectChanges();
    return fixture;
  };

  it('exports AboutShadergroveDialog as an alias of DesktopVersionDialog', () => {
    expect(AboutShadergroveDialog).toBe(DesktopVersionDialog);
  });

  it('renders About title, version, and live status without forcing a check', async () => {
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h2')?.textContent?.trim()).toBe('About Shadergrove');
    expect(root.textContent).toContain('Shadergrove');
    expect(root.textContent).toContain('Version 1.2.3');
    expect(root.textContent).toContain('You are on the latest version.');

    const status = root.querySelector('.status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('role')).toBe('status');
    expect(check).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('on the web, drops the update status and keeps the changelog link', async () => {
    platform.available = false;
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.status')).toBeNull();
    expect(root.querySelector('mat-dialog-actions button[matButton="filled"]')).toBeNull();
    expect(root.textContent).toContain('Version 1.2.3');
    expect(root.querySelector('a.changelog')?.getAttribute('href')).toContain('CHANGELOG.md');
  });

  it('shows unavailable status text and a disabled primary action', async () => {
    updateState.set({
      status: 'unavailable',
      currentVersion: '1.2.3',
      message: 'Updates are managed by your package manager.',
    });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Updates are managed by your package manager.');
    const action = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Unavailable'),
    );
    expect(action?.disabled).toBe(true);
  });

  it('shows checking status and keeps the primary action disabled', async () => {
    updateState.set({ status: 'checking', currentVersion: '1.2.3' });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Checking for an update…');
    const action = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Checking…'),
    );
    expect(action?.disabled).toBe(true);
  });

  it('offers Update when a new version is available and preserves install via updater.update', async () => {
    updateState.set({
      status: 'available',
      currentVersion: '1.2.3',
      availableVersion: '1.3.0',
    });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Version 1.3.0 is available.');
    const action = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Update'),
    );
    expect(action?.disabled).toBe(false);
    action?.click();
    fixture.detectChanges();
    expect(update).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
  });

  it('offers Restart and update when a download is ready', async () => {
    updateState.set({
      status: 'downloaded',
      currentVersion: '1.2.3',
      availableVersion: '1.3.0',
    });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Version 1.3.0 is ready to install.');
    const action = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Restart and update'),
    );
    expect(action?.disabled).toBe(false);
    action?.click();
    fixture.detectChanges();
    expect(update).toHaveBeenCalledOnce();
    expect(check).not.toHaveBeenCalled();
  });

  it('shows download progress and keeps the primary action disabled while busy', async () => {
    updateState.set({
      status: 'downloading',
      currentVersion: '1.2.3',
      availableVersion: '1.3.0',
      progress: 42.4,
    });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Downloading version 1.3.0…');
    expect(root.textContent).toContain('42 %');
    expect(root.querySelector('mat-progress-bar')).toBeTruthy();

    const action = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Downloading'),
    );
    expect(action?.disabled).toBe(true);
  });

  it('retries an update check from the error action without exposing the raw updater error', async () => {
    updateState.set({
      status: 'error',
      currentVersion: '1.2.3',
      message: 'network down',
    });
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.textContent).toContain('Update check failed.');
    expect(root.textContent).not.toContain('network down');
    const retry = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry'),
    );
    expect(retry).toBeTruthy();
    retry?.click();
    fixture.detectChanges();
    expect(check).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it('localizes the About title in French', async () => {
    const fixture = await mount('fr');
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('À propos de Shadergrove');
    expect(root.textContent).toContain('Version 1.2.3');
  });

  it('declares reduced-motion-safe spin styles for the busy icon', async () => {
    const source = readFileSync(
      resolve(import.meta.dirname, './desktop-version-dialog.ts'),
      'utf8',
    );
    expect(source).toContain('@media (prefers-reduced-motion: reduce)');
    expect(source).toContain('animation: none');
  });
});
