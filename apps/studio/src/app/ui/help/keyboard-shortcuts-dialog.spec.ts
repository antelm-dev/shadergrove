import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences, type WorkspacePreferences } from '../../prefs/preferences';
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog';
import { SHORTCUT_CATALOG, SHORTCUT_ENTRY_IDS } from './shortcut-catalog';

describe('KeyboardShortcutsDialog', () => {
  const language = signal(speaking('en'));

  beforeEach(async () => {
    language.set(speaking('en'));
    TestBed.configureTestingModule({
      imports: [KeyboardShortcutsDialog],
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
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const mount = async (locale: 'en' | 'fr' = 'en') => {
    language.set(speaking(locale));
    const fixture = TestBed.createComponent(KeyboardShortcutsDialog);
    fixture.detectChanges();
    return fixture;
  };

  it('renders every catalog section and entry with visible kbd tokens', async () => {
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Keyboard Shortcuts');
    expect(root.querySelectorAll('section.section')).toHaveLength(SHORTCUT_CATALOG.length);
    expect(root.querySelectorAll('li.entry')).toHaveLength(SHORTCUT_ENTRY_IDS.length);

    const labels = [...root.querySelectorAll('.label')].map((node) => node.textContent?.trim());
    expect(labels).toEqual([
      'Save shader',
      'Full screen',
      'Toggle developer tools',
      'Command palette',
      'New source file',
      'Compile now',
      'Close active document',
      'Toggle bottom panel',
      'Format GLSL',
      'Pause / resume',
      'Show / hide controls',
      'Capture PNG',
      'Zen mode',
      'Previous tab',
      'Next tab',
      'Activate tab 1–9',
    ]);

    const chords = [...root.querySelectorAll('.chord')].map((node) => ({
      aria: node.getAttribute('aria-label'),
      keys: [...node.querySelectorAll('kbd')].map((kbd) => kbd.textContent?.trim()),
    }));
    expect(chords[0]).toEqual({ aria: 'Ctrl+S', keys: ['Ctrl', 'S'] });
    expect(chords.at(-1)).toEqual({
      aria: 'Ctrl+1 through Ctrl+9',
      keys: ['Ctrl', '1…9'],
    });

    // Labels come from DOM text nodes, not CSS pseudo-content.
    // Chord aria-label is the accessible name; kbd tokens stay visual-only.
    for (const kbd of root.querySelectorAll('kbd')) {
      expect(kbd.textContent?.trim().length).toBeGreaterThan(0);
      expect(kbd.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('localizes section titles and entry labels in French', async () => {
    const fixture = await mount('fr');
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Raccourcis clavier');
    expect(root.textContent).toContain('Général');
    expect(root.textContent).toContain('Éditeur');
    expect(root.textContent).toContain('Aperçu');
    expect(root.textContent).toContain('Navigation');
    expect(root.textContent).toContain('Formater le GLSL');
    expect(root.textContent).toContain('Capturer en PNG');
    expect(root.textContent).toContain('Basculer les outils de développement');
  });

  it('exposes semantic headings for each section', async () => {
    const fixture = await mount('en');
    const root = fixture.nativeElement as HTMLElement;
    const sections = [...root.querySelectorAll('section.section')];
    expect(sections.map((section) => section.getAttribute('aria-labelledby'))).toEqual([
      'help-shortcuts-general',
      'help-shortcuts-editor',
      'help-shortcuts-preview',
      'help-shortcuts-navigation',
    ]);
    for (const section of sections) {
      const headingId = section.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      expect(section.querySelector(`#${headingId}`)?.tagName).toBe('H3');
    }
  });
});
