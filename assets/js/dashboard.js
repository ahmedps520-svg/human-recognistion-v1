// Smart-room dashboard. Everything on screen comes from the cloud project
// (tables + one realtime channel) and updates live. The home agent on the PC
// drives the real devices; the camera app on the iPad publishes the room.

import { CLOUD } from './config.js';
import { Cloud, readCloudConfig, saveCloudConfig, clearCloudConfig } from './cloud.js';
import { LiveViewer } from './live.js';
import { homeFromRow, activityFromRow, defaultHome } from './rows.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDuration = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const ago = (d) => {
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 60000) return 'just now';
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} h ago`;
  return fmtDay(d);
};
const WEATHER_ICON = (code, day) => {
  if (code == null) return '🌡️';
  if (code === 0) return day ? '☀️' : '🌙';
  if (code <= 2) return day ? '🌤️' : '☁️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '🌨️';
  if (code <= 82) return '🌦️';
  return '⛈️';
};
const AGENT_CARDS = ['cardSecurity', 'cardScenes', 'cardClimate', 'cardLights', 'cardSwitches', 'cardAutomations', 'cardMinecraft', 'cardWeather'];

// ---------------------------------------------------------------- state
let cloud = null;
let viewer = null;
const S = {
  home: defaultHome(),
  devices: {},
  activity: [],
  visits: [],
  visitsToday: 0,
  presence: { camera: null, agent: null, dashboards: [] },
  connected: false,
  lastFrameAt: 0,
  rendered: {},
  retryTimer: null,
};

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 2600);
}

/** Render only when the data for a section changed (keeps the DOM calm). */
function changed(key, data) {
  const sig = JSON.stringify(data);
  if (S.rendered[key] === sig) return false;
  S.rendered[key] = sig;
  return true;
}

async function act(cardId, fn) {
  const card = cardId ? $(cardId) : null;
  card?.classList.add('busy');
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    return null;
  } finally {
    card?.classList.remove('busy');
  }
}

const camera = () => S.presence.camera;
const agentOnline = () => !!S.presence.agent;
const dev = (name) => S.devices[name] || null;

// ---------------------------------------------------------------- sign-in
function showGate() {
  const cfg = readCloudConfig(CLOUD);
  $('gate').classList.remove('hidden');
  $('gate').setAttribute('aria-hidden', 'false');
  $('gateSetup').open = !cfg.configured;
  $('gateSetup').classList.toggle('hidden', cfg.source === 'baked');
  $('gateForm').elements.url.value = cfg.url || '';
  $('gateForm').elements.url.closest('label').classList.toggle('hidden', cfg.bakedUrl);
  $('gateProject').textContent = cfg.configured ? `Project: ${cfg.url.replace(/^https?:\/\//, '')}` : cfg.url ? `Project: ${cfg.url.replace(/^https?:\/\//, '')} · paste its anon key once` : 'No cloud project on this device yet';
  $('gateError').classList.add('hidden');
  setLive(false, 'Sign in to see your room');
  setTimeout(() => $('gateForm').elements.email.focus(), 50);
}

function hideGate() {
  $('gate').classList.add('hidden');
  $('gate').setAttribute('aria-hidden', 'true');
}

async function gateSubmit(ev) {
  ev.preventDefault();
  const f = $('gateForm');
  const email = f.elements.email.value.trim();
  const password = f.elements.password.value;
  const url = f.elements.url.value.trim();
  const anonKey = f.elements.anonKey.value.trim();
  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (!readCloudConfig(CLOUD).configured || (url && anonKey)) {
      if (!url || !anonKey) throw new Error(url ? 'First-time setup: paste the anon key from Supabase → Settings → API Keys.' : 'First-time setup: paste the project URL and the anon key from Supabase → Settings → API Keys.');
      saveCloudConfig({ url, anonKey });
      if (cloud) await cloud.close().catch(() => {});
      cloud = null;
      await createCloud();
    }
    if (!cloud) throw new Error('No cloud project configured.');
    if (!email || !password) throw new Error('Enter your email and password.');
    await cloud.signIn(email, password);
    f.elements.password.value = '';
    await enter();
  } catch (e) {
    $('gateError').textContent = e.message;
    $('gateError').classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

async function createCloud() {
  const cfg = readCloudConfig(CLOUD);
  if (!cfg.configured) return null;
  cloud = new Cloud({ url: cfg.url, anonKey: cfg.anonKey, role: 'dashboard' });
  await cloud.init();
  cloud.onAuth((user) => {
    if (!user) {
      viewer?.stop();
      showGate();
    }
  });
  return cloud;
}

async function boot() {
  try {
    await createCloud();
  } catch (e) {
    toast(`Cloud: ${e.message}`, 'error');
  }
  if (!cloud || !cloud.user) {
    showGate();
    return;
  }
  await enter();
}

// ---------------------------------------------------------------- connection
function setLive(on, text) {
  S.connected = on;
  $('liveDot').classList.toggle('on', on);
  if (text) $('roomSub').textContent = text;
}

async function enter() {
  hideGate();
  setLive(false, 'Loading…');
  try {
    const [home, devices, activity] = await Promise.all([cloud.getHome(), cloud.listDevices(), cloud.listActivity(40)]);
    S.home = home;
    S.devices = devices;
    S.activity = activity;
  } catch (e) {
    setLive(false, `Could not load the room: ${e.message}`);
    toast(e.message, 'error');
    return;
  }
  if (!S.subscribed) {
    S.subscribed = true;
    cloud.onTable('home', (ev) => {
      if (!ev.new) return;
      const prev = S.home;
      S.home = homeFromRow(ev.new);
      renderModes();
      renderSecurity();
      renderAutomations();
      renderCamera();
      if (prev.roomName !== S.home.roomName) $('roomName').textContent = S.home.roomName;
    });
    cloud.onTable('device_states', (ev) => {
      if (!ev.new) return;
      S.devices[ev.new.device] = { ...(ev.new.state || {}), updatedAt: ev.new.updated_at };
      renderDevice(ev.new.device);
    });
    cloud.onTable('activity', (ev) => {
      if (ev.eventType !== 'INSERT' || !ev.new) return;
      S.activity.unshift(activityFromRow(ev.new));
      S.activity.length = Math.min(S.activity.length, 60);
      renderActivity(true);
    });
    cloud.onTable('events', () => refreshVisits());
    cloud.onPresence((p) => {
      S.presence = p;
      renderCamera();
      renderSecurity();
      renderAgent();
      maybeWatch();
    });
    cloud.onStatus((st) => {
      if (st === 'live') setLive(true);
      else if (st === 'joining') setLive(false, 'Connecting…');
      else setLive(false, 'Reconnecting…');
      renderCamera();
    });
    cloud.on('frame', showFrame);
    viewer = new LiveViewer(cloud, {
      video: $('camVideo'),
      onState: (st) => {
        updateWants();
        renderCamera();
        if (st === 'failed') {
          clearTimeout(S.retryTimer);
          S.retryTimer = setTimeout(() => maybeWatch(), 30000);
        }
      },
    });
    document.addEventListener('visibilitychange', () => {
      updateWants();
      if (!document.hidden) maybeWatch();
    });
  }
  $('roomName').textContent = S.home.roomName || 'My room';
  renderAll();
  refreshVisits();
  await cloud.join({ wantsFrames: !document.hidden });
  renderAgent();
}

/** Tell the camera whether we need JPEG snapshots (no direct video yet, page visible). */
function updateWants() {
  if (!cloud) return;
  cloud.track({ wantsFrames: !document.hidden && viewer?.state !== 'connected' });
}

/** Ask the camera for a direct video connection whenever it is running and we have none. */
function maybeWatch() {
  if (!viewer || document.hidden) return;
  const cam = camera();
  if (!cam || !cam.running) {
    if (viewer.state !== 'idle') viewer.stop();
    return;
  }
  if (viewer.state === 'idle' || viewer.state === 'failed') viewer.request();
}

function showFrame(f) {
  if (!f?.jpeg) return;
  const img = $('camFrame');
  img.src = `data:image/jpeg;base64,${f.jpeg}`;
  S.lastFrameAt = Date.now();
  renderCamera();
}

// ---------------------------------------------------------------- renderers
function renderAll() {
  renderModes();
  renderCamera();
  renderSecurity();
  renderScenes();
  renderClimate();
  renderLights();
  renderSwitches();
  renderActivity();
  renderAutomations();
  renderMinecraft();
  renderWeather();
  renderAgent();
}

function renderDevice(name) {
  switch (name) {
    case 'door':
      return renderSecurity();
    case 'ac':
    case 'sensors':
      return renderClimate();
    case 'lights':
      return renderLights();
    case 'switches':
      return renderSwitches();
    case 'scenes':
      return renderScenes();
    case 'automations':
      return renderAutomations();
    case 'minecraft':
      return renderMinecraft();
    case 'weather':
      return renderWeather();
    case 'agent':
    case 'notify':
      return renderAgent();
    default:
      return null;
  }
}

function renderModes() {
  for (const b of $('modes').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === S.home.mode);
  for (const el of document.querySelectorAll('.scene')) el.classList.toggle('active', !!el.dataset.mode && el.dataset.mode === S.home.mode);
}

function renderAgent() {
  const on = agentOnline();
  const a = S.presence.agent || dev('agent') || {};
  const chip = $('chipAgent');
  chip.className = `chip chip-agent ${on ? 'on' : 'off'}`;
  chip.innerHTML = `🖥️ <b>${on ? `agent on${a.mock ? ' · demo' : ''}` : 'agent off'}</b>`;
  chip.title = on ? `Home agent v${a.version || '?'}${a.mock ? ' (mock devices: nothing is wired yet)' : ''}` : 'Start the home agent on your PC: npm run agent';
  for (const id of AGENT_CARDS) $(id)?.classList.toggle('offline', !on);
  const notify = dev('notify');
  $('serverInfo').textContent = [
    `Signed in as ${cloud?.user?.email || '–'}`,
    `Cloud project: ${readCloudConfig(CLOUD).url.replace(/^https?:\/\//, '') || '–'}`,
    `Home agent: ${on ? `online · v${a.version || '?'}${a.mock ? ' · mock devices' : ''}` : 'offline (run "npm run agent" on your PC)'}`,
    `Camera: ${camera() ? (camera().running ? 'running' : 'app open, camera off') : 'offline'}`,
    `Phone alerts: ${notify?.enabled ? notify.adapter : 'not configured (server/config.json → notify)'}`,
  ].join('\n');
  $('btnCloudReset').classList.toggle('hidden', readCloudConfig(CLOUD).source !== 'local');
}

function renderCamera() {
  const cam = camera();
  const online = !!cam && !!cam.running;
  const people = online ? cam.people || 0 : 0;
  const video = $('camVideo');
  const frame = $('camFrame');
  const direct = viewer?.state === 'connected';
  const freshFrame = Date.now() - S.lastFrameAt < 8000 && !!frame.src;
  video.hidden = !direct;
  frame.hidden = direct || !freshFrame;
  const showOffline = !direct && !freshFrame;
  $('camOffline').classList.toggle('hidden', !showOffline);
  if (showOffline) {
    $('camOfflineTitle').textContent = !cam ? 'Camera app is not open' : !cam.running ? 'Camera is off' : viewer?.state === 'connecting' ? 'Connecting to the camera…' : 'Waiting for the picture…';
    $('camOfflineHint').textContent = !cam
      ? 'Open the camera app on the iPad, sign in with the same account and press Start camera.'
      : !cam.running
        ? 'Press "Start camera" here or on the iPad.'
        : 'The first picture takes a few seconds.';
  }
  const q = $('camQuality');
  q.hidden = showOffline;
  q.textContent = direct ? 'direct · live' : 'snapshots';
  $('btnCamStart').textContent = online ? 'Stop camera' : 'Start camera';
  $('btnCamStart').disabled = !cam;
  const peopleEl = $('camPeople');
  peopleEl.textContent = !online ? (cam ? 'Camera off' : 'Camera offline') : people ? `${people} ${people === 1 ? 'person' : 'people'} in the room` : 'Nobody in the room';
  peopleEl.className = `chip chip-dark ${people ? 'people' : ''}`;
  const armed = S.home.armed;
  $('camArmed').textContent = armed ? 'Armed' : 'Disarmed';
  $('camArmed').className = `chip chip-dark ${armed ? 'armed' : ''}`;
  $('camRec').classList.toggle('hidden', !(online && cam.recording));
  $('camMeta').textContent = online ? `Live · ${cam.mode === 'identify' ? 'identifying people' : 'recording every visit'}${cam.viewers ? ` · ${cam.viewers} watching` : ''}` : cam ? 'Camera app open, camera off' : 'Waiting for the camera app';
  const since = people ? Math.min(...(cam.tracks || []).map((t) => t.since || Date.now())) : null;
  const sub = !online ? (cam ? 'Camera off' : 'Camera offline') : people ? `Occupied${since ? ` for ${fmtDuration(Date.now() - since)}` : ''}` : `Empty${cam.emptySince ? ` since ${fmtTime(cam.emptySince)}` : ''}`;
  if (S.connected) $('roomSub').textContent = `${sub}${S.home.mode ? ` · ${S.home.mode} mode` : ''}`;
  $('camSince').textContent = people && since ? `in view ${fmtDuration(Date.now() - since)}` : '';
  $('secVisitsToday').textContent = S.visitsToday ?? 0;
  $('visitsToday').textContent = `${S.visitsToday ?? 0} today`;
  if (S.visits[0]) $('secLastVisit').textContent = ago(S.visits[0].startedAt);
}

function renderSecurity() {
  const armed = S.home.armed;
  const alarm = S.home.alarm;
  const ring = $('secRing');
  ring.className = `ring ${alarm ? 'alarm' : armed ? 'armed' : ''}`;
  $('secIcon').textContent = alarm ? '🚨' : armed ? '🔒' : '🛡️';
  $('secText').textContent = alarm ? 'ALARM' : armed ? 'Armed' : 'Secure';
  $('alarmStrip').classList.toggle('hidden', !alarm);
  $('btnArm').classList.toggle('accent', !armed);
  $('btnDisarm').classList.toggle('accent', !!armed);
  const lastAlarm = S.home.alarmAt || S.activity.find((e) => e.kind === 'alarm')?.at;
  $('secLastAlarm').textContent = lastAlarm ? ago(lastAlarm) : 'never';
  const d = dev('door');
  const btn = $('btnDoor');
  if (!d || d.enabled === false || d.adapter === 'none') {
    $('doorState').textContent = 'Door switch not set up';
    $('doorNote').textContent = agentOnline() ? 'configure door.adapter in server/config.json' : 'home agent offline';
    $('doorIcon').textContent = '🚪';
    btn.classList.remove('open');
    btn.disabled = true;
    return;
  }
  btn.disabled = !agentOnline();
  if (d.error) {
    $('doorState').textContent = 'Door switch error';
    $('doorNote').textContent = d.error;
    return;
  }
  const open = d.on === true;
  btn.classList.toggle('open', open);
  $('doorIcon').textContent = open ? '🔓' : '🔒';
  $('doorState').textContent = open ? 'Door unlocked' : 'Door locked';
  $('doorNote').textContent = d.lastAction ? `${d.lastAction.action} · ${ago(d.lastAction.at)}` : 'tap to toggle';
}

function renderScenes() {
  const list = dev('scenes')?.list || [];
  if (!changed('scenes', list)) return;
  $('sceneRow').innerHTML = list.length
    ? list
        .map((s) => `<button type="button" class="scene" data-scene="${esc(s.id)}" ${s.mode ? `data-mode="${esc(s.mode)}"` : ''}><span class="ico">${esc(s.icon)}</span><span class="nm">${esc(s.name)}</span><span class="last">${s.lastRun ? `ran ${ago(s.lastRun)}` : `${s.actions} steps`}</span></button>`)
        .join('')
    : '<p class="muted small">Scenes appear once the home agent has run on your PC.</p>';
  renderModes();
}

function renderClimate() {
  const ac = dev('ac');
  const badge = $('acState');
  if (!ac || ac.enabled === false || ac.adapter === 'none') {
    badge.textContent = 'Not set up';
    badge.className = 'badge';
    $('acNote').textContent = 'Configure ac.adapter in server/config.json (Sensibo, Home Assistant or webhooks).';
  } else if (ac.error) {
    badge.textContent = 'Error';
    badge.className = 'badge danger';
    $('acNote').textContent = ac.error;
  } else {
    badge.textContent = ac.power ? `On · ${ac.mode || ''}` : 'Off';
    badge.className = `badge ${ac.power ? 'on' : ''}`;
    $('acTarget').textContent = ac.targetTemp ?? '–';
    $('acPower').textContent = ac.power ? 'Turn off' : 'Turn on';
    $('acPower').classList.toggle('accent', !ac.power);
    for (const b of $('acModes').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === ac.mode);
    if (ac.fanLevel) $('acFan').value = ['auto', 'low', 'medium', 'high'].includes(ac.fanLevel) ? ac.fanLevel : 'auto';
    $('acNote').textContent = ac.room ? `${ac.room} · ${ac.adapter}` : '';
  }
  const sensors = dev('sensors')?.list || [];
  const temp = sensors.find((x) => x.kind === 'temperature')?.value ?? ac?.currentTemp ?? null;
  const hum = sensors.find((x) => x.kind === 'humidity')?.value ?? ac?.humidity ?? null;
  $('chipInside').innerHTML = `🌡️ <b>${temp != null ? `${Number(temp).toFixed(1)}°` : '–'}</b>${hum != null ? ` · ${Math.round(hum)}%` : ''}`;
  if (changed('sensors', sensors)) {
    $('sensorRow').innerHTML = sensors
      .map((s) => `<div class="sensor"><b>${s.value != null ? `${s.value}${esc(s.unit || '')}` : '–'}</b><small>${esc(s.name)}</small></div>`)
      .join('');
  }
}

const rgbHex = (c) => (c ? `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}` : '#ffffff');
const hexRgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function renderLights() {
  const l = dev('lights');
  const list = $('lightList');
  if (!l || l.enabled === false) {
    list.innerHTML = '<p class="muted small">Add your Govee API key in server/config.json (govee.apiKey). Get it in the Govee Home app under Settings → Apply for API key.</p>';
    return;
  }
  if (l.error) {
    list.innerHTML = `<p class="muted small">${esc(l.error)}</p>`;
    return;
  }
  if (!changed('lights', l.devices)) return;
  list.innerHTML = (l.devices || [])
    .map((d) => {
      const s = d.state || {};
      return `<div class="light ${s.power ? '' : 'off'}" data-device="${esc(d.device)}">
        <div class="row1"><span class="name"><i class="swatch" style="background:${s.power ? rgbHex(s.color) : '#333'};color:${s.power ? rgbHex(s.color) : 'transparent'}"></i>${esc(d.deviceName)}</span>
          <button type="button" class="switch ${s.power ? 'on' : ''}" data-power="${s.power ? '0' : '1'}" aria-label="power"></button></div>
        <label>Brightness <input type="range" min="1" max="100" value="${s.brightness ?? 50}" data-brightness><input type="color" value="${rgbHex(s.color)}" data-color title="Colour"></label>
        ${s.online === false ? '<small class="muted">offline</small>' : ''}
      </div>`;
    })
    .join('');
}

function renderSwitches() {
  const list = $('switchList');
  const switches = dev('switches')?.list || [];
  if (!switches.length) {
    list.innerHTML = '<p class="muted small">Add plugs and switches under "switches" in server/config.json (Shelly, Tasmota, Home Assistant or webhooks).</p>';
    return;
  }
  if (!changed('switches', switches)) return;
  list.innerHTML = switches
    .map((sw) => `<div class="sw ${sw.on ? '' : 'off'}" data-switch="${esc(sw.id)}"><div class="row1"><span class="name"><span class="ico">${esc(sw.icon)}</span>${esc(sw.name)}${sw.error ? `<small class="muted"> · ${esc(sw.error)}</small>` : ''}</span><button type="button" class="switch ${sw.on ? 'on' : ''}" data-action="${sw.on ? 'off' : 'on'}" aria-label="toggle"></button></div></div>`)
    .join('');
}

async function refreshVisits() {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [events, count] = await Promise.all([cloud.listEvents(8), cloud.countEventsSince(todayStart.toISOString())]);
    S.visits = events;
    S.visitsToday = count;
    renderCamera();
    if (!changed('visits', events)) return;
    const list = $('visitList');
    if (!events.length) {
      list.innerHTML = '<li class="muted small">No visits yet. The camera logs everyone who enters, with a snapshot and clip.</li>';
      return;
    }
    const urls = await Promise.all(events.map(async (e) => ({ snap: e.snapshotPath ? await cloud.mediaUrl(e.snapshotPath).catch(() => null) : null, clips: await Promise.all((e.clipPaths?.length ? e.clipPaths : e.clipPath ? [e.clipPath] : []).map((p) => cloud.mediaUrl(p).catch(() => null))) })));
    list.innerHTML = events
      .map((e, i) => {
        const dur = e.endedAt ? fmtDuration(new Date(e.endedAt) - new Date(e.startedAt)) : 'now';
        const u = urls[i];
        return `<li>
          ${u.snap ? `<img src="${esc(u.snap)}" alt="" loading="lazy">` : '<div class="no-thumb">no snapshot</div>'}
          <div class="when"><b>${e.personName ? esc(e.personName) : 'Someone'}</b>${e.alarmTriggered ? '<span class="tag alarm">alarm</span>' : ''}<small>${esc(fmtDay(e.startedAt))} ${esc(fmtTime(e.startedAt))} · ${dur}</small>${e.features?.ai?.summary ? `<small>${esc(e.features.ai.summary)}</small>` : ''}</div>
          <div>${u.clips.filter(Boolean).map((url, k) => `<a class="pill small" href="${esc(url)}" target="_blank" rel="noopener">▶${u.clips.length > 1 ? ` ${k + 1}` : ''}</a>`).join(' ')}</div>
        </li>`;
      })
      .join('');
  } catch (e) {
    console.warn('visits', e.message);
  }
}

function renderActivity(flash = false) {
  if (!changed('activity', S.activity)) return;
  const list = $('activityList');
  if (!S.activity.length) {
    list.innerHTML = '<li class="muted small">Nothing yet. Scenes, visits, door and device changes show up here as they happen.</li>';
    return;
  }
  list.innerHTML = S.activity
    .slice(0, 25)
    .map((e, i) => `<li class="${esc(e.kind)} ${flash && i === 0 ? 'new' : ''}"><time>${esc(fmtTime(e.at))}</time><span>${esc(e.text)}</span></li>`)
    .join('');
}

/** Built-in rules from the agent, with the enabled flags the dashboard saved in the home row. */
function automationList() {
  const base = dev('automations')?.list || [];
  return base.map((a) => ({ ...a, enabled: S.home.automations?.[a.id]?.enabled ?? a.enabled }));
}

function renderAutomations() {
  const list = automationList();
  if (!changed('automations', list)) return;
  $('automationList').innerHTML = list.length
    ? list
        .map((a) => `<div class="auto" data-automation="${esc(a.id)}"><span class="ico">${esc(a.icon)}</span><div class="txt"><b>${esc(a.name)}</b><small>${esc(a.description || '')}${a.lastFired ? ` · last ${ago(a.lastFired)}` : ''}</small></div><button type="button" class="run" data-run>Run</button><button type="button" class="switch ${a.enabled ? 'on' : ''}" data-enabled="${a.enabled ? '0' : '1'}" aria-label="enabled"></button></div>`)
        .join('')
    : '<p class="muted small">Automations appear once the home agent has run on your PC.</p>';
}

function renderMinecraft() {
  const mc = dev('minecraft');
  const badge = $('mcState');
  if (!mc || mc.enabled === false) {
    badge.textContent = 'Disabled';
    badge.className = 'badge';
    $('mcInfo').innerHTML = '';
    return;
  }
  badge.textContent = mc.online ? 'Online' : 'Offline';
  badge.className = `badge ${mc.online ? 'on' : 'danger'}`;
  const rows = [];
  if (mc.online) {
    rows.push(['Players', `${mc.players.online} / ${mc.players.max}${mc.players.sample?.length ? ` · ${mc.players.sample.map(esc).join(', ')}` : ''}`]);
    rows.push(['Version', esc(mc.version)]);
    if (mc.motd) rows.push(['MOTD', esc(mc.motd)]);
    if (mc.latencyMs != null) rows.push(['Ping', `${mc.latencyMs} ms`]);
  } else rows.push(['Status', `not reachable${mc.error ? ` (${esc(mc.error)})` : ''}`]);
  $('mcInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderWeather() {
  const w = dev('weather');
  if (!w || w.enabled === false || w.error) {
    $('chipWeather').innerHTML = `⛅ <b>–</b>`;
    $('weatherTemp').textContent = '–';
    $('weatherDesc').textContent = w?.error ? w.error : 'Set location.lat / location.lon in server/config.json for outdoor weather.';
    $('weatherFacts').textContent = '';
    return;
  }
  const icon = WEATHER_ICON(w.code, w.isDay);
  $('chipWeather').innerHTML = `${icon} <b>${Math.round(w.temperature)}°</b> outside`;
  $('weatherIcon').textContent = icon;
  $('weatherTemp').textContent = `${Math.round(w.temperature)}°`;
  $('weatherDesc').textContent = w.description || '';
  $('weatherPlace').textContent = w.name || '';
  $('weatherFacts').textContent = [w.humidity != null ? `${Math.round(w.humidity)}% humidity` : '', w.wind != null ? `wind ${Math.round(w.wind)} km/h` : ''].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- actions
const agent = (action, params = {}) => cloud.command('agent', action, params, { timeout: 12000 });

async function setMode(mode) {
  const prev = S.home.mode;
  S.home = { ...S.home, mode };
  renderModes();
  const r = await act(null, async () => {
    await cloud.setHome({ mode });
    await cloud.addActivity('mode', `Mode set to ${mode}`, { source: 'dashboard' });
    return true;
  });
  if (!r) {
    S.home = { ...S.home, mode: prev };
    renderModes();
  }
}

async function setArmed(armed) {
  await act('cardCamera', async () => {
    await cloud.setHome({ armed });
    await cloud.addActivity('security', armed ? '🔒 Camera armed from the dashboard' : '🔓 Camera disarmed from the dashboard', { source: 'dashboard' });
    toast(armed ? 'Armed' : 'Disarmed');
  });
}

async function runScene(id) {
  const r = await act('cardScenes', () => agent('scene', { id }));
  if (r) toast(r.failed ? `${r.name}: ${r.failed} step${r.failed > 1 ? 's' : ''} skipped (device not set up)` : `${r.name} ✓`);
}

async function setAc(changes) {
  const r = await act('cardClimate', () => agent('ac', { changes }));
  if (r?.state) {
    S.devices.ac = { ...(S.devices.ac || {}), ...r.state };
    renderClimate();
  }
}

async function setDoor(action) {
  const r = await act('cardSecurity', () => agent('door', { action }));
  if (r?.state) {
    S.devices.door = { ...(S.devices.door || {}), ...r.state };
    renderSecurity();
  }
}

async function setLight(device, changes) {
  await act('cardLights', () => agent('light', { device, changes }));
}

async function setSwitch(id, action) {
  const r = await act('cardSwitches', () => agent('switch', { id, action }));
  if (r?.state) {
    const list = (S.devices.switches?.list || []).map((s) => (s.id === r.state.id ? r.state : s));
    S.devices.switches = { ...(S.devices.switches || {}), list };
    renderSwitches();
  }
}

function snapshot() {
  const video = $('camVideo');
  const frame = $('camFrame');
  const canvas = document.createElement('canvas');
  let w = 0;
  let h = 0;
  if (!video.hidden && video.videoWidth) {
    w = video.videoWidth;
    h = video.videoHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  } else if (!frame.hidden && frame.naturalWidth) {
    w = frame.naturalWidth;
    h = frame.naturalHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(frame, 0, 0, w, h);
  } else return toast('No picture to save yet', 'error');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/jpeg', 0.9);
  a.download = `room-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
  a.click();
}

// ---------------------------------------------------------------- sheet
function openSheet() {
  $('roomForm').elements.roomName.value = S.home.roomName || '';
  renderAgent();
  $('sheet').classList.add('open');
  $('sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheet').setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------- bind
function bind() {
  $('gateForm').addEventListener('submit', gateSubmit);
  $('btnSettings').addEventListener('click', openSheet);
  $('btnSheetClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
  $('roomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomName = e.target.elements.roomName.value.trim() || 'My room';
    await act(null, () => cloud.setHome({ roomName }));
    $('roomName').textContent = roomName;
    closeSheet();
  });
  $('btnSignOut').addEventListener('click', async () => {
    viewer?.stop();
    await cloud?.signOut().catch(() => {});
    showGate();
  });
  $('btnCloudReset').addEventListener('click', async () => {
    if (!confirm('Forget the cloud project saved on this device? You will be asked for the URL and key again.')) return;
    viewer?.stop();
    await cloud?.signOut().catch(() => {});
    clearCloudConfig();
    location.reload();
  });
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('btnArm').addEventListener('click', () => setArmed(true));
  $('btnDisarm').addEventListener('click', () => setArmed(false));
  $('btnCamStart').addEventListener('click', () => act('cardCamera', () => cloud.command('camera', camera()?.running ? 'stop' : 'start').then(() => toast(camera()?.running ? 'Stopping the camera' : 'Starting the camera'))));
  $('btnSnapshot').addEventListener('click', snapshot);
  $('btnSiren').addEventListener('click', () => act('cardSecurity', () => cloud.command('camera', 'siren').then(() => toast('Siren test sent to the camera'))));
  $('btnNotifyTest').addEventListener('click', () => act('cardSecurity', () => agent('notify', { title: 'Home', message: 'Test alert from your dashboard' }).then((r) => toast(`Sent via ${r.adapter}`))));
  for (const b of document.querySelectorAll('[data-door]')) b.addEventListener('click', () => setDoor(b.dataset.door));
  $('sceneRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scene]');
    if (b) runScene(b.dataset.scene);
  });
  $('acUp').addEventListener('click', () => setAc({ targetTemp: (dev('ac')?.targetTemp ?? 23) + 1 }));
  $('acDown').addEventListener('click', () => setAc({ targetTemp: (dev('ac')?.targetTemp ?? 23) - 1 }));
  $('acPower').addEventListener('click', () => setAc({ power: !dev('ac')?.power }));
  $('acModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAc({ mode: b.dataset.mode, power: true });
  });
  $('acFan').addEventListener('change', (e) => setAc({ fanLevel: e.target.value }));
  for (const b of document.querySelectorAll('button[data-all]')) {
    b.addEventListener('click', () => act('cardLights', () => agent('lights.all', { changes: { power: b.dataset.all === 'on' } })));
  }
  $('lightList').addEventListener('click', (e) => {
    const sw = e.target.closest('button[data-power]');
    if (!sw) return;
    sw.classList.toggle('on');
    setLight(sw.closest('.light').dataset.device, { power: sw.dataset.power === '1' });
  });
  $('lightList').addEventListener('change', (e) => {
    const card = e.target.closest('.light');
    if (!card) return;
    if (e.target.matches('[data-brightness]')) setLight(card.dataset.device, { brightness: Number(e.target.value), power: true });
    if (e.target.matches('[data-color]')) setLight(card.dataset.device, { color: hexRgb(e.target.value), power: true });
  });
  for (const b of document.querySelectorAll('button[data-sw-all]')) {
    b.addEventListener('click', () => act('cardSwitches', () => agent('switches.all', { action: b.dataset.swAll })));
  }
  $('switchList').addEventListener('click', (e) => {
    const sw = e.target.closest('button[data-action]');
    if (!sw) return;
    sw.classList.toggle('on');
    setSwitch(sw.closest('.sw').dataset.switch, sw.dataset.action);
  });
  $('automationList').addEventListener('click', (e) => {
    const row = e.target.closest('.auto');
    if (!row) return;
    const id = row.dataset.automation;
    if (e.target.closest('[data-run]')) act('cardAutomations', () => agent('automation.run', { id }).then((r) => toast(r.failed ? `${r.failed} step(s) skipped` : 'Automation ran ✓')));
    const sw = e.target.closest('button[data-enabled]');
    if (sw) {
      sw.classList.toggle('on');
      const enabled = sw.dataset.enabled === '1';
      act('cardAutomations', async () => {
        await cloud.setHome({ automations: { ...(S.home.automations || {}), [id]: { enabled } } });
        const a = automationList().find((x) => x.id === id);
        await cloud.addActivity('automation', `${a?.icon || '⚙️'} "${a?.name || id}" ${enabled ? 'enabled' : 'disabled'}`, { source: 'dashboard', automation: id });
      });
    }
  });
  for (const b of document.querySelectorAll('button[data-mc]')) {
    b.addEventListener('click', () => act('cardMinecraft', async () => {
      const out = await agent('minecraft', { action: b.dataset.mc });
      $('rconOut').textContent = out.stdout || `${b.dataset.mc}: ok`;
      $('rconForm').classList.remove('hidden');
    }));
  }
  $('btnConsole').addEventListener('click', () => $('rconForm').classList.toggle('hidden'));
  $('rconForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const command = $('rconInput').value.trim();
    if (!command) return;
    act('cardMinecraft', async () => {
      const out = await agent('minecraft.rcon', { command });
      $('rconOut').textContent = `> ${command}\n${out.output || '(no output)'}`;
      $('rconInput').value = '';
    });
  });

  // live clock + ticking counters
  setInterval(() => {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('dateLine').textContent = fmtDay(now);
    if (cloud?.user) renderCamera();
  }, 1000);
}

bind();
boot();
window.homeDash = { S, get cloud() { return cloud; }, get viewer() { return viewer; }, enter };
