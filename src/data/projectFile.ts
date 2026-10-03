import type { ComparisonProject, PhotoAsset, Point } from '../core/types';
import { detectImageMime, MAX_IMAGE_EDGE, MAX_PHOTO_BYTES } from './images';

const MAX_PROJECT_FILE_BYTES = 85 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 60 * 1024 * 1024;
const MAX_WORKING_BYTES = 16 * 1024 * 1024;
const imageTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const workingTypes = ['image/jpeg', 'image/png', 'image/webp'];
const contours = ['outer', 'fringe', 'leftSideburn', 'rightSideburn'];
const anchorIds = ['leftEye', 'rightEye', 'nose', 'chin'];
interface PortableBlob { encoding: 'base64'; mime: string; size: number; sha256: string; data: string }
type PortablePhoto = Omit<PhotoAsset, 'original' | 'image'> & { original: PortableBlob; image: PortableBlob };
interface PortableFile {
  application: 'haircut-compare'; projectVersion: 1;
  project: Omit<ComparisonProject, 'photos'> & { photos: PortablePhoto[] };
}

function invalid(detail: string): never { throw new Error(`项目文件无效：${detail}`); }
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name}格式不正确。`);
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 240, nonempty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) invalid(`${name}不正确。`);
}
function bool(value: unknown, name: string): void { if (typeof value !== 'boolean') invalid(`${name}不正确。`); }
function number(value: unknown, name: string, min: number, max: number, integer = false): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(`${name}超出有效范围。`);
}
function validatePoint(value: unknown): void {
  const p = object(value, '坐标');
  number(p.x, '横坐标', 0, 1);
  number(p.y, '纵坐标', 0, 1);
}
function validatePhotoMetadata(value: unknown): asserts value is Omit<PhotoAsset, 'original' | 'image'> {
  const p = object(value, '照片');
  text(p.id, '照片标识', 128, true);
  text(p.name, '照片名称');
  number(p.width, '分析照片宽度', 1, MAX_IMAGE_EDGE, true);
  number(p.height, '分析照片高度', 1, MAX_IMAGE_EDGE, true);
  number(p.originalWidth, '原图宽度', 1, 32768, true);
  number(p.originalHeight, '原图高度', 1, 32768, true);
  if ((p.originalWidth as number) * (p.originalHeight as number) > 80_000_000) invalid('原图分辨率过大。');
  if ((p.width as number) > (p.originalWidth as number) || (p.height as number) > (p.originalHeight as number)) invalid('分析照片尺寸不能超过原图。');
  if (!imageTypes.includes(p.sourceMime as string)) invalid('原图格式不受支持。');
  if (!Array.isArray(p.anchors) || p.anchors.length > anchorIds.length) invalid('面部锚点不正确。');
  const ids = new Set();
  for (const value of p.anchors) {
    const anchor = object(value, '面部锚点');
    if (!anchorIds.includes(anchor.id as string) || ids.has(anchor.id)) invalid('面部锚点标识重复或不受支持。');
    ids.add(anchor.id);
    text(anchor.label, '锚点名称', 100);
    validatePoint(anchor.point);
  }
  const lines = object(p.contours, '发型轮廓');
  for (const kind of contours) {
    const points = lines[kind];
    if (!Array.isArray(points) || points.length > 10000) invalid('轮廓节点过多或格式不正确。');
    points.forEach(validatePoint);
  }
  if (p.pose !== undefined) {
    const pose = object(p.pose, '头部姿态');
    for (const axis of ['yaw', 'pitch', 'roll']) number(pose[axis], '头部角度', -180, 180);
  }
  if (p.stats !== undefined) {
    const stats = object(p.stats, '照片质量');
    for (const name of ['luminance', 'darkFraction', 'brightFraction']) number(stats[name], '光线统计', 0, 1);
    number(stats.sharpness, '清晰度统计', 0, 16);
  }
  const analysis = object(p.analysis, '分析信息');
  if (!['idle', 'automatic', 'manual', 'failed'].includes(analysis.status as string)) invalid('分析状态不正确。');
  text(analysis.provider, '算法名称', 100);
  text(analysis.version, '算法版本', 200);
  if (!Array.isArray(analysis.warnings) || analysis.warnings.length > 30) invalid('质量提示不正确。');
  analysis.warnings.forEach(w => text(w, '质量提示', 1000));
  if (analysis.provenance !== undefined) {
    const provenance = object(analysis.provenance, '算法来源元数据');
    if (provenance.contractVersion !== 1) invalid('算法契约版本不受支持。');
    if (provenance.coordinateSpace !== 'oriented-image-normalized') invalid('算法坐标系不受支持。');
    for (const key of ['inputSize', 'inferenceSize']) {
      const size = object(provenance[key], '算法图像尺寸');
      number(size.width, '算法图像宽度', 1, 32768, true);
      number(size.height, '算法图像高度', 1, 32768, true);
    }
    const confidence = object(provenance.confidence, '算法置信信息');
    if (!['detected', 'unavailable'].includes(confidence.face as string)) invalid('面部检测状态不正确。');
    if (!['candidate', 'unavailable'].includes(confidence.contours as string)) invalid('轮廓置信状态不正确。');
    if (confidence.calibrated !== false) invalid('算法置信信息尚未标定，calibrated 必须为 false。');
    if (confidence.hairMean !== undefined) number(confidence.hairMean, '头发平均置信值', 0, 1);
    if (confidence.hairThreshold !== undefined) number(confidence.hairThreshold, '头发置信阈值', 0, 1);
  }
  number(p.annotationRevision, '标注版本', 0, 1_000_000, true);
}
function validateProjectMetadata(value: unknown): asserts value is ComparisonProject {
  const p = object(value, '项目');
  if (p.schemaVersion !== 1) invalid('项目版本不受支持，请升级应用后再试。');
  text(p.id, '项目标识', 128, true);
  text(p.name, '项目名称');
  text(p.notes, '备注', 10000);
  text(p.updatedAt, '更新时间', 100, true);
  if (!Number.isFinite(Date.parse(p.updatedAt))) invalid('更新时间不正确。');
  if (!['front', 'left', 'right'].includes(p.view as string)) invalid('照片视角不正确。');
  bool(p.referenceConfirmed, '轮廓确认状态');
  bool(p.alignmentConfirmed, '对齐确认状态');
  if (!Array.isArray(p.photos) || p.photos.length > 2) invalid('每个对比项目最多包含两张照片。');
  const ids = new Set<string>();
  for (const photo of p.photos) {
    validatePhotoMetadata(photo);
    if (ids.has(photo.id)) invalid('照片标识重复。');
    ids.add(photo.id);
  }
  if (p.referenceId !== null && (typeof p.referenceId !== 'string' || !ids.has(p.referenceId))) invalid('喜欢照片的标识不存在。');
  if (p.referenceId === null && (p.referenceConfirmed || p.alignmentConfirmed)) invalid('请先指定喜欢的照片。');
  if (p.alignmentConfirmed && p.photos.length !== 2) invalid('对齐结果需要两张照片。');
  const display = object(p.display, '显示设置');
  for (const name of ['currentContour', 'referencePhoto', 'original']) bool(display[name], '图层显示状态');
  number(display.photoOpacity, '照片透明度', 0, 1);
  number(display.zoom, '缩放倍数', .25, 8);
  const visible = object(display.visibleContours, '轮廓显示设置');
  for (const kind of contours) bool(visible[kind], '轮廓显示状态');
}

/** Validate the in-memory shape before committing it to IndexedDB or a portable file. */
export function validateProject(value: unknown): asserts value is ComparisonProject {
  validateProjectMetadata(value);
  let total = 0;
  for (const photo of value.photos) {
    if (!(photo.original instanceof Blob) || !(photo.image instanceof Blob)) invalid('照片数据缺失。');
    if (!photo.original.size || photo.original.size > MAX_PHOTO_BYTES) invalid('原图为空或超过 25 MB。');
    if (!photo.image.size || photo.image.size > MAX_WORKING_BYTES) invalid('分析图为空或超过 16 MB。');
    if (!imageTypes.includes(photo.original.type) || !workingTypes.includes(photo.image.type)) invalid('照片数据格式不受支持。');
    if (photo.sourceMime !== photo.original.type) invalid('原图格式与元数据不一致。');
    total += photo.original.size + photo.image.size;
  }
  if (total > MAX_TOTAL_MEDIA_BYTES) invalid('照片合计超过 60 MB，请缩小原图。');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('项目文件需要安全浏览器环境，请通过 localhost 或 HTTPS 打开。');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
async function packBlob(blob: Blob): Promise<PortableBlob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const detected = await detectImageMime(blob);
  if (detected !== blob.type) invalid('照片格式与内容不一致。');
  return { encoding: 'base64', mime: blob.type, size: blob.size, sha256: await sha256(bytes), data: base64(bytes) };
}

export async function serializeProject(project: ComparisonProject): Promise<Blob> {
  validateProject(project);
  const photos: PortablePhoto[] = [];
  // Serial encoding keeps peak memory lower on iPhone than processing all original Blobs together.
  for (const photo of project.photos) {
    const original = await packBlob(photo.original), image = await packBlob(photo.image);
    photos.push({ ...photo, original, image });
  }
  const portable: PortableFile = { application: 'haircut-compare', projectVersion: 1, project: { ...project, photos } };
  const file = new Blob([JSON.stringify(portable)], { type: 'application/json' });
  if (file.size > MAX_PROJECT_FILE_BYTES) invalid('导出文件过大，请缩小原图。');
  return file;
}

function validatePortableBlob(value: unknown, original: boolean): PortableBlob {
  const blob = object(value, '照片数据');
  if (blob.encoding !== 'base64') invalid('照片编码不受支持。');
  if (!(original ? imageTypes : workingTypes).includes(blob.mime as string)) invalid('照片格式不受支持。');
  number(blob.size, '照片数据大小', 1, original ? MAX_PHOTO_BYTES : MAX_WORKING_BYTES, true);
  if (typeof blob.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(blob.sha256)) invalid('照片校验信息缺失。');
  if (typeof blob.data !== 'string' || blob.data.length !== 4 * Math.ceil((blob.size as number) / 3) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(blob.data)) invalid('照片编码损坏。');
  return blob as unknown as PortableBlob;
}
async function unpackBlob(value: PortableBlob): Promise<Blob> {
  let binary: string;
  try { binary = atob(value.data); } catch { invalid('照片编码损坏。'); }
  if (binary!.length !== value.size) invalid('照片大小校验失败。');
  const bytes = Uint8Array.from(binary!, c => c.charCodeAt(0));
  if (await sha256(bytes) !== value.sha256) invalid('照片校验失败，文件可能已损坏。');
  const blob = new Blob([bytes], { type: value.mime });
  if (await detectImageMime(blob) !== value.mime) invalid('照片内容与格式不一致。');
  return blob;
}

export async function deserializeProject(file: Blob): Promise<ComparisonProject> {
  if (!file.size) invalid('文件为空。');
  if (file.size > MAX_PROJECT_FILE_BYTES) invalid('文件超过 85 MB，请使用较小的项目文件。');
  let input: unknown;
  try { input = JSON.parse(await file.text()); } catch { invalid('无法解析 JSON，文件可能已损坏。'); }
  const portable = object(input, '文件');
  if (portable.application !== 'haircut-compare' || portable.projectVersion !== 1) invalid('不是本应用的 v1 项目文件。');
  validateProjectMetadata(portable.project);
  const project = portable.project;
  let total = 0;
  const validated = project.photos.map(photo => {
    const p = photo as unknown as PortablePhoto;
    const original = validatePortableBlob(p.original, true), image = validatePortableBlob(p.image, false);
    if (original.mime !== p.sourceMime) invalid('原图格式与元数据不一致。');
    total += original.size + image.size;
    return { photo: p, original, image };
  });
  if (total > MAX_TOTAL_MEDIA_BYTES) invalid('照片合计超过 60 MB。');
  const photos: PhotoAsset[] = [];
  for (const item of validated) {
    photos.push({ ...item.photo, original: await unpackBlob(item.original), image: await unpackBlob(item.image) });
  }
  const restored = { ...project, photos };
  validateProject(restored);
  return restored;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 240) || '发型对比';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari may begin the download asynchronously. Keep the URL alive briefly, then always release it.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export type { Point };
