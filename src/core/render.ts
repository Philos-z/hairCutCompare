import type { ComparisonProject, ContourKind, PhotoAsset, QualityResult, RegionMetric, SimilarityTransform } from './types';
import { CONTOUR_LABELS } from './types';
import { toPixel, transformPoint } from './geometry';

export const REFERENCE_COLOR = '#159464';
export const CURRENT_COLOR = '#d78a3e';
export function drawBase(ctx: CanvasRenderingContext2D, reference: PhotoAsset, current: PhotoAsset, rImage: CanvasImageSource, cImage: CanvasImageSource, project: ComparisonProject, transform: SimilarityTransform | null, width: number, height: number) {
  ctx.save();ctx.clearRect(0,0,width,height);ctx.fillStyle='#e7ebe7';ctx.fillRect(0,0,width,height);
  const s=width/reference.width;ctx.scale(s,s);
  ctx.beginPath();ctx.rect(0,0,reference.width,reference.height);ctx.clip();
  if(project.display.original) {
    const fit=Math.min(reference.width/current.width,reference.height/current.height);
    ctx.drawImage(cImage,(reference.width-current.width*fit)/2,(reference.height-current.height*fit)/2,current.width*fit,current.height*fit);
  } else {
    if(project.display.referencePhoto){ctx.drawImage(rImage,0,0,reference.width,reference.height);}
    ctx.globalAlpha=project.display.photoOpacity;
    if(transform)ctx.transform(transform.a,transform.b,-transform.b,transform.a,transform.tx,transform.ty);
    else { const fit=Math.min(reference.width/current.width,reference.height/current.height);ctx.translate((reference.width-current.width*fit)/2,(reference.height-current.height*fit)/2);ctx.scale(fit,fit); }
    ctx.drawImage(cImage,0,0,current.width,current.height);
  }
  ctx.restore();
}
export function drawContourLayers(ctx:CanvasRenderingContext2D, reference:PhotoAsset,current:PhotoAsset,project:ComparisonProject,t:SimilarityTransform|null,width:number) {
  if(project.display.original)return;
  const scale=width/reference.width;ctx.save();ctx.scale(scale,scale);ctx.lineJoin='round';ctx.lineCap='round';ctx.lineWidth=2.5/scale;
  const stroke=(photo:PhotoAsset,kind:ContourKind,isCurrent:boolean)=>{
    const points=photo.contours[kind];if(points.length<2||isCurrent&&!t)return;
    ctx.beginPath();points.forEach((p,i)=>{let q=toPixel(p,photo);if(isCurrent&&t)q=transformPoint(q,t);if(i===0)ctx.moveTo(q.x,q.y);else ctx.lineTo(q.x,q.y);});
    ctx.strokeStyle=isCurrent?CURRENT_COLOR:REFERENCE_COLOR;ctx.setLineDash(isCurrent?[7/scale,5/scale]:[]);ctx.stroke();
  };
  for(const kind of Object.keys(CONTOUR_LABELS) as ContourKind[]){if(!project.display.visibleContours[kind])continue;stroke(reference,kind,false);if(project.display.currentContour)stroke(current,kind,true);}
  ctx.restore();
}
function wrapText(ctx:CanvasRenderingContext2D,text:string,maxWidth:number):string[]{const lines:string[]=[];let line='';for(const ch of text){if(ch==='\n'){lines.push(line);line='';continue;}if(ch==='\r')continue;if(ctx.measureText(line+ch).width>maxWidth){lines.push(line);line=ch;}else line+=ch;}if(line)lines.push(line);return lines;}
export async function exportComparison(project:ComparisonProject,reference:PhotoAsset,current:PhotoAsset,rImage:CanvasImageSource,cImage:CanvasImageSource,t:SimilarityTransform|null,quality:QualityResult,metrics:RegionMetric[]):Promise<Blob>{
  // "查看原图" is a temporary inspection mode; a comparison download always
  // includes the chosen contour layers in the reference coordinate system.
  project={...project,display:{...project.display,original:false}};
  const width=Math.min(2048,Math.max(800,reference.width)), height=Math.round(width*reference.height/reference.width), font=Math.max(18,width/48),pad=width/24;
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法导出图片。');
  ctx.font=`${font}px sans-serif`;const notes=wrapText(ctx,project.notes||'未添加理发备注',width-pad*2);
  ctx.font=`600 ${font*1.35}px sans-serif`;const titles=wrapText(ctx,project.name||'发型参照',width-pad*2);ctx.font=`${font}px sans-serif`;
  const status=quality.status==='comparable'?'可量化 · 2D 投影比例':quality.status==='retake'?'需重拍 · 仅供参考':'仅供视觉参考';
  const percent=(value:number|null)=>{if(value===null)return '—';const rounded=Math.abs(value)<.05?0:value;return `${rounded>=0?'+':''}${rounded.toFixed(1)}%`;};
  const metricLines=metrics.flatMap(m=>[`${m.label}：轮廓偏移 ${m.signedOffset>=0?'+':''}${m.signedOffset.toFixed(1)}% 面部参考尺度`, ...(m.projection?[`投影宽度 ${percent(m.projection.widthChangePercent)} · 高度 ${percent(m.projection.heightChangePercent)}`]:[])]);
  const issueLines=quality.issues.filter(i=>i.severity!=='info').slice(0,3).flatMap(i=>wrapText(ctx,i.message,width-pad*2));
  const footer=Math.round(pad*2+font*1.6*(4+notes.length+metricLines.length+issueLines.length)+font*1.9*(titles.length-1));canvas.width=width;canvas.height=height+footer;
  drawBase(ctx,reference,current,rImage,cImage,project,t,width,height);drawContourLayers(ctx,reference,current,project,t,width);
  ctx.fillStyle='#fafaf6';ctx.fillRect(0,height,width,footer);let y=height+pad+font;
  ctx.fillStyle='#25362e';ctx.font=`600 ${font*1.35}px sans-serif`;for(const line of titles){ctx.fillText(line,pad,y);y+=font*1.9;}
  ctx.font=`${font}px sans-serif`;ctx.fillText(`${new Date().toLocaleDateString('zh-CN')} · ${status}${project.display.original?' · 原图查看，未叠加轮廓':''}`,pad,y);y+=font*1.6;
  ctx.fillStyle=REFERENCE_COLOR;ctx.fillText('绿色实线：喜欢的轮廓',pad,y);if(project.display.currentContour){ctx.fillStyle=CURRENT_COLOR;ctx.fillText('橙色虚线：当前轮廓',width/2,y);}y+=font*1.6;
  ctx.fillStyle='#46574d';for(const line of [...metricLines,...issueLines,...notes]){ctx.fillText(line,pad,y);y+=font*1.6;}
  ctx.fillStyle='#76847b';ctx.fillText('发型参照 · 照片投影对比，非真实发丝长度测量',pad,y);
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 导出失败，请降低图片尺寸重试。')),'image/png'));
}
