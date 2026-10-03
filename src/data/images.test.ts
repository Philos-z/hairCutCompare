import { describe, expect, it } from 'vitest';
import { detectImageMime, MAX_PHOTO_BYTES, preparePhoto } from './images';

describe('raster input validation', () => {
  it('identifies supported formats by their bytes even with missing browser MIME', async () => {
    expect(await detectImageMime(new Blob([new Uint8Array([255, 216, 255, 224])]))).toBe('image/jpeg');
    expect(await detectImageMime(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]))).toBe('image/png');
    expect(await detectImageMime(new Blob(['RIFF0000WEBP']))).toBe('image/webp');
    expect(await detectImageMime(new Blob(['0000ftypheic0000mif1']))).toBe('image/heic');
  });

  it('rejects SVG and mislabeled MIME; gives a useful HEIC-specific error', async () => {
    await expect(detectImageMime(new Blob(['<svg />'], { type: 'image/png' }))).rejects.toThrow('仅支持');
    await expect(detectImageMime(new Blob(['broken']), 'portrait.heic')).rejects.toThrow('请转为 JPEG / PNG');
  });

  it('rejects empty or oversized inputs before attempting a browser decode', async () => {
    await expect(preparePhoto(new Blob([]), 'empty.jpg')).rejects.toThrow('文件为空');
    await expect(preparePhoto(new Blob([new Uint8Array(MAX_PHOTO_BYTES + 1)]), 'large.jpg')).rejects.toThrow('25 MB');
  });
});
