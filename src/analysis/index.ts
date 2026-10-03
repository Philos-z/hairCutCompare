import AnalysisWorker from './mediapipe.worker?worker';
import { emptyContours } from '../core/types';
import type { AnalysisInput, AnalysisResult, FaceLandmarkProvider, HairSegmentationProvider, PhotoAsset } from '../core/types';
import { ANALYSIS_VERSION } from './protocol';
import type { AnalysisResponse } from './protocol';

let worker: Worker | undefined;
let id = 0;
let serial: Promise<unknown> = Promise.resolve();
let cache = new WeakMap<Blob, Promise<AnalysisResult>>();
let failedReason: string | undefined;
let activeCancel: (() => void) | undefined;
let generation = 0;
const fallback = (message: string): AnalysisResult => ({ anchors: [], contours: emptyContours(), provider: 'manual', version: ANALYSIS_VERSION, warnings: [message, '仍可拖动面部锚点、手工描画并确认轮廓。'] });

/** Terminate expensive inference immediately; the next request starts a fresh worker. */
export function resetAnalysis(): void {
  generation++;
  activeCancel?.(); activeCancel = undefined;
  worker?.terminate(); worker = undefined; failedReason = undefined;
  cache = new WeakMap();
}
export const shutdownAnalysis = resetAnalysis;

function requestAnalysis(input: AnalysisInput): Promise<AnalysisResult> {
  if (failedReason) return Promise.resolve(fallback(failedReason));
  if (typeof Worker === 'undefined') return Promise.resolve(fallback('此浏览器不支持 Worker 自动分析，请手工校准。'));
  return new Promise(resolve => {
    const requestId = ++id;
    let complete = false;
    const finish = (result: AnalysisResult) => {
      if (complete) return; complete = true;
      clearTimeout(timer);
      worker?.removeEventListener('message', onMessage);
      worker?.removeEventListener('error', onError);
      activeCancel = undefined;
      resolve(result);
    };
    const stop = (message: string) => {
      failedReason = message;
      finish(fallback(message)); worker?.terminate(); worker = undefined;
    };
    const onMessage = (event: MessageEvent<AnalysisResponse>) => {
      if (event.data.id !== requestId) return;
      if ('result' in event.data) finish(event.data.result);
      else stop(event.data.error);
    };
    const onError = () => stop('自动分析线程启动失败，请使用人工校准或稍后重试。');
    const timer = setTimeout(() => stop('自动分析超过 45 秒，已停止线程。请使用人工校准或重新分析。'), 45_000);
    activeCancel = () => finish(fallback('自动分析已取消。'));
    try {
      worker ??= new AnalysisWorker();
      worker.addEventListener('message', onMessage); worker.addEventListener('error', onError);
      worker.postMessage({ id: requestId, blob: input.blob, baseURL: new URL(import.meta.env.BASE_URL, location.href).href });
    } catch { stop('无法启动自动分析，请使用人工校准。'); }
  });
}

/** No runtime network upload: all model paths are same-origin bundled assets. */
export function analyzeImage(input: AnalysisInput): Promise<AnalysisResult> {
  const prior = cache.get(input.blob);
  if (prior) return prior;
  const requestedGeneration = generation;
  const pending = serial.then(() => requestedGeneration === generation ? requestAnalysis(input) : fallback('自动分析已取消。'));
  cache.set(input.blob, pending);
  serial = pending.catch(() => undefined);
  return pending;
}
export const analyzePhoto = (photo: PhotoAsset): Promise<AnalysisResult> => analyzeImage({ blob: photo.image, width: photo.width, height: photo.height });

/** Both adapters share one serial inference/cache, so their normalized coordinates,
 * model versions and candidate contours are consistent for the same oriented blob.
 * An Apple backend can implement the identical provider contracts in a native host.
 */
export class MediaPipeFaceAdapter implements FaceLandmarkProvider {
  readonly id = 'mediapipe-face-landmarker';
  async detectFace(input: AnalysisInput) { const { anchors, pose, warnings, provider, version, provenance } = await analyzeImage(input); return { anchors, pose, warnings, provider, version, provenance }; }
}
export class MediaPipeHairAdapter implements HairSegmentationProvider {
  readonly id = 'mediapipe-hair-segmenter';
  async segmentHair(input: AnalysisInput) { const { contours, warnings, provider, version, provenance } = await analyzeImage(input); return { contours, warnings, provider, version, provenance }; }
}
