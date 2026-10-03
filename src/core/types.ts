import { createId } from './id';

/** All persisted points use the oriented original image's normalized coordinates.
 * Original pixels = normalized point × originalWidth/originalHeight;
 * working pixels = normalized point × width/height. EXIF is applied once on import.
 */
export interface Point { x: number; y: number }
export type AnchorId = 'leftEye' | 'rightEye' | 'nose' | 'chin';
export interface FaceAnchor { id: AnchorId; label: string; point: Point }
export type ContourKind = 'outer' | 'fringe' | 'leftSideburn' | 'rightSideburn';
export type HairContours = Record<ContourKind, Point[]>;
export type PhotoView = 'front' | 'left' | 'right';
export interface Pose { yaw: number; pitch: number; roll: number }
export interface ImageStats { luminance: number; darkFraction: number; brightFraction: number; sharpness: number }
export interface AnalysisProvenance {
  contractVersion: 1;
  coordinateSpace: 'oriented-image-normalized';
  inputSize: { width: number; height: number };
  inferenceSize: { width: number; height: number };
  confidence: { face: 'detected' | 'unavailable'; hairMean?: number; hairThreshold?: number; contours: 'candidate' | 'unavailable'; calibrated: false };
}
export interface AnalysisResult {
  anchors: FaceAnchor[];
  contours: HairContours;
  pose?: Pose;
  stats?: ImageStats;
  provider: string;
  version: string;
  warnings: string[];
  provenance?: AnalysisProvenance;
}
export interface PhotoAsset {
  id: string; name: string; original: Blob; image: Blob; width: number; height: number;
  originalWidth: number; originalHeight: number; sourceMime: string;
  anchors: FaceAnchor[]; contours: HairContours; pose?: Pose; stats?: ImageStats;
  analysis: { status: 'idle' | 'automatic' | 'manual' | 'failed'; provider: string; version: string; warnings: string[]; provenance?: AnalysisProvenance };
  annotationRevision: number;
}
export interface DisplayOptions {
  currentContour: boolean; referencePhoto: boolean; photoOpacity: number; zoom: number;
  original: boolean; visibleContours: Record<ContourKind, boolean>;
}
export interface ComparisonProject {
  schemaVersion: 1; id: string; name: string; photos: PhotoAsset[]; referenceId: string | null;
  view: PhotoView; referenceConfirmed: boolean; alignmentConfirmed: boolean;
  notes: string; display: DisplayOptions; updatedAt: string;
}
export interface SavedEntry { id: string; name: string; kind: 'baseline' | 'project'; createdAt: string; project: ComparisonProject }
export interface SimilarityTransform { a: number; b: number; tx: number; ty: number; scale: number; rotation: number; residual: number }
export interface QualityIssue { code: string; severity: 'info' | 'warning' | 'block'; message: string; suggestion: string }
export interface QualityResult { status: 'comparable' | 'visual-only' | 'retake'; issues: QualityIssue[] }
export interface RegionMetric { kind: ContourKind; label: string; signedOffset: number; absoluteOffset: number; referenceScale: number; unit: 'face-percent'; projection?: { widthChangePercent: number | null; heightChangePercent: number | null } }
export interface AIAdvice { summary: string; qualityIssues: { code: string; severity: 'info' | 'warning'; message: string; suggestion: string }[]; regionNotes: { metricId: string | null; text: string }[]; limitations: string[]; model: string; inputDigest: string }
export interface AnalysisInput { blob: Blob; width: number; height: number }
export interface FaceLandmarkProvider { readonly id: string; detectFace(input: AnalysisInput): Promise<Pick<AnalysisResult, 'anchors' | 'pose' | 'warnings' | 'provider' | 'version' | 'provenance'>> }
export interface HairSegmentationProvider { readonly id: string; segmentHair(input: AnalysisInput): Promise<Pick<AnalysisResult, 'contours' | 'warnings' | 'provider' | 'version' | 'provenance'>> }
export interface ImagePreprocessor { prepare(file: Blob, name: string): Promise<PhotoAsset> }
export interface CaptureQualityEvaluator { evaluate(reference: PhotoAsset, current: PhotoAsset, project: ComparisonProject, transform: SimilarityTransform | null): QualityResult }
export interface RegistrationProvider { register(reference: PhotoAsset, current: PhotoAsset): SimilarityTransform | null }
export interface ComparisonEngine { compare(reference: PhotoAsset, current: PhotoAsset, transform: SimilarityTransform, quality: QualityResult): RegionMetric[] }
export interface AIAdviceProvider { advise(project: ComparisonProject, quality: QualityResult, metrics: RegionMetric[]): Promise<AIAdvice> }

export const CONTOUR_LABELS: Record<ContourKind, string> = { outer: '外轮廓', fringe: '刘海下缘', leftSideburn: '左鬓角', rightSideburn: '右鬓角' };
export const emptyContours = (): HairContours => ({ outer: [], fringe: [], leftSideburn: [], rightSideburn: [] });
export const defaultDisplay = (): DisplayOptions => ({ currentContour: false, referencePhoto: false, photoOpacity: 1, zoom: 1, original: false, visibleContours: { outer: true, fringe: true, leftSideburn: true, rightSideburn: true } });
export const createProject = (): ComparisonProject => ({ schemaVersion: 1, id: createId(), name: '', photos: [], referenceId: null, view: 'front', referenceConfirmed: false, alignmentConfirmed: false, notes: '', display: defaultDisplay(), updatedAt: new Date().toISOString() });
