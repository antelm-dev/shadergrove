/**
 * Shader Doctor — the Worker side.
 *
 * Gets a snapshot of the open draft (texture metadata and the host's observed
 * load state, never bytes) and the capability profile the host chose, and
 * answers with structural findings for that target. It reads the project's
 * shape only — passes, bindings, slots, the post-processing chain — and never
 * the GLSL: whether a shader actually reads a channel, or compiles on the
 * target, is listed as not checked rather than guessed from the source text.
 */
import type {
  AnalyzerFinding,
  AnalyzerInput,
  AnalyzerReport,
  FindingLocation,
} from '@shadergrove/shared/plugin';
import { resolvePassOrder, type ChannelIndex, type RenderPass } from '@shadergrove/shared/project';

/** Every rule this analyzer evaluates, on every profile. */
const CHECKED_RULES = [
  'limits.passes',
  'limits.controls',
  'features.common',
  'features.feedback',
  'features.post-processing',
  'bindings.buffer',
  'resources.texture',
];

/** What it never evaluates: they need the GLSL itself, which this version does not parse. */
const UNCHECKED_RULES = ['limits.source', 'source.portability'];

const MESSAGE_LENGTH = 300;
const bounded = (text: string): string =>
  text.length <= MESSAGE_LENGTH ? text : `${text.slice(0, MESSAGE_LENGTH - 1)}…`;

function diagnose(input: AnalyzerInput): AnalyzerReport {
  const { profile, project } = input;
  const wallpaper = profile.id === 'wallpaper-web/v1';
  const findings: AnalyzerFinding[] = [];
  const add = (
    ruleId: string,
    severity: AnalyzerFinding['severity'],
    confidence: AnalyzerFinding['confidence'],
    coverage: AnalyzerFinding['coverage'],
    message: string,
    location?: FindingLocation,
  ) =>
    findings.push({
      ruleId,
      severity,
      confidence,
      coverage,
      message: bounded(message),
      targetVersion: profile.version,
      ...(location ? { location } : {}),
    });
  const at = (pass: RenderPass, channel: ChannelIndex): FindingLocation => ({
    kind: 'binding',
    passId: pass.id,
    channel,
  });

  // What the target draws: the Image pass and every enabled buffer, as both the
  // preview and the Wallpaper export order them. The Common pass is composed in.
  const { order: drawn, errors } = resolvePassOrder(project);

  if (drawn.length > profile.limits.passes) {
    add(
      'limits.passes',
      'error',
      'certain',
      'structural',
      `${drawn.length} passes are drawn; ${profile.name} draws at most ${profile.limits.passes}.`,
    );
  }
  if (input.controls.length > profile.limits.controls) {
    add(
      'limits.controls',
      'error',
      'certain',
      'structural',
      `${input.controls.length} controls; ${profile.name} takes at most ${profile.limits.controls}.`,
    );
  }

  const common = project.passes.find((pass) => pass.kind === 'common');
  if (!profile.features.commonPass && common && common.source.trim() !== '') {
    add(
      'features.common',
      'error',
      'certain',
      'structural',
      `${profile.name} has no Common pass; its code would be missing from every pass.`,
    );
  }

  if (!profile.features.feedback) {
    for (const pass of drawn) {
      pass.channels.forEach((binding, channel) => {
        if (binding.kind !== 'buffer' || !binding.feedback) return;
        add(
          'features.feedback',
          'error',
          'certain',
          'structural',
          `${pass.name} iChannel${channel} reads a previous frame; ${profile.name} has no feedback.`,
          at(pass, channel as ChannelIndex),
        );
      });
    }
  }

  if (input.postProcessingActive && !profile.features.postProcessing) {
    const chain = input.render.postProcessing;
    const names = chain.effects
      .filter((effect) => effect.enabled)
      .map((effect) =>
        effect.type === 'custom'
          ? effect.definition.name
          : effect.type === 'bloom'
            ? 'Bloom'
            : 'Vignette',
      );
    add(
      'features.post-processing',
      'error',
      'certain',
      'structural',
      `${profile.name} does not include post-processing: ${names.join(', ')} will be missing, and it renders the passes without them.`,
    );
  }

  // The editor already lists these as project problems; here they say what the target does.
  for (const error of errors) {
    const pass = project.passes.find((candidate) => candidate.id === error.passId);
    const consequence = wallpaper ? ' The export refuses the project until this is fixed.' : '';
    add(
      'bindings.buffer',
      'warning',
      'certain',
      'structural',
      `${pass ? `${pass.name}: ` : ''}${error.message}${consequence}`,
      pass && error.channel !== null ? at(pass, error.channel) : undefined,
    );
  }

  // Texture slots the drawn passes bind, judged only by what the host saw happen to them:
  // `empty` and `loaded` are verdicts, anything else is reported as unchecked.
  const uses = new Map<number, { pass: RenderPass; channel: ChannelIndex }[]>();
  for (const pass of drawn) {
    pass.channels.forEach((binding, channel) => {
      if (binding.kind !== 'texture') return;
      const list = uses.get(binding.slot) ?? [];
      list.push({ pass, channel: channel as ChannelIndex });
      uses.set(binding.slot, list);
    });
  }
  const empty: number[] = [];
  for (const [slot, list] of [...uses].sort(([a], [b]) => a - b)) {
    const first = list[0]!;
    const where = `${first.pass.name} iChannel${first.channel}`;
    const state = input.channels[slot]?.state ?? 'unknown';
    if (!profile.features.textures && state !== 'empty') {
      add(
        'resources.texture',
        'error',
        'certain',
        'structural',
        `${profile.name} has no textures; ${where} samples slot ${slot}.`,
        at(first.pass, first.channel),
      );
    } else if (state === 'empty') {
      empty.push(slot);
    } else if (state === 'failed') {
      // A settled failure is never a pass; like any state but empty or loaded it is no verdict either.
      add(
        'resources.texture',
        'warning',
        'likely',
        'unchecked',
        `The image in texture slot ${slot} (${where}) failed to load in the preview, which samples an empty texture instead. Whether ${profile.name} can use it is not checked.`,
        at(first.pass, first.channel),
      );
    } else if (state !== 'loaded') {
      add(
        'resources.texture',
        'info',
        'possible',
        'unchecked',
        state === 'loading'
          ? `Not checked: the image in texture slot ${slot} (${where}) is still loading.`
          : `Not checked: the image in texture slot ${slot} (${where}) has not been seen loading in the preview.`,
        at(first.pass, first.channel),
      );
    }
  }
  if (empty.length > 0) {
    // An empty slot samples a transparent placeholder, on purpose; only the intent is in doubt.
    const first = uses.get(empty[0]!)![0]!;
    add(
      'resources.texture',
      'warning',
      'possible',
      'structural',
      `Texture slot${empty.length > 1 ? 's' : ''} ${empty.join(', ')} ${empty.length > 1 ? 'have' : 'has'} no image, so the passes bound to ${empty.length > 1 ? 'them' : 'it'} sample a transparent placeholder. Whether the shader reads ${empty.length > 1 ? 'them' : 'it'} is not checked.`,
      at(first.pass, first.channel),
    );
  }

  const rank = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    profile: profile.id,
    targetVersion: profile.version,
    revision: input.revision,
    checkedRules: CHECKED_RULES,
    uncheckedRules: UNCHECKED_RULES,
    findings,
  };
}

shaderStudio.handle('analyzer:doctor', (params) => diagnose(params as AnalyzerInput));
