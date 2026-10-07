import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import {
  DEFAULT_EDITOR_APPEARANCE,
  fontFamilyStack,
  type EditorAppearance,
} from '@shadergrove/shared/editor-prefs';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { ReducedMotion } from '../prefs/reduced-motion';
import { FontLoader, findFont, nearestWeight } from './google-fonts';
import { AppThemes } from '../themes/app-themes';
import type { ProjectAnalysis } from './glsl-analysis';
import { bindAnalysisModel, syncAnalysisMarkers } from './monaco-glsl-analysis';
import { GLSL_LANGUAGE_ID, JSON_LANGUAGE_ID, loadMonaco, type MonacoApi } from './monaco-loader';

export type EditorLanguage = 'glsl' | 'json';

/** One document the editor can show. The id is what its state is filed under. */
export interface EditorDoc {
  id: string;
  language: EditorLanguage;
  value: string;
}

/**
 * A Monaco instance bound to a signal.
 *
 * Deliberately dumb: it renders whatever `doc` it is given, dresses itself in
 * whatever `appearance` it is given, and reports edits through `valueChange`. It
 * holds no opinion about shaders, which is what lets the same component back
 * every pass, every file, the vertex shader and the config tab.
 *
 * It also never rebuilds itself, and this is the whole design.
 *
 * A Monaco *editor* is a view. A Monaco *model* is the document: the text, and —
 * critically — the undo/redo stack. Tearing down an editor, or reassigning its
 * text, destroys both. So the editor here is created exactly once and lives for
 * as long as the component, and switching tabs swaps the **model** underneath
 * it: `setModel` for the text and the undo history, `saveViewState`/
 * `restoreViewState` for the cursor, the selection and the scroll position.
 *
 * The alternative — one editor per document, or one editor whose value is
 * reassigned — is what makes an editor "lose your place": switch to Buffer A and
 * back, and the cursor is at the top, the scroll is at the top, and Ctrl+Z does
 * nothing. Keeping a model per document is what makes all three survive, and it
 * costs one object per open file.
 *
 * The same reasoning is why nothing here recreates the editor for appearance
 * either: every option is applied to the live instance through `updateOptions`,
 * because this component is also moved between a docked panel and a floating
 * window at the user's whim.
 */
@Component({
  selector: 'app-code-editor',
  template: `
    <div #host class="editor-host"></div>
    @if (!ready()) {
      <div class="editor-loading">Loading editor…</div>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      min-height: 0;
    }

    .editor-host {
      width: 100%;
      height: 100%;
    }

    .editor-loading {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class CodeEditor {
  readonly doc = input.required<EditorDoc>();
  /**
   * Every document that still exists. A model whose document is gone — a deleted
   * buffer, a deleted file — is disposed: its undo stack is not worth keeping for
   * a tab that can never be opened again.
   */
  readonly liveIds = input<readonly string[] | null>(null);
  readonly diagnostics = input<readonly CompileDiagnostic[]>([]);
  /**
   * Front-end analysis of the project the documents belong to. Optional: without
   * it the editor is exactly what it was, and it never starts the analysis itself.
   */
  readonly analysis = input<ProjectAnalysis | null>(null);
  readonly readOnly = input(false);
  readonly appearance = input<EditorAppearance>(DEFAULT_EDITOR_APPEARANCE);

  /**
   * Carries the document id, not just the text. The alternative — the parent
   * assuming an edit belongs to whichever tab it thinks is open — is a very
   * efficient way to write one file's contents into another the instant those
   * two disagree.
   */
  readonly valueChange = output<{ id: string; value: string }>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly destroyRef = inject(DestroyRef);
  private readonly fonts = inject(FontLoader);
  private readonly reducedMotion = inject(ReducedMotion);
  private readonly themes = inject(AppThemes);

  private readonly monaco = signal<MonacoApi | null>(null);
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private visibleTokensFrame: number | null = null;

  /** One model per document: the text, and the undo/redo stack behind it. */
  private readonly models = new Map<string, Monaco.editor.ITextModel>();

  /** Undoes each GLSL model's analysis binding. */
  private readonly unbind = new Map<string, () => void>();

  /** Cursor, selection and scroll, per document. Monaco does not keep these. */
  private readonly viewStates = new Map<string, Monaco.editor.ICodeEditorViewState>();

  /** Which document's model is currently in the editor. */
  private mounted: string | null = null;

  readonly ready = signal(false);

  /**
   * Set while we are writing into the model ourselves, so the resulting change
   * event is not echoed back out as if the user had typed it.
   */
  private applying = false;

  /**
   * The Monaco options implied by the current appearance.
   *
   * Motion is the one thing the user does not get the last word on: someone who
   * has asked their OS for less of it means it here too, and a cursor that
   * pulses or a viewport that glides is exactly what they asked to be spared.
   */
  private readonly options = computed<Monaco.editor.IEditorOptions>(() => {
    const appearance = this.appearance();
    const still = this.reducedMotion.enabled();
    const font = findFont(appearance.fontFamily);

    return {
      fontFamily: fontFamilyStack(appearance.fontFamily),
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      fontWeight: String(nearestWeight(appearance.fontFamily, appearance.fontWeight)),
      // Asking a face without ligatures for its ligatures is harmless, but it
      // also turns on kerning and contextual alternates that some of these fonts
      // do surprising things with. Only opt in where there is something to gain.
      fontLigatures: appearance.ligatures && (font?.ligatures ?? false),
      tabSize: appearance.tabSize,
      wordWrap: appearance.wordWrap,
      minimap: { enabled: appearance.minimap },
      lineNumbers: appearance.lineNumbers ? 'on' : 'off',
      bracketPairColorization: { enabled: appearance.bracketPairs },
      guides: { bracketPairs: appearance.bracketPairs },
      renderWhitespace: appearance.renderWhitespace ? 'all' : 'none',
      stickyScroll: { enabled: appearance.stickyScroll },
      cursorBlinking: still ? 'solid' : appearance.cursorBlinking,
      smoothScrolling: !still,
      cursorSmoothCaretAnimation: still ? 'off' : 'on',
    };
  });

  constructor() {
    afterNextRender(() => void this.boot());

    effect(() => {
      const monaco = this.monaco();
      const doc = this.doc();
      if (!monaco || !this.editor) return;

      untracked(() => this.mount(monaco, doc));
    });

    // Prune the models of documents that no longer exist.
    effect(() => {
      const live = this.liveIds();
      if (!live) return;

      untracked(() => {
        const keep = new Set(live);
        for (const [id, model] of this.models) {
          if (keep.has(id) || id === this.mounted) continue;
          this.unbind.get(id)?.();
          this.unbind.delete(id);
          model.dispose();
          this.models.delete(id);
          this.viewStates.delete(id);
        }
      });
    });

    effect(() => {
      const monaco = this.monaco();
      const diagnostics = this.diagnostics();
      const doc = this.doc();
      if (!monaco || !this.editor) return;

      const model = this.models.get(doc.id);
      if (!model) return;

      monaco.editor.setModelMarkers(
        model,
        'shader-studio',
        diagnostics.map((diagnostic) => this.toMarker(monaco, model, diagnostic, doc.language)),
      );
    });

    // Analysis owns its own marker owner: these effects never touch `shader-studio`.
    effect(() => {
      const monaco = this.monaco();
      const analysis = this.analysis();
      if (!monaco) return;

      untracked(() => {
        for (const [id, model] of this.models) this.bindModel(monaco, id, model, analysis);
      });
    });

    effect(() => {
      const monaco = this.monaco();
      const analysis = this.analysis();
      this.doc();
      // A new accepted snapshot is the only thing that puts analysis markers back.
      analysis?.snapshot();
      if (!monaco || !analysis) return;

      untracked(() => {
        for (const model of this.models.values()) syncAnalysisMarkers(monaco, model);
      });
    });

    effect(() => {
      const readOnly = this.readOnly();
      untracked(() => this.editor?.updateOptions({ readOnly }));
    });

    // Appearance, applied live. Nothing here recreates the editor.
    effect(() => {
      const options = this.options();
      untracked(() => this.editor?.updateOptions(options));
    });

    // Fetch the chosen family, then tell Monaco to measure again. Monaco caches
    // character widths on first paint; without the remeasure a font that lands a
    // moment later renders at the *fallback's* metrics — every glyph correct and
    // every cursor position wrong.
    effect(() => {
      const family = this.appearance().fontFamily;
      const monaco = this.monaco();
      if (!monaco) return;

      untracked(() => {
        void this.fonts.load(family).then((status) => {
          if (status === 'loaded') monaco.editor.remeasureFonts();
        });
      });
    });
  }

  /**
   * Put a document in the editor, taking the outgoing one's place with it.
   *
   * The order matters. The view state of the document being *left* has to be
   * captured before its model is swapped out, because `saveViewState` reads the
   * editor's live cursor and scroll — a moment later they belong to the new
   * document and the old ones are gone for good.
   */
  private mount(monaco: MonacoApi, doc: EditorDoc): void {
    const editor = this.editor;
    if (!editor) return;

    if (this.mounted === doc.id) {
      // Same document, new text from outside — a revert, a recovered draft.
      // Never for text the user just typed: that already round-tripped through
      // `valueChange`, and reassigning it here would flatten the undo stack.
      const model = this.models.get(doc.id);
      if (model && model.getValue() !== doc.value) {
        this.applying = true;
        model.setValue(doc.value);
        this.applying = false;
      }
      this.flushPendingReveal(doc.id);
      return;
    }

    if (this.mounted) {
      const state = editor.saveViewState();
      if (state) this.viewStates.set(this.mounted, state);
    }

    let model = this.models.get(doc.id);
    if (!model) {
      model = monaco.editor.createModel(doc.value, this.monacoLanguage(doc.language));
      this.models.set(doc.id, model);
      this.bindModel(monaco, doc.id, model, this.analysis());
    } else if (model.getValue() !== doc.value) {
      this.applying = true;
      model.setValue(doc.value);
      this.applying = false;
    }

    this.applying = true;
    editor.setModel(model);
    this.applying = false;

    const state = this.viewStates.get(doc.id);
    if (state) editor.restoreViewState(state);
    else this.scheduleVisibleTokens();

    this.mounted = doc.id;

    // After the view state, never before: a held reveal is a deliberate jump to a
    // line, and it has to beat the cursor this document was last left at.
    this.flushPendingReveal(doc.id);
  }

  /**
   * Colours the lines on screen now, rather than when the browser is next idle.
   *
   * Monaco highlights in two ways: the lines it is told are visible — on a
   * scroll, a view-state restore, or the editor's creation — at once, and the
   * whole document in the background, in idle callbacks. A shader rendering on
   * every frame can leave the main thread no idle time at all, and then a resize
   * or a newly mounted document (neither of which tells Monaco what is visible)
   * shows plain text until the first scroll. Restoring the current view state is
   * the public way to tell it; it moves nothing.
   */
  private scheduleVisibleTokens(): void {
    if (this.visibleTokensFrame !== null) return;
    this.visibleTokensFrame = requestAnimationFrame(() => {
      this.visibleTokensFrame = null;
      const state = this.editor?.saveViewState();
      if (state) this.editor?.restoreViewState(state);
    });
  }

  private flushPendingReveal(docId: string): void {
    const pending = this.pendingReveal;
    if (pending?.docId !== docId) return;

    this.pendingReveal = null;
    this.revealLine(pending.line);
  }

  /**
   * Re-measure and re-lay-out. Monaco's `automaticLayout` watches the host with a
   * ResizeObserver, which covers dragging and resizing; this exists for the cases
   * it cannot see — a tab that was hidden while its container changed size, and a
   * panel restored from a mode where it had no size at all.
   */
  layout(): void {
    this.editor?.layout();
  }

  focus(): void {
    this.editor?.focus();
  }

  /**
   * Put the cursor on a line of a given document — what clicking a diagnostic
   * does.
   *
   * The document is named, not assumed, because the caller almost always asks
   * for a document that is not open yet: selecting the tab and revealing the line
   * happen in one gesture, and the tab has not been *mounted* by the time this is
   * called — mounting is an effect, and effects have not run.
   *
   * Revealing anyway would put the cursor on line N of the document being
   * navigated *away* from, and the mount that followed would then restore the
   * incoming document's saved cursor right over the top of it. The line would
   * simply never be shown, and the whole feature would look like it did nothing.
   *
   * So a reveal for a document that is not mounted is *held*, and `mount` applies
   * it once the model is in — after the view state has been restored, so it wins.
   */
  revealIn(docId: string, line: number): void {
    if (this.mounted === docId) {
      this.revealLine(line);
      return;
    }
    this.pendingReveal = { docId, line };
  }

  private pendingReveal: { docId: string; line: number } | null = null;

  private revealLine(line: number): void {
    const editor = this.editor;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const target = Math.min(Math.max(line, 1), model.getLineCount());
    const column = Math.max(1, model.getLineFirstNonWhitespaceColumn(target));

    editor.setPosition({ lineNumber: target, column });
    editor.revealLineInCenterIfOutsideViewport(target);
    editor.focus();
  }

  /**
   * Run the language's formatter over the buffer. Goes through Monaco's own
   * action rather than the provider directly, so the edit arrives on the
   * editor's undo stack exactly as it would from Shift+Alt+F.
   */
  async format(): Promise<void> {
    await this.editor?.getAction('editor.action.formatDocument')?.run();
  }

  private async boot(): Promise<void> {
    const monaco = await loadMonaco();
    // Monaco's theme is global, and `AppThemes` alone sets it — painted before
    // this editor exists, so it never shows Monaco's default first.
    this.themes.attachMonaco(monaco);

    const doc = untracked(this.doc);
    const model = monaco.editor.createModel(doc.value, this.monacoLanguage(doc.language));
    this.models.set(doc.id, model);
    this.mounted = doc.id;

    const editor = monaco.editor.create(this.host().nativeElement, {
      model,
      readOnly: untracked(this.readOnly),
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      padding: { top: 12, bottom: 12 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      ...untracked(this.options),
    });

    // Reads the *model*, not the editor: a change event can land in the gap
    // between a model being swapped in and the editor settling on it, and
    // `editor.getValue()` would then attribute one document's text to another —
    // which is a very efficient way to overwrite a file you were not looking at.
    editor.onDidChangeModelContent(() => {
      if (this.applying) return;
      const id = this.mounted;
      const model = id ? this.models.get(id) : null;
      if (id && model) this.valueChange.emit({ id, value: model.getValue() });
    });

    // A resize changes which lines are on screen without scrolling.
    editor.onDidLayoutChange(() => this.scheduleVisibleTokens());

    this.editor = editor;
    this.monaco.set(monaco);
    this.ready.set(true);
    this.scheduleVisibleTokens();

    this.destroyRef.onDestroy(() => {
      if (this.visibleTokensFrame !== null) cancelAnimationFrame(this.visibleTokensFrame);
      editor.dispose();
      for (const stop of this.unbind.values()) stop();
      this.unbind.clear();
      for (const model of this.models.values()) model.dispose();
      this.models.clear();
      this.viewStates.clear();
    });
  }

  private bindModel(
    monaco: MonacoApi,
    id: string,
    model: Monaco.editor.ITextModel,
    analysis: ProjectAnalysis | null,
  ): void {
    this.unbind.get(id)?.();
    this.unbind.delete(id);
    if (!analysis || model.getLanguageId() !== GLSL_LANGUAGE_ID) return;
    this.unbind.set(
      id,
      bindAnalysisModel(monaco, model, analysis, id, () => this.applying),
    );
  }

  private monacoLanguage(language: EditorLanguage): string {
    return language === 'json' ? JSON_LANGUAGE_ID : GLSL_LANGUAGE_ID;
  }

  /**
   * Diagnostics with no line (link errors, schema errors) are pinned to line 1
   * rather than dropped — an error you cannot see is worse than one in the
   * wrong place, and the message itself says what is wrong.
   */
  private toMarker(
    monaco: MonacoApi,
    model: Monaco.editor.ITextModel,
    diagnostic: CompileDiagnostic,
    language: EditorLanguage,
  ): Monaco.editor.IMarkerData {
    const line = Math.min(Math.max(diagnostic.line || 1, 1), model.getLineCount());
    const content = model.getLineContent(line);
    const start = content.search(/\S/);

    return {
      severity:
        diagnostic.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Error,
      message: diagnostic.message,
      startLineNumber: line,
      endLineNumber: line,
      startColumn: start < 0 ? 1 : start + 1,
      endColumn: content.length + 1,
      source: language,
    };
  }
}
