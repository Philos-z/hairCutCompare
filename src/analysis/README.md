# Local photo analysis

`analyzePhoto(photo)` / `analyzeImage(input)` run Face Landmarker and HairSegmenter in one serial Worker. Use `resetAnalysis()` before an explicit retry after a timeout/initialization failure; it terminates active inference and discards the Blob result cache. Never run synchronous detection on the main thread.

The normalized output coordinate system belongs to the direction-corrected input Blob. MediaPipe's `leftEye` and `rightEye` adapter names mean **image left and right**, not anatomical left and right. Head pose is an estimate derived from the canonical-face transformation matrix; landmark z is not interpreted as physical depth.

The binary hair mask is confidence-thresholded (0.55), reduced to its largest connected component, and converted into an editable silhouette candidate. Fringe extraction retains a continuous visible lower edge between the eyes, without bridging undetected gaps. Sideburn candidates use visible lateral hair only. These heuristic region names require manual review; the hair-only model does not semantically classify bangs or sideburns. An absent boundary stays empty.

Assets are served only from `public/models/` and `public/vendor/mediapipe/`. `npm run models:prepare` verifies the checked-in SHA256 lock, downloading only missing official version-1 models and copying byte-identical installed tasks-vision 0.10.32 WASM files. Normal setup rejects modified files. The `--record-baseline` option is only for the initial maintainer-reviewed lock creation, not ordinary installation.

Production uses Vite's classic/IIFE Worker and native `importScripts`. Vite's development server forces module Workers, so the Worker includes a development compatibility loader: it evaluates only same-origin `/vendor/mediapipe/` scripts in classic function scope. This is necessary for Emscripten's classic-loader semantics, is never a user-supplied script path, and is not a runtime CDN. Strict-CSP deployments should use the production build (no eval branch).

Supported-worker capabilities: OffscreenCanvas, createImageBitmap, WebGL2. Model downloads happen only at preparation; the browser loads same-origin bundled assets. Missing capability, initialization errors, and 45-second timeout preserve manual editing. CPU is the inference delegate; MediaPipe may still use WebGL for pixel conversion/segmentation postprocessing.

Verified with project-local Chromium and WebKit in both Vite dev and a production IIFE build using an official Google sample portrait (temporary fixture, not retained). Both returned four anchors, matrix pose, and silhouette candidates. This verifies plumbing, not haircut measurement accuracy or iPhone hardware performance.

Primary API references:

- https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js
- https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter/web_js
- https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter/index

## Provenance and confidence

Successful inference returns `provenance` with coordinate contract version 1, direction-corrected input dimensions, and the dimensions actually sent to inference (long edge at most 1280px). These sizes describe an aspect-preserving resize, not a crop or a perspective warp; use normalized points with the asset's explicitly saved original/working dimensions for pixel mapping.

`confidence.face` reports whether one detectable face yielded the four visible anchors, without fabricating a numeric face score. `hairMean` is the mean raw hair confidence over model-winning hair pixels, including winning hair below the 0.55 extraction threshold; it is not restricted to already accepted silhouette pixels. Missing/mismatched confidence maps remain unavailable. `hairThreshold` records the applied threshold when a confidence map exists. `contours: candidate` explicitly requires human review. `calibrated: false` means these confidence values have not been validated as probabilities of haircut measurement correctness.

## Physical iPhone validation still required

Playwright mobile Safari uses desktop WebKit with mobile viewport/touch/device settings. It does not establish iPhone CPU speed, iOS memory limits, thermal behavior, camera/file-picker behavior, or iOS-specific HEIC/HDR decoding.

On an actual iPhone, test a trusted HTTPS local origin, first model load, repeated JPEG/HEIC photo imports, two large photos in one project, model initialization under memory pressure, background/foreground resumption, touch editing/scrolling, exported downloads, and IndexedDB persistence after closing Safari. OffscreenCanvas/WebGL2 unavailability is expected to fall back to manual processing, even though CPU is the model inference delegate. The browser still uses graphics resources for MediaPipe's texture conversion and segmentation postprocessing. Original image decoding happens before model inference, so manual inference fallback alone cannot prevent a very large photo from exhausting browser memory.
