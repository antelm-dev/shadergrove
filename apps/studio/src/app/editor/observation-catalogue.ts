import { Injectable } from '@angular/core';
import type { GlslAnalysisClient, ObservationCatalogue } from '@shadergrove/glsl-analysis';

import type { CapturedAccepted } from '../rendering/render-inspection';
import { preparedFragment } from './observation-source';

export type CatalogueResult =
  | { readonly ok: true; readonly catalogue: ObservationCatalogue }
  | { readonly ok: false; readonly reason: 'cancelled' | 'source' | 'unavailable' | 'invalid' };

async function createLocalClient(): Promise<GlslAnalysisClient> {
  // Loaded only when a catalogue is first asked for: the Worker and WASM stay out of everything else.
  const { GlslAnalysisClient, resolveGlslAnalysisAssets } =
    await import('@shadergrove/glsl-analysis');
  const assets = resolveGlslAnalysisAssets(new URL('glsl-analysis/', document.baseURI));
  return new GlslAnalysisClient({ assets });
}

/**
 * Asks the analysis front end for the verified observation catalogue of one
 * *captured accepted* fragment — never the editor's draft. It owns its own
 * client and session, so it neither shares nor disturbs the editor's analysis,
 * and it is only ever asked on an explicit user action.
 */
@Injectable({ providedIn: 'root' })
export class ObservationCatalogues {
  /** Test seam; the default loads the real client from the local assets. */
  createClient: () => Promise<GlslAnalysisClient> = createLocalClient;

  private client: Promise<GlslAnalysisClient> | null = null;
  private sequence = 0;
  private active: string | null = null;

  /** One catalogue at a time: a newer request supersedes the older, and `signal` cancels it. */
  async find(
    projectId: string,
    passId: string,
    accepted: CapturedAccepted,
    signal: AbortSignal,
  ): Promise<CatalogueResult> {
    const source = preparedFragment(accepted);
    if (source === null) return { ok: false, reason: 'source' };
    if (signal.aborted) return { ok: false, reason: 'cancelled' };

    this.client ??= this.createClient();
    let client: GlslAnalysisClient;
    try {
      client = await this.client;
    } catch {
      this.client = null;
      return { ok: false, reason: 'unavailable' };
    }
    if (signal.aborted) return { ok: false, reason: 'cancelled' };

    const sessionId = 'observation';
    const requestId = `o${++this.sequence}`;
    this.active = requestId;
    const onAbort = () => client.cancel(sessionId);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = await client.analyze({
        requestId,
        sessionId,
        projectId,
        revision: accepted.revision ?? 0,
        passId,
        stage: 'fragment',
        profile: { language: 'essl', version: 300 },
        source,
        observe: true,
      });
      // Superseded or aborted while the Worker was busy: nothing is published.
      if (signal.aborted || this.active !== requestId || reply.requestId !== requestId) {
        return { ok: false, reason: 'cancelled' };
      }
      if (reply.status === 'cancelled') return { ok: false, reason: 'cancelled' };
      if (reply.status === 'unavailable') return { ok: false, reason: 'unavailable' };
      if (reply.status !== 'ok' || !reply.observation) return { ok: false, reason: 'invalid' };
      return { ok: true, catalogue: reply.observation };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.active === requestId) this.active = null;
    }
  }

  ngOnDestroy(): void {
    const client = this.client;
    this.client = null;
    void client?.then((resolved) => resolved.dispose()).catch(() => undefined);
  }
}
