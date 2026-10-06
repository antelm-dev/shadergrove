import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import { EDITOR_THEMES, monacoThemeId, type EditorThemePalette } from './editor-themes';
import { formatGlsl } from '@shadergrove/shared/glsl-format';
import {
  GLSL_BUILTINS,
  GLSL_KEYWORDS,
  GLSL_PREDEFINED,
  GLSL_TYPES,
} from '@shadergrove/shared/glsl-lexicon';
import { GLSL_SNIPPETS } from './glsl-snippets';
import { registerGlslAnalysis } from './monaco-glsl-analysis';

/**
 * Loads Monaco once, on demand, in the browser only.
 *
 * The entry point matters. Three are on offer:
 *
 *   editor.api     the API surface and nothing else — no find, no folding, no
 *                  suggestions. Lean, but a poor place to write code.
 *   editor.main    everything, including all ~90 bundled languages and the
 *                  TypeScript/CSS/HTML/JSON language services. Megabytes we
 *                  would never use.
 *   edcore.main    the editor and every one of its contributions, with no
 *                  languages at all.
 *
 * `edcore.main` is the one that fits: this app brings its own two languages
 * (GLSL and JSON, both registered below as Monarch tokenizers, which run on the
 * main thread) and wants the full editing experience for them.
 *
 * Monaco's *stylesheet* is loaded globally, via `angular.json`. The CSS its ESM
 * modules import ends up in a chunk that nothing ever links, which leaves the
 * editor structurally unstyled — bare textarea, no gutter — while the syntax
 * colours, which Monaco injects at runtime, still look right and hide it.
 */

export type MonacoApi = typeof Monaco;

export const GLSL_LANGUAGE_ID = 'glsl';
export const JSON_LANGUAGE_ID = 'json-lite';

let loader: Promise<MonacoApi> | null = null;

export function loadMonaco(): Promise<MonacoApi> {
  loader ??= initialize();
  return loader;
}

async function initialize(): Promise<MonacoApi> {
  // Monaco looks for its worker factory on the global object.
  (globalThis as { MonacoEnvironment?: Monaco.Environment }).MonacoEnvironment = {
    getWorker: () =>
      new Worker(new URL('./monaco.worker', import.meta.url), {
        type: 'module',
        name: 'monaco-editor-worker',
      }),
  };

  // edcore.main ships no type declarations of its own; it re-exports exactly
  // the API that editor.api declares, which is what MonacoApi refers to.
  const monaco =
    (await import('monaco-editor/esm/vs/editor/edcore.main.js')) as unknown as MonacoApi;

  registerGlsl(monaco);
  registerJson(monaco);
  registerThemes(monaco);

  return monaco;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

function registerGlsl(monaco: MonacoApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === GLSL_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: GLSL_LANGUAGE_ID, extensions: ['.glsl', '.frag', '.vert'] });

  monaco.languages.setLanguageConfiguration(GLSL_LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
  });

  registerGlslCompletions(monaco);
  registerGlslAnalysis(monaco, GLSL_LANGUAGE_ID, new Set(Object.keys(DOCUMENTED_UNIFORMS)));
  registerGlslFormatting(monaco);

  monaco.languages.setMonarchTokensProvider(GLSL_LANGUAGE_ID, {
    defaultToken: '',
    keywords: GLSL_KEYWORDS,
    types: GLSL_TYPES,
    builtins: GLSL_BUILTINS,
    predefined: GLSL_PREDEFINED,

    tokenizer: {
      root: [
        [/^\s*#\s*\w+/, 'keyword.directive'],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@types': 'type',
              '@builtins': 'predefined',
              '@predefined': 'variable.predefined',
              '@default': 'identifier',
            },
          },
        ],
        { include: '@whitespace' },
        [/\d*\.\d+(?:[eE][-+]?\d+)?[fF]?/, 'number.float'],
        [/\d+[fFuU]?/, 'number'],
        [/[{}()[\]]/, '@brackets'],
        [/[<>=!+\-*/%&|^~?:]+/, 'operator'],
        [/[;,.]/, 'delimiter'],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });
}

/**
 * Completions for GLSL.
 *
 * Monaco's built-in word-based suggestions only offer words already in the
 * file, which is useless for the things you actually need to recall: the
 * engine's built-in uniforms and the GLSL standard library.
 */
const DOCUMENTED_UNIFORMS: Record<string, string> = {
  iTime: 'float — seconds since the shader started, pausable',
  iResolution: 'vec2 — drawing-buffer size in pixels',
  iMouse: 'vec4 — xy: pointer in pixels, z: 1 while pressed',
  iMouseVel: 'vec2 — pointer velocity, pixels per second',
  u_clickData: 'vec3[] — per click: xy in pixels, z: birth time (<= 0 unused)',
  iChannel0: 'sampler2D — bound image for this channel, or a 1×1 transparent pixel if unassigned',
  iChannel1: 'sampler2D — bound image for this channel, or a 1×1 transparent pixel if unassigned',
  iChannel2: 'sampler2D — bound image for this channel, or a 1×1 transparent pixel if unassigned',
  iChannel3: 'sampler2D — bound image for this channel, or a 1×1 transparent pixel if unassigned',
};

function registerGlslCompletions(monaco: MonacoApi): void {
  monaco.languages.registerCompletionItemProvider(GLSL_LANGUAGE_ID, {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const item = (
        label: string,
        kind: Monaco.languages.CompletionItemKind,
        detail?: string,
      ): Monaco.languages.CompletionItem => ({
        label,
        kind,
        insertText: label,
        range,
        ...(detail ? { detail } : {}),
      });

      const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages;

      const snippets = GLSL_SNIPPETS.map(
        (snippet): Monaco.languages.CompletionItem => ({
          label: snippet.label,
          kind: CompletionItemKind.Snippet,
          detail: snippet.detail,
          insertText: snippet.body,
          insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // Ahead of the plain identifiers: someone typing `fbm` in an empty
          // file wants the function, not a word that happens to start that way.
          sortText: `0${snippet.label}`,
        }),
      );

      return {
        suggestions: [
          ...snippets,
          ...Object.entries(DOCUMENTED_UNIFORMS).map(([name, detail]) =>
            item(name, CompletionItemKind.Variable, detail),
          ),
          ...GLSL_BUILTINS.map((name) => item(name, CompletionItemKind.Function)),
          ...GLSL_TYPES.map((name) => item(name, CompletionItemKind.TypeParameter)),
          ...GLSL_KEYWORDS.map((name) => item(name, CompletionItemKind.Keyword)),
        ],
      };
    },
  });
}

/**
 * Wires `formatGlsl` in as the language's formatter, which is what gives the
 * editor its Format Document action (Shift+Alt+F) and lets the toolbar ask for
 * one by name rather than rewriting the buffer itself.
 *
 * The whole document is replaced in a single edit, so it lands as one undo step
 * and the cursor survives.
 */
function registerGlslFormatting(monaco: MonacoApi): void {
  monaco.languages.registerDocumentFormattingEditProvider(GLSL_LANGUAGE_ID, {
    provideDocumentFormattingEdits: (model, options) => {
      const formatted = formatGlsl(model.getValue(), {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
      });

      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  });
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Highlighting only. Validation of the config comes from `shared/validate`,
 * which knows what a *control schema* is — far more useful than a generic
 * "unexpected token" — and is the same code the API will run.
 */
function registerJson(monaco: MonacoApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === JSON_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: JSON_LANGUAGE_ID, extensions: ['.json'] });

  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    defaultToken: '',
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"\s*(?=:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[:,]/, 'delimiter'],
        [/\s+/, ''],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Every built-in theme, registered up front — they are a few hundred bytes of
 * data each, and defining them lazily would mean a visible flash of the wrong
 * colours the first time someone picks one in the settings dialog. Plugin
 * themes come and go with their packages; `AppThemes` defines those.
 *
 * Monaco's theme is a *global* setting rather than a per-editor one, so a single
 * `setTheme` switches every editor at once. That is also why the editor cannot
 * offer a different theme per tab, and why `AppThemes` is the one place that
 * calls it.
 */
function registerThemes(monaco: MonacoApi): void {
  for (const theme of EDITOR_THEMES) {
    monaco.editor.defineTheme(monacoThemeId(theme.id), toMonacoTheme(theme.palette));
  }
}

/** Monaco wants its colours without the `#`, in the rules but not in the colors. */
export function toMonacoTheme(palette: EditorThemePalette): Monaco.editor.IStandaloneThemeData {
  const { tokens } = palette;
  const hex = (color: string) => color.replace('#', '');

  return {
    base: palette.base,
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex(tokens.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex(tokens.keyword) },
      { token: 'keyword.directive', foreground: hex(tokens.directive) },
      { token: 'type', foreground: hex(tokens.type) },
      { token: 'predefined', foreground: hex(tokens.predefined) },
      { token: 'variable.predefined', foreground: hex(tokens.variable) },
      { token: 'number', foreground: hex(tokens.number) },
      { token: 'number.float', foreground: hex(tokens.number) },
      { token: 'string', foreground: hex(tokens.string) },
      { token: 'operator', foreground: hex(tokens.operator) },
    ],
    colors: {
      'editor.background': palette.background,
      'editor.foreground': palette.foreground,
      'editor.lineHighlightBackground': palette.lineHighlight,
      'editorLineNumber.foreground': palette.lineNumber,
      'editorGutter.background': palette.background,
      'editorWidget.background': palette.background,
      'editorStickyScroll.background': palette.background,
    },
  };
}
