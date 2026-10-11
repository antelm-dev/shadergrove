import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReducedMotion } from '../prefs/reduced-motion';
import { AppThemes } from '../themes/app-themes';
import { CodeEditor, MONACO_LOADER, type EditorDoc } from './code-editor';
import { FontLoader } from './google-fonts';
import type { MonacoApi } from './monaco-loader';
import { loadMonacoInJsdom } from './testing/jsdom-monaco';

/**
 * A model that keeps what the real one is accountable for here: its text, an
 * undo history that `setValue` throws away, and a change event that only the
 * editor currently showing it hears. Monaco itself needs a browser.
 */
class FakeModel {
  readonly edits: Array<{ range: unknown; text: string }> = [];
  stackElements = 0;
  history: string[] = [];
  readonly listeners = new Set<() => void>();
  eol: 'lf' | 'crlf' | 'default' = 'default';

  constructor(
    private text: string,
    readonly language: string,
  ) {}

  setEOL(sequence: number): void {
    this.eol = sequence === 0 ? 'lf' : 'crlf';
  }

  getValue(): string {
    return this.text;
  }

  setValue(value: string): void {
    this.text = value;
    this.history = [];
    this.fire();
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const before = this.text.slice(0, offset).split('\n');
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  }

  pushStackElement(): void {
    this.stackElements += 1;
  }

  pushEditOperations(
    _before: unknown,
    operations: Array<{
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
    }>,
  ): void {
    for (const { range, text } of operations) {
      this.edits.push({ range, text });
      const offset = (line: number, column: number) =>
        this.text
          .split('\n')
          .slice(0, line - 1)
          .join('\n').length +
        (line > 1 ? 1 : 0) +
        column -
        1;
      const from = offset(range.startLineNumber, range.startColumn);
      const to = offset(range.endLineNumber, range.endColumn);
      this.history.push(this.text);
      this.text = this.text.slice(0, from) + text + this.text.slice(to);
    }
    this.fire();
  }

  getLineCount(): number {
    return this.text.split('\n').length;
  }

  getLineContent(line: number): string {
    return this.text.split('\n')[line - 1] ?? '';
  }

  getLineFirstNonWhitespaceColumn(): number {
    return 1;
  }

  dispose(): void {}

  fire(): void {
    this.listeners.forEach((listener) => listener());
  }
}

class FakeEditor {
  model: FakeModel | null;
  private listener: (() => void) | null = null;
  private subscription: (() => void) | null = null;

  constructor(options: { model: FakeModel }) {
    this.model = options.model;
  }

  onDidChangeModelContent(listener: () => void): void {
    this.listener = listener;
    this.attach();
  }

  onDidLayoutChange(): void {}

  setModel(model: FakeModel): void {
    this.subscription?.();
    this.model = model;
    this.attach();
  }

  private attach(): void {
    this.subscription?.();
    this.subscription = null;
    if (!this.model || !this.listener) return;
    const model = this.model;
    const listener = this.listener;
    model.listeners.add(listener);
    this.subscription = () => model.listeners.delete(listener);
  }

  getModel(): FakeModel | null {
    return this.model;
  }

  saveViewState(): object {
    return {};
  }

  restoreViewState(): void {}
  updateOptions(): void {}
  layout(): void {}
  focus(): void {}
  dispose(): void {}
}

const models: FakeModel[] = [];
const fakeMonaco = {
  editor: {
    createModel: (value: string, language: string) => {
      const model = new FakeModel(value, language);
      models.push(model);
      return model;
    },
    create: (_host: unknown, options: { model: FakeModel }) => new FakeEditor(options),
    setModelMarkers: () => {},
    remeasureFonts: () => {},
    EndOfLineSequence: { LF: 0, CRLF: 1 },
  },
  MarkerSeverity: { Warning: 4, Error: 8 },
};

const CONFIG: EditorDoc = { id: '@config', language: 'json', value: '[\n  1\n]', scope: 'waves' };
const IMAGE: EditorDoc = { id: 'image', language: 'glsl', value: 'void main() {}' };

describe('CodeEditor', () => {
  let fixture: ComponentFixture<CodeEditor>;
  let emitted: Array<{ id: string; value: string }>;

  beforeEach(async () => {
    models.length = 0;
    emitted = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [CodeEditor],
      providers: [
        provideZonelessChangeDetection(),
        { provide: MONACO_LOADER, useValue: async () => fakeMonaco },
        { provide: AppThemes, useValue: { attachMonaco: vi.fn() } },
        { provide: FontLoader, useValue: { load: async () => 'idle' } },
        { provide: ReducedMotion, useValue: { enabled: signal(false) } },
      ],
    });
    fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('doc', CONFIG);
    fixture.componentInstance.valueChange.subscribe((change) => emitted.push(change));
  });

  afterEach(() => TestBed.resetTestingModule());

  async function ready(): Promise<void> {
    fixture.detectChanges();
    for (let i = 0; i < 10 && !fixture.componentInstance.ready(); i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
    }
    fixture.detectChanges();
    expect(fixture.componentInstance.ready()).toBe(true);
  }

  async function show(doc: EditorDoc): Promise<void> {
    fixture.componentRef.setInput('doc', doc);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const configModel = () => models.find((model) => model.language === 'json-lite')!;

  describe('applyEdit', () => {
    it('has no model to write into before Monaco is ready', () => {
      fixture.detectChanges();
      expect(fixture.componentInstance.applyEdit('@config', '[]')).toBe(false);
      expect(emitted).toEqual([]);
    });

    it('replaces only the span that differs, as one stack element, reporting it once', async () => {
      await ready();

      expect(fixture.componentInstance.applyEdit('@config', '[\n  2\n]')).toBe(true);

      const model = configModel();
      expect(model.getValue()).toBe('[\n  2\n]');
      expect(model.edits).toHaveLength(1);
      expect(model.edits[0]).toEqual({
        range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 4 },
        text: '2',
      });
      expect(model.stackElements).toBe(2);
      expect(emitted).toEqual([{ id: '@config', value: '[\n  2\n]' }]);
    });

    it('is a success and a silence when the text already matches', async () => {
      await ready();

      expect(fixture.componentInstance.applyEdit('@config', CONFIG.value)).toBe(true);

      expect(configModel().edits).toEqual([]);
      expect(emitted).toEqual([]);
    });

    it('handles insertions, deletions and a wholesale replacement', async () => {
      await ready();
      const apply = (value: string) => fixture.componentInstance.applyEdit('@config', value);

      for (const value of ['[]', '[\n  1,\n  2\n]', '[\n  1\n]', 'x']) {
        expect(apply(value)).toBe(true);
        expect(configModel().getValue()).toBe(value);
      }
      expect(emitted.map((change) => change.value)).toEqual([
        '[]',
        '[\n  1,\n  2\n]',
        '[\n  1\n]',
        'x',
      ]);
    });

    it('reports an edit to a model that is not on screen, which the editor would not', async () => {
      await ready();
      await show(IMAGE);

      expect(fixture.componentInstance.applyEdit('@config', '[]')).toBe(true);

      expect(configModel().getValue()).toBe('[]');
      expect(emitted).toEqual([{ id: '@config', value: '[]' }]);
    });

    it('does not echo the model change as a second report', async () => {
      await ready();
      fixture.componentInstance.applyEdit('@config', '[7]');
      expect(emitted).toHaveLength(1);

      // Typing still reports itself.
      configModel().pushEditOperations(null, [
        {
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
          text: ' ',
        },
      ]);
      expect(emitted).toHaveLength(2);
    });

    it('knows no such document', async () => {
      await ready();
      expect(fixture.componentInstance.applyEdit('nothing', 'x')).toBe(false);
    });
  });

  describe('line endings', () => {
    it('gives the Config model LF, whatever the platform defaults to, and leaves GLSL alone', async () => {
      await ready();
      await show(IMAGE);

      expect(configModel().eol).toBe('lf');
      expect(models.find((model) => model.language === 'glsl')!.eol).toBe('default');
    });
  });

  describe('document scope', () => {
    it('starts the history afresh when the owner changes, even for identical text', async () => {
      await ready();
      fixture.componentInstance.applyEdit('@config', '[\n  2\n]');
      expect(configModel().history).toHaveLength(1);

      await show({ ...CONFIG, value: '[\n  2\n]', scope: 'other' });

      expect(configModel().history).toEqual([]);
      expect(emitted).toHaveLength(1);
    });

    it('keeps the history while the owner stays', async () => {
      await ready();
      fixture.componentInstance.applyEdit('@config', '[\n  2\n]');

      await show({ ...CONFIG, value: '[\n  2\n]' });

      expect(configModel().history).toHaveLength(1);
    });

    it('leaves a document without a scope as it always was', async () => {
      await ready();
      await show(IMAGE);
      const model = models.find((candidate) => candidate.language === 'glsl')!;
      model.history = ['older'];

      await show(CONFIG);
      await show({ ...IMAGE });

      expect(model.history).toEqual(['older']);
    });

    it('resets a model that was last shown for another owner when it returns', async () => {
      await ready();
      fixture.componentInstance.applyEdit('@config', '[\n  2\n]');
      await show(IMAGE);

      await show({ ...CONFIG, value: '[\n  2\n]', scope: 'other' });

      expect(configModel().history).toEqual([]);
    });
  });
});

/**
 * Literal scrubbing, over the app's real Monaco models and GLSL tokenizer, so the
 * undo stack under test is Monaco's own. Only the view is stood in for: it maps
 * every pointer to `target` and hands content changes on as the editor would.
 */
describe('CodeEditor literal scrub', () => {
  let monaco: MonacoApi;
  let fixture: ComponentFixture<CodeEditor>;
  let emitted: Array<{ id: string; value: string }>;
  let view: ScrubView;
  let created: Record<string, unknown>;

  class ScrubView {
    node = document.createElement('div');
    target: { lineNumber: number; column: number } | null = null;
    private listener: (() => void) | null = null;
    private subscription: { dispose(): void } | null = null;

    constructor(
      private readonly host: HTMLElement,
      public model: Monaco.editor.ITextModel,
    ) {
      host.appendChild(this.node);
    }

    getTargetAtClientPoint() {
      return (
        this.target && {
          type: monaco.editor.MouseTargetType.CONTENT_TEXT,
          position: this.target,
        }
      );
    }

    onDidChangeModelContent(listener: () => void): void {
      this.listener = listener;
      this.attach();
    }

    /** Like Monaco, a new model gets a new view node. */
    setModel(model: Monaco.editor.ITextModel): void {
      this.model = model;
      this.node.remove();
      this.node = this.host.appendChild(document.createElement('div'));
      this.attach();
    }

    private attach(): void {
      this.subscription?.dispose();
      const listener = this.listener;
      this.subscription = listener ? this.model.onDidChangeContent(() => listener()) : null;
    }

    getModel(): Monaco.editor.ITextModel {
      return this.model;
    }

    saveViewState(): null {
      return null;
    }

    onDidLayoutChange(): void {}
    restoreViewState(): void {}
    updateOptions(): void {}
    layout(): void {}
    focus(): void {}
    dispose(): void {
      this.subscription?.dispose();
      this.node.remove();
    }
  }

  const SOURCE: EditorDoc = {
    id: 'image',
    language: 'glsl',
    value: 'float a = 0.50; /*\n  0.5 */\nfloat b = -1.0;',
  };

  beforeAll(async () => {
    monaco = await loadMonacoInJsdom();
  }, 120_000);

  beforeEach(async () => {
    emitted = [];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [CodeEditor],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: MONACO_LOADER,
          useValue: async () => ({
            ...monaco,
            editor: {
              ...monaco.editor,
              create: (host: HTMLElement, options: { model: Monaco.editor.ITextModel }) => {
                created = options;
                view = new ScrubView(host, options.model);
                return view;
              },
            },
          }),
        },
        { provide: AppThemes, useValue: { attachMonaco: vi.fn() } },
        { provide: FontLoader, useValue: { load: async () => 'idle' } },
        { provide: ReducedMotion, useValue: { enabled: signal(false) } },
      ],
    });
    fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('doc', SOURCE);
    fixture.componentInstance.valueChange.subscribe((change) => emitted.push(change));
    fixture.detectChanges();
    for (let i = 0; i < 10 && !fixture.componentInstance.ready(); i++) {
      await fixture.whenStable();
      await new Promise((resolve) => setTimeout(resolve));
    }
    expect(fixture.componentInstance.ready()).toBe(true);
  });

  afterEach(() => TestBed.resetTestingModule());

  const pointer = (type: string, init: PointerEventInit = {}) => {
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      altKey: true,
      ...init,
    });
    (type === 'pointerdown' ? view.node : document).dispatchEvent(event);
    return event;
  };
  const key = (type: 'keydown' | 'keyup', name: string) =>
    document.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));

  /** Press on a line and column at x = 100, then move to each x in turn. */
  function drag(lineNumber: number, column: number, xs: number[], init: PointerEventInit = {}) {
    view.target = { lineNumber, column };
    const down = pointer('pointerdown', { clientX: 100, ...init });
    for (const x of xs) pointer('pointermove', { clientX: x, ...init });
    return down;
  }

  const line = (n: number) => view.model.getLineContent(n);

  it('lets Ctrl/Cmd add cursors, leaving Alt to the gesture', () => {
    expect(created['multiCursorModifier']).toBe('ctrlCmd');
  });

  it('scrubs a float in steps of four pixels and reports each edit as typing', () => {
    const down = drag(1, 12, [103, 108, 140]);
    pointer('pointerup', { clientX: 140 });

    expect(down.defaultPrevented).toBe(true);
    expect(line(1)).toBe('float a = 0.60; /*');
    expect(emitted.map((change) => change.id)).toEqual(['image', 'image']);
    expect(emitted.at(-1)?.value).toBe(view.model.getValue());
  });

  it('is one undo step, however many edits the drag made', () => {
    drag(1, 12, [104, 108, 112, 160, 80]);
    pointer('pointerup');
    expect(line(1)).toBe('float a = 0.45; /*');

    view.model.undo();
    expect(view.model.getValue()).toBe(SOURCE.value);
    view.model.redo();
    expect(line(1)).toBe('float a = 0.45; /*');
  });

  it('crosses zero with the unary minus inside the edited range', () => {
    drag(3, 13, [140]);
    pointer('pointerup');
    expect(line(3)).toBe('float b = 0.0;');

    drag(3, 12, [144]);
    pointer('pointerup');
    expect(line(3)).toBe('float b = 1.1;');
  });

  it('takes ten times the step with Shift and a tenth with Ctrl', () => {
    drag(1, 12, [108], { shiftKey: true });
    pointer('pointerup');
    expect(line(1)).toBe('float a = 0.70; /*');

    drag(1, 12, [108], { ctrlKey: true });
    pointer('pointerup');
    expect(line(1)).toBe('float a = 0.702; /*');
  });

  it('keeps typing on either side out of the undo step of the gesture', () => {
    // Typing leaves its stack element open; the gesture has to close it, and its own.
    const type = (text: string) => {
      const end = view.model.getLineMaxColumn(3);
      view.model.pushEditOperations(
        [],
        [
          {
            range: { startLineNumber: 3, startColumn: end, endLineNumber: 3, endColumn: end },
            text,
          },
        ],
        () => null,
      );
    };
    type(' // x');
    drag(1, 12, [140]);
    pointer('pointerup');
    type('y');

    view.model.undo();
    expect([line(1), line(3)]).toEqual(['float a = 0.60; /*', 'float b = -1.0; // x']);
    view.model.undo();
    expect([line(1), line(3)]).toEqual(['float a = 0.50; /*', 'float b = -1.0; // x']);
  });

  it('restores the original on Escape and leaves nothing scrubbed to undo or redo', () => {
    drag(1, 12, [140]);
    expect(line(1)).toBe('float a = 0.60; /*');

    key('keydown', 'Escape');
    expect(line(1)).toBe('float a = 0.50; /*');
    pointer('pointermove', { clientX: 200 });
    expect(line(1)).toBe('float a = 0.50; /*');

    view.model.undo();
    expect(view.model.getValue()).toBe(SOURCE.value);
    view.model.redo();
    expect(view.model.getValue()).toBe(SOURCE.value);
  });

  it('ends when Alt is let go', () => {
    drag(1, 12, [108]);
    key('keyup', 'Alt');
    pointer('pointermove', { clientX: 200 });

    expect(line(1)).toBe('float a = 0.52; /*');
  });

  it.each([
    ['without Alt', 1, 12, { altKey: false }],
    ['off a literal', 1, 3, {}],
    ['in a comment opened on an earlier line', 2, 4, {}],
  ])('leaves the press to Monaco %s', (_name, lineNumber, column, init) => {
    const down = drag(lineNumber, column, [140], init);
    pointer('pointerup');

    expect(down.defaultPrevented).toBe(false);
    expect(view.model.getValue()).toBe(SOURCE.value);
    expect(emitted).toEqual([]);
  });

  it('ignores the gesture in a read-only editor', () => {
    fixture.componentRef.setInput('readOnly', true);
    fixture.detectChanges();

    const down = drag(1, 12, [140]);
    pointer('pointerup');

    expect(down.defaultPrevented).toBe(false);
    expect(view.model.getValue()).toBe(SOURCE.value);
  });

  it('still scrubs after the editor has shown another document', async () => {
    fixture.componentRef.setInput('doc', CONFIG);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentRef.setInput('doc', SOURCE);
    fixture.detectChanges();
    await fixture.whenStable();

    drag(1, 12, [108]);
    pointer('pointerup');

    expect(line(1)).toBe('float a = 0.52; /*');
    expect(emitted).toEqual([{ id: 'image', value: view.model.getValue() }]);
  });

  it('ignores the gesture outside GLSL', async () => {
    fixture.componentRef.setInput('doc', CONFIG);
    fixture.detectChanges();
    await fixture.whenStable();

    const down = drag(2, 3, [140]);
    pointer('pointerup');

    expect(down.defaultPrevented).toBe(false);
    expect(view.model.getValue()).toBe(CONFIG.value);
  });
});
