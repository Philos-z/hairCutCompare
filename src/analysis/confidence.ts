/** Raw model confidence averaged over pixels where category 1 wins.
 * This is diagnostic metadata, not a calibrated segmentation accuracy score.
 * Background pixels and non-finite outputs do not contribute to the mean.
 */
export function meanHairConfidence(categories: ArrayLike<number>, hairConfidence: ArrayLike<number> | undefined): number | undefined {
  if (!hairConfidence || hairConfidence.length !== categories.length) return undefined;
  let sum = 0, count = 0;
  for (let i = 0; i < categories.length; i++) {
    const confidence = hairConfidence[i];
    if (categories[i] === 1 && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) { sum += confidence; count++; }
  }
  return count ? sum / count : undefined;
}
