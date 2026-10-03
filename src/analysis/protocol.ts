import type { AnalysisResult } from '../core/types';
export interface AnalysisRequest { id: number; blob: Blob; baseURL: string }
export type AnalysisResponse = { id: number; result: AnalysisResult } | { id: number; error: string };
export const ANALYSIS_VERSION = 'tasks-vision@0.10.32/face-f16-v1/hair-f32-v1/contours-v1';
