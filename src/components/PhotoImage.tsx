import { useEffect, useState } from 'react';
import type { PhotoAsset } from '../core/types';
export function usePhotoImage(photo?: PhotoAsset|null): HTMLImageElement|null {
  const [image,setImage]=useState<HTMLImageElement|null>(null);
  useEffect(()=>{setImage(null);if(!photo)return;let cancelled=false;const url=URL.createObjectURL(photo.image),img=new Image();img.onload=()=>{if(!cancelled)setImage(img);};img.src=url;return()=>{cancelled=true;URL.revokeObjectURL(url);};},[photo?.image]);
  return image;
}
export function PhotoImage({photo,...props}:{photo:PhotoAsset}&React.ImgHTMLAttributes<HTMLImageElement>){const image=usePhotoImage(photo);return image?<img {...props} src={image.src} />:<div className="image-loading">正在读取照片…</div>;}
