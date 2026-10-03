import type { ComparisonProject, PhotoAsset, SavedEntry } from '../core/types';
import { validateProject } from './projectFile';

const DATABASE_NAME = 'haircut-compare';
const DATABASE_VERSION = 1;
const STORE = 'entries';
let databasePromise: Promise<IDBDatabase> | undefined;
interface StoredImage { bytes: ArrayBuffer; type: string }
type StoredPhoto = Omit<PhotoAsset, 'original' | 'image'> & { original: StoredImage | Blob; image: StoredImage | Blob };
type StoredEntry = Omit<SavedEntry, 'project'> & { project: Omit<ComparisonProject, 'photos'> & { photos: StoredPhoto[] } };

function restoreImage(image: StoredImage | Blob): Blob {
  if (image instanceof Blob) return image; // Read older records saved by browsers supporting direct Blob storage.
  if (!image || !(image.bytes instanceof ArrayBuffer) || typeof image.type !== 'string') {
    throw new Error('本地照片数据不完整，请使用已导出的项目文件恢复。');
  }
  return new Blob([image.bytes], { type: image.type });
}

function storageError(error: unknown): Error {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return new Error('浏览器本地空间不足，请导出项目备份并删除旧项目，再尝试保存。');
  if (name === 'SecurityError' || name === 'InvalidStateError') return new Error('浏览器禁止本地保存。请退出隐私浏览，或允许此网站使用本地存储；也可以导出项目文件。');
  return new Error('本地存储失败，请重试；关闭页面前建议导出项目文件备份。');
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('此浏览器不支持本地数据库，请使用项目文件导出备份。'));
      return;
    }
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onerror = () => { settled = true; reject(storageError(request.error)); };
    request.onblocked = () => {
      settled = true;
      reject(new Error('另一个页面正在使用旧版本数据库，请关闭此应用的其他标签页后重试。'));
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      const db = request.result;
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
  });
  databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(STORE, mode); } catch (error) { reject(storageError(error)); return; }
    let result: T;
    let failed = false;
    tx.oncomplete = () => { if (!failed) resolve(result); };
    tx.onerror = () => { failed = true; reject(storageError(tx.error)); };
    tx.onabort = () => { failed = true; reject(storageError(tx.error)); };
    try {
      const request = operation(tx.objectStore(STORE));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { failed = true; reject(storageError(request.error)); };
    } catch (error) {
      failed = true;
      tx.abort();
      reject(storageError(error));
    }
  });
}

export async function listEntries(): Promise<SavedEntry[]> {
  const entries = await transaction<StoredEntry[]>('readonly', store => store.getAll());
  const restored: SavedEntry[] = entries.map(entry => ({ ...entry, project: { ...entry.project, photos: entry.project.photos.map(photo => ({
    ...photo, original: restoreImage(photo.original), image: restoreImage(photo.image),
  })) } }));
  return restored.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveEntry(entry: SavedEntry): Promise<void> {
  if (!entry.id || entry.id.length > 128 || !entry.name.trim() || entry.name.length > 240 ||
      !['baseline', 'project'].includes(entry.kind) || !Number.isFinite(Date.parse(entry.createdAt))) {
    throw new Error('保存名称或项目标识无效。');
  }
  validateProject(entry.project);
  if (entry.kind === 'baseline' && (entry.project.photos.length !== 1 || entry.project.referenceId !== entry.project.photos[0].id)) {
    throw new Error('命名基准只能包含一张喜欢的照片。');
  }
  // Some Safari/WebKit contexts fail asynchronous IDB Blob writes. Store exact binary bytes instead;
  // create every buffer before starting the transaction, so Safari cannot auto-close an idle transaction.
  const photos: StoredPhoto[] = [];
  for (const photo of entry.project.photos) {
    const original: StoredImage = { bytes: await photo.original.arrayBuffer(), type: photo.original.type };
    const image = photo.original === photo.image ? original : { bytes: await photo.image.arrayBuffer(), type: photo.image.type };
    photos.push({ ...photo, original, image });
  }
  const stored: StoredEntry = { ...entry, project: { ...entry.project, photos } };
  await transaction('readwrite', store => store.put(stored));
}

export async function deleteEntry(id: string): Promise<void> {
  if (!id || id.length > 128) throw new Error('项目标识无效。');
  await transaction('readwrite', store => store.delete(id));
}
