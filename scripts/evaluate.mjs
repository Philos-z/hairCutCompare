import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const engine = option('--browser', 'chromium');
if (!['chromium', 'webkit'].includes(engine)) throw new Error('--browser must be chromium or webkit');
const baseURL = new URL(option('--base-url', 'http://127.0.0.1:5173'));
if (!['http:', 'https:'].includes(baseURL.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(baseURL.hostname)) {
  throw new Error('Evaluation only accepts a local localhost/127.0.0.1 server. No cloud image uploads are performed.');
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(resolve(root, '.browsers'))) process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, '.browsers');
const { chromium, webkit } = await import('@playwright/test');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = resolve(root, 'tests/fixtures/white-house-portrait.jpg');
const source = await readFile(sourcePath);
const lock = JSON.parse(await readFile(resolve(root, 'public/models/assets.lock.json'), 'utf8'));
for (const asset of lock.assets) {
  const bytes = await readFile(resolve(root, 'public', asset.path));
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error(`Model/WASM lock mismatch: ${asset.path}`);
}
const cases = [
  { id: 'baseline', label: 'Baseline, identical content, common JPEG encoding', scale: 1, roll: 0, shiftX: 0, shiftY: 0, exposure: 1 },
  { id: 'roll-translation', label: 'Canvas +8 degree roll and (+20,-10) pixel translation', scale: 1, roll: 8, shiftX: 20, shiftY: -10, exposure: 1 },
  { id: 'framing-mild', label: 'Canvas 0.82 framing; no real camera-distance or perspective change', scale: .82, roll: 0, shiftX: 0, shiftY: 0, exposure: 1 },
  { id: 'framing-large', label: 'Canvas 0.58 framing; no real camera-distance or perspective change', scale: .58, roll: 0, shiftX: 0, shiftY: 0, exposure: 1 },
  { id: 'light-mild', label: 'Canvas RGB multiplication 0.80; synthetic lighting', scale: 1, roll: 0, shiftX: 0, shiftY: 0, exposure: .80 },
  { id: 'light-severe-dark', label: 'Canvas RGB multiplication 0.10; synthetic lighting', scale: 1, roll: 0, shiftX: 0, shiftY: 0, exposure: .10 },
  { id: 'light-severe-bright', label: 'Canvas RGB multiplication 4.00 with clipping; synthetic lighting', scale: 1, roll: 0, shiftX: 0, shiftY: 0, exposure: 4 },
  { id: 'simulated-yaw-35', label: 'SIMULATED pose gate: override yaw=35; image and actual head angle unchanged', scale: 1, roll: 0, shiftX: 0, shiftY: 0, exposure: 1, simulatedYaw: 35 },
];
const samplesDir = resolve(root, 'evaluation/samples', engine);
const resultsDir = resolve(root, 'evaluation/results');
await mkdir(samplesDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });
const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
const external = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== baseURL.origin) {
      external.push(url.href);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  await page.goto(baseURL.href, { waitUntil: 'networkidle' });
  const report = await page.evaluate(async ({ sourceBase64, cases }) => {
    const imagePath = '/src/data/images.ts', analysisPath = '/src/analysis/index.ts';
    const corePath = '/src/core/geometry.ts', comparisonPath = '/src/core/comparison.ts', typesPath = '/src/core/types.ts';
    const { loadImage, preparePhoto, canvasBlob } = await import(imagePath);
    const { analyzePhoto, resetAnalysis } = await import(analysisPath);
    const { registerPhotos, transformPoint, toPixel, faceScale } = await import(corePath);
    const { evaluateQuality, compareContours, QUALITY_CONFIG_VERSION } = await import(comparisonPath);
    const { createProject } = await import(typesPath);
    const source = new Blob([Uint8Array.from(atob(sourceBase64), c => c.charCodeAt(0))], { type: 'image/jpeg' });
    const decoded = await loadImage(source), width = decoded.naturalWidth, height = decoded.naturalHeight;
    const rms = values => values.length ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) : null;
    const round = value => value == null ? null : Math.round(value * 1e6) / 1e6;
    const base64 = async blob => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(binary);
    };
    const transformFromCase = variation => {
      const angle = variation.roll * Math.PI / 180;
      const a = variation.scale * Math.cos(angle), b = variation.scale * Math.sin(angle);
      return { a, b, tx: width / 2 + variation.shiftX - a * width / 2 + b * height / 2, ty: height / 2 + variation.shiftY - b * width / 2 - a * height / 2, scale: variation.scale, rotation: angle, residual: 0 };
    };
    const inverse = t => {
      const d = t.a * t.a + t.b * t.b;
      return { a: t.a / d, b: -t.b / d, tx: -(t.a * t.tx + t.b * t.ty) / d, ty: (t.b * t.tx - t.a * t.ty) / d, scale: 1 / t.scale, rotation: -t.rotation, residual: 0 };
    };
    let reference;
    const records = [];
    resetAnalysis();
    try {
      for (const variation of cases) {
        const knownForward = transformFromCase(variation), knownInverse = inverse(knownForward);
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.fillStyle = '#c9c9c9'; ctx.fillRect(0, 0, width, height);
        ctx.setTransform(knownForward.a, knownForward.b, -knownForward.b, knownForward.a, knownForward.tx, knownForward.ty);
        ctx.drawImage(decoded, 0, 0); ctx.resetTransform();
        if (variation.exposure !== 1) {
          const pixels = ctx.getImageData(0, 0, width, height);
          for (let i = 0; i < pixels.data.length; i += 4) for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] *= variation.exposure;
          ctx.putImageData(pixels, 0, 0);
        }
        // Encode every case identically before invoking the actual app preprocessing + CPU Worker.
        const sample = await canvasBlob(canvas, 'image/jpeg', .96);
        const imported = await preparePhoto(sample, `${variation.id}.jpg`);
        const started = performance.now();
        const output = await analyzePhoto(imported), elapsed = performance.now() - started;
        const photo = { ...imported, anchors: output.anchors, contours: output.contours, pose: output.pose, stats: output.stats ?? imported.stats,
          analysis: { status: output.anchors.length || output.contours.outer.length ? 'automatic' : 'failed', provider: output.provider, version: output.version, warnings: output.warnings, provenance: output.provenance } };
        if (!reference) {
          reference = photo;
          if (reference.analysis.provider !== 'mediapipe-cpu-worker' || reference.anchors.length < 3) throw new Error(`Baseline real inference failed: ${output.warnings.join('; ')}`);
        }
        const measuredPose = photo.pose;
        const current = variation.simulatedYaw === undefined ? photo : { ...photo, pose: { yaw: variation.simulatedYaw, pitch: reference.pose?.pitch ?? 0, roll: reference.pose?.roll ?? 0 } };
        const t = registerPhotos(reference, current);
        const project = { ...createProject(), photos: [reference, current], referenceId: reference.id };
        const unconfirmed = evaluateQuality(reference, current, project, t);
        // Research-only opt-in lets us inspect candidate invariance. No human contour review is asserted.
        const confirmed = evaluateQuality(reference, current, { ...project, referenceConfirmed: true, alignmentConfirmed: true }, t);
        const regionalMetrics = t ? compareContours(reference, current, t, confirmed) : [];
        const pairs = reference.anchors.flatMap(anchor => {
          const other = current.anchors.find(value => value.id === anchor.id);
          return other ? [{ id: anchor.id, reference: toPixel(anchor.point, reference), current: toPixel(other.point, current) }] : [];
        });
        const rawDistances = pairs.map(pair => {
          const expected = transformPoint(pair.reference, knownForward);
          return Math.hypot(pair.current.x - expected.x, pair.current.y - expected.y);
        });
        const probeDistances = t ? pairs.map(pair => {
          const expected = transformPoint(pair.reference, knownForward), restored = transformPoint(expected, t);
          return Math.hypot(restored.x - pair.reference.x, restored.y - pair.reference.y);
        }) : [];
        records.push({
          id: variation.id, label: variation.label, operation: variation, dimensions: { width, height },
          simulatedPoseOnly: variation.simulatedYaw !== undefined, actualMeasuredPose: measuredPose ?? null, qualityPose: current.pose ?? null,
          sampleJPEG: await base64(sample), analysisJPEG: await base64(imported.image),
          inferenceMilliseconds: round(elapsed), analysis: photo.analysis, anchors: photo.anchors, contours: photo.contours, stats: photo.stats,
          knownReferenceToCurrent: knownForward, knownCurrentToReference: knownInverse, estimatedCurrentToReference: t,
          errors: {
            matchedAnchorCount: pairs.length, referenceFaceScalePixels: round(faceScale(reference)),
            rawLandmarkReprojectionRMSEPixels: round(rms(rawDistances)),
            registrationProbeRMSEPixels: round(rms(probeDistances)),
            fittingResidualPixels: round(t?.residual),
            scaleError: t ? round(t.scale - knownInverse.scale) : null,
            rotationErrorDegrees: t ? round((t.rotation - knownInverse.rotation) * 180 / Math.PI) : null,
            translationErrorPixels: t ? round(Math.hypot(t.tx - knownInverse.tx, t.ty - knownInverse.ty)) : null,
          },
          qualityUnconfirmed: unconfirmed, qualityWithSimulatedConfirmation: confirmed, regionalMetrics,
        });
      }
      return { records, qualityConfigVersion: QUALITY_CONFIG_VERSION, userAgent: navigator.userAgent };
    } finally { resetAnalysis(); }
  }, { sourceBase64: source.toString('base64'), cases });
  if (external.length) throw new Error(`Blocked unexpected external request(s): ${external.join(', ')}`);
  for (const record of report.records) {
    const sample = Buffer.from(record.sampleJPEG, 'base64'), analysis = Buffer.from(record.analysisJPEG, 'base64');
    await writeFile(resolve(samplesDir, `${record.id}.jpg`), sample);
    await writeFile(resolve(samplesDir, `${record.id}.analysis.jpg`), analysis);
    record.sample = { path: `evaluation/samples/${engine}/${record.id}.jpg`, bytes: sample.length, sha256: hash(sample) };
    record.analysisInput = { path: `evaluation/samples/${engine}/${record.id}.analysis.jpg`, bytes: analysis.length, sha256: hash(analysis) };
    delete record.sampleJPEG; delete record.analysisJPEG;
  }
  const results = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), engine, browserVersion: browser.version(),
    localOrigin: baseURL.origin, userAgent: report.userAgent, qualityConfigVersion: report.qualityConfigVersion,
    source: { path: 'tests/fixtures/white-house-portrait.jpg', width: 820, height: 1024, bytes: source.length, sha256: hash(source), attribution: 'tests/fixtures/ATTRIBUTION.md' },
    modelLock: lock,
    limitations: [
      'One public-domain portrait; eight controlled cases are not eight independent people or physical captures.',
      'All derived geometry uses 2D canvas transforms: no changed head yaw/pitch, camera perspective, lens, or physical lighting.',
      'simulated-yaw-35 only changes metadata to exercise the pose gate; actual pixels/head angle do not change.',
      'qualityWithSimulatedConfirmation and regionalMetrics are research-only automatic candidates, not human-reviewed measurements.',
      'Reprojection metrics compare to the known canvas operation using baseline model landmarks; no independent human ground truth.',
      'Confidence scores are uncalibrated model values, not accuracy probabilities; timing depends on local hardware and first-run model loading.',
      'A physical same-person/same-hair angle, distance, light and style cohort plus manual reference annotations is still required.',
    ],
    externalRequests: external, cases: report.records,
  };
  await writeFile(resolve(resultsDir, `${engine}.json`), JSON.stringify(results, null, 2) + '\n');
  const columns = ['scenario', 'simulated_pose_only', 'inference_ms', 'provider', 'algorithm_version', 'anchors', 'known_scale', 'known_roll_degrees', 'estimated_inverse_scale', 'estimated_inverse_roll_degrees', 'landmark_reprojection_rmse_px', 'registration_probe_rmse_px', 'fit_rmse_px', 'quality_unconfirmed', 'quality_with_simulated_confirmation', 'issue_codes', 'outer_abs_face_percent', 'outer_signed_face_percent', 'fringe_abs_face_percent', 'hair_mean_confidence'];
  const csv = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = report.records.map(record => {
    const outer = record.regionalMetrics.find(metric => metric.kind === 'outer'), fringe = record.regionalMetrics.find(metric => metric.kind === 'fringe');
    return [record.id, record.simulatedPoseOnly, record.inferenceMilliseconds, record.analysis.provider, record.analysis.version, record.anchors.length,
      record.operation.scale, record.operation.roll, record.estimatedCurrentToReference?.scale, record.estimatedCurrentToReference ? record.estimatedCurrentToReference.rotation * 180 / Math.PI : null,
      record.errors.rawLandmarkReprojectionRMSEPixels, record.errors.registrationProbeRMSEPixels, record.errors.fittingResidualPixels,
      record.qualityUnconfirmed.status, record.qualityWithSimulatedConfirmation.status, record.qualityWithSimulatedConfirmation.issues.map(issue => `${issue.code}:${issue.severity}`).join(';'),
      outer?.absoluteOffset, outer?.signedOffset, fringe?.absoluteOffset, record.analysis.provenance?.confidence?.hairMean].map(csv).join(',');
  });
  await writeFile(resolve(resultsDir, `${engine}.csv`), [columns.map(csv).join(','), ...rows].join('\n') + '\n');
  console.log(`Saved ${report.records.length} ${engine} research cases to evaluation/results/${engine}.{json,csv}`);
  for (const record of report.records) console.log(`${record.id}: ${record.qualityWithSimulatedConfirmation.status}, reprojection=${record.errors.rawLandmarkReprojectionRMSEPixels ?? 'unavailable'} px, probe=${record.errors.registrationProbeRMSEPixels ?? 'unavailable'} px, issues=${record.qualityWithSimulatedConfirmation.issues.map(issue => issue.code).join(',') || 'none'}`);
} finally { await browser.close(); }
