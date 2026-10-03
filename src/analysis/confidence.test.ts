import { expect, it } from 'vitest';
import { meanHairConfidence } from './confidence';

it('reports raw winning-hair confidence independently of the contour threshold', () => {
  expect(meanHairConfidence([0, 1, 1], [0.99, 0.4, 0.8])).toBeCloseTo(0.6);
  expect(meanHairConfidence([0, 0], [0.99, 0.9])).toBeUndefined();
  expect(meanHairConfidence([1, 1], [0.8, Number.NaN])).toBeCloseTo(0.8);
});
it('does not manufacture missing confidence or accept mismatched confidence maps', () => {
  expect(meanHairConfidence([1], undefined)).toBeUndefined();
  expect(meanHairConfidence([1, 1], [0.9])).toBeUndefined();
});
