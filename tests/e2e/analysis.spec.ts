import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const portrait = fileURLToPath(new URL('../fixtures/white-house-portrait.jpg', import.meta.url));
const firstCard = (page: Page) => page.locator('.photo-card').first();
const waitForCandidates = async (page: Page) => {
  await expect(firstCard(page).locator('.analysis-state')).toContainText('已生成候选标注', { timeout: 45_000 });
};

test('real portrait creates local face anchors, editable open silhouette, and export provenance', async ({ page, context }, testInfo) => {
  test.setTimeout(70_000);
  const remoteRequests: string[] = [];
  const base = new URL(String(testInfo.project.use.baseURL ?? 'http://localhost:5173'));
  context.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== base.origin) remoteRequests.push(url.href); });
  await page.goto('/');
  await page.getByLabel('导入照片1').setInputFiles(portrait);
  await waitForCandidates(page);
  await expect(firstCard(page).locator('.analysis-warning')).toContainText('人工核对');
  await firstCard(page).getByRole('button', { name: '锚点', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('svg text')).toHaveCount(4);
  await expect(dialog.locator('.editor-photo').getByText('画面左眼', { exact: true })).toBeVisible();
  await expect(dialog.locator('.editor-photo').getByText('画面右眼', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await firstCard(page).getByRole('button', { name: '轮廓', exact: true }).click();
  const outer = page.getByRole('dialog').locator('svg > g > path').first();
  await expect(outer).toHaveAttribute('d', /L/);
  expect(await outer.getAttribute('d')).not.toMatch(/[Zz]/);
  await expect(page.getByRole('dialog').locator('svg circle')).not.toHaveCount(0);
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  const download = await downloadPromise;
  const outputPath = await download.path();
  expect(outputPath).not.toBeNull();
  const portable = JSON.parse(await readFile(outputPath!, 'utf8'));
  const photo = portable.project.photos[0];
  expect(photo.analysis.provider).toBe('mediapipe-cpu-worker');
  expect(photo.analysis.version).toContain('tasks-vision@0.10.32');
  expect(photo.analysis.provenance).toMatchObject({
    contractVersion: 1, coordinateSpace: 'oriented-image-normalized',
    inputSize: { width: photo.width, height: photo.height },
    confidence: { face: 'detected', contours: 'candidate', calibrated: false, hairThreshold: 0.55 },
  });
  expect(photo.analysis.provenance.confidence.hairMean).toBeGreaterThanOrEqual(0);
  expect(photo.analysis.provenance.confidence.hairMean).toBeLessThanOrEqual(1);
  expect(photo.analysis.provenance.inferenceSize.width).toBeLessThanOrEqual(1280);
  expect(photo.analysis.provenance.inferenceSize.height).toBeLessThanOrEqual(1280);
  expect(photo.anchors.map((a: { id: string }) => a.id)).toEqual(['leftEye', 'rightEye', 'nose', 'chin']);
  expect(photo.anchors[0].point.x).toBeLessThan(photo.anchors[1].point.x);
  expect(photo.contours.outer.length).toBeGreaterThan(3);
  expect(photo.contours.fringe.length).toBeGreaterThan(1);
  expect(photo.contours.leftSideburn).toHaveLength(0);
  expect(photo.contours.rightSideburn).toHaveLength(0);
  expect(Object.values(photo.pose).every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true);
  expect(photo.analysis.warnings.some((warning: string) => warning.includes('人工核对'))).toBe(true);
  // The true open silhouette may reach unequal side endpoints; no artificial
  // straight closing segment is persisted or added by the editor.
  expect(photo.contours.outer[0]).not.toEqual(photo.contours.outer.at(-1));
  expect(remoteRequests).toEqual([]);
});

test('missing models preserves manual calibration and a working explicit retry', async ({ page }) => {
  test.setTimeout(70_000);
  await page.route('**/models/**', route => route.fulfill({ status: 404, body: 'deliberately unavailable model in fallback test' }));
  await page.goto('/');
  await page.getByLabel('导入照片1').setInputFiles(portrait);
  await expect(firstCard(page).locator('.analysis-state')).toContainText('自动分析不可用，可手工编辑', { timeout: 45_000 });
  await firstCard(page).getByRole('button', { name: '锚点', exact: true }).click();
  await page.getByRole('button', { name: '添加四个位置示意锚点', exact: true }).click();
  await expect(page.getByRole('dialog').locator('svg text')).toHaveCount(4);
  // Do not commit the illustrative positions; availability of manual editing is
  // distinct from accepting them as real face landmarks.
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await page.unroute('**/models/**');
  await firstCard(page).getByRole('button', { name: '重试自动分析', exact: true }).click();
  await waitForCandidates(page);
  await firstCard(page).getByRole('button', { name: '锚点', exact: true }).click();
  await expect(page.getByRole('dialog').locator('svg text')).toHaveCount(4);
  await expect(page.getByRole('dialog').locator('.editor-photo').getByText('画面左眼', { exact: true })).toBeVisible();
});

test('reset discards queued requests before any inference Worker starts', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const modulePath = '/src/analysis/index.ts';
    const mod = await import(/* @vite-ignore */ modulePath) as typeof import('../../src/analysis');
    const native = window.Worker;
    let starts = 0;
    window.Worker = class extends native { constructor(url: string | URL, options?: WorkerOptions) { starts++; super(url, options); } };
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 100;
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    const first = mod.analyzeImage({ blob, width: 80, height: 100 });
    const second = mod.analyzeImage({ blob: blob.slice(0, blob.size, blob.type), width: 80, height: 100 });
    mod.resetAnalysis();
    const outputs = await Promise.all([first, second]); window.Worker = native;
    return { starts, warnings: outputs.map(output => output.warnings), providers: outputs.map(output => output.provider) };
  });
  expect(result.starts).toBe(0);
  expect(result.providers).toEqual(['manual', 'manual']);
  expect(result.warnings.every(warnings => warnings.includes('自动分析已取消。'))).toBe(true);
});
