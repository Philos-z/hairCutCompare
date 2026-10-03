import { describe, expect, it } from 'vitest';
import { anchorsFromLandmarks, contoursFromMask, largestComponent, poseFromMatrix, traceOuterArch } from './geometry';

describe('MediaPipe coordinate adapter', () => {
  it('names eyes by image x even if anatomical indices are mirrored', () => {
    const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    points[33].x = points[133].x = 0.7; points[362].x = points[263].x = 0.3;
    const anchors = anchorsFromLandmarks(points);
    expect(anchors[0]).toMatchObject({ id: 'leftEye', point: { x: 0.3 } });
    expect(anchors[1]).toMatchObject({ id: 'rightEye', point: { x: 0.7 } });
    expect(anchorsFromLandmarks([])).toEqual([]);
    points[152].y = 1.1;
    expect(anchorsFromLandmarks(points)).toEqual([]);
  });
  it('extracts pose from the column-major matrix and ignores uniform scale', () => {
    const angle = Math.PI / 6, c = Math.cos(angle) * 2, s = Math.sin(angle) * 2;
    const matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 2, 0, 100, 10, 0, 1];
    expect(poseFromMatrix(matrix)?.roll).toBeCloseTo(30);
    expect(poseFromMatrix(matrix)?.yaw).toBeCloseTo(0);
    expect(poseFromMatrix([0, 0])).toBeUndefined();
  });
});

describe('candidate hair silhouette', () => {
  it('ignores disconnected speckles without joining them to the head contour', () => {
    const mask = new Uint8Array(20 * 20);
    for (let y = 3; y < 11; y++) for (let x = 5; x < 15; x++) mask[y * 20 + x] = 1;
    mask[0] = 1;
    expect(largestComponent(mask, 20, 20)[0]).toBe(0);
    const result = contoursFromMask(mask, 20, 20);
    expect(result.contours.outer.length).toBeGreaterThanOrEqual(4);
    expect(result.contours.outer.every(p => p.x > 0.2 && p.y > 0.1)).toBe(true);
    expect(result.contours.fringe).toEqual([]);
    expect(result.warnings.some(w => w.includes('人工'))).toBe(true);
  });
  it('does not manufacture a hairline when no usable hair was detected', () => {
    const result = contoursFromMask(new Uint8Array(400), 20, 20);
    expect(result.contours.outer).toEqual([]);
    expect(result.contours.leftSideburn).toEqual([]);
    expect(result.warnings).not.toEqual([]);
  });
  it('retains asymmetric side endpoints without crossing the empty face region', () => {
    const mask = new Uint8Array(400);
    for (let y = 2; y < 5; y++) for (let x = 3; x < 17; x++) mask[y * 20 + x] = 1;
    for (let y = 5; y < 15; y++) for (let x = 3; x < 6; x++) mask[y * 20 + x] = 1;
    for (let y = 5; y < 12; y++) for (let x = 14; x < 17; x++) mask[y * 20 + x] = 1;
    const arch = traceOuterArch(mask, 20, 20, 0.5);
    expect(arch[0].y).toBeCloseTo(0.75);
    expect(arch.at(-1)?.y).toBeCloseTo(0.6);
    expect(arch.every(p => p.x <= 0.3 || p.x >= 0.7 || p.y <= 0.25)).toBe(true);
    for (let i = 1; i < arch.length; i++) {
      const crossesFace = (arch[i - 1].x <= 0.3 && arch[i].x >= 0.7) || (arch[i - 1].x >= 0.7 && arch[i].x <= 0.3);
      if (crossesFace) expect(Math.max(arch[i - 1].y, arch[i].y)).toBeLessThanOrEqual(0.25);
    }
  });
  it('reports an actually clipped silhouette', () => {
    const mask = new Uint8Array(20 * 20);
    for (let y = 0; y < 10; y++) for (let x = 3; x < 17; x++) mask[y * 20 + x] = 1;
    expect(contoursFromMask(mask, 20, 20).warnings.some(w => w.includes('裁切'))).toBe(true);
  });
  it('keeps a visible fringe candidate continuous instead of crossing an unobserved gap', () => {
    const mask = new Uint8Array(400);
    // Connected at the crown, separated in the forehead search window.
    for (let y = 0; y < 2; y++) for (let x = 5; x < 15; x++) mask[y * 20 + x] = 1;
    for (let y = 2; y < 7; y++) for (const x of [5, 6, 7, 8, 11, 12, 13, 14]) mask[y * 20 + x] = 1;
    const anchors = [
      { id: 'leftEye' as const, label: 'left', point: { x: 0.25, y: 0.4 } },
      { id: 'rightEye' as const, label: 'right', point: { x: 0.7, y: 0.4 } },
      { id: 'nose' as const, label: 'nose', point: { x: 0.5, y: 0.6 } },
      { id: 'chin' as const, label: 'chin', point: { x: 0.5, y: 0.8 } },
    ];
    const points = contoursFromMask(mask, 20, 20, anchors).contours.fringe;
    expect(points.length).toBeGreaterThan(1);
    expect(Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))).toBeLessThan(0.2);
  });
  it('extracts the visible lower forehead boundary separately from the crown arch', () => {
    const mask = new Uint8Array(400);
    for (let y = 2; y < 9; y++) for (let x = 5; x < 15; x++) mask[y * 20 + x] = 1;
    const anchors = [
      { id: 'leftEye' as const, label: 'left', point: { x: 0.35, y: 0.5 } },
      { id: 'rightEye' as const, label: 'right', point: { x: 0.65, y: 0.5 } },
      { id: 'nose' as const, label: 'nose', point: { x: 0.5, y: 0.65 } },
      { id: 'chin' as const, label: 'chin', point: { x: 0.5, y: 0.85 } },
    ];
    const { contours } = contoursFromMask(mask, 20, 20, anchors);
    expect(Math.min(...contours.outer.map(p => p.y))).toBeCloseTo(0.1);
    expect(contours.fringe.length).toBeGreaterThan(1);
    expect(contours.fringe.every(p => p.y > 0.3 && p.y < 0.5)).toBe(true);
  });
});
