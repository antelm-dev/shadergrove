import { describe, expect, it } from 'vitest';

import {
  DEFAULT_VISUAL,
  classifyComponent,
  clampExposure,
  formatRaw,
  formatUniform,
  fragCoord,
  linearToSrgb,
  parseCoordinate,
  parseVisit,
  pickTexel,
  stepTexel,
  stepZoom,
  visualizeBand,
  visualizeTexel,
} from './render-inspection-model';

const SIZE = { width: 8, height: 4 };

describe('parseVisit', () => {
  it('accepts whole visits from 1 to the maximum only', () => {
    expect(parseVisit('1', 128)).toBe(1);
    expect(parseVisit(' 128 ', 128)).toBe(128);
    for (const bad of ['', '0', '129', '-1', '1.5', '1e2', '0x10', 'a', '١']) {
      expect(parseVisit(bad, 128), bad).toBeNull();
    }
  });
});

describe('pickTexel', () => {
  it('maps the top-left screen corner to the top row, with y counted from the bottom', () => {
    const rect = { left: 10, top: 20, width: 80, height: 40 };
    expect(pickTexel(rect, 10, 20, SIZE)).toEqual({ x: 0, y: 3 });
    expect(pickTexel(rect, 89.9, 59.9, SIZE)).toEqual({ x: 7, y: 0 });
  });

  it('is independent of CSS size, zoom and device pixel ratio: only the rendered rectangle matters', () => {
    // The same texel (5, 1) is hit at every scale of the rendered box.
    for (const scale of [0.25, 1, 2, 3.5, 32]) {
      const rect = { left: 7, top: 11, width: SIZE.width * scale, height: SIZE.height * scale };
      const centreX = rect.left + (5 + 0.5) * scale;
      const centreY = rect.top + (SIZE.height - 1 - 1 + 0.5) * scale;
      expect(pickTexel(rect, centreX, centreY, SIZE)).toEqual({ x: 5, y: 1 });
    }
  });

  it('handles a stretched, non-uniform CSS box', () => {
    const rect = { left: 0, top: 0, width: 800, height: 100 };
    expect(pickTexel(rect, 799, 99, SIZE)).toEqual({ x: 7, y: 0 });
    expect(pickTexel(rect, 150, 26, SIZE)).toEqual({ x: 1, y: 2 });
  });

  it('rejects positions outside the image instead of clamping them', () => {
    const rect = { left: 0, top: 0, width: 80, height: 40 };
    expect(pickTexel(rect, -0.1, 5, SIZE)).toBeNull();
    expect(pickTexel(rect, 80, 5, SIZE)).toBeNull();
    expect(pickTexel(rect, 5, 40, SIZE)).toBeNull();
    expect(pickTexel(rect, 5, -1, SIZE)).toBeNull();
    expect(pickTexel(rect, Number.NaN, 5, SIZE)).toBeNull();
  });

  it('rejects a collapsed rectangle or an empty image', () => {
    expect(pickTexel({ left: 0, top: 0, width: 0, height: 10 }, 0, 0, SIZE)).toBeNull();
    expect(
      pickTexel({ left: 0, top: 0, width: 10, height: 10 }, 0, 0, { width: 0, height: 4 }),
    ).toBeNull();
  });
});

describe('typed and keyboard coordinates', () => {
  it('accepts whole numbers inside the image only', () => {
    expect(parseCoordinate('0', 8)).toBe(0);
    expect(parseCoordinate(' 7 ', 8)).toBe(7);
    for (const bad of ['8', '-1', '1.5', '', 'x', '1e1', '+2']) {
      expect(parseCoordinate(bad, 8)).toBeNull();
    }
  });

  it('keeps keyboard steps on the image', () => {
    expect(stepTexel({ x: 0, y: 0 }, -1, -1, SIZE)).toEqual({ x: 0, y: 0 });
    expect(stepTexel({ x: 7, y: 3 }, 10, 10, SIZE)).toEqual({ x: 7, y: 3 });
    expect(stepTexel({ x: 3, y: 1 }, 1, 1, SIZE)).toEqual({ x: 4, y: 2 });
  });

  it('reports gl_FragCoord at the texel centre', () => {
    expect(fragCoord({ x: 3, y: 0 })).toEqual([3.5, 0.5]);
  });
});

describe('stepZoom', () => {
  it('moves through the levels and stops at either end', () => {
    expect(stepZoom(null, 1)).toBe(2);
    expect(stepZoom(1, 1)).toBe(2);
    expect(stepZoom(1, -1)).toBe(0.5);
    expect(stepZoom(32, 1)).toBe(32);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });
});

describe('raw values', () => {
  it('writes every digit and never hides a non-finite or negative-zero value', () => {
    expect(formatRaw(Number.NaN)).toBe('NaN');
    expect(formatRaw(Infinity)).toBe('+Infinity');
    expect(formatRaw(-Infinity)).toBe('-Infinity');
    expect(formatRaw(-0)).toBe('-0');
    expect(formatRaw(2048)).toBe('2048');
    expect(formatRaw(0.1)).toBe('0.1');
    expect(formatRaw(Math.fround(0.1))).toBe('0.10000000149011612');
  });

  it('flags what is not an ordinary [0, 1] value', () => {
    expect(classifyComponent(Number.NaN, 'rgba32f')).toBe('nan');
    expect(classifyComponent(Infinity, 'rgba16f')).toBe('posInf');
    expect(classifyComponent(-Infinity, 'rgba16f')).toBe('negInf');
    expect(classifyComponent(-0.25, 'rgba16f')).toBe('negative');
    expect(classifyComponent(2048, 'rgba16f')).toBe('hdr');
    expect(classifyComponent(0.5, 'rgba32f')).toBe('normal');
    // Bytes are never "HDR".
    expect(classifyComponent(255, 'rgba8')).toBe('normal');
  });

  it('formats uniforms, including nested arrays and non-finite numbers', () => {
    expect(formatUniform(1.5)).toBe('1.5');
    expect(formatUniform(true)).toBe('true');
    expect(formatUniform([1, [2, Number.NaN]])).toBe('[1, [2, NaN]]');
  });
});

describe('visualization', () => {
  const draw = (
    rgba: number[],
    format: 'rgba8' | 'rgba16f' | 'rgba32f',
    options = DEFAULT_VISUAL,
  ) => {
    const out = new Uint8ClampedArray(4);
    visualizeTexel(rgba, 0, format, options, out, 0);
    return Array.from(out);
  };

  it('clamps HDR to white and negatives to black, which is not the raw value', () => {
    expect(draw([2048, -0.25, 0.5, 1], 'rgba32f')).toEqual([255, 0, 128, 255]);
  });

  it('scales bytes into 0–1 first', () => {
    expect(draw([255, 0, 51, 255], 'rgba8')).toEqual([255, 0, 51, 255]);
  });

  it('applies exposure before the transform', () => {
    expect(draw([0.25, 0.25, 0.25, 1], 'rgba32f', { ...DEFAULT_VISUAL, exposure: 1 })).toEqual([
      128, 128, 128, 255,
    ]);
    expect(draw([2, 2, 2, 1], 'rgba32f', { ...DEFAULT_VISUAL, exposure: -1 })).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('encodes sRGB on request', () => {
    expect(linearToSrgb(0)).toBe(0);
    expect(linearToSrgb(1)).toBeCloseTo(1, 12);
    expect(draw([0.5, 0.5, 0.5, 1], 'rgba32f', { ...DEFAULT_VISUAL, transform: 'srgb' })).toEqual([
      188, 188, 188, 255,
    ]);
  });

  it('isolates one channel as grey, ignoring the others', () => {
    expect(draw([1, 0.5, 0, 0.25], 'rgba32f', { ...DEFAULT_VISUAL, channel: 'g' })).toEqual([
      128, 128, 128, 255,
    ]);
    expect(draw([1, 0.5, 0, 0.25], 'rgba32f', { ...DEFAULT_VISUAL, channel: 'a' })).toEqual([
      64, 64, 64, 255,
    ]);
  });

  it('draws non-finite components as their own colours, not as a plausible value', () => {
    expect(draw([Number.NaN, 0, 0, 1], 'rgba32f')).toEqual([255, 0, 255, 255]);
    expect(draw([0, Infinity, 0, 1], 'rgba32f')).toEqual([255, 255, 255, 255]);
    expect(draw([0, -Infinity, 0, 1], 'rgba32f')).toEqual([0, 255, 255, 255]);
    expect(draw([Infinity, -Infinity, 0, 1], 'rgba32f')).toEqual([255, 255, 255, 255]);
    // An isolated channel only looks at its own value.
    expect(draw([Number.NaN, 0.5, 0, 1], 'rgba32f', { ...DEFAULT_VISUAL, channel: 'g' })).toEqual([
      128, 128, 128, 255,
    ]);
  });

  it('limits and sanitises exposure', () => {
    expect(clampExposure(100)).toBe(16);
    expect(clampExposure(-100)).toBe(-16);
    expect(clampExposure(Number.NaN)).toBe(0);
  });

  it('draws a band of bottom-up texel rows top-down, and says where it lands', () => {
    // A 2×3 image; rows 1..2 (bottom-up) form the band. Texel row 2 is the top of the picture.
    const band = [
      // row 1
      0.2, 0.2, 0.2, 1, 0.2, 0.2, 0.2, 1,
      // row 2
      1, 1, 1, 1, 1, 1, 1, 1,
    ];
    const out = new Uint8ClampedArray(2 * 2 * 4);
    const top = visualizeBand(band, 2, 2, 1, 3, 'rgba32f', DEFAULT_VISUAL, out);
    expect(top).toBe(0);
    expect(Array.from(out.slice(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(out.slice(8, 12))).toEqual([51, 51, 51, 255]);
  });
});
