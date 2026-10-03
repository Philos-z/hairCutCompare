import { FaceLandmarker, FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { anchorsFromLandmarks, contoursFromMask, poseFromMatrix } from './geometry';
import { meanHairConfidence } from './confidence';
import { emptyContours } from '../core/types';
import type { AnalysisResult, ImageStats } from '../core/types';
import { ANALYSIS_VERSION } from './protocol';
import type { AnalysisRequest, AnalysisResponse } from './protocol';

const worker = self as unknown as DedicatedWorkerGlobalScope;
// Vite dev always uses module Workers. Emscripten's classic loader relies on
// sloppy-mode function semantics and resets ModuleFactory between tasks, so a
// cached ES-module import cannot load it. Production's IIFE Worker instead uses
// native importScripts; this compatibility bridge runs only in Vite dev.
(worker as unknown as { import: (url: string) => Promise<unknown> }).import = async (url: string) => {
  const local = new URL(url, worker.location.href);
  if (local.origin !== worker.location.origin || !local.pathname.includes('/vendor/mediapipe/')) throw new Error('拒绝加载非本地模型运行时');
  const response = await fetch(local.href);
  if (!response.ok) throw new Error(`本地模型运行时加载失败：${response.status}`);
  const factory = new Function(`${await response.text()}\n;return ModuleFactory;`)();
  (worker as unknown as { ModuleFactory: unknown }).ModuleFactory = factory;
};
let face: FaceLandmarker | undefined, hair: ImageSegmenter | undefined;
let assets: ReturnType<typeof FilesetResolver.forVisionTasks> | undefined;
let capabilitiesChecked = false;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function imageStats(canvas: OffscreenCanvas): ImageStats {
  // Match the preprocessing provider's aspect-preserving 256px statistics.
  const ratio = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  const width = Math.max(3, Math.round(canvas.width * ratio)), height = Math.max(3, Math.round(canvas.height * ratio));
  const sample = new OffscreenCanvas(width, height);
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法读取图片像素');
  ctx.drawImage(canvas, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height).data, luma = new Float32Array(width * height);
  let luminance = 0, dark = 0, bright = 0;
  for (let i = 0; i < luma.length; i++) {
    const value = (0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]) / 255;
    luma[i] = value; luminance += value; if (value < 0.06) dark++; if (value > 0.97) bright++;
  }
  let lapSum = 0, lapSq = 0, count = 0;
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, lap = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * luma[i];
    lapSum += lap; lapSq += lap * lap; count++;
  }
  return { luminance: luminance / luma.length, darkFraction: dark / luma.length, brightFraction: bright / luma.length, sharpness: Math.max(0, lapSq / count - (lapSum / count) ** 2) };
}

async function analyze(request: AnalysisRequest): Promise<AnalysisResult> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') throw new Error('此浏览器缺少独立线程图片分析支持，请手工校准并描线。');
  if (!capabilitiesChecked) {
    const probe = new OffscreenCanvas(1, 1), gl = probe.getContext('webgl2');
    if (!gl) throw new Error('此浏览器的 Worker WebGL2 不可用，请手工校准并描线。');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    capabilitiesChecked = true;
  }
  const bitmap = await createImageBitmap(request.blob);
  const inputSize = { width: bitmap.width, height: bitmap.height };
  const maxSize = 1280, scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) { bitmap.close(); throw new Error('图片画布不可用，请手工校准并描线。'); }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  const provenance: NonNullable<AnalysisResult['provenance']> = {
    contractVersion: 1, coordinateSpace: 'oriented-image-normalized', inputSize,
    inferenceSize: { width: canvas.width, height: canvas.height },
    confidence: { face: 'unavailable', contours: 'unavailable', calibrated: false },
  };
  const result: AnalysisResult = { anchors: [], contours: emptyContours(), provider: 'mediapipe-cpu-worker', version: ANALYSIS_VERSION, warnings: [], stats: imageStats(canvas), provenance };
  const base = new URL(request.baseURL);
  if (base.origin !== worker.location.origin) throw new Error('本地分析只允许加载同源模型资源。');
  assets ??= FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/', base).href);
  const fileset = await assets;
  try {
    face ??= await FaceLandmarker.createFromOptions(fileset, {
      canvas: new OffscreenCanvas(1, 1), baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href, delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 2, outputFacialTransformationMatrixes: true,
    });
    const detected = face.detect(canvas);
    if (detected.faceLandmarks.length === 1) {
      result.anchors = anchorsFromLandmarks(detected.faceLandmarks[0]);
      provenance.confidence.face = result.anchors.length ? 'detected' : 'unavailable';
      if (!result.anchors.length) result.warnings.push('部分稳定面部锚点位于画面外，请补拍完整面部或人工标记可见锚点。');
      result.pose = poseFromMatrix(detected.facialTransformationMatrixes[0]?.data);
      if (!result.pose) result.warnings.push('未得到稳定的头部姿态估计，请人工检查转头和仰俯。');
    } else result.warnings.push(detected.faceLandmarks.length > 1 ? '发现多张脸，请裁切到单人后重新分析。' : '未找到可靠面部锚点，请人工标记双眼、鼻尖和下巴。');
  } catch { result.warnings.push('面部自动识别暂不可用，请人工标记锚点或稍后重试。'); }
  try {
    hair ??= await ImageSegmenter.createFromOptions(fileset, {
      canvas: new OffscreenCanvas(1, 1), baseOptions: { modelAssetPath: new URL('models/hair_segmenter.tflite', base).href, delegate: 'CPU' },
      runningMode: 'IMAGE', outputCategoryMask: true, outputConfidenceMasks: true,
    });
    hair.segment(canvas, segmented => {
      const category = segmented.categoryMask;
      if (!category) { result.warnings.push('未得到头发遮罩，请手工描线。'); return; }
      const values = category.getAsUint8Array(), rawConfidence = segmented.confidenceMasks?.[1]?.getAsFloat32Array();
      const confidence = rawConfidence?.length === values.length ? rawConfidence : undefined;
      provenance.confidence.hairMean = meanHairConfidence(values, confidence);
      provenance.confidence.hairThreshold = confidence ? 0.55 : undefined;
      // Category 1 is hair in the pinned official HairSegmenter model. Confidence
      // is optional; apply it only when supplied, without inventing a certainty score.
      const mask = new Uint8Array(values.length);
      for (let i = 0; i < values.length; i++) mask[i] = values[i] === 1 && (!confidence || (Number.isFinite(confidence[i]) && confidence[i] >= 0.55 && confidence[i] <= 1)) ? 1 : 0;
      if (!confidence) result.warnings.push('未得到完整头发置信图，候选轮廓需要人工核对。');
      const extracted = contoursFromMask(mask, category.width, category.height, result.anchors);
      result.contours = extracted.contours; result.warnings.push(...extracted.warnings);
      provenance.confidence.contours = Object.values(result.contours).some(points => points.length >= 2) ? 'candidate' : 'unavailable';
    });
  } catch { result.warnings.push('头发自动识别暂不可用，请手工描线或稍后重试。'); }
  return result;
}

// Promise chain makes even direct worker callers serial. Detection itself is synchronous
// inside this thread; the main thread timeout can terminate a wedged runtime.
let serial = Promise.resolve();
worker.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  serial = serial.then(async () => {
    let response: AnalysisResponse;
    try { response = { id: request.id, result: await analyze(request) }; }
    catch (error) { response = { id: request.id, error: errorMessage(error) }; }
    worker.postMessage(response);
  });
};
