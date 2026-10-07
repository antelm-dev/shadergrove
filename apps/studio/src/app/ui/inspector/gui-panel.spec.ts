import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShaderControl } from '@shadergrove/shared/model';
import { EditorNavigation } from '../../editor/editor-navigation';
import { I18n } from '../../i18n/i18n';
import { Preferences } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import { SurfaceLayoutService } from '../../surfaces';
import { ShaderStore } from '../../workspace/shader-store';
import { GuiPanel } from './gui-panel';

describe('GuiPanel entry to the Config builder', () => {
  const record = signal<{ id: string } | null>({ id: 'waves' });
  const controls = signal<readonly ShaderControl[]>([]);
  const calls: string[] = [];
  const openEditor = vi.fn(() => {
    calls.push('openEditor');
    return true;
  });
  const reveal = vi.fn((docId: string, line: number) => {
    calls.push(`reveal ${docId}:${line}`);
  });

  beforeEach(() => {
    calls.length = 0;
    openEditor.mockClear();
    reveal.mockClear();
    record.set({ id: 'waves' });
    controls.set([]);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [GuiPanel],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ShaderStore,
          useValue: { record, controls, params: signal({}), setParam: vi.fn() },
        },
        { provide: Preferences, useValue: { value: signal({}), patch: vi.fn() } },
        { provide: RendererHandle, useValue: { fps: signal(0) } },
        { provide: SurfaceLayoutService, useValue: { openEditor } },
        { provide: EditorNavigation, useValue: { reveal } },
        { provide: I18n, useValue: { t: (key: string) => key } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  function mount() {
    const fixture = TestBed.createComponent(GuiPanel);
    fixture.detectChanges();
    return fixture;
  }

  function button(root: HTMLElement): HTMLButtonElement | null {
    return root.querySelector<HTMLButtonElement>('.edit-controls');
  }

  it('offers a labelled Edit controls action even when the shader has no controls', () => {
    const fixture = mount();

    expect(button(fixture.nativeElement)?.textContent).toContain('inspector.editControls');
    expect(fixture.nativeElement.querySelector('.empty')?.textContent).toContain(
      'inspector.noControls',
    );
  });

  it('keeps offering it when there are controls to tune', () => {
    controls.set([{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }]);
    const fixture = mount();
    fixture.detectChanges();

    expect(button(fixture.nativeElement)).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.empty')).toBeNull();
  });

  it('is not offered with no shader open', () => {
    record.set(null);
    const fixture = mount();

    expect(button(fixture.nativeElement)).toBeNull();
  });

  it('restores the editor, then points it at the Config', () => {
    const fixture = mount();

    button(fixture.nativeElement)!.click();

    expect(calls).toEqual(['openEditor', 'reveal @config:0']);
  });
});
