import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EDITOR_GROUP_ID,
  asEditorGroupId,
  createDefaultSurface,
  editorSurfaceId,
  type SurfaceRecord,
} from '@shadergrove/shared/surfaces';
import { I18n } from '../../i18n/i18n';
import { SurfaceLayoutService, SurfaceRegistry } from '../../surfaces';
import { WorkspaceActions } from '../workspace-actions';
import { EditorGroups } from './editor-groups';
import { EditorWindowControls } from './editor-window-controls';

const DEFAULT_SURFACE = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
const SECOND_GROUP = asEditorGroupId('editor-group:second');
const SECOND_SURFACE = editorSurfaceId(SECOND_GROUP);

describe('EditorWindowControls surface identity', () => {
  const records = signal<ReadonlyMap<string, SurfaceRecord>>(new Map());
  const layout = {
    editorId: DEFAULT_SURFACE,
    editorDockSide: () => 'right' as const,
    float: vi.fn(),
    dock: vi.fn(),
    toggleMinimized: vi.fn(),
    toggleMaximized: vi.fn(),
    close: vi.fn(),
    commandContext: () => ({}),
  };
  const canCloseGroup = signal(false);
  const groups = {
    primaryGroupId: DEFAULT_EDITOR_GROUP_ID,
    canSplit: vi.fn(() => true),
    canCloseGroup,
    split: vi.fn(),
    closeGroup: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    canCloseGroup.set(false);
    records.set(
      new Map([
        [DEFAULT_SURFACE, createDefaultSurface('editor', { id: DEFAULT_SURFACE })],
        [
          SECOND_SURFACE,
          createDefaultSurface('editor', {
            id: SECOND_SURFACE,
            chrome: { kind: 'editor', editorGroupId: SECOND_GROUP },
            placement: {
              host: 'contained',
              mode: 'maximized',
              restore: { mode: 'docked', side: 'left', size: 300 },
            },
          }),
        ],
      ]),
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [EditorWindowControls],
      providers: [
        provideZonelessChangeDetection(),
        { provide: SurfaceLayoutService, useValue: layout },
        {
          provide: SurfaceRegistry,
          useValue: {
            viewport: signal({ width: 1200, height: 800 }),
            get: (id: string) => records().get(id as SurfaceRecord['id']),
          },
        },
        { provide: WorkspaceActions, useValue: { openEditorSettings: vi.fn() } },
        { provide: I18n, useValue: { t: (key: string) => key } },
        { provide: EditorGroups, useValue: groups },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  function mount(surfaceId?: string, groupId?: string) {
    const fixture = TestBed.createComponent(EditorWindowControls);
    if (surfaceId) fixture.componentRef.setInput('surfaceId', surfaceId);
    if (groupId) fixture.componentRef.setInput('groupId', groupId);
    fixture.detectChanges();
    return fixture;
  }

  function press(fixture: ReturnType<typeof mount>, label: string): void {
    const button = fixture.nativeElement.querySelector(
      `button[aria-label="${label}"]`,
    ) as HTMLButtonElement;
    button.click();
  }

  it('acts on the default surface when no surface is supplied', () => {
    const fixture = mount();

    press(fixture, 'editor.collapse');
    press(fixture, 'editor.maximize');
    press(fixture, 'editor.close');

    expect(layout.toggleMinimized).toHaveBeenCalledWith(DEFAULT_SURFACE);
    expect(layout.toggleMaximized).toHaveBeenCalledWith(DEFAULT_SURFACE);
    expect(layout.close).toHaveBeenCalledWith(DEFAULT_SURFACE);
  });

  it('acts on, and reflects, the supplied surface rather than the default one', () => {
    const fixture = mount(SECOND_SURFACE);

    // The second surface is maximized; the default one is not.
    expect(
      fixture.nativeElement.querySelector('button[aria-label="editor.restore"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('button[aria-label="editor.maximize"]')).toBeNull();

    press(fixture, 'editor.restore');
    press(fixture, 'editor.collapse');
    press(fixture, 'editor.close');

    expect(layout.toggleMaximized).toHaveBeenCalledWith(SECOND_SURFACE);
    expect(layout.toggleMinimized).toHaveBeenCalledWith(SECOND_SURFACE);
    expect(layout.close).toHaveBeenCalledWith(SECOND_SURFACE);
    expect(layout.toggleMaximized).not.toHaveBeenCalledWith(DEFAULT_SURFACE);
  });

  it('keeps two instances independent', () => {
    const first = mount();
    const second = mount(SECOND_SURFACE);

    press(first, 'editor.close');
    press(second, 'editor.close');

    expect(layout.close).toHaveBeenNthCalledWith(1, DEFAULT_SURFACE);
    expect(layout.close).toHaveBeenNthCalledWith(2, SECOND_SURFACE);
  });

  it('closes its own group, not the editor, when it sits in a split', () => {
    canCloseGroup.set(true);
    const inSplit = mount(DEFAULT_SURFACE, SECOND_GROUP);
    const lone = mount();

    press(inSplit, 'editor.closeGroup');
    expect(groups.closeGroup).toHaveBeenCalledWith(SECOND_GROUP);
    expect(layout.close).not.toHaveBeenCalled();

    // The lone legacy editor keeps hiding the whole editor.
    press(lone, 'editor.close');
    expect(layout.close).toHaveBeenCalledWith(DEFAULT_SURFACE);
  });

  it('splits its own group right or down from the window menu', () => {
    const fixture = mount(DEFAULT_SURFACE, SECOND_GROUP);
    const controls = fixture.componentInstance as unknown as {
      splitGroup(axis: 'horizontal' | 'vertical'): void;
    };

    controls.splitGroup('horizontal');
    controls.splitGroup('vertical');

    expect(groups.split).toHaveBeenNthCalledWith(1, 'horizontal', SECOND_GROUP);
    expect(groups.split).toHaveBeenNthCalledWith(2, 'vertical', SECOND_GROUP);
    expect(groups.canSplit).toHaveBeenCalledWith(SECOND_GROUP);
  });
});
