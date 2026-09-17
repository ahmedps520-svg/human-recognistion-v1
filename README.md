# Room Guard (human-recognition v1)

A bedroom camera that runs entirely in the browser, recognises the people who
belong in the room, saves clips of every visit, and raises an alarm (and can
ask a smart lock to lock the door) when it sees someone it does not know.

Version 1 is a static site meant for **GitHub Pages**. For now everything it
learns and records (people, events, clips) stays in the browser that runs the
camera; cloud sync with **Supabase** is built in but optional and off by
default. No server of your own is needed: the machine learning runs on-device
inside the browser tab that has the camera.

> **Status:** v1 foundation. Detection, identification, recording, alarms and
> the learning loop all work end to end, but height estimation is
> *approximate*, weight is only estimated as "build", and nothing here is a
> substitute for a real security system. See [Limitations](#limitations) and
> [docs/ROADMAP.md](docs/ROADMAP.md) for the year-long plan.

## How it identifies people

Every frame goes through three on-device models:

| Cue | How it is measured | Model |
| --- | --- | --- |
| **Approximate height** | Head-top to feet in pixels, converted to centimetres with a one-time floor calibration (a known person walks around the room once). Only measured when the person is standing with feet in view. | MediaPipe Pose Landmarker |
| **Build (weight proxy)** | Shoulder and hip width relative to torso length. Scale-free, so it works at any distance, but only when the person faces the camera. A camera cannot weigh anyone, so the enrolled weight is informational. | MediaPipe Pose Landmarker |
| **Hair length** | How far the hair segmentation mask hangs below ear level, in head-heights. | MediaPipe multiclass selfie segmenter |
| **Face** | 128-number face descriptor compared with the enrolled samples. A clear face match wins outright; the body cues carry the identification when the face is turned away or too far. | face-api (TinyFaceDetector + FaceRecognitionNet) |

Each cue is scored against every enrolled person (`assets/js/identify.js`),
weighted (face 3, height 1.5, hair 1, build 0.75) and smoothed over a few
seconds per tracked person. The verdict is one of:

- **known** – confident match, shown with the person's colour;
- **ambiguous** – clearly one of the family but two people score alike (no alarm);
- **unknown** – a stranger: after the grace period the siren sounds, a
  notification is sent and, if enabled, the door-lock webhook is called;
- **insufficient** – not enough cues yet (someone half in frame).

**It learns.** Every visit is logged with the measured height, build, hair and
the best face samples. Confirming who it really was on the Events tab adds
those measurements to that person, and once three confirmed samples exist the
learned values replace the typed-in ones. This is how the identifier adapts to
your camera, your room and your family over time.

## Features in v1

- Live view with skeleton overlay, name, confidence and measured cues.
- Enrollment of family members: name, height, weight, hair length, colour,
  "notify me when they enter", face and body capture with a live preview and
  sample thumbnails, plus face import from album photos.
- Floor calibration wizard for height estimation (per camera placement).
- Clip recording (WebM) of every occupancy and a snapshot per visit, kept in
  the browser's IndexedDB (or uploaded to Supabase Storage once cloud sync is turned on).
- Event log with thumbnails, playback, "who was it?" confirmation (learning) and deletion.
- Siren (Web Audio), browser notifications and a generic door-lock webhook.
- Arm / disarm, configurable thresholds, backup export / import, clip downloads.
- Optional Claude vision assistant: a plain-language description of every
  visit and an attribute-based second opinion when the camera is unsure.
- Works offline after the first load (models are cached by the browser);
  Claude is the only feature that needs the internet.

## Setup

### 1. Deploy the site

The site is plain HTML/JS with no build step.

1. Push this repository to GitHub.
2. In **Settings → Pages** choose **GitHub Actions** as the source. The
   workflow in `.github/workflows/pages.yml` runs the unit tests and deploys
   `main` on every push. (Serving the branch directly also works.)
3. Open the Pages URL in Chrome or Edge on the computer that has the camera.
   Cameras only work over HTTPS, which Pages provides.

You can also run it locally with `npm run serve` and open `http://localhost:8080`.

### 2. Where your data lives (for now: in the browser)

Everything is stored in the browser you run the camera in: people, events
and settings in localStorage, clips and snapshots in IndexedDB. Nothing is
uploaded anywhere. Three things follow from that:

- Use the same browser profile on the same computer every time; another
  browser starts empty.
- When you first start the camera the app asks the browser for *persistent
  storage* so clips are not evicted when disk space runs low. Settings →
  Browser storage shows usage and lets you ask again.
- **Export backup** in Settings saves people, events and settings as a JSON
  file (import it on a new machine). Clips are downloaded one at a time from
  the Events tab.

### 3. Enroll your family

On the **People** tab add each person with their height, weight and hair
length. The form shows a live camera preview with the same overlay as the
Live tab and a readiness line (face, hair, feet, standing, facing camera) so
you can see what the camera is getting before you capture:

- **Capture 5 face samples** grabs faces from the camera; each one appears as
  a thumbnail you can inspect and remove.
- **Capture body sample** records hair length, build and (after calibration)
  height while the person stands still with their whole body in view.
- **Add photos from album** finds faces in photos you already have (phone
  album or any image files). Tick the faces that belong to this person and
  add them. Photos only contribute face samples; body measurements come from
  the room camera so they match what it sees.

More samples in different lighting, angles and days make the match more
robust.

### 4. Calibrate height

On the **Calibrate** tab pick a person whose height you know, press **Start
collecting**, and have them walk slowly around the whole room facing the
camera with their feet visible. Stop after ~30 s, check the fit error (aim
for under 4 cm) and save. Redo this whenever the camera moves.

### 5. Arm it

Press **Arm alarm** on the Live tab. The badge shows "Armed". Strangers who are
clearly seen for longer than the grace period (default 4 s) trigger the alarm.

### Door lock

The lock integration is a webhook: when the alarm fires the app POSTs
`{"action":"lock","reason":"unknown person detected","at":"…"}` (optionally
with a bearer token) to the URL you configure. Point it at a Home Assistant
webhook automation, a Supabase Edge Function, or a small ESP32/Raspberry Pi
server driving a servo or a smart lock. The endpoint must allow CORS from your
Pages origin. Use **Send test lock request** in Settings to verify it.

## Later: cloud storage with Supabase

The Supabase client, schema and sign-in flow are already in the app; they are
just not needed yet. When you want clips and events off the laptop:

1. Create a project at [supabase.com](https://supabase.com).
2. Open the SQL editor, paste `supabase/schema.sql`, run it. It creates the
   `profiles`, `events` and `cameras` tables, the private `clips` storage
   bucket, and row-level-security policies that allow **authenticated users only**.
3. Under **Authentication → Users** add yourself (email + password) and under
   **Authentication → Providers → Email** disable public sign-ups.
4. In the app's **Settings → Cloud sync** enter the project URL, the anon key,
   your email and password, then **Save & sign in**. From then on people,
   events and clips are read from and written to Supabase; the browser copy
   is kept as an offline cache of people and calibration.

## Development

```
npm install         # playwright + pinned browser libraries (already vendored)
npm test            # unit tests for feature extraction, calibration and identification
npm run test:e2e    # headless Chromium: fake camera with a photo, enrollment, alarm, events
npm run serve       # local static server on :8080
```

The end-to-end test downloads the MediaPipe models once into
`tests/e2e/.cache` and serves the CDN assets from `node_modules`, so it needs
no internet afterwards. Set `CHROMIUM_PATH` if Playwright's own browser is not
installed.

Layout:

```
index.html              single page app (Live, People, Events, Calibrate, Settings)
assets/js/config.js     asset URLs, landmark indices, default settings, match weights
assets/js/features.js   body metrics, floor calibration, hair index (pure, unit tested)
assets/js/identify.js   scoring, verdicts, temporal tracker (pure, unit tested)
assets/js/vision.js     MediaPipe + face-api loading and per-frame inference
assets/js/recorder.js   MediaRecorder clips and snapshots
assets/js/storage.js    Supabase tables/storage with local fallback (localStorage + IndexedDB)
assets/js/alarm.js      siren, notifications, door-lock webhook
assets/js/app.js        UI and orchestration
vendor/                 pinned library bundles (see vendor/README.md)
supabase/schema.sql     tables, RLS policies, storage bucket
```

## Claude vision assistant (optional)

Large language models are not face recognisers. Claude (like the other
major hosted models) will not identify a real person from their face, and
one frame every 200 ms through an API would be slow and expensive anyway.
So the local models stay in charge of recognition, and Claude is used for
what it is good at:

- **Describing each visit** in one or two plain sentences that are stored
  with the event ("An adult with shoulder-length dark hair in a grey hoodie
  came in and sat at the desk").
- **A second opinion when the camera is unsure.** Claude gets one still
  frame plus the household roster described by non-facial attributes (age
  group, height, hair length, weight, notes) and says whose attributes fit
  best, with a confidence. A confident match (≥ 70 %) upgrades an "unknown"
  or "ambiguous" visit to that person and holds the alarm; "unknown" lets
  the alarm proceed. The prompt tells Claude not to use faces.

Turn it on under **Settings → Claude vision assistant** with your own
Anthropic API key. The key is stored only in your browser; frames are sent
to Anthropic's API under your account (see their data policies). Costs are
per visit, not per frame: roughly one to two cents per visit on Claude Opus
5, a fraction of that on Haiku 4.5. A per-hour cap protects against a busy
day. Add an age group to each person on the People tab, and put anything
distinctive in their notes (glasses, usual clothes, typical times), because
that is what Claude matches on.

## Running it on an iPad

An iPad Pro runs the whole pipeline in Safari. Two things matter:

- **Face runtime.** Safari's WebGL on iPhone and iPad can only render
  16-bit floats, which visibly degrades the 128-number face embeddings and
  makes people look alike to the matcher. The app therefore runs the face
  models on the exact WASM runtime on Apple mobile devices (Settings →
  Performance → Face model runtime, default *Auto*). The Diagnostics box
  there shows which runtime is active.
- **Keep the tab awake.** The app requests a screen wake lock while the
  camera runs, but iPadOS still pauses the camera when the tab is in the
  background or the iPad is locked. Use Guided Access or keep the tab in
  front.

## Limitations

- **Height is approximate.** Expect roughly ± 5 cm after a good calibration,
  worse near the edges of the calibrated floor area, and nothing at all when
  the feet are hidden or the person is sitting or crouching. Two family
  members within a few centimetres of each other need face samples to be told apart.
- **Claude is a helper, not the recogniser.** It only sees attributes, so
  two adults with similar height and hair are still ambiguous to it; face
  samples on the People tab are what make matches certain.
- **Weight cannot be measured optically.** "Build" separates a slim adult
  from a heavy one but not 60 kg from 65 kg.
- **Hair** is measured from a 256×256 mask; hats, hoods and buns confuse it.
- **A stranger who matches someone's body cues and never shows a face may be
  taken for that person.** Enroll faces for everyone and keep the camera
  where faces are visible on entry.
- Identification only runs while the tab is open with the camera on; a
  laptop lid closing stops it. A dedicated always-on device is on the roadmap.
- The browser tab keeps the models in memory (~150 MB) and uses the GPU. On
  a laptop with a real GPU expect 10–30 analysed frames per second; without
  GPU acceleration it drops below 1 fps (hover the fps badge for per-stage timings).

## Privacy and consent

This records people in a home. Tell everyone who uses the room, including
the nanny, that the camera exists and what is stored. Keep the Supabase
project private (the schema only grants access to signed-in users), do not
share the anon key beyond the devices you trust, and delete clips you do not
need. Face descriptors are stored as numbers that cannot be turned back into
a photo, but snapshots and clips can.

Everything is computed on your device. The only outbound traffic is to your
Supabase project, your own door-lock webhook, the model/library CDNs on
first load, and (only if you enable it) one frame per visit to Anthropic's
API for the Claude assistant. The MediaPipe runtime would also post anonymous usage reports to
Google; the app blocks those by default (Settings → Performance).
