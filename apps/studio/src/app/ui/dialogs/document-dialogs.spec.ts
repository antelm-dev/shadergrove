import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { I18n } from '../../i18n/i18n';
import { explorerProject } from '../../workspace/testing/fake-session';
import { DocumentDialogs, bufferConsumers } from './document-dialogs';

describe('DocumentDialogs', () => {
  let answer: unknown;
  const open = vi.fn((_component: unknown, _config: { data: Record<string, unknown> }) => ({
    afterClosed: () => of(answer),
  }));

  beforeEach(() => {
    open.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: MatDialog, useValue: { open } },
        {
          provide: I18n,
          useValue: {
            t: (key: string, params?: Record<string, unknown>) =>
              params ? `${key}${JSON.stringify(params)}` : key,
            formatList: (names: string[]) => names.join(' & '),
          },
        },
      ],
    });
  });

  const dialogs = () => TestBed.inject(DocumentDialogs);
  const message = () => open.mock.calls.at(-1)?.[1].data['message'];

  it('names the passes a buffer feeds, and only those', () => {
    const project = explorerProject();
    expect(bufferConsumers(project, 'buf-a')).toEqual(['Buffer B']);
    expect(bufferConsumers(project, 'buf-b')).toEqual([]);
  });

  it('says what deleting a buffer unbinds, and nothing of the kind for a file', async () => {
    answer = true;
    expect(await dialogs().confirmDelete({ kind: 'pass', name: 'Buffer A' }, ['B', 'C'])).toBe(
      true,
    );
    expect(message()).toBe(
      'dialog.deleteBufferMessage{"name":"Buffer A"}dialog.deleteBufferConsumersMany{"names":"B & C"}',
    );

    answer = undefined;
    expect(await dialogs().confirmDelete({ kind: 'file', name: 'noise.glsl' }, [])).toBe(false);
    expect(message()).toBe('dialog.deleteFileMessage{"name":"noise.glsl"}');
  });

  it('gives a new name only when one was given and it changed', async () => {
    const doc = { kind: 'file' as const, name: 'noise.glsl' };
    answer = { value: 'hash.glsl', checked: false };
    expect(await dialogs().askRename(doc)).toBe('hash.glsl');
    answer = { value: 'noise.glsl', checked: false };
    expect(await dialogs().askRename(doc)).toBeUndefined();
    answer = undefined;
    expect(await dialogs().askNewFileName()).toBeUndefined();
  });
});
