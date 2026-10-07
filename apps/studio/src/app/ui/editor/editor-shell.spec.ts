import { Component, input, output, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_EDITOR_GROUP_ID,
  asEditorGroupId,
  createDefaultSurface,
  editorSurfaceId,
  type EditorGroupId,
} from '@shadergrove/shared/surfaces';
import { ReducedMotion } from '../../prefs/reduced-motion';
import { SurfaceLayoutService, SurfaceRegistry } from '../../surfaces';
import { EditorGroups } from './editor-groups';
import { EditorPanel } from './editor-panel';
import { EditorShell } from './editor-shell';

const SECOND_GROUP = asEditorGroupId('editor-group:second');
const DEFAULT_SURFACE = editorSurfaceId(DEFAULT_EDITOR_GROUP_ID);
const SECOND_SURFACE = editorSurfaceId(SECOND_GROUP);

@Component({ selector: 'app-editor-panel', standalone: true, template: '' })
class EditorPanelStub {
  readonly groupId = input<EditorGroupId>(DEFAULT_EDITOR_GROUP_ID);
  readonly surfaceId = input<string>('');
  readonly collapsed = input(false);
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  relayout(): void {}
  focusEditor(): void {}
}

describe('EditorShell group identity', () => {
  const groupIds = signal<readonly EditorGroupId[]>([DEFAULT_EDITOR_GROUP_ID]);
  const activeGroupId = signal<EditorGroupId | null>(DEFAULT_EDITOR_GROUP_ID);
  const groups = { groupIds, activeGroupId, activateGroup: vi.fn() };
  const layout = { zIndex: () => 7, activate: vi.fn() };
  let registry: SurfaceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    groupIds.set([DEFAULT_EDITOR_GROUP_ID]);
    activeGroupId.set(DEFAULT_EDITOR_GROUP_ID);
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );

    TestBed.resetTestingModule();
    TestBed.overrideComponent(EditorShell, {
      remove: { imports: [EditorPanel] },
      add: { imports: [EditorPanelStub] },
    });
    TestBed.configureTestingModule({
      imports: [EditorShell],
      providers: [
        provideZonelessChangeDetection(),
        { provide: EditorGroups, useValue: groups },
        { provide: SurfaceLayoutService, useValue: layout },
        { provide: ReducedMotion, useValue: { enabled: signal(true) } },
      ],
    });

    registry = TestBed.inject(SurfaceRegistry);
    registry.upsert(createDefaultSurface('editor', { id: DEFAULT_SURFACE }));
    registry.upsert(
      createDefaultSurface('editor', {
        id: SECOND_SURFACE,
        chrome: { kind: 'editor', editorGroupId: SECOND_GROUP },
        placement: {
          host: 'contained',
          mode: 'floating',
          rect: { x: 10, y: 20, width: 320, height: 240 },
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  function mount(groupId?: EditorGroupId) {
    const fixture = TestBed.createComponent(EditorShell);
    if (groupId) fixture.componentRef.setInput('groupId', groupId);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const panel = fixture.debugElement.query(By.directive(EditorPanelStub))
      .componentInstance as EditorPanelStub;
    return { fixture, host, panel };
  }

  it('means the default group and surface when no input is supplied', () => {
    const { host, panel } = mount();

    expect(host.getAttribute('aria-label')).toBe('Source editor');
    expect(host.dataset['surfaceId']).toBe(DEFAULT_SURFACE);
    expect(host.dataset['editorGroup']).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(panel.groupId()).toBe(DEFAULT_EDITOR_GROUP_ID);
    expect(panel.surfaceId()).toBe(DEFAULT_SURFACE);
    expect(host.classList.contains('docked')).toBe(true);
  });

  it('frames each group with its own surface geometry and labels', () => {
    groupIds.set([DEFAULT_EDITOR_GROUP_ID, SECOND_GROUP]);
    const first = mount();
    const second = mount(SECOND_GROUP);

    expect(second.panel.groupId()).toBe(SECOND_GROUP);
    expect(second.panel.surfaceId()).toBe(SECOND_SURFACE);
    expect(second.host.dataset['surfaceId']).toBe(SECOND_SURFACE);
    expect(second.host.classList.contains('floating')).toBe(true);
    expect(second.host.style.left).toBe('10px');
    expect(second.host.style.zIndex).toBe('7');
    expect(first.host.classList.contains('floating')).toBe(false);
    expect(first.host.getAttribute('aria-label')).toBe('Source editor 1');
    expect(second.host.getAttribute('aria-label')).toBe('Source editor 2');
  });

  it('activates its own surface and group, not the default ones', () => {
    groupIds.set([DEFAULT_EDITOR_GROUP_ID, SECOND_GROUP]);
    const { host } = mount(SECOND_GROUP);

    host.dispatchEvent(new Event('pointerdown'));

    expect(layout.activate).toHaveBeenCalledWith(SECOND_SURFACE);
    expect(groups.activateGroup).toHaveBeenCalledWith(SECOND_GROUP);
  });

  it('does not re-activate a group that is already active', () => {
    const { host } = mount();

    host.dispatchEvent(new Event('pointerdown'));

    expect(groups.activateGroup).not.toHaveBeenCalled();
  });
});
