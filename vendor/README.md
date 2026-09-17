# Vendored browser libraries

These files are copied verbatim from npm so the site is self-contained on GitHub Pages
and pinned to known-good versions. Do not edit them by hand.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `mediapipe-tasks-vision-1.0.1.mjs` | `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 |
| `face-api-1.7.15.esm.js` | `@vladmandic/face-api` (bundles TensorFlow.js) | 1.7.15 | MIT |
| `supabase-js-2.116.0.umd.js` | `@supabase/supabase-js` | 2.116.0 | MIT |

The heavy assets (MediaPipe WASM runtime, face-api model weights, MediaPipe `.task`
and `.tflite` models) are loaded from the pinned CDN URLs listed in
`assets/js/config.js`. Point those URLs at your own copies if you want to self-host.

To upgrade, install the new version with npm and copy the same dist files here,
then update the version in `config.js` (the WASM runtime must match the bundle).
