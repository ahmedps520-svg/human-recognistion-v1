# Room Guard (human-recognition v1)

A bedroom camera that runs entirely in the browser. Whenever a person is in
the room it records the visit from the moment they are seen until they
leave, keeps a snapshot and the clip, and can sound an alarm when armed.
Optionally it can also work out who the person is.

It is a static site on **GitHub Pages**, so the whole thing is one link:
<https://ahmedps520-svg.github.io/human-recognistion-v1/> (camera app) and
the same link ending in `dashboard.html` (smart-room dashboard). One sign-in
with email + password connects the camera on the iPad, the dashboard on any
phone or laptop and the **home agent** on the PC that drives the real
devices. They meet in a small free Supabase project that only you can read
([docs/CLOUD-SETUP.md](docs/CLOUD-SETUP.md), ten minutes, once). The machine
learning runs on-device inside the browser tab that has the camera. Without
signing in the camera app still works on its own from browser storage.

> **Status:** v1. Visit recording, alarms and the optional identification
> mode all work end to end, but height estimation is *approximate* and
> nothing here is a substitute for a real security system. See
> [Limitations](#limitations) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Two modes

**Record every visit (default).** A pose model finds people in each frame.
The first time someone is seen a recording starts; it stops a few seconds
after the room is empty again. Each visit becomes an event with the time
they entered, the time they left, the duration, a snapshot and the clip
(long visits are saved in several parts). When the alarm is armed, any
person present for longer than the grace period triggers the siren, a
notification and, if configured, the door-lock webhook. Only the pose model
is loaded, so the camera starts fast and uses little power.

**Identify people (Settings → Mode).** Adds the People and Calibrate tabs and
the face and hair models, and tries to name the person as described below.

## How identification works (identify mode)

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

- Live view with skeleton overlay and, in identify mode, name, confidence and measured cues.
- Visit log: entered, left, duration, snapshot, clip (multi-part for long visits), download.
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
- Smart-room dashboard on the same site: live picture (device-to-device
  video), who is in the room, arm/disarm, door lock, modes, scenes,
  automations, climate, Govee lights, plugs, Minecraft server, weather,
  activity timeline, all updating live.
- Home agent for the PC: drives the devices, runs scenes and automations
  (intruder response: lights red, door locked, phone alert) and signs in
  with the same account. No ports, tokens or addresses.
- Works offline after the first load (models are cached by the browser);
  the cloud link and Claude are the only features that need the internet.

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

### 2. Sign in (or not)

The first screen asks for your email and password. That is the one
household account from [docs/CLOUD-SETUP.md](docs/CLOUD-SETUP.md); signed in,
visits and clips go to your cloud project, the dashboard sees the camera, and
arm/disarm works from anywhere. Until the project is baked into
`assets/js/config.js`, the sign-in screen has a **First-time setup** box
where you paste the project URL and anon key once per device.

**Use this device without signing in** keeps everything in the browser you
run the camera in: people, events and settings in localStorage, clips and
snapshots in IndexedDB. Nothing is uploaded. Use the same browser profile
every time, let the app ask for *persistent storage* when the camera starts,
and **Export backup** in Settings now and then. Clips are downloaded one at
a time from the Events tab.

### 3. (Identify mode only) Enroll your family

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

### 4. (Identify mode only) Calibrate height

On the **Calibrate** tab pick a person whose height you know, press **Start
collecting**, and have them walk slowly around the whole room facing the
camera with their feet visible. Stop after ~30 s, check the fit error (aim
for under 4 cm) and save. Redo this whenever the camera moves.

### 5. Arm it

Press **Arm alarm** on the Live tab. The badge shows "Armed". In the default
mode any person present for longer than the grace period (default 4 s)
triggers the alarm; in identify mode only people the camera does not
recognise do.

### Door lock

Signed in, the alarm reaches the home agent, whose **Intruder response**
automation locks the door switch, turns the lights red and sends a phone
alert (ntfy). Without the agent, the camera app can also POST
`{"action":"lock","reason":"…","at":"…"}` to a webhook of your own (Home
Assistant, an ESP32 behind a tiny server); set it under Settings → Alarm
and verify with **Send test lock request**.

## The cloud link

One Supabase project is the meeting point for the three parts. Durable
state lives in tables (`home`: mode, armed, alarm; `device_states`:
everything the agent mirrors; `activity`; `events` + the `clips` bucket).
Live state goes over one realtime channel: presence (who is online, what
the camera sees), broadcast commands with replies (dashboard → camera or
agent), the WebRTC handshake for the live video and JPEG snapshots as a
fallback. Every table is locked to the signed-in user by row level
security, so the anon key in the site is harmless on its own.
[docs/CLOUD-SETUP.md](docs/CLOUD-SETUP.md) has the one-time setup and
`assets/js/cloud.js` the whole protocol (used unchanged by the browser and
by the agent in Node).

## Development

```
npm install                 # playwright, supabase-js (for the agent); browser libraries are vendored
npm test                    # unit tests (camera logic, cloud link) + agent and LAN-server tests
npm run test:e2e            # headless Chromium: fake camera with a photo, both modes
npm run test:e2e:cloud      # camera app + dashboard + home agent through a fake cloud project
npm run serve               # local static server on :8080
npm run agent               # home agent (see docs/CLOUD-SETUP.md and server/README.md)
npm run agent:mock          # home agent with simulated devices
```

The camera end-to-end test downloads the MediaPipe models once into
`tests/e2e/.cache` and serves the CDN assets from `node_modules`, so it needs
no internet afterwards. The cloud test replaces supabase-js with
`tests/fake-cloud/` (an in-memory look-alike of the project) so it runs
offline too. Set `CHROMIUM_PATH` if Playwright's own browser is not installed.

Layout:

```
index.html              single page app (Live, People, Events, Calibrate, Settings)
assets/js/config.js     asset URLs, landmark indices, default settings, match weights
assets/js/features.js   body metrics, floor calibration, hair index (pure, unit tested)
assets/js/identify.js   scoring, verdicts, temporal tracker (pure, unit tested)
assets/js/vision.js     MediaPipe + face-api loading and per-frame inference
assets/js/recorder.js   MediaRecorder clips and snapshots
assets/js/storage.js    cloud tables/storage when signed in, else localStorage + IndexedDB
assets/js/cloud.js      the cloud link: sign-in, home row, devices, activity, presence, commands
assets/js/live.js       device-to-device live video (WebRTC) with snapshot fallback
assets/js/rows.js       row <-> object mapping shared by browser and agent
assets/js/alarm.js      siren, notifications, door-lock webhook
assets/js/app.js        UI and orchestration
vendor/                 pinned library bundles (see vendor/README.md)
supabase/schema.sql     tables, RLS policies, realtime, storage bucket
dashboard.html          smart-room dashboard (assets/js/dashboard.js)
server/agent.js         home agent entry point; server/lib/agent.js the core
server/lib/             device adapters (Govee, Sensibo, Shelly, Tasmota, Home Assistant, webhooks, Minecraft), scenes, automations
tests/fake-cloud/       Supabase stand-in for tests
```

## Dashboard and home agent

`dashboard.html` is a dark-glass control centre for the room that updates
live: the camera picture and who is in the room, a security panel with
arm/disarm and the door lock, room modes (Home / Away / Sleep / Guest),
one-tap scenes, automations (schedules, "room empty for N minutes",
"intruder response"), climate with room sensors, Govee lights, plugs and
switches, the visit log, an activity timeline, outdoor weather, phone
alerts through ntfy or Telegram, and the Minecraft server (status, players,
start/stop/restart, RCON console).

The devices are driven by the **home agent**, `npm run agent` on the PC at
home. It signs in with the same account, mirrors every device into the
cloud and carries out what you tap on the dashboard; `npm run agent:mock`
simulates all devices so you can use the whole dashboard before anything is
wired in. Device configuration is described in
[server/README.md](server/README.md).

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
own cloud project, the live video to your own dashboard, your own door-lock
webhook, the model/library CDNs on first load, and (only if you enable it)
one frame per visit to Anthropic's API for the Claude assistant. The MediaPipe runtime would also post anonymous usage reports to
Google; the app blocks those by default (Settings → Performance).
