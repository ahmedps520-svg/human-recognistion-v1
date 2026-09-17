import test from 'node:test';
import assert from 'node:assert/strict';
import {
  identify, scoreObservation, profileExpectations, faceDistance, Tracker, summarizeTrack, iou,
} from '../../assets/js/identify.js';

// Deterministic pseudo-random 128-d descriptors; independent seeds are ~0.9 apart,
// near() produces a copy ~0.16 away (a clear same-person match).
const vec = (seed) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return Array.from({ length: 128 }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 4294967296 - 0.5) * 0.2;
  });
};
const near = (v, eps = 0.02) => v.map((x, i) => x + eps * Math.cos(i));

const profiles = [
  { id: 'mom', name: 'Mom', heightCm: 160, hairLength: 'long', faceDescriptors: [vec(1)], samples: [] },
  { id: 'dad', name: 'Dad', heightCm: 178, hairLength: 'short', faceDescriptors: [vec(2)], samples: [] },
  { id: 'me', name: 'Me', heightCm: 175, hairLength: 'short', faceDescriptors: [vec(3)], samples: [] },
  { id: 'baby', name: 'Baby brother', heightCm: 80, hairLength: 'short', faceDescriptors: [], samples: [] },
  { id: 'nanny', name: 'Nanny', heightCm: 158, hairLength: 'medium', faceDescriptors: [vec(4)], samples: [] },
];

test('body cues alone identify a clearly distinct person', () => {
  const r = identify({ heightCm: 161, hair: 1.5, build: null, faceDescriptor: null }, profiles);
  assert.equal(r.verdict, 'known');
  assert.equal(r.best.profileId, 'mom');
  assert.ok(r.confidence > 0.8);
});

test('two people with similar bodies give an ambiguous verdict, not an alarm', () => {
  const r = identify({ heightCm: 176.5, hair: 0.1, build: null, faceDescriptor: null }, profiles);
  assert.equal(r.verdict, 'ambiguous');
  assert.ok(['dad', 'me'].includes(r.best.profileId));
});

test('a clear face match wins even when the body cues disagree', () => {
  const r = identify({ heightCm: 160, hair: 1.5, build: null, faceDescriptor: near(vec(2)) }, profiles);
  assert.equal(r.verdict, 'known');
  assert.equal(r.best.profileId, 'dad');
  assert.ok(r.confidence >= 0.9);
});

test('a stranger with a visible face and a matching height is unknown', () => {
  const r = identify({ heightCm: 160, hair: 1.5, build: null, faceDescriptor: vec(99) }, profiles);
  assert.equal(r.verdict, 'unknown');
});

test('no cues at all is insufficient evidence', () => {
  const r = identify({ heightCm: null, hair: null, build: null, faceDescriptor: null }, profiles);
  assert.equal(r.verdict, 'insufficient');
  assert.equal(r.best, null);
  assert.equal(identify({ heightCm: 170 }, []).verdict, 'insufficient');
});

test('a height far from everyone is unknown', () => {
  const r = identify({ heightCm: 120, hair: 0.1 }, profiles);
  assert.equal(r.verdict, 'unknown');
});

test('learned samples override the enrolled values once there are enough', () => {
  const p = { ...profiles[0], samples: [{ height: 166 }, { height: 167 }, { height: 165, hair: 1.2 }] };
  const e = profileExpectations(p);
  assert.equal(e.height, 166);
  assert.equal(e.learned.height, true);
  assert.equal(e.learned.hair, false, 'hair needs three samples too');
  assert.equal(e.hair, 1.6);
  const s = scoreObservation({ heightCm: 166, hair: 1.6 }, p);
  assert.ok(s.parts.height.s > 0.99);
});

test('faceDistance skips malformed descriptors', () => {
  assert.equal(faceDistance(vec(1), [[1, 2, 3], null]), null);
  assert.ok(faceDistance(vec(1), [vec(5), vec(1)]) < 1e-9);
});

test('iou basics', () => {
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1);
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }), 0);
});

test('tracker keeps one track for a slowly moving person and smooths identity', () => {
  const tr = new Tracker({ maxAgeMs: 500, windowMs: 2000 });
  let active;
  for (let i = 0; i < 12; i++) {
    const box = { x: 100 + i * 3, y: 50, w: 120, h: 300 };
    // alternate a noisy frame in: mom-like most frames, one frame of nothing usable
    const obs = i % 5 === 4 ? { heightCm: null, hair: null } : { heightCm: 160 + (i % 3), hair: 1.5 };
    const result = identify(obs, profiles);
    ({ active } = tr.update([{ box, obs, result }], i * 100));
  }
  assert.equal(active.length, 1);
  const t = active[0];
  assert.equal(t.identity.verdict, 'known');
  assert.equal(t.identity.profileId, 'mom');
  assert.equal(t.identity.stable, true);
  assert.equal(t.frames, 12);
  const s = summarizeTrack(t);
  assert.ok(Math.abs(s.heightCm - 161) <= 1);
  assert.equal(s.identity.name, 'Mom');
});

test('tracker ends a track after it disappears and starts unknown timer for strangers', () => {
  const tr = new Tracker({ maxAgeMs: 300, windowMs: 2000 });
  const box = { x: 10, y: 10, w: 100, h: 200 };
  let t = 0;
  let res;
  for (let i = 0; i < 10; i++) {
    t = i * 100;
    const obs = { heightCm: 120, hair: 0.1, faceDescriptor: vec(42) };
    res = tr.update([{ box, obs, result: identify(obs, profiles) }], t);
  }
  assert.equal(res.active[0].identity.verdict, 'unknown');
  assert.ok(res.active[0].unknownSince != null, 'unknown timer started');
  res = tr.update([], t + 1000);
  assert.equal(res.active.length, 0);
  assert.equal(res.ended.length, 1);
});

test('tracker separates two people standing apart', () => {
  const tr = new Tracker();
  const a = { x: 0, y: 0, w: 100, h: 300 };
  const b = { x: 400, y: 0, w: 100, h: 300 };
  const oa = { heightCm: 160, hair: 1.5 };
  const ob = { heightCm: 80, hair: 0.1 };
  let res;
  for (let i = 0; i < 8; i++) {
    res = tr.update([
      { box: a, obs: oa, result: identify(oa, profiles) },
      { box: b, obs: ob, result: identify(ob, profiles) },
    ], i * 100);
  }
  assert.equal(res.active.length, 2);
  const names = res.active.map((t) => t.identity.profileId).sort();
  assert.deepEqual(names, ['baby', 'mom']);
});
