import { describe, expect, it } from 'vitest';
import { createProject, emptyContours, type ComparisonProject, type PhotoAsset } from '../core/types';
import { deserializeProject, serializeProject, validateProject } from './projectFile';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=';
function photo(id: string): PhotoAsset {
  const blob = new Blob([Uint8Array.from(atob(PNG), c => c.charCodeAt(0))], { type: 'image/png' });
  return {
    id, name: '正面照片', original: blob, image: blob, width: 1, height: 1, originalWidth: 1, originalHeight: 1,
    sourceMime: 'image/png', anchors: [{ id: 'nose', label: '鼻尖', point: { x: .5, y: .5 } }],
    contours: { ...emptyContours(), outer: [{ x: .2, y: .2 }, { x: .8, y: .2 }] },
    analysis: { status: 'manual', provider: 'manual', version: '1', warnings: [] }, annotationRevision: 2,
  };
}
function project(): ComparisonProject {
  return { ...createProject(), name: '喜欢的短发', photos: [photo('reference'), photo('current')], referenceId: 'reference', referenceConfirmed: true, alignmentConfirmed: true, notes: '先修刘海。' };
}
async function changeFile(change: (payload: any) => void): Promise<Blob> {
  const payload = JSON.parse(await (await serializeProject(project())).text());
  change(payload);
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}
const provenance = () => ({
  contractVersion: 1, coordinateSpace: 'oriented-image-normalized',
  inputSize: { width: 1, height: 1 }, inferenceSize: { width: 256, height: 256 },
  confidence: { face: 'detected', hairMean: .83, hairThreshold: .5, contours: 'candidate', calibrated: false },
});

describe('portable project file', () => {
  it('round-trips original bytes, analysis bytes, annotations and display settings', async () => {
    const input = project();
    input.display.currentContour = true;
    input.display.photoOpacity = .65;
    const file = await serializeProject(input);
    const result = await deserializeProject(file);
    expect(result.id).toBe(input.id);
    expect(result.name).toBe('喜欢的短发');
    expect(result.notes).toBe(input.notes);
    expect(result.display).toEqual(input.display);
    expect(result.photos[0].anchors).toEqual(input.photos[0].anchors);
    expect(result.photos[0].contours).toEqual(input.photos[0].contours);
    expect(result.photos[0].annotationRevision).toBe(2);
    expect(result.photos[0].original.type).toBe('image/png');
    expect(new Uint8Array(await result.photos[0].original.arrayBuffer())).toEqual(new Uint8Array(await input.photos[0].original.arrayBuffer()));
    expect(await result.photos[0].image.arrayBuffer()).toEqual(await input.photos[0].image.arrayBuffer());
  });

  it('preserves a single-photo named baseline', async () => {
    const input = project();
    input.photos = [input.photos[0]];
    input.alignmentConfirmed = false;
    const result = await deserializeProject(await serializeProject(input));
    expect(result.photos).toHaveLength(1);
    expect(result.referenceId).toBe('reference');
  });

  it('rejects invalid JSON, unsupported versions and missing reference IDs', async () => {
    await expect(deserializeProject(new Blob(['broken']))).rejects.toThrow('无法解析 JSON');
    await expect(deserializeProject(await changeFile(p => { p.projectVersion = 3; }))).rejects.toThrow('v1 项目文件');
    await expect(deserializeProject(await changeFile(p => { p.project.referenceId = 'absent'; }))).rejects.toThrow('标识不存在');
  });

  it('rejects duplicate IDs, coordinates outside the image and invalid dimensions', async () => {
    await expect(deserializeProject(await changeFile(p => { p.project.photos[1].id = 'reference'; }))).rejects.toThrow('照片标识重复');
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].contours.outer[0].x = -1; }))).rejects.toThrow('横坐标');
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].width = 90000; }))).rejects.toThrow('宽度');
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].anchors.push(p.project.photos[0].anchors[0]); }))).rejects.toThrow('锚点标识重复');
  });

  it('rejects altered image bytes, malformed base64 and oversized claimed media', async () => {
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].original.data = 'j' + p.project.photos[0].original.data.slice(1); }))).rejects.toThrow('照片校验失败');
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].image.data = '!!'; }))).rejects.toThrow('照片编码损坏');
    await expect(deserializeProject(await changeFile(p => { p.project.photos[0].original.size = 30 * 1024 * 1024; }))).rejects.toThrow('数据大小');
  });

  it('rejects fake raster content before writing an export', async () => {
    const input = project();
    input.photos[0].image = new Blob(['<svg />'], { type: 'image/png' });
    await expect(serializeProject(input)).rejects.toThrow('仅支持');
  });

  it('validates local storage payloads, including blob and view types', () => {
    expect(() => validateProject({ ...project(), view: 'back' })).toThrow('视角');
    const input = project();
    input.photos[0].image = {} as Blob;
    expect(() => validateProject(input)).toThrow('照片数据缺失');
  });

  it('round-trips optional algorithm provenance while retaining older v1 file compatibility', async () => {
    const older = await deserializeProject(await serializeProject(project()));
    expect(older.photos[0].analysis).not.toHaveProperty('provenance');
    const restored = await deserializeProject(await changeFile(p => {
      p.project.photos[0].analysis.provenance = provenance();
    }));
    expect(restored.photos[0].analysis).toHaveProperty('provenance', provenance());
    const again = await deserializeProject(await serializeProject(restored));
    expect(again.photos[0].analysis).toHaveProperty('provenance', provenance());
  });

  it('rejects unsupported algorithm coordinate spaces and contract versions', async () => {
    await expect(deserializeProject(await changeFile(p => {
      p.project.photos[0].analysis.provenance = { ...provenance(), coordinateSpace: 'raw-pixel' };
    }))).rejects.toThrow('算法坐标系');
    await expect(deserializeProject(await changeFile(p => {
      p.project.photos[0].analysis.provenance = { ...provenance(), contractVersion: 2 };
    }))).rejects.toThrow('算法契约版本');
  });

  it('rejects confidence values outside [0,1], invalid enums and unsupported calibrated claims', async () => {
    for (const [key, value, error] of [
      ['hairMean', -.01, '平均置信值'], ['hairThreshold', 1.01, '置信阈值'],
      ['face', 'certain', '面部检测状态'], ['contours', 'precise', '轮廓置信状态'],
      ['calibrated', true, '尚未标定'],
    ] as const) {
      await expect(deserializeProject(await changeFile(p => {
        const metadata = provenance();
        p.project.photos[0].analysis.provenance = { ...metadata, confidence: { ...metadata.confidence, [key]: value } };
      }))).rejects.toThrow(error);
    }
    await expect(deserializeProject(await changeFile(p => {
      p.project.photos[0].analysis.provenance = { ...provenance(), inferenceSize: { width: 0, height: 256 } };
    }))).rejects.toThrow('算法图像宽度');
  });
});
