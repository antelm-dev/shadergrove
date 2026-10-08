/**
 * What the plugin Worker prelude provides (see apps/studio/src/plugin-sandbox.js).
 * Requests arrive as plain data; a handler's return value is sent back as JSON.
 */
declare const shaderStudio: {
  handle(method: string, fn: (params: unknown) => unknown): void;
  notify(data: unknown): void;
};
// Worker globals the code may use; `lib` stays ES2022 so DOM and network APIs do not type-check.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (
  label: string,
  options?: { fatal?: boolean },
) => { decode(input: ArrayBuffer | ArrayBufferView): string };
