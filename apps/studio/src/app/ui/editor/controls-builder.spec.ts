import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShaderControl } from '@shadergrove/shared/model';
import { validateControls } from '@shadergrove/shared/validate';
import { I18n } from '../../i18n/i18n';
import { controlsToText } from '../../workspace/controls-text';
import { parseControls } from '../../workspace/state/controls-schema';
import { ShaderStore } from '../../workspace/shader-store';
import { ControlsBuilder } from './controls-builder';

const SPEED: ShaderControl = { key: 'speed', type: 'number', default: 1, min: 0, max: 4 };
const GLOW: ShaderControl = { key: 'glow', type: 'boolean', folder: 'Look', default: false };
const TINT: ShaderControl = { key: 'tint', type: 'color', folder: 'Look', default: '#336699' };

function text(controls: readonly ShaderControl[]): string {
  const result = validateControls(controls);
  if (!result.ok) throw new Error(result.errors.join(' '));
  return controlsToText(result.value);
}

/** The slice of the store the builder reads: which shader, and its Config text. */
class FakeStore {
  readonly record = signal<{ id: string } | null>({ id: 'waves' });
  readonly draft = signal<{ controlsText: string } | null>({ controlsText: '[]' });

  setText(controlsText: string): void {
    this.draft.set({ controlsText });
  }
}

describe('ControlsBuilder', () => {
  let store: FakeStore;
  let committed: string[];
  let repairs: number;
  let confirmDelete: boolean;
  let openedDialogs: number;

  beforeEach(() => {
    store = new FakeStore();
    committed = [];
    repairs = 0;
    confirmDelete = true;
    openedDialogs = 0;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ControlsBuilder],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: store },
        { provide: I18n, useValue: { t: (key: string) => key } },
        {
          provide: MatDialog,
          useValue: {
            open: () => {
              openedDialogs++;
              return { afterClosed: () => of(confirmDelete) };
            },
          },
        },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  /** Mounted the way `EditorPanel` hosts it: a commit lands in the store. */
  function mount(controls: readonly ShaderControl[] = []): ComponentFixture<ControlsBuilder> {
    store.setText(text(controls));
    const fixture = TestBed.createComponent(ControlsBuilder);
    fixture.componentInstance.commit.subscribe((value) => {
      committed.push(value);
      store.setText(value);
    });
    fixture.componentInstance.repair.subscribe(() => repairs++);
    fixture.detectChanges();
    return fixture;
  }

  function el(fixture: ComponentFixture<ControlsBuilder>): HTMLElement {
    return fixture.nativeElement;
  }

  function query<T extends HTMLElement>(fixture: ComponentFixture<ControlsBuilder>, css: string) {
    return el(fixture).querySelector<T>(css);
  }

  async function click(fixture: ComponentFixture<ControlsBuilder>, css: string): Promise<void> {
    const target = query(fixture, css);
    if (!target) throw new Error(`nothing matches ${css}`);
    target.click();
    await settle(fixture);
  }

  async function type(
    fixture: ComponentFixture<ControlsBuilder>,
    css: string,
    value: string,
  ): Promise<void> {
    const input = query<HTMLInputElement>(fixture, css);
    if (!input) throw new Error(`nothing matches ${css}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  async function settle(fixture: ComponentFixture<ControlsBuilder>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }

  const schema = () => parseControls(store.draft()!.controlsText)!;
  const keys = () => schema().map((control) => control.key);

  function rows(fixture: ComponentFixture<ControlsBuilder>): string[] {
    return [...el(fixture).querySelectorAll<HTMLElement>('.select')].map(
      (row) => row.dataset['key']!,
    );
  }

  describe('authoring', () => {
    it('starts from an empty schema and creates each of the four types', async () => {
      const fixture = mount();
      expect(el(fixture).querySelector('.hint')?.textContent).toContain('builder.empty');

      for (const type of ['number', 'boolean', 'color', 'select']) {
        await click(fixture, `[data-add="${type}"]`);
      }

      expect(schema().map((control) => control.type)).toEqual([
        'number',
        'boolean',
        'color',
        'select',
      ]);
      expect(committed).toHaveLength(4);
      expect(validateControls(schema()).ok).toBe(true);
      expect(rows(fixture)).toEqual(keys());
    });

    it('counts a write as written when the editor hands it back with other line endings', async () => {
      const fixture = mount();
      fixture.componentInstance.commit.subscribe((value) =>
        store.setText(value.replace(/\n/g, '\r\n')),
      );

      await click(fixture, '[data-add="number"]');

      expect(query(fixture, '.notice.error')).toBeNull();
      expect(query(fixture, '.form')).not.toBeNull();
    });

    it('opens the form of a new control so its details can be filled in', async () => {
      const fixture = mount();
      await click(fixture, '[data-add="number"]');

      expect(query(fixture, '.form')).not.toBeNull();
      expect(query(fixture, '.uniform-line')?.textContent).toContain('builder.uniform');
      expect(query(fixture, '.select[aria-current="true"]')?.dataset['key']).toBe('value');
    });

    it('applies an edited definition in a single commit and not at all when nothing changed', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      expect((query(fixture, '.apply') as HTMLButtonElement).disabled).toBe(true);

      await type(fixture, '.f-label', 'Pace');
      await type(fixture, '.f-max', '8');
      await type(fixture, '.f-default', '6');
      expect(query(fixture, '.badge')).not.toBeNull();
      expect(committed).toEqual([]);

      await click(fixture, '.apply');

      expect(committed).toHaveLength(1);
      expect(schema()).toEqual([{ ...SPEED, label: 'Pace', max: 8, default: 6 }]);
      expect(query(fixture, '.badge')).toBeNull();
      expect((query(fixture, '.apply') as HTMLButtonElement).disabled).toBe(true);
    });

    it('applies on Enter in a field typed into before the view has caught up', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      const enter = () =>
        query(fixture, '.f-label')!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );

      expect(enter()).toBe(true);
      expect(committed).toEqual([]);
      expect(query(fixture, '.notice')).toBeNull();

      // No change detection between the keystrokes: Apply is still rendered disabled.
      const input = query<HTMLInputElement>(fixture, '.f-label')!;
      input.value = 'Pace';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect((query(fixture, '.apply') as HTMLButtonElement).disabled).toBe(true);
      expect(enter()).toBe(false);

      expect(committed).toHaveLength(1);
      expect(schema()).toEqual([{ ...SPEED, label: 'Pace' }]);
    });

    it('keeps an existing key read-only and shows its uniform and GLSL type', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');

      expect(query(fixture, '.f-key')).toBeNull();
      expect(query(fixture, '.uniform-line')?.textContent).toContain('builder.uniform');
      expect(el(fixture).querySelector('.names .uniform')?.textContent).toContain('u_speed');
      expect(el(fixture).querySelector('.names .uniform')?.textContent).toContain('float');
    });

    it('warns when a type changes and never touches the shader source', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      expect(query(fixture, '.note')).toBeNull();

      fixture.componentInstance['setType']('color');
      await settle(fixture);
      expect(query(fixture, '.note')?.textContent).toContain('builder.typeChange');

      await click(fixture, '.apply');
      expect(schema()).toEqual([{ key: 'speed', type: 'color', default: '#ffffff' }]);
    });

    it('edits select options, keeping numeric values', async () => {
      const fixture = mount([
        { key: 'mode', type: 'select', default: 1, options: { Off: 0, On: 1 } },
      ]);
      await click(fixture, '[data-key="mode"]');

      const values = el(fixture).querySelectorAll<HTMLInputElement>('.option-value');
      values[1].value = '2.5';
      values[1].dispatchEvent(new Event('input', { bubbles: true }));
      await settle(fixture);
      await click(fixture, '.option-add');
      await click(fixture, '.apply');

      expect(schema()[0]).toEqual({
        key: 'mode',
        type: 'select',
        default: 2.5,
        options: { Off: 0, On: 2.5, 'Option 3': 3.5 },
      });
    });
  });

  describe('validation', () => {
    it('shows the error on the field and refuses to apply it', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-min', '9');

      expect(query(fixture, '.f-min')?.getAttribute('aria-invalid')).toBe('true');
      expect(query(fixture, '.error')?.textContent).toContain('min');
      const before = store.draft()!.controlsText;

      await click(fixture, '.apply');

      expect(committed).toEqual([]);
      expect(store.draft()!.controlsText).toBe(before);
      expect(query(fixture, '.notice.error')?.textContent).toContain('builder.error.fix');
      expect(query(fixture, '.form')).not.toBeNull();
    });

    it('flags text that is not a number and duplicate option labels', async () => {
      const fixture = mount([
        SPEED,
        { key: 'mode', type: 'select', default: 0, options: { A: 0, B: 1 } },
      ]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-step', 'abc');
      expect(query(fixture, '.error')?.textContent).toContain('builder.error.number');

      await click(fixture, '[data-key="mode"]');
      // The guard asks first: the half-typed step is still pending.
      await click(fixture, '.guard button:nth-child(2)');
      const labels = el(fixture).querySelectorAll<HTMLInputElement>('.option-label');
      labels[1].value = 'A';
      labels[1].dispatchEvent(new Event('input', { bubbles: true }));
      await settle(fixture);

      expect(el(fixture).textContent).toContain('builder.error.optionDuplicate');
      await click(fixture, '.apply');
      expect(committed).toEqual([]);
    });

    it('preserves invalid JSON, offers the repair, and edits nothing', async () => {
      const fixture = mount([SPEED]);
      store.setText('[{"key": "speed",');
      await settle(fixture);

      expect(query(fixture, '.repair')).not.toBeNull();
      expect(query(fixture, '[data-add]')).toBeNull();
      expect(query(fixture, '.select')).toBeNull();

      await click(fixture, '.repair-action');
      expect(repairs).toBe(1);
      expect(committed).toEqual([]);
      expect(store.draft()!.controlsText).toBe('[{"key": "speed",');
    });

    it('does not mistake the last good schema for the buffer', async () => {
      const fixture = mount([SPEED]);
      store.setText('not json');
      await settle(fixture);

      fixture.componentInstance['add']('number');
      await settle(fixture);

      expect(committed).toEqual([]);
      expect(store.draft()!.controlsText).toBe('not json');
    });
  });

  describe('managing controls', () => {
    it('moves a control up and down within its group and nowhere else', async () => {
      const fixture = mount([GLOW, SPEED, TINT]);
      expect(rows(fixture)).toEqual(['glow', 'tint', 'speed']);
      expect(query<HTMLButtonElement>(fixture, '[data-move="glow:up"]')!.disabled).toBe(true);
      expect(query<HTMLButtonElement>(fixture, '[data-move="tint:down"]')!.disabled).toBe(true);

      await click(fixture, '[data-move="tint:up"]');
      expect(keys()).toEqual(['tint', 'speed', 'glow']);
      expect(rows(fixture)).toEqual(['tint', 'glow', 'speed']);

      await click(fixture, '[data-move="tint:down"]');
      expect(keys()).toEqual(['glow', 'speed', 'tint']);
      expect(committed).toHaveLength(2);
    });

    it('shows ungrouped controls under Parameters in the inspector order', async () => {
      const fixture = mount([GLOW, SPEED]);
      const titles = [...el(fixture).querySelectorAll('.group-title')].map((t) => t.textContent);
      expect(titles).toEqual(['Look', 'Parameters']);
    });

    it('duplicates with a fresh key, selecting the copy', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      await click(fixture, '.duplicate');

      expect(keys()).toEqual(['speed', 'speed2']);
      expect(query(fixture, '.select[aria-current="true"]')?.dataset['key']).toBe('speed2');
    });

    it('deletes only after confirmation', async () => {
      const fixture = mount([SPEED, GLOW]);
      await click(fixture, '[data-key="speed"]');

      // The dialog answers asynchronously (its component is loaded on demand).
      confirmDelete = false;
      await click(fixture, '.delete');
      await vi.waitFor(() => expect(openedDialogs).toBe(1));
      await settle(fixture);
      expect(keys()).toEqual(['speed', 'glow']);

      confirmDelete = true;
      await click(fixture, '.delete');
      await vi.waitFor(() => expect(keys()).toEqual(['glow']));
      await settle(fixture);
      expect(query(fixture, '.form')).toBeNull();
    });

    it('changes a control group through the folder field', async () => {
      const fixture = mount([SPEED, GLOW]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-folder', 'Look');
      await click(fixture, '.apply');

      expect(schema()[0].folder).toBe('Look');
      const titles = [...el(fixture).querySelectorAll('.group-title')].map((t) => t.textContent);
      expect(titles).toEqual(['Look']);
    });
  });

  describe('pending edits', () => {
    it('asks before a selection switch, and Cancel keeps the form', async () => {
      const fixture = mount([SPEED, GLOW]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');

      await click(fixture, '[data-key="glow"]');
      expect(query(fixture, '.guard')).not.toBeNull();
      expect(query(fixture, '.select[aria-current="true"]')?.dataset['key']).toBe('speed');

      await click(fixture, '.guard button:nth-child(3)');
      expect(query(fixture, '.guard')).toBeNull();
      expect(query<HTMLInputElement>(fixture, '.f-label')?.value).toBe('Pace');
      expect(committed).toEqual([]);
    });

    it('Discard drops the edit and continues; Apply writes it and continues', async () => {
      const fixture = mount([SPEED, GLOW]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');
      await click(fixture, '[data-key="glow"]');
      await click(fixture, '.guard button:nth-child(2)');

      expect(committed).toEqual([]);
      expect(query(fixture, '.select[aria-current="true"]')?.dataset['key']).toBe('glow');

      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');
      await click(fixture, '[data-key="glow"]');
      await click(fixture, '.guard-apply');

      expect(committed).toHaveLength(1);
      expect(schema()[0].label).toBe('Pace');
      expect(query(fixture, '.select[aria-current="true"]')?.dataset['key']).toBe('glow');
    });

    it('runs a guarded action at once when nothing is pending, and holds it otherwise', async () => {
      const fixture = mount([SPEED]);
      const action = vi.fn();

      fixture.componentInstance.guard(action);
      expect(action).toHaveBeenCalledOnce();

      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');
      fixture.componentInstance.guard(action);
      expect(action).toHaveBeenCalledOnce();
    });
  });

  describe('stale data', () => {
    it('refuses to apply over a JSON edit made while the form was open', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');

      const external = text([SPEED, GLOW]);
      store.setText(external);
      await settle(fixture);
      expect(query(fixture, '.stale')).not.toBeNull();

      await click(fixture, '.apply');

      expect(committed).toEqual([]);
      expect(store.draft()!.controlsText).toBe(external);
      expect(query(fixture, '.notice.error')?.textContent).toContain('builder.conflict');
      expect(query<HTMLInputElement>(fixture, '.f-label')?.value).toBe('');
      expect(query(fixture, '.stale')).toBeNull();
    });

    it('follows the buffer when the user has nothing pending', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');

      store.setText(text([{ ...SPEED, label: 'From JSON' }]));
      await settle(fixture);

      expect(query<HTMLInputElement>(fixture, '.f-label')?.value).toBe('From JSON');
      expect(query(fixture, '.stale')).toBeNull();
    });

    it('drops the form when the control disappears from a followed buffer', async () => {
      const fixture = mount([SPEED, GLOW]);
      await click(fixture, '[data-key="speed"]');
      store.setText(text([GLOW]));
      await settle(fixture);

      expect(query(fixture, '.form')).toBeNull();
    });

    it('clears a pending form when another shader replaces the document', async () => {
      const fixture = mount([SPEED]);
      await click(fixture, '[data-key="speed"]');
      await type(fixture, '.f-label', 'Pace');

      store.record.set({ id: 'other' });
      store.setText(text([SPEED]));
      await settle(fixture);

      expect(query(fixture, '.form')).toBeNull();
      expect(query(fixture, '.stale')).toBeNull();
      expect(committed).toEqual([]);
    });
  });
});
