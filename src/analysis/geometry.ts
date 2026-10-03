import type { FaceAnchor, HairContours, Point, Pose } from '../core/types';
import { emptyContours } from '../core/types';

interface Landmark { x: number; y: number; z?: number }
const finitePoint = (p: Landmark | undefined): p is Landmark => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const mean = (points: Landmark[]): Point => ({ x: points.reduce((v, p) => v + p.x, 0) / points.length, y: points.reduce((v, p) => v + p.y, 0) / points.length });

/** Anchor names refer to IMAGE left/right, independent of the person's anatomical side. */
export function anchorsFromLandmarks(landmarks: Landmark[]): FaceAnchor[] {
  if (![33, 133, 362, 263, 1, 152].every(index => finitePoint(landmarks[index]))) return [];
  const eyes = [mean([landmarks[33], landmarks[133]]), mean([landmarks[362], landmarks[263]])].sort((a, b) => a.x - b.x);
  return [
    { id: 'leftEye', label: '画面左眼', point: eyes[0] },
    { id: 'rightEye', label: '画面右眼', point: eyes[1] },
    { id: 'nose', label: '鼻尖', point: { x: landmarks[1].x, y: landmarks[1].y } },
    { id: 'chin', label: '下巴', point: { x: landmarks[152].x, y: landmarks[152].y } },
  ];
}

/** MediaPipe matrices are column-major canonical-face -> camera transforms.
 * Remove column scale before extracting Euler angles (Rz * Ry * Rx).
 * These estimates diagnose perspective; they never warp hair or infer metric depth.
 */
export function poseFromMatrix(data: ArrayLike<number> | undefined): Pose | undefined {
  if (!data || data.length !== 16 || Array.from(data).some(n => !Number.isFinite(n))) return undefined;
  const scales = [Math.hypot(data[0], data[1], data[2]), Math.hypot(data[4], data[5], data[6]), Math.hypot(data[8], data[9], data[10])];
  if (scales.some(s => s < 1e-8)) return undefined;
  const r00 = data[0] / scales[0], r10 = data[1] / scales[0], r20 = data[2] / scales[0];
  const r21 = data[6] / scales[1], r22 = data[10] / scales[2];
  const radians = 180 / Math.PI;
  return { yaw: Math.asin(Math.max(-1, Math.min(1, -r20))) * radians, pitch: Math.atan2(r21, r22) * radians, roll: Math.atan2(r10, r00) * radians };
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}
export function simplifyLine(points: Point[], tolerance = 0.0025): Point[] {
  if (points.length < 3) return points;
  let max = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], points[0], points[points.length - 1]);
    if (d > max) { max = d; index = i; }
  }
  if (max <= tolerance) return [points[0], points[points.length - 1]];
  return [...simplifyLine(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplifyLine(points.slice(index), tolerance)];
}

/** Retain a single connected hair component; disconnected speckles cannot define the head. */
export function largestComponent(mask: Uint8Array, width: number, height: number): Uint8Array {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let largest: number[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0, tail = 1; queue[0] = seed; visited[seed] = 1;
    const component: number[] = [];
    while (head < tail) {
      const index = queue[head++]; component.push(index);
      const x = index % width, y = Math.floor(index / width);
      const neighbors = [x > 0 ? index - 1 : -1, x + 1 < width ? index + 1 : -1, y > 0 ? index - width : -1, y + 1 < height ? index + width : -1];
      for (const next of neighbors) if (next >= 0 && mask[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next; }
    }
    if (component.length > largest.length) largest = component;
  }
  const result = new Uint8Array(mask.length);
  for (const index of largest) result[index] = 1;
  return result;
}

/** Follow actual exposed pixel edges. Row envelopes can splice separate sides
 * across the face when one side ends sooner, so they are never used as a path. */
export function traceOuterArch(mask: Uint8Array, width: number, height: number, centerX?: number): Point[] {
  interface Edge { from: number; to: number; direction: number; used: boolean }
  const stride = width + 1, edges: Edge[] = [], outgoing = new Map<number, Edge[]>();
  const add = (x0: number, y0: number, x1: number, y1: number, direction: number) => {
    const edge: Edge = { from: y0 * stride + x0, to: y1 * stride + x1, direction, used: false };
    edges.push(edge); const list = outgoing.get(edge.from) ?? []; list.push(edge); outgoing.set(edge.from, list);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    if (y === 0 || !mask[(y - 1) * width + x]) add(x, y, x + 1, y, 0);
    if (x === width - 1 || !mask[y * width + x + 1]) add(x + 1, y, x + 1, y + 1, 1);
    if (y === height - 1 || !mask[(y + 1) * width + x]) add(x + 1, y + 1, x, y + 1, 2);
    if (x === 0 || !mask[y * width + x - 1]) add(x, y + 1, x, y, 3);
  }
  const coordinate = (key: number): Point => ({ x: (key % stride) / width, y: Math.floor(key / stride) / height });
  let loop: Point[] = [], bestArea = 0;
  for (const seed of edges) {
    if (seed.used) continue;
    const path: Point[] = [];
    let edge: Edge | undefined = seed;
    while (edge && !edge.used) {
      edge.used = true; path.push(coordinate(edge.from));
      if (edge.to === seed.from) break;
      const direction: number = edge.direction;
      // Keep hair on the right at a corner shared by diagonally touching edges.
      const priority = (candidate: Edge): number => [1, 0, 3, 2].indexOf((candidate.direction - direction + 4) % 4);
      edge = outgoing.get(edge.to)?.filter(candidate => !candidate.used).sort((a, b) => priority(a) - priority(b))[0];
    }
    if (path.length < 4) continue;
    const area = Math.abs(path.reduce((sum, p, i) => { const next = path[(i + 1) % path.length]; return sum + p.x * next.y - next.x * p.y; }, 0));
    if (area > bestArea) { bestArea = area; loop = path; }
  }
  if (!loop.length) return [];
  const bounds = loop.reduce((extent, p) => ({ min: Math.min(extent.min, p.x), max: Math.max(extent.max, p.x) }), { min: 1, max: 0 });
  const middle = centerX ?? (bounds.min + bounds.max) / 2;
  let leftIndex = -1, rightIndex = -1;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    if (p.x < middle && (leftIndex < 0 || p.y > loop[leftIndex].y || (p.y === loop[leftIndex].y && p.x < loop[leftIndex].x))) leftIndex = i;
    if (p.x > middle && (rightIndex < 0 || p.y > loop[rightIndex].y || (p.y === loop[rightIndex].y && p.x > loop[rightIndex].x))) rightIndex = i;
  }
  if (leftIndex < 0 || rightIndex < 0) return [];
  const arc = (step: number) => {
    const path: Point[] = [];
    for (let i = leftIndex; ; i = (i + step + loop.length) % loop.length) { path.push(loop[i]); if (i === rightIndex) return path; }
  };
  const forward = arc(1), backward = arc(-1);
  const minY = (points: Point[]) => points.reduce((min, p) => Math.min(min, p.y), 1);
  return simplifyLine(minY(forward) < minY(backward) ? forward : backward);
}

export function contoursFromMask(inputMask: Uint8Array, width: number, height: number, anchors: FaceAnchor[] = []): { contours: HairContours; warnings: string[] } {
  const contours = emptyContours(), warnings: string[] = [];
  if (width < 2 || height < 2 || inputMask.length !== width * height) return { contours, warnings: ['头发遮罩尺寸无效，请手工描线。'] };
  const mask = largestComponent(inputMask, width, height);
  let count = 0, top = height, bottom = -1;
  const left = new Int32Array(height).fill(width), right = new Int32Array(height).fill(-1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) { count++; top = Math.min(top, y); bottom = Math.max(bottom, y); left[y] = Math.min(left[y], x); right[y] = Math.max(right[y], x); }
  if (count < Math.max(12, width * height * 0.0008) || bottom <= top) return { contours, warnings: ['未找到可靠的头发区域，请手工描线。'] };
  const point = (x: number, y: number): Point => ({ x: (x + 0.5) / width, y: (y + 0.5) / height });
  contours.outer = traceOuterArch(mask, width, height, anchors.find(anchor => anchor.id === 'nose')?.point.x);
  if (contours.outer.length < 2) warnings.push('未找到连续的头顶与两侧外轮廓，请手工描线。');
  if (left.some(x => x === 0) || right.some(x => x === width - 1) || top === 0 || bottom === height - 1) warnings.push('头发区域触及画面边缘，轮廓可能被裁切。');
  const eyeLeft = anchors.find(a => a.id === 'leftEye')?.point, eyeRight = anchors.find(a => a.id === 'rightEye')?.point;
  const nose = anchors.find(a => a.id === 'nose')?.point, chin = anchors.find(a => a.id === 'chin')?.point;
  if (eyeLeft && eyeRight && nose && chin) {
    const eyeY = (eyeLeft.y + eyeRight.y) / 2, faceHeight = Math.max(0.08, chin.y - eyeY);
    const x0 = Math.max(0, Math.floor(eyeLeft.x * width)), x1 = Math.min(width - 1, Math.ceil(eyeRight.x * width));
    const y0 = Math.max(top, Math.floor((eyeY - faceHeight * 0.65) * height));
    const y1 = Math.min(bottom, Math.floor((eyeY + faceHeight * 0.12) * height));
    let fringe: Point[] = [], candidate: Point[] = [];
    for (let x = x0; x <= x1; x++) {
      let edge = -1;
      for (let y = y0; y <= y1; y++) if (mask[y * width + x] && y + 1 < height && !mask[(y + 1) * width + x]) edge = y;
      if (edge >= 0) candidate.push(point(x, edge));
      else { if (candidate.length > fringe.length) fringe = candidate; candidate = []; }
    }
    if (candidate.length > fringe.length) fringe = candidate;
    if (fringe.length >= Math.max(4, (x1 - x0) * 0.3)) contours.fringe = simplifyLine(fringe);
    const sides = [
      { kind: 'leftSideburn' as const, xs: left, accept: (x: number) => x / width < eyeLeft.x },
      { kind: 'rightSideburn' as const, xs: right, accept: (x: number) => x / width > eyeRight.x },
    ];
    const from = Math.max(top, Math.round(eyeY * height)), to = Math.min(bottom, Math.round(nose.y * height));
    for (const side of sides) {
      const points: Point[] = [];
      for (let y = from; y <= to; y++) if (right[y] >= 0 && side.accept(side.xs[y])) points.push(point(side.xs[y], y));
      if (points.length >= Math.max(4, height * 0.02)) contours[side.kind] = simplifyLine(points);
    }
  }
  warnings.push('自动轮廓是候选线，请确认外轮廓；刘海和鬓角尤其需要人工核对。');
  if (!contours.fringe.length) warnings.push('未可靠识别刘海下缘，可以手工补画。');
  return { contours, warnings };
}
