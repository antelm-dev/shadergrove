/* Monaco needs a browser: these stand in for it in component specs. */

/**
 * A model that keeps what the real one is accountable for here: its text, an
 * undo history that `setValue` throws away, and a change event that only the
 * editor currently showing it hears. Monaco itself needs a browser.
 */
export class FakeModel {
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

export class FakeEditor {
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
  /** Lines the cursor was put on, as a reveal does. */
  readonly revealed: number[] = [];
  setPosition(position: { lineNumber: number }): void {
    this.revealed.push(position.lineNumber);
  }
  revealLineInCenterIfOutsideViewport(): void {}
  updateOptions(): void {}
  layout(): void {}
  focus(): void {}
  dispose(): void {}
}

/** Every model created, oldest first. Clear it between tests. */
export const models: FakeModel[] = [];
/** Every editor created, oldest first. Clear it between tests. */
export const editors: FakeEditor[] = [];
export const fakeMonaco = {
  editor: {
    createModel: (value: string, language: string) => {
      const model = new FakeModel(value, language);
      models.push(model);
      return model;
    },
    create: (_host: unknown, options: { model: FakeModel }) => {
      const editor = new FakeEditor(options);
      editors.push(editor);
      return editor;
    },
    setModelMarkers: () => {},
    remeasureFonts: () => {},
    EndOfLineSequence: { LF: 0, CRLF: 1 },
  },
  MarkerSeverity: { Warning: 4, Error: 8 },
};
