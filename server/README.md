# Room Guard home server

A single Node.js process (no dependencies) that runs on a computer at home
and gives you one place for everything:

- receives the **live camera feed** and **visit log** from the Room Guard
  tab and stores clips and snapshots on disk (`server/data/`);
- serves the **dashboard** (`/dashboard.html`) and the camera app itself;
- controls the **Minecraft server** (status, players, start / stop /
  restart, RCON console), the **air conditioning**, the **door switch**
  and the **Govee lights** behind a token-protected JSON API.

## Run it

```
npm run server            # uses server/config.json (created with a token on first run)
npm run server:mock       # demo with simulated devices, token "demo-token-change-me"
node server/index.js --mock --port 9000      # the same, with options
node server/index.js --config C:\path\to\other-config.json
```

On Windows, open PowerShell or Command Prompt **inside the project folder**
first (in File Explorer, open the folder, then type `cmd` in the address bar
and press Enter). When Windows Firewall asks, allow Node.js on private
networks so your iPad can reach the server.

Then open `http://<that computer>:8787/dashboard.html`, press **Connect**
and paste the token the server printed. Copy `server/config.example.json`
to `server/config.json` and fill in the devices you have; every device is
optional. Restart the server after editing the config.

Useful environment variables: `PORT`, `HOME_SERVER_TOKEN`, `GOVEE_API_KEY`,
`HOME_SERVER_CONFIG` (path to another config file).

## Devices

| Device | Config | Notes |
| --- | --- | --- |
| Minecraft | `minecraft.host/port` for status; `minecraft.rcon` for the console and graceful stop; `startCommand`, `stopCommand`, `restartCommand` are shell commands run by the server (e.g. `systemctl start minecraft`, `docker start mc`, `screen -S mc -X stuff "stop\n"`). | Enable RCON in `server.properties` (`enable-rcon=true`, `rcon.password=…`). Status uses the normal server list ping, so it works without RCON. |
| Air conditioning | `ac.adapter`: `sensibo` (cloud API key from the Sensibo app), `homeassistant` (`climate.*` entity), or `webhook` (URL templates with `{temp}`, `{mode}`, `{fan}`). | For an infrared-only AC, put a Broadlink/ESP IR blaster behind Home Assistant or a tiny webhook. |
| Door switch | `door.adapter`: `shelly` (Gen1 or Gen2 relay), `tasmota`, `homeassistant` (`switch.*`, `lock.*` or `cover.*`), or `webhook`. `pulseMs > 0` makes "open" a momentary pulse (door strike, gate). | Room Guard's alarm can call `POST /api/door/lock`; use "Use the server for the door lock" in the camera app's Settings. |
| Govee lights | `govee.apiKey` from the Govee Home app (Settings → Apply for API key). | Uses the Govee cloud API, so it works from anywhere. Power, brightness, colour and colour temperature. Rate limit is 10 000 calls/day. |

Set `"mock": true` to simulate all devices while you build things.

## The smart room: modes, scenes, automations and more

| Feature | Config | What it does |
| --- | --- | --- |
| Modes | – | Home / Away / Sleep / Guest, switched from the dashboard or by scenes; automations can be conditioned on the mode. |
| Scenes | `scenes` (optional; defaults built in: I'm home, Wake up, Focus, Movie, Sleep, Away) | One tap runs a list of actions: `{device:'lights', all:{power,brightness,color,colorTempK}}`, `{device:'ac', set:{…}}`, `{device:'door', action}`, `{device:'switch', id, action}`, `{device:'switches', all:'off'}`, `{device:'camera', command:'arm'}`, `{device:'notify', title, message}`, `{device:'mode', mode}`, `{device:'scene', id}`. A scene with `mode` also sets the mode. |
| Automations | `automations` (optional; defaults built in) | `trigger`: `{type:'alarm'}`, `{type:'presence'}` (someone entered), `{type:'empty', minutes:15}`, `{type:'schedule', at:'23:00'}`, `{type:'door', state:'open'}`, `{type:'armed', armed:true}`. Optional `conditions`: `{mode, armed, between:['22:00','07:00']}`. Toggles are saved in `data/automations.json`. Only "Intruder response" is on by default. |
| Plugs & switches | `switches: [{id, name, icon, adapter, shelly|tasmota|homeassistant|webhook}]` | Any relay, same adapters as the door. |
| Sensors | `sensors: [{id, name, kind, unit, entityId}]` | Home Assistant sensor entities (temperature, humidity, co2, illuminance…). |
| Weather | `location: {lat, lon, name}` | Outdoor conditions from Open-Meteo, no key needed. |
| Phone alerts | `notify: {adapter:'ntfy', ntfy:{topic}}` or `{adapter:'telegram', telegram:{botToken, chatId}}` | ntfy: install the ntfy app, subscribe to a topic name of your choice, put the same name in the config. |
| Activity | – | Everything that happens is logged to `data/activity.json` and streamed to the dashboard. |
| Room name | `roomName` | Shown at the top of the dashboard. |

## Connecting the camera app

In the camera app's **Settings → Home server**, enter the server URL and
token and press **Test connection**. From then on visits, clips and
snapshots are stored on the server, the live feed is sent every 500 ms,
and the dashboard can arm and disarm the alarm.

The camera app is served over HTTPS (GitHub Pages), and browsers refuse to
send data from an HTTPS page to a plain-HTTP server. Three ways to give the
server HTTPS:

1. **Tailscale (recommended).** Install Tailscale on the server machine and
   on the iPad, then run `tailscale serve --bg 8787`. The server is then
   reachable at `https://<machine>.<tailnet>.ts.net` with a valid
   certificate, from home or anywhere, with nothing exposed to the internet.
2. **Cloudflare Tunnel.** `cloudflared tunnel --url http://localhost:8787`
   gives a public HTTPS hostname; protect it with Cloudflare Access.
3. **Own certificate.** Set `https.cert` and `https.key` in the config (for
   example from Let's Encrypt with a DDNS domain).

Alternatively serve the camera app from the server itself (`http://…:8787/`)
on the same machine, where `localhost` counts as secure.

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
