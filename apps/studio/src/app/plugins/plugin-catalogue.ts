import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';

import {
  CATALOGUE_MAX_BYTES,
  CATALOGUE_PATH,
  SUPPORTED_PLUGIN_PROTOCOLS,
  isAppVersionInRange,
  parsePluginPackage,
  validateCatalogue,
  type CatalogueEntry,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';

export type CatalogueState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; packages: CatalogueEntry[] }
  | { status: 'error'; message: string };

/** How the catalogue reads bytes; replaced in tests. */
export type CatalogueFetch = (url: string) => Promise<Response>;

/**
 * The official packages that ship with this release, read from the app's own
 * assets (`plugins/catalogue.json` beside the package files). Same-origin on
 * the web, `shader-studio://bundle/` on the desktop — so it works offline
 * there — and never on the server: during SSR nothing is fetched.
 *
 * Browsing reads JSON and nothing else. A package file is fetched only when
 * the user installs it, and only reaches review once its size and SHA-256
 * match the entry and its manifest repeats the entry's identity, protocol and
 * app range. Entries this app cannot run are not listed at all.
 */
@Injectable({ providedIn: 'root' })
export class PluginCatalogueService {
  private readonly document = inject(DOCUMENT);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private fetcher: CatalogueFetch = (url) => fetch(url, { cache: 'no-cache', credentials: 'omit' });

  private readonly stateSignal = signal<CatalogueState>({ status: 'idle' });
  readonly state = this.stateSignal.asReadonly();
  private loading: Promise<void> | null = null;

  /** For tests. */
  useFetch(fetcher: CatalogueFetch): void {
    this.fetcher = fetcher;
  }

  /** Reads the catalogue; a load already under way is shared rather than started twice. */
  load(): Promise<void> {
    if (!this.browser) return Promise.resolve();
    return (this.loading ??= this.fetchCatalogue().finally(() => (this.loading = null)));
  }

  /** The listed entry of a package, loading the catalogue once if it never loaded; `null` if not listed. */
  async entry(id: string): Promise<CatalogueEntry | null> {
    if (this.stateSignal().status !== 'ready') await this.load();
    const state = this.stateSignal();
    if (state.status === 'error') throw new Error(state.message);
    return state.status === 'ready'
      ? (state.packages.find((entry) => entry.id === id) ?? null)
      : null;
  }

  private async fetchCatalogue(): Promise<void> {
    this.stateSignal.set({ status: 'loading' });
    try {
      const bytes = await this.read(this.url(CATALOGUE_PATH), CATALOGUE_MAX_BYTES);
      const parsed = validateCatalogue(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      if (!parsed.ok) throw new Error(parsed.errors[0]);
      this.stateSignal.set({
        status: 'ready',
        packages: parsed.value.packages.filter(
          (entry) =>
            SUPPORTED_PLUGIN_PROTOCOLS.includes(entry.protocolVersion) &&
            isAppVersionInRange(entry.appVersionRange, APP_VERSION),
        ),
      });
    } catch (error) {
      this.stateSignal.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The package file of one entry, checked byte for byte against it. Rejects
   * on any mismatch; the caller hands what resolves to the usual review.
   */
  async fetchPackage(entry: CatalogueEntry): Promise<Uint8Array> {
    if (!this.browser) throw new Error('Plugins cannot be installed here');
    const bytes = await this.read(this.url(`plugins/${entry.file}`), entry.bytes);
    if (bytes.byteLength !== entry.bytes) {
      throw new Error(`${entry.file} is ${bytes.byteLength} bytes, not the ${entry.bytes} listed`);
    }
    const digest = await sha256Hex(bytes);
    if (digest !== entry.sha256) throw new Error(`${entry.file} does not match its catalogue hash`);
    const parsed = parsePluginPackage(bytes);
    if (!parsed.ok) throw new Error(parsed.errors[0]);
    const { manifest } = parsed.value;
    if (
      manifest.id !== entry.id ||
      manifest.version !== entry.version ||
      manifest.protocolVersion !== entry.protocolVersion ||
      manifest.appVersionRange !== entry.appVersionRange
    ) {
      throw new Error(`${entry.file} is not the package its catalogue entry describes`);
    }
    return bytes;
  }

  private url(path: string): string {
    return new URL(path, this.document.baseURI).href;
  }

  /** The body, refused once it passes `max` bytes — counted before it is all held. */
  private async read(url: string, max: number): Promise<Uint8Array> {
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Could not load ${url} (${response.status})`);
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new Error(`${url} is too large`);
    const reader = response.body?.getReader();
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > max) throw new Error(`${url} is too large`);
      return bytes;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error(`${url} is too large`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('This browser cannot check package integrity');
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
