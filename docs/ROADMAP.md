# Roadmap (12 months)

The goal is a reliable, always-on bedroom guard that knows the family, keeps
a record of visits, and can act (alarm, lock, notify) when someone unknown
shows up. v1 proves the pipeline in a browser; later versions make it robust,
always on and physical.

## Phase 1 — Foundation (months 1–2) · v1, this repo
- [x] Static site on GitHub Pages, no build step.
- [x] On-device pose, hair segmentation and face descriptors.
- [x] Height via floor calibration, build proxy, hair length index.
- [x] Weighted scoring with known / ambiguous / unknown / insufficient verdicts and temporal smoothing.
- [x] Clip + snapshot recording in the browser (IndexedDB) with persistent-storage request and clip downloads; Supabase upload built in, off by default.
- [x] Events log with confirmation feedback that updates the person's samples.
- [x] Siren, notifications, door-lock webhook, arm/disarm.
- [x] Enrollment preview with readiness indicators, face thumbnails, album photo import.
- [x] iPad support: exact WASM face runtime on Apple mobile devices, SSD face detector, screen wake lock, diagnostics.
- [x] Claude vision assistant: per-visit descriptions and attribute-based second opinions (never face recognition).
- [x] "Record every visit" as the default mode: pose-only detection, visit events with entered/left times, multi-part clips; identification is the optional advanced mode.
- [ ] Field test with the whole family for two weeks; tune weights and sigmas from confirmed events.

## Phase 2 — Accuracy (months 3–4)
- Collect a labelled dataset from confirmed events (features + snapshots) and
  train a small per-household classifier in the browser (TensorFlow.js) that
  replaces the hand-tuned Gaussian scorer; keep the current scorer as fallback.
- Gait and walking-speed cues (pose sequence over 2–3 s) as extra features.
- Clothing colour histogram as a same-day cue (re-identification within a day).
- Better height: fit a floor homography from four marked points instead of the
  linear model; use the head-top from segmentation always.
- Face: switch to a stronger embedding model and add liveness / blur rejection.
- Multiple-person handling: per-person clip cropping and separate events.

## Phase 3 — Always on (months 5–7)
- Dedicated device (Raspberry Pi 5 / Jetson / mini PC) running a kiosk browser
  or a Node/Python port of the pipeline, with a watchdog and auto-restart.
- Turn on Supabase sync (schema, client and sign-in already in the app) so
  events and clips leave the laptop.
- Supabase Edge Function to receive events and fan out push notifications
  (Telegram / WhatsApp / email) and to call the lock.
- Realtime dashboard (Supabase Realtime) so a phone can watch events and
  arm/disarm remotely.
- Privacy zones, schedules (auto-arm at night), and quiet hours.

## Phase 4 — Physical actions (months 8–10)
- ESP32 door-lock controller (servo/deadbolt) with a secure webhook, manual
  override and battery backup.
- Local siren (GPIO buzzer) so the alarm works without speakers.
- Two-way audio: play a warning message to unknown visitors.

## Phase 5 — Hardening (months 11–12)
- Encrypted clips at rest with a household key; automatic retention purge.
- Adversarial tests: hats, masks, hoodies, low light, IR night mode.
- Offline-first with a sync queue; upload when the connection returns.
- Documentation, install script, and a one-page setup guide for the family.

## Ideas parked for later
- Pet detection to avoid false alarms.
- Fall / distress detection for the baby brother's room.
- Multi-camera hand-off with a shared identity across rooms.
