// Pure identification logic: scores an observation against enrolled profiles,
// decides known / ambiguous / unknown / insufficient, and smooths the decision
// over time per tracked person.

import { MATCH, HAIR_LENGTH_INDEX } from './config.js';
import { median, clamp } from './features.js';

export function euclidean(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export function faceDistance(descriptor, descriptors) {
  if (!descriptor || !Array.isArray(descriptors) || !descriptors.length) return null;
  let best = Infinity;
  for (const d of descriptors) {
    if (!d || d.length !== descriptor.length) continue;
    const v = euclidean(descriptor, d);
    if (v < best) best = v;
  }
  return Number.isFinite(best) ? best : null;
}

export const gaussianScore = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);

export const faceScore = (d, cfg = MATCH.face) => 1 - clamp((d - cfg.zero) / cfg.span, 0, 1);

/** What the system expects to measure for a profile: learned from confirmed samples when enough exist, else from the enrolled values. */
export function profileExpectations(profile, cfg = MATCH) {
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const learned = (key) => {
    const v = samples.map((s) => s && s[key]).filter(Number.isFinite);
    return v.length >= cfg.minSamplesForLearned ? median(v) : null;
  };
  const learnedHeight = learned('height');
  const learnedHair = learned('hair');
  const learnedBuild = learned('build');
  return {
    height: learnedHeight ?? (Number.isFinite(profile.heightCm) ? profile.heightCm : null),
    hair: learnedHair ?? (profile.hairLength in HAIR_LENGTH_INDEX ? HAIR_LENGTH_INDEX[profile.hairLength] : null),
    build: learnedBuild,
    learned: { height: learnedHeight != null, hair: learnedHair != null, build: learnedBuild != null },
  };
}

export function scoreObservation(obs, profile, cfg = MATCH) {
  const exp = profileExpectations(profile, cfg);
  const parts = {};
  let wsum = 0;
  let ssum = 0;
  const add = (key, w, s, extra) => {
    parts[key] = { s, w, ...extra };
    wsum += w;
    ssum += w * s;
  };
  if (obs.faceDescriptor && Array.isArray(profile.faceDescriptors) && profile.faceDescriptors.length) {
    const d = faceDistance(obs.faceDescriptor, profile.faceDescriptors);
    if (d != null) add('face', cfg.weights.face, faceScore(d, cfg.face), { d });
  }
  if (Number.isFinite(obs.heightCm) && exp.height != null) {
    const w = cfg.weights.height * (obs.heightExtrapolated ? 0.5 : 1);
    add('height', w, gaussianScore(obs.heightCm, exp.height, cfg.sigma.height), { observed: obs.heightCm, expected: exp.height });
  }
  if (Number.isFinite(obs.hair) && exp.hair != null) {
    add('hair', cfg.weights.hair, gaussianScore(obs.hair, exp.hair, cfg.sigma.hair), { observed: obs.hair, expected: exp.hair });
  }
  if (Number.isFinite(obs.build) && exp.build != null) {
    add('build', cfg.weights.build, gaussianScore(obs.build, exp.build, cfg.sigma.build), { observed: obs.build, expected: exp.build });
  }
  return {
    profileId: profile.id,
    name: profile.name,
    score: wsum > 0 ? ssum / wsum : 0,
    evidence: wsum,
    parts,
  };
}

function verdictFrom(ranked, { threshold, margin, cfg }) {
  const strong = ranked
    .filter((r) => r.parts.face && r.parts.face.d <= cfg.face.strong)
    .sort((a, b) => a.parts.face.d - b.parts.face.d)[0];
  if (strong) return { verdict: 'known', best: strong, confidence: Math.max(strong.score, 0.9), ranked };
  const best = ranked[0];
  const maxEvidence = ranked.reduce((m, r) => Math.max(m, r.evidence), 0);
  if (!best || maxEvidence < cfg.minEvidence) return { verdict: 'insufficient', best: null, confidence: 0, ranked };
  const second = ranked[1];
  if (best.score >= threshold) {
    if (!second || best.score - second.score >= margin) {
      return { verdict: 'known', best, confidence: best.score, ranked };
    }
    return { verdict: 'ambiguous', best, confidence: best.score, ranked };
  }
  return { verdict: 'unknown', best, confidence: best.score, ranked };
}

/**
 * Identify one observation against the enrolled profiles.
 * verdicts: known | ambiguous (one of several known people) | unknown (stranger) | insufficient (not enough cues yet)
 */
export function identify(obs, profiles, opts = {}) {
  const cfg = { ...MATCH, ...(opts.match || {}) };
  const threshold = opts.threshold ?? 0.62;
  const margin = opts.margin ?? 0.08;
  const ranked = (profiles || []).map((p) => scoreObservation(obs, p, cfg)).sort((a, b) => b.score - a.score);
  return verdictFrom(ranked, { threshold, margin, cfg });
}

export function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

let nextTrackId = 1;

/**
 * Keeps people consistent across frames and averages their identification.
 */
export class Tracker {
  constructor({ maxAgeMs = 1500, windowMs = 3000, iouThreshold = 0.3, threshold = 0.62, margin = 0.08, match = null } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.windowMs = windowMs;
    this.iouThreshold = iouThreshold;
    this.threshold = threshold;
    this.margin = margin;
    this.cfg = { ...MATCH, ...(match || {}) };
    this.tracks = [];
  }

  setOptions({ threshold, margin } = {}) {
    if (Number.isFinite(threshold)) this.threshold = threshold;
    if (Number.isFinite(margin)) this.margin = margin;
  }

  /**
   * @param {Array<{box:{x,y,w,h}, obs:object, result:object}>} detections per-frame detections with identify() results
   * @param {number} t timestamp in ms
   */
  update(detections, t) {
    const unmatched = new Set(detections.map((_, i) => i));
    const pairs = [];
    for (const tr of this.tracks) {
      for (let i = 0; i < detections.length; i++) {
        const d = detections[i];
        const v = iou(tr.box, d.box);
        if (v >= this.iouThreshold) pairs.push({ tr, i, v });
        else {
          const cx = tr.box.x + tr.box.w / 2 - (d.box.x + d.box.w / 2);
          const cy = tr.box.y + tr.box.h / 2 - (d.box.y + d.box.h / 2);
          const diag = Math.hypot(tr.box.w, tr.box.h) || 1;
          const rel = Math.hypot(cx, cy) / diag;
          if (rel < 0.5) pairs.push({ tr, i, v: 0.2 * (1 - rel) });
        }
      }
    }
    pairs.sort((a, b) => b.v - a.v);
    const usedTracks = new Set();
    for (const p of pairs) {
      if (usedTracks.has(p.tr.id) || !unmatched.has(p.i)) continue;
      usedTracks.add(p.tr.id);
      unmatched.delete(p.i);
      this._absorb(p.tr, detections[p.i], t);
    }
    for (const i of unmatched) {
      const tr = {
        id: nextTrackId++,
        box: detections[i].box,
        firstSeen: t,
        lastSeen: t,
        frames: 0,
        history: [],
        heights: [],
        builds: [],
        hairs: [],
        faces: [],
        identity: { verdict: 'insufficient', profileId: null, name: null, confidence: 0 },
        unknownSince: null,
      };
      this._absorb(tr, detections[i], t);
      this.tracks.push(tr);
    }
    const ended = [];
    this.tracks = this.tracks.filter((tr) => {
      if (t - tr.lastSeen > this.maxAgeMs) {
        ended.push(tr);
        return false;
      }
      return true;
    });
    for (const tr of this.tracks) this._decide(tr, t);
    return { active: this.tracks, ended };
  }

  _absorb(tr, det, t) {
    tr.box = det.box;
    tr.lastSeen = t;
    tr.frames += 1;
    tr.history.push({ t, ranked: det.result?.ranked || [] });
    const cutoff = t - this.windowMs;
    while (tr.history.length && tr.history[0].t < cutoff) tr.history.shift();
    const obs = det.obs || {};
    const pushCapped = (arr, v, cap = 90) => {
      if (Number.isFinite(v)) {
        arr.push(v);
        if (arr.length > cap) arr.shift();
      }
    };
    pushCapped(tr.heights, obs.heightExtrapolated ? null : obs.heightCm);
    pushCapped(tr.builds, obs.build);
    pushCapped(tr.hairs, obs.hair);
    if (obs.faceDescriptor) {
      const best = det.result?.ranked?.find((r) => r.parts.face)?.parts.face.d ?? Infinity;
      tr.faces.push({ t, descriptor: Array.from(obs.faceDescriptor), d: best });
      tr.faces.sort((a, b) => a.d - b.d);
      if (tr.faces.length > 5) tr.faces.length = 5;
    }
    if (det.snapshot) tr.snapshot = det.snapshot;
  }

  _decide(tr, t) {
    // Average each profile's score over the window, weighted by evidence, and
    // keep the best face distance seen so a clear face wins immediately.
    const acc = new Map();
    for (const h of tr.history) {
      for (const r of h.ranked) {
        let a = acc.get(r.profileId);
        if (!a) {
          a = { profileId: r.profileId, name: r.name, s: 0, w: 0, faceD: Infinity, n: 0 };
          acc.set(r.profileId, a);
        }
        a.s += r.score * r.evidence;
        a.w += r.evidence;
        a.n += 1;
        if (r.parts.face && r.parts.face.d < a.faceD) a.faceD = r.parts.face.d;
      }
    }
    const ranked = [...acc.values()]
      .map((a) => ({
        profileId: a.profileId,
        name: a.name,
        score: a.w > 0 ? a.s / a.w : 0,
        evidence: a.w / Math.max(1, tr.history.length),
        parts: Number.isFinite(a.faceD) ? { face: { d: a.faceD } } : {},
      }))
      .sort((a, b) => b.score - a.score);
    const v = verdictFrom(ranked, { threshold: this.threshold, margin: this.margin, cfg: this.cfg });
    const stable = tr.frames >= 5 && t - tr.firstSeen >= 800;
    tr.identity = {
      verdict: v.verdict,
      profileId: v.best?.profileId ?? null,
      name: v.best?.name ?? null,
      confidence: v.confidence,
      stable,
      ranked,
    };
    if (v.verdict === 'unknown' && stable) {
      if (tr.unknownSince == null) tr.unknownSince = t;
    } else {
      tr.unknownSince = null;
    }
  }
}

/** Condense a track into the record stored with an event. */
export function summarizeTrack(tr) {
  return {
    trackId: tr.id,
    firstSeen: tr.firstSeen,
    lastSeen: tr.lastSeen,
    frames: tr.frames,
    heightCm: median(tr.heights),
    build: median(tr.builds),
    hair: median(tr.hairs),
    faceDescriptors: tr.faces.slice(0, 3).map((f) => f.descriptor),
    identity: {
      verdict: tr.identity.verdict,
      profileId: tr.identity.profileId,
      name: tr.identity.name,
      confidence: tr.identity.confidence,
      ranked: (tr.identity.ranked || []).slice(0, 3).map((r) => ({ profileId: r.profileId, name: r.name, score: r.score })),
    },
  };
}
