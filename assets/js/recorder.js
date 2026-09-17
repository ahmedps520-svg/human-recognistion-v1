// Clip recording with MediaRecorder plus JPEG snapshots for thumbnails.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
];

export function pickMimeType(candidates = MIME_CANDIDATES) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export function extensionForMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

export class ClipRecorder {
  constructor(stream, { maxSec = 60 } = {}) {
    this.stream = stream;
    this.maxSec = maxSec;
    this.rec = null;
    this.chunks = [];
    this.startedAt = null;
    this.meta = null;
    this.mimeType = pickMimeType();
    this.maxTimer = null;
    this.onAutoStop = null;
    this.stopPromise = null;
  }

  get supported() {
    return this.mimeType != null && typeof MediaRecorder !== 'undefined';
  }

  get recording() {
    return !!this.rec && this.rec.state === 'recording';
  }

  get elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  start(meta = {}) {
    if (!this.supported || this.recording) return false;
    try {
      this.rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    } catch (e) {
      console.warn('MediaRecorder failed to start', e);
      return false;
    }
    this.chunks = [];
    this.meta = meta;
    this.startedAt = Date.now();
    this.rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
    };
    this.rec.start(1000);
    if (this.maxSec > 0) {
      this.maxTimer = setTimeout(() => {
        if (this.recording) this.onAutoStop?.();
      }, this.maxSec * 1000);
    }
    return true;
  }

  /** Stops and resolves with the finished clip. Safe to call twice. */
  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (!this.rec) return Promise.resolve(null);
    clearTimeout(this.maxTimer);
    const rec = this.rec;
    this.stopPromise = new Promise((resolve) => {
      const finish = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || this.mimeType || 'video/webm' });
        const result = {
          blob,
          // plain type without codec parameters, e.g. "video/webm" (what storage buckets expect)
          mimeType: (blob.type || 'video/webm').split(';')[0].trim(),
          extension: extensionForMime(blob.type),
          startedAt: this.startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - this.startedAt,
          meta: this.meta,
        };
        this.rec = null;
        this.chunks = [];
        this.stopPromise = null;
        resolve(result);
      };
      rec.onstop = finish;
      rec.onerror = finish;
      try {
        if (rec.state !== 'inactive') rec.stop();
        else finish();
      } catch {
        finish();
      }
    });
    return this.stopPromise;
  }
}

/** Draw the current video frame into a canvas scaled to maxWidth. */
export function snapshotCanvas(video, maxWidth = 640) {
  const vw = video.videoWidth || video.width;
  const vh = video.videoHeight || video.height;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxWidth / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.8) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export async function captureSnapshot(video, { maxWidth = 640, quality = 0.8 } = {}) {
  const canvas = snapshotCanvas(video, maxWidth);
  if (!canvas) return null;
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  return { blob, dataUrl: canvas.toDataURL('image/jpeg', 0.6), width: canvas.width, height: canvas.height };
}
