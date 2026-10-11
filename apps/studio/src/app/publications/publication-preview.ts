import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { composePass } from '@shadergrove/shared/pass-source';
import { resolvePassOrder } from '@shadergrove/shared/project';
import type { PublicationDetail } from '@shadergrove/shared/publication';
import { defaultParams } from '@shadergrove/shared/validate';
import { I18n } from '../i18n/i18n';
import { GlContextRegistry } from '../rendering/gl-context-registry';
import { type ChannelSource, type EnginePass, ShaderEngine } from '@shadergrove/rendering';
import { PublicationApi } from './publication-api';

/**
 * A live render of a published snapshot, on a WebGL context of its own.
 *
 * It exists only while it is on screen: the page mounts it when the visitor
 * asks for the preview and removes it to stop, and being destroyed is what
 * frees the context, the compiled programs and the frame loop. Nothing here
 * runs on the server — the engine is created after the first browser render.
 *
 * It never touches `ShaderStore`: a public shader being looked at is not a
 * document in anyone's library, and must not become one by being previewed.
 * A shader this device cannot compile, or a lost context, is a message in the
 * frame rather than an error in the page.
 */
@Component({
  selector: 'app-publication-preview',
  template: `
    <canvas #canvas class="canvas" aria-hidden="true"></canvas>
    @if (problem(); as message) {
      <p class="problem" role="alert">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      background: #0b0b0c;
    }

    .canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .problem {
      position: absolute;
      inset: auto 0 0;
      margin: 0;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--mat-sys-error-container) 92%, transparent);
      color: var(--mat-sys-on-error-container);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class PublicationPreview {
  readonly publication = input.required<PublicationDetail>();

  private readonly api = inject(PublicationApi);
  private readonly contexts = inject(GlContextRegistry);
  private readonly i18n = inject(I18n);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly problem = signal<string | null>(null);

  private destroyed = false;
  private release: (() => void) | null = null;

  constructor() {
    afterNextRender(() => void this.boot());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.release?.();
    });
  }

  private async boot(): Promise<void> {
    const canvas = this.canvas().nativeElement;
    let engine: ShaderEngine;
    try {
      engine = await ShaderEngine.create(await this.contexts.create(canvas));
    } catch {
      this.problem.set(this.i18n.t('explore.previewUnavailable'));
      return;
    }

    const observer = new ResizeObserver(() => engine.resize());
    this.release = () => {
      observer.disconnect();
      // Disposes the context with it, which is what takes it out of the registry.
      engine.dispose();
    };
    // Stopped while the context was still being created.
    if (this.destroyed) {
      this.release();
      return;
    }

    engine.onContextLost = () => this.problem.set(this.i18n.t('explore.previewLost'));
    engine.onContextRestored = () => this.problem.set(null);

    const publication = this.publication();
    const { project, controls, render, channels } = publication.shader;
    let failed = false;
    const passes = resolvePassOrder(project).order.map((pass): EnginePass => {
      const { source, spans, errors } = composePass(project, pass);
      failed ||= errors.length > 0;
      return {
        id: pass.id,
        kind: pass.kind === 'image' ? 'image' : 'buffer',
        fragment: source,
        spans,
        channels: pass.channels,
        resolution: pass.resolution,
        filter: pass.filter,
        wrap: pass.wrap,
      };
    });
    const textures = channels.map((channel, index): ChannelSource | null =>
      channel.ext === null
        ? null
        : {
            url: this.api.textureUrl(publication, index),
            wrap: channel.wrap,
            filter: channel.filter,
            flipY: channel.flipY,
          },
    );

    const diagnostics = engine.setPasses({
      vertex: project.vertex,
      controls,
      params: defaultParams(controls),
      render,
      passes,
      textures,
    });
    if (failed || diagnostics.some((entry) => entry.severity === 'error')) {
      this.problem.set(this.i18n.t('explore.previewFailed'));
    }
    observer.observe(canvas);
  }
}
