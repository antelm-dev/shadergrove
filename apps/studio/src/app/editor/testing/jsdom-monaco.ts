import { loadMonaco, type MonacoApi } from '../monaco-loader';

/**
 * The app's real Monaco — GLSL tokenizer, models, undo stack — under jsdom,
 * which lacks three browser APIs it touches while loading. No editor view is
 * created from it: that needs layout jsdom does not have.
 */
export function loadMonacoInJsdom(): Promise<MonacoApi> {
  const doc = document as Document & { queryCommandSupported?: () => boolean };
  doc.queryCommandSupported ??= () => false;
  const css = globalThis as { CSS?: { escape?: (value: string) => string } };
  css.CSS ??= {};
  css.CSS.escape ??= (value) => value;
  window.matchMedia ??= () =>
    ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }) as unknown as MediaQueryList;
  return loadMonaco();
}
