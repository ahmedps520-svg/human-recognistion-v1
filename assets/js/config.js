// Central configuration: pinned asset URLs, landmark indices and default settings.
// Everything here is plain data so it can be imported from Node tests as well as the browser.

export const APP_VERSION = '0.1.0';

// Heavy assets are fetched from pinned CDN locations. Point these at your own
// hosting if you prefer to self-host (see vendor/README.md). The WASM runtime
// version MUST match vendor/mediapipe-tasks-vision-*.mjs.
export const ASSETS = {
  mediapipeWasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm',
  poseModel:
    'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  segmenterModel:
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
  faceModels: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model',
};

// MediaPipe BlazePose landmark indices (33 points).
export const POSE = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

// Skeleton edges used for the overlay drawing.
export const POSE_EDGES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [28, 30], [30, 32],
  [0, 2], [0, 5], [2, 7], [5, 8], [9, 10],
];

// Categories produced by the selfie multiclass segmenter.
export const SEG = { BACKGROUND: 0, HAIR: 1, BODY_SKIN: 2, FACE_SKIN: 3, CLOTHES: 4, OTHERS: 5 };

// Hair length categories a person can be enrolled with, mapped to the
// "hair index" the camera measures: how far the hair hangs below ear level,
// expressed in head-heights. Short hair ends around the ears (0), chin to
// shoulder length is roughly 0.5 to 1.3, longer hair goes well beyond that.
export const HAIR_LENGTH_INDEX = {
  bald: -0.35,
  short: 0.1,
  medium: 0.8,
  long: 1.6,
};

export const HAIR_LENGTH_LABELS = {
  bald: 'Bald / very short',
  short: 'Short (above the ears)',
  medium: 'Medium (chin to shoulders)',
  long: 'Long (past the shoulders)',
};

// Default user settings, persisted in localStorage (see settings.js).
export const DEFAULT_SETTINGS = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseEmail: '',
  cameraDeviceId: '',
  cameraLabel: '',
  mirror: false,
  // identification
  matchThreshold: 0.62, // combined score needed to call someone "known"
  matchMargin: 0.08, // best score must beat runner-up by this much
  unknownGraceSec: 4, // seconds of confident "unknown" before the alarm fires
  // recording
  recordClips: true,
  clipMaxSec: 60,
  clipTailSec: 3,
  recordAudio: false,
  // alarm & lock
  alarmEnabled: true,
  alarmDurationSec: 20,
  notifyEnabled: false,
  lockWebhookUrl: '',
  lockWebhookToken: '',
  lockOnUnknown: false,
  // performance
  faceEveryMs: 350,
  hairEveryFrames: 3,
  poseModelDelegate: 'GPU',
  blockTelemetry: true, // stop the MediaPipe runtime from posting usage logs to Google
  faceDetector: 'ssd', // 'ssd' (more accurate, finds smaller faces) or 'tiny' (lighter)
  tfBackend: 'auto', // face model runtime: 'auto' picks WASM on iPad/iPhone (exact maths) and WebGL elsewhere
  // Claude vision assistant (optional; key stays in this browser)
  aiEnabled: false,
  aiApiKey: '',
  aiModel: 'claude-opus-5',
  aiDescribeVisits: true, // one description per visit, written into the event
  aiSecondOpinion: true, // ask Claude which household member the visible attributes fit when the camera is unsure
  aiMaxPerHour: 40,
};

export const AI_MODELS = {
  'claude-opus-5': 'Claude Opus 5 (best judgement)',
  'claude-sonnet-5': 'Claude Sonnet 5 (balanced)',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fastest, cheapest)',
};

export const AGE_GROUP_LABELS = {
  baby: 'Baby / toddler (0–3)',
  child: 'Child (4–12)',
  teen: 'Teenager',
  adult: 'Adult',
};

// Per-feature weights and tolerances used by identify.js. Face dominates when
// available; body cues carry the identification when the face is turned away.
export const MATCH = {
  weights: { face: 3.0, height: 1.5, hair: 1.0, build: 0.75 },
  sigma: { height: 6.0, hair: 0.4, build: 0.06 },
  face: { strong: 0.45, zero: 0.4, span: 0.3 }, // score = 1 - clamp((d - zero) / span)
  minEvidence: 1.0, // total weight of available features needed for a verdict
  minSamplesForLearned: 3,
};
