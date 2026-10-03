import type { FaceAnchor, PhotoAsset, Point, SimilarityTransform } from './types';

export function toPixel(p: Point, size: { width: number; height: number }): Point { return { x: p.x * size.width, y: p.y * size.height }; }
export function transformPoint(p: Point, t: SimilarityTransform): Point { return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty }; }
export function inversePoint(p: Point, t: SimilarityTransform): Point {
  const denominator = t.a * t.a + t.b * t.b;
  return { x: (t.a * (p.x - t.tx) + t.b * (p.y - t.ty)) / denominator, y: (-t.b * (p.x - t.tx) + t.a * (p.y - t.ty)) / denominator };
}
export function fitSimilarity(from: Point[], to: Point[]): SimilarityTransform | null {
  if (from.length !== to.length || from.length < 3 || [...from, ...to].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const center = (points: Point[]) => ({ x: points.reduce((s,p)=>s+p.x,0)/points.length, y: points.reduce((s,p)=>s+p.y,0)/points.length });
  const fc = center(from), tc = center(to);
  let denominator = 0, cosine = 0, sine = 0, xx = 0, yy = 0, xy = 0;
  from.forEach((p,i) => {
    const x = p.x - fc.x, y = p.y - fc.y, u = to[i].x - tc.x, v = to[i].y - tc.y;
    denominator += x*x+y*y; cosine += x*u+y*v; sine += x*v-y*u; xx+=x*x; yy+=y*y; xy+=x*y;
  });
  if (denominator < 1e-8 || xx*yy-xy*xy < denominator*denominator*1e-5) return null;
  const a = cosine / denominator, b = sine / denominator, scale = Math.hypot(a,b);
  if (!Number.isFinite(scale) || scale < 0.01 || scale > 100) return null;
  const tx = tc.x - a*fc.x + b*fc.y, ty = tc.y - b*fc.x - a*fc.y;
  const t: SimilarityTransform = { a,b,tx,ty,scale,rotation: Math.atan2(b,a),residual: 0 };
  t.residual = Math.sqrt(from.reduce((sum,p,i) => { const q=transformPoint(p,t); return sum+(q.x-to[i].x)**2+(q.y-to[i].y)**2; },0)/from.length);
  return t;
}
export function matchedAnchors(reference: FaceAnchor[], current: FaceAnchor[]): [FaceAnchor[],FaceAnchor[]] {
  const r: FaceAnchor[] = [], c: FaceAnchor[] = [];
  for (const anchor of reference) { const other = current.find(a=>a.id===anchor.id); if(other) { r.push(anchor); c.push(other); } }
  return [r,c];
}
export function registerPhotos(reference: PhotoAsset, current: PhotoAsset): SimilarityTransform | null {
  const [r,c] = matchedAnchors(reference.anchors,current.anchors);
  return fitSimilarity(c.map(a=>toPixel(a.point,current)),r.map(a=>toPixel(a.point,reference)));
}
export function transformedNormalized(p: Point, current: PhotoAsset, reference: PhotoAsset, t: SimilarityTransform): Point {
  const q=transformPoint(toPixel(p,current),t); return { x:q.x/reference.width,y:q.y/reference.height };
}
export function contourCovered(points: Point[], current: PhotoAsset, reference: PhotoAsset, t: SimilarityTransform): boolean {
  return points.every(p=> { const q=inversePoint(toPixel(p,reference),t); return q.x>=0 && q.y>=0 && q.x<=current.width && q.y<=current.height; });
}
export function faceScale(photo: PhotoAsset): number {
  const l=photo.anchors.find(a=>a.id==='leftEye'), r=photo.anchors.find(a=>a.id==='rightEye');
  if(l&&r) { const a=toPixel(l.point,photo), b=toPixel(r.point,photo); return Math.hypot(a.x-b.x,a.y-b.y); }
  const n=photo.anchors.find(a=>a.id==='nose'), c=photo.anchors.find(a=>a.id==='chin');
  if(n&&c) { const a=toPixel(n.point,photo),b=toPixel(c.point,photo);return Math.hypot(a.x-b.x,a.y-b.y); }
  return 0;
}
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++) { const a=polygon[i],b=polygon[j]; if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x) inside=!inside; }
  return inside;
}
export function nearestOnPolyline(p: Point, points: Point[], closed=false): { point: Point; distance: number } {
  let nearest = { point: points[0] ?? p, distance: Infinity };
  const count=closed?points.length:points.length-1;
  for(let i=0;i<count;i++) {
    const a=points[i], b=points[(i+1)%points.length], dx=b.x-a.x,dy=b.y-a.y;
    const u=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
    const q={x:a.x+u*dx,y:a.y+u*dy}, distance=Math.hypot(p.x-q.x,p.y-q.y);
    if(distance<nearest.distance) nearest={point:q,distance};
  }
  return nearest;
}
export function samplePolyline(points: Point[], closed=false, count=120): Point[] {
  if(points.length<2) return points;
  const lengths: number[]=[]; let total=0;
  for(let i=0;i<(closed?points.length:points.length-1);i++) { const b=points[(i+1)%points.length];total+=Math.hypot(b.x-points[i].x,b.y-points[i].y);lengths.push(total); }
  if(total===0) return [points[0]];
  const sampled: Point[]=[];
  for(let n=0;n<count;n++) {
    const d=total*n/(closed?count:count-1); let i=lengths.findIndex(v=>v>=d); if(i<0)i=lengths.length-1;
    const previous=i?lengths[i-1]:0, f=(d-previous)/(lengths[i]-previous||1),a=points[i],b=points[(i+1)%points.length];
    sampled.push({x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f});
  }
  return sampled;
}
