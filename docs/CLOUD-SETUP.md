# One-time cloud setup (about 10 minutes)

Everything runs from one link, <https://ahmedps520-svg.github.io/human-recognistion-v1/>,
with one sign-in. The camera app, the dashboard and the home agent on your
PC all talk through a small free **Supabase** project that only you can
read. You create that project once; after that it is only email + password.

## 1. Create the project

1. Go to <https://supabase.com>, sign up (GitHub login is fine) and press
   **New project**. Pick any name, a strong database password (you will not
   need it again) and the region closest to you. Wait a minute while it is created.
2. Open **SQL Editor** (left sidebar) → **New query**, paste the whole
   contents of [`supabase/schema.sql`](../supabase/schema.sql) and press
   **Run**. It creates the tables, the clips bucket, the security rules and
   turns on realtime. Running it again later is harmless.
3. Open **Authentication → Users** → **Add user** → **Create new user**.
   Enter your email and a password, tick **Auto Confirm User**, create.
   This is the one household account every device signs in with.
4. Open **Authentication → Sign In / Providers → Email** and turn **off**
   "Allow new users to sign up", so nobody else can create an account.
5. Open **Project Settings → API** (or **Settings → API Keys**) and copy two
   things: the **Project URL** (`https://xxxx.supabase.co`) and the
   **anon public** key (a long string). Both are safe to share with your
   own devices; the tables still need the sign-in from step 3.

## 2. Tell the site about the project

The project URL is already baked into the site (`CLOUD.supabaseUrl` in
`assets/js/config.js`). What is still missing is the **anon public key**:

- **Bake it in (recommended, once).** Put it into `assets/js/config.js`
  under `CLOUD.supabaseAnonKey` and push to `main`. From then on every
  device only sees the email + password screen. (Send me the key in chat
  and I will do this for you. Never send the password.)
- **Per device.** Open the site, expand **First-time setup** on the sign-in
  screen and paste the key there. It is remembered in that browser.

The key is public by design: every table still needs the sign-in from
step 3 (row level security), so the key alone cannot read anything.

## 3. Sign in on each device

- **iPad (camera):** open the link in Safari, sign in, press **Start
  camera**. Add it to the Home Screen so it opens full screen.
- **Phone or laptop (dashboard):** open the link with `dashboard.html` at
  the end, sign in. Signing in on one page signs in both pages of the site
  in that browser.

## 4. Start the home agent on the PC

The agent is the only part that talks to real devices (door switch, AC,
Govee lights, plugs, Minecraft server, phone alerts). It needs Node.js 22
or newer.

```
npm install
npm run agent:mock     # first try: simulated devices
npm run agent          # real devices from server/config.json
```

The first run asks for the project URL + anon key (unless they are baked
into the site) and then for your email + password. The sign-in is remembered
in `server/data/agent-auth.json`, so afterwards it starts without questions.
Leave the window open; the dashboard header shows **agent on** while it
runs. To start it automatically with Windows, create a Task Scheduler task
that runs `npm run agent` in the project folder at logon.

Device settings (Govee key, door adapter, ntfy topic for phone alerts…) go
in `server/config.json`; see [`server/README.md`](../server/README.md).

## What goes where

| | Where it lives |
| --- | --- |
| Sign-in | Supabase Auth, one user |
| Mode, armed, alarm, room name, automation switches | table `home` (one row) |
| Door, AC, lights, plugs, sensors, weather, Minecraft, scenes, automations | table `device_states`, mirrored by the agent |
| Timeline | table `activity` |
| Visits with snapshots and clips | table `events` + bucket `clips` |
| Who is online and what the camera sees right now | realtime presence |
| Buttons (unlock, scene, siren…) and live-video handshake | realtime broadcast |
| Live video | straight from the iPad to the dashboard (WebRTC); one JPEG per second over the channel as a fallback |

The free Supabase tier (500 MB database, 1 GB storage, 2 million realtime
messages per month) is enough for a household; clips are the only thing
that grows, and `schema.sql` shows how to purge old ones automatically.

## Troubleshooting

- **"Wrong email or password"** – the user from step 3; check for a typo,
  or set a new password in Supabase → Authentication → Users.
- **"This user is not confirmed yet"** – in Authentication → Users open the
  user and confirm the email (or recreate it with Auto Confirm ticked).
- **Dashboard says "agent off"** – start `npm run agent` on the PC; the
  devices keep their last known state until it is back.
- **Dashboard says "Camera app is not open"** – open the site on the iPad
  and sign in; "Camera is off" means it is open but not started (press
  Start camera on either device).
- **Live picture says "snapshots" instead of "direct"** – the two devices
  could not open a direct connection (unusual router); the picture still
  updates once per second.
- **Nothing updates live** – the SQL file was not run completely (realtime
  is turned on at its end). Run it again.
