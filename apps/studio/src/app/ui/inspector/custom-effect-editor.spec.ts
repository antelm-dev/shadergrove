import { Component, input, output, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomEffect,
  findPostProcessingEffect,
  type CustomEffect,
  type RenderSettings,
} from '@shadergrove/shared/model';
import { LIMITS } from '@shadergrove/shared/validate';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import { Preferences, createDefaultWorkspacePreferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { CustomEffectEditor } from './custom-effect-editor';

/** Monaco has no place in jsdom; the dialog only needs a document in and edits out. */
@Component({ selector: 'app-code-editor', template: '' })
class StubCodeEditor {
  readonly doc = input.required<EditorDoc>();
  readonly diagnostics = input<unknown>();
  readonly appearance = input<unknown>();
  readonly valueChange = output<{ id: string; value: string }>();
}

describe('CustomEffectEditor', () => {
  const draft = signal<{ render: RenderSettings } | null>(null);
  const dialogRef = { close: vi.fn(), disableClose: false };

  beforeEach(async () => {
    vi.useFakeTimers();
    dialogRef.close.mockReset();
    dialogRef.disableClose = false;
    draft.set({
      render: {
        postProcessing: {
          enabled: true,
          effects: [createCustomEffect({ instanceId: 'c', enabled: true, name: 'Grain' })],
        },
      },
    });

    await TestBed.configureTestingModule({
      imports: [CustomEffectEditor],
      providers: [
        provideZonelessChangeDetection(),
        provideTestLanguages(),
        I18n,
        { provide: MAT_DIALOG_DATA, useValue: { instanceId: 'c' } },
        { provide: MatDialogRef, useValue: dialogRef },
        {
          provide: Preferences,
          useValue: {
            resolved: signal('dark'),
            value: signal(createDefaultWorkspacePreferences()).asReadonly(),
            patch: () => {},
          },
        },
        { provide: EditorSettings, useValue: { effective: signal({}) } },
        {
          provide: ShaderStore,
          useValue: {
            draft: draft.asReadonly(),
            allDiagnostics: signal([]),
            setRender: (render: RenderSettings) => draft.set({ render }),
          },
        },
      ],
    })
      .overrideComponent(CustomEffectEditor, {
        remove: { imports: [CodeEditor] },
        add: { imports: [StubCodeEditor] },
      })
      .compileComponents();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function create() {
    const fixture = TestBed.createComponent(CustomEffectEditor);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const editor = fixture.debugElement.query(
      (node) => node.componentInstance instanceof StubCodeEditor,
    ).componentInstance as StubCodeEditor;
    const done = () => root.querySelector<HTMLButtonElement>('[data-testid="effect-done"]')!;
    return { fixture, root, editor, done };
  }

  const effect = () => findPostProcessingEffect(draft()!.render, 'c') as CustomEffect;

  function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('writes every keystroke into the draft, so a save never misses one, and closes on Done', () => {
    const { fixture, editor, done } = create();

    editor.valueChange.emit({
      id: '@effect/c',
      value: 'vec4 effect(vec4 c, vec2 uv) { return c; }',
    });
    // No timer: Ctrl+S right now saves this code.
    expect(effect().definition.source).toContain('return c;');

    fixture.detectChanges();
    done().click();
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('refuses to close at once when the code typed is over the limit, before any debounce', () => {
    const { fixture, editor, done } = create();
    const before = effect().definition.source;

    editor.valueChange.emit({
      id: '@effect/c',
      value: 'x'.repeat(LIMITS.customEffectSourceLength + 1),
    });
    fixture.detectChanges();

    // No timer has fired: Escape and the backdrop are already blocked.
    expect(dialogRef.disableClose).toBe(true);
    expect(done().disabled).toBe(true);
    vi.advanceTimersByTime(300);
    expect(effect().definition.source).toBe(before);

    editor.valueChange.emit({
      id: '@effect/c',
      value: 'vec4 effect(vec4 c, vec2 uv) { return c; }',
    });
    fixture.detectChanges();
    expect(dialogRef.disableClose).toBe(false);
    expect(done().disabled).toBe(false);
  });

  it('refuses to close while the controls text does not validate, and applies it once it does', () => {
    const { fixture, root, done } = create();
    const controls = root.querySelector<HTMLTextAreaElement>('[data-testid="effect-controls"]')!;

    type(controls, '[{ "key": "gain", ');
    fixture.detectChanges();
    expect(dialogRef.disableClose).toBe(true);
    expect(done().disabled).toBe(true);
    expect(effect().definition.controls).toEqual([]);

    type(controls, '[{ "key": "gain", "type": "number", "default": 1, "min": 0, "max": 2 }]');
    fixture.detectChanges();
    expect(dialogRef.disableClose).toBe(false);
    expect(effect().definition.controls.map((control) => control.key)).toEqual(['gain']);
    expect(effect().values).toEqual({ gain: 1 });
  });

  it('keeps the spaces typed in a name, and trims only on blur', () => {
    const { fixture, root } = create();
    const name = root.querySelector<HTMLInputElement>('[data-testid="effect-name"]')!;

    type(name, 'Soft ');
    fixture.detectChanges();
    expect(effect().definition.name).toBe('Soft ');
    type(name, 'Soft Glow ');
    name.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(effect().definition.name).toBe('Soft Glow');
  });

  it('reverts a dropped control to the value it opened with, not its default', () => {
    draft.set({
      render: {
        postProcessing: {
          enabled: true,
          effects: [
            createCustomEffect({
              instanceId: 'c',
              enabled: true,
              controls: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
              values: { gain: 1.75 },
            }),
          ],
        },
      },
    });
    const { fixture, root } = create();

    // A valid schema without `gain` prunes its value from the draft...
    type(root.querySelector<HTMLTextAreaElement>('[data-testid="effect-controls"]')!, '[]');
    fixture.detectChanges();
    expect(effect().values).toEqual({});

    // ...and Revert brings back 1.75, not the default 1.
    root.querySelector<HTMLButtonElement>('[data-testid="effect-revert"]')!.click();
    fixture.detectChanges();
    expect(effect().values).toEqual({ gain: 1.75 });
  });

  it('reverts to the definition it opened with, clearing what was not applied', () => {
    const { fixture, root, editor } = create();
    const original = structuredClone(effect().definition);

    editor.valueChange.emit({
      id: '@effect/c',
      value: 'vec4 effect(vec4 c, vec2 uv) { return c.bgra; }',
    });
    vi.advanceTimersByTime(300);
    type(root.querySelector<HTMLTextAreaElement>('[data-testid="effect-controls"]')!, 'nope');
    fixture.detectChanges();
    expect(dialogRef.disableClose).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-testid="effect-revert"]')!.click();
    fixture.detectChanges();

    expect(effect().definition).toEqual(original);
    expect(dialogRef.disableClose).toBe(false);
  });
});
