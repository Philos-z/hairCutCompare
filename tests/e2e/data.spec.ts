import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { ComparisonProject } from '../../src/core/types';

type Portable = { application: string; projectVersion: number; project: Omit<ComparisonProject, 'photos'> & { photos: (Omit<ComparisonProject['photos'][number], 'original' | 'image'> & { original: { data: string; sha256: string }; image: { data: string; sha256: string } })[] } };

async function loadDemo(page: Page) {
  await page.getByRole('button', { name: '体验示意图', exact: true }).click();
  await expect(page.getByText('绘制示意图 · 非实拍')).toBeVisible();
  await expect(page.getByRole('button', { name: '导出对比图片', exact: true })).toBeEnabled();
}
async function exportProject(page: Page): Promise<{ payload: Portable; text: string }> {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '项目文件', exact: true }).click();
  const download = await event;
  expect(download.suggestedFilename()).toMatch(/\.haircompare\.json$/);
  const filename = await download.path();
  expect(filename).toBeTruthy();
  const text = await readFile(filename!, 'utf8');
  return { payload: JSON.parse(text), text };
}
async function digest(page: Page, json: string): Promise<string> {
  return page.evaluate(async json => {
    const projectPath = '/src/data/projectFile.ts', aiPath = '/src/ai/client.ts';
    const { deserializeProject } = await import(projectPath);
    const { getInputDigest } = await import(aiPath);
    return getInputDigest(await deserializeProject(new Blob([json], { type: 'application/json' })));
  }, json);
}
async function saveNamed(page: Page, kind: 'baseline' | 'project', name: string) {
  await page.getByRole('button', { name: kind === 'baseline' ? '保存喜欢基准' : '保存项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: kind === 'baseline' ? '保存喜欢的发型' : '保存对比项目', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存到此浏览器', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('named baseline reopens with a newly selected current photo retained', async ({ page }) => {
  await loadDemo(page);
  const before = await exportProject(page);
  await saveNamed(page, 'baseline', '喜欢短发 · 本地基准');
  await loadDemo(page);
  const newer = await exportProject(page);
  expect(newer.payload.project.photos[1].id).not.toBe(before.payload.project.photos[1].id);
  await page.getByRole('button', { name: '我的基准', exact: true }).click();
  const library = page.getByRole('dialog', { name: '我的基准与项目', exact: true });
  await library.getByRole('button', { name: /^喜欢短发 · 本地基准/ }).click();
  await expect(library).toBeHidden();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  const reopened = await exportProject(page);
  expect(reopened.payload.project.name).toBe('喜欢短发 · 本地基准');
  expect(reopened.payload.project.referenceId).toBe(before.payload.project.referenceId);
  expect(reopened.payload.project.photos[0].image.sha256).toBe(before.payload.project.photos[0].image.sha256);
  expect(reopened.payload.project.photos[1].id).toBe(newer.payload.project.photos[1].id);
  expect(reopened.payload.project.alignmentConfirmed).toBe(false);
  await page.getByRole('button', { name: '确认轮廓，开始对比', exact: true }).click();
  await expect(page.getByLabel('已检查双方轮廓和面部对齐，转头、仰俯和拍摄距离接近')).not.toBeChecked();
  await page.getByLabel('已检查双方轮廓和面部对齐，转头、仰俯和拍摄距离接近').check();
  await expect(page.getByText('已确认，可查看 2D 投影指标')).toBeVisible();
});

test('portable project restores original bytes, notes, layers, confirmations and evidence digest', async ({ page }) => {
  await loadDemo(page);
  const notes = '刘海参照绿色线；两侧保留一点弧度。项目恢复验证。';
  await page.getByPlaceholder('例如：两侧更贴合绿色轮廓，刘海保留到参考线…').fill(notes);
  await page.getByRole('switch', { name: /显示当前轮廓/ }).check();
  await page.locator('#opacity').fill('0.55');
  await saveNamed(page, 'project', '完整项目 · 本地备份');
  const before = await exportProject(page);
  const beforeDigest = await digest(page, before.text);
  expect(before.payload.project.referenceConfirmed).toBe(true);
  expect(before.payload.project.alignmentConfirmed).toBe(true);
  expect(before.payload.project.display.currentContour).toBe(true);
  expect(before.payload.project.display.photoOpacity).toBe(.55);
  await page.reload();
  await expect(page.getByText('导入一张喜欢的照片', { exact: true })).toBeVisible();
  await page.locator('input[type="file"][accept=".json,.haircompare.json"]').setInputFiles({
    name: '备份.haircompare.json', mimeType: 'application/json', buffer: Buffer.from(before.text),
  });
  await expect(page.getByRole('status')).toContainText('项目和原始照片已恢复');
  await expect(page.getByPlaceholder('例如：两侧更贴合绿色轮廓，刘海保留到参考线…')).toHaveValue(notes);
  await expect(page.getByRole('switch', { name: /显示当前轮廓/ })).toBeChecked();
  await expect(page.locator('#opacity')).toHaveValue('0.55');
  await expect(page.getByLabel('已检查双方轮廓和面部对齐，转头、仰俯和拍摄距离接近')).toBeChecked();
  const restored = await exportProject(page);
  expect(restored.payload.project).toEqual(before.payload.project);
  expect(await digest(page, restored.text)).toBe(beforeDigest);
  // IndexedDB records also survive a reload, independently of the portable import.
  await page.getByRole('button', { name: '我的基准', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /^完整项目 · 本地备份/ })).toBeVisible();
  await page.getByRole('button', { name: '关闭基准库', exact: true }).click();
});

test('corrupted portable files are rejected without replacing the open project', async ({ page }) => {
  await loadDemo(page);
  const before = await exportProject(page);
  const damaged = JSON.parse(before.text);
  damaged.project.photos[0].original.sha256 = '0'.repeat(64);
  await page.locator('input[type="file"][accept=".json,.haircompare.json"]').setInputFiles({
    name: '损坏.haircompare.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)),
  });
  await expect(page.getByRole('alert')).toContainText('照片校验失败');
  const after = await exportProject(page);
  expect(after.payload.project).toEqual(before.payload.project);
});

test('native image decoding handles EXIF rotation and mirroring exactly once', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const path = '/src/data/images.ts';
    const { preparePhoto, loadImage } = await import(path);
    const source = document.createElement('canvas'); source.width = 240; source.height = 160;
    const ctx = source.getContext('2d')!;
    ctx.fillStyle = '#ed301b'; ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#1bce42'; ctx.fillRect(120, 0, 120, 80);
    ctx.fillStyle = '#184fee'; ctx.fillRect(0, 80, 120, 80);
    ctx.fillStyle = '#f0c421'; ctx.fillRect(120, 80, 120, 80);
    const jpeg = await new Promise<Blob>(resolve => source.toBlob(blob => resolve(blob!), 'image/jpeg', .99));
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    const output = [];
    for (const orientation of [1, 2, 3, 6, 8]) {
      const exif = new Uint8Array([
        255, 225, 0, 34, 69, 120, 105, 102, 0, 0, // APP1 + Exif\0\0
        73, 73, 42, 0, 8, 0, 0, 0, // little-endian TIFF + IFD offset
        1, 0, 18, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const file = new Blob([bytes.slice(0, 2), exif, bytes.slice(2)], { type: 'image/jpeg' });
      const photo = await preparePhoto(file, `orientation-${orientation}.jpg`);
      const img = await loadImage(photo.image);
      const canvas = document.createElement('canvas'); canvas.width = photo.width; canvas.height = photo.height;
      const c = canvas.getContext('2d')!; c.drawImage(img, 0, 0);
      const sample = (x: number, y: number) => Array.from(c.getImageData(x, y, 1, 1).data).slice(0, 3);
      output.push({ orientation, width: photo.width, height: photo.height, topLeft: sample(20, 20), topRight: sample(photo.width - 20, 20), originalRetained: photo.original.size === file.size });
    }
    return output;
  });
  const dominant = (rgb: number[]) => rgb[0] > 150 && rgb[1] > 100 ? 'yellow' : ['red', 'green', 'blue'][rgb.indexOf(Math.max(...rgb))];
  expect(results.map(r => [r.orientation, r.width, r.height, dominant(r.topLeft), dominant(r.topRight), r.originalRetained])).toEqual([
    [1, 240, 160, 'red', 'green', true],
    [2, 240, 160, 'green', 'red', true],
    [3, 240, 160, 'yellow', 'blue', true],
    [6, 160, 240, 'blue', 'red', true],
    [8, 160, 240, 'green', 'yellow', true],
  ]);
});

test('desktop and phone views keep content within the viewport', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.toLowerCase().includes('mobile');
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  await loadDemo(page);
  const sizes = await page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }));
  expect(sizes.content).toBeLessThanOrEqual(sizes.width + 2);
  const dismiss = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.screenshot({ path: testInfo.outputPath(mobile ? 'mobile-390.png' : 'desktop-1280.png'), fullPage: true });
});
