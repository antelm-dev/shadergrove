import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReducedMotion } from '../prefs/reduced-motion';
import { AppThemes } from '../themes/app-themes';
import { CodeEditor, MONACO_LOADER, type EditorDoc } from './code-editor';
import { FontLoader } from './google-fonts';
import { fakeMonaco, models } from './testing/fake-monaco';

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
