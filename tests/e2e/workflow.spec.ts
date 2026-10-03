import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function demo(page:Page) {
  await page.goto('/');
  await page.getByRole('button',{name:'体验示意图',exact:true}).click();
  await expect(page.getByText('已确认，可查看 2D 投影指标')).toBeVisible();
  const toast=page.getByRole('button',{name:'关闭提示',exact:true});
  if(await toast.isVisible())await toast.click();
}
async function portable(page:Page) {
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'项目文件',exact:true}).click();
  const path=await (await pending).path();
  return JSON.parse(await readFile(path!,'utf8')).project;
}
async function transform(page:Page,project:unknown) {
  return page.evaluate(async project=>{
    const path='/src/core/geometry.ts';
    const {registerPhotos}=await import(path);
    const p=project as {photos:{id:string}[];referenceId:string};
    return registerPhotos(p.photos.find(photo=>photo.id===p.referenceId),p.photos.find(photo=>photo.id!==p.referenceId));
  },project);
}
async function dragPoint(page:Page,card:number,mode:'轮廓'|'锚点') {
  await page.locator('.photo-card').nth(card).getByRole('button',{name:mode,exact:true}).click();
  const dialog=page.getByRole('dialog');
  const circle=dialog.locator('svg circle').nth(mode==='轮廓'?3:2);
  await circle.scrollIntoViewIfNeeded();
  const box=await circle.boundingBox();expect(box).not.toBeNull();
  const x=box!.x+box!.width/2,y=box!.y+box!.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+14,y+9,{steps:6});await page.mouse.up();
  await dialog.getByRole('button',{name:'应用修改',exact:true}).click();
}

test('step changes redraw the photo and current hair edits preserve facial registration',async({page})=>{
  await demo(page);
  const samples=()=>page.locator('canvas').evaluate((canvas:HTMLCanvasElement)=>{
    const ctx=canvas.getContext('2d')!;
    return [[.5,.5],[.5,.75],[.3,.3]].flatMap(([x,y])=>Array.from(ctx.getImageData(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1).data));
  });
  const rendered=await samples();
  await page.getByRole('button',{name:'确认轮廓',exact:true}).click();
  await page.getByRole('button',{name:'确认轮廓，开始对比',exact:true}).click();
  await expect.poll(samples).toEqual(rendered);
  const before=await portable(page),beforeTransform=await transform(page,before);
  await dragPoint(page,1,'轮廓');
  const after=await portable(page);
  expect(after.photos[1].contours).not.toEqual(before.photos[1].contours);
  expect(after.photos[1].anchors).toEqual(before.photos[1].anchors);
  expect(after.photos[0].contours).toEqual(before.photos[0].contours);
  expect(after.alignmentConfirmed).toBe(true);
  expect(await transform(page,after)).toEqual(beforeTransform);
  await expect(page.getByText('已确认，可查看 2D 投影指标')).toBeVisible();
  await dragPoint(page,1,'锚点');
  const moved=await portable(page);
  expect(moved.alignmentConfirmed).toBe(false);
  expect(await transform(page,moved)).not.toEqual(beforeTransform);
  await expect(page.locator('.metrics-list')).toHaveCount(0);
});

test('favorite edits and favorite switching require a new contour confirmation',async({page})=>{
  await demo(page);
  const before=await portable(page);
  await dragPoint(page,0,'轮廓');
  const edited=await portable(page);
  expect(edited.referenceConfirmed).toBe(false);
  expect(edited.photos[0].contours).not.toEqual(before.photos[0].contours);
  expect(await transform(page,edited)).toEqual(await transform(page,before));
  await expect(page.getByRole('heading',{name:'确认你喜欢的发型轮廓'})).toBeVisible();
  await page.getByRole('button',{name:'确认轮廓，开始对比',exact:true}).click();
  await page.locator('.photo-card').nth(1).getByRole('button',{name:'标记喜欢',exact:true}).click();
  const switched=await portable(page);
  expect(switched.referenceId).toBe(before.photos[1].id);
  expect(switched.referenceConfirmed).toBe(false);expect(switched.alignmentConfirmed).toBe(false);
  await expect(page.getByRole('heading',{name:'确认你喜欢的发型轮廓'})).toBeVisible();
});

test('PNG includes both contour layers, status and notes even while inspecting the original',async({page})=>{
  await demo(page);
  const notes='长备注验证：两侧保留弧度，刘海参照绿色线。'.repeat(24)+'备注末尾必须完整导出。';
  await page.getByPlaceholder('例如：两侧更贴合绿色轮廓，刘海保留到参考线…').fill(notes);
  const title='完整长标题验证'.repeat(10);
  await page.getByRole('button',{name:'保存项目',exact:true}).click();
  await page.getByRole('dialog').getByLabel('名称',{exact:true}).fill(title);
  await page.getByRole('button',{name:'保存到此浏览器',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('switch',{name:/显示当前轮廓/}).check();
  await page.getByRole('button',{name:'查看原图',exact:true}).click();
  await page.evaluate(()=>{
    const original=CanvasRenderingContext2D.prototype.fillText;
    (window as unknown as {exportText:string[]}).exportText=[];
    CanvasRenderingContext2D.prototype.fillText=function(text:string,x:number,y:number,maxWidth?:number){
      (window as unknown as {exportText:string[]}).exportText.push(text);
      if(maxWidth===undefined)original.call(this,text,x,y);else original.call(this,text,x,y,maxWidth);
    };
  });
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'导出对比图片',exact:true}).click();
  const download=await pending;
  expect(download.suggestedFilename()).toMatch(/\.png$/);
  const bytes=await readFile((await download.path())!);
  const pixels=await page.evaluate(async data=>{
    const img=new Image();img.src=data;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
    const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
    const imageHeight=Math.round(img.width*900/720),values=ctx.getImageData(0,0,img.width,imageHeight).data;
    let green=0,orange=0;
    for(let i=0;i<values.length;i+=4){if(values[i]===21&&values[i+1]===148&&values[i+2]===100)green++;if(values[i]===215&&values[i+1]===138&&values[i+2]===62)orange++;}
    return {width:img.width,height:img.height,imageHeight,green,orange,text:(window as unknown as {exportText:string[]}).exportText};
  },`data:image/png;base64,${bytes.toString('base64')}`);
  expect(pixels.green).toBeGreaterThan(100);expect(pixels.orange).toBeGreaterThan(100);
  expect(pixels.height).toBeGreaterThan(pixels.imageHeight+100);
  expect(pixels.text.join('')).toContain(notes);expect(pixels.text.join('')).toContain(title);expect(pixels.text.join('')).toContain('可量化');
  expect(pixels.text.join('')).toContain('投影宽度');
  await expect(page.getByRole('button',{name:'返回校正',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('profile calibration can omit an occluded eye and use three visible anchors',async({page})=>{
  await demo(page);const before=await transform(page,await portable(page));
  for(const index of [0,1]){
    await page.locator('.photo-card').nth(index).getByRole('button',{name:'锚点',exact:true}).click();
    await page.getByRole('button',{name:'移除画面左眼锚点',exact:true}).click();
    await expect(page.getByRole('dialog').locator('.editor-photo svg text')).toHaveCount(3);
    await page.getByRole('button',{name:'应用修改',exact:true}).click();
  }
  const project=await portable(page),after=await transform(page,project);
  expect(project.photos[0].anchors).toHaveLength(3);expect(project.photos[1].anchors).toHaveLength(3);
  for(const key of ['a','b','tx','ty'])expect(after[key]).toBeCloseTo(before[key],7);
  await page.getByLabel('已检查双方轮廓和面部对齐，转头、仰俯和拍摄距离接近').check();
  await expect(page.getByText('已确认，可查看 2D 投影指标')).toBeVisible();
});

test('large pose mismatch shows the reference photo and suppresses measurements',async({page})=>{
  await demo(page);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'项目文件',exact:true}).click();
  const file=JSON.parse(await readFile((await (await pending).path())!,'utf8'));
  file.project.photos[1].pose={yaw:35,pitch:0,roll:5};
  await page.locator('input[type="file"][accept=".json,.haircompare.json"]').setInputFiles({name:'姿态门控.haircompare.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(file))});
  await expect(page.getByText('建议重拍',{exact:true})).toBeVisible();
  await expect(page.getByRole('img',{name:'重拍时参考的喜欢照片',exact:true})).toBeVisible();
  await expect(page.locator('.metrics-list')).toHaveCount(0);
  await expect(page.getByLabel('已检查双方轮廓和面部对齐，转头、仰俯和拍摄距离接近')).toBeDisabled();
});

test('AI requires consent and an explicit click; service failure preserves local measurements',async({page})=>{
  const requests:string[]=[];
  await page.route('**/ai-proxy/v1/comparison-assistance',route=>{requests.push(route.request().postData()!);return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({detail:'测试中的离线服务'})});});
  await demo(page);
  const metrics=await page.locator('.metrics-list').innerText();
  await page.getByRole('button',{name:/AI 辅助说明/}).click();
  await expect(page.getByRole('dialog',{name:'AI 辅助设置'})).toBeVisible();expect(requests).toHaveLength(0);
  await page.getByLabel('我同意主动调用时发送选定头部图片到该服务和 OpenAI。').check();
  await page.getByRole('button',{name:'完成设置',exact:true}).click();expect(requests).toHaveLength(0);
  await page.getByRole('button',{name:/AI 辅助说明/}).click();
  await expect(page.getByRole('alert')).toBeVisible();expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0]).metrics[0].projection).toBeDefined();
  expect(await page.locator('.metrics-list').innerText()).toBe(metrics);
  await expect(page.getByText('已确认，可查看 2D 投影指标')).toBeVisible();
});

test('touch pointer tracing uses image coordinates and keeps facial anchors fixed',async({page})=>{
  await demo(page);const before=await portable(page);
  await page.locator('.photo-card').nth(1).getByRole('button',{name:'轮廓',exact:true}).click();
  await page.getByRole('button',{name:'重新描线',exact:true}).click();
  await page.getByRole('dialog').locator('.editor-photo > svg').evaluate((svg:SVGSVGElement)=>{
    // Playwright WebKit has no native touch-drag API. Dispatch touch PointerEvents
    // through the same handlers; physical gesture/capture remains a device check.
    svg.setPointerCapture=()=>{};
    const rect=svg.getBoundingClientRect(),point=(x:number,y:number)=>({clientX:rect.x+rect.width*x,clientY:rect.y+rect.height*y,pointerId:7,pointerType:'touch',isPrimary:true,bubbles:true});
    svg.dispatchEvent(new PointerEvent('pointerdown',point(.28,.5)));
    for(const [x,y] of [[.27,.35],[.33,.23],[.5,.18],[.66,.23],[.74,.35],[.73,.5]])svg.dispatchEvent(new PointerEvent('pointermove',point(x,y)));
    svg.dispatchEvent(new PointerEvent('pointerup',point(.73,.5)));
  });
  await page.getByRole('button',{name:'应用修改',exact:true}).click();
  const after=await portable(page);
  expect(after.photos[1].contours.outer).toHaveLength(7);
  expect(after.photos[1].contours.outer[0].x).toBeCloseTo(.28);
  expect(after.photos[1].anchors).toEqual(before.photos[1].anchors);
  expect(await transform(page,after)).toEqual(await transform(page,before));
  await page.locator('.photo-card').nth(1).getByRole('button',{name:'轮廓',exact:true}).click();
  await page.getByRole('dialog').locator('.editor-photo > svg').evaluate((svg:SVGSVGElement)=>{
    svg.setPointerCapture=()=>{};
    const rect=svg.getBoundingClientRect(),x=rect.x+rect.width*.28+12,y=rect.y+rect.height*.5;
    const pointer={pointerId:8,pointerType:'touch',isPrimary:true,bubbles:true};
    svg.dispatchEvent(new PointerEvent('pointerdown',{...pointer,clientX:x,clientY:y}));
    svg.dispatchEvent(new PointerEvent('pointermove',{...pointer,clientX:x,clientY:y+18}));
    svg.dispatchEvent(new PointerEvent('pointerup',{...pointer,clientX:x,clientY:y+18}));
  });
  await page.getByRole('button',{name:'应用修改',exact:true}).click();
  const adjusted=await portable(page);
  expect(adjusted.photos[1].contours.outer[0]).not.toEqual(after.photos[1].contours.outer[0]);
  expect(adjusted.photos[1].anchors).toEqual(before.photos[1].anchors);
});
