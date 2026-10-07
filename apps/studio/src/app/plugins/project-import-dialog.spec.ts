import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { Preferences } from '../prefs/preferences';
import { SOURCE_PROVIDERS, type SourceProvider } from './host-adapters';
import { PLUGIN_STORE, PluginInstallations } from './plugin-installations';
import type { StoredPlugin } from './plugin-store';
import {
  ProjectPluginActions,
  type ProjectActionOutcome,
  type ProjectImportRequest,
} from './project-actions';
import { ProjectImportDialog, type ProjectImportDialogData } from './project-import-dialog';

/**
 * The import dialog against the real installations and the official Shadertoy
 * package; only the run itself (`ProjectPluginActions.runImport`, covered in
 * its own spec) is replaced, so what is asserted here is what the dialog asks
 * for, when it refuses, and when it lets go.
 */
const generated = resolve(import.meta.dirname, '../../plugins');
const SHADERTOY = 'dev.shadergrove.shadertoy';

const packageText = (id: string): string => {
  const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  return readFileSync(
    resolve(generated, catalogue.packages.find((p) => p.id === id)!.file),
    'utf8',
  );
};

/** The Shadertoy package under another id and, optionally, version: a second importer of the same kind. */
function variant(id: string, version?: string): string {
  const parsed = JSON.parse(packageText(SHADERTOY)) as {
    manifest: { id: string; name: string; version: string };
  };
  parsed.manifest.id = id;
  parsed.manifest.name = `Shadertoy as ${id}`;
  if (version) parsed.manifest.version = version;
  return JSON.stringify(parsed);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolveFn = done));
  return { promise, resolve: resolveFn };
}

describe('ProjectImportDialog', () => {
  const user = signal<{ id: string } | null>(null);
  const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
  const running = signal<{ pluginId: string; contributionId: string; step: string } | null>(null);
  const patch = vi.fn();
  const close = vi.fn();
  const cancel = vi.fn();
  const runImport =
    vi.fn<
      (
        id: string,
        contribution: string,
        request: ProjectImportRequest,
      ) => Promise<ProjectActionOutcome>
    >();
  let backdrop: Subject<MouseEvent>;
  let keys: Subject<KeyboardEvent>;
  let profiles: Map<string, Map<string, StoredPlugin>>;
  let dialogData: ProjectImportDialogData;

  const provider: SourceProvider = {
    id: 'shadertoy-api/v1',
    command: { label: 'action.importShadertoy', icon: 'public' },
    fields: [
      {
        key: 'idOrUrl',
        kind: 'text',
        label: 'shadertoy.idOrUrl',
        maxLength: 200,
      },
      {
        key: 'apiKey',
        kind: 'credential',
        label: 'shadertoy.apiKey',
        maxLength: 64,
        remember: 'shadertoyApiKey',
      },
    ],
    fetchSource: async () => ({ sourceId: 'x', source: {} }),
    fetchAsset: async () => new Uint8Array(),
  };

  function configure(): PluginInstallations {
    TestBed.configureTestingModule({
      imports: [ProjectImportDialog],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PLUGIN_STORE,
          useValue: (profile: string) => {
            const records = profiles.get(profile) ?? new Map<string, StoredPlugin>();
            profiles.set(profile, records);
            return {
              list: async () => [...records.values()],
              put: async (stored: StoredPlugin) => void records.set(stored.id, stored),
              remove: async (id: string) => void records.delete(id),
              replace: async (record: StoredPlugin) =>
                records.get(record.id)?.installedAt === record.installedAt
                  ? (records.set(record.id, record), true)
                  : false,
              readBootstrap: async () => null,
              writeBootstrap: async () => undefined,
            };
          },
        },
        { provide: AuthService, useValue: { user, status } },
        { provide: DesktopPlatform, useValue: { available: false } },
        I18n,
        {
          provide: Preferences,
          useValue: {
            value: signal({ language: 'en', shadertoyApiKey: 'remembered-key' }).asReadonly(),
            patch,
          },
        },
        { provide: MAT_DIALOG_DATA, useFactory: () => dialogData },
        { provide: SOURCE_PROVIDERS, useValue: provider, multi: true },
        { provide: ProjectPluginActions, useValue: { running, runImport, cancel } },
        {
          provide: MatDialogRef,
          useValue: {
            close,
            backdropClick: () => backdrop,
            keydownEvents: () => keys,
          },
        },
      ],
    });
    return TestBed.inject(PluginInstallations);
  }

  async function settle(): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function install(
    installations: PluginInstallations,
    source: string,
    enabled = true,
  ): Promise<string> {
    const review = installations.review(new TextEncoder().encode(source));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    const id = review.plugin.manifest.id;
    if (enabled) await installations.setEnabled(id, true);
    return id;
  }

  /** Opens the dialog for an importer as an opener would: the context read now. */
  async function open(
    installations: PluginInstallations,
    id: string,
  ): Promise<ComponentFixture<ProjectImportDialog>> {
    const data: ProjectImportDialogData = {
      context: installations.context(id)!,
      contributionId: 'shadertoy',
    };
    dialogData = data;
    const fixture = TestBed.createComponent(ProjectImportDialog);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const q = (fixture: ComponentFixture<unknown>, testid: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${testid}"]`);

  async function type(
    fixture: ComponentFixture<unknown>,
    testid: string,
    value: string,
  ): Promise<void> {
    const input = q(fixture, testid) as HTMLInputElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function click(fixture: ComponentFixture<unknown>, testid: string): Promise<void> {
    q(fixture, testid)!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const disabled = (fixture: ComponentFixture<unknown>, testid: string) =>
    (q(fixture, testid) as HTMLButtonElement | null)?.disabled;

  beforeEach(() => {
    profiles = new Map();
    user.set(null);
    status.set('anonymous');
    running.set(null);
    patch.mockClear();
    close.mockClear();
    cancel.mockClear();
    runImport.mockReset();
    backdrop = new Subject();
    keys = new Subject();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('asks the provider’s fields, fills the remembered key, and runs its own importer', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, variant('org.example.other'));
    const fixture = await open(installations, id);
    // The wording comes from the host adapter, not from the package.
    expect((fixture.nativeElement as HTMLElement).querySelector('h2')?.textContent).toContain(
      'Import from Shadertoy',
    );
    expect(disabled(fixture, 'import-run')).toBe(true);
    expect((q(fixture, 'import-field-apiKey') as HTMLInputElement).value).toBe('remembered-key');
    expect(q(fixture, 'import-field-apiKey')!.getAttribute('type')).toBe('password');

    await type(fixture, 'import-field-idOrUrl', ' https://www.shadertoy.com/view/ParFix ');
    expect(disabled(fixture, 'import-run')).toBe(false);
    runImport.mockResolvedValue({ status: 'imported', name: 'Parity', warnings: [] });
    await click(fixture, 'import-run');

    // A generic dispatch: the second package's id, trimmed values, the host's credential preference.
    expect(runImport).toHaveBeenCalledWith('org.example.other', 'shadertoy', {
      mode: 'provider',
      values: { idOrUrl: 'https://www.shadertoy.com/view/ParFix', apiKey: 'remembered-key' },
    });
    expect(patch).toHaveBeenCalledWith({ shadertoyApiKey: 'remembered-key' });
    expect(close).toHaveBeenCalledWith({
      imported: { name: 'Parity', warnings: [] },
      toEditor: false,
    });
  });

  it('pastes source in the other mode, keeping what was typed when a run fails', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY), true);
    const fixture = await open(installations, id);
    await click(fixture, 'import-mode-paste');
    await type(fixture, 'import-paste-name', 'Pasted');
    await type(fixture, 'import-paste-source', 'void mainImage() {}');

    runImport.mockResolvedValueOnce({ status: 'failed', message: 'needs mainImage' });
    await click(fixture, 'import-run');
    expect(runImport).toHaveBeenCalledWith(SHADERTOY, 'shadertoy', {
      mode: 'paste',
      name: 'Pasted',
      text: 'void mainImage() {}',
    });
    expect(q(fixture, 'import-message')?.textContent).toContain('needs mainImage');
    expect(close).not.toHaveBeenCalled();
    expect((q(fixture, 'import-paste-source') as HTMLTextAreaElement).value).toBe(
      'void mainImage() {}',
    );
  });

  it('keeps the form and the draft behind it when the replacement is declined', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    await type(fixture, 'import-field-idOrUrl', 'ParFix');
    // The unsaved-changes prompt answered "stay": runImport reports a cancel and adopts nothing.
    runImport.mockResolvedValue({ status: 'cancelled' });
    await click(fixture, 'import-run');
    expect(q(fixture, 'import-message')?.textContent).toContain('Cancelled');
    expect(close).not.toHaveBeenCalled();
    expect((q(fixture, 'import-field-idOrUrl') as HTMLInputElement).value).toBe('ParFix');
    expect(disabled(fixture, 'import-run')).toBe(false);
  });

  it('keeps warnings readable until the user returns to the editor', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    await type(fixture, 'import-field-idOrUrl', 'ParFix');
    runImport.mockResolvedValue({
      status: 'imported',
      name: 'Parity',
      warnings: ['The sound pass was not imported.'],
    });
    await click(fixture, 'import-run');

    expect(close).not.toHaveBeenCalled();
    expect(q(fixture, 'import-done')?.textContent).toContain('Imported “Parity”.');
    expect(q(fixture, 'import-warnings')?.textContent).toContain('sound pass');
    await click(fixture, 'import-editor');
    expect(close).toHaveBeenCalledWith({
      imported: { name: 'Parity', warnings: ['The sound pass was not imported.'] },
      toEditor: true,
    });
  });

  it.each([
    ['the package is switched off', (i: PluginInstallations) => i.setEnabled(SHADERTOY, false)],
    ['the package is removed', (i: PluginInstallations) => i.remove(SHADERTOY)],
    [
      'the package is updated',
      async (i: PluginInstallations) => {
        await install(i, variant(SHADERTOY, '9.9.9'), true);
      },
    ],
  ])('refuses to run once %s, before any submission', async (_name, change) => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    await type(fixture, 'import-field-idOrUrl', 'ParFix');
    expect(disabled(fixture, 'import-run')).toBe(false);

    await change(installations);
    await settle();
    fixture.detectChanges();
    expect(q(fixture, 'import-stale')).not.toBeNull();
    expect(q(fixture, 'import-run')).toBeNull();
    // Nor can a submission that bypasses the disabled button (Enter in a field) reach it.
    await (fixture.componentInstance as unknown as { submit(): Promise<void> }).submit();
    expect(runImport).not.toHaveBeenCalled();
  });

  it('is invalidated by a profile switch', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    user.set({ id: 'u1' });
    status.set('authenticated');
    await settle();
    fixture.detectChanges();
    expect(q(fixture, 'import-stale')).not.toBeNull();
    expect(runImport).not.toHaveBeenCalled();
  });

  it('does not offer to run while another plugin action is running', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    await type(fixture, 'import-field-idOrUrl', 'ParFix');
    running.set({ pluginId: 'other', contributionId: 'export', step: 'writing' });
    fixture.detectChanges();
    expect(disabled(fixture, 'import-run')).toBe(true);

    // Closing then must not cancel what is not this dialog's.
    await click(fixture, 'import-cancel');
    expect(cancel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ toEditor: false });
  });

  it('cancels only its own run when closed, and closes once that has settled', async () => {
    const installations = configure();
    await settle();
    const id = await install(installations, packageText(SHADERTOY));
    const fixture = await open(installations, id);
    await type(fixture, 'import-field-idOrUrl', 'ParFix');
    const run = deferred<ProjectActionOutcome>();
    runImport.mockReturnValue(run.promise);
    await click(fixture, 'import-run');

    // Escape, a click outside and Cancel are all the same request: one cancel, then wait.
    keys.next(new KeyboardEvent('keydown', { key: 'Escape' }));
    backdrop.next(new MouseEvent('click'));
    await click(fixture, 'import-cancel');
    expect(cancel).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    run.resolve({ status: 'cancelled' });
    await fixture.whenStable();
    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith({ toEditor: false });
  });

  describe('when destroyed', () => {
    async function openWithKey(): Promise<ComponentFixture<ProjectImportDialog>> {
      const installations = configure();
      await settle();
      const id = await install(installations, packageText(SHADERTOY));
      const fixture = await open(installations, id);
      await type(fixture, 'import-field-idOrUrl', 'ParFix');
      return fixture;
    }

    it('cancels its own pending run once', async () => {
      const fixture = await openWithKey();
      runImport.mockReturnValue(deferred<ProjectActionOutcome>().promise);
      await click(fixture, 'import-run');
      fixture.destroy();
      expect(cancel).toHaveBeenCalledOnce();
    });

    it('cancels nothing while idle', async () => {
      const fixture = await openWithKey();
      fixture.destroy();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('cancels nothing while another action is running', async () => {
      const fixture = await openWithKey();
      running.set({ pluginId: 'other', contributionId: 'export', step: 'writing' });
      fixture.destroy();
      expect(cancel).not.toHaveBeenCalled();
    });
  });
});
