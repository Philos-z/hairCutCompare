import { CONTOUR_LABELS, type ComparisonProject, type ContourKind, type PhotoAsset, type QualityIssue, type QualityResult, type RegionMetric, type SimilarityTransform } from './types';
import { contourCovered, faceScale, nearestOnPolyline, samplePolyline, toPixel, transformPoint } from './geometry';

export const QUALITY_CONFIG_VERSION = 'web-research-1';
export function evaluateQuality(reference: PhotoAsset, current: PhotoAsset, project: ComparisonProject, t: SimilarityTransform | null): QualityResult {
  const issues: QualityIssue[]=[];
  const add=(code: string,severity: QualityIssue['severity'],message: string,suggestion: string)=>issues.push({code,severity,message,suggestion});
  if(!t) add('anchors','warning','面部锚点不足，尚未完成对齐','在两张照片中确认至少三个分布充分的对应锚点。');
  if((reference.analysis.status==='automatic'||current.analysis.status==='automatic')&&
     (reference.analysis.provider!==current.analysis.provider||reference.analysis.version!==current.analysis.version))
    add('algorithm-version','warning','两张照片使用了不同的自动分析版本','使用同一版本重新分析，或分别打开编辑器人工检查并应用双方标注。');
  const scale=faceScale(reference);
  if(t&&(!scale||t.residual/scale>0.08)) add('alignment','block','面部对齐误差较大','检查对应锚点，保持中性表情并使用更接近的拍摄角度。');
  if(reference.pose&&current.pose) {
    if(Math.abs(reference.pose.yaw-current.pose.yaw)>15 || Math.abs(reference.pose.pitch-current.pose.pitch)>12) add('pose','block','转头或仰俯角度明显不一致','参考喜欢照片的姿态重新拍摄，二维旋转不能恢复被遮挡的轮廓。');
  } else add('pose-unknown','info','姿态需要人工确认','确认两张照片的转头、仰俯角度接近；大角度差异请重拍。');
  for(const [label,photo] of [['喜欢照片',reference],['当前照片',current]] as const) {
    if(photo.contours.outer.length<3) add('missing-contour','warning',`${label}缺少完整外轮廓`,'在轮廓编辑器中检查、描画并确认可见边界。');
    if(Object.values(photo.contours).some(points=>points.some(p=>p.x<=.002||p.y<=.002||p.x>=.998||p.y>=.998)))
      add('clipped-region','info',`${label}有轮廓触及画面边缘`,'这些区域不会量化；重新拍摄完整头部可补充对比。');
    if(photo.stats) {
      if(photo.stats.luminance<0.10&&photo.stats.darkFraction>0.70) add('dark','warning',`${label}整体偏暗`,'补充柔和正面光线，确认头发边缘清楚可见。');
      if(photo.stats.brightFraction>0.35) add('exposure','warning',`${label}高亮区域较多`,'避开逆光与过曝，检查发梢是否仍清晰。');
      if(photo.stats.sharpness<0.001) add('blur','warning',`${label}细节可能模糊`,'确认边界清楚，必要时重新拍摄。');
    }
  }
  if(t && (Object.values(reference.contours).some(points=>points.length>1&&!contourCovered(points,current,reference,t))||Object.values(current.contours).some(points=>points.some(p=>{const q=transformPoint(toPixel(p,current),t);return q.x<0||q.y<0||q.x>reference.width||q.y>reference.height;})))) add('coverage','warning','部分轮廓超出双方共同的照片画面','重新拍摄完整头部；缺失区域不会提供量化结果。');
  if(t && scale>0) {
    const currentFraction=faceScale(current)/current.width, refFraction=scale/reference.width;
    if(currentFraction>0 && Math.max(currentFraction/refFraction,refFraction/currentFraction)>1.6) add('distance','warning','两张照片的面部占框比例差异较大','尽量保持相同镜头与拍摄距离，避免透视变化。');
  }
  if(reference.analysis.provider==='demo'||current.analysis.provider==='demo') add('demo','info','当前为操作演示示意图','示意数据只用于验证交互，不代表真人测量精度。');
  if(!project.referenceConfirmed) add('reference','info','喜欢的轮廓尚未确认','先检查并确认目标轮廓。');
  if(!project.alignmentConfirmed) add('confirmation','info','双方轮廓、视角与面部锚点尚未确认','在校准步骤检查双方轮廓、面部重合、角度和拍摄距离。');
  const blocked=issues.some(i=>i.severity==='block');
  const unconfirmed=!t||!scale||!project.referenceConfirmed||!project.alignmentConfirmed||reference.contours.outer.length<3||issues.some(i=>i.severity==='warning' && i.code!=='coverage');
  return { status: blocked?'retake':unconfirmed?'visual-only':'comparable',issues };
}
const median=(values:number[])=>{const v=[...values].sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:0;};
export function compareContours(reference: PhotoAsset,current: PhotoAsset,t: SimilarityTransform,quality: QualityResult): RegionMetric[] {
  if(quality.status!=='comparable') return [];
  const scale=faceScale(reference); if(!scale)return [];
  const metrics:RegionMetric[]=[];
  for(const kind of Object.keys(CONTOUR_LABELS) as ContourKind[]) {
    const r=reference.contours[kind], c=current.contours[kind];
    const touchesFrame=(points:typeof r)=>points.some(p=>p.x<=.002||p.y<=.002||p.x>=.998||p.y>=.998);
    // A cut-off source edge cannot support a trustworthy regional measurement,
    // even when the corresponding reference points fit inside the other image.
    if(r.length<2||c.length<2||!contourCovered(r,current,reference,t)||touchesFrame(r)||touchesFrame(c))continue;
    const rp=r.map(p=>toPixel(p,reference)),cp=c.map(p=>transformPoint(toPixel(p,current),t));
    if(cp.some(p=>p.x<0||p.y<0||p.x>reference.width||p.y>reference.height))continue;
    const nose=reference.anchors.find(a=>a.id==='nose'), center=nose?toPixel(nose.point,reference):{x:reference.width/2,y:reference.height*.6};
    const distances:number[]=[],signed:number[]=[];
    for(const p of samplePolyline(cp)) {
      const closest=nearestOnPolyline(p,rp); distances.push(closest.distance);
      const outward=(p.x-closest.point.x)*(closest.point.x-center.x)+(p.y-closest.point.y)*(closest.point.y-center.y);
      const sign=kind==='outer'?(outward<0?-1:1):(p.y<closest.point.y?-1:1);
      signed.push(closest.distance<1e-6?0:sign*closest.distance);
    }
    const span=(points:typeof rp,axis:'x'|'y')=>Math.max(...points.map(p=>p[axis]))-Math.min(...points.map(p=>p[axis]));
    const proportionalChange=(axis:'x'|'y')=>{const baseline=span(rp,axis);return baseline>=1?(span(cp,axis)/baseline-1)*100:null;};
    metrics.push({kind,label:CONTOUR_LABELS[kind],signedOffset:median(signed)/scale*100,absoluteOffset:median(distances)/scale*100,referenceScale:scale,unit:'face-percent',projection:{widthChangePercent:proportionalChange('x'),heightChangePercent:proportionalChange('y')}});
  }
  return metrics;
}
