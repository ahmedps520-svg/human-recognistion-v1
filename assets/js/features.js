// Pure feature extraction: turns pose landmarks and a hair segmentation mask
// into the body cues the identifier uses (approximate height, build, hair
// length). No DOM or model dependencies so it can be unit tested in Node.

import { POSE, SEG } from './config.js';

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 });

export function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function toPixels(landmarks, width, height) {
  // MediaPipe normalizes x/y to [0,1]; z is roughly on the same scale as x.
  return landmarks.map((l) => ({
    x: l.x * width,
    y: l.y * height,
    z: (l.z ?? 0) * width,
    v: l.visibility ?? 1,
  }));
}

function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const n = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
  return (Math.acos(clamp((v1.x * v2.x + v1.y * v2.y) / n, -1, 1)) * 180) / Math.PI;
}

/**
 * Compute geometric body cues from one person's 33 pose landmarks.
 * @param {Array<{x:number,y:number,z?:number,visibility?:number}>} landmarks normalized landmarks
 * @param {number} width frame width in px
 * @param {number} height frame height in px
 * @returns {object|null} metrics in pixel units, or null when too little of the body is visible
 */
export function bodyMetrics(landmarks, width, height, { minVis = 0.5 } = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 33 || !width || !height) return null;
  const P = toPixels(landmarks, width, height);
  const get = (i) => (P[i] && P[i].v >= minVis && Number.isFinite(P[i].x) ? P[i] : null);

  const visible = P.filter((p) => p.v >= minVis);
  if (visible.length < 4) return null;

  const nose = get(POSE.NOSE);
  const lEye = get(POSE.LEFT_EYE);
  const rEye = get(POSE.RIGHT_EYE);
  const lEar = get(POSE.LEFT_EAR);
  const rEar = get(POSE.RIGHT_EAR);
  const lMouth = get(POSE.MOUTH_LEFT);
  const rMouth = get(POSE.MOUTH_RIGHT);
  const lSh = get(POSE.LEFT_SHOULDER);
  const rSh = get(POSE.RIGHT_SHOULDER);
  const lHip = get(POSE.LEFT_HIP);
  const rHip = get(POSE.RIGHT_HIP);
  const lKnee = get(POSE.LEFT_KNEE);
  const rKnee = get(POSE.RIGHT_KNEE);
  const lAnkle = get(POSE.LEFT_ANKLE);
  const rAnkle = get(POSE.RIGHT_ANKLE);
  const feetPts = [
    lAnkle, rAnkle,
    get(POSE.LEFT_HEEL), get(POSE.RIGHT_HEEL),
    get(POSE.LEFT_FOOT_INDEX), get(POSE.RIGHT_FOOT_INDEX),
  ].filter(Boolean);

  const pair = (a, b) => (a && b ? mid(a, b) : a || b || null);
  const eyeMid = pair(lEye, rEye);
  const mouthMid = pair(lMouth, rMouth);
  const earMid = pair(lEar, rEar);
  const shoulderMid = pair(lSh, rSh);
  const hipMid = pair(lHip, rHip);

  // --- Head size and top-of-head estimate (human proportions) ---
  let headHeight = null;
  let headTopY = null;
  let headQuality = 0;
  if (eyeMid && mouthMid && mouthMid.y - eyeMid.y > 1) {
    const eyeToMouth = mouthMid.y - eyeMid.y; // about a third of the head height
    headHeight = 3.0 * eyeToMouth;
    headTopY = eyeMid.y - 1.35 * eyeToMouth;
    headQuality = 1;
  } else if (lEar && rEar && Math.abs(lEar.x - rEar.x) > 2) {
    headHeight = 1.5 * Math.abs(lEar.x - rEar.x);
    headTopY = earMid.y - 0.45 * headHeight;
    headQuality = 0.6;
  } else if (nose && shoulderMid && shoulderMid.y - nose.y > 1) {
    headHeight = 1.18 * (shoulderMid.y - nose.y);
    headTopY = nose.y - 0.6 * headHeight;
    headQuality = 0.3;
  }
  const headWidth = lEar && rEar ? Math.abs(lEar.x - rEar.x) : headHeight ? headHeight * 0.7 : null;
  const headCenterX = earMid?.x ?? nose?.x ?? eyeMid?.x ?? shoulderMid?.x ?? null;

  // --- Feet ---
  const feetY = feetPts.length ? Math.max(...feetPts.map((p) => p.y)) : null;
  const feetInFrame = feetY != null && feetY < height * 0.985;
  const feetVisible = !!(lAnkle || rAnkle) && feetInFrame;

  // --- Posture ---
  const kneeAngles = [];
  if (lHip && lKnee && lAnkle) kneeAngles.push(angleAt(lHip, lKnee, lAnkle));
  if (rHip && rKnee && rAnkle) kneeAngles.push(angleAt(rHip, rKnee, rAnkle));
  const kneeAngle = kneeAngles.length ? Math.min(...kneeAngles) : null;
  let torsoTilt = null;
  if (shoulderMid && hipMid) {
    torsoTilt = Math.abs(Math.atan2(shoulderMid.x - hipMid.x, hipMid.y - shoulderMid.y)) * (180 / Math.PI);
  }
  const standing = kneeAngle != null && kneeAngle > 150 && torsoTilt != null && torsoTilt < 25;

  // --- Facing the camera? (yaw from shoulder depth difference) ---
  let facing = null;
  if (lSh && rSh) {
    const dx = Math.abs(lSh.x - rSh.x);
    const dz = Math.abs((lSh.z ?? 0) - (rSh.z ?? 0));
    const yaw = (Math.atan2(dz, Math.max(dx, 1e-6)) * 180) / Math.PI;
    facing = clamp(1 - yaw / 60, 0, 1);
  }

  const shoulderWidth = lSh && rSh ? dist(lSh, rSh) : null;
  const hipWidth = lHip && rHip ? dist(lHip, rHip) : null;
  const torsoLength = shoulderMid && hipMid ? dist(shoulderMid, hipMid) : null;

  const pixelHeight = headTopY != null && feetY != null ? feetY - headTopY : null;
  const heightUsable = pixelHeight != null && pixelHeight > 0 && feetVisible && standing && headQuality >= 0.6;

  // Build (weight proxy): body width relative to torso length, scale invariant.
  let build = null;
  if (shoulderWidth && hipWidth && torsoLength > 1 && facing != null && facing >= 0.5) {
    build = (shoulderWidth + hipWidth) / (2 * torsoLength);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of visible) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (headTopY != null) minY = Math.min(minY, headTopY);
  if (headWidth) {
    minX = Math.min(minX, (headCenterX ?? minX) - headWidth * 0.7);
    maxX = Math.max(maxX, (headCenterX ?? maxX) + headWidth * 0.7);
  }
  const box = {
    x: clamp(minX, 0, width),
    y: clamp(minY, 0, height),
    w: clamp(maxX, 0, width) - clamp(minX, 0, width),
    h: clamp(maxY, 0, height) - clamp(minY, 0, height),
  };

  return {
    box,
    nose, eyeMid, mouthMid, earMid, shoulderMid, hipMid,
    headTopY, headHeight, headWidth, headQuality, headCenterX,
    feetY, feetVisible,
    kneeAngle, torsoTilt, standing, facing,
    shoulderWidth, hipWidth, torsoLength,
    pixelHeight, heightUsable, build,
    points: P,
  };
}

/**
 * Fit the floor calibration model from samples of one person with a known height.
 * The camera is fixed, so the pixel scale (frame-height fractions per cm) at a
 * given floor position is a smooth function of where the feet appear in the
 * frame. We model it as scale = a * fy + b, with fy and ph normalized by the
 * frame height.
 * @param {Array<{fy:number, ph:number}>} samples feet Y and pixel height as fractions of frame height
 * @param {number} refHeightCm the real height of the person in the samples
 */
export function fitCalibration(samples, refHeightCm) {
  if (!Number.isFinite(refHeightCm) || refHeightCm <= 0) return null;
  let pts = (samples || [])
    .filter((s) => Number.isFinite(s.fy) && Number.isFinite(s.ph) && s.ph > 0)
    .map((s) => ({ x: s.fy, y: s.ph / refHeightCm, ph: s.ph }));
  if (!pts.length) return null;

  const fit = (P) => {
    const n = P.length;
    const xs = P.map((p) => p.x);
    const spread = Math.max(...xs) - Math.min(...xs);
    const mx = mean(xs);
    const my = mean(P.map((p) => p.y));
    if (n < 3 || spread < 0.03) return { a: 0, b: my };
    let sxx = 0;
    let sxy = 0;
    for (const p of P) {
      sxx += (p.x - mx) ** 2;
      sxy += (p.x - mx) * (p.y - my);
    }
    const a = sxx > 0 ? sxy / sxx : 0;
    return { a, b: my - a * mx };
  };

  let model = fit(pts);
  if (pts.length >= 6) {
    // One pass of outlier rejection (a crouch, a wrong detection, a pet).
    const errs = pts.map((p) => p.ph / (model.a * p.x + model.b) - refHeightCm);
    const m = mean(errs);
    const sd = Math.sqrt(mean(errs.map((e) => (e - m) ** 2)) || 0);
    if (sd > 0) {
      const kept = pts.filter((_, i) => Math.abs(errs[i] - m) <= 2 * sd);
      if (kept.length >= 3 && kept.length < pts.length) {
        pts = kept;
        model = fit(pts);
      }
    }
  }
  const predicted = pts.map((p) => p.ph / (model.a * p.x + model.b));
  const rmseCm = Math.sqrt(mean(predicted.map((h) => (h - refHeightCm) ** 2)) || 0);
  const xs = pts.map((p) => p.x);
  return {
    version: 1,
    a: model.a,
    b: model.b,
    n: pts.length,
    refHeightCm,
    fyMin: Math.min(...xs),
    fyMax: Math.max(...xs),
    rmseCm,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Estimate a standing person's height from the calibration model.
 * @param {object} calib result of fitCalibration
 * @param {number} fy feet Y as a fraction of frame height
 * @param {number} ph pixel height as a fraction of frame height
 */
export function estimateHeightCm(calib, fy, ph) {
  if (!calib || !Number.isFinite(fy) || !Number.isFinite(ph) || ph <= 0) return null;
  const s = calib.a * fy + calib.b;
  if (!(s > 1e-6)) return null;
  const cm = ph / s;
  if (!Number.isFinite(cm) || cm < 40 || cm > 250) return null;
  const extrapolated = fy < calib.fyMin - 0.08 || fy > calib.fyMax + 0.08;
  return { cm, extrapolated };
}

/**
 * Measure hair from the multiclass segmentation mask around one person's head.
 * @param {Uint8Array} mask category mask (row-major), values from SEG
 * @param {number} maskW mask width
 * @param {number} maskH mask height
 * @param {object} m bodyMetrics() result for that person
 * @param {number} frameW frame width in px
 * @param {number} frameH frame height in px
 */
export function hairMetrics(mask, maskW, maskH, m, frameW, frameH) {
  if (!mask || !m || !m.headHeight || m.headCenterX == null || !(m.earMid || m.eyeMid)) return null;
  const sx = maskW / frameW;
  const sy = maskH / frameH;
  if (m.headHeight * sy < 4) return null; // too small in the mask to say anything

  const halfW = Math.max(m.headWidth ?? 0, m.headHeight * 0.6) * 1.4;
  const x0 = clamp(Math.floor((m.headCenterX - halfW) * sx), 0, maskW - 1);
  const x1 = clamp(Math.ceil((m.headCenterX + halfW) * sx), 0, maskW - 1);
  const topY = m.headTopY - m.headHeight * 0.6;
  const bottomLimit = m.hipMid
    ? m.hipMid.y
    : m.shoulderMid
      ? m.shoulderMid.y + 1.5 * m.headHeight
      : m.headTopY + 3 * m.headHeight;
  const y0 = clamp(Math.floor(topY * sy), 0, maskH - 1);
  const y1 = clamp(Math.ceil(bottomLimit * sy), 0, maskH - 1);
  const bandW = x1 - x0 + 1;
  const minCount = Math.max(1, Math.round(bandW * 0.06));

  let top = -1;
  let bottom = -1;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * maskW;
    let c = 0;
    for (let x = x0; x <= x1; x++) if (mask[row + x] === SEG.HAIR) c++;
    total += c;
    if (c >= minCount) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  const headArea = bandW * (m.headHeight * sy);
  if (top < 0) return { hairIndex: null, coverage: total / headArea, hairTopY: null, hairBottomY: null };

  const hairTopY = top / sy;
  const hairBottomY = (bottom + 1) / sy;
  const earY = m.earMid?.y ?? m.eyeMid.y;
  const hairIndex = clamp((hairBottomY - earY) / m.headHeight, -0.5, 3);
  return { hairIndex, hairTopY, hairBottomY, coverage: total / headArea };
}

/** Use the hair mask to refine the top-of-head estimate (hair is part of the silhouette). */
export function refineHeadTop(m, hair) {
  if (!m || !hair || hair.hairTopY == null || m.headTopY == null) return m;
  const lift = m.headTopY - hair.hairTopY;
  if (lift > 0 && lift < 0.6 * m.headHeight) {
    const headTopY = hair.hairTopY;
    const pixelHeight = m.feetY != null ? m.feetY - headTopY : m.pixelHeight;
    return { ...m, headTopY, pixelHeight, box: { ...m.box, y: Math.min(m.box.y, headTopY), h: m.box.h + Math.max(0, m.box.y - headTopY) } };
  }
  return m;
}

/**
 * Assemble the observation the identifier consumes.
 */
export function buildObservation({ metrics, hair, calib, faceDescriptor, frameHeight }) {
  let heightCm = null;
  let heightExtrapolated = false;
  if (metrics && metrics.heightUsable && calib && frameHeight) {
    const est = estimateHeightCm(calib, metrics.feetY / frameHeight, metrics.pixelHeight / frameHeight);
    if (est) {
      heightCm = est.cm;
      heightExtrapolated = est.extrapolated;
    }
  }
  return {
    heightCm,
    heightExtrapolated,
    build: metrics?.build ?? null,
    hair: hair?.hairIndex ?? null,
    faceDescriptor: faceDescriptor || null,
  };
}
