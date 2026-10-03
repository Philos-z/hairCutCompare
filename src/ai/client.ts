import type { AIAdvice, ComparisonProject, PhotoAsset, QualityResult, RegionMetric } from '../core/types';

export interface AIServiceOptions { baseUrl: string; token?: string; signal?: AbortSignal }
export class AIServiceError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = 'AIServiceError'; }
}
export interface HeadCrop { x: number; y: number; width: number; height: number }
const TIMEOUT_MS = 45_000;
const MAX_IMAGE_EDGE = 1280;

function selectedPhotos(project: ComparisonProject): [PhotoAsset, PhotoAsset] {
  const reference = project.photos.find(photo => photo.id === project.referenceId);
  const current = project.photos.filter(photo => photo.id !== project.referenceId);
  if (!reference || current.length !== 1) throw new AIServiceError('请先导入两张照片，并标记一张为“喜欢”。', 'missing_pair');
  return [reference, current[0]];
}

async function sha256(value: BufferSource): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new AIServiceError('请通过 HTTPS 或 localhost 打开页面，以校验 AI 输入版本。', 'insecure_context');
  const digest = await crypto.subtle.digest('SHA-256', value);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable evidence fingerprint; names, timestamps, and customer data are excluded. */
export async function getInputDigest(project: ComparisonProject): Promise<string> {
  const pair = selectedPhotos(project);
  const photos = await Promise.all(pair.map(async photo => ({
    id: photo.id, width: photo.width, height: photo.height,
    imageHash: await sha256(await photo.image.arrayBuffer()),
    anchors: photo.anchors, contours: photo.contours, pose: photo.pose ?? null, stats: photo.stats ?? null,
    analysis: photo.analysis, annotationRevision: photo.annotationRevision,
  })));
  return sha256(new TextEncoder().encode(JSON.stringify({
    schemaVersion: project.schemaVersion, referenceId: project.referenceId, view: project.view, photos,
    referenceConfirmed: project.referenceConfirmed, alignmentConfirmed: project.alignmentConfirmed,
    notes: project.notes, display: project.display,
  })));
}

/** Use confirmed geometry to crop the selected head, retaining all hair annotations. */
export function getHeadCrop(photo: PhotoAsset): HeadCrop {
  const points = [...photo.anchors.map(anchor => anchor.point), ...Object.values(photo.contours).flat()]
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
  if (points.length < 2) throw new AIServiceError('请先标记面部锚点或发型轮廓，再请求 AI；这样只需发送头部区域。', 'missing_head_geometry');
  const leftEye = photo.anchors.find(anchor => anchor.id === 'leftEye')?.point;
  const rightEye = photo.anchors.find(anchor => anchor.id === 'rightEye')?.point;
  const xs = points.map(point => point.x * photo.width), ys = points.map(point => point.y * photo.height);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (leftEye && rightEye) {
    const span = Math.hypot((rightEye.x - leftEye.x) * photo.width, (rightEye.y - leftEye.y) * photo.height);
    const eyeY = (leftEye.y + rightEye.y) * photo.height / 2;
    if (span > 1) {
      minX = Math.min(minX, leftEye.x * photo.width - span * 0.9, rightEye.x * photo.width - span * 0.9);
      maxX = Math.max(maxX, leftEye.x * photo.width + span * 0.9, rightEye.x * photo.width + span * 0.9);
      minY = Math.min(minY, eyeY - span * 2.1);
      maxY = Math.max(maxY, eyeY + span * 1.6);
    }
  }
  const padding = Math.max(maxX - minX, maxY - minY) * 0.1;
  const x = Math.max(0, Math.floor(minX - padding)), y = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(photo.width, Math.ceil(maxX + padding)), bottom = Math.min(photo.height, Math.ceil(maxY + padding));
  if (right - x < 2 || bottom - y < 2) throw new AIServiceError('头部标记范围太小，请修正面部锚点或轮廓。', 'invalid_head_geometry');
  return { x, y, width: right - x, height: bottom - y };
}

async function headImage(photo: PhotoAsset): Promise<{ dataUrl: string; crop: HeadCrop }> {
  const crop = getHeadCrop(photo);
  const url = URL.createObjectURL(photo.image);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const factor = Math.min(1, MAX_IMAGE_EDGE / Math.max(crop.width, crop.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.width * factor));
    canvas.height = Math.max(1, Math.round(crop.height * factor));
    const context = canvas.getContext('2d');
    if (!context) throw new AIServiceError('浏览器无法准备 AI 图片，本地对比仍可使用。', 'image_preparation_failed');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    if (dataUrl.length > 2_796_240) throw new AIServiceError('AI 图片太大，请改用较小照片。', 'image_too_large');
    return { dataUrl, crop };
  } finally { URL.revokeObjectURL(url); }
}

function checkedServiceUrl(baseUrl: string): string {
  try {
    const value = baseUrl.trim();
    if (!value) throw new Error();
    const url = value.startsWith('/') && !value.startsWith('//')
      ? new URL(value, globalThis.location?.origin)
      : new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    // Keep deployments and same-origin development proxies under their prefix.
    // A leading slash on the endpoint would discard /ai-proxy or /research/api.
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return new URL('v1/comparison-assistance', url).href;
  } catch { throw new AIServiceError('请填写有效的 AI 服务 HTTP 或 HTTPS 地址。', 'invalid_service_url'); }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1200;

export function validateAdvice(value: unknown, digest: string, metricIds: string[]): AIAdvice {
  if (!isRecord(value) || value.inputDigest !== digest || !isText(value.summary) || !isText(value.model)
    || !Array.isArray(value.limitations) || value.limitations.length > 14 || !value.limitations.every(isText)
    || !Array.isArray(value.qualityIssues) || value.qualityIssues.length > 12
    || !Array.isArray(value.regionNotes) || value.regionNotes.length > 8) {
    throw new AIServiceError('AI 回答格式或输入版本不匹配，本地结果保持不变。', 'invalid_response');
  }
  if (Object.keys(value).some(key => !['summary', 'qualityIssues', 'regionNotes', 'limitations', 'model', 'inputDigest'].includes(key))) {
    throw new AIServiceError('AI 回答包含不支持的字段，本地结果保持不变。', 'invalid_response');
  }
  for (const issue of value.qualityIssues) {
    if (!isRecord(issue) || !isText(issue.code) || !['info', 'warning'].includes(String(issue.severity)) || !isText(issue.message) || !isText(issue.suggestion)) {
      throw new AIServiceError('AI 质量建议无效，本地结果保持不变。', 'invalid_response');
    }
  }
  for (const note of value.regionNotes) {
    if (!isRecord(note) || !isText(note.text) || (note.metricId !== null && (typeof note.metricId !== 'string' || !metricIds.includes(note.metricId)))) {
      throw new AIServiceError('AI 引用了不存在的区域指标，本地结果保持不变。', 'invalid_response');
    }
  }
  return value as unknown as AIAdvice;
}

/** Called only after the user's opt-in. Geometry and local quality are immutable. */
export async function requestAdvice(project: ComparisonProject, quality: QualityResult, metrics: RegionMetric[], options: AIServiceOptions): Promise<AIAdvice> {
  const [reference, current] = selectedPhotos(project);
  const endpoint = checkedServiceUrl(options.baseUrl);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const [inputDigest, referenceHead, currentHead] = await Promise.all([getInputDigest(project), headImage(reference), headImage(current)]);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const metadata = (photo: PhotoAsset, crop: HeadCrop) => ({
      width: photo.width, height: photo.height, pose: photo.pose ?? null, stats: photo.stats ?? null,
      provider: photo.analysis.provider, version: photo.analysis.version, crop,
    });
    // No project/customer names, original EXIF, notes, or unrelated photos leave
    // the browser. JPEG canvas output strips metadata and uses oriented pixels.
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.token?.trim() ? { Authorization: `Bearer ${options.token.trim()}` } : {}) },
      body: JSON.stringify({
        schemaVersion: 1, inputDigest, view: project.view,
        referenceImage: referenceHead.dataUrl, currentImage: currentHead.dataUrl,
        quality, metrics: quality.status === 'comparable' ? metrics : [],
        captureInfo: { reference: metadata(reference, referenceHead.crop), current: metadata(current, currentHead.crop) },
      }), signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AIServiceError('AI 服务未返回有效 JSON，本地对比仍可使用。', 'invalid_response'); }
    if (!response.ok) {
      const detail = isRecord(payload) && isRecord(payload.detail) ? payload.detail : null;
      throw new AIServiceError(detail && isText(detail.message) ? detail.message : 'AI 服务暂时不可用，本地结果已经保留。', detail && isText(detail.code) ? detail.code : `http_${response.status}`);
    }
    const advice = validateAdvice(payload, inputDigest, quality.status === 'comparable' ? metrics.map(metric => metric.kind) : []);
    // Async image preparation and requests cannot overwrite edits made in flight.
    if (await getInputDigest(project) !== inputDigest) throw new AIServiceError('照片或标记已变化，请重新请求 AI 建议。', 'stale_input');
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return advice;
  } catch (error) {
    if (controller.signal.aborted) throw new AIServiceError(timedOut ? 'AI 请求超时，本地对比仍可使用。' : 'AI 请求已取消。', timedOut ? 'timeout' : 'cancelled');
    if (error instanceof AIServiceError) throw error;
    throw new AIServiceError('无法连接 AI 服务，请检查地址和网络。本地对比仍可使用。', 'connection_failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
