import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialogRef } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import { PluginCommands, type PluginCommand } from '../../plugins/plugin-commands';
import { Preferences } from '../../prefs/preferences';
import { NewShaderDialog } from './new-shader-dialog';

describe('NewShaderDialog', () => {
  const imports = signal<PluginCommand[]>([]);
  const close = vi.fn();

  beforeEach(async () => {
    imports.set([]);
    close.mockClear();
    TestBed.configureTestingModule({
      imports: [NewShaderDialog],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        { provide: Preferences, useValue: { value: signal({ language: 'en' }).asReadonly() } },
        { provide: MatDialogRef, useValue: { close } },
        { provide: PluginCommands, useValue: { imports } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  const buttons = (fixture: { nativeElement: HTMLElement }) =>
    Array.from(fixture.nativeElement.querySelectorAll('button')).map(
      (button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    );

  it('offers no importer while no plugin contributes one', () => {
    const fixture = TestBed.createComponent(NewShaderDialog);
    fixture.detectChanges();
    expect(buttons(fixture).some((label) => /Shadertoy/.test(label))).toBe(false);
  });

  it('offers each active importer and hands the chosen one back', () => {
    const shadertoy: PluginCommand = {
      id: 'plugin:pkg/shadertoy',
      ref: 'pkg/shadertoy',
      icon: () => 'public',
      label: () => 'Import from Shadertoy…',
      action: () => undefined,
    };
    imports.set([shadertoy]);
    const fixture = TestBed.createComponent(NewShaderDialog);
    fixture.detectChanges();
    expect(buttons(fixture)).toContain('public Import from Shadertoy…');

    (
      fixture.nativeElement.querySelector(
        '[data-testid="new-shader-plugin:pkg/shadertoy"]',
      ) as HTMLButtonElement
    ).click();
    expect(close).toHaveBeenCalledWith({ action: 'plugin', command: shadertoy });
  });
});
