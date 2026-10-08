// Palette Studio end to end in the browser: the official package installed from
// its file, switched on and used from its Installed card — an image with alpha
// decoded by the host's image bridge and clustered by the real sandboxed
// Worker, a gradient edited and round-tripped through palette JSON, and the
// generated luminance-mapping effect previewed (compiled, never added), applied
// twice, saved, and still drawing the same pixels after the package is removed.
//
// Colour assumptions, stated so the CPU and GPU numbers can be compared: the
// test shader writes the sRGB-encoded grey 0.388581, whose linear luminance is
// 0.125, so the effect's t = cbrt(Y) is exactly 0.5; the canvas shows the
// effect's output bytes unchanged (no output transform), which the baseline
// pixel checks first.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { plane, writePng } from './textures-fixtures';

test.describe.configure({ timeout: 300_000 });

const ID = 'dev.shadergrove.palette-studio';
const REF = `${ID}/palette-studio`;
const PACKAGE = resolve(
  import.meta.dirname,
  '../../studio/src/plugins/dev.shadergrove.palette-studio-1.0.0.sgplugin.json',
);
const GREY = 0.388581;

/** The documented CPU arithmetic of the effect (see the package's notes), for one pixel. */
function mapped(rgb: readonly number[], stops: { position: number; color: number[] }[]): number[] {
  const linear = (c: number) => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb.map((byte) => linear(byte / 255));
  const t = Math.cbrt(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
  // Two srgb stops at 0 and 1: interpolation on the encoded values.
  const [from, to] = [stops[0]!.color, stops[1]!.color];
  return from.map((value, axis) => Math.round(value + (to[axis]! - value) * t));
}

/** A shader of this test's own, a flat grey, open and paused. */
async function openTarget(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/shaders', {
    data: { name, fragment: `void main() { gl_FragColor = vec4(vec3(${GREY}), 1.0); }` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { shader } = (await response.json()) as { shader: { id: string } };
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(shader.id)}`);
  return shader.id;
}

/** The live preview's centre pixel, as the canvas shows it. */
function centre(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const { ng } = window as unknown as {
      ng: {
        getComponent(element: Element | null): {
          engine(): { context: { canvas: HTMLCanvasElement } };
        };
      };
    };
    const source = ng.getComponent(document.querySelector('app-shader-canvas')).engine()
      .context.canvas;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext('2d')!;
    context.drawImage(source, 0, 0);
    const data = context.getImageData(source.width >> 1, source.height >> 1, 1, 1).data;
    return [data[0]!, data[1]!, data[2]!];
  });
}

async function expectCentre(page: Page, expected: number[]): Promise<void> {
  await expect
    .poll(async () => {
      const pixel = await centre(page);
      return pixel.every((value, axis) => Math.abs(value - expected[axis]!) <= 2)
        ? expected
        : pixel;
    })
    .toEqual(expected);
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL(/\/plugins/);
}

async function backToEditor(page: Page): Promise<void> {
  await page.getByRole('link', { name: /back to the editor/i }).click();
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
}

async function setEnabled(page: Page, on: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${ID}`).getByRole('switch');
  if ((await toggle.isChecked()) !== on) await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

async function save(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await expect(page.locator('.dirty')).toHaveCount(0, { timeout: 30_000 });
}

async function downloaded(page: Page, button: Locator): Promise<{ name: string; text: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return {
    name: download.suggestedFilename(),
    text: readFileSync((await download.path())!, 'utf8'),
  };
}

const swatches = (panel: Locator) =>
  panel
    .locator('[data-testid^="palette-swatch-"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-color')));
const stopColours = (panel: Locator) =>
  panel
    .locator('[data-testid^="palette-stop-color-"]')
    .evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value));

/** The effect preview's CPU samples, as drawn (33 opaque texels). */
const samples = (panel: Locator) =>
  panel.getByTestId('palette-samples').evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 1).data;
    return Array.from({ length: canvas.width }, (_, i) => [
      data[i * 4]!,
      data[i * 4 + 1]!,
      data[i * 4 + 2]!,
    ]);
  });

async function effects(page: Page, id: string) {
  const response = await page.request.get(`/api/shaders/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    shader: {
      render: {
        postProcessing: {
          effects: { type: string; instanceId: string; definition?: { source: string } }[];
        };
      };
    };
  };
  return body.shader.render.postProcessing.effects.filter((effect) => effect.type === 'custom');
}

/** Opaque red, green, blue, white over alpha 128 (brown), 64, 1 and 0. */
const ALPHA_IMAGE = plane(4, 2, (x, y) =>
  y === 0
    ? (
        [
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [255, 255, 255, 255],
        ] as const
      )[x]!
    : (
        [
          [200, 100, 50, 128],
          [10, 20, 30, 64],
          [250, 5, 125, 1],
          [77, 88, 99, 0],
        ] as const
      )[x]!,
);
const pngFile = (name: string, image: ReturnType<typeof plane>) => ({
  name,
  mimeType: 'image/png',
  buffer: writePng(image),
});

test('Palette Studio: alpha-aware extraction, gradient editing, JSON round-trip, effect applied twice and kept after removal', async ({
  page,
}) => {
  const id = await openTarget(page, 'Palette target');
  // No effect yet: the canvas shows the grey the shader wrote.
  await expectCentre(page, [99, 99, 99]);

  await openPlugins(page);
  await page.getByTestId('plugin-file').setInputFiles({
    name: 'palette-studio.sgplugin.json',
    mimeType: 'application/json',
    buffer: readFileSync(PACKAGE),
  });
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${ID}`)).toBeVisible();
  await setEnabled(page, true);
  const panel = page.getByTestId(`plugin-tool-${REF}`);
  await expect(panel.getByTestId('palette-stop-color-0')).toBeVisible();

  // Extraction from an image with alpha: alpha 64/1/0 are under the default threshold.
  await panel.getByTestId('palette-file').setInputFiles(pngFile('alpha.png', ALPHA_IMAGE));
  await expect(panel.getByTestId('palette-image')).toBeVisible();
  await expect
    .poll(() => swatches(panel))
    .toEqual(['#0000ff', '#ff0000', '#00ff00', '#ffffff', '#c86432']);
  expect(await stopColours(panel)).toHaveLength(5);
  expect((await stopColours(panel))[0]).toBe('#0000ff');
  expect((await stopColours(panel))[4]).toBe('#ffffff');
  await panel.getByTestId('palette-alpha').fill('1');
  await expect.poll(async () => (await swatches(panel)).length).toBe(6);
  await expect.poll(() => swatches(panel)).not.toContain('#4d5863');

  // A fully transparent image says so and leaves the palette alone.
  await panel.getByTestId('palette-file').setInputFiles(
    pngFile(
      'clear.png',
      plane(2, 2, () => [255, 0, 0, 0]),
    ),
  );
  await expect(panel.getByTestId('palette-status')).toHaveClass(/error/);
  await expect(panel.getByTestId('palette-status')).toContainText('noVisible');
  expect(await swatches(panel)).toHaveLength(6);

  // A palette file in, its stops reordered, and the edited palette out again.
  await panel.getByTestId('palette-import').setInputFiles({
    name: 'two-tone.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'shadergrove-palette/v1',
        name: '../Two tone',
        colors: ['#ff0000', '#000000'],
        gradient: {
          interpolation: 'srgb',
          stops: [
            { position: 0, color: '#ff0000' },
            { position: 1, color: '#000000' },
          ],
        },
      }),
    ),
  });
  await expect(panel.getByTestId('palette-name')).toHaveValue('../Two tone');
  await panel.getByTestId('palette-stop-down-0').click();
  expect(await stopColours(panel)).toEqual(['#000000', '#ff0000']);
  const exported = await downloaded(page, panel.getByTestId('palette-export'));
  expect(exported.name).toBe('Two-tone.json');
  const palette = JSON.parse(exported.text);
  expect(palette).toEqual({
    format: 'shadergrove-palette/v1',
    name: '../Two tone',
    colors: ['#ff0000', '#000000'],
    gradient: {
      interpolation: 'srgb',
      stops: [
        { position: 0, color: '#000000' },
        { position: 1, color: '#ff0000' },
      ],
    },
  });

  // The effect preview: compiled by the renderer, CPU samples drawn, nothing added to the draft.
  await expect(panel.getByTestId('palette-compile')).toContainText('compiles');
  const cpu = await samples(panel);
  expect(cpu).toHaveLength(33);
  expect(cpu[0]).toEqual([0, 0, 0]);
  expect(cpu[16]).toEqual([128, 0, 0]);
  expect(cpu[32]).toEqual([255, 0, 0]);
  expect(await effects(page, id)).toEqual([]);

  // Applied: the GPU agrees with the CPU sample at t = 0.5.
  await panel.getByTestId('palette-apply').click();
  await expect(panel.getByTestId('palette-notice')).toHaveAttribute('role', 'status');
  await backToEditor(page);
  const stops = [
    { position: 0, color: [0, 0, 0] },
    { position: 1, color: [255, 0, 0] },
  ];
  const once = mapped([99, 99, 99], stops);
  expect(once.map((value, axis) => Math.abs(value - cpu[16]![axis]!) <= 1)).toEqual([
    true,
    true,
    true,
  ]);
  await expectCentre(page, once);
  await save(page);

  // A second instance from the saved file: the effect maps the first one's output again.
  await openPlugins(page);
  await panel.getByTestId('palette-import').setInputFiles({
    name: exported.name,
    mimeType: 'application/json',
    buffer: Buffer.from(exported.text),
  });
  expect(await stopColours(panel)).toEqual(['#000000', '#ff0000']);
  await expect(panel.getByTestId('palette-compile')).toContainText('compiles');
  await panel.getByTestId('palette-apply').click();
  await expect(panel.getByTestId('palette-notice')).toHaveAttribute('role', 'status');
  await backToEditor(page);
  const twice = mapped(once, stops);
  await expectCentre(page, twice);
  await save(page);
  const saved = await effects(page, id);
  expect(saved).toHaveLength(2);
  expect(saved[0]!.instanceId).not.toBe(saved[1]!.instanceId);
  for (const effect of saved) {
    expect(effect.definition!.source).toContain('pgGradient');
    expect(JSON.parse(effect.definition!.source.split('\n')[1]!.slice(3))).toEqual(palette);
  }

  // Switched off, the tool is gone; removed, the shader keeps both copies and draws the same.
  await openPlugins(page);
  await setEnabled(page, false);
  await expect(panel).toHaveCount(0);
  await page.getByTestId(`plugin-remove-${ID}`).click();
  await expect(page.getByTestId(`plugin-${ID}`)).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('mat-toolbar.toolbar')).toBeVisible();
  await page.locator('app-shader-browser .shader-row', { hasText: 'Palette target' }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(id)}`);
  expect(await effects(page, id)).toEqual(saved);
  await expectCentre(page, twice);
});
