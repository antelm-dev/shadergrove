// Texture Utilities end to end in the browser: the official package installed
// from its file, switched on, and used from its Installed card — images decoded
// by the host's image bridge, the `assetTool:` call run in the real sandboxed
// Worker, results checked byte for byte in the preview, the downloaded PNG and
// sidecar, and the texture slot it was explicitly assigned to (and no other).
// A hostile package on the same workflow shows that a full job is cancelled
// and timed out for real, and that switching it off drops what it was doing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from './fixtures';
import { SOURCES, channel, plane, readPng, writePng, type Rgba } from './textures-fixtures';

test.describe.configure({ timeout: 300_000 });

const ID = 'dev.shadergrove.texture-utilities';
const REF = `${ID}/texture-utilities`;
const PACKAGE = resolve(
  import.meta.dirname,
  '../../studio/src/plugins/dev.shadergrove.texture-utilities-1.0.0.sgplugin.json',
);

/** A shader of this test's own, open and paused, so assigning a texture touches nothing shared. */
async function openTarget(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/shaders', {
    data: { name, fragment: 'void main() { gl_FragColor = vec4(0.5); }' },
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

/** Plugins, then a package from a file: reviewed, installed (off), switched on. */
async function installFile(
  page: Page,
  id: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByTestId('open-plugins').click();
  await expect(page).toHaveURL(/\/plugins/);
  await page.getByTestId('plugin-file').setInputFiles(file);
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.getByTestId('plugin-install').click();
  await expect(page.getByTestId(`plugin-${id}`)).toBeVisible();
  await setEnabled(page, id, true);
}

async function setEnabled(page: Page, id: string, on: boolean): Promise<void> {
  const toggle = page.getByTestId(`plugin-enable-${id}`).getByRole('switch');
  await toggle.click();
  if (on) await expect(toggle).toBeChecked();
  else await expect(toggle).not.toBeChecked();
}

const pngFile = (name: string, image: Rgba) => ({
  name,
  mimeType: 'image/png',
  buffer: writePng(image),
});

/** The preview canvas's pixels (drawn opaque in the r/g/b/a and rgb views, so exact). */
const previewPixels = (panel: Locator) =>
  panel.getByTestId('textures-preview').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')!;
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  });

async function downloaded(page: Page, button: Locator): Promise<{ name: string; bytes: Buffer }> {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: download.suggestedFilename(), bytes: readFileSync((await download.path())!) };
}

async function channels(page: Page, id: string): Promise<(string | null)[]> {
  const response = await page.request.get(`/api/shaders/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { shader: { channels: { ext: string | null }[] } };
  return body.shader.channels.map((slot) => slot.ext);
}

async function slotPng(page: Page, id: string, slot: number): Promise<Rgba> {
  const response = await page.request.get(
    `/api/shaders/${encodeURIComponent(id)}/textures/${slot}?v=${Date.now()}`,
  );
  expect(response.ok()).toBe(true);
  return readPng(await response.body());
}

test('Texture Utilities: four images packed exactly, inspected, downloaded and assigned to the chosen slot only', async ({
  page,
}) => {
  const id = await openTarget(page, 'Texture pack target');
  await installFile(page, ID, {
    name: 'texture-utilities.sgplugin.json',
    mimeType: 'application/json',
    buffer: readFileSync(PACKAGE),
  });
  const panel = page.getByTestId(`plugin-tool-${REF}`);
  await expect(panel.getByTestId('textures-op-pack')).toBeChecked();

  for (const [slot, source] of SOURCES.entries()) {
    await panel
      .getByTestId(`textures-file-${slot}`)
      .setInputFiles(pngFile(`source-${slot + 1}.png`, source));
    await expect(panel.getByTestId(`textures-image-${slot}`)).toBeVisible();
  }
  // The output follows the first image's size.
  await expect(panel.getByTestId('textures-width')).toHaveValue('4');
  await expect(panel.getByTestId('textures-height')).toHaveValue('2');

  // R ← image 1 red (the default), G ← image 2 green, B ← image 3 blue, A ← image 4 alpha.
  await panel.getByTestId('textures-source-1').selectOption('1');
  await panel.getByTestId('textures-source-2').selectOption('2');
  await panel.getByTestId('textures-source-3').selectOption('3');
  await panel.getByTestId('textures-channel-3').selectOption('a');
  await panel.getByTestId('textures-name').fill('../Packed ORM');
  const expected = new Uint8Array(4 * 2 * 4);
  for (let texel = 0; texel < 8; texel++) {
    for (let c = 0; c < 4; c++) expected[texel * 4 + c] = SOURCES[c]!.rgba[texel * 4 + c]!;
  }

  // Each channel's raw bytes, as grey, in the preview: the decode kept the colour under low
  // alpha, and the Worker copied it exactly.
  for (const [index, view] of (['r', 'g', 'b', 'a'] as const).entries()) {
    await panel.getByTestId('textures-view').selectOption(view);
    await expect
      .poll(async () => {
        const { width, data } = await previewPixels(panel);
        return width === 4 ? data.filter((_, i) => i % 4 === 0) : null;
      })
      .toEqual(Array.from({ length: 8 }, (_, texel) => expected[texel * 4 + index]));
  }
  await panel.getByTestId('textures-tile').check();
  await expect.poll(async () => (await previewPixels(panel)).width).toBe(12);
  await expect(panel.getByTestId('textures-seams')).toBeVisible();

  const started = Date.now();
  await panel.getByTestId('textures-generate').click();
  await expect(panel.getByTestId('textures-result')).toHaveText(/4×2 · data · straight/);
  console.info(`texture-utilities: 4×(4×2) pack in the real Worker: ${Date.now() - started} ms`);

  // The plugin named it "../Packed ORM"; the file is named by the host.
  const png = await downloaded(page, panel.getByTestId('textures-download-png'));
  expect(png.name).toBe('Packed-ORM.png');
  const decoded = readPng(png.bytes);
  expect([decoded.width, decoded.height]).toEqual([4, 2]);
  expect([...decoded.rgba]).toEqual([...expected]);

  const sidecarFile = await downloaded(page, panel.getByTestId('textures-download-sidecar'));
  expect(sidecarFile.name).toBe('Packed-ORM.json');
  const sidecar = JSON.parse(sidecarFile.bytes.toString('utf8'));
  expect(sidecar).toMatchObject({
    format: 'shadergrove-image/v1',
    file: 'Packed-ORM.png',
    width: 4,
    height: 2,
    orientation: 'top-left',
    alpha: 'straight',
    usage: 'data',
    encoding: 'none',
    operation: 'pack',
    channels: [
      { output: 'red', image: 1, channel: 'red' },
      { output: 'green', image: 2, channel: 'green' },
      { output: 'blue', image: 3, channel: 'blue' },
      { output: 'alpha', image: 4, channel: 'alpha' },
    ],
  });

  // Assigned to iChannel2, explicitly: that slot gets exactly these bytes, no other slot changes.
  expect(await channels(page, id)).toEqual([null, null, null, null]);
  await panel.getByTestId('textures-slot').selectOption('2');
  await panel.getByTestId('textures-assign').click();
  await expect.poll(() => channels(page, id)).toEqual([null, null, 'png', null]);
  await expect(panel.getByTestId('textures-notice')).toHaveAttribute('role', 'status');
  expect([...(await slotPng(page, id, 2)).rgba]).toEqual([...expected]);

  // A changed selection makes the result out of date: nothing to download or assign.
  await panel.getByTestId('textures-source-3').selectOption('constant');
  await expect(panel.getByTestId('textures-stale')).toBeVisible();
  await expect(panel.getByTestId('textures-download-png')).toHaveCount(0);
  await expect(panel.getByTestId('textures-assign')).toHaveCount(0);

  // Switched off, the tool is gone from the card.
  await setEnabled(page, ID, false);
  await expect(panel).toHaveCount(0);
});

/** The documented normal of the height at each texel (see the package's notes). */
function normals(
  heights: Rgba,
  options: { strength: number; green: 'up' | 'down'; edges: 'wrap' | 'clamp' },
): number[] {
  const { width, height } = heights;
  const at = (x: number, y: number) => {
    const cx = options.edges === 'wrap' ? (x + width) % width : Math.min(width - 1, Math.max(0, x));
    const cy =
      options.edges === 'wrap' ? (y + height) % height : Math.min(height - 1, Math.max(0, y));
    return heights.rgba[(cy * width + cx) * 4]! / 255;
  };
  const encode = (value: number) => Math.round((value * 0.5 + 0.5) * 255);
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = -options.strength * ((at(x + 1, y) - at(x - 1, y)) / 2);
      const ny =
        -options.strength * ((at(x, y - 1) - at(x, y + 1)) / 2) * (options.green === 'up' ? 1 : -1);
      const length = Math.hypot(nx, ny, 1);
      out.push(encode(nx / length), encode(ny / length), encode(1 / length), 255);
    }
  }
  return out;
}

test('Texture Utilities: normals from flat and ramp heights, green flipped, assigned to the chosen slot', async ({
  page,
}) => {
  const id = await openTarget(page, 'Texture normal target');
  await installFile(page, ID, {
    name: 'texture-utilities.sgplugin.json',
    mimeType: 'application/json',
    buffer: readFileSync(PACKAGE),
  });
  const panel = page.getByTestId(`plugin-tool-${REF}`);
  await panel.getByTestId('textures-op-normal').check();
  await panel.getByTestId('textures-view').selectOption('rgb');
  const rgb = async () => (await previewPixels(panel)).data;

  // Flat: (128, 128, 255) everywhere.
  const flat = plane(4, 4, () => [100, 100, 100, 255]);
  await panel.getByTestId('textures-file-0').setInputFiles(pngFile('flat.png', flat));
  await expect.poll(rgb).toEqual(Array.from({ length: 16 }, () => [128, 128, 255, 255]).flat());

  // A ramp rising towards the top and the right, clamped edges: green up (OpenGL), then down.
  const ramp = plane(4, 4, (x, y) => {
    const value = Math.min(255, x * 40 + (3 - y) * 50);
    return [value, value, value, 255];
  });
  await panel.getByTestId('textures-file-0').setInputFiles(pngFile('ramp.png', ramp));
  await panel.getByTestId('textures-edges').selectOption('clamp');
  const up = normals(ramp, { strength: 2, green: 'up', edges: 'clamp' });
  await expect.poll(rgb).toEqual(up);
  // The rise is towards the top, so the normal leans down: green below 128 with +Y up.
  expect(channel({ ...ramp, rgba: Uint8Array.from(up) }, 1).every((g) => g <= 128)).toBe(true);

  await panel.getByTestId('textures-green').selectOption('down');
  const down = normals(ramp, { strength: 2, green: 'down', edges: 'clamp' });
  await expect.poll(rgb).toEqual(down);

  await panel.getByTestId('textures-generate').click();
  await expect(panel.getByTestId('textures-result')).toHaveText(/4×4 · data · opaque/);
  const png = await downloaded(page, panel.getByTestId('textures-download-png'));
  expect([...readPng(png.bytes).rgba]).toEqual(down);
  const sidecar = JSON.parse(
    (await downloaded(page, panel.getByTestId('textures-download-sidecar'))).bytes.toString('utf8'),
  );
  expect(sidecar).toMatchObject({
    operation: 'normal',
    usage: 'data',
    alpha: 'opaque',
    normal: { y: 'down (DirectX, -Y)', strength: 2, edges: 'clamp (edge texel repeated)' },
  });

  await panel.getByTestId('textures-slot').selectOption('3');
  await panel.getByTestId('textures-assign').click();
  await expect.poll(() => channels(page, id)).toEqual([null, null, null, 'png']);
  await expect(panel.getByTestId('textures-notice')).toHaveAttribute('role', 'status');
  expect([...(await slotPng(page, id, 3)).rgba]).toEqual(down);

  // A full-size job: the throughput of the real Worker at the bound.
  const big = plane(1024, 1024, (x, y) => {
    const value = (x ^ y) & 255;
    return [value, value, value, 255];
  });
  await panel.getByTestId('textures-file-0').setInputFiles(pngFile('big.png', big));
  // The size was never set by hand, so it follows the new image.
  await expect(panel.getByTestId('textures-width')).toHaveValue('1024');
  await expect(panel.getByTestId('textures-height')).toHaveValue('1024');
  const started = Date.now();
  await panel.getByTestId('textures-generate').click();
  await expect(panel.getByTestId('textures-result')).toHaveText(/1024×1024 · data · opaque/, {
    timeout: 20_000,
  });
  console.info(
    `texture-utilities: 1024² normal map in the real Worker: ${Date.now() - started} ms`,
  );
});

const SLOW_ID = 'dev.example.slow-textures';
const SLOW_PACKAGE = JSON.stringify({
  manifest: {
    id: SLOW_ID,
    version: '1.0.0',
    protocolVersion: 4,
    appVersionRange: '>=2.0.0 <3.0.0',
    name: 'Slow textures',
    publisher: 'Example',
    license: 'MIT',
    contributions: [
      {
        kind: 'assetTool',
        id: 'slow',
        name: 'Slow',
        workflow: 'texture-utilities/v1',
        inputs: ['image'],
        outputs: ['image'],
      },
    ],
  },
  // Previews echo the input; a full job never answers.
  code: `shaderStudio.handle('assetTool:slow', (input) => input.preview
    ? { kind: 'image', metadata: {}, images: [{ name: 'echo', width: input.planes[0].width,
        height: input.planes[0].height, orientation: 'top-left', alpha: input.planes[0].alpha,
        usage: input.planes[0].usage, rgba: input.planes[0].rgba }] }
    : new Promise(() => {}));`,
});

test('Texture tools: a full job in the sandboxed Worker is cancelled, timed out and dropped for real', async ({
  page,
}) => {
  await openTarget(page, 'Texture slow target');
  await installFile(page, SLOW_ID, {
    name: 'slow.sgplugin.json',
    mimeType: 'application/json',
    buffer: Buffer.from(SLOW_PACKAGE),
  });
  const panel = page.getByTestId(`plugin-tool-${SLOW_ID}/slow`);
  const frames = page.locator('iframe[sandbox]');
  await panel.getByTestId('textures-file-0').setInputFiles(
    pngFile(
      'gray.png',
      plane(2, 2, () => [9, 9, 9, 255]),
    ),
  );
  await expect(panel.getByTestId('textures-preview')).toBeVisible();
  await expect(frames).toHaveCount(0);

  // Cancelled: the Worker's frame goes, and nothing is shown.
  await panel.getByTestId('textures-generate').click();
  await expect(frames).toHaveCount(1);
  await panel.getByTestId('textures-cancel').click();
  await expect(frames).toHaveCount(0);
  await expect(panel.getByTestId('textures-notice')).toBeVisible();
  await expect(panel.getByTestId('textures-result')).toHaveCount(0);

  // Not answered in time: terminated by the host after the call limit (10 s).
  await panel.getByTestId('textures-generate').click();
  await expect(frames).toHaveCount(1);
  await expect(panel.getByTestId('textures-notice')).toHaveText(/did not answer .* in time/, {
    timeout: 20_000,
  });
  await expect(panel.getByTestId('textures-notice')).toHaveAttribute('role', 'alert');
  await expect(frames).toHaveCount(0);

  // Switched off mid-job: the panel and the Worker go; switched on again, no old result returns.
  await panel.getByTestId('textures-generate').click();
  await expect(frames).toHaveCount(1);
  await setEnabled(page, SLOW_ID, false);
  await expect(panel).toHaveCount(0);
  await expect(frames).toHaveCount(0);
  await setEnabled(page, SLOW_ID, true);
  await expect(panel.getByTestId('textures-generate')).toBeEnabled();
  await expect(panel.getByTestId('textures-result')).toHaveCount(0);
  await page.getByTestId(`plugin-remove-${SLOW_ID}`).click();
  await expect(page.getByTestId(`plugin-${SLOW_ID}`)).toHaveCount(0);
});
