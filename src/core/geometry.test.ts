import { describe, expect, it } from 'vitest';
import { fitSimilarity, inversePoint, registerPhotos, transformPoint } from './geometry';
import { emptyContours, type PhotoAsset, type Point } from './types';

const source:Point[]=[{x:120,y:100},{x:230,y:108},{x:179,y:200},{x:175,y:260}];
function photo(width:number,height:number,points:Point[]):PhotoAsset{return{id:'test',name:'',image:new Blob(),original:new Blob(),width,height,originalWidth:width,originalHeight:height,sourceMime:'image/png',anchors:points.map((p,i)=>({id:(['leftEye','rightEye','nose','chin'] as const)[i],label:'',point:{x:p.x/width,y:p.y/height}})),contours:emptyContours(),analysis:{status:'manual',provider:'test',version:'1',warnings:[]},annotationRevision:1};}
describe('pixel-space similarity registration',()=>{
  it('recovers rotation/translation/scale for unequal aspect ratios',()=>{
    const angle=.31,scale=1.7,t={a:scale*Math.cos(angle),b:scale*Math.sin(angle),tx:33,ty:-40,scale,rotation:angle,residual:0}, target=source.map(p=>transformPoint(p,t));
    const result=registerPhotos(photo(960,720,target),photo(400,1100,source))!;
    for(const key of ['a','b','tx','ty','scale','rotation'] as const)expect(result[key]).toBeCloseTo(t[key],9);
    expect(result.residual).toBeLessThan(1e-9);expect(inversePoint(transformPoint(source[0],result),result).x).toBeCloseTo(source[0].x,9);
  });
  it('returns identity for identical points',()=>{const t=fitSimilarity(source,source)!;expect(t.a).toBe(1);expect(t.b).toBe(0);expect(t.residual).toBe(0);});
  it('does not use hairstyle geometry to calculate the transform',()=>{const reference=photo(400,500,source),current=photo(400,500,source);const before=registerPhotos(reference,current);current.contours.outer=[{x:.1,y:.1},{x:.8,y:.05},{x:.9,y:.4}];expect(registerPhotos(reference,current)).toEqual(before);});
  it('rejects missing, collinear and nonfinite calibration points',()=>{expect(fitSimilarity(source.slice(0,2),source.slice(0,2))).toBeNull();expect(fitSimilarity([{x:1,y:1},{x:2,y:2},{x:3,y:3}],[{x:1,y:1},{x:2,y:2},{x:3,y:3}])).toBeNull();expect(fitSimilarity([{x:NaN,y:0},...source.slice(1)],source)).toBeNull();});
});
