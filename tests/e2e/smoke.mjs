// End-to-end smoke test: runs the real app in headless Chromium with a fake
// camera that shows a photo of a person, and walks through detection,
// enrollment, identification, the alarm and the event log.
//
// Requirements: `npm install` (playwright + the three libraries are resolved from
// node_modules), network access to storage.googleapis.com the first time (the
// MediaPipe models are cached under tests/e2e/.cache), and a Chromium binary
// (set CHROMIUM_PATH if Playwright's own download is not available).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer, MIME } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cache = path.join(here, '.cache');
fs.mkdirSync(cache, { recursive: true });

const LOCAL = {
  wasmDir: process.env.E2E_WASM_DIR || path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm'),
  faceModelDir: process.env.E2E_FACE_MODEL_DIR || path.join(root, 'node_modules/@vladmandic/face-api/model'),
  poseModel: path.join(cache, 'pose_landmarker_lite.task'),
  segModel: path.join(cache, 'selfie_multiclass_256x256.tflite'),
  person: process.env.E2E_SAMPLE_IMAGE || path.join(cache, 'person.jpg'),
};
const REMOTE = {
  poseModel: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  segModel: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  person: 'https://storage.googleapis.com/mediapipe-assets/pose.jpg',
};

async function ensureFile(file, url) {
  if (fs.existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};
const assert = (cond, msg) => (cond ? step(`ok: ${msg}`) : fail(msg));

async function waitFor(page, fn, { timeout = 60000, label = 'condition', interval = 250, arg } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    await page.waitForTimeout(interval);
  }
  throw new Error(`timeout waiting for ${label}`);
}

await Promise.all([
  ensureFile(LOCAL.poseModel, REMOTE.poseModel),
  ensureFile(LOCAL.segModel, REMOTE.segModel),
  ensureFile(LOCAL.person, REMOTE.person),
]);

const { server, url } = await startServer(root, { '/__fixtures__/': cache });
step(`serving ${url}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-web-security',
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
const externalRequests = [];
page.on('request', (r) => {
  if (!r.url().startsWith(url) && !/cdn\.jsdelivr\.net|storage\.googleapis\.com\/mediapipe-models|api\.anthropic\.com/.test(r.url())) externalRequests.push(r.url());
});
page.on('requestfailed', (r) => console.log(`  request failed: ${r.url().slice(0, 160)} (${r.failure()?.errorText})`));
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log(`  console.${m.type()}: ${m.text().slice(0, 300)}`);
});

// Serve the CDN-hosted assets from local files so the test needs no internet.
const serveLocal = async (route, file) => {
  if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: `missing ${file}` });
  await route.fulfill({ status: 200, contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
};
const routeDir = (pattern, dir) =>
  page.route(pattern, (route, request) => {
    const m = request.url().match(pattern);
    return serveLocal(route, path.join(dir, m ? m[1] : ''));
  });
await routeDir(/cdn\.jsdelivr\.net\/npm\/@mediapipe\/tasks-vision@[^/]+\/wasm\/([^?#]+)/, LOCAL.wasmDir);
await routeDir(/cdn\.jsdelivr\.net\/npm\/@vladmandic\/face-api@[^/]+\/model\/([^?#]+)/, LOCAL.faceModelDir);
await page.route(REMOTE.poseModel, (route) => serveLocal(route, LOCAL.poseModel));
await page.route(REMOTE.segModel, (route) => serveLocal(route, LOCAL.segModel));

// Optional: force the face-model runtime (E2E_TF_BACKEND=wasm exercises the vendored WASM binaries).
const forcedBackend = process.env.E2E_TF_BACKEND || '';
await page.addInitScript((backend) => {
  if (backend) localStorage.setItem('hr.settings.v1', JSON.stringify({ tfBackend: backend }));
}, forcedBackend);

// Stubbed Anthropic API: the app talks to it through the vendored SDK bundle.
let aiStub = { mode: 'unknown', calls: 0, lastBody: null };
await page.route(/https:\/\/api\.anthropic\.com\/v1\/messages(\?.*)?$/, async (route, request) => {
  aiStub.calls += 1;
  aiStub.lastBody = request.postDataJSON();
  const match = aiStub.mode === 'match';
  const payload = {
    summary: match ? 'An adult with short dark hair in a black sleeveless top is standing with arms out.' : 'An adult with short dark hair is stretching on a mat.',
    people: [{ ageGroup: 'adult', hairLength: 'short', build: 'slim', clothing: 'black sleeveless top, black shorts', activity: 'yoga pose', bestMatch: match ? 'Someone Else' : 'unknown', confidence: match ? 0.9 : 0.2, reasoning: match ? 'adult, short hair, height fits' : 'no clear fit' }],
  };
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ id: 'msg_stub', type: 'message', role: 'assistant', model: aiStub.lastBody?.model || 'stub', content: [{ type: 'text', text: JSON.stringify(payload) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 120 } }),
  });
});

// Fake camera: a canvas that keeps redrawing the sample photo.
await page.addInitScript(() => {
  const makeStream = async () => {
    const img = new Image();
    img.src = '/__fixtures__/person.jpg';
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = Math.round((960 * img.height) / img.width);
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const drawFrame = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = `hsl(${(tick++ * 7) % 360},60%,50%)`;
      ctx.fillRect(0, 0, 10, 10);
    };
    drawFrame();
    const stream = canvas.captureStream(15);
    setInterval(drawFrame, 66);
    return stream;
  };
  const md = navigator.mediaDevices;
  Object.defineProperty(md, 'getUserMedia', { value: makeStream, configurable: true });
  Object.defineProperty(md, 'enumerateDevices', {
    value: async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'Fake camera', groupId: 'g' }],
    configurable: true,
  });
});

try {
  await page.goto(`${url}/`);
  await waitFor(page, () => !!window.roomGuard, { label: 'app boot', timeout: 15000 });
  step('app booted');

  await page.click('#btnStart');
  await waitFor(page, () => window.roomGuard.state.running, { label: 'camera + models', timeout: 180000 });
  step(`models loaded: ${await page.textContent('#modelStatus')}`);
  const diag = await page.evaluate(() => window.roomGuard.state.engine.diagnostics());
  step(`diagnostics: backend=${diag.tfBackend} float32=${diag.float32} detector=${diag.faceDetector} pose=${diag.poseDelegate}`);
  if (forcedBackend) assert(diag.tfBackend === forcedBackend, `forced TensorFlow.js backend ${forcedBackend} is active`);

  const det = await waitFor(
    page,
    () => {
      const d = window.roomGuard.state.lastDetections[0];
      if (!d || !d.face || !Number.isFinite(d.obs.hair)) return null;
      return {
        standing: d.metrics.standing, feetVisible: d.metrics.feetVisible, headQuality: d.metrics.headQuality,
        hair: d.obs.hair, build: d.obs.build, faceLen: d.face.descriptor.length, verdict: d.result.verdict,
        box: d.box, fps: window.roomGuard.state.fps.value,
      };
    },
    { label: 'a detection with face and hair', timeout: 90000 },
  );
  step(`detection: ${JSON.stringify(det)}`);
  assert(det.faceLen === 128, 'face descriptor has 128 dims');
  assert(Number.isFinite(det.hair), 'hair index measured');
  assert(det.verdict === 'insufficient', 'no profiles yet -> insufficient evidence (no alarm)');
  const tracks = await page.evaluate(() => window.roomGuard.state.tracker.tracks.length);
  assert(tracks === 1, `one tracked person (got ${tracks})`);
  await page.waitForTimeout(8000);
  step(`throughput: ${await page.evaluate(() => `${window.roomGuard.state.fps.value.toFixed(2)} fps, frame ${window.roomGuard.state.frame}, ms per stage ${JSON.stringify(window.roomGuard.state.timing)}`)}`);
  await page.screenshot({ path: path.join(cache, 'live-before-enroll.png') });

  // Enroll the person in the photo.
  await page.click('#tabs button[data-view="people"]');
  await page.click('#btnNewPerson');
  await waitFor(
    page,
    () => document.getElementById('enrollPreview').width > 0 && document.getElementById('enrollPreviewOff').classList.contains('hidden'),
    { label: 'enrollment preview drawing', timeout: 20000 },
  );
  const enrollStatus = await waitFor(
    page,
    () => {
      const t = document.getElementById('enrollStatus').textContent;
      return t.includes('face ✓') ? t : null;
    },
    { label: 'enrollment status reports a face', timeout: 90000 },
  );
  step(`enroll status: ${enrollStatus}`);
  await page.screenshot({ path: path.join(cache, 'enroll-preview.png') });
  await page.fill('#personForm [name=name]', 'Test Person');
  await page.fill('#personForm [name=heightCm]', '175');
  await page.selectOption('#hairLengthSelect', 'short');
  await page.click('#btnCaptureFace');
  await waitFor(page, () => Number(document.getElementById('faceCount').textContent) >= 3, { label: 'face samples', timeout: 120000 });
  await waitFor(page, () => !document.getElementById('btnCaptureFace').disabled, { label: 'face capture finished', timeout: 120000 });
  const captured = Number(await page.textContent('#faceCount'));
  const thumbs = await page.evaluate(() => document.querySelectorAll('#faceThumbs figure img').length);
  step(`face samples: ${captured}, thumbnails: ${thumbs}`);
  assert(thumbs === captured, 'one thumbnail per captured face sample');

  // Album photo import: the same sample photo, expect one face candidate.
  await page.setInputFiles('#photoInput', LOCAL.person);
  await waitFor(page, () => document.querySelectorAll('#photoReview input[data-cand]').length >= 1, { label: 'faces found in the photo', timeout: 120000 });
  await page.screenshot({ path: path.join(cache, 'enroll-photo-review.png') });
  await page.click('#btnAddPhotoFaces');
  await waitFor(page, (n) => Number(document.getElementById('faceCount').textContent) === n + 1, { label: 'photo face added', timeout: 10000, arg: captured });
  step('photo import added a face sample');
  await page.click('#faceThumbs button[data-remove-face="0"]');
  assert(Number(await page.textContent('#faceCount')) === captured, 'removing a face sample updates the count');

  await page.click('#btnCaptureBody');
  await waitFor(page, () => Number(document.getElementById('bodyCount').textContent) >= 1, { label: 'body sample', timeout: 20000 });
  await page.click('#personForm button[type=submit]');
  await waitFor(page, () => document.querySelectorAll('#peopleList .card').length === 1, { label: 'profile card', timeout: 10000 });
  const profile = await page.evaluate(() => {
    const p = window.roomGuard.state.profiles[0];
    return { name: p.name, faces: p.faceDescriptors.length, samples: p.samples.length, sample: p.samples[0] };
  });
  step(`profile saved: ${JSON.stringify(profile)}`);
  assert(profile.faces >= 3 && profile.samples === 1, 'profile carries face and body samples');
  const avatars = await page.evaluate(() => document.querySelectorAll('#peopleList .card .thumbs img').length);
  assert(avatars >= 1, `person card shows face thumbnails (${avatars})`);
  const thumbsSaved = await page.evaluate(() => window.roomGuard.state.profiles[0].faceThumbs.filter(Boolean).length);
  assert(thumbsSaved === profile.faces, 'thumbnails saved alongside descriptors');

  // The same person should now be recognised.
  await page.click('#tabs button[data-view="live"]');
  const identity = await waitFor(
    page,
    () => {
      const t = window.roomGuard.state.tracker.tracks[0];
      return t && t.identity.verdict === 'known' ? t.identity : null;
    },
    { label: 'known identity', timeout: 30000 },
  );
  step(`identified: ${identity.name} ${(identity.confidence * 100).toFixed(0)}%`);
  assert(identity.name === 'Test Person', 'identified as the enrolled person');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(cache, 'live-identified.png') });

  // Make the enrolled face not match any more: the person becomes a stranger and the alarm must fire.
  await page.evaluate(() => {
    const rg = window.roomGuard;
    rg.state.profiles = [{ id: 'x', name: 'Someone Else', heightCm: 175, hairLength: 'long', faceDescriptors: [Array.from({ length: 128 }, (_, i) => Math.sin(i) * 0.3)], samples: [] }];
    rg.state.settings.unknownGraceSec = 1;
  });
  // Claude on (stubbed). With bestMatch "unknown" the alarm must still fire, and the visit gets a description.
  await page.evaluate(() => {
    const rg = window.roomGuard;
    Object.assign(rg.state.settings, { aiEnabled: true, aiApiKey: 'sk-ant-test', aiModel: 'claude-opus-5', aiDescribeVisits: true, aiSecondOpinion: true });
    rg.ai.configure({ apiKey: 'sk-ant-test' });
    for (const p of rg.state.presence.values()) p.aiTried = false;
  });
  await page.click('#btnArm');
  const alarm = await waitFor(page, () => window.roomGuard.state.alarmActive, { label: 'alarm', timeout: 60000 });
  assert(alarm === true, 'alarm fired for an unknown person');
  assert(!(await page.$eval('#alarmBanner', (el) => el.classList.contains('hidden'))), 'alarm banner shown');
  await page.screenshot({ path: path.join(cache, 'live-alarm.png') });
  await page.click('#btnDismissAlarm');
  assert(aiStub.calls >= 1, `Claude was consulted through the SDK bundle (${aiStub.calls} calls)`);
  assert(aiStub.lastBody?.output_config?.format?.type === 'json_schema', 'request used structured JSON output');
  assert(aiStub.lastBody?.fallbacks === 'default', 'opus-5 request carries server-side fallbacks');
  assert(Array.isArray(aiStub.lastBody?.messages?.[0]?.content) && aiStub.lastBody.messages[0].content[0]?.type === 'image', 'request carried the frame as an image block');
  const aiNote = await waitFor(page, () => {
    const p = [...window.roomGuard.state.presence.values()][0];
    return p?.ai?.summary || null;
  }, { label: 'Claude description on the track', timeout: 30000 });
  step(`Claude description: ${aiNote}`);

  // Manual "Ask Claude" with a stub that matches the enrolled name: the camera's unknown becomes known via Claude.
  aiStub.mode = 'match';
  await waitFor(page, () => !document.getElementById('btnAskAi').disabled, { label: 'Ask Claude button enabled', timeout: 10000 });
  await page.click('#btnAskAi');
  const viaAi = await waitFor(page, () => {
    const p = [...window.roomGuard.state.presence.values()][0];
    return p?.aiIdentity ? p.aiIdentity.name : null;
  }, { label: 'Claude second opinion applied', timeout: 30000 });
  assert(viaAi === 'Someone Else', `second opinion identified the person (${viaAi})`);
  await waitFor(page, () => document.getElementById('presence').textContent.includes('Claude'), { label: 'presence shows Claude identity', timeout: 15000 });
  await page.screenshot({ path: path.join(cache, 'live-claude.png') });

  // Stop: events must be closed and the clip saved locally (IndexedDB).
  await page.click('#btnStop');
  await waitFor(page, () => !window.roomGuard.state.running, { label: 'camera stopped', timeout: 20000 });
  await page.waitForTimeout(1500);
  const events = await page.evaluate(async () => {
    const list = await window.roomGuard.store.listEvents();
    const out = [];
    for (const e of list) {
      out.push({
        verdict: e.verdict, person: e.personName, alarm: e.alarmTriggered, clip: e.clipPath, snapshot: e.snapshotPath,
        ended: !!e.endedAt, hair: e.features?.hair, faces: e.features?.faceDescriptors?.length, aiSummary: e.features?.ai?.summary || null,
        clipUrl: e.clipPath ? await window.roomGuard.store.mediaUrl(e.clipPath) : null,
        snapUrl: e.snapshotPath ? await window.roomGuard.store.mediaUrl(e.snapshotPath) : null,
      });
    }
    return out;
  });
  step(`events: ${JSON.stringify(events)}`);
  assert(events.length >= 1, 'at least one event logged');
  assert(events.every((e) => e.ended), 'events were closed');
  assert(events.some((e) => e.alarm), 'an event records the alarm');
  assert(events.some((e) => e.clip && e.clipUrl), 'clip saved and retrievable');
  assert(events.some((e) => e.snapshot && e.snapUrl), 'snapshot saved and retrievable');
  assert(events.some((e) => e.aiSummary), 'event stored the Claude description');
  assert(events.some((e) => e.person === 'Someone Else' && e.verdict === 'known'), 'event closed with the identity Claude supplied');

  await page.click('#tabs button[data-view="events"]');
  await waitFor(page, () => document.querySelectorAll('#eventsList .event').length >= 1, { label: 'events rendered', timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(cache, 'events.png'), fullPage: true });
  step('events view rendered');
  assert(externalRequests.length === 0, `no unexpected network requests (got ${JSON.stringify(externalRequests.slice(0, 5))})`);
} catch (e) {
  fail(e.stack || String(e));
  await page.screenshot({ path: path.join(cache, 'failure.png') }).catch(() => {});
} finally {
  if (pageErrors.length) {
    fail(`page errors:\n  ${pageErrors.join('\n  ')}`);
  }
  await browser.close();
  server.close();
}
console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
