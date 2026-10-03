import type { FaceLandmarkProvider, HairSegmentationProvider, ImagePreprocessor, CaptureQualityEvaluator, RegistrationProvider, ComparisonEngine } from './types';
import { registerPhotos } from './geometry';
import { compareContours, evaluateQuality } from './comparison';

/** Native adapters exchange this same normalized image contract through a bridge or service. */
export interface ProviderRegistry { face: FaceLandmarkProvider; hair: HairSegmentationProvider; preprocess: ImagePreprocessor; quality: CaptureQualityEvaluator; registration: RegistrationProvider; comparison: ComparisonEngine }
export const registrationProvider:RegistrationProvider={register:registerPhotos};
export const qualityProvider:CaptureQualityEvaluator={evaluate:evaluateQuality};
export const comparisonEngine:ComparisonEngine={compare:compareContours};
export const nativeAdapterContract = { contractVersion: 1, coordinates: 'oriented-image-normalized', transform: 'current-pixels-to-reference-pixels-similarity', futureProvider: 'apple-vision', enabled: false } as const;
