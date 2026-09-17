// Room Guard: wires the camera, the vision models, tracking, identification,
// recording, alarms and the UI together.

import { APP_VERSION, POSE_EDGES, HAIR_LENGTH_LABELS, HAIR_LENGTH_INDEX } from './config.js';
import { loadSettings, saveSettings, LOCAL_KEYS, localGet, localSet, exportLocalData, importLocalData } from './settings.js';
import { VisionEngine, matchFacesToPoses } from './vision.js';
import { bodyMetrics, hairMetrics, refineHeadTop, buildObservation, fitCalibration, median } from './features.js';
import { identify, Tracker, summarizeTrack } from './identify.js';
import { ClipRecorder, captureSnapshot } from './recorder.js';
import { Store, clipPathFor } from './storage.js';
import { Siren, requestNotificationPermission, notify, triggerDoorLock } from './alarm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (d) => new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const els = {};
for (const el of document.querySelectorAll('[id]')) els[el.getAttribute('id')] = el;

const store = new Store();
const siren = new Siren();

const state = {
  settings: loadSettings(),
  profiles: [],
  calibration: null,
  engine: null,
  tracker: null,
  recorder: null,
  stream: null,
  running: false,
  armed: !!localGet('hr.armed', false),
  frame: 0,
  errors: 0,
  mask: null,
  faces: { list: [], at: 0, busy: false },
  fps: { count: 0, since: performance.now(), value: 0 },
  timing: { pose: 0, hair: 0, face: 0 },
  lastDetections: [],
  presence: new Map(),
  session: null,
  emptySince: null,
  alarmActive: false,
  editing: null,
  calib: { collecting: false, samples: [], refHeight: null, fit: null, reason: '' },
  view: 'live',
};

// ---------------------------------------------------------------- UI helpers
let toastTimer = null;
function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), kind === 'error' ? 7000 : 3500);
}

function log(message, kind = '') {
  const li = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<time>${fmtTime(Date.now())}</time><span>${esc(message)}</span>`;
  els.liveLog.prepend(li);
  while (els.liveLog.children.length > 40) els.liveLog.lastChild.remove();
}

function showView(name) {
  state.view = name;
  for (const b of els.tabs.querySelectorAll('button')) b.classList.toggle('active', b.dataset.view === name);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  if (name === 'events') renderEvents();
  if (name === 'people') renderPeople();
  if (name === 'calibrate') renderCalibration();
}

function profileById(id) {
  return state.profiles.find((p) => p.id === id) || null;
}

function hairLabel(index) {
  if (!Number.isFinite(index)) return null;
  let best = 'short';
  let bestD = Infinity;
  for (const [k, v] of Object.entries(HAIR_LENGTH_INDEX)) {
    const d = Math.abs(v - index);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function labelFor(identity) {
  if (!identity) return 'Identifying…';
  switch (identity.verdict) {
    case 'known':
      return `${identity.name} ${pct(identity.confidence)}`;
    case 'ambiguous':
      return `${identity.name}? ${pct(identity.confidence)}`;
    case 'unknown':
      return 'Unknown person';
    default:
      return 'Identifying…';
  }
}

function colorFor(identity) {
  if (!identity) return '#9ca3af';
  if (identity.verdict === 'known') return profileById(identity.profileId)?.color || '#4ade80';
  if (identity.verdict === 'ambiguous') return '#fbbf24';
  if (identity.verdict === 'unknown') return '#f87171';
  return '#9ca3af';
}

function updateStoreStatus() {
  const el = els.storeStatus;
  if (!store.remote) {
    el.textContent = 'Local mode';
    el.className = 'status-pill';
  } else if (store.user) {
    el.textContent = `Supabase · ${store.user.email || 'signed in'}`;
    el.className = 'status-pill ok';
  } else {
    el.textContent = 'Supabase · sign in required';
    el.className = 'status-pill warn';
  }
  if (els.connStatus) els.connStatus.textContent = el.textContent;
}

function updateArmedUI() {
  els.btnArm.textContent = state.armed ? 'Disarm alarm' : 'Arm alarm';
  els.btnArm.classList.toggle('armed', state.armed);
  els.armedBadge.textContent = state.armed ? 'Armed' : 'Disarmed';
  els.armedBadge.classList.toggle('armed', state.armed);
}

// ---------------------------------------------------------------- data loading
async function loadProfiles() {
  try {
    state.profiles = await store.listProfiles();
  } catch (e) {
    toast(e.message, 'error');
    state.profiles = localGet(LOCAL_KEYS.profiles, []);
  }
  renderPeople();
  renderCalibPeople();
}

async function loadCalibration() {
  try {
    state.calibration = await store.loadCalibration(state.settings.cameraLabel);
  } catch {
    state.calibration = localGet(LOCAL_KEYS.calibration);
  }
  renderCalibCurrent();
}

// ---------------------------------------------------------------- camera
async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const current = state.settings.cameraDeviceId;
    els.cameraSelect.innerHTML = '<option value="">Default camera</option>';
    for (const c of cams) {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Camera ${els.cameraSelect.options.length}`;
      if (c.deviceId === current) o.selected = true;
      els.cameraSelect.appendChild(o);
    }
  } catch {
    /* ignore */
  }
}

function waitForVideo(video, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (video.videoWidth > 0 && video.readyState >= 2) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('Camera did not deliver frames'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function startCamera() {
  if (state.running) return;
  siren.unlock();
  els.btnStart.disabled = true;
  const s = state.settings;
  try {
    const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: !!s.recordAudio };
    if (s.cameraDeviceId) constraints.video.deviceId = { exact: s.cameraDeviceId };
    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (s.cameraDeviceId) {
        delete constraints.video.deviceId;
        state.stream = await navigator.mediaDevices.getUserMedia(constraints);
      } else throw e;
    }
    els.video.srcObject = state.stream;
    await els.video.play().catch(() => {});
    await waitForVideo(els.video);
    els.videoWrap.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
    els.stagePlaceholder.classList.add('hidden');
    const label = state.stream.getVideoTracks()[0]?.label || '';
    if (label && label !== s.cameraLabel) {
      s.cameraLabel = label;
      saveSettings(s);
      await loadCalibration();
    }
    listCameras();

    if (!state.engine) {
      state.engine = new VisionEngine({ onStatus: (m) => (els.modelStatus.textContent = m) });
      await state.engine.load({ delegate: s.poseModelDelegate || 'GPU', blockTelemetry: s.blockTelemetry !== false });
    }
    state.tracker = new Tracker({ threshold: s.matchThreshold, margin: s.matchMargin });
    state.recorder = new ClipRecorder(state.stream, { maxSec: s.clipMaxSec });
    state.recorder.onAutoStop = () => rotateRecording();
    state.frame = 0;
    state.errors = 0;
    state.mask = null;
    state.faces = { list: [], at: 0, busy: false };
    state.emptySince = null;
    state.running = true;
    els.btnStop.disabled = false;
    els.btnSnapshot.disabled = false;
    log('Camera started');
    requestAnimationFrame(loop);
  } catch (e) {
    console.error(e);
    toast(`Could not start: ${e.message}`, 'error');
    els.modelStatus.textContent = `Error: ${e.message}`;
    els.btnStart.disabled = false;
    stopStream();
  }
}

function stopStream() {
  if (state.stream) for (const t of state.stream.getTracks()) t.stop();
  state.stream = null;
  els.video.srcObject = null;
}

async function stopCamera() {
  if (!state.running) return;
  state.running = false;
  const tracks = state.tracker ? [...state.tracker.tracks] : [];
  for (const tr of tracks) {
    const p = state.presence.get(tr.id);
    state.presence.delete(tr.id);
    if (p) await closeEvent(tr, p);
  }
  if (state.tracker) state.tracker.tracks = [];
  await finalizeRecording();
  stopStream();
  const ctx = els.overlay.getContext('2d');
  ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.stagePlaceholder.classList.remove('hidden');
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  els.btnSnapshot.disabled = true;
  els.fpsBadge.textContent = '– fps';
  state.lastDetections = [];
  renderPresence([]);
  log('Camera stopped');
}

// ---------------------------------------------------------------- main loop
function loop() {
  if (!state.running) return;
  const v = els.video;
  if (v.readyState >= 2 && v.videoWidth) {
    try {
      processFrame(performance.now());
      state.errors = 0;
    } catch (e) {
      console.error(e);
      if (++state.errors > 30) {
        toast(`Vision pipeline failed: ${e.message}`, 'error');
        stopCamera();
        return;
      }
    }
  }
  requestAnimationFrame(loop);
}

function processFrame(now) {
  const video = els.video;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const s = state.settings;
  const engine = state.engine;

  const tPose = performance.now();
  const poses = engine.detectPoses(video, now);
  ema('pose', performance.now() - tPose);
  state.frame += 1;

  if (poses.length) {
    if (!state.mask || state.frame % Math.max(1, s.hairEveryFrames) === 0) {
      const tHair = performance.now();
      state.mask = engine.segmentHair(video, now);
      ema('hair', performance.now() - tHair);
    }
    if (!state.faces.busy && now - state.faces.at > s.faceEveryMs) {
      state.faces.busy = true;
      const tFace = performance.now();
      engine
        .detectFaces(video)
        .then((list) => {
          state.faces.list = list;
          state.faces.at = performance.now();
          ema('face', state.faces.at - tFace);
        })
        .catch((e) => console.warn('face detection failed', e))
        .finally(() => {
          state.faces.busy = false;
        });
    }
  } else {
    state.mask = null;
  }

  const facesFresh = now - state.faces.at < 1500 ? state.faces.list : [];
  const metricsList = poses.map((lm) => bodyMetrics(lm, W, H));
  const faceFor = matchFacesToPoses(facesFresh, metricsList);
  const detections = [];
  metricsList.forEach((m0, i) => {
    if (!m0) return;
    const hair = state.mask ? hairMetrics(state.mask.data, state.mask.width, state.mask.height, m0, W, H) : null;
    const m = refineHeadTop(m0, hair);
    const face = faceFor[i];
    const obs = buildObservation({ metrics: m, hair, calib: state.calibration, faceDescriptor: face?.descriptor || null, frameHeight: H });
    const result = identify(obs, state.profiles, { threshold: s.matchThreshold, margin: s.matchMargin });
    detections.push({ box: m.box, obs, result, metrics: m, hair, face });
  });
  state.lastDetections = detections;

  if (state.calib.collecting) collectCalibrationSample(detections, H);

  const { active, ended } = state.tracker.update(detections, now);
  handlePresence(active, ended, now);
  draw(detections, active, W, H);
  renderPresence(active);

  state.fps.count += 1;
  if (now - state.fps.since > 1000) {
    state.fps.value = (state.fps.count * 1000) / (now - state.fps.since);
    state.fps.count = 0;
    state.fps.since = now;
    els.fpsBadge.textContent = `${state.fps.value.toFixed(state.fps.value < 2 ? 1 : 0)} fps`;
    const t = state.timing;
    els.fpsBadge.title = `pose ${t.pose.toFixed(0)} ms · hair ${t.hair.toFixed(0)} ms · face ${t.face.toFixed(0)} ms`;
  }
}

function ema(key, ms) {
  const t = state.timing;
  t[key] = t[key] ? t[key] * 0.8 + ms * 0.2 : ms;
}

// ---------------------------------------------------------------- presence, events, alarm
function handlePresence(active, ended, now) {
  const s = state.settings;
  for (const tr of active) {
    let p = state.presence.get(tr.id);
    if (!p) {
      p = { trackId: tr.id, eventId: null, eventPromise: null, alarmed: false, locked: false, notified: false };
      state.presence.set(tr.id, p);
      ensureRecording();
    }
    if (!p.eventId && !p.eventPromise && (tr.identity.stable || now - tr.firstSeen > 2500)) {
      p.eventPromise = openEvent(tr, p)
        .catch((e) => log(`Could not save event: ${e.message}`, 'error'))
        .finally(() => {
          p.eventPromise = null;
        });
    }
    const id = tr.identity;
    if (id.verdict === 'known' && id.stable && !p.notified) {
      p.notified = true;
      log(`${id.name} is in the room (${pct(id.confidence)})`);
      const prof = profileById(id.profileId);
      if (prof?.alertOnEnter && s.notifyEnabled) notify('Room Guard', `${id.name} entered your room`);
    }
    if (state.armed && id.verdict === 'unknown' && tr.unknownSince != null && now - tr.unknownSince >= s.unknownGraceSec * 1000 && !p.alarmed) {
      p.alarmed = true;
      fireAlarm(tr, p);
    }
  }
  for (const tr of ended) {
    const p = state.presence.get(tr.id);
    state.presence.delete(tr.id);
    if (p) closeEvent(tr, p);
  }
  if (active.length === 0) {
    if (state.emptySince == null) state.emptySince = now;
    if (state.session && now - state.emptySince > s.clipTailSec * 1000) finalizeRecording();
  } else {
    state.emptySince = null;
  }
}

/** Only known / ambiguous verdicts name a person; unknown visits store no candidate. */
function personFor(identity) {
  if (identity.verdict === 'known' || identity.verdict === 'ambiguous') return { id: identity.profileId, name: identity.name };
  return { id: null, name: null };
}

function eventStartIso(tr) {
  return new Date(Date.now() - (performance.now() - tr.firstSeen)).toISOString();
}

async function openEvent(tr, p) {
  const startedAt = eventStartIso(tr);
  const snap = await captureSnapshot(els.video, { maxWidth: 640 });
  let snapshotPath = null;
  if (snap?.blob) {
    try {
      snapshotPath = await store.uploadMedia(snap.blob, clipPathFor(startedAt, 'jpg', tr.identity.verdict, `${tr.identity.name || 'person'}-${tr.id}`), 'image/jpeg');
    } catch (e) {
      log(`Snapshot save failed: ${e.message}`, 'error');
    }
  }
  const who = personFor(tr.identity);
  const ev = await store.insertEvent({
    startedAt,
    endedAt: null,
    verdict: tr.identity.verdict,
    personId: who.id,
    personName: who.name,
    confidence: tr.identity.confidence,
    features: summarizeTrack(tr),
    snapshotPath,
    clipPath: null,
    alarmTriggered: p.alarmed,
    lockTriggered: p.locked,
    cameraLabel: state.settings.cameraLabel,
  });
  p.eventId = ev.id;
  if (state.session) state.session.eventIds.push(ev.id);
}

async function closeEvent(tr, p) {
  if (p.eventPromise) await p.eventPromise;
  const who = personFor(tr.identity);
  const patch = {
    endedAt: new Date().toISOString(),
    verdict: tr.identity.verdict,
    personId: who.id,
    personName: who.name,
    confidence: tr.identity.confidence,
    features: summarizeTrack(tr),
    alarmTriggered: p.alarmed,
    lockTriggered: p.locked,
  };
  try {
    if (p.eventId) await store.updateEvent(p.eventId, patch);
    else if (tr.frames >= 5) {
      const ev = await store.insertEvent({ startedAt: eventStartIso(tr), ...patch, snapshotPath: null, clipPath: null, cameraLabel: state.settings.cameraLabel });
      if (state.session) state.session.eventIds.push(ev.id);
    }
  } catch (e) {
    log(`Could not save event: ${e.message}`, 'error');
  }
  log(`${labelFor(tr.identity)} left`);
  if (state.view === 'events') renderEvents();
}

async function fireAlarm(tr, p) {
  const s = state.settings;
  log('Unknown person in the room: alarm', 'error');
  state.alarmActive = true;
  els.alarmBanner.classList.remove('hidden');
  if (s.alarmEnabled) siren.start(s.alarmDurationSec);
  if (s.notifyEnabled) notify('⚠️ Room Guard', 'Unknown person detected in your room');
  if (s.lockOnUnknown && s.lockWebhookUrl) {
    const r = await triggerDoorLock({ url: s.lockWebhookUrl, token: s.lockWebhookToken, reason: 'unknown person detected', extra: { trackId: tr.id } });
    p.locked = !!r.ok;
    log(r.ok ? 'Door lock requested' : `Door lock failed: ${r.message}`, r.ok ? 'warn' : 'error');
  }
  if (p.eventId) store.updateEvent(p.eventId, { alarmTriggered: true, lockTriggered: p.locked }).catch(() => {});
}

function dismissAlarm() {
  siren.stop();
  state.alarmActive = false;
  els.alarmBanner.classList.add('hidden');
}

// ---------------------------------------------------------------- recording
function ensureRecording() {
  const s = state.settings;
  if (!s.recordClips || !state.recorder?.supported || state.session) return;
  if (!state.recorder.start({ startedAt: Date.now() })) return;
  state.session = { id: uuid(), startedAt: Date.now(), eventIds: [] };
  els.recBadge.classList.remove('hidden');
}

async function finalizeRecording() {
  const session = state.session;
  if (!session) return;
  state.session = null;
  els.recBadge.classList.add('hidden');
  const clip = await state.recorder.stop();
  if (!clip || clip.blob.size < 2000) return;
  const path = clipPathFor(new Date(clip.startedAt), clip.extension, 'visit', 'clip');
  try {
    await store.uploadMedia(clip.blob, path, clip.mimeType);
    for (const id of session.eventIds) await store.updateEvent(id, { clipPath: path });
    log(`Clip saved (${(clip.blob.size / 1048576).toFixed(1)} MB, ${Math.round(clip.durationMs / 1000)} s)`);
    if (state.view === 'events') renderEvents();
  } catch (e) {
    log(`Clip save failed: ${e.message}`, 'error');
  }
}

function rotateRecording() {
  finalizeRecording().then(() => {
    if (state.running && state.tracker?.tracks.length) ensureRecording();
  });
}

// ---------------------------------------------------------------- drawing
function draw(detections, tracks, W, H) {
  const c = els.overlay;
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const mirror = !!state.settings.mirror;
  const X = (x) => (mirror ? W - x : x);
  const trackByBox = new Map(tracks.map((t) => [t.box, t]));

  for (const d of detections) {
    const tr = trackByBox.get(d.box);
    const identity = tr?.identity || null;
    const color = colorFor(identity);
    const pts = d.metrics.points;

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (const [a, b] of POSE_EDGES) {
      const pa = pts[a];
      const pb = pts[b];
      if (!pa || !pb || pa.v < 0.5 || pb.v < 0.5) continue;
      ctx.beginPath();
      ctx.moveTo(X(pa.x), pa.y);
      ctx.lineTo(X(pb.x), pb.y);
      ctx.stroke();
    }

    const b = d.box;
    const bx = mirror ? W - (b.x + b.w) : b.x;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.strokeRect(bx, b.y, b.w, b.h);

    if (d.metrics.heightUsable) {
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, d.metrics.headTopY);
      ctx.lineTo(bx + b.w, d.metrics.headTopY);
      ctx.moveTo(bx, d.metrics.feetY);
      ctx.lineTo(bx + b.w, d.metrics.feetY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (d.face) {
      const f = d.face.box;
      ctx.strokeStyle = 'rgba(96,165,250,0.9)';
      ctx.lineWidth = 2;
      ctx.strokeRect(mirror ? W - (f.x + f.w) : f.x, f.y, f.w, f.h);
    }

    const cues = [];
    if (Number.isFinite(d.obs.heightCm)) cues.push(`${d.obs.heightCm.toFixed(0)} cm${d.obs.heightExtrapolated ? '?' : ''}`);
    else if (!state.calibration) cues.push('no calibration');
    else if (!d.metrics.feetVisible) cues.push('feet hidden');
    else if (!d.metrics.standing) cues.push('not standing');
    if (Number.isFinite(d.obs.hair)) cues.push(`hair ${hairLabel(d.obs.hair)}`);
    if (Number.isFinite(d.obs.build)) cues.push(`build ${d.obs.build.toFixed(2)}`);
    if (d.face) cues.push('face ✓');
    drawLabel(ctx, bx, b.y, [labelFor(identity), cues.join(' · ')], color, W);
  }
}

function drawLabel(ctx, x, y, lines, color, W) {
  const font1 = `bold ${Math.max(14, W / 50)}px system-ui, sans-serif`;
  const font2 = `${Math.max(12, W / 64)}px system-ui, sans-serif`;
  ctx.font = font1;
  const w1 = ctx.measureText(lines[0]).width;
  ctx.font = font2;
  const w2 = lines[1] ? ctx.measureText(lines[1]).width : 0;
  const lh1 = Math.max(14, W / 50) * 1.25;
  const lh2 = lines[1] ? Math.max(12, W / 64) * 1.3 : 0;
  const pad = 6;
  const bw = Math.max(w1, w2) + pad * 2;
  const bh = lh1 + lh2 + pad * 1.5;
  let top = y - bh - 2;
  if (top < 0) top = y + 2;
  const left = Math.max(0, Math.min(x, W - bw));
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(left, top, bw, bh);
  ctx.fillStyle = color;
  ctx.fillRect(left, top, 4, bh);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  ctx.font = font1;
  ctx.fillText(lines[0], left + pad + 2, top + pad / 2);
  if (lines[1]) {
    ctx.font = font2;
    ctx.fillStyle = '#d1d5db';
    ctx.fillText(lines[1], left + pad + 2, top + pad / 2 + lh1);
  }
}

function renderPresence(tracks) {
  if (!tracks.length) {
    els.presence.innerHTML = '<p class="muted">Nobody detected.</p>';
    return;
  }
  const html = tracks
    .map((tr) => {
      const id = tr.identity;
      const sum = summarizeTrack(tr);
      const cues = [];
      if (Number.isFinite(sum.heightCm)) cues.push(`≈ ${sum.heightCm.toFixed(0)} cm`);
      if (Number.isFinite(sum.hair)) cues.push(`hair: ${hairLabel(sum.hair)}`);
      if (Number.isFinite(sum.build)) cues.push(`build ${sum.build.toFixed(2)}`);
      cues.push(sum.faceDescriptors.length ? 'face seen' : 'no face yet');
      cues.push(`${Math.round((tr.lastSeen - tr.firstSeen) / 1000)} s`);
      const runnerUp = (id.ranked || []).slice(0, 3).map((r) => `${esc(r.name)} ${pct(r.score)}`).join(', ');
      return `<div class="person-now" style="border-left-color:${colorFor(id)}">
        <div class="name"><span>${esc(labelFor(id))}</span>${p_alarm(tr)}</div>
        <div class="bar"><i style="width:${Math.round((id.confidence || 0) * 100)}%;background:${colorFor(id)}"></i></div>
        <div class="cues">${cues.map(esc).join('<span>·</span>')}</div>
        ${runnerUp ? `<div class="cues muted">scores: ${runnerUp}</div>` : ''}
      </div>`;
    })
    .join('');
  els.presence.innerHTML = html;
}

function p_alarm(tr) {
  const p = state.presence.get(tr.id);
  if (p?.alarmed) return '<span class="tag alarm">alarm</span>';
  if (tr.identity.verdict === 'unknown' && tr.unknownSince != null && state.armed) {
    const left = Math.max(0, state.settings.unknownGraceSec - (performance.now() - tr.unknownSince) / 1000);
    return `<span class="muted small">alarm in ${left.toFixed(0)} s</span>`;
  }
  return '';
}

// ---------------------------------------------------------------- snapshots
async function takeSnapshot() {
  const snap = await captureSnapshot(els.video, { maxWidth: 1280, quality: 0.9 });
  if (!snap) return toast('No frame available');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(snap.blob);
  a.download = `room-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------------------------------------------------------- people
function renderPeople() {
  if (!state.profiles.length) {
    els.peopleList.innerHTML = '<p class="muted">No one enrolled yet. Add your family members so the camera can tell them apart.</p>';
    return;
  }
  els.peopleList.innerHTML = state.profiles
    .map((p) => {
      const warn = [];
      if (!p.faceDescriptors?.length) warn.push('no face samples');
      if (!Number.isFinite(p.heightCm)) warn.push('no height');
      return `<article class="card" style="border-top-color:${esc(p.color || '#4ade80')}" data-id="${esc(p.id)}">
        <h3>${esc(p.name)} ${p.alertOnEnter ? '<span class="tag">notify</span>' : ''}</h3>
        <div class="meta">
          <span>${Number.isFinite(p.heightCm) ? `${p.heightCm} cm` : '– cm'}</span>
          <span>${Number.isFinite(p.weightKg) ? `${p.weightKg} kg` : '– kg'}</span>
          <span>${esc(HAIR_LENGTH_LABELS[p.hairLength] || p.hairLength || '')}</span>
          <span>${p.faceDescriptors?.length || 0} face · ${p.samples?.length || 0} body samples</span>
        </div>
        ${p.notes ? `<p class="small muted">${esc(p.notes)}</p>` : ''}
        ${warn.length ? `<div class="warn">⚠ ${warn.join(', ')}</div>` : ''}
        <div class="actions">
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="delete" class="danger-outline">Delete</button>
        </div>
      </article>`;
    })
    .join('');
}

function openPersonForm(profile) {
  const f = els.personForm;
  state.editing = profile
    ? { ...profile, faceDescriptors: [...(profile.faceDescriptors || [])], samples: [...(profile.samples || [])] }
    : { id: '', name: '', heightCm: '', weightKg: '', hairLength: 'short', color: '#4ade80', alertOnEnter: false, notes: '', faceDescriptors: [], samples: [] };
  const e = state.editing;
  f.elements.personId.value = e.id || '';
  f.elements.name.value = e.name || '';
  f.elements.heightCm.value = e.heightCm ?? '';
  f.elements.weightKg.value = e.weightKg ?? '';
  f.elements.hairLength.value = e.hairLength || 'short';
  f.elements.color.value = e.color || '#4ade80';
  f.elements.alertOnEnter.checked = !!e.alertOnEnter;
  f.elements.notes.value = e.notes || '';
  els.personFormTitle.textContent = profile ? `Edit ${profile.name}` : 'Add a person';
  updateSampleCounts();
  f.classList.remove('hidden');
  f.elements.name.focus();
}

function updateSampleCounts() {
  els.faceCount.textContent = state.editing?.faceDescriptors.length || 0;
  els.bodyCount.textContent = state.editing?.samples.length || 0;
  els.captureHint.textContent = state.running
    ? 'Camera is on. Have this person stand in front of it, then capture.'
    : 'Start the camera on the Live tab first, then have this person stand in front of it.';
}

async function savePerson(ev) {
  ev.preventDefault();
  const f = els.personForm;
  const e = state.editing || { faceDescriptors: [], samples: [] };
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const profile = {
    id: f.elements.personId.value || undefined,
    name: f.elements.name.value.trim(),
    heightCm: num(f.elements.heightCm.value),
    weightKg: num(f.elements.weightKg.value),
    hairLength: f.elements.hairLength.value,
    color: f.elements.color.value,
    alertOnEnter: f.elements.alertOnEnter.checked,
    notes: f.elements.notes.value.trim(),
    faceDescriptors: e.faceDescriptors,
    samples: e.samples,
  };
  if (!profile.name) return toast('Name is required', 'error');
  try {
    await store.saveProfile(profile);
    await loadProfiles();
    f.classList.add('hidden');
    state.editing = null;
    toast(`${profile.name} saved`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function captureFaces(n = 5) {
  if (!state.running || !state.engine?.faceReady) return toast('Start the camera first', 'error');
  if (!state.editing) return;
  const btn = els.btnCaptureFace;
  btn.disabled = true;
  let got = 0;
  try {
    for (let i = 0; i < n * 2 && got < n; i++) {
      els.captureHint.textContent = `Capturing face ${got + 1} of ${n}… look at the camera, then turn slightly.`;
      const faces = await state.engine.detectFaces(els.video);
      const face = faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
      if (face) {
        state.editing.faceDescriptors.push(face.descriptor);
        got += 1;
        siren.beep(880, 80);
        updateSampleCounts();
      }
      await sleep(650);
    }
    toast(got ? `Captured ${got} face sample${got > 1 ? 's' : ''}` : 'No face found. Move closer and face the camera.', got ? '' : 'error');
  } finally {
    btn.disabled = false;
    updateSampleCounts();
  }
}

async function captureBody() {
  if (!state.running) return toast('Start the camera first', 'error');
  if (!state.editing) return;
  const btn = els.btnCaptureBody;
  btn.disabled = true;
  const acc = { heights: [], builds: [], hairs: [] };
  // Collect over at least 2.5 s and at least 8 analysed frames (slow devices), never longer than 20 s.
  const started = performance.now();
  let lastFrame = state.frame;
  let frames = 0;
  let seen = 0;
  try {
    await new Promise((resolve) => {
      const tick = () => {
        if (state.frame !== lastFrame) {
          lastFrame = state.frame;
          frames += 1;
          const d = state.lastDetections[0];
          if (state.lastDetections.length === 1 && d) {
            seen += 1;
            if (Number.isFinite(d.obs.heightCm) && !d.obs.heightExtrapolated) acc.heights.push(d.obs.heightCm);
            if (Number.isFinite(d.obs.build)) acc.builds.push(d.obs.build);
            if (Number.isFinite(d.obs.hair)) acc.hairs.push(d.obs.hair);
          }
        }
        const elapsed = performance.now() - started;
        els.captureHint.textContent = `Hold still, whole body in view… ${frames} frames`;
        const done = (elapsed >= 2500 && frames >= 8) || elapsed >= 20000 || !state.running;
        if (!done) setTimeout(tick, 50);
        else resolve();
      };
      tick();
    });
    const sample = { t: new Date().toISOString(), height: median(acc.heights), build: median(acc.builds), hair: median(acc.hairs), source: 'enroll' };
    if (!seen) return toast('Exactly one person must be in view', 'error');
    if (![sample.height, sample.build, sample.hair].some(Number.isFinite)) return toast('Nothing measurable: stand facing the camera with feet visible', 'error');
    state.editing.samples.push(sample);
    siren.beep(660, 80);
    const parts = [];
    if (sample.height != null) parts.push(`${sample.height.toFixed(0)} cm`);
    if (sample.hair != null) parts.push(`hair ${hairLabel(sample.hair)}`);
    if (sample.build != null) parts.push(`build ${sample.build.toFixed(2)}`);
    toast(`Body sample added: ${parts.join(', ')}${sample.height == null && !state.calibration ? ' (calibrate to measure height)' : ''}`);
  } finally {
    btn.disabled = false;
    updateSampleCounts();
  }
}

// ---------------------------------------------------------------- events
async function renderEvents() {
  let events;
  try {
    events = await store.listEvents({ limit: 60 });
  } catch (e) {
    els.eventsList.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  if (!events.length) {
    els.eventsList.innerHTML = '<p class="muted">No events yet.</p>';
    return;
  }
  const options = state.profiles.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  els.eventsList.innerHTML = events
    .map((e) => {
      const f = e.features || {};
      const cues = [];
      if (Number.isFinite(f.heightCm)) cues.push(`≈ ${f.heightCm.toFixed(0)} cm`);
      if (Number.isFinite(f.hair)) cues.push(`hair ${hairLabel(f.hair)}`);
      if (Number.isFinite(f.build)) cues.push(`build ${f.build.toFixed(2)}`);
      if (f.faceDescriptors?.length) cues.push(`${f.faceDescriptors.length} face sample${f.faceDescriptors.length > 1 ? 's' : ''}`);
      const duration = e.endedAt ? `${Math.max(1, Math.round((new Date(e.endedAt) - new Date(e.startedAt)) / 1000))} s` : 'ongoing';
      const title = e.confirmedPersonId ? `${esc(e.personName)} (confirmed)` : e.verdict === 'known' ? esc(e.personName) : e.verdict === 'ambiguous' ? `${esc(e.personName)}?` : e.verdict === 'unknown' ? 'Unknown person' : 'Unidentified';
      return `<article class="event" data-id="${esc(e.id)}">
        <img class="thumb" alt="" data-snap="${esc(e.snapshotPath || '')}">
        <video controls hidden preload="none"></video>
        <div class="body">
          <div class="title"><span>${title}</span><span class="tag ${esc(e.verdict)}">${esc(e.verdict)} ${e.confidence != null ? pct(e.confidence) : ''}</span></div>
          <div class="meta">${fmtDate(e.startedAt)} · ${duration} ${e.alarmTriggered ? '· <span class="tag alarm">alarm</span>' : ''} ${e.lockTriggered ? '· <span class="tag">door locked</span>' : ''}</div>
          <div class="meta">${cues.length ? cues.map(esc).join(' · ') : 'no body measurements'}</div>
          <div class="actions">
            <button type="button" data-act="play" ${e.clipPath ? '' : 'disabled'}>${e.clipPath ? 'Play clip' : 'No clip'}</button>
            <select data-role="who"><option value="">Who was it?</option>${options}<option value="__stranger">A stranger</option></select>
            <button type="button" data-act="confirm">Confirm</button>
            <button type="button" data-act="delete" class="danger-outline">Delete</button>
          </div>
        </div>
      </article>`;
    })
    .join('');
  for (const img of els.eventsList.querySelectorAll('img[data-snap]')) {
    const path = img.dataset.snap;
    if (!path) {
      img.remove();
      continue;
    }
    store.mediaUrl(path).then((u) => {
      if (u) img.src = u;
      else img.remove();
    }).catch(() => img.remove());
  }
  els.eventsList._events = events;
}

async function onEventAction(ev) {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.event');
  const event = (els.eventsList._events || []).find((e) => e.id === card.dataset.id);
  if (!event) return;
  const act = btn.dataset.act;
  try {
    if (act === 'play') {
      const url = await store.mediaUrl(event.clipPath);
      if (!url) return toast('Clip is not available (it may still be uploading)', 'error');
      const v = card.querySelector('video');
      v.src = url;
      v.hidden = false;
      v.play().catch(() => {});
    } else if (act === 'delete') {
      if (!confirm('Delete this event and its clip?')) return;
      await store.deleteEvent(event);
      renderEvents();
    } else if (act === 'confirm') {
      const who = card.querySelector('select[data-role="who"]').value;
      if (!who) return toast('Pick who it was first');
      if (who === '__stranger') {
        await store.updateEvent(event.id, { verdict: 'unknown', personId: null, personName: null, confirmedPersonId: null });
        toast('Marked as a stranger');
      } else {
        const profile = profileById(who);
        if (!profile) return;
        await learnFromEvent(event, profile);
      }
      renderEvents();
    }
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function learnFromEvent(event, profile) {
  const f = event.features || {};
  const p = { ...profile, samples: [...(profile.samples || [])], faceDescriptors: [...(profile.faceDescriptors || [])] };
  const sample = { t: event.startedAt, height: f.heightCm ?? null, build: f.build ?? null, hair: f.hair ?? null, source: 'confirm' };
  if ([sample.height, sample.build, sample.hair].some(Number.isFinite)) p.samples.push(sample);
  for (const d of f.faceDescriptors || []) if (Array.isArray(d) && d.length === 128) p.faceDescriptors.push(d);
  while (p.samples.length > 300) p.samples.shift();
  while (p.faceDescriptors.length > 40) p.faceDescriptors.shift();
  await store.saveProfile(p);
  await store.updateEvent(event.id, { confirmedPersonId: p.id, personId: p.id, personName: p.name, verdict: 'known' });
  await loadProfiles();
  toast(`Learned from this visit: ${p.name}`);
}

// ---------------------------------------------------------------- calibration
function renderCalibPeople() {
  const sel = els.calibPerson;
  const current = sel.value;
  sel.innerHTML = '<option value="">Type a height below</option>';
  for (const p of state.profiles) {
    if (!Number.isFinite(p.heightCm)) continue;
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.name} (${p.heightCm} cm)`;
    sel.appendChild(o);
  }
  sel.value = current;
}

function renderCalibCurrent() {
  const c = state.calibration;
  if (!c) {
    els.calibCurrent.innerHTML = 'No calibration yet. Height will not be estimated until you calibrate.';
    return;
  }
  els.calibCurrent.innerHTML = `<div>Reference height: <b>${esc(c.refHeightCm)} cm</b></div>
    <div>Samples used: <b>${esc(c.n)}</b> · fit error: <b>± ${Number(c.rmseCm).toFixed(1)} cm</b></div>
    <div>Calibrated floor area: feet between ${Math.round(c.fyMin * 100)}% and ${Math.round(c.fyMax * 100)}% of the frame height</div>
    <div class="small">Saved ${c.createdAt ? fmtDate(c.createdAt) : ''}${state.settings.cameraLabel ? ` for “${esc(state.settings.cameraLabel)}”` : ''}</div>`;
}

function renderCalibration() {
  renderCalibPeople();
  renderCalibCurrent();
}

function collectCalibrationSample(detections, H) {
  const c = state.calib;
  if (detections.length !== 1) {
    c.reason = detections.length ? 'Exactly one person must be in view.' : 'Nobody in view.';
  } else {
    const m = detections[0].metrics;
    if (!m.feetVisible) c.reason = 'Feet are not visible.';
    else if (!m.standing) c.reason = 'Stand up straight.';
    else if (m.headQuality < 0.6) c.reason = 'Face the camera so the head can be measured.';
    else {
      c.reason = 'Collecting… keep walking around the room.';
      if (state.frame % 2 === 0) c.samples.push({ fy: m.feetY / H, ph: m.pixelHeight / H });
      if (c.samples.length > 600) c.samples.shift();
    }
  }
  if (state.frame % 10 === 0) renderCalibStats();
}

function renderCalibStats() {
  const c = state.calib;
  const lines = [c.collecting ? c.reason : c.fit ? 'Stopped. Save the calibration if the error looks reasonable.' : 'Not collecting.'];
  if (c.samples.length) {
    const fys = c.samples.map((s) => s.fy);
    lines.push(`Samples: ${c.samples.length} · feet between ${Math.round(Math.min(...fys) * 100)}% and ${Math.round(Math.max(...fys) * 100)}% of frame height`);
    const fit = fitCalibration(c.samples, c.refHeight);
    if (fit) lines.push(`Live fit error: ± ${fit.rmseCm.toFixed(1)} cm (aim for under 4 cm and a wide range of floor positions)`);
  }
  els.calibStats.textContent = lines.join('\n');
}

function startCalibration() {
  const height = Number(els.calibHeight.value);
  if (!state.running) return toast('Start the camera first', 'error');
  if (!(height >= 40 && height <= 250)) return toast('Enter the reference person\'s height in cm', 'error');
  state.calib = { collecting: true, samples: [], refHeight: height, fit: null, reason: 'Waiting for a person…' };
  els.btnCalibStart.disabled = true;
  els.btnCalibStop.disabled = false;
  els.btnCalibSave.disabled = true;
  renderCalibStats();
}

function stopCalibration() {
  const c = state.calib;
  c.collecting = false;
  c.fit = fitCalibration(c.samples, c.refHeight);
  els.btnCalibStart.disabled = false;
  els.btnCalibStop.disabled = true;
  els.btnCalibSave.disabled = !c.fit;
  renderCalibStats();
  if (!c.fit) toast('No usable samples were collected', 'error');
}

async function saveCalibration() {
  const fit = state.calib.fit;
  if (!fit) return;
  try {
    await store.saveCalibration(state.settings.cameraLabel, fit);
    state.calibration = fit;
    renderCalibCurrent();
    toast('Calibration saved');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function clearCalibration() {
  if (!confirm('Delete the saved calibration?')) return;
  await store.saveCalibration(state.settings.cameraLabel, null).catch(() => {});
  state.calibration = null;
  state.calib = { collecting: false, samples: [], refHeight: null, fit: null, reason: '' };
  els.btnCalibSave.disabled = true;
  renderCalibration();
  renderCalibStats();
}

// ---------------------------------------------------------------- settings
function renderSettings() {
  const f = els.settingsForm;
  for (const el of f.elements) {
    if (!el.name || !(el.name in state.settings)) continue;
    if (el.type === 'checkbox') el.checked = !!state.settings[el.name];
    else el.value = state.settings[el.name] ?? '';
  }
  els.videoWrap.classList.toggle('mirror', !!state.settings.mirror);
  updateStoreStatus();
}

function readSettingsForm() {
  const f = els.settingsForm;
  const s = { ...state.settings };
  for (const el of f.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'checkbox') s[el.name] = el.checked;
    else if (el.type === 'number') s[el.name] = el.value === '' ? s[el.name] : Number(el.value);
    else s[el.name] = el.value.trim();
  }
  return s;
}

async function applySettings(next, { reconnect = true } = {}) {
  const prev = state.settings;
  state.settings = next;
  saveSettings(next);
  els.videoWrap.classList.toggle('mirror', !!next.mirror);
  state.tracker?.setOptions({ threshold: next.matchThreshold, margin: next.matchMargin });
  if (state.recorder) state.recorder.maxSec = next.clipMaxSec;
  if (reconnect && (prev.supabaseUrl !== next.supabaseUrl || prev.supabaseAnonKey !== next.supabaseAnonKey)) {
    await store.configure(next);
    await loadProfiles();
    await loadCalibration();
  }
  updateStoreStatus();
}

async function saveSettingsForm(ev) {
  ev.preventDefault();
  await applySettings(readSettingsForm());
  toast('Settings saved');
}

async function signIn() {
  const next = readSettingsForm();
  const password = els.supabasePassword.value;
  if (!next.supabaseUrl || !next.supabaseAnonKey) return toast('Enter the Supabase URL and anon key first', 'error');
  await applySettings(next, { reconnect: false });
  try {
    await store.configure(next);
    if (!store.remote) throw new Error(store.lastError?.message || 'Supabase client could not be created');
    if (next.supabaseEmail && password) await store.signIn(next.supabaseEmail, password);
    els.supabasePassword.value = '';
    await loadProfiles();
    await loadCalibration();
    updateStoreStatus();
    toast(store.user ? `Signed in as ${store.user.email}` : 'Connected. Sign in to read and write data.');
  } catch (e) {
    updateStoreStatus();
    toast(e.message, 'error');
  }
}

async function signOut() {
  await store.signOut().catch(() => {});
  updateStoreStatus();
  await loadProfiles();
  toast('Signed out');
}

function exportData() {
  const data = exportLocalData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `room-guard-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importData(file) {
  try {
    importLocalData(JSON.parse(await file.text()));
    state.settings = loadSettings();
    renderSettings();
    await store.configure(state.settings);
    await loadProfiles();
    await loadCalibration();
    toast('Import complete');
  } catch (e) {
    toast(`Import failed: ${e.message}`, 'error');
  }
}

async function wipeLocal() {
  if (!confirm('Delete all settings, people, events and clips stored in this browser? Supabase data is not touched.')) return;
  await stopCamera();
  for (const k of ['hr.settings.v1', 'hr.armed', ...Object.values(LOCAL_KEYS)]) localStorage.removeItem(k);
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('hr-clips');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  location.reload();
}

// ---------------------------------------------------------------- boot
function bind() {
  els.appVersion.textContent = `v${APP_VERSION}`;
  els.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  els.hairLengthSelect.innerHTML = Object.entries(HAIR_LENGTH_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  els.btnStart.addEventListener('click', startCamera);
  els.btnStop.addEventListener('click', stopCamera);
  els.btnArm.addEventListener('click', () => {
    siren.unlock();
    state.armed = !state.armed;
    localSet('hr.armed', state.armed);
    updateArmedUI();
    log(state.armed ? 'Alarm armed' : 'Alarm disarmed', 'warn');
    if (state.armed && !state.profiles.length) toast('Nobody is enrolled yet, so every visitor counts as unknown once they are clearly seen.', 'error');
  });
  els.btnTestSiren.addEventListener('click', () => {
    if (siren.active) siren.stop();
    else siren.start(3);
  });
  els.btnSnapshot.addEventListener('click', takeSnapshot);
  els.btnDismissAlarm.addEventListener('click', dismissAlarm);

  els.btnNewPerson.addEventListener('click', () => openPersonForm(null));
  els.btnCancelPerson.addEventListener('click', () => {
    els.personForm.classList.add('hidden');
    state.editing = null;
  });
  els.personForm.addEventListener('submit', savePerson);
  els.btnCaptureFace.addEventListener('click', () => captureFaces(5));
  els.btnCaptureBody.addEventListener('click', captureBody);
  els.btnClearSamples.addEventListener('click', () => {
    if (!state.editing) return;
    state.editing.faceDescriptors = [];
    state.editing.samples = [];
    updateSampleCounts();
  });
  els.peopleList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.card').dataset.id;
    const p = profileById(id);
    if (!p) return;
    if (btn.dataset.act === 'edit') openPersonForm(p);
    if (btn.dataset.act === 'delete' && confirm(`Remove ${p.name}?`)) {
      try {
        await store.deleteProfile(id);
        await loadProfiles();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });

  els.btnRefreshEvents.addEventListener('click', renderEvents);
  els.eventsList.addEventListener('click', onEventAction);

  els.calibPerson.addEventListener('change', () => {
    const p = profileById(els.calibPerson.value);
    if (p) els.calibHeight.value = p.heightCm;
  });
  els.btnCalibStart.addEventListener('click', startCalibration);
  els.btnCalibStop.addEventListener('click', stopCalibration);
  els.btnCalibSave.addEventListener('click', saveCalibration);
  els.btnCalibClear.addEventListener('click', clearCalibration);

  els.settingsForm.addEventListener('submit', saveSettingsForm);
  els.btnSignIn.addEventListener('click', signIn);
  els.btnSignOut.addEventListener('click', signOut);
  els.btnRequestNotify.addEventListener('click', async () => {
    const r = await requestNotificationPermission();
    toast(r === 'granted' ? 'Notifications allowed' : `Notifications: ${r}`, r === 'granted' ? '' : 'error');
  });
  els.btnTestLock.addEventListener('click', async () => {
    const s = readSettingsForm();
    const r = await triggerDoorLock({ url: s.lockWebhookUrl, token: s.lockWebhookToken, action: 'test', reason: 'manual test' });
    toast(r.message, r.ok ? '' : 'error');
  });
  els.btnExport.addEventListener('click', exportData);
  els.importFile.addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  els.btnWipe.addEventListener('click', wipeLocal);

  store.onChange(updateStoreStatus);
  window.addEventListener('beforeunload', () => {
    if (state.running) stopStream();
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    toast(`Error: ${e.reason?.message || e.reason}`, 'error');
  });
}

async function init() {
  bind();
  renderSettings();
  updateArmedUI();
  await store.configure(state.settings);
  await loadProfiles();
  await loadCalibration();
  listCameras();
  if (!navigator.mediaDevices?.getUserMedia) toast('This browser cannot access cameras. Use Chrome, Edge or Safari over HTTPS.', 'error');
}

// Exposed for debugging and the end-to-end test.
window.roomGuard = { state, store, siren, startCamera, stopCamera, identify, summarizeTrack };

init();
