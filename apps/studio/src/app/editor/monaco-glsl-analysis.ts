import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import type { FunctionSymbol, GlobalSymbol } from '@shadergrove/glsl-analysis';
import type { ProjectAnalysis } from './glsl-analysis';
import type { MappedDiagnostic } from './glsl-analysis-source';

type MonacoApi = typeof Monaco;

/**
 * Marker owner for front-end analysis. Deliberately not `shader-studio`, which
 * belongs to the driver's compile diagnostics: each owner clears only its own
 * markers, so neither can erase or shadow the other.
 */
export const ANALYSIS_MARKER_OWNER = 'shader-studio-analysis';

interface ModelBinding {
  readonly analysis: ProjectAnalysis;
  readonly docId: string;
  stop(): void;
}

const bindings = new WeakMap<Monaco.editor.ITextModel, ModelBinding>();
const registered = new WeakSet<object>();

/**
 * Ties a model to the analysis of the project it belongs to. Any edit
 * immediately withdraws the model's analysis markers and marks the analysis
 * dirty, so nothing computed for the previous text is presented as current.
 * The returned function undoes the binding and clears the markers.
 */
export function bindAnalysisModel(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  analysis: ProjectAnalysis,
  docId: string,
): () => void {
  bindings.get(model)?.stop();

  const subscription = model.onDidChangeContent(() => {
    analysis.markDirty();
    monaco.editor.setModelMarkers(model, ANALYSIS_MARKER_OWNER, []);
  });
  const binding: ModelBinding = {
    analysis,
    docId,
    stop: () => {
      subscription.dispose();
      if (bindings.get(model) === binding) bindings.delete(model);
      if (!model.isDisposed()) monaco.editor.setModelMarkers(model, ANALYSIS_MARKER_OWNER, []);
    },
  };
  bindings.set(model, binding);
  return binding.stop;
}

/** Replaces the model's analysis markers with the analysis' current diagnostics. */
export function syncAnalysisMarkers(monaco: MonacoApi, model: Monaco.editor.ITextModel): void {
  const binding = bindings.get(model);
  if (!binding || model.isDisposed()) return;

  const markers = binding.analysis
    .diagnosticsFor(binding.docId)
    .map((diagnostic) => toMarker(monaco, model, diagnostic));
  monaco.editor.setModelMarkers(model, ANALYSIS_MARKER_OWNER, markers);
}

function toMarker(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  diagnostic: MappedDiagnostic,
): Monaco.editor.IMarkerData {
  const severity =
    diagnostic.severity === 'error'
      ? monaco.MarkerSeverity.Error
      : diagnostic.severity === 'warning'
        ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info;
  const base = { severity, source: 'glslang' };

  // Without an attributable line the message is pinned to the top of the document
  // and says why, rather than pointing at a line that was never the culprit.
  if (diagnostic.line === null) {
    const where =
      diagnostic.origin === 'generated'
        ? 'in declarations the renderer adds (often a redeclaration)'
        : 'no source line available';
    return {
      ...base,
      message: `${diagnostic.message} (${where})`,
      startLineNumber: 1,
      endLineNumber: 1,
      startColumn: 1,
      endColumn: Math.max(2, model.getLineMaxColumn(1)),
    };
  }

  const line = Math.min(diagnostic.line, model.getLineCount());
  const maxColumn = model.getLineMaxColumn(line);
  const exact = diagnostic.startColumn !== null && diagnostic.endColumn !== null;
  return {
    ...base,
    message: diagnostic.message,
    startLineNumber: line,
    endLineNumber: line,
    startColumn: exact
      ? diagnostic.startColumn!
      : Math.max(1, model.getLineFirstNonWhitespaceColumn(line)),
    endColumn: exact ? Math.min(diagnostic.endColumn!, maxColumn) : maxColumn,
  };
}

/**
 * Declared-symbol completion and hover, registered once per Monaco instance
 * however many editors there are. The providers add to — never replace — the
 * built-in lexicon, snippets and documented uniforms. `skip` lists names those
 * already describe so a declared `iTime` is not offered twice.
 */
export function registerGlslAnalysis(
  monaco: MonacoApi,
  languageId: string,
  skip: ReadonlySet<string>,
): void {
  if (registered.has(monaco)) return;
  registered.add(monaco);

  monaco.languages.registerCompletionItemProvider(languageId, {
    provideCompletionItems: (model, position) => {
      const symbols = symbolsFor(model);
      if (!symbols) return { suggestions: [] };

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const { CompletionItemKind } = monaco.languages;

      return {
        suggestions: [
          ...symbols.globals
            .filter((symbol) => !skip.has(symbol.name ?? ''))
            .map(
              (symbol): Monaco.languages.CompletionItem => ({
                label: symbol.name ?? '',
                kind:
                  symbol.kind === 'const'
                    ? CompletionItemKind.Constant
                    : CompletionItemKind.Variable,
                insertText: symbol.name ?? '',
                detail: describeGlobal(symbol),
                // Declared names first: they are what this file actually has.
                sortText: `0${symbol.name}`,
                range,
              }),
            ),
          ...symbols.functions.map(
            (symbol): Monaco.languages.CompletionItem => ({
              label: symbol.name,
              kind: CompletionItemKind.Function,
              insertText: symbol.name,
              detail: symbol.signature,
              documentation:
                symbol.overloadCount > 1 ? `${symbol.overloadCount} overloads` : undefined,
              sortText: `0${symbol.name}`,
              range,
            }),
          ),
        ],
      };
    },
  });

  monaco.languages.registerHoverProvider(languageId, {
    provideHover: (model, position) => {
      const symbols = symbolsFor(model);
      const word = model.getWordAtPosition(position);
      if (!symbols || !word) return null;

      const name = word.word;
      const global = symbols.globals.find((symbol) => symbol.name === name);
      const functions = symbols.functions.filter((symbol) => symbol.name === name);
      const lines = [
        ...(global ? [describeGlobal(global, name)] : []),
        ...functions.map((symbol) => symbol.signature),
      ];
      if (!lines.length) return null;

      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        ),
        contents: [{ value: lines.map((line) => `\`\`\`glsl\n${line}\n\`\`\``).join('\n') }],
      };
    },
  });
}

/**
 * The analysis' symbols for this model, or null. The facade withholds symbols
 * from any stale snapshot; the model's own binding decides whose they are.
 */
function symbolsFor(
  model: Monaco.editor.ITextModel,
): { globals: readonly GlobalSymbol[]; functions: readonly FunctionSymbol[] } | null {
  const binding = bindings.get(model);
  return binding ? binding.analysis.symbolsFor(binding.docId) : null;
}

function describeGlobal(symbol: GlobalSymbol, name = symbol.name ?? ''): string {
  const qualifier = symbol.qualifier ? `${symbol.qualifier} ` : '';
  return `${qualifier}${symbol.type.text} ${name}`;
}
