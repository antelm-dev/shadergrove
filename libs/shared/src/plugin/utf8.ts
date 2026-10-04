// This library compiles without DOM or Node types; every runtime that loads it has both.
declare const TextEncoder: new () => { encode(text: string): Uint8Array };

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;
