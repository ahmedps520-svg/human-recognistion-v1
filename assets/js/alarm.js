// Siren (Web Audio), browser notifications and the door-lock webhook.

export class Siren {
  constructor() {
    this.ctx = null;
    this.osc = null;
    this.gain = null;
    this.sweepTimer = null;
    this.stopTimer = null;
    this.active = false;
    this.onChange = () => {};
  }

  /** Create or resume the AudioContext. Must be called from a user gesture at least once. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return !!this.ctx;
  }

  start(durationSec = 20) {
    if (!this.unlock()) return false;
    if (this.active) return true;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.05);
    osc.start();
    this.osc = osc;
    this.gain = gain;
    this.active = true;
    let up = true;
    const sweep = () => {
      if (!this.active) return;
      const t = ctx.currentTime;
      osc.frequency.cancelScheduledValues(t);
      osc.frequency.setValueAtTime(up ? 600 : 1200, t);
      osc.frequency.linearRampToValueAtTime(up ? 1200 : 600, t + 0.45);
      up = !up;
    };
    sweep();
    this.sweepTimer = setInterval(sweep, 450);
    if (durationSec > 0) this.stopTimer = setTimeout(() => this.stop(), durationSec * 1000);
    this.onChange(true);
    return true;
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.sweepTimer);
    clearTimeout(this.stopTimer);
    const ctx = this.ctx;
    try {
      const t = ctx.currentTime;
      this.gain.gain.cancelScheduledValues(t);
      this.gain.gain.setValueAtTime(this.gain.gain.value || 0.3, t);
      this.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      this.osc.stop(t + 0.2);
    } catch {
      /* already stopped */
    }
    this.osc = null;
    this.gain = null;
    this.onChange(false);
  }

  /** Short confirmation tone (enrollment captures, arming). */
  beep(freq = 880, ms = 120) {
    if (!this.unlock()) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    osc.start(t);
    osc.stop(t + ms / 1000 + 0.02);
  }
}

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function notify(title, body, { tag = 'room-camera' } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, { body, tag, renotify: true });
    setTimeout(() => n.close(), 15000);
    return true;
  } catch {
    return false;
  }
}

/**
 * POST to the configured door-lock webhook (Home Assistant, a Raspberry Pi,
 * an ESP32 with a servo, a Supabase edge function...). The endpoint must allow
 * CORS from the site's origin.
 */
export async function triggerDoorLock({ url, token = '', action = 'lock', reason = '', extra = {} }) {
  if (!url) return { ok: false, skipped: true, message: 'No door-lock webhook configured' };
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers,
      body: JSON.stringify({ action, reason, at: new Date().toISOString(), source: 'room-camera', ...extra }),
    });
    return { ok: res.ok, status: res.status, message: res.ok ? 'Webhook accepted' : `Webhook returned HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e, message: `Webhook failed: ${e.message}` };
  }
}
