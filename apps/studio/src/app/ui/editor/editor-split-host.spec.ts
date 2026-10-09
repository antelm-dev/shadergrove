import {
  Component,
  forwardRef,
  input,
  output,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EDITOR_GROUP_ID,
  asEditorGroupId,
  asSplitNodeId,
  createDefaultSurface,
  editorSurfaceId,
  type EditorGroupId,
  type EditorLayoutNode,
  type SurfaceId,
} from '@shadergrove/shared/surfaces';
import { I18n } from '../../i18n/i18n';
import { SurfaceRegistry } from '../../surfaces/surface-registry';
import { EditorGroups } from './editor-groups';
import { EditorPanel } from './editor-panel';
import {
  EditorSplitHost,
  clampGroupRatio,
  layoutEditorTree,
  minEditorExtent,
  splitsFit,
} from './editor-split-host';

const A = DEFAULT_EDITOR_GROUP_ID;
const B = asEditorGroupId('editor-group:1');
const A_SURFACE = editorSurfaceId(A);
const B_SURFACE = editorSurfaceId(B);
const SPLIT = asSplitNodeId('split:b');
const leaf = (surfaceId: SurfaceId): EditorLayoutNode => ({ kind: 'leaf', surfaceId });
const TWO: EditorLayoutNode = {
  kind: 'split',
  id: SPLIT,
  axis: 'horizontal',
  ratio: 0.5,
  first: leaf(A_SURFACE),
  second: leaf(B_SURFACE),
};
const C_SURFACE = editorSurfaceId(asEditorGroupId('editor-group:2'));
// [A | [B | C]]
const NESTED: EditorLayoutNode = {
  ...TWO,
  second: {
    kind: 'split',
    id: asSplitNodeId('split:c'),
    axis: 'horizontal',
    ratio: 0.5,
    first: leaf(B_SURFACE),
    second: leaf(C_SURFACE),
  },
};

// Provided as EditorPanel so the host's panel query finds it.
@Component({
  selector: 'app-editor-panel',
  standalone: true,
  template: '',
  providers: [{ provide: EditorPanel, useExisting: forwardRef(() => EditorPanelStub) }],
})
class EditorPanelStub {
  readonly groupId = input<EditorGroupId | null>(null);
  readonly surfaceId = input<string>('');
  readonly collapsed = input(false);
  readonly dragEnabled = input(false);
  readonly explorer = input(true);
  readonly dragStart = output<PointerEvent>();

  relayout = vi.fn();
  focusEditor = vi.fn();
}

describe('layoutEditorTree', () => {
  it('places leaves and splits as fractions, with a live ratio overriding its split', () => {
    const nested: EditorLayoutNode = {
      ...TWO,
      second: {
        kind: 'split',
        id: asSplitNodeId('split:c'),
        axis: 'vertical',
        ratio: 0.25,
        first: leaf(B_SURFACE),
        second: leaf(editorSurfaceId(asEditorGroupId('editor-group:2'))),
      },
    };
    const { leaves, splits } = layoutEditorTree(nested, { id: SPLIT, ratio: 0.6 });

    expect(leaves.map(({ x, y, width, height }) => [x, y, width, height])).toEqual([
      [0, 0, 0.6, 1],
      [0.6, 0, 0.4, 0.25],
      [0.6, 0.25, 0.4, 0.75],
    ]);
    expect(splits.map((split) => [split.id, split.ratio])).toEqual([
      [SPLIT, 0.6],
      ['split:c', 0.25],
    ]);
  });
});

describe('clampGroupRatio', () => {
  it('keeps both groups at the pixel minimum as well as the fraction bounds', () => {
    expect(clampGroupRatio(0.05, 1000, 220, 220)).toBe(0.22);
    expect(clampGroupRatio(0.95, 1000, 220, 220)).toBe(0.78);
    expect(clampGroupRatio(0.95, 2000, 220, 220)).toBe(0.8);
    expect(clampGroupRatio(0.4, 1000, 220, 220)).toBe(0.4);
    // Too small for two minimums: the middle.
    expect(clampGroupRatio(0.3, 300, 220, 220)).toBe(0.5);
  });

  it('keeps a nested split side at the sum of its groups minimums', () => {
    const outer = layoutEditorTree(NESTED).splits[0]!;
    expect([outer.minFirst, outer.minSecond]).toEqual([220, 440]);
    // [A | [B | C]] in 1000px: the right side cannot go below 2 x 220.
    expect(clampGroupRatio(0.95, 1000, outer.minFirst, outer.minSecond)).toBe(0.56);
  });

  it('keeps every nested group at its minimum at an uneven nested ratio', () => {
    const uneven = { ...NESTED, second: { ...NESTED.second, ratio: 0.25 } } as EditorLayoutNode;
    // B at a quarter of the right side needs that side at 4 x 220.
    expect(layoutEditorTree(uneven).splits[0]!.minSecond).toBe(880);
    // Across the other axis a split needs only its larger side.
    expect(minEditorExtent(uneven, 'vertical')).toBe(120);
  });
});

describe('splitsFit', () => {
  const { splits } = layoutEditorTree(TWO);

  it('fits when both sides keep their minimum, and until the host is measured', () => {
    expect(splitsFit(splits, { width: 1000, height: 600 })).toBe(true);
    expect(splitsFit(splits, { width: 0, height: 0 })).toBe(true);
  });

  it('does not fit a frame too narrow for two groups side by side', () => {
    // A right-docked editor: 340px cannot hold two 220px groups.
    expect(splitsFit(splits, { width: 340, height: 900 })).toBe(false);
  });

  it('fits a ratio clamped to exactly the minimum despite floating point', () => {
    const down = layoutEditorTree({ ...TWO, axis: 'vertical', ratio: 120 / 440 });
    expect(440 * (120 / 440)).toBeLessThan(120);
    expect(splitsFit(down.splits, { width: 1000, height: 440 })).toBe(true);
  });
});

describe('EditorSplitHost', () => {
  const visibleGroupIds = signal<readonly EditorGroupId[]>([A]);
  const activeGroupId = signal<EditorGroupId | null>(A);
  const pendingFocus = signal<EditorGroupId | null>(null);
  const groups = {
    visibleGroupIds,
    activeGroupId,
    pendingFocus,
    clearFocusRequest: vi.fn(() => pendingFocus.set(null)),
    activateGroup: vi.fn(),
    commitRatio: vi.fn(),
    groupNumber: (id: EditorGroupId) => visibleGroupIds().indexOf(id) + 1,
    groupForSurface: (id: SurfaceId) => (id === A_SURFACE ? A : id === B_SURFACE ? B : null),
  };
  let registry: SurfaceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    visibleGroupIds.set([A]);
    activeGroupId.set(A);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    TestBed.resetTestingModule();
    TestBed.overrideComponent(EditorSplitHost, {
      remove: { imports: [EditorPanel] },
      add: { imports: [EditorPanelStub] },
    });
    TestBed.configureTestingModule({
      imports: [EditorSplitHost],
      providers: [
        provideZonelessChangeDetection(),
        { provide: EditorGroups, useValue: groups },
        {
          provide: I18n,
          useValue: {
            t: (key: string, params: { n?: number } = {}) =>
              params.n === undefined ? key : `${key} ${params.n}`,
          },
        },
      ],
    });
    registry = TestBed.inject(SurfaceRegistry);
    registry.setViewport({ width: 1200, height: 800 });
    registry.upsert(createDefaultSurface('editor', { id: A_SURFACE }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  function showSplit(): void {
    registry.upsert(
      createDefaultSurface('editor', {
        id: B_SURFACE,
        chrome: { kind: 'editor', editorGroupId: B },
      }),
    );
    registry.setEditorLayout(TWO);
    visibleGroupIds.set([A, B]);
  }

  function mount() {
    const fixture = TestBed.createComponent(EditorSplitHost);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const panels = () =>
      fixture.debugElement
        .queryAll(By.directive(EditorPanelStub))
        .map((el) => el.componentInstance as EditorPanelStub);
    return { fixture, host, panels };
  }

  it('shows the lone legacy panel, unbound, when there is no split', () => {
    const { host, panels } = mount();

    expect(panels()).toHaveLength(1);
    expect(panels()[0]!.groupId()).toBeNull();
    expect(panels()[0]!.explorer()).toBe(true);
    expect(host.querySelector('[role="region"]')).toBeNull();
    expect(host.querySelector('[role="separator"]')).toBeNull();
  });

  it('binds one panel per shown group, labelled, with the explorer in the first only', () => {
    showSplit();
    const { host, panels } = mount();

    expect(panels().map((panel) => panel.groupId())).toEqual([A, B]);
    expect(panels().map((panel) => panel.explorer())).toEqual([true, false]);
    expect(panels().every((panel) => panel.surfaceId() === A_SURFACE)).toBe(true);
    const regions = [...host.querySelectorAll('[role="region"]')];
    expect(regions.map((region) => region.getAttribute('aria-label'))).toEqual([
      'editor.groupLabel 1',
      'editor.groupLabel 2',
    ]);
    expect((regions[1] as HTMLElement).style.left).toBe('50%');
  });

  it('keeps the default group panel instance when the split opens and closes', () => {
    const { fixture, panels } = mount();
    const lone = panels()[0];

    showSplit();
    fixture.detectChanges();
    expect(panels()[0]).toBe(lone);

    registry.setEditorLayout(leaf(A_SURFACE));
    visibleGroupIds.set([A]);
    fixture.detectChanges();
    expect(panels()[0]).toBe(lone);
  });

  it('previews a pointer resize and commits only the released ratio', () => {
    showSplit();
    const { fixture, host } = mount();
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    } as DOMRect);
    const bar = host.querySelector('[role="separator"]') as HTMLElement;
    expect(bar.getAttribute('aria-orientation')).toBe('vertical');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');

    const pointer = (type: string, clientX: number) =>
      bar.dispatchEvent(
        Object.assign(new MouseEvent(type, { clientX, button: 0, bubbles: true }), {
          pointerId: 1,
        }),
      );
    pointer('pointerdown', 500);
    pointer('pointermove', 700);
    fixture.detectChanges();
    expect(groups.commitRatio).not.toHaveBeenCalled();
    expect(bar.getAttribute('aria-valuenow')).toBe('70');
    expect(registry.editorLayout()).toBe(TWO);

    pointer('pointermove', 990);
    pointer('pointerup', 990);
    expect(groups.commitRatio).toHaveBeenCalledTimes(1);
    // 220px minimum for the right group in 1000px.
    expect(groups.commitRatio).toHaveBeenCalledWith(SPLIT, 0.78);
  });

  it('clamps a drag against a nested split and never stacks while dragging', () => {
    showSplit();
    registry.setEditorLayout(NESTED);
    const { fixture, host } = mount();
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    } as DOMRect);
    const bar = host.querySelector('[data-split-id="split:b"]') as HTMLElement;
    const pointer = (type: string, clientX: number) =>
      bar.dispatchEvent(
        Object.assign(new MouseEvent(type, { clientX, button: 0, bubbles: true }), {
          pointerId: 1,
        }),
      );

    pointer('pointerdown', 500);
    pointer('pointermove', 990);
    fixture.detectChanges();
    expect(host.classList.contains('stacked')).toBe(false);
    expect(bar.getAttribute('aria-valuenow')).toBe('56');

    pointer('pointerup', 990);
    expect(groups.commitRatio).toHaveBeenCalledExactlyOnceWith(SPLIT, 0.56);
  });

  it('drops the preview, committing nothing, when the pointer capture is lost', () => {
    showSplit();
    const { fixture, host } = mount();
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    } as DOMRect);
    const bar = host.querySelector('[role="separator"]') as HTMLElement;
    const pointer = (type: string, clientX: number) =>
      bar.dispatchEvent(
        Object.assign(new MouseEvent(type, { clientX, button: 0, bubbles: true }), {
          pointerId: 1,
        }),
      );

    pointer('pointerdown', 500);
    pointer('pointermove', 700);
    bar.dispatchEvent(new Event('lostpointercapture'));
    pointer('pointerup', 700);
    fixture.detectChanges();

    expect(groups.commitRatio).not.toHaveBeenCalled();
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('drops a drag whose splitter goes away with the split', () => {
    showSplit();
    const { fixture, host } = mount();
    const bar = host.querySelector('[role="separator"]') as HTMLElement;
    bar.dispatchEvent(
      Object.assign(new MouseEvent('pointerdown', { clientX: 500, button: 0 }), { pointerId: 1 }),
    );

    registry.setViewport({ width: 600, height: 800 });
    fixture.detectChanges();
    expect(host.querySelector('[role="separator"]')).toBeNull();
    registry.setViewport({ width: 1200, height: 800 });
    fixture.detectChanges();

    expect(host.querySelector('.splitter.dragging')).toBeNull();
    expect(groups.commitRatio).not.toHaveBeenCalled();
  });

  it('resizes from the keyboard, committing each step', () => {
    showSplit();
    const { host } = mount();
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 600,
    } as DOMRect);
    const bar = host.querySelector('[role="separator"]') as HTMLElement;

    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));

    expect(groups.commitRatio.mock.calls).toEqual([
      [SPLIT, 0.55],
      [SPLIT, 0.22],
    ]);
  });

  it('stacks the groups in one column below the compact breakpoint, keeping the tree', () => {
    showSplit();
    registry.setViewport({ width: 600, height: 800 });
    const { host, panels } = mount();

    expect(host.classList.contains('stacked')).toBe(true);
    expect(panels()).toHaveLength(2);
    expect(host.querySelector('[role="separator"]')).toBeNull();
    expect((host.querySelector('.leaf') as HTMLElement).style.left).toBe('');
    expect(registry.editorLayout()).toBe(TWO);
  });

  it('activates a group when focus enters it and focuses a new group editor', () => {
    showSplit();
    const { fixture, host, panels } = mount();

    host.querySelectorAll('.leaf')[1]!.dispatchEvent(new Event('focusin'));
    expect(groups.activateGroup).toHaveBeenCalledWith(B);

    pendingFocus.set(B);
    fixture.detectChanges();
    TestBed.tick();
    expect(groups.clearFocusRequest).toHaveBeenCalled();
    expect(panels()[1]!.focusEditor).toHaveBeenCalled();
  });
});
