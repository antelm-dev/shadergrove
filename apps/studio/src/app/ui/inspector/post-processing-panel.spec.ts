import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import {
  DEFAULT_RENDER,
  createBloomEffect,
  createCustomEffect,
  createVignetteEffect,
  findPostProcessingEffect,
  getBloomEffect,
  type CustomEffect,
  type PostProcessingEffect,
  type RenderSettings,
  type VignetteEffect,
} from '@shadergrove/shared/model';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages } from '../../i18n/testing/languages';
import { Preferences, createDefaultWorkspacePreferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { CustomEffectEditor } from './custom-effect-editor';
import { PostProcessingPanel } from './post-processing-panel';

/** Fires a real `input` + `change` cycle on a native input, the way a slider drag does. */
function setInputValue(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, String(value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** `mat-slide-toggle`'s host carries the test id, but its inner `button[role="switch"]` is what's clickable. */
function clickToggle(host: Element): void {
  host.querySelector<HTMLButtonElement>('button[role="switch"]')!.click();
}

function chain(...effects: PostProcessingEffect[]): { render: RenderSettings } {
  return { render: { postProcessing: { enabled: true, effects } } };
}

const gain = (instanceId: string, value: number): CustomEffect =>
  createCustomEffect({
    instanceId,
    enabled: true,
    name: `Gain ${instanceId}`,
    controls: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
    values: { gain: value },
  });

describe('PostProcessingPanel', () => {
  const draft = signal<{ render: RenderSettings } | null>({ render: DEFAULT_RENDER });
  const diagnostics = signal<readonly CompileDiagnostic[]>([]);
  const dialog = { open: vi.fn() };

  beforeEach(async () => {
    draft.set({ render: DEFAULT_RENDER });
    diagnostics.set([]);
    dialog.open.mockReset();

    await TestBed.configureTestingModule({
      imports: [PostProcessingPanel],
      providers: [
        provideZonelessChangeDetection(),
        provideTestLanguages(),
        I18n,
        {
          provide: Preferences,
          useValue: {
            value: signal(createDefaultWorkspacePreferences()).asReadonly(),
            patch: () => {},
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            draft: draft.asReadonly(),
            allDiagnostics: diagnostics.asReadonly(),
            setRender: (render: RenderSettings) => draft.set({ render }),
          },
        },
        { provide: MatDialog, useValue: dialog },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function create() {
    const fixture = TestBed.createComponent(PostProcessingPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const effects = () => draft()!.render.postProcessing.effects;
  const ids = () => effects().map((effect) => effect.instanceId);
  const rowIds = (root: HTMLElement) =>
    [...root.querySelectorAll('.effect')].map((row) => row.getAttribute('data-testid'));
  const button = (root: HTMLElement, id: string) =>
    root.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;

  /** Duplicate, reset and remove live in each row's "more actions" menu, rendered in the overlay. */
  function fromRowMenu(
    root: HTMLElement,
    fixture: { detectChanges(): void },
    action: 'duplicate' | 'reset' | 'remove',
    instanceId: string,
  ): void {
    button(root, `pp-more-${instanceId}`).click();
    fixture.detectChanges();
    document
      .querySelector<HTMLButtonElement>(`[data-testid="pp-${action}-${instanceId}"]`)!
      .click();
    fixture.detectChanges();
  }

  function addFromMenu(root: HTMLElement, fixture: { detectChanges(): void }, type: string): void {
    // mat-menu content renders into the CDK overlay container (document.body).
    button(root, 'pp-add').click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>(`[data-testid="pp-add-${type}"]`)!.click();
    fixture.detectChanges();
  }

  it('renders one row per instance, keyed by its id', async () => {
    const fixture = await create();
    expect(rowIds(fixture.nativeElement)).toEqual(['pp-effect-bloom']);
  });

  it('adds a second instance of a type already in the chain, and removes just that one', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    addFromMenu(root, fixture, 'bloom');

    expect(effects().map((e) => e.type)).toEqual(['bloom', 'bloom']);
    const added = ids()[1]!;
    expect(added).not.toBe('bloom');
    expect(effects()[1]!.enabled).toBe(true);
    // Two of a type are told apart by name too, for screen readers.
    expect(button(root, `pp-more-${added}`).getAttribute('aria-label')).toBe(
      'More actions for Bloom 2',
    );

    fromRowMenu(root, fixture, 'remove', added);

    expect(ids()).toEqual(['bloom']);
    expect(rowIds(root)).toEqual(['pp-effect-bloom']);
  });

  it('stops offering to add or duplicate once the chain is full', async () => {
    draft.set(
      chain(...Array.from({ length: 16 }, (_, i) => createBloomEffect({ instanceId: `b${i}` }))),
    );
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    expect(button(root, 'pp-add').disabled).toBe(true);
    expect(root.querySelector('[data-testid="pp-full"]')).not.toBeNull();
    button(root, 'pp-more-b0').click();
    fixture.detectChanges();
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="pp-duplicate-b0"]')!.disabled,
    ).toBe(true);
  });

  it('duplicates an instance right after itself, with its settings and a new id', async () => {
    draft.set(chain(createVignetteEffect({ enabled: true, intensity: 0.8 }), createBloomEffect()));
    const fixture = await create();

    fromRowMenu(fixture.nativeElement, fixture, 'duplicate', 'vignette');

    expect(effects().map((e) => e.type)).toEqual(['vignette', 'vignette', 'bloom']);
    expect((effects()[1] as VignetteEffect).settings.intensity).toBe(0.8);
    expect(new Set(ids()).size).toBe(3);
  });

  it('moves one of two same-type instances, and the DOM order follows it', async () => {
    draft.set(
      chain(
        createVignetteEffect({ instanceId: 'v1' }),
        createBloomEffect(),
        createVignetteEffect({ instanceId: 'v2' }),
      ),
    );
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    button(root, 'pp-move-up-v2').click();
    fixture.detectChanges();

    expect(ids()).toEqual(['v1', 'v2', 'bloom']);
    expect(rowIds(root)).toEqual(['pp-effect-v1', 'pp-effect-v2', 'pp-effect-bloom']);
  });

  it('drops a dragged row where the target row is, even several rows away', async () => {
    draft.set(chain(gain('a', 1), gain('b', 1), gain('c', 1)));
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    const row = (id: string) => root.querySelector(`[data-testid="pp-effect-${id}"]`)!;
    const drag = (from: string, to: string) => {
      row(from).dispatchEvent(new Event('dragstart'));
      row(to).dispatchEvent(new Event('drop'));
      fixture.detectChanges();
    };

    drag('a', 'c');
    expect(ids()).toEqual(['b', 'c', 'a']);
    drag('a', 'b');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('master toggle flips only postProcessing.enabled, leaving effects untouched', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    const before = effects();

    clickToggle(root.querySelector('[data-testid="pp-master-toggle"]')!);
    fixture.detectChanges();

    expect(draft()!.render.postProcessing.enabled).toBe(false);
    expect(effects()).toEqual(before);
  });

  it('per-effect enable toggles only that instance', async () => {
    draft.set(
      chain(createBloomEffect({ instanceId: 'b1' }), createBloomEffect({ instanceId: 'b2' })),
    );
    const fixture = await create();

    clickToggle(fixture.nativeElement.querySelector('[data-testid="pp-enable-b2"]')!);
    fixture.detectChanges();

    expect(effects().map((e) => e.enabled)).toEqual([false, true]);
  });

  it('reset restores an instance to its type defaults, keeping enabled state and position', async () => {
    draft.set(
      chain(createBloomEffect({ enabled: false, strength: 1.9, radius: 0.9, threshold: 0.1 })),
    );
    const fixture = await create();

    fromRowMenu(fixture.nativeElement, fixture, 'reset', 'bloom');

    const bloom = getBloomEffect(draft()!.render);
    expect(bloom.enabled).toBe(false);
    expect(bloom.settings).toEqual({ strength: 0.3, radius: 0.5, threshold: 0.85 });
  });

  it('two rapid settings edits on the same effect both survive — neither clobbers the other', async () => {
    draft.set(chain(createBloomEffect(), createVignetteEffect({ enabled: true })));
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    const row = root.querySelector('[data-testid="pp-effect-vignette"]')!;
    const [intensity, softness] = [
      ...row.querySelectorAll<HTMLInputElement>('input[type="range"]'),
    ];

    setInputValue(intensity!, 0.9);
    setInputValue(softness!, 0.15);
    fixture.detectChanges();

    const vignette = findPostProcessingEffect(draft()!.render, 'vignette') as VignetteEffect;
    expect(vignette.settings).toEqual({ intensity: 0.9, softness: 0.15, roundness: 1 });
  });

  // ---------------------------------------------------------------------------
  // Custom effects
  // ---------------------------------------------------------------------------

  it("sets each custom instance's own values, with its own name", async () => {
    draft.set(chain(gain('a', 0.5), gain('b', 1.5)));
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="pp-effect-a"]')!.getAttribute('aria-label')).toBe(
      'Gain a',
    );

    setInputValue(root.querySelector<HTMLInputElement>('[data-testid="pp-value-b-gain"]')!, 0.25);
    fixture.detectChanges();

    expect(effects().map((e) => (e as CustomEffect).values['gain'])).toEqual([0.5, 0.25]);
  });

  it('adding a custom effect opens its editor; the code button reopens it', async () => {
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    addFromMenu(root, fixture, 'custom');

    const added = effects()[1] as CustomEffect;
    expect(added.type).toBe('custom');
    expect(dialog.open).toHaveBeenCalledWith(
      CustomEffectEditor,
      expect.objectContaining({
        data: { instanceId: added.instanceId },
      }),
    );

    fixture.detectChanges();
    button(root, `pp-edit-${added.instanceId}`).click();
    expect(dialog.open).toHaveBeenCalledTimes(2);
  });

  it("shows a custom effect's compile error with its line, and only on that effect", async () => {
    draft.set(chain(gain('a', 1), gain('b', 1)));
    diagnostics.set([
      {
        severity: 'error',
        line: 3,
        message: "'x' : undeclared identifier",
        source: 'fragment',
        docId: '@effect/b',
      },
    ]);
    const fixture = await create();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="pp-error-a"]')).toBeNull();
    expect(root.querySelector('[data-testid="pp-error-b"]')!.textContent!.trim()).toBe(
      "Line 3: 'x' : undeclared identifier",
    );
  });

  it('explains a custom effect from a newer API instead of hiding it', async () => {
    const future = gain('f', 1);
    future.definition.apiVersion = 3;
    draft.set(chain(future));
    const fixture = await create();

    expect(
      fixture.nativeElement.querySelector('[data-testid="pp-unsupported-f"]')!.textContent,
    ).toContain('v3');
  });
});
