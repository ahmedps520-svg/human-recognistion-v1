import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterFromProfiles, secondOpinion, describePerson } from '../../assets/js/ai.js';

const profiles = [
  { id: 'mom', name: 'Mom', heightCm: 160, weightKg: 58, hairLength: 'long', ageGroup: 'adult', notes: 'wears glasses' },
  { id: 'baby', name: 'Baby brother', heightCm: 80, hairLength: 'short', ageGroup: 'baby' },
];

test('rosterFromProfiles uses only non-facial attributes', () => {
  const r = rosterFromProfiles(profiles);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'Mom');
  assert.equal(r[0].ageGroup, 'Adult');
  assert.equal(r[0].heightCm, 160);
  assert.equal(r[0].hairLength, 'Long (past the shoulders)');
  assert.equal(r[0].notes, 'wears glasses');
  assert.equal(r[1].ageGroup, 'Baby / toddler (0–3)');
  assert.ok(!('faceDescriptors' in r[0]), 'no face data is ever sent');
});

test('secondOpinion only accepts a confident, single, enrolled match', () => {
  const ok = { refused: false, people: [{ bestMatch: 'Mom', confidence: 0.85, reasoning: 'adult, long hair' }] };
  const r = secondOpinion(ok, profiles);
  assert.equal(r.profileId, 'mom');
  assert.equal(r.confidence, 0.85);
  assert.equal(secondOpinion({ refused: false, people: [{ bestMatch: 'Mom', confidence: 0.5 }] }, profiles), null, 'too unsure');
  assert.equal(secondOpinion({ refused: false, people: [{ bestMatch: 'unknown', confidence: 0.9 }] }, profiles), null, 'unknown');
  assert.equal(secondOpinion({ refused: false, people: [{ bestMatch: 'Stranger', confidence: 0.9 }] }, profiles), null, 'not enrolled');
  assert.equal(secondOpinion({ refused: false, people: [{ bestMatch: 'Mom', confidence: 0.9 }, { bestMatch: 'unknown', confidence: 0.1 }] }, profiles), null, 'two people');
  assert.equal(secondOpinion({ refused: true, people: [] }, profiles), null, 'refusal');
  assert.equal(secondOpinion(null, profiles), null);
});

test('describePerson skips unsure fields', () => {
  assert.equal(describePerson({ ageGroup: 'adult', hairLength: 'unsure', build: 'slim', clothing: 'red hoodie', activity: 'sitting' }), 'adult, slim build, red hoodie, sitting');
  assert.equal(describePerson(null), '');
});
