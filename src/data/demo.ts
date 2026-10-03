import { createProject, type ComparisonProject, type FaceAnchor, type HairContours, type PhotoAsset, type Point } from '../core/types';
import { createId } from '../core/id';
import { canvasBlob, measureImageStats } from './images';

const WIDTH = 720, HEIGHT = 900;
const angle = 5 * Math.PI / 180;
const transform = { a: .92 * Math.cos(angle), b: .92 * Math.sin(angle), tx: 76, ty: 6 };
const referenceOuter: Point[] = [
  { x: 220, y: 606 }, { x: 208, y: 548 }, { x: 202, y: 470 }, { x: 197, y: 398 },
  { x: 202, y: 339 }, { x: 217, y: 296 }, { x: 246, y: 257 }, { x: 280, y: 234 },
  { x: 316, y: 217 }, { x: 360, y: 208 }, { x: 404, y: 218 }, { x: 443, y: 237 },
  { x: 476, y: 265 }, { x: 503, y: 305 }, { x: 518, y: 356 }, { x: 521, y: 413 },
  { x: 513, y: 476 }, { x: 510, y: 549 }, { x: 500, y: 606 },
];
const referenceFringe: Point[] = [
  { x: 216, y: 412 }, { x: 241, y: 405 }, { x: 270, y: 390 }, { x: 301, y: 405 },
  { x: 330, y: 385 }, { x: 360, y: 403 }, { x: 392, y: 386 }, { x: 423, y: 404 },
  { x: 455, y: 391 }, { x: 479, y: 406 }, { x: 505, y: 413 },
];
const referenceLines: HairContours = {
  outer: referenceOuter,
  fringe: referenceFringe,
  leftSideburn: [{ x: 216, y: 412 }, { x: 224, y: 486 }, { x: 229, y: 551 }, { x: 236, y: 599 }],
  rightSideburn: [{ x: 505, y: 413 }, { x: 498, y: 486 }, { x: 492, y: 552 }, { x: 485, y: 599 }],
};
const currentLines: HairContours = {
  outer: referenceOuter.map(p => ({ x: 360 + (p.x - 360) * 1.13, y: p.y < 415 ? p.y - 43 : p.y + 14 })),
  fringe: referenceFringe.map(p => ({ x: p.x, y: p.y + 35 })),
  leftSideburn: referenceLines.leftSideburn.map((p, i) => ({ x: p.x - 6, y: p.y + i * 12 })),
  rightSideburn: referenceLines.rightSideburn.map((p, i) => ({ x: p.x + 6, y: p.y + i * 12 })),
};
const anchors: FaceAnchor[] = [
  { id: 'leftEye', label: '左眼', point: { x: 291, y: 466 } },
  { id: 'rightEye', label: '右眼', point: { x: 429, y: 466 } },
  { id: 'nose', label: '鼻尖', point: { x: 360, y: 544 } },
  { id: 'chin', label: '下巴', point: { x: 360, y: 682 } },
];
const mapCurrent = (p: Point): Point => ({ x: transform.a * p.x - transform.b * p.y + transform.tx, y: transform.b * p.x + transform.a * p.y + transform.ty });
const normalized = (p: Point): Point => ({ x: p.x / WIDTH, y: p.y / HEIGHT });

function path(ctx: CanvasRenderingContext2D, points: Point[], close = false): void {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  if (close) ctx.closePath();
}
function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string): void {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
}
function drawHead(ctx: CanvasRenderingContext2D, current: boolean): void {
  const lines = current ? currentLines : referenceLines;
  ctx.save();
  if (current) ctx.transform(transform.a, transform.b, -transform.b, transform.a, transform.tx, transform.ty);
  // An intentionally stylized illustration: never masquerade as a captured customer photo.
  ctx.fillStyle = '#e8bd9a';
  ctx.fillRect(304, 624, 112, 161);
  ctx.beginPath(); ctx.moveTo(168, 895); ctx.quadraticCurveTo(172, 786, 283, 762);
  ctx.quadraticCurveTo(360, 814, 437, 762); ctx.quadraticCurveTo(548, 786, 552, 895); ctx.closePath();
  ctx.fillStyle = current ? '#5984ad' : '#5b9386'; ctx.fill();
  ellipse(ctx, 210, 516, 25, 47, '#ebc4a5');
  ellipse(ctx, 510, 516, 25, 47, '#ebc4a5');
  ctx.beginPath();
  ctx.moveTo(211, 420); ctx.bezierCurveTo(226, 321, 494, 321, 509, 420);
  ctx.bezierCurveTo(507, 574, 473, 660, 360, 682);
  ctx.bezierCurveTo(247, 660, 213, 574, 211, 420); ctx.closePath();
  const skin = ctx.createLinearGradient(210, 430, 510, 620);
  skin.addColorStop(0, '#f6d6ba'); skin.addColorStop(1, '#edc4a7'); ctx.fillStyle = skin; ctx.fill();
  // Hair outline, sideburns and fringe are the same vertices exposed to the editor.
  const hairShape = [
    ...lines.outer,
    ...lines.rightSideburn.slice().reverse(),
    ...lines.fringe.slice().reverse(),
    ...lines.leftSideburn,
  ];
  path(ctx, hairShape, true); ctx.fillStyle = '#344341'; ctx.fill();
  ctx.strokeStyle = '#243633'; ctx.lineWidth = 3; ctx.stroke();
  ctx.save();
  path(ctx, hairShape, true); ctx.clip();
  ctx.strokeStyle = '#56635d'; ctx.lineWidth = 5;
  for (let x = 236; x <= 487; x += 37) {
    ctx.beginPath(); ctx.moveTo(x - 20, 402); ctx.quadraticCurveTo(x - 11, 290, x + 35, 229); ctx.stroke();
  }
  ctx.restore();
  // Stable facial geometry is identical in both illustrations.
  ctx.strokeStyle = '#695046'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  for (const x of [291, 429]) {
    ctx.beginPath(); ctx.moveTo(x - 24, 442); ctx.quadraticCurveTo(x, 432, x + 25, 442); ctx.stroke();
    ellipse(ctx, x, 466, 22, 11, '#fff9ed');
    ellipse(ctx, x, 466, 7, 9, '#3a4b45');
    ellipse(ctx, x + 2, 463, 2, 2, '#fff');
  }
  ctx.lineWidth = 4; ctx.strokeStyle = '#bd8e76';
  ctx.beginPath(); ctx.moveTo(361, 486); ctx.lineTo(351, 537); ctx.quadraticCurveTo(360, 553, 373, 540); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(323, 596); ctx.quadraticCurveTo(360, 613, 397, 596); ctx.strokeStyle = '#a96d63'; ctx.stroke();
  ctx.restore();
}

async function demoPhoto(current: boolean): Promise<PhotoAsset> {
  const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法绘制示意图片。');
  ctx.fillStyle = current ? '#e8edf2' : '#eaf0ea'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = current ? '#d9e1e9' : '#dce6dd'; ctx.lineWidth = 1;
  for (let x = 0; x < WIDTH; x += 45) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, HEIGHT); ctx.stroke(); }
  for (let y = 0; y < HEIGHT; y += 45) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WIDTH, y); ctx.stroke(); }
  drawHead(ctx, current);
  ctx.fillStyle = '#536963'; ctx.font = '600 17px sans-serif';
  ctx.fillText('DEMO / ILLUSTRATION', 32, 46);
  ctx.font = '15px sans-serif'; ctx.fillText(current ? 'CURRENT · +5° / ×0.92' : 'REFERENCE · FRONT', 32, 73);
  const blob = await canvasBlob(canvas);
  const mapPoint = (p: Point) => normalized(current ? mapCurrent(p) : p);
  const contours = Object.fromEntries(Object.entries(current ? currentLines : referenceLines).map(([kind, points]) => [kind, points.map(mapPoint)])) as HairContours;
  return {
    id: createId(), name: current ? '本次发型 · 示意' : '喜欢的发型 · 示意', original: blob, image: blob,
    width: WIDTH, height: HEIGHT, originalWidth: WIDTH, originalHeight: HEIGHT, sourceMime: 'image/png',
    anchors: anchors.map(anchor => ({ ...anchor, point: mapPoint(anchor.point) })), contours,
    pose: { yaw: 0, pitch: 0, roll: current ? 5 : 0 }, stats: measureImageStats(canvas, WIDTH, HEIGHT),
    analysis: { status: 'manual', provider: 'demo', version: 'illustration-v1', warnings: ['示意数据，不代表实拍精度'] },
    annotationRevision: 1,
  };
}

export async function createDemoProject(): Promise<ComparisonProject> {
  const reference = await demoPhoto(false), current = await demoPhoto(true);
  return {
    ...createProject(), name: '轮廓校正示意', photos: [reference, current], referenceId: reference.id,
    referenceConfirmed: true, alignmentConfirmed: true,
    notes: '示意数据，不代表实拍精度。两张图的面部完全相同；本次发型头顶更高、两侧更宽、刘海更低。当前图另有 5° 旋转、0.92 倍缩放及位置变化，用于验证校准。',
  };
}
