import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShaderHistoryCause, ShaderHistoryEntry } from '@shadergrove/shared/model';
import { ApiError, ShaderApi } from '../../api/shader-api';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { WorkspaceActions } from '../workspace-actions';
import { HistoryDialog, relativeTime } from './history-dialog';

const CAUSES: ShaderHistoryCause[] = [
  'restore',
  'sync',
  'preset-delete',
  'preset-save',
  'update',
  'baseline',
  'duplicate',
  'import',
  'create',
];

function entry(revision: number, overrides: Partial<ShaderHistoryEntry> = {}): ShaderHistoryEntry {
  return {
    revision,
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    cause: 'update',
    checkpointName: null,
    restoredFromRevision: null,
    ...overrides,
  };
}

/** A promise the test settles by hand, to look at the dialog while a write is in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('HistoryDialog', () => {
  const language = signal(speaking('en'));
  const record = signal<{ id: string; revision: number; kind?: string } | null>({
    id: 'waves',
    revision: 9,
  });
  const api = {
    listHistory: vi.fn(),
    setCheckpoint: vi.fn(),
  };
  const workspace = { restoreHistory: vi.fn() };
  const close = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    language.set(speaking('en'));
    record.set({ id: 'waves', revision: 9 });
    api.listHistory.mockResolvedValue([
      entry(9, { cause: 'restore', restoredFromRevision: 4 }),
      entry(7, { checkpointName: 'Before bloom' }),
      entry(4, { cause: 'create' }),
    ]);
    TestBed.configureTestingModule({
      imports: [HistoryDialog],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        {
          provide: Preferences,
          useValue: { value: language.asReadonly(), patch: () => undefined },
        },
        { provide: MAT_DIALOG_DATA, useValue: { shaderId: 'waves', name: 'Waves' } },
        { provide: MatDialogRef, useValue: { close } },
        { provide: ShaderApi, useValue: api },
        { provide: WorkspaceActions, useValue: workspace },
        {
          provide: ShaderStore,
          useValue: { record, selectedId: () => record()?.id ?? null },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function mount(): Promise<ComponentFixture<HistoryDialog>> {
    const fixture = TestBed.createComponent(HistoryDialog);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  async function settle(fixture: ComponentFixture<HistoryDialog>): Promise<void> {
    await new Promise((done) => setTimeout(done));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  const root = (fixture: ComponentFixture<HistoryDialog>) => fixture.nativeElement as HTMLElement;
  const rows = (fixture: ComponentFixture<HistoryDialog>) => [
    ...root(fixture).querySelectorAll<HTMLElement>('ol.entries > li'),
  ];

  function button(scope: HTMLElement, label: string): HTMLButtonElement {
    const found = [...scope.querySelectorAll('button')].find(
      (candidate) =>
        candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
    );
    expect(found, `button "${label}"`).toBeTruthy();
    return found!;
  }

  it('lists entries newest first with revision, cause, time, checkpoint and provenance', async () => {
    const fixture = await mount();

    expect(api.listHistory).toHaveBeenCalledWith('waves');
    expect(root(fixture).querySelector('h2')?.textContent?.trim()).toBe('History of Waves');
    expect(root(fixture).textContent).toContain('source, settings and presets');
    expect(root(fixture).textContent).toContain(
      'Textures, channel settings and the library preview are not part of history',
    );

    const [head, named, first] = rows(fixture);
    expect(head.textContent).toContain('Revision 9');
    expect(head.textContent).toContain('Current');
    expect(head.textContent).toContain('Restored from revision 4');
    expect(head.querySelector('time')?.textContent?.trim()).toMatch(/minute|ago/);
    expect(head.querySelector('time')?.getAttribute('datetime')).toBeTruthy();
    expect(button(head, 'Restore revision 9').disabled).toBe(true);
    expect(named.textContent).toContain('Before bloom');
    expect(named.textContent).toContain('Saved');
    expect(first.textContent).toContain('Created');
    expect(button(first, 'Restore revision 4').disabled).toBe(false);
  });

  it('shows loading, then an empty state that is not an error', async () => {
    let answer!: (value: ShaderHistoryEntry[]) => void;
    api.listHistory.mockReturnValueOnce(new Promise((done) => (answer = done)));
    const fixture = TestBed.createComponent(HistoryDialog);
    fixture.detectChanges();
    expect(root(fixture).querySelector('mat-progress-bar')).toBeTruthy();
    expect(rows(fixture)).toHaveLength(0);

    answer([]);
    await settle(fixture);
    expect(root(fixture).querySelector('mat-progress-bar')).toBeNull();
    expect(root(fixture).textContent).toContain('No saved states yet');
  });

  it('offers a retry after a failed load', async () => {
    api.listHistory.mockRejectedValueOnce(new ApiError('Cannot reach the server'));
    const fixture = await mount();
    expect(root(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'Cannot reach the server',
    );

    button(root(fixture), 'Try again').click();
    await settle(fixture);
    expect(rows(fixture)).toHaveLength(3);
  });

  it('names a checkpoint inline, validating first and keeping the dialog open', async () => {
    const pending = deferred<ShaderHistoryEntry>();
    api.setCheckpoint.mockReturnValueOnce(pending.promise);
    const fixture = await mount();
    const target = rows(fixture)[2];

    button(target, 'Name checkpoint').click();
    fixture.detectChanges();
    const input = target.querySelector('input')!;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    button(target, 'Save').click();
    fixture.detectChanges();
    expect(target.textContent).toContain('Use 1 to 64 characters');
    expect(api.setCheckpoint).not.toHaveBeenCalled();

    input.value = '  First light ';
    input.dispatchEvent(new Event('input'));
    button(target, 'Save').click();
    fixture.detectChanges();
    // In flight: every action is held, so nothing can be sent twice.
    expect(button(target, 'Save').disabled).toBe(true);
    expect(button(rows(fixture)[1], 'Restore revision 7').disabled).toBe(true);
    button(target, 'Save').click();
    expect(api.setCheckpoint).toHaveBeenCalledOnce();
    expect(api.setCheckpoint).toHaveBeenCalledWith('waves', 4, 'First light');

    pending.resolve(entry(4, { cause: 'create', checkpointName: 'First light' }));
    await settle(fixture);
    expect(rows(fixture)[2].textContent).toContain('First light');
    expect(rows(fixture)[2].querySelector('input')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(workspace.restoreHistory).not.toHaveBeenCalled();
  });

  it('clears a checkpoint name, and says so when that fails', async () => {
    api.setCheckpoint
      .mockRejectedValueOnce(new ApiError('Write failed'))
      .mockResolvedValueOnce(entry(7));
    const fixture = await mount();

    button(rows(fixture)[1], 'Clear checkpoint name').click();
    await settle(fixture);
    expect(root(fixture).querySelector('.notice')?.textContent).toContain(
      'Could not update the checkpoint: Write failed',
    );
    expect(rows(fixture)[1].textContent).toContain('Before bloom');

    button(rows(fixture)[1], 'Clear checkpoint name').click();
    await settle(fixture);
    expect(api.setCheckpoint).toHaveBeenLastCalledWith('waves', 7, null);
    expect(rows(fixture)[1].textContent).not.toContain('Before bloom');
  });

  it('restores through the workspace once, then shows the refreshed history', async () => {
    const pending = deferred<string>();
    workspace.restoreHistory.mockReturnValueOnce(pending.promise);
    const fixture = await mount();

    button(rows(fixture)[2], 'Restore revision 4').click();
    fixture.detectChanges();
    expect(button(rows(fixture)[2], 'Restore revision 4').disabled).toBe(true);
    button(rows(fixture)[2], 'Restore revision 4').click();
    expect(workspace.restoreHistory).toHaveBeenCalledOnce();
    expect(workspace.restoreHistory).toHaveBeenCalledWith('waves', 4);

    api.listHistory.mockResolvedValueOnce([
      entry(10, { cause: 'restore', restoredFromRevision: 4 }),
      ...(await api.listHistory.mock.results[0]!.value),
    ]);
    record.set({ id: 'waves', revision: 10 });
    pending.resolve('restored');
    await settle(fixture);
    expect(rows(fixture)[0].textContent).toContain('Revision 10');
    expect(rows(fixture)[0].textContent).toContain('Current');
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves everything alone when the unsaved-changes guard is cancelled', async () => {
    workspace.restoreHistory.mockResolvedValueOnce('cancelled');
    const fixture = await mount();

    button(rows(fixture)[2], 'Restore revision 4').click();
    await settle(fixture);
    expect(api.listHistory).toHaveBeenCalledOnce();
    expect(root(fixture).querySelector('.notice')).toBeNull();
  });

  it('explains a stale head without losing the dialog', async () => {
    workspace.restoreHistory.mockResolvedValueOnce('conflict');
    const fixture = await mount();

    button(rows(fixture)[2], 'Restore revision 4').click();
    await settle(fixture);
    expect(root(fixture).querySelector('.notice')?.textContent).toContain(
      'This shader changed since it was opened',
    );
    expect(close).not.toHaveBeenCalled();
  });

  it('offers no writes on a shared example, which the server refuses', async () => {
    record.set({ id: 'waves', revision: 9, kind: 'template' });
    const fixture = await mount();

    expect(button(rows(fixture)[2], 'Restore revision 4').disabled).toBe(true);
    expect(button(rows(fixture)[2], 'Name checkpoint').disabled).toBe(true);
  });

  it('closes rather than act on another shader once the selection moves', async () => {
    await mount();
    expect(close).not.toHaveBeenCalled();

    record.set({ id: 'plasma', revision: 1 });
    TestBed.tick();
    expect(close).toHaveBeenCalled();
  });

  it('labels every cause, in English and in French', async () => {
    api.listHistory.mockResolvedValue(CAUSES.map((cause, index) => entry(20 - index, { cause })));
    const labels = async () => {
      const fixture = await mount();
      return rows(fixture).map((row) =>
        row.querySelector('.meta')!.textContent!.split('·')[0]!.trim(),
      );
    };

    const english = await labels();
    expect(english).toEqual([
      'Restored',
      'Synced',
      'Preset deleted',
      'Preset saved',
      'Saved',
      'Before history began',
      'Duplicated',
      'Imported',
      'Created',
    ]);

    language.set(speaking('fr'));
    const french = await labels();
    expect(french).toEqual([
      'Restauration',
      'Synchronisation',
      'Préréglage supprimé',
      'Préréglage enregistré',
      'Enregistrement',
      'Avant le début de l’historique',
      'Duplication',
      'Importation',
      'Création',
    ]);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');

  it('picks the largest unit that fits', () => {
    expect(relativeTime('2026-10-08T11:58:00.000Z', now, 'en')).toBe('2 minutes ago');
    expect(relativeTime('2026-10-07T12:00:00.000Z', now, 'en')).toBe('yesterday');
    expect(relativeTime('2026-10-08T12:00:00.000Z', now, 'fr')).toBe('maintenant');
    expect(relativeTime('2026-10-08T12:00:02.000Z', now, 'en')).toBe('now');
    expect(relativeTime('not a date', now, 'en')).toBe('');
  });
});
