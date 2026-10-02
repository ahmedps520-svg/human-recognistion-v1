# Home agent (and the optional LAN server)

The **home agent** is the one process that runs at home, on the PC, and
talks to the real devices: the Minecraft server, the air conditioning, the
door switch, Govee lights, plugs and switches, Home Assistant sensors,
outdoor weather and phone alerts. It signs in to the same cloud project as
the dashboard and the camera app, so there are no ports, tokens or
addresses to type anywhere.

## Run it

```
npm install               # once (installs supabase-js for the agent)
npm run agent:mock        # simulated devices, to try the dashboard
npm run agent             # real devices from server/config.json
npm run agent -- --login  # sign in again with another account
```

On Windows, open PowerShell or Command Prompt **inside the project folder**
first (in File Explorer, open the folder, then type `cmd` in the address
bar and press Enter). The first run asks for the project URL + anon key
(unless they are baked into the site, see
[docs/CLOUD-SETUP.md](../docs/CLOUD-SETUP.md)) and then for your email +
password; both are remembered on this PC (`server/data/agent-auth.json`
holds the session, never the password). Leave the window open: the
dashboard header shows **agent on** while it runs. To start it with
Windows, add a Task Scheduler task that runs `npm run agent` in the project
folder at logon.

Copy `server/config.example.json` to `server/config.json` and fill in the
devices you have; every device is optional. Restart the agent after
editing the config. Useful environment variables: `GOVEE_API_KEY`,
`HOME_SERVER_CONFIG` (path to another config file).

What the agent does, continuously:

- mirrors every device's state into the cloud (`device_states`) so the
  dashboard shows it, polling cloud devices every 30 s and weather every 10 min;
- carries out dashboard taps (door, AC, lights, plugs, scenes, Minecraft,
  phone-alert test) and answers them;
- follows the camera (who is in the room, armed, alarm) and the room row
  (mode, automation switches) to run scenes and automations;
- writes what it did to the activity timeline.

## Devices

| Device | Config | Notes |
| --- | --- | --- |
| Minecraft | `minecraft.host/port` for status; `minecraft.rcon` for the console and graceful stop; `startCommand`, `stopCommand`, `restartCommand` are shell commands run by the server (e.g. `systemctl start minecraft`, `docker start mc`, `screen -S mc -X stuff "stop\n"`). | Enable RCON in `server.properties` (`enable-rcon=true`, `rcon.password=…`). Status uses the normal server list ping, so it works without RCON. |
| Air conditioning | `ac.adapter`: `sensibo` (cloud API key from the Sensibo app), `homeassistant` (`climate.*` entity), or `webhook` (URL templates with `{temp}`, `{mode}`, `{fan}`). | For an infrared-only AC, put a Broadlink/ESP IR blaster behind Home Assistant or a tiny webhook. |
| Door switch | `door.adapter`: `shelly` (Gen1 or Gen2 relay), `tasmota`, `homeassistant` (`switch.*`, `lock.*` or `cover.*`), or `webhook`. `pulseMs > 0` makes "open" a momentary pulse (door strike, gate). | The "Intruder response" automation locks it when the camera alarm fires. |
| Govee lights | `govee.apiKey` from the Govee Home app (Settings → Apply for API key). | Uses the Govee cloud API, so it works from anywhere. Power, brightness, colour and colour temperature. Rate limit is 10 000 calls/day. |

Set `"mock": true` to simulate all devices while you build things.

## The smart room: modes, scenes, automations and more

| Feature | Config | What it does |
| --- | --- | --- |
| Modes | – | Home / Away / Sleep / Guest, switched from the dashboard or by scenes; automations can be conditioned on the mode. |
| Scenes | `scenes` (optional; defaults built in: I'm home, Wake up, Focus, Movie, Sleep, Away) | One tap runs a list of actions: `{device:'lights', all:{power,brightness,color,colorTempK}}`, `{device:'ac', set:{…}}`, `{device:'door', action}`, `{device:'switch', id, action}`, `{device:'switches', all:'off'}`, `{device:'camera', command:'arm'}`, `{device:'notify', title, message}`, `{device:'mode', mode}`, `{device:'scene', id}`. A scene with `mode` also sets the mode. |
| Automations | `automations` (optional; defaults built in) | `trigger`: `{type:'alarm'}`, `{type:'presence'}` (someone entered), `{type:'empty', minutes:15}`, `{type:'schedule', at:'23:00'}`, `{type:'door', state:'open'}`, `{type:'armed', armed:true}`. Optional `conditions`: `{mode, armed, between:['22:00','07:00']}`. The on/off switches on the dashboard are kept in the cloud (`home.automations`). Only "Intruder response" is on by default. |
| Plugs & switches | `switches: [{id, name, icon, adapter, shelly|tasmota|homeassistant|webhook}]` | Any relay, same adapters as the door. |
| Sensors | `sensors: [{id, name, kind, unit, entityId}]` | Home Assistant sensor entities (temperature, humidity, co2, illuminance…). |
| Weather | `location: {lat, lon, name}` | Outdoor conditions from Open-Meteo, no key needed. |
| Phone alerts | `notify: {adapter:'ntfy', ntfy:{topic}}` or `{adapter:'telegram', telegram:{botToken, chatId}}` | ntfy: install the ntfy app, subscribe to a topic name of your choice, put the same name in the config. |
| Activity | – | Everything that happens is logged to `data/activity.json` and streamed to the dashboard. |
| Room name | `roomName` | Shown at the top of the dashboard. |

## Connecting the camera app

Nothing to configure: sign in on the iPad with the same email + password.
The camera then shows up on the dashboard, arm/disarm works from anywhere,
visits and clips go to the cloud, and the alarm reaches the agent's
"Intruder response" automation (door locked, lights red, phone alert).

## The LAN server (optional, legacy)

`npm run server` still starts the earlier token-protected JSON API on port
8787 (`server/index.js`, `--mock` for simulated devices). The site no
longer uses it; it remains for scripts and for anyone who prefers a local
API. Its routes are listed below.

## API

All routes except `/api/health` need `Authorization: Bearer <token>` or
`?token=<token>` (for images, video and the event stream).

```
GET  /api/status                         everything at once
GET  /api/events                         Server-Sent Events: status, camera, visit, command, minecraft, ac, door, lights
POST /api/camera/frame?meta={json}       JPEG body from the camera app (meta: people, armed, recording, tracks)
GET  /api/camera/frame.jpg               latest frame
GET  /api/camera/stream                  MJPEG live stream (use as <img src>)
POST /api/camera/presence                {people, armed, recording, tracks}
POST /api/camera/command                 {action: arm|disarm|start|stop|siren}  → forwarded to the camera tab
GET/POST /api/camera/events, PUT/DELETE /api/camera/events/:id
PUT/GET  /api/camera/media/<path>        clips and snapshots
GET/PUT  /api/camera/profiles, /api/camera/calibration?label=
GET/POST /api/mode {mode} ; GET /api/scenes ; POST /api/scenes/:id/run
GET  /api/automations ; POST /api/automations/:id {enabled} ; POST /api/automations/:id/run
GET  /api/switches ; POST /api/switches/all {action} ; POST /api/switches/:id {action}
GET  /api/sensors ; GET /api/weather ; GET /api/activity?limit= ; POST /api/notify {title, message}
GET  /api/minecraft ; POST /api/minecraft/start|stop|restart ; POST /api/minecraft/rcon {command}
GET  /api/ac ; POST /api/ac {power, mode, targetTemp, fanLevel}
GET  /api/door ; POST /api/door {action: open|close|toggle|lock|unlock|pulse} ; POST /api/door/lock (alarm webhook)
GET  /api/lights ; POST /api/lights/all {power…} ; POST /api/lights/:device {power, brightness, color:{r,g,b}, colorTempK}
```

## Keeping it running

On Linux, a systemd unit is the simplest:

```
[Unit]
Description=Room Guard home server
After=network-online.target

[Service]
WorkingDirectory=/path/to/human-recognistion-v1
ExecStart=/usr/bin/node server/index.js
Restart=always
User=youruser

[Install]
WantedBy=multi-user.target
```

On macOS use `launchd` or simply `pm2 start server/index.js`. Back up
`server/data/` if the visit log matters to you.
