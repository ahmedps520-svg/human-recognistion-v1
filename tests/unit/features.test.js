import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyMetrics, fitCalibration, estimateHeightCm, hairMetrics, refineHeadTop, buildObservation, median,
} from '../../assets/js/features.js';
import { POSE, SEG } from '../../assets/js/config.js';

// Builds a plausible standing person in normalized coordinates. Feet at `feetY`,
// scaled so the figure is `scale` frame-heights tall (head top to feet).
function person({ feetY = 0.9, scale = 0.8, cx = 0.5, kneeBend = 0, yaw = 0, vis = 0.95 } = {}) {
  const top = feetY - scale;
  const u = scale; // 1 body height
  const y = (f) => top + f * u;
  const halfShoulder = 0.12 * u * Math.cos(yaw);
  const z = 0.12 * u * Math.sin(yaw);
  const lm = Array.from({ length: 33 }, () => ({ x: cx, y: y(0.5), z: 0, visibility: 0 }));
  const set = (i, x, yy, zz = 0, v = vis) => (lm[i] = { x, y: yy, z: zz, visibility: v });
  // head: eyes at 0.06 of body height, mouth at 0.1, ears at 0.065
  set(POSE.NOSE, cx, y(0.08));
  set(POSE.LEFT_EYE, cx + 0.02 * u, y(0.06));
  set(POSE.RIGHT_EYE, cx - 0.02 * u, y(0.06));
  set(POSE.LEFT_EAR, cx + 0.045 * u, y(0.068));
  set(POSE.RIGHT_EAR, cx - 0.045 * u, y(0.068));
  set(POSE.MOUTH_LEFT, cx + 0.012 * u, y(0.1));
  set(POSE.MOUTH_RIGHT, cx - 0.012 * u, y(0.1));
  set(POSE.LEFT_SHOULDER, cx + halfShoulder, y(0.19), z);
  set(POSE.RIGHT_SHOULDER, cx - halfShoulder, y(0.19), -z);
  set(POSE.LEFT_HIP, cx + 0.09 * u * Math.cos(yaw), y(0.5), z * 0.75);
  set(POSE.RIGHT_HIP, cx - 0.09 * u * Math.cos(yaw), y(0.5), -z * 0.75);
  const kneeDx = kneeBend * 0.15 * u;
  set(POSE.LEFT_KNEE, cx + 0.06 * u + kneeDx, y(0.73));
  set(POSE.RIGHT_KNEE, cx - 0.06 * u + kneeDx, y(0.73));
  set(POSE.LEFT_ANKLE, cx + 0.06 * u, y(0.97));
  set(POSE.RIGHT_ANKLE, cx - 0.06 * u, y(0.97));
  set(POSE.LEFT_HEEL, cx + 0.06 * u, y(1.0));
  set(POSE.RIGHT_HEEL, cx - 0.06 * u, y(1.0));
  set(POSE.LEFT_FOOT_INDEX, cx + 0.08 * u, y(1.0));
  set(POSE.RIGHT_FOOT_INDEX, cx - 0.08 * u, y(1.0));
  return lm;
}

const W = 640;
const H = 480;

test('bodyMetrics: standing full-body person yields usable height and build', () => {
  const m = bodyMetrics(person(), W, H);
  assert.ok(m, 'metrics computed');
  assert.equal(m.standing, true);
  assert.equal(m.feetVisible, true);
  assert.equal(m.headQuality, 1);
  assert.ok(m.heightUsable, 'height usable');
  // Head top should land close to the synthetic top (feetY - scale) = 0.1 * H
  assert.ok(Math.abs(m.headTopY - 0.1 * H) < 0.03 * H, `headTop ${m.headTopY} vs ${0.1 * H}`);
  assert.ok(Math.abs(m.pixelHeight - 0.8 * H) < 0.04 * H, `pixelHeight ${m.pixelHeight}`);
  assert.ok(m.build > 0.5 && m.build < 1.2, `build ${m.build}`);
  assert.ok(m.facing > 0.9, 'facing camera');
  assert.ok(m.box.w > 0 && m.box.h > 0);
});

test('bodyMetrics: crouching person is not standing, so height is not usable', () => {
  const m = bodyMetrics(person({ kneeBend: 1 }), W, H);
  assert.ok(m);
  assert.equal(m.standing, false);
  assert.equal(m.heightUsable, false);
});

test('bodyMetrics: feet cut off at the frame edge disables height', () => {
  const m = bodyMetrics(person({ feetY: 1.0 }), W, H);
  assert.ok(m);
  assert.equal(m.feetVisible, false);
  assert.equal(m.heightUsable, false);
});

test('bodyMetrics: sideways person has no build estimate', () => {
  const m = bodyMetrics(person({ yaw: Math.PI / 2.2 }), W, H);
  assert.ok(m);
  assert.ok(m.facing < 0.5, `facing ${m.facing}`);
  assert.equal(m.build, null);
});

test('bodyMetrics: returns null for garbage input', () => {
  assert.equal(bodyMetrics(null, W, H), null);
  assert.equal(bodyMetrics([], W, H), null);
  const invisible = person({ vis: 0.1 });
  assert.equal(bodyMetrics(invisible, W, H), null);
});

test('calibration: fit from a known person recovers another person\'s height', () => {
  // Ground truth camera: scale (frame-fraction per cm) grows as feet move down the frame.
  const truth = (fy) => 0.0025 + 0.004 * fy;
  const ref = 172;
  const samples = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5);
  for (let fy = 0.55; fy <= 0.98; fy += 0.02) {
    samples.push({ fy, ph: ref * truth(fy) * (1 + 0.02 * rnd()) });
  }
  samples.push({ fy: 0.7, ph: ref * truth(0.7) * 0.7 }); // a crouch: outlier
  const calib = fitCalibration(samples, ref);
  assert.ok(calib);
  assert.ok(calib.rmseCm < 4, `rmse ${calib.rmseCm}`);
  const child = 112;
  const est = estimateHeightCm(calib, 0.8, child * truth(0.8));
  assert.ok(est && Math.abs(est.cm - child) < 3, `estimated ${est && est.cm}`);
  assert.equal(est.extrapolated, false);
  const far = estimateHeightCm(calib, 0.3, child * truth(0.3));
  assert.ok(far && far.extrapolated, 'flags extrapolation outside the calibrated floor area');
});

test('calibration: few samples fall back to a constant scale', () => {
  const calib = fitCalibration([{ fy: 0.9, ph: 0.8 }, { fy: 0.9, ph: 0.82 }], 170);
  assert.ok(calib);
  assert.equal(calib.a, 0);
  const est = estimateHeightCm(calib, 0.9, 0.81);
  assert.ok(Math.abs(est.cm - 170) < 3);
  assert.equal(fitCalibration([], 170), null);
  assert.equal(fitCalibration([{ fy: 0.9, ph: 0.8 }], 0), null);
});

test('hairMetrics: measures how far hair hangs below the ears', () => {
  const m = bodyMetrics(person(), W, H);
  const maskW = 160;
  const maskH = 120;
  const mask = new Uint8Array(maskW * maskH);
  const sx = maskW / W;
  const sy = maskH / H;
  // paint hair from a little above the head top down to one head-height below ear level
  const earY = m.earMid.y;
  const hairBottom = earY + 1.0 * m.headHeight;
  const hairTop = m.headTopY - 0.1 * m.headHeight;
  for (let y = Math.floor(hairTop * sy); y < hairBottom * sy; y++) {
    for (let x = Math.floor((m.headCenterX - m.headWidth) * sx); x <= (m.headCenterX + m.headWidth) * sx; x++) {
      mask[y * maskW + x] = SEG.HAIR;
    }
  }
  const hair = hairMetrics(mask, maskW, maskH, m, W, H);
  assert.ok(hair && hair.hairIndex != null, 'hair found');
  assert.ok(Math.abs(hair.hairIndex - 1.0) < 0.2, `hair index ${hair.hairIndex}`);
  assert.ok(hair.hairTopY < m.headTopY);
  const refined = refineHeadTop(m, hair);
  assert.ok(refined.headTopY <= m.headTopY);
  assert.ok(refined.pixelHeight >= m.pixelHeight);

  const empty = hairMetrics(new Uint8Array(maskW * maskH), maskW, maskH, m, W, H);
  assert.equal(empty.hairIndex, null);
});

test('buildObservation: uses calibration only when the height is usable', () => {
  const m = bodyMetrics(person(), W, H);
  const calib = { a: 0, b: (m.pixelHeight / H) / 165, fyMin: 0.5, fyMax: 1, rmseCm: 1 };
  const obs = buildObservation({ metrics: m, hair: { hairIndex: 0.2 }, calib, faceDescriptor: null, frameHeight: H });
  assert.ok(Math.abs(obs.heightCm - 165) < 0.5, `height ${obs.heightCm}`);
  assert.equal(obs.hair, 0.2);
  assert.ok(obs.build > 0);
  const crouch = bodyMetrics(person({ kneeBend: 1 }), W, H);
  const obs2 = buildObservation({ metrics: crouch, hair: null, calib, frameHeight: H });
  assert.equal(obs2.heightCm, null);
  assert.equal(obs2.hair, null);
});

test('median ignores non-finite values', () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
  assert.equal(median([]), null);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
