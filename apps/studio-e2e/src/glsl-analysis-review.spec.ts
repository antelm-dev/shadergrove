/// <reference lib="dom" />
// The page's Angular debug API (`window.ng`) and Monaco are untyped here.
/* oxlint-disable typescript/no-explicit-any */
import type { Page } from '@playwright/test';
import { createProject, DEFAULT_VERTEX } from '@shadergrove/shared/project';
import { expect, test } from './fixtures';

test.describe.configure({ timeout: 180_000 });
const chip = (page: Page) => page.locator('.analysis-chip');

async function fixture(page: Page, name: string) {
  const fragment =
    '#include "outer.glsl"\nvoid main() { gl_FragColor = vec4(reviewWave(reviewGain)); }';
  const project = createProject(fragment, DEFAULT_VERTEX);
  project.passes.find((pass) => pass.kind === 'common')!.source = 'uniform float reviewGain;';
  project.files.push(
    { id: 'review-outer', name: 'outer.glsl', source: '#include "inner.glsl"' },
    {
      id: 'review-inner',
      name: 'inner.glsl',
      source: 'float reviewWave(float p) { return 0.25 + 0.1 * sin(p); }',
    },
  );
  const response = await page.request.post('/api/shaders', {
    data: { name, fragment, vertex: DEFAULT_VERTEX, project },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { shader: created } = (await response.json()) as { shader: { id: string } };
  await page.addInitScript(() =>
    localStorage.setItem(
      'shader-studio.preferences',
      JSON.stringify({ paused: true, editorOpen: true }),
    ),
  );
  await page.goto('/');
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.locator('app-shader-browser .shader-row', { hasText: name }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(created.id)}`);
  await expect(page.locator('.view-lines')).toContainText('reviewWave');
  await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  return created.id;
}

// Observe the real Monaco model/marker owners through Angular's existing dev
// debug API. All edits and completion requests still use the actual editor UI.
async function placeCursor(page: Page, needle: string) {
  await page.locator('.monaco-editor').first().click();
  await page.evaluate((word) => {
    const component = (window as any).ng.getComponent(document.querySelector('app-code-editor'));
    const editor = component.editor;
    const text = editor.getModel().getValue();
    if (!text.includes(word)) throw new Error(`Fixture has no ${word}: ${text}`);
    editor.setPosition(editor.getModel().getPositionAt(text.indexOf(word) + word.length));
    editor.focus();
  }, needle);
}

test('nested includes expose declared completion and navigate to the original error', async ({
  page,
}) => {
  await fixture(page, 'Review nested includes');
  await placeCursor(page, 'reviewWave');
  await page.keyboard.press('Control+Space');
  await expect(
    page.locator('.suggest-widget .monaco-list-row', { hasText: 'reviewWave' }).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+i');
  await expect(page.locator('.monaco-hover:visible')).toContainText('float reviewWave');
  await page.keyboard.press('Escape');
  // The Common uniform is also visible in the Image compilation.
  await placeCursor(page, 'reviewGain');
  await page.keyboard.press('Control+Space');
  await expect(
    page.locator('.suggest-widget .monaco-list-row', { hasText: 'reviewGain' }).first(),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  // Edit the nested file through the existing explorer, then return to Image.
  await page.getByRole('treeitem', { name: /inner.glsl/ }).click();
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(
    '// nested header\nfloat reviewWave(float p) { return missingNested; }',
  );
  await expect(chip(page)).toHaveAttribute('data-analysis', 'problems');
  await page.getByRole('tab', { name: /Image/ }).click();
  await chip(page).click();
  await expect(page.getByRole('tab', { name: /inner.glsl/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const cursor = await page.evaluate(() =>
    (window as any).ng.getComponent(document.querySelector('app-code-editor')).editor.getPosition(),
  );
  expect(cursor.lineNumber).toBe(2);
});

test('driver and analysis markers coexist and switching during a pending reply drops it', async ({
  page,
}) => {
  const id = await fixture(page, 'Review pending project');
  const acceptedMaterial = await page.evaluate(() => {
    const panel = (window as any).ng.getComponent(document.querySelector('app-editor-panel'));
    const canvas = (window as any).ng.getComponent(document.querySelector('app-shader-canvas'));
    return canvas.engine().passMaterial(panel.store.activeDoc().id).uuid;
  });
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\nvoid broken( {');
  await expect(chip(page)).toHaveAttribute('data-analysis', 'problems');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const component = (window as any).ng.getComponent(
          document.querySelector('app-code-editor'),
        );
        const uri = component.editor.getModel().uri;
        return ['shader-studio', 'shader-studio-analysis'].every(
          (owner) => component.monaco().editor.getModelMarkers({ owner, resource: uri }).length > 0,
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    (window as any).__reviewDraws = 0;
    for (const method of ['drawArrays', 'drawElements'] as const) {
      const original = WebGL2RenderingContext.prototype[method];
      (WebGL2RenderingContext.prototype as any)[method] = function (...args: any[]) {
        (window as any).__reviewDraws++;
        return (original as any).apply(this, args);
      };
    }
  });
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__reviewDraws)).toBeGreaterThan(3);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const afterInvalid = await page.evaluate(() => {
    const panel = (window as any).ng.getComponent(document.querySelector('app-editor-panel'));
    const canvas = (window as any).ng.getComponent(document.querySelector('app-shader-canvas'));
    return canvas.engine().passMaterial(panel.store.activeDoc().id).uuid;
  });
  expect(afterInvalid).toBe(acceptedMaterial);
  // Gate the real next Worker result on the host side, without fabricating it.
  await page.evaluate(() => {
    const analysis = (window as any).ng.getComponent(
      document.querySelector('app-editor-panel'),
    ).analysis;
    (window as any).__reviewGate = { held: 0, release: [] };
    void analysis.client.then((client: any) => {
      const original = client.analyze.bind(client);
      client.analyze = async (request: any) => {
        const reply = await original(request);
        (window as any).__reviewGate.held++;
        await new Promise((resolve) => (window as any).__reviewGate.release.push(resolve));
        return reply;
      };
    });
  });
  await page.keyboard.press('Control+End');
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n// pending revision');
  await expect
    .poll(() => page.evaluate(() => (window as any).__reviewGate.held))
    .toBeGreaterThan(0);
  const response = await page.request.get('/api/shaders');
  const { shaders } = (await response.json()) as { shaders: { id: string; name: string }[] };
  const other = shaders.find((shader) => shader.id !== id && shader.name === 'Hex Pulse')!;
  await page.locator('app-shader-browser .shader-row', { hasText: other.name }).click();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page).toHaveURL(`/shaders/${encodeURIComponent(other.id)}`);
  await page.evaluate(() => {
    const analysis = (window as any).ng.getComponent(
      document.querySelector('app-editor-panel'),
    ).analysis;
    void analysis.client.then((client: any) => {
      delete client.analyze;
    });
    for (const release of (window as any).__reviewGate.release) release();
  });
  await expect(chip(page)).toHaveAttribute('data-analysis', 'ready');
  const snapshot = await page.evaluate(() => {
    const analysis = (window as any).ng.getComponent(
      document.querySelector('app-editor-panel'),
    ).analysis;
    return { current: analysis.current, projectId: analysis.snapshot()?.projectId };
  });
  expect(snapshot).toEqual({ current: true, projectId: other.id });
  await expect(page.locator('.monaco-editor .squiggly-error')).toHaveCount(0);
});
