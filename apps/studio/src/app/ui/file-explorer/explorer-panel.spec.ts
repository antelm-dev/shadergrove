import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Preferences, type WorkspacePreferences } from '../../prefs/preferences';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import type { TranslationKey } from '../../i18n/keys';
import {
  INFORMATIONAL_CAPABILITIES,
  INACTIVE_STATUS,
  type ExplorerNode,
  type ExplorerTree,
} from './contract';
import { ExplorerPanel } from './explorer-panel';

const doc = (id: string, patch: Partial<ExplorerNode> = {}, depth = 1): ExplorerNode => ({
  id,
  kind: 'buffer-pass',
  docId: id,
  name: id,
  depth,
  children: [],
  capabilities: {
    selectable: true,
    rename: true,
    duplicate: false,
    delete: true,
    reorder: true,
    toggleEnabled: true,
    ...patch.capabilities,
  },
  status: { ...INACTIVE_STATUS, ...patch.status },
  icon: 'layers',
  ...patch,
});

const group = (id: string, labelKey: TranslationKey, children: ExplorerNode[]): ExplorerNode => ({
  id,
  kind: 'group',
  labelKey,
  depth: 0,
  children,
  capabilities: INFORMATIONAL_CAPABILITIES,
  status: INACTIVE_STATUS,
  icon: 'folder',
  defaultExpanded: true,
});

const info = (id: string, patch: Partial<ExplorerNode> = {}, depth = 1): ExplorerNode => ({
  id,
  kind: 'channel-texture',
  depth,
  children: [],
  capabilities: INFORMATIONAL_CAPABILITIES,
  status: INACTIVE_STATUS,
  icon: 'image',
  ...patch,
});

const sampleTree = (): ExplorerTree => ({
  view: 'files',
  nodes: [
    group('explorer:files:group:passes', 'explorer.group.passes', [
      doc('image', { kind: 'image-pass', name: 'Image' }),
      doc('buf-a', { name: 'Buffer A' }),
      doc('buf-b', { name: 'Buffer B' }),
    ]),
    group('explorer:files:group:project', 'explorer.group.project', [
      doc('@vertex', {
        kind: 'vertex',
        name: 'Vertex',
        capabilities: {
          selectable: true,
          rename: false,
          duplicate: false,
          delete: false,
          reorder: false,
          toggleEnabled: false,
        },
      }),
    ]),
  ],
});

const pipelineTree = (overrides: Partial<Record<string, ExplorerNode>> = {}): ExplorerTree => {
  const binding = (id: string, patch: Partial<ExplorerNode>): ExplorerNode => info(id, patch, 3);
  const channel = (id: string, channelIndex: 0 | 1 | 2 | 3, child: ExplorerNode): ExplorerNode =>
    info(
      id,
      {
        kind: 'channel',
        labelKey: `explorer.channel.${channelIndex}` as const,
        children: [child],
        icon: 'input',
      },
      2,
    );

  const texture = binding('binding-texture', {
    kind: 'channel-texture',
    labelKey: 'explorer.binding.texture',
    labelParams: { slot: 0 },
    textureSlot: 0,
  });
  const buffer = binding('binding-buffer', {
    kind: 'channel-buffer',
    labelKey: 'explorer.binding.buffer',
    labelParams: { name: 'Buffer A' },
    channelTargetPassId: 'buf-a',
    icon: 'layers',
  });
  const feedback = binding('binding-feedback', {
    kind: 'channel-feedback',
    labelKey: 'explorer.binding.feedback',
    labelParams: { name: 'Buffer B' },
    channelTargetPassId: 'buf-b',
    icon: 'replay',
  });
  const dangling = binding('binding-dangling', {
    kind: 'channel-buffer',
    labelKey: 'explorer.binding.buffer',
    labelParams: { name: { kind: 'translation', key: 'explorer.binding.missingTarget' } },
    channelTargetPassId: 'missing-buffer',
    icon: 'layers',
  });

  return {
    view: 'pipeline',
    nodes: [
      group('explorer:pipeline:group:execution', 'explorer.group.execution', [
        doc('image', {
          kind: 'image-pass',
          name: 'Image',
          children: [
            group('explorer:pipeline:image:channels', 'explorer.group.channels', [
              channel('channel-0', 0, overrides['texture'] ?? texture),
              channel('channel-1', 1, overrides['buffer'] ?? buffer),
              channel('channel-2', 2, overrides['feedback'] ?? feedback),
              channel('channel-3', 3, overrides['dangling'] ?? dangling),
            ]),
          ],
        }),
      ]),
    ],
  };
};

function dispatchDragEvent(
  target: HTMLElement,
  type: 'dragstart' | 'dragover' | 'drop',
  dataTransfer: Pick<DataTransfer, 'setData' | 'getData' | 'dropEffect' | 'effectAllowed'> = {
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: () => '',
    setData: () => undefined,
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: dataTransfer,
  });
  target.dispatchEvent(event);
}

describe('ExplorerPanel', () => {
  const language = signal(speaking('en'));
  const tree = signal<ExplorerTree>(sampleTree());
  let resizeObserverCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null;

  beforeEach(async () => {
    resizeObserverCallback = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof resizeObserverCallback) {
          resizeObserverCallback = callback as typeof resizeObserverCallback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );

    tree.set(sampleTree());
    language.set(speaking('en'));
    TestBed.configureTestingModule({
      imports: [ExplorerPanel],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        {
          provide: Preferences,
          useValue: {
            value: language.asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) => {
              language.update((value) => ({ ...value, ...patch }));
            },
          },
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  const setPanelWidth = (fixture: ReturnType<typeof mount>, width: number): void => {
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = `${width}px`;
    resizeObserverCallback?.([{ contentRect: { width } }]);
    fixture.detectChanges();
  };

  const headerControl = (fixture: ReturnType<typeof mount>, selector: string): HTMLElement => {
    return fixture.nativeElement.querySelector(selector) as HTMLElement;
  };

  const mount = () => {
    const fixture = TestBed.createComponent(ExplorerPanel);
    fixture.componentRef.setInput('tree', tree());
    fixture.detectChanges();
    resizeObserverCallback?.([{ contentRect: { width: 240 } }]);
    fixture.detectChanges();
    return fixture;
  };

  it('renders nested hierarchy with group and document rows', () => {
    const fixture = mount();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
    expect(element.textContent).toContain('Image');
    expect(element.textContent).toContain('Buffer A');
  });

  it('emits select when a selectable row is clicked', () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const row = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(select).toHaveBeenCalledWith({ docId: 'buf-a' });
  });

  it('does not emit select for informational group rows', () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const row = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"]',
    ) as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(select).not.toHaveBeenCalled();
  });

  it('emits viewChange from the header switch', () => {
    const fixture = mount();
    const viewChange = vi.fn();
    fixture.componentInstance.viewChange.subscribe(viewChange);

    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(viewChange).toHaveBeenCalledWith('pipeline');
  });

  it('collapses groups when the expand control is clicked', () => {
    const fixture = mount();
    const expand = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"] .expand',
    ) as HTMLButtonElement;
    expand.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-node-id="image"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-node-id="buf-a"]')).toBeNull();
  });

  it('emits command events for header create actions', () => {
    const fixture = mount();
    const command = vi.fn();
    fixture.componentInstance.command.subscribe(command);

    fixture.componentInstance.collapse.emit();
    fixture.componentInstance.command.emit({ command: 'create-file' });
    expect(command).toHaveBeenCalledWith({ command: 'create-file' });
  });

  it('disables buffer creation when canCreateBuffer is false', () => {
    const fixture = mount();
    fixture.componentRef.setInput('canCreateBuffer', false);
    fixture.detectChanges();
    expect(fixture.componentInstance.canCreateBuffer()).toBe(false);
  });

  it('shows loading state instead of the tree', () => {
    tree.set({ view: 'files', nodes: [], emptyReason: 'loading' });
    const fixture = mount();
    expect(fixture.nativeElement.querySelector('[role="tree"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('mat-spinner')).not.toBeNull();
  });

  it('shows no-project empty state', () => {
    tree.set({ view: 'files', nodes: [], emptyReason: 'no-project' });
    const fixture = mount();
    expect(fixture.nativeElement.querySelector('.state.empty')).not.toBeNull();
  });

  it('marks active rows with aria-selected', () => {
    tree.set({
      ...sampleTree(),
      nodes: [
        group('explorer:files:group:passes', 'explorer.group.passes', [
          doc('image', {
            kind: 'image-pass',
            name: 'Image',
            status: { ...INACTIVE_STATUS, active: true },
          }),
        ]),
      ],
    });
    const fixture = mount();
    const active = fixture.nativeElement.querySelector('[data-node-id="image"]') as HTMLElement;
    expect(active.getAttribute('aria-selected')).toBe('true');
  });

  it('emits rename command on double-click when allowed', () => {
    const fixture = mount();
    const command = vi.fn();
    fixture.componentInstance.command.subscribe(command);

    const row = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    expect(command).toHaveBeenCalledWith({ command: 'rename', docId: 'buf-a' });
  });

  it('emits reorder intent for compatible drag-and-drop', () => {
    const fixture = mount();
    const reorder = vi.fn();
    fixture.componentInstance.reorder.subscribe(reorder);

    const source = fixture.nativeElement.querySelector('[data-node-id="buf-a"]') as HTMLElement;
    const target = fixture.nativeElement.querySelector('[data-node-id="buf-b"]') as HTMLElement;

    const dataTransfer: Pick<DataTransfer, 'setData' | 'getData' | 'dropEffect' | 'effectAllowed'> =
      {
        dropEffect: 'none',
        effectAllowed: 'all',
        getData: () => '',
        setData: () => undefined,
      };
    dispatchDragEvent(source, 'dragstart', dataTransfer);
    dispatchDragEvent(target, 'drop', dataTransfer);
    fixture.detectChanges();

    expect(reorder).toHaveBeenCalledWith({
      sourceDocId: 'buf-a',
      targetDocId: 'buf-b',
      list: 'buffer',
    });
  });

  it('activates rows on Enter via keyboard handler', async () => {
    const fixture = mount();
    const select = vi.fn();
    fixture.componentInstance.select.subscribe(select);

    const treeRoot = fixture.nativeElement.querySelector('#explorer-tree') as HTMLElement;
    treeRoot.focus();
    treeRoot.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    fixture.detectChanges();

    const groupRow = fixture.nativeElement.querySelector(
      '[data-node-id="explorer:files:group:passes"]',
    ) as HTMLElement;
    groupRow.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    fixture.detectChanges();

    const focusedRow = fixture.nativeElement.querySelector('[data-node-id="image"]') as HTMLElement;
    focusedRow.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    expect(select).toHaveBeenCalledWith({ docId: 'image' });
  });

  it('renders texture binding labels with resolved English and French slots', async () => {
    tree.set(pipelineTree());
    const fixture = mount();
    let row = fixture.nativeElement.querySelector(
      '[data-node-id="binding-texture"] .label',
    ) as HTMLElement;
    expect(row.textContent?.trim()).toBe('Texture slot 0');
    expect(row.textContent).not.toContain('{slot}');

    language.set(speaking('fr'));
    fixture.detectChanges();

    row = fixture.nativeElement.querySelector(
      '[data-node-id="binding-texture"] .label',
    ) as HTMLElement;
    expect(row.textContent?.trim()).toBe('Emplacement texture 0');
    expect(row.textContent).not.toContain('{slot}');
  });

  it('renders resolved buffer and feedback binding labels and distinct kinds', () => {
    tree.set(pipelineTree());
    const fixture = mount();
    const bufferRow = fixture.nativeElement.querySelector(
      '[data-node-id="binding-buffer"]',
    ) as HTMLElement;
    const feedbackRow = fixture.nativeElement.querySelector(
      '[data-node-id="binding-feedback"]',
    ) as HTMLElement;

    expect(bufferRow.querySelector('.label')?.textContent?.trim()).toBe('Buffer “Buffer A”');
    expect(feedbackRow.querySelector('.label')?.textContent?.trim()).toBe(
      'Feedback from “Buffer B”',
    );
    expect(bufferRow.dataset['nodeId']).toBe('binding-buffer');
    expect(feedbackRow.dataset['nodeId']).toBe('binding-feedback');
  });

  it('updates rendered binding labels when the target name changes', () => {
    tree.set(pipelineTree());
    const fixture = mount();

    tree.set(
      pipelineTree({
        buffer: info(
          'binding-buffer',
          {
            kind: 'channel-buffer',
            labelKey: 'explorer.binding.buffer',
            labelParams: { name: 'Velocity Buffer' },
            channelTargetPassId: 'buf-a',
            icon: 'layers',
          },
          3,
        ),
      }),
    );
    fixture.componentRef.setInput('tree', tree());
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector(
      '[data-node-id="binding-buffer"] .label',
    ) as HTMLElement;
    expect(row.textContent?.trim()).toBe('Buffer “Velocity Buffer”');
  });

  it('renders localized fallback labels for dangling targets without placeholders', async () => {
    tree.set(pipelineTree());
    const fixture = mount();
    let row = fixture.nativeElement.querySelector(
      '[data-node-id="binding-dangling"] .label',
    ) as HTMLElement;
    expect(row.textContent?.trim()).toBe('Buffer “missing target”');
    expect(row.textContent).not.toContain('{name}');

    language.set(speaking('fr'));
    fixture.detectChanges();

    row = fixture.nativeElement.querySelector(
      '[data-node-id="binding-dangling"] .label',
    ) as HTMLElement;
    expect(row.textContent?.trim()).toBe('Buffer « cible manquante »');
    expect(row.textContent).not.toContain('{name}');
  });

  it('uses resolved labels in accessible names', () => {
    tree.set(pipelineTree());
    const fixture = mount();
    const texture = fixture.nativeElement.querySelector(
      '[data-node-id="binding-texture"]',
    ) as HTMLElement;
    const buffer = fixture.nativeElement.querySelector(
      '[data-node-id="binding-buffer"]',
    ) as HTMLElement;
    const feedback = fixture.nativeElement.querySelector(
      '[data-node-id="binding-feedback"]',
    ) as HTMLElement;
    const dangling = fixture.nativeElement.querySelector(
      '[data-node-id="binding-dangling"]',
    ) as HTMLElement;

    expect(texture.getAttribute('aria-label')).toContain('Texture slot 0');
    expect(buffer.getAttribute('aria-label')).toContain('Buffer “Buffer A”');
    expect(feedback.getAttribute('aria-label')).toContain('Feedback from “Buffer B”');
    expect(dangling.getAttribute('aria-label')).toContain('Buffer “missing target”');
    expect(texture.getAttribute('aria-label')).not.toContain('{slot}');
    expect(buffer.getAttribute('aria-label')).not.toContain('{name}');
    expect(feedback.getAttribute('aria-label')).not.toContain('{name}');
    expect(dangling.getAttribute('aria-label')).not.toContain('{name}');
  });

  describe('responsive header', () => {
    it.each([
      { width: 180, iconTabs: true, compact: true },
      { width: 240, iconTabs: true, compact: true },
      { width: 400, iconTabs: false, compact: false },
    ])('keeps header controls reachable at ${width}px', ({ width, iconTabs, compact }) => {
      const fixture = mount();
      setPanelWidth(fixture, width);
      const host = fixture.nativeElement as HTMLElement;

      expect(host.classList.contains('explorer-icon-view-tabs')).toBe(iconTabs);
      expect(host.classList.contains('explorer-header-compact')).toBe(compact);

      const tabs = host.querySelectorAll('[role="tab"]');
      expect(tabs).toHaveLength(2);
      expect(headerControl(fixture, '.create')).not.toBeNull();
      expect(headerControl(fixture, '.collapse')).not.toBeNull();

      for (const tab of tabs) {
        expect(tab.getAttribute('aria-selected')).toMatch(/true|false/);
        expect(tab.getAttribute('aria-label')).toBeTruthy();
      }
    });

    it('emits viewChange from compact icon tabs at 180px', () => {
      const fixture = mount();
      setPanelWidth(fixture, 180);
      const viewChange = vi.fn();
      fixture.componentInstance.viewChange.subscribe(viewChange);

      const pipelineTab = fixture.nativeElement.querySelectorAll(
        '[role="tab"]',
      )[1] as HTMLButtonElement;
      pipelineTab.click();
      fixture.detectChanges();

      expect(viewChange).toHaveBeenCalledWith('pipeline');
      expect(pipelineTab.getAttribute('aria-label')).toContain('Pipeline');
    });

    it('shows text view tabs and title at 400px', () => {
      const fixture = mount();
      setPanelWidth(fixture, 400);
      const host = fixture.nativeElement as HTMLElement;

      expect(host.classList.contains('explorer-icon-view-tabs')).toBe(false);
      expect(host.querySelector('.title')?.textContent).toContain('Project explorer');
      expect(host.querySelector('.view-tab-label')?.textContent).toContain('Files');
    });
  });

  describe('render-disabled buffers', () => {
    const disabledTree = (): ExplorerTree => ({
      view: 'files',
      nodes: [
        group('explorer:files:group:passes', 'explorer.group.passes', [
          doc('buf-disabled', {
            name: 'Buffer C',
            status: { ...INACTIVE_STATUS, disabled: true },
          }),
        ]),
      ],
    });

    it('does not set aria-disabled on render-disabled buffers', () => {
      tree.set(disabledTree());
      const fixture = mount();
      const row = fixture.nativeElement.querySelector(
        '[data-node-id="buf-disabled"]',
      ) as HTMLElement;

      expect(row.getAttribute('aria-disabled')).toBeNull();
      expect(row.getAttribute('aria-label')).toContain('Disabled');
      expect(row.classList.contains('disabled')).toBe(true);
    });

    it('keeps render-disabled buffers keyboard-selectable', async () => {
      tree.set(disabledTree());
      const fixture = mount();
      const select = vi.fn();
      fixture.componentInstance.select.subscribe(select);

      const treeRoot = fixture.nativeElement.querySelector('#explorer-tree') as HTMLElement;
      treeRoot.focus();
      treeRoot.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      fixture.detectChanges();

      const row = fixture.nativeElement.querySelector(
        '[data-node-id="buf-disabled"]',
      ) as HTMLElement;
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      fixture.detectChanges();

      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      fixture.detectChanges();

      expect(select).toHaveBeenCalledWith({ docId: 'buf-disabled' });
    });

    it('exposes Enable for render-disabled buffers via row actions', () => {
      tree.set(disabledTree());
      const fixture = mount();
      const command = vi.fn();
      fixture.componentInstance.command.subscribe(command);

      const row = fixture.nativeElement.querySelector(
        '[data-node-id="buf-disabled"]',
      ) as HTMLElement;
      const menuBtn = row.querySelector('.row-menu') as HTMLButtonElement;
      expect(menuBtn).not.toBeNull();

      menuBtn.click();
      fixture.detectChanges();

      const enableItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
        (item) => item.textContent?.includes('Enable'),
      ) as HTMLButtonElement | undefined;
      expect(enableItem).toBeDefined();
      enableItem?.click();
      fixture.detectChanges();

      expect(command).toHaveBeenCalledWith({ command: 'enable', docId: 'buf-disabled' });
    });

    it('exposes Enable for render-disabled buffers via the ContextMenu key', async () => {
      tree.set(disabledTree());
      const fixture = mount();
      const command = vi.fn();
      fixture.componentInstance.command.subscribe(command);

      const treeRoot = fixture.nativeElement.querySelector('#explorer-tree') as HTMLElement;
      const row = fixture.nativeElement.querySelector(
        '[data-node-id="buf-disabled"]',
      ) as HTMLElement;
      treeRoot.focus();
      row.focus();
      fixture.detectChanges();

      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      fixture.detectChanges();

      const enableItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
        (item) => item.textContent?.includes('Enable'),
      ) as HTMLButtonElement | undefined;
      expect(enableItem).toBeDefined();
      enableItem?.click();
      fixture.detectChanges();

      expect(command).toHaveBeenCalledWith({ command: 'enable', docId: 'buf-disabled' });
    });
  });
});
