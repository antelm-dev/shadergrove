import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReducedMotion } from '../prefs/reduced-motion';
import { AppThemes } from '../themes/app-themes';
import { CodeEditor, MONACO_LOADER, type EditorDoc } from './code-editor';
import { FontLoader } from './google-fonts';

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
