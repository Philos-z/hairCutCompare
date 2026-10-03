import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { createProject, emptyContours, type PhotoAsset, type SavedEntry } from '../core/types';
import { deleteEntry, listEntries, saveEntry } from './storage';

function entry(id: string, kind: SavedEntry['kind'] = 'project'): SavedEntry {
  const original = new Blob(['original image bytes'], { type: 'image/jpeg' });
  const image = new Blob(['oriented image bytes'], { type: 'image/jpeg' });
  const p: PhotoAsset = {
    id: 'reference', name: '照片', original, image, sourceMime: 'image/jpeg', width: 80, height: 100,
    originalWidth: 800, originalHeight: 1000, anchors: [], contours: emptyContours(),
    analysis: { status: 'idle', provider: 'none', version: '1', warnings: [] }, annotationRevision: 0,
  };
  return {
    id, name: id, kind, createdAt: '2026-10-03T10:00:00.000Z',
    project: { ...createProject(), photos: [p], referenceId: p.id, name: '本地项目' },
  };
}

describe('native IndexedDB persistence', () => {
  it('saves original blobs and takes a snapshot of editable annotations', async () => {
    const input = entry('saved-project');
    await saveEntry(input);
    input.project.notes = 'changed after save';
    input.project.photos[0].contours.outer.push({ x: .5, y: .2 });
    const found = (await listEntries()).find(e => e.id === input.id)!;
    expect(found.project.notes).toBe('');
    expect(found.project.photos[0].contours.outer).toEqual([]);
    expect(await found.project.photos[0].original.text()).toBe('original image bytes');
    expect(await found.project.photos[0].image.text()).toBe('oriented image bytes');
    await deleteEntry(input.id);
  });

  it('updates atomically, lists newest first and deletes entries', async () => {
    const first = entry('first'), second = entry('second');
    second.createdAt = '2026-10-03T11:00:00.000Z';
    await saveEntry(first);
    await saveEntry(second);
    first.project.notes = 'updated';
    await saveEntry(first);
    const saved = (await listEntries()).filter(e => ['first', 'second'].includes(e.id));
    expect(saved.map(e => e.id)).toEqual(['second', 'first']);
    expect(saved[1].project.notes).toBe('updated');
    await deleteEntry('first');
    expect((await listEntries()).some(e => e.id === 'first')).toBe(false);
    await deleteEntry('second');
  });

  it('supports a named baseline and rejects a baseline containing two photos', async () => {
    const baseline = entry('short-hair', 'baseline');
    await saveEntry(baseline);
    expect((await listEntries()).find(e => e.id === baseline.id)?.kind).toBe('baseline');
    baseline.project.photos.push({ ...baseline.project.photos[0], id: 'current' });
    await expect(saveEntry(baseline)).rejects.toThrow('只能包含一张');
    await deleteEntry(baseline.id);
  });

  it('explains quota failures and leaves existing saved entries intact', async () => {
    const existing = entry('quota-existing');
    await saveEntry(existing);
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('disk full', 'QuotaExceededError');
    });
    try {
      await expect(saveEntry(entry('quota-new'))).rejects.toThrow('本地空间不足');
    } finally { spy.mockRestore(); }
    const entries = await listEntries();
    expect(entries.some(e => e.id === 'quota-existing')).toBe(true);
    expect(entries.some(e => e.id === 'quota-new')).toBe(false);
    await deleteEntry(existing.id);
  });
});
