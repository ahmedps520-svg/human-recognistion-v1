// Claude vision assistant. Runs in the browser with the user's own API key
// (stored only in this browser). It describes who is in the room in
// non-identifying terms and gives an attribute-based second opinion against
// the household roster: age group, height, hair, build, clothing, notes.
// It deliberately never asks Claude to recognise anyone by their face.

import Anthropic from '../../vendor/anthropic-sdk-0.126.0.esm.js';
import { AGE_GROUP_LABELS, HAIR_LENGTH_LABELS } from './config.js';

const SYSTEM_PROMPT = `You are the assistant of a family's bedroom camera. The family and their nanny know the camera is there.
You receive one still frame plus a list of household members described by non-facial attributes.

For each visible person, describe only non-identifying attributes: apparent age group, hair length, body build, clothing, and what they are doing.
Then judge which household member's listed attributes fit best, using age group, height compared with furniture and doorways, hair length, build and the notes. Give a confidence between 0 and 1 and answer "unknown" when nothing fits well or two members fit equally.
Do not attempt to recognise anyone by facial features; base the match only on the listed attributes. Be brief and factual. The summary is one or two plain sentences for a family activity log.`;

export function rosterFromProfiles(profiles) {
  return (profiles || []).map((p) => ({
    name: p.name,
    ageGroup: p.ageGroup && AGE_GROUP_LABELS[p.ageGroup] ? AGE_GROUP_LABELS[p.ageGroup] : 'not given',
    heightCm: Number.isFinite(p.heightCm) ? p.heightCm : null,
    weightKg: Number.isFinite(p.weightKg) ? p.weightKg : null,
    hairLength: HAIR_LENGTH_LABELS[p.hairLength] || p.hairLength || 'not given',
    notes: p.notes || '',
  }));
}

function buildSchema(names) {
  const matchEnum = [...new Set(names.filter(Boolean)), 'unknown'];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'people'],
    properties: {
      summary: { type: 'string' },
      people: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ageGroup', 'hairLength', 'build', 'clothing', 'activity', 'bestMatch', 'confidence', 'reasoning'],
          properties: {
            ageGroup: { type: 'string', enum: ['baby', 'child', 'teen', 'adult', 'unsure'] },
            hairLength: { type: 'string', enum: ['bald', 'short', 'medium', 'long', 'covered', 'unsure'] },
            build: { type: 'string', enum: ['slim', 'average', 'heavy', 'unsure'] },
            clothing: { type: 'string' },
            activity: { type: 'string' },
            bestMatch: { type: 'string', enum: matchEnum },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reasoning: { type: 'string' },
          },
        },
      },
    },
  };
}

function rosterText(roster) {
  if (!roster.length) return 'Household members: none enrolled yet.';
  const lines = roster.map((r) => {
    const bits = [r.ageGroup];
    if (r.heightCm) bits.push(`${r.heightCm} cm tall`);
    if (r.weightKg) bits.push(`about ${r.weightKg} kg`);
    bits.push(`hair: ${r.hairLength}`);
    if (r.notes) bits.push(`notes: ${r.notes}`);
    return `- ${r.name}: ${bits.join(', ')}`;
  });
  return `Household members:\n${lines.join('\n')}`;
}

export class ClaudeAssistant {
  constructor() {
    this.client = null;
    this.apiKey = '';
    this.calls = []; // timestamps of recent calls, for the hourly cap
    this.lastError = null;
  }

  configure({ apiKey }) {
    const key = (apiKey || '').trim();
    if (key === this.apiKey && this.client) return;
    this.apiKey = key;
    this.client = key ? new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }) : null;
  }

  get ready() {
    return !!this.client;
  }

  callsInLastHour() {
    const cutoff = Date.now() - 3600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    return this.calls.length;
  }

  /**
   * Describe one frame.
   * @param {object} p
   * @param {string} p.jpegBase64 base64 JPEG without the data: prefix
   * @param {Array} p.roster from rosterFromProfiles()
   * @param {string} [p.hints] what the camera itself measured
   * @param {string} p.model model id
   * @param {number} [p.maxPerHour]
   */
  async describe({ jpegBase64, roster, hints = '', model, maxPerHour = 40 }) {
    if (!this.client) throw new Error('Claude is not configured (add an API key in Settings)');
    if (this.callsInLastHour() >= maxPerHour) throw new Error(`Claude call limit reached (${maxPerHour} per hour)`);
    this.calls.push(Date.now());

    const names = roster.map((r) => r.name);
    const text = [
      rosterText(roster),
      hints ? `Camera measurements for the main person: ${hints}.` : '',
      'Describe the people in this frame and give your best attribute-based match for each.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const isOpus5 = model === 'claude-opus-5';
    const supportsEffort = /^claude-(opus|sonnet)-5/.test(model);
    const params = {
      model,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
            { type: 'text', text },
          ],
        },
      ],
      output_config: { format: { type: 'json_schema', schema: buildSchema(names) }, ...(supportsEffort ? { effort: 'low' } : {}) },
    };
    if (isOpus5) {
      // Server-side fallback: if a safety classifier declines, the request is re-run on the default fallback model.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }

    let response;
    try {
      response = await this.client.beta.messages.create(params);
    } catch (e) {
      this.lastError = e;
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Claude rejected the API key');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Claude rate limit hit, try again in a minute');
      if (e instanceof Anthropic.APIError) throw new Error(`Claude API error ${e.status}: ${e.message}`);
      throw e;
    }

    const usage = response.usage || {};
    if (response.stop_reason === 'refusal') {
      return { refused: true, explanation: response.stop_details?.explanation || '', summary: '', people: [], usage, model: response.model };
    }
    const textBlock = (response.content || []).find((b) => b.type === 'text');
    let parsed = null;
    try {
      parsed = textBlock ? JSON.parse(textBlock.text) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return { refused: false, summary: textBlock?.text || '', people: [], usage, model: response.model, unparsed: true };
    return {
      refused: false,
      summary: parsed.summary || '',
      people: Array.isArray(parsed.people) ? parsed.people : [],
      usage,
      model: response.model,
      truncated: response.stop_reason === 'max_tokens',
    };
  }
}

/**
 * Turn Claude's answer into an identity the app can use: only when exactly one
 * person is described, the best match is an enrolled name and the confidence
 * is high enough.
 */
export function secondOpinion(result, profiles, { minConfidence = 0.7 } = {}) {
  if (!result || result.refused || result.people.length !== 1) return null;
  const person = result.people[0];
  if (!person.bestMatch || person.bestMatch === 'unknown' || !(person.confidence >= minConfidence)) return null;
  const profile = (profiles || []).find((p) => p.name === person.bestMatch);
  if (!profile) return null;
  return { profileId: profile.id, name: profile.name, confidence: person.confidence, reasoning: person.reasoning || '' };
}

export function describePerson(person) {
  if (!person) return '';
  const bits = [];
  if (person.ageGroup && person.ageGroup !== 'unsure') bits.push(person.ageGroup);
  if (person.hairLength && person.hairLength !== 'unsure') bits.push(`${person.hairLength} hair`);
  if (person.build && person.build !== 'unsure') bits.push(`${person.build} build`);
  if (person.clothing) bits.push(person.clothing);
  if (person.activity) bits.push(person.activity);
  return bits.join(', ');
}
