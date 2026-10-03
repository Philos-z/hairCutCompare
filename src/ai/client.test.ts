import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, emptyContours } from '../core/types';
import type { ComparisonProject, PhotoAsset, RegionMetric } from '../core/types';
import { getHeadCrop, getInputDigest, requestAdvice, validateAdvice } from './client';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

function photo(id: string): PhotoAsset {
  return {
    id, name: 'Private photo name', original: new Blob(['original']), image: new Blob([`oriented-${id}`]),
    width: 1000, height: 1200, originalWidth: 1000, originalHeight: 1200, sourceMime: 'image/jpeg',
    anchors: [
      { id: 'leftEye', label: '左眼', point: { x: 0.42, y: 0.5 } },
      { id: 'rightEye', label: '右眼', point: { x: 0.58, y: 0.5 } },
      { id: 'nose', label: '鼻尖', point: { x: 0.5, y: 0.57 } },
      { id: 'chin', label: '下巴', point: { x: 0.5, y: 0.67 } },
    ], contours: { ...emptyContours(), outer: [{ x: 0.25, y: 0.35 }, { x: 0.5, y: 0.2 }, { x: 0.75, y: 0.35 }] },
    analysis: { status: 'manual', provider: 'manual', version: '1', warnings: [] }, annotationRevision: 1,
  };
}

function project(): ComparisonProject {
  return { ...createProject(), name: 'Private customer name', photos: [photo('reference'), photo('current')], referenceId: 'reference', notes: 'Private project note' };
}

const metric: RegionMetric = { kind: 'outer', label: '外轮廓', signedOffset: 0, absoluteOffset: 0, referenceScale: 100, unit: 'face-percent', projection: { widthChangePercent: 12.5, heightChangePercent: null } };
const advice = (inputDigest: string) => ({ summary: '当前轮廓的差异需结合本地结果。', qualityIssues: [], regionNotes: [{ metricId: 'outer', text: '外轮廓可见差异。' }], limitations: ['视觉建议不能替代本地测量。'], model: 'pinned-model', inputDigest });

describe('AI evidence version binding', () => {
  it('changes with geometry, reference selection, view, and image but excludes names', async () => {
    const p = project();
    const original = await getInputDigest(p);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
    p.name = 'Different customer';
    p.photos[0].name = 'Renamed file';
    p.updatedAt = 'later';
    expect(await getInputDigest(p)).toBe(original);
    p.photos[1].anchors[0].point.x += 0.01;
    expect(await getInputDigest(p)).not.toBe(original);
    const changedGeometry = await getInputDigest(p);
    p.referenceId = 'current';
    expect(await getInputDigest(p)).not.toBe(changedGeometry);
    const changedReference = await getInputDigest(p);
    p.view = 'left';
    expect(await getInputDigest(p)).not.toBe(changedReference);
    const changedView = await getInputDigest(p);
    p.photos[0].image = new Blob(['different-oriented-image']);
    expect(await getInputDigest(p)).not.toBe(changedView);
  });

  it('invalidates when notes, display, confirmations, or algorithm provenance change', async () => {
    const p = project();
    let previous = await getInputDigest(p);
    const edits = [() => { p.notes += 'changed'; }, () => { p.display.photoOpacity = 0.5; }, () => { p.alignmentConfirmed = true; }, () => { p.photos[1].analysis.version = 'new-model'; }];
    for (const edit of edits) {
      edit();
      const digest = await getInputDigest(p);
      expect(digest).not.toBe(previous);
      previous = digest;
    }
  });

  it('requires an explicit pair', async () => {
    await expect(getInputDigest(createProject())).rejects.toMatchObject({ code: 'missing_pair' });
  });
});

describe('AI privacy and output contract', () => {
  it('crops around the head and includes all annotated hair', () => {
    const p = photo('crop');
    const crop = getHeadCrop(p);
    expect(crop.x).toBeGreaterThan(0);
    expect(crop.y).toBeGreaterThan(0);
    expect(crop.y).toBeLessThan(0.2 * p.height);
    expect(crop.x + crop.width).toBeLessThan(p.width);
    for (const point of p.contours.outer) {
      expect(point.x * p.width).toBeGreaterThanOrEqual(crop.x);
      expect(point.x * p.width).toBeLessThanOrEqual(crop.x + crop.width);
      expect(point.y * p.height).toBeGreaterThanOrEqual(crop.y);
      expect(point.y * p.height).toBeLessThanOrEqual(crop.y + crop.height);
    }
    p.anchors = [];
    p.contours = emptyContours();
    expect(() => getHeadCrop(p)).toThrow('头部区域');
  });

  it('rejects stale replies, nonexistent metrics and geometry overrides', () => {
    expect(validateAdvice(advice('a'.repeat(64)), 'a'.repeat(64), ['outer']).summary).toContain('本地');
    expect(() => validateAdvice(advice('wrong'), 'a'.repeat(64), ['outer'])).toThrow('版本');
    expect(() => validateAdvice(advice('a'.repeat(64)), 'a'.repeat(64), [])).toThrow('不存在');
    expect(() => validateAdvice({ ...advice('a'.repeat(64)), transform: {} }, 'a'.repeat(64), ['outer'])).toThrow('不支持');
  });

  it.each([
    ['http://localhost:8000', 'http://localhost:8000/v1/comparison-assistance'],
    ['https://hair.example/research/api', 'https://hair.example/research/api/v1/comparison-assistance'],
    ['https://hair.example/ai-proxy/', 'https://hair.example/ai-proxy/v1/comparison-assistance'],
    ['/ai-proxy', 'https://hair.example/ai-proxy/v1/comparison-assistance'],
  ])('preserves %s while sending only cropped images and evidence', async (baseUrl, endpoint) => {
    vi.stubGlobal('location', { origin: 'https://hair.example' });
    vi.stubGlobal('Image', class { src = ''; decoding = ''; async decode() {} });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect() {}, drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,aGVhZA==' }) });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const data = JSON.parse(String(init.body));
      return new Response(JSON.stringify(advice(data.inputDigest)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = project();
    const before = JSON.stringify(p.photos.map(x => ({ anchors: x.anchors, contours: x.contours })));
    await requestAdvice(p, { status: 'comparable', issues: [] }, [metric], { baseUrl, token: 'research-token' });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(endpoint);
    expect(request.headers).toMatchObject({ Authorization: 'Bearer research-token' });
    const body = String(request.body);
    expect(body).not.toContain('Private');
    expect(body).not.toContain('original');
    const data = JSON.parse(body);
    expect(data.referenceImage).toMatch(/^data:image\/jpeg/);
    expect(data.currentImage).toMatch(/^data:image\/jpeg/);
    expect(data.captureInfo.reference.pose).toBeNull();
    expect(data.metrics).toEqual([metric]);
    expect(before).toBe(JSON.stringify(p.photos.map(x => ({ anchors: x.anchors, contours: x.contours }))));
  });

  it.each(['', 'file:///tmp/backend', 'https://user:secret@hair.example/ai-proxy', 'https://hair.example/api?token=secret', 'https://hair.example/api#section', '//hair.example/ai-proxy'])('rejects unsafe or ambiguous service address %s without uploading', async baseUrl => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestAdvice(project(), { status: 'retake', issues: [] }, [], { baseUrl })).rejects.toMatchObject({ code: 'invalid_service_url' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors cancellation before preparing or uploading images', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestAdvice(project(), { status: 'retake', issues: [] }, [], { baseUrl: 'http://localhost:8000', signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
