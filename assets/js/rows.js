// Row <-> object mapping shared by the camera app, the dashboard and the home agent.
// Plain data helpers, usable from Node as well as the browser.

export const profileFromRow = (r) => ({
  id: r.id,
  name: r.name,
  heightCm: r.height_cm == null ? null : Number(r.height_cm),
  weightKg: r.weight_kg == null ? null : Number(r.weight_kg),
  hairLength: r.hair_length || 'short',
  ageGroup: r.age_group || '',
  faceDescriptors: Array.isArray(r.face_descriptors) ? r.face_descriptors : [],
  faceThumbs: Array.isArray(r.face_thumbs) ? r.face_thumbs : [],
  samples: Array.isArray(r.samples) ? r.samples : [],
  color: r.color || '#4ade80',
  alertOnEnter: !!r.alert_on_enter,
  notes: r.notes || '',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const profileToRow = (p) => ({
  id: p.id,
  name: p.name,
  height_cm: p.heightCm ?? null,
  weight_kg: p.weightKg ?? null,
  hair_length: p.hairLength || 'short',
  age_group: p.ageGroup || null,
  face_descriptors: p.faceDescriptors || [],
  face_thumbs: p.faceThumbs || [],
  samples: p.samples || [],
  color: p.color || '#4ade80',
  alert_on_enter: !!p.alertOnEnter,
  notes: p.notes || '',
  updated_at: new Date().toISOString(),
});

export const eventFromRow = (r) => ({
  id: r.id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  verdict: r.verdict,
  personId: r.person_id,
  personName: r.person_name,
  confidence: r.confidence == null ? null : Number(r.confidence),
  features: r.features || {},
  clipPath: r.clip_path,
  clipPaths: Array.isArray(r.clip_paths) && r.clip_paths.length ? r.clip_paths : r.clip_path ? [r.clip_path] : [],
  snapshotPath: r.snapshot_path,
  alarmTriggered: !!r.alarm_triggered,
  lockTriggered: !!r.lock_triggered,
  confirmedPersonId: r.confirmed_person_id,
  cameraLabel: r.camera_label,
});

export const eventToRow = (e) => ({
  id: e.id,
  started_at: e.startedAt,
  ended_at: e.endedAt ?? null,
  verdict: e.verdict,
  person_id: e.personId ?? null,
  person_name: e.personName ?? null,
  confidence: e.confidence ?? null,
  features: e.features || {},
  clip_path: e.clipPath ?? null,
  clip_paths: e.clipPaths || (e.clipPath ? [e.clipPath] : []),
  snapshot_path: e.snapshotPath ?? null,
  alarm_triggered: !!e.alarmTriggered,
  lock_triggered: !!e.lockTriggered,
  confirmed_person_id: e.confirmedPersonId ?? null,
  camera_label: e.cameraLabel ?? null,
});

const EVENT_PATCH_KEYS = {
  endedAt: 'ended_at', verdict: 'verdict', personId: 'person_id', personName: 'person_name', confidence: 'confidence',
  features: 'features', clipPath: 'clip_path', clipPaths: 'clip_paths', snapshotPath: 'snapshot_path', alarmTriggered: 'alarm_triggered',
  lockTriggered: 'lock_triggered', confirmedPersonId: 'confirmed_person_id', cameraLabel: 'camera_label',
};

export const eventPatchToRow = (patch) => {
  const row = eventToRow(patch);
  const out = {};
  for (const [k, col] of Object.entries(EVENT_PATCH_KEYS)) if (k in patch) out[col] = row[col];
  return out;
};

export const HOME_MODES = ['home', 'away', 'sleep', 'guest'];

export const defaultHome = () => ({
  id: 'main',
  roomName: 'My room',
  mode: 'home',
  modeSince: null,
  armed: false,
  alarm: false,
  alarmAt: null,
  automations: {},
  updatedAt: null,
});

export const homeFromRow = (r) => ({
  id: r.id || 'main',
  roomName: r.room_name || 'My room',
  mode: HOME_MODES.includes(r.mode) ? r.mode : 'home',
  modeSince: r.mode_since || null,
  armed: !!r.armed,
  alarm: !!r.alarm,
  alarmAt: r.alarm_at || null,
  automations: r.automations && typeof r.automations === 'object' ? r.automations : {},
  updatedAt: r.updated_at || null,
});

const HOME_KEYS = { roomName: 'room_name', mode: 'mode', modeSince: 'mode_since', armed: 'armed', alarm: 'alarm', alarmAt: 'alarm_at', automations: 'automations' };

/** Only the keys present in the patch end up in the row, so a partial upsert leaves the rest untouched. */
export const homePatchToRow = (patch) => {
  const out = {};
  for (const [k, col] of Object.entries(HOME_KEYS)) if (k in patch) out[col] = patch[k];
  return out;
};

export const activityFromRow = (r) => ({ id: r.id, at: r.at, kind: r.kind, text: r.text, ...(r.meta && typeof r.meta === 'object' ? r.meta : {}) });
