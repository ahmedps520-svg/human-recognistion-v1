# Release notes

## 0.4.0 — One link, one sign-in (2 October 2026)

No more server addresses, IP numbers or tokens. Everything is on the GitHub
Pages link, and every device signs in with the same email + password.

### What changed for you
- **Sign-in screen** on both the camera app and the dashboard. Sign in on
  one page of the site and the other is signed in too. The camera app can
  still be used without signing in (browser storage only).
- **Dashboard runs from the cloud.** The picture, who is in the room,
  arm/disarm, door, modes, scenes, automations, climate, lights, plugs,
  Minecraft, weather, visits and the timeline all come from your cloud
  project and update live. Header chip shows whether the home agent is on.
- **Live picture straight from the iPad** to the dashboard (WebRTC), with a
  one-frame-per-second fallback when a direct connection is not possible.
  "Start camera" / "Stop camera" and "Snapshot" from the dashboard.
- **Home agent** (`npm run agent`) replaces the home server for devices:
  same adapters (Govee, Sensibo, Shelly, Tasmota, Home Assistant, webhooks,
  Minecraft, ntfy/Telegram), no ports, no tokens; it signs in once and
  remembers the session. `npm run agent:mock` simulates every device.
- Arm/disarm, alarm, mode and automation switches live in one shared room
  row, so they survive a device being offline and every screen agrees.

### Under the hood
- `supabase/schema.sql` v2: `home`, `device_states`, `activity` tables,
  realtime publication, same RLS (signed-in users only). Safe to re-run.
- `assets/js/cloud.js`: one module for sign-in, tables, presence (throttled,
  change-only), commands with replies, table change events; used unchanged
  by the browser and by the agent in Node. `assets/js/live.js`: WebRTC
  publisher/viewer. `assets/js/rows.js`: shared row mapping.
- Settings: the Home server and Supabase sections are gone; an Account
  section shows the sign-in state. Settings keys `serverUrl`, `serverToken`,
  `serverPushFrames`, `serverFrameMs`, `supabase*` are no longer used.
- Tests: cloud link unit tests, home agent tests, and a browser end-to-end
  test that runs the camera app, the dashboard and the agent together
  through `tests/fake-cloud/`, an in-memory Supabase look-alike.
- The LAN JSON server (`npm run server`) remains as an optional extra.


## 0.3.0 — Smart-room dashboard (2 October 2026)

Your room on one screen, updating live. The home server grew from a device
bridge into a small smart-home hub, and the dashboard was redesigned.

### Dashboard
- New dark-glass design: frosted cards, large type, status-driven colour
  (amber when armed, red during an alarm, blue when occupied). Works on an
  iPad wall panel, a phone and a laptop.
- Everything updates in real time from the server's event stream; taps
  update instantly, the live feed runs at 10 fps, counters tick, and the
  connection reconnects by itself.
- Header: room name, mode switcher (Home / Away / Sleep / Guest), occupancy,
  inside temperature and humidity, outdoor weather, clock.
- Security panel: status ring, door lock with one big button, last alarm,
  last visit, visits today, siren and phone-alert tests.
- Scenes: I'm home, Wake up, Focus, Movie, Sleep, Away (editable in the
  server config).
- Automations with on/off toggles and "Run": Intruder response (on by
  default), Night routine, Wake-up, Empty-room saver, Welcome lights,
  Visitor alert.
- Climate card with room sensors; lights; plugs and switches; person
  detection with thumbnails; activity timeline; Minecraft; outdoor weather.
- Settings sheet for the server address, token, room name and camera URL;
  nothing technical on the main screen.

### Home server (v0.3.0)
- Room modes, scenes and an automation engine with triggers for alarm,
  someone entering, room empty for N minutes, daily schedules, door and
  armed changes, and conditions on mode, armed state and time of day.
- Extra switches (Shelly, Tasmota, Home Assistant, webhooks), Home
  Assistant sensors, Open-Meteo weather (no key), phone alerts via ntfy or
  Telegram, a persistent activity timeline.
- Scenes and automations now broadcast every device change so open
  dashboards never show stale state.
- The camera reports its alarm flag; the dashboard can trigger a siren test.

### Camera app
- Streams at 10 fps to the server and waits for the last frame before
  reporting "nobody" when stopped.

### Upgrade notes
- Restart the server after pulling. Existing `server/config.json` files keep
  working; new sections (`roomName`, `location`, `notify`, `switches`,
  `sensors`, `scenes`, `automations`) are optional.
- Automation toggles are saved in `server/data/automations.json`.

## 0.2.0 — Home server and first dashboard (18 September 2026)
- `server/`: dependency-free Node.js home server with a token-protected API,
  Server-Sent Events, optional HTTPS and a mock mode for every device.
- Receives the camera's live feed and visit log, stores clips and snapshots
  on disk, serves the site and a dashboard, relays arm/disarm commands.
- Minecraft: server list ping (status, players, version), RCON console,
  start/stop/restart; AC: Sensibo, Home Assistant, webhooks; door: Shelly,
  Tasmota, Home Assistant, webhooks; Govee lights through the cloud API.
- Camera app: "Home server" settings, visits and clips stored on the
  server, door lock routed through the server.

## 0.1.4 — Record every visit (17 September 2026)
- New default mode: detect a person, record the visit from entering to
  leaving, log it with times, snapshot and clip (long visits in parts),
  alarm for any person when armed. Only the pose model loads, so the camera
  starts in seconds.
- Identification becomes the optional "Identify people" mode.

## 0.1.3 — iPad fix and Claude assistant (17 September 2026)
- Face recognition on iPad/iPhone: the face models run on the exact WASM
  runtime because Safari's WebGL only renders 16-bit floats. SSD face
  detector by default, screen wake lock, diagnostics panel.
- Optional Claude vision assistant: plain-language visit descriptions and
  attribute-based second opinions (never face recognition), with the user's
  own API key.

## 0.1.2 — Enrollment preview and album photos (17 September 2026)
- Live camera preview with readiness indicators inside the person form,
  face-sample thumbnails that can be removed, and face import from album
  photos.

## 0.1.1 — Browser storage by default (17 September 2026)
- Everything stays in the browser (localStorage + IndexedDB) with persistent
  storage requests, backup export/import and clip downloads. Supabase sync
  remains optional.

## 0.1.0 — Room Guard v1 (17 September 2026)
- Browser-based bedroom camera on GitHub Pages: pose, hair and face models
  on device, approximate height via floor calibration, build and hair cues,
  weighted identification with known / ambiguous / unknown verdicts,
  clip recording, siren, notifications, door-lock webhook, Supabase schema,
  unit and end-to-end tests.
