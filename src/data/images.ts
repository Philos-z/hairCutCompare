import { emptyContours, type ImageStats, type PhotoAsset } from '../core/types';
import { createId } from '../core/id';

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 2048;
const MAX_DECODED_PIXELS = 80_000_000;
const acceptedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/** Native image decoding applies EXIF rotation and mirroring once, before canvas processing. */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const finish = () => {
      URL.revokeObjectURL(url);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        finish();
        reject(new Error('照片尺寸无效，请换一张照片。'));
        return;
      }
      finish();
      resolve(img);
    };
    img.onerror = () => {
      finish();
      reject(new Error(/hei[cf]/i.test(blob.type)
        ? '当前浏览器无法解码 HEIC / HEIF，请从相册导出为 JPEG 或 PNG 后重试。'
        : '无法读取照片，请确认文件完整，并使用 JPEG、PNG 或 WebP。'));
    };
    img.src = url;
  });
}

/** Restrict imports to raster formats; SVG and HTML are deliberately unsupported. */
export async function detectImageMime(blob: Blob, name = ''): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brands = ascii(8, 64);
    if (/heic|heix|hevc|hevx|heim|heis/.test(brands)) return 'image/heic';
    if (/mif1|msf1/.test(brands)) return 'image/heif';
  }
  if (/\.hei[cf]$/i.test(name) || /image\/hei[cf]/i.test(blob.type)) {
    throw new Error('HEIC / HEIF 文件不完整或格式不受支持，请转为 JPEG / PNG。');
  }
  throw new Error('仅支持 JPEG、PNG、WebP，以及浏览器可解码的 HEIC / HEIF 照片。');
}

export function canvasBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片处理失败，请重试或使用较小的图片。')), type, quality);
  });
}

/** Stats use the uncorrected oriented image, so later exposure adjustments cannot conceal quality problems. */
export function measureImageStats(source: CanvasImageSource, width: number, height: number): ImageStats {
  const ratio = Math.min(1, 256 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(3, Math.round(width * ratio));
  canvas.height = Math.max(3, Math.round(height * ratio));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器无法创建照片分析画布，请尝试更新浏览器。');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(canvas.width * canvas.height);
  let sum = 0, dark = 0, bright = 0;
  for (let i = 0; i < gray.length; i++) {
    const p = i * 4;
    const value = (data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722) / 255;
    gray[i] = value;
    sum += value;
    if (value < .06) dark++;
    if (value > .97) bright++;
  }
  let lapSum = 0, lapSquare = 0, count = 0;
  for (let y = 1; y < canvas.height - 1; y++) {
    for (let x = 1; x < canvas.width - 1; x++) {
      const i = y * canvas.width + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - canvas.width] + gray[i + canvas.width] - 4 * gray[i];
      lapSum += lap;
      lapSquare += lap * lap;
      count++;
    }
  }
  return { luminance: sum / gray.length, darkFraction: dark / gray.length, brightFraction: bright / gray.length, sharpness: Math.max(0, lapSquare / count - (lapSum / count) ** 2) };
}

export async function preparePhoto(file: Blob, name: string): Promise<PhotoAsset> {
  if (!file.size) throw new Error('照片文件为空，请重新选择。');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('单张照片不能超过 25 MB，请先导出较小的照片。');
  const sourceMime = await detectImageMime(file, name);
  if (!acceptedTypes.has(sourceMime)) throw new Error('此照片格式不受支持。');
  const original = file.type === sourceMime ? file : file.slice(0, file.size, sourceMime);
  const decoded = await loadImage(original);
  const originalWidth = decoded.naturalWidth, originalHeight = decoded.naturalHeight;
  if (originalWidth * originalHeight > MAX_DECODED_PIXELS || Math.max(originalWidth, originalHeight) > 32768) {
    throw new Error('照片分辨率过大，请使用 8000 万像素以下的照片。');
  }
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * scale)), height = Math.max(1, Math.round(originalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法创建照片画布，请尝试更新浏览器。');
  // drawImage uses the native decoder's oriented pixels. Do not apply EXIF transforms again.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(decoded, 0, 0, width, height);
  const image = await canvasBlob(canvas, sourceMime === 'image/png' ? 'image/png' : 'image/jpeg', .94);
  const stats = measureImageStats(canvas, width, height);
  return {
    id: createId(), name: name.slice(0, 240) || '未命名照片', original, image, width, height,
    originalWidth, originalHeight, sourceMime, anchors: [], contours: emptyContours(), stats,
    analysis: { status: 'idle', provider: 'none', version: '1', warnings: [] }, annotationRevision: 0,
  };
}
