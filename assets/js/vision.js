// Model loading and per-frame inference: MediaPipe pose landmarks, multiclass
// selfie segmentation (for hair) and face-api descriptors (for faces).

import { FilesetResolver, PoseLandmarker, ImageSegmenter } from '../../vendor/mediapipe-tasks-vision-1.0.1.mjs';
import * as faceapi from '../../vendor/face-api-1.7.15.esm.js';
import { ASSETS } from './config.js';

export { faceapi };

const TELEMETRY_HOST = 'odml.pa.googleapis.com';
let telemetryBlocked = false;

/**
 * The MediaPipe web runtime posts anonymous usage logs to Google and offers no
 * option to turn that off. This short-circuits those requests (and nothing else).
 */
export function blockMediaPipeTelemetry() {
  if (telemetryBlocked || typeof window === 'undefined') return;
  telemetryBlocked = true;
  const isTelemetry = (url) => typeof url === 'string' && url.includes(TELEMETRY_HOST);
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      this.__blocked = isTelemetry(String(url));
      return this.__blocked ? undefined : open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      if (this.__blocked) return undefined;
      return send.apply(this, args);
    };
    XHR.prototype.setRequestHeader = ((orig) =>
      function (...args) {
        if (this.__blocked) return undefined;
        return orig.apply(this, args);
      })(XHR.prototype.setRequestHeader);
  }
  const fetch0 = window.fetch;
  if (fetch0) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      if (isTelemetry(url)) return Promise.resolve(new Response('', { status: 204 }));
      return fetch0.call(this, input, init);
    };
  }
}

/** iPhone / iPad (including iPadOS, which reports itself as a Mac with touch). */
export function isAppleMobile() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

const WASM_DIR = new URL('../../vendor/tfjs-wasm/', import.meta.url).href;

export class VisionEngine {
  constructor({ assets = ASSETS, onStatus = () => {} } = {}) {
    this.assets = assets;
    this.onStatus = onStatus;
    this.pose = null;
    this.segmenter = null;
    this.faceReady = false;
    this.loaded = false;
    this.lastPoseTs = -1;
    this.lastSegTs = -1;
    this.delegate = 'GPU';
    this.faceDetector = 'ssd';
    this.tfBackend = null;
    this.float32 = null;
    this.faceOptions = null;
  }

  async load({ delegate = 'GPU', numPoses = 3, blockTelemetry = true, faceDetector = 'ssd', tfBackend = 'auto', withFaces = true, withHair = true } = {}) {
    this.delegate = delegate;
    this.withFaces = withFaces;
    this.withHair = withHair;
    if (blockTelemetry) blockMediaPipeTelemetry();
    this.onStatus('Loading vision runtime…');
    const vision = await FilesetResolver.forVisionTasks(this.assets.mediapipeWasm);
    this.onStatus('Loading pose model…');
    this.pose = await this._create(
      (d) =>
        PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: this.assets.poseModel, delegate: d },
          runningMode: 'VIDEO',
          numPoses,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      delegate,
    );
    if (!withHair && !withFaces) {
      this.loaded = true;
      this.onStatus(`Models ready (pose ${this.delegate})`);
      return;
    }
    if (withHair) {
      this.onStatus('Loading hair segmentation model…');
      this.segmenter = await this._create(
      (d) =>
        ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: this.assets.segmenterModel, delegate: d },
          runningMode: 'VIDEO',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        }),
        delegate,
      );
    }
    if (!withFaces) {
      this.loaded = true;
      this.onStatus(`Models ready (pose ${this.delegate})`);
      return;
    }
    this.onStatus('Preparing face runtime…');
    await this._selectTfBackend(tfBackend);
    this.onStatus('Loading face models…');
    this.faceDetector = faceDetector === 'tiny' ? 'tiny' : 'ssd';
    const detectorNet = this.faceDetector === 'ssd' ? faceapi.nets.ssdMobilenetv1 : faceapi.nets.tinyFaceDetector;
    await Promise.all([
      detectorNet.loadFromUri(this.assets.faceModels),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(this.assets.faceModels),
      faceapi.nets.faceRecognitionNet.loadFromUri(this.assets.faceModels),
    ]);
    this.faceOptions =
      this.faceDetector === 'ssd'
        ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.4 })
        : new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
    this.faceReady = true;
    this.loaded = true;
    this.onStatus(`Models ready (pose ${this.delegate}, face ${this.tfBackend}${this.float32 === false ? ' 16-bit' : ''})`);
  }

  /**
   * Pick the TensorFlow.js backend for the face models. WebGL on iPhone/iPad
   * can only render 16-bit floats, which visibly degrades the 128-d face
   * embeddings, so Apple mobile devices default to the exact WASM backend.
   */
  async _selectTfBackend(pref = 'auto') {
    const tf = faceapi.tf;
    const want = pref === 'auto' ? (isAppleMobile() ? 'wasm' : 'webgl') : pref;
    const attempt = async (name) => {
      if (name === 'wasm') tf.setWasmPaths(WASM_DIR);
      const ok = await tf.setBackend(name);
      if (!ok) throw new Error(`backend ${name} unavailable`);
      await tf.ready();
      return name;
    };
    const order = [want, ...['webgl', 'wasm', 'cpu'].filter((n) => n !== want)];
    for (const name of order) {
      try {
        await attempt(name);
        break;
      } catch (e) {
        console.warn(`TensorFlow.js backend ${name} failed`, e);
      }
    }
    this.tfBackend = tf.getBackend();
    try {
      this.float32 = this.tfBackend === 'webgl' ? !!tf.env().getBool('WEBGL_RENDER_FLOAT32_ENABLED') : true;
    } catch {
      this.float32 = null;
    }
  }

  diagnostics() {
    return {
      poseDelegate: this.delegate,
      faceDetector: this.faceDetector,
      tfBackend: this.tfBackend,
      float32: this.float32,
      appleMobile: isAppleMobile(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    };
  }

  async _create(factory, delegate) {
    try {
      return await factory(delegate);
    } catch (e) {
      if (delegate === 'GPU') {
        console.warn('GPU delegate unavailable, using CPU', e);
        this.delegate = 'CPU';
        return factory('CPU');
      }
      throw e;
    }
  }

  /** @returns {Array<Array>} one landmark array (33 points) per detected person */
  detectPoses(video, timestampMs) {
    if (!this.pose) return [];
    const t = Math.max(timestampMs, this.lastPoseTs + 1);
    this.lastPoseTs = t;
    const res = this.pose.detectForVideo(video, t);
    return res?.landmarks || [];
  }

  /** @returns {{data:Uint8Array,width:number,height:number}|null} category mask copy */
  segmentHair(video, timestampMs) {
    if (!this.segmenter) return null;
    const t = Math.max(timestampMs, this.lastSegTs + 1);
    this.lastSegTs = t;
    let out = null;
    this.segmenter.segmentForVideo(video, t, (result) => {
      const m = result.categoryMask;
      if (m) out = { data: m.getAsUint8Array().slice(), width: m.width, height: m.height };
    });
    return out;
  }

  /** Detect faces and compute 128-d descriptors. Boxes are in video pixel coordinates. */
  async detectFaces(input) {
    if (!this.faceReady || !this.faceOptions) return [];
    const dets = await faceapi.detectAllFaces(input, this.faceOptions).withFaceLandmarks(true).withFaceDescriptors();
    return dets.map((d) => ({
      box: { x: d.detection.box.x, y: d.detection.box.y, w: d.detection.box.width, h: d.detection.box.height },
      score: d.detection.score,
      descriptor: Array.from(d.descriptor),
    }));
  }

  close() {
    try { this.pose?.close(); } catch { /* ignore */ }
    try { this.segmenter?.close(); } catch { /* ignore */ }
    this.pose = null;
    this.segmenter = null;
    this.loaded = false;
  }
}

/**
 * Assign each detected face to the pose whose head it covers.
 * @param {Array} faces from detectFaces()
 * @param {Array} metricsList bodyMetrics() results, same order as poses
 * @returns {Array} face (or null) per metrics entry
 */
export function matchFacesToPoses(faces, metricsList) {
  const out = metricsList.map(() => null);
  const used = new Set();
  for (let i = 0; i < metricsList.length; i++) {
    const m = metricsList[i];
    if (!m) continue;
    const head = m.eyeMid || m.nose || m.earMid;
    if (!head) continue;
    let best = null;
    let bestD = Infinity;
    for (let j = 0; j < faces.length; j++) {
      if (used.has(j)) continue;
      const f = faces[j].box;
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      const inside = head.x >= f.x - f.w * 0.3 && head.x <= f.x + f.w * 1.3 && head.y >= f.y - f.h * 0.3 && head.y <= f.y + f.h * 1.3;
      const d = Math.hypot(head.x - cx, head.y - cy);
      const limit = Math.max(f.w, f.h, m.headHeight || 0) * 0.9;
      if ((inside || d < limit) && d < bestD) {
        best = j;
        bestD = d;
      }
    }
    if (best != null) {
      used.add(best);
      out[i] = faces[best];
    }
  }
  return out;
}
