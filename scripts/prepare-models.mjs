import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';

// Explicit upstream versions. Never use a runtime CDN or an upstream `latest` URL.
const version = '0.10.32';
const models = [
  { name: 'face_landmarker.task', url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
  { name: 'hair_segmenter.tflite', url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/1/hair_segmenter.tflite' },
];
const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'public/models/assets.lock.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function writeIfDifferent(path, bytes) {
  try {
    const current = await readFile(path);
    if (current.equals(bytes)) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(path, bytes);
}
let manifest;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!manifest && !process.argv.includes('--record-baseline')) throw new Error('No model lock manifest. Initial maintainer setup requires --record-baseline; normal setup must verify the checked-in manifest.');
if (manifest && manifest.tasksVisionVersion !== version) throw new Error('tasks-vision version differs from the lock manifest.');
await mkdir(resolve(root, 'public/models'), { recursive: true });
await mkdir(resolve(root, 'public/vendor/mediapipe'), { recursive: true });
const entries = [];
for (const model of models) {
  const path = resolve(root, 'public/models', model.name);
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetch(model.url);
    if (!response.ok) throw new Error(`${model.name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = hash(bytes);
  const locked = manifest?.assets.find(asset => asset.path === `models/${model.name}`);
  if (manifest && (!locked || locked.sha256 !== sha256 || locked.url !== model.url)) throw new Error(`Integrity verification failed: ${model.name}`);
  await writeIfDifferent(path, bytes);
  entries.push({ path: `models/${model.name}`, url: model.url, bytes: bytes.length, sha256 });
  console.log(`Verified ${model.name} (${bytes.length} bytes, ${sha256})`);
}
const packageRoot = resolve(root, 'node_modules/@mediapipe/tasks-vision');
const packageJSON = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (packageJSON.version !== version) throw new Error(`Expected tasks-vision ${version}, received ${packageJSON.version}`);
for (const name of (await readdir(resolve(packageRoot, 'wasm'))).filter(name => /\.(js|wasm)$/.test(name))) {
  const bytes = await readFile(resolve(packageRoot, 'wasm', name));
  const path = `vendor/mediapipe/${basename(name)}`;
  const sha256 = hash(bytes);
  const locked = manifest?.assets.find(asset => asset.path === path);
  if (manifest && (!locked || locked.sha256 !== sha256)) throw new Error(`Integrity verification failed: ${name}`);
  await writeIfDifferent(resolve(root, 'public', path), bytes);
  entries.push({ path, bytes: bytes.length, sha256 });
}
if (!manifest) {
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, tasksVisionVersion: version, assets: entries }, null, 2) + '\n');
  console.log('Recorded initial baseline. Review and commit assets.lock.json with the bundled assets.');
} else console.log(`Verified ${entries.length} same-origin assets against the checked-in lock.`);
