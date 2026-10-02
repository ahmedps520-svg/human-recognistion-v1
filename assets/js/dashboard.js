// Smart-room dashboard. Everything on screen comes from the home server
// (server/) and updates live over its event stream.

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

// ---------------------------------------------------------------- config
const CONF_KEY = 'hr.dash.v2';
const conf = { serverUrl: '', token: '', cameraUrl: '', roomName: '' };
try {
  Object.assign(conf, JSON.parse(localStorage.getItem(CONF_KEY) || localStorage.getItem('hr.dash.v1') || '{}'));
} catch {
  /* ignore */
}
const params = new URLSearchParams(location.search);
if (params.get('token')) {
  conf.token = params.get('token');
  conf.serverUrl = params.get('server') || conf.serverUrl || location.origin;
  saveConf();
  history.replaceState(null, '', location.pathname);
}
if (!conf.serverUrl && location.protocol.startsWith('http')) conf.serverUrl = location.origin;
function saveConf() {
  try {
    localStorage.setItem(CONF_KEY, JSON.stringify(conf));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- state
const S = {
  status: null,
  es: null,
  connected: false,
  camera: null,
  ac: null,
  door: null,
  lights: null,
  switches: [],
  sensors: [],
  scenes: [],
  automations: [],
  activity: [],
  visits: [],
  weather: null,
  minecraft: null,
  home: { mode: 'home' },
  lastAlarmAt: null,
  alarmActive: false,
  streamRetry: null,
  rendered: {},
};

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 2600);
}

const base = () => conf.serverUrl.replace(/\/$/, '');
const withToken = (p) => `${base()}${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(conf.token)}`;

async function api(path, { method = 'GET', body } = {}) {
  if (!conf.serverUrl || !conf.token) throw new Error('Not connected: open Settings and enter the server URL and token');
  const res = await fetch(`${base()}${path}`, { method, headers: { Authorization: `Bearer ${conf.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}

/** Render only when the data for a section changed (keeps the DOM calm). */
function changed(key, data) {
  const sig = JSON.stringify(data);
  if (S.rendered[key] === sig) return false;
  S.rendered[key] = sig;
  return true;
}

async function act(cardId, fn) {
  const card = $(cardId);
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

// ---------------------------------------------------------------- connection
function setLive(on, text) {
  S.connected = on;
  $('liveDot').classList.toggle('on', on);
  if (text) $('roomSub').textContent = text;
}

async function connect() {
  $('roomName').textContent = conf.roomName || 'My room';
  if (!conf.serverUrl || !conf.token) {
    setLive(false, 'Not connected · open Settings');
    openSheet();
    return;
  }
  try {
    const status = await api('/api/status');
    applyStatus(status);
    openEvents();
    startStream();
  } catch (e) {
    setLive(false, `Can't reach the home server: ${e.message}`);
    toast(e.message, 'error');
  }
}

function openEvents() {
  S.es?.close();
  const es = new EventSource(withToken('/api/events'));
  S.es = es;
  const parse = (ev) => {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  };
  const on = (type, fn) => es.addEventListener(type, (ev) => {
    const d = parse(ev);
    if (d) fn(d);
  });
  on('status', applyStatus);
  on('camera', (d) => {
    S.camera = { ...(S.camera || {}), online: true, lastFrameAt: d.at, presence: d.presence };
    renderCamera();
    renderSecurity();
    if ($('camStream').hidden) startStream();
  });
  on('presence', () => refreshCameraStatus());
  on('armed', () => refreshCameraStatus());
  on('alarm', (d) => {
    S.lastAlarmAt = d.at;
    S.alarmActive = true;
    renderSecurity();
    setTimeout(() => {
      S.alarmActive = false;
      renderSecurity();
    }, 60000);
  });
  on('visit', () => {
    refreshVisits();
    refreshCameraStatus();
  });
  on('mode', (d) => {
    S.home = { ...S.home, mode: d.mode, modeSince: d.modeSince };
    renderModes();
  });
  on('activity', (d) => {
    S.activity.unshift(d.entry);
    S.activity.length = Math.min(S.activity.length, 60);
    renderActivity(true);
  });
  on('scene', () => refresh('/api/scenes', 'scenes', renderScenes));
  on('automations', () => refresh('/api/automations', 'automations', renderAutomations));
  on('automation', () => refresh('/api/automations', 'automations', renderAutomations));
  on('door', (d) => {
    S.door = d.state;
    renderSecurity();
  });
  on('ac', (d) => {
    S.ac = d.state;
    renderClimate();
  });
  on('lights', () => refresh('/api/lights', 'lights', renderLights));
  on('switches', () => refresh('/api/switches', 'switches', renderSwitches));
  on('minecraft', () => setTimeout(() => refresh('/api/minecraft', 'minecraft', renderMinecraft), 1500));
  on('command', () => {});
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false, 'Reconnecting…');
}

async function refresh(path, key, render) {
  try {
    S[key] = await api(path);
    render();
  } catch (e) {
    console.warn(path, e.message);
  }
}

async function refreshCameraStatus() {
  try {
    S.camera = await api('/api/camera/status');
    renderCamera();
    renderSecurity();
  } catch {
    /* transient */
  }
}

function applyStatus(s) {
  S.status = s;
  S.camera = s.camera;
  S.ac = s.ac;
  S.door = s.door;
  S.lights = s.lights;
  S.switches = s.switches || [];
  S.sensors = s.sensors || [];
  S.scenes = s.scenes || [];
  S.automations = s.automations || [];
  S.activity = s.activity || [];
  S.weather = s.weather;
  S.minecraft = s.minecraft;
  S.home = s.home || S.home;
  S.notify = s.notify;
  if (!conf.roomName && s.roomName) $('roomName').textContent = s.roomName;
  const alarm = S.activity.find((e) => e.kind === 'alarm');
  if (alarm) S.lastAlarmAt = alarm.at;
  setLive(true);
  renderAll();
  $('serverInfo').textContent = `Home server v${s.version}${s.mock ? ' · mock devices (nothing is wired yet)' : ''}\nPhone alerts: ${s.notify?.enabled ? s.notify.adapter : 'not configured'}`;
  refreshVisits();
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
}

function renderModes() {
  for (const b of $('modes').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === S.home.mode);
  for (const el of document.querySelectorAll('.scene')) el.classList.toggle('active', !!el.dataset.mode && el.dataset.mode === S.home.mode);
}

function startStream() {
  const img = $('camStream');
  img.hidden = false;
  img.src = withToken('/api/camera/stream') + `&t=${Date.now()}`;
  img.onerror = () => {
    img.hidden = true;
    $('camOffline').classList.remove('hidden');
    clearTimeout(S.streamRetry);
    S.streamRetry = setTimeout(startStream, 5000);
  };
  img.onload = () => {
    img.hidden = false;
    $('camOffline').classList.add('hidden');
  };
  $('lnkSnapshot').href = withToken('/api/camera/frame.jpg');
}

function renderCamera() {
  const c = S.camera || {};
  const p = c.presence || {};
  const online = !!c.online;
  const people = p.people || 0;
  const peopleEl = $('camPeople');
  peopleEl.textContent = !online ? 'Camera offline' : people ? `${people} ${people === 1 ? 'person' : 'people'} in the room` : 'Nobody in the room';
  peopleEl.className = `chip chip-dark ${people ? 'people' : ''}`;
  $('camArmed').textContent = p.armed ? 'Armed' : 'Disarmed';
  $('camArmed').className = `chip chip-dark ${p.armed ? 'armed' : ''}`;
  $('camRec').classList.toggle('hidden', !p.recording);
  $('camMeta').textContent = online ? `Live · ${p.mode === 'identify' ? 'identifying people' : 'recording every visit'}` : 'Waiting for the camera app';
  if (!online && !$('camStream').naturalWidth) $('camOffline').classList.remove('hidden');
  const sub = !online ? 'Camera offline' : people ? `Occupied${c.occupiedSince ? ` for ${fmtDuration(Date.now() - c.occupiedSince)}` : ''}` : `Empty${c.emptySince ? ` since ${fmtTime(c.emptySince)}` : ''}`;
  $('roomSub').textContent = `${sub}${S.home.mode ? ` · ${S.home.mode} mode` : ''}`;
  $('camSince').textContent = people && c.occupiedSince ? `in view ${fmtDuration(Date.now() - c.occupiedSince)}` : '';
  $('secVisitsToday').textContent = c.visitsToday ?? 0;
  $('visitsToday').textContent = c.visitsToday != null ? `${c.visitsToday} today` : '';
  if (c.lastVisit) $('secLastVisit').textContent = ago(c.lastVisit.startedAt);
}

function renderSecurity() {
  const p = S.camera?.presence || {};
  const ring = $('secRing');
  const alarm = S.alarmActive || p.alarm;
  ring.className = `ring ${alarm ? 'alarm' : p.armed ? 'armed' : ''}`;
  $('secIcon').textContent = alarm ? '🚨' : p.armed ? '🔒' : '🛡️';
  $('secText').textContent = alarm ? 'ALARM' : p.armed ? 'Armed' : 'Secure';
  $('alarmStrip').classList.toggle('hidden', !alarm);
  $('btnArm').classList.toggle('accent', !p.armed);
  $('btnDisarm').classList.toggle('accent', !!p.armed);
  $('secLastAlarm').textContent = S.lastAlarmAt ? ago(S.lastAlarmAt) : 'never';
  const d = S.door;
  const btn = $('btnDoor');
  if (!d || d.enabled === false) {
    $('doorState').textContent = 'Door switch not set up';
    $('doorNote').textContent = 'configure door.adapter on the server';
    $('doorIcon').textContent = '🚪';
    btn.classList.remove('open');
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
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
  if (!changed('scenes', S.scenes)) return;
  $('sceneRow').innerHTML = S.scenes
    .map((s) => `<button type="button" class="scene" data-scene="${esc(s.id)}" ${s.mode ? `data-mode="${esc(s.mode)}"` : ''}><span class="ico">${esc(s.icon)}</span><span class="nm">${esc(s.name)}</span><span class="last">${s.lastRun ? `ran ${ago(s.lastRun)}` : `${s.actions} steps`}</span></button>`)
    .join('');
  renderModes();
}

function renderClimate() {
  const ac = S.ac;
  const badge = $('acState');
  if (!ac || ac.enabled === false || ac.adapter === 'none') {
    badge.textContent = 'Not set up';
    badge.className = 'badge';
    $('acNote').textContent = 'Configure ac.adapter on the server (Sensibo, Home Assistant or webhooks).';
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
  // inside chip + sensors
  const temp = S.sensors.find((x) => x.kind === 'temperature')?.value ?? ac?.currentTemp ?? null;
  const hum = S.sensors.find((x) => x.kind === 'humidity')?.value ?? ac?.humidity ?? null;
  $('chipInside').innerHTML = `🌡️ <b>${temp != null ? `${Number(temp).toFixed(1)}°` : '–'}</b>${hum != null ? ` · ${Math.round(hum)}%` : ''}`;
  if (changed('sensors', S.sensors)) {
    $('sensorRow').innerHTML = S.sensors
      .map((s) => `<div class="sensor"><b>${s.value != null ? `${s.value}${esc(s.unit || '')}` : '–'}</b><small>${esc(s.name)}</small></div>`)
      .join('');
  }
}

const rgbHex = (c) => (c ? `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}` : '#ffffff');
const hexRgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function renderLights() {
  const l = S.lights;
  const list = $('lightList');
  if (!l || l.enabled === false) {
    list.innerHTML = '<p class="muted small">Add your Govee API key on the server (govee.apiKey). Get it in the Govee Home app under Settings → Apply for API key.</p>';
    return;
  }
  if (l.error) {
    list.innerHTML = `<p class="muted small">${esc(l.error)}</p>`;
    return;
  }
  if (!changed('lights', l.devices)) return;
  list.innerHTML = l.devices
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
  if (!S.switches.length) {
    list.innerHTML = '<p class="muted small">Add plugs and switches under "switches" in the server config (Shelly, Tasmota, Home Assistant or webhooks).</p>';
    return;
  }
  if (!changed('switches', S.switches)) return;
  list.innerHTML = S.switches
    .map((sw) => `<div class="sw ${sw.on ? '' : 'off'}" data-switch="${esc(sw.id)}"><div class="row1"><span class="name"><span class="ico">${esc(sw.icon)}</span>${esc(sw.name)}${sw.error ? `<small class="muted"> · ${esc(sw.error)}</small>` : ''}</span><button type="button" class="switch ${sw.on ? 'on' : ''}" data-action="${sw.on ? 'off' : 'on'}" aria-label="toggle"></button></div></div>`)
    .join('');
}

async function refreshVisits() {
  try {
    const events = await api('/api/camera/events?limit=8');
    S.visits = events;
    if (!changed('visits', events)) return;
    const list = $('visitList');
    if (!events.length) {
      list.innerHTML = '<li class="muted small">No visits yet. The camera logs everyone who enters, with a snapshot and clip.</li>';
      return;
    }
    list.innerHTML = events
      .map((e) => {
        const parts = e.clipPaths?.length ? e.clipPaths : e.clipPath ? [e.clipPath] : [];
        const dur = e.endedAt ? fmtDuration(new Date(e.endedAt) - new Date(e.startedAt)) : 'now';
        return `<li>
          ${e.snapshotPath ? `<img src="${withToken(`/api/camera/media/${e.snapshotPath}`)}" alt="" loading="lazy">` : '<div class="no-thumb">no snapshot</div>'}
          <div class="when"><b>${e.personName ? esc(e.personName) : 'Someone'}</b>${e.alarmTriggered ? '<span class="tag alarm">alarm</span>' : ''}<small>${esc(fmtDay(e.startedAt))} ${esc(fmtTime(e.startedAt))} · ${dur}</small>${e.features?.ai?.summary ? `<small>${esc(e.features.ai.summary)}</small>` : ''}</div>
          <div>${parts.map((p, i) => `<a class="pill small" href="${withToken(`/api/camera/media/${p}`)}" target="_blank" rel="noopener">▶${parts.length > 1 ? ` ${i + 1}` : ''}</a>`).join(' ')}</div>
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

function renderAutomations() {
  if (!changed('automations', S.automations)) return;
  $('automationList').innerHTML = S.automations
    .map((a) => `<div class="auto" data-automation="${esc(a.id)}"><span class="ico">${esc(a.icon)}</span><div class="txt"><b>${esc(a.name)}</b><small>${esc(a.description || '')}${a.lastFired ? ` · last ${ago(a.lastFired)}` : ''}</small></div><button type="button" class="run" data-run>Run</button><button type="button" class="switch ${a.enabled ? 'on' : ''}" data-enabled="${a.enabled ? '0' : '1'}" aria-label="enabled"></button></div>`)
    .join('');
}

function renderMinecraft() {
  const mc = S.minecraft;
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
  const w = S.weather;
  if (!w || w.enabled === false || w.error) {
    $('chipWeather').innerHTML = `⛅ <b>–</b>`;
    $('weatherTemp').textContent = '–';
    $('weatherDesc').textContent = w?.error ? w.error : 'Set location.lat / location.lon on the server for outdoor weather.';
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
async function setMode(mode) {
  const prev = S.home.mode;
  S.home = { ...S.home, mode };
  renderModes();
  const r = await act(null, () => api('/api/mode', { method: 'POST', body: { mode } }));
  if (!r) {
    S.home = { ...S.home, mode: prev };
    renderModes();
  }
}

async function runScene(id) {
  const r = await act('cardScenes', () => api(`/api/scenes/${encodeURIComponent(id)}/run`, { method: 'POST' }));
  if (r) toast(r.failed ? `${r.name}: ${r.failed} step${r.failed > 1 ? 's' : ''} skipped (device not set up)` : `${r.name} ✓`);
}

async function setAc(changes) {
  const r = await act('cardClimate', () => api('/api/ac', { method: 'POST', body: changes }));
  if (r) {
    S.ac = r;
    renderClimate();
  }
}

async function setDoor(action) {
  const r = await act('cardSecurity', () => api('/api/door', { method: 'POST', body: { action } }));
  if (r) {
    S.door = r;
    renderSecurity();
  }
}

async function setLight(device, changes) {
  await act('cardLights', async () => {
    await api(`/api/lights/${encodeURIComponent(device)}`, { method: 'POST', body: changes });
    await refresh('/api/lights', 'lights', renderLights);
  });
}

async function setSwitch(id, action) {
  const r = await act('cardSwitches', () => api(`/api/switches/${encodeURIComponent(id)}`, { method: 'POST', body: { action } }));
  if (r) {
    S.switches = S.switches.map((s) => (s.id === r.id ? r : s));
    renderSwitches();
  }
}

// ---------------------------------------------------------------- sheet
function openSheet() {
  const f = $('connForm');
  f.elements.serverUrl.value = conf.serverUrl;
  f.elements.token.value = conf.token;
  f.elements.cameraUrl.value = conf.cameraUrl;
  f.elements.roomName.value = conf.roomName;
  $('sheet').classList.add('open');
  $('sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheet').setAttribute('aria-hidden', 'true');
}

// ---------------------------------------------------------------- bind
function bind() {
  $('btnSettings').addEventListener('click', openSheet);
  $('btnSheetClose').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) closeSheet();
  });
  $('connForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    conf.serverUrl = f.elements.serverUrl.value.trim();
    conf.token = f.elements.token.value.trim();
    conf.cameraUrl = f.elements.cameraUrl.value.trim();
    conf.roomName = f.elements.roomName.value.trim();
    saveConf();
    closeSheet();
    $('lnkCameraApp').href = conf.cameraUrl || 'index.html';
    connect();
  });
  $('modes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  $('btnArm').addEventListener('click', () => act('cardCamera', () => api('/api/camera/command', { method: 'POST', body: { action: 'arm' } }).then(() => toast('Arming the camera'))));
  $('btnDisarm').addEventListener('click', () => act('cardCamera', () => api('/api/camera/command', { method: 'POST', body: { action: 'disarm' } }).then(() => toast('Disarming the camera'))));
  $('btnSiren').addEventListener('click', () => act('cardSecurity', () => api('/api/camera/command', { method: 'POST', body: { action: 'siren' } }).then(() => toast('Siren test sent to the camera'))));
  $('btnNotifyTest').addEventListener('click', () => act('cardSecurity', () => api('/api/notify', { method: 'POST', body: { title: 'Home', message: 'Test alert from your dashboard' } }).then((r) => toast(`Sent via ${r.adapter}`))));
  for (const b of document.querySelectorAll('[data-door]')) b.addEventListener('click', () => setDoor(b.dataset.door));
  $('sceneRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-scene]');
    if (b) runScene(b.dataset.scene);
  });
  $('acUp').addEventListener('click', () => setAc({ targetTemp: (S.ac?.targetTemp ?? 23) + 1 }));
  $('acDown').addEventListener('click', () => setAc({ targetTemp: (S.ac?.targetTemp ?? 23) - 1 }));
  $('acPower').addEventListener('click', () => setAc({ power: !S.ac?.power }));
  $('acModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAc({ mode: b.dataset.mode, power: true });
  });
  $('acFan').addEventListener('change', (e) => setAc({ fanLevel: e.target.value }));
  for (const b of document.querySelectorAll('button[data-all]')) {
    b.addEventListener('click', () => act('cardLights', async () => {
      await api('/api/lights/all', { method: 'POST', body: { power: b.dataset.all === 'on' } });
      await refresh('/api/lights', 'lights', renderLights);
    }));
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
    b.addEventListener('click', () => act('cardSwitches', async () => {
      await api('/api/switches/all', { method: 'POST', body: { action: b.dataset.swAll } });
      await refresh('/api/switches', 'switches', renderSwitches);
    }));
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
    if (e.target.closest('[data-run]')) act('cardAutomations', () => api(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' }).then((r) => toast(r.failed ? `${r.failed} step(s) skipped` : 'Automation ran ✓')));
    const sw = e.target.closest('button[data-enabled]');
    if (sw) {
      sw.classList.toggle('on');
      act('cardAutomations', async () => {
        await api(`/api/automations/${encodeURIComponent(id)}`, { method: 'POST', body: { enabled: sw.dataset.enabled === '1' } });
        await refresh('/api/automations', 'automations', renderAutomations);
      });
    }
  });
  for (const b of document.querySelectorAll('button[data-mc]')) {
    b.addEventListener('click', () => act('cardMinecraft', async () => {
      const out = await api(`/api/minecraft/${b.dataset.mc}`, { method: 'POST' });
      $('rconOut').textContent = out.stdout || `${b.dataset.mc}: ok`;
      $('rconForm').classList.remove('hidden');
      setTimeout(() => refresh('/api/minecraft', 'minecraft', renderMinecraft), 1500);
    }));
  }
  $('btnConsole').addEventListener('click', () => $('rconForm').classList.toggle('hidden'));
  $('rconForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const command = $('rconInput').value.trim();
    if (!command) return;
    act('cardMinecraft', async () => {
      const out = await api('/api/minecraft/rcon', { method: 'POST', body: { command } });
      $('rconOut').textContent = `> ${command}\n${out.output || '(no output)'}`;
      $('rconInput').value = '';
    });
  });

  // live clock + ticking counters
  setInterval(() => {
    const now = new Date();
    $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('dateLine').textContent = fmtDay(now);
    if (S.camera) renderCamera();
  }, 1000);
  // things the server polls itself (cloud lights, Minecraft, sensors, weather)
  setInterval(() => {
    if (!S.connected) return;
    refresh('/api/minecraft', 'minecraft', renderMinecraft);
    refresh('/api/lights', 'lights', renderLights);
    refresh('/api/sensors', 'sensors', renderClimate);
  }, 30000);
  setInterval(() => S.connected && refresh('/api/weather', 'weather', renderWeather), 10 * 60 * 1000);
  $('lnkCameraApp').href = conf.cameraUrl || 'index.html';
}

bind();
connect();
window.homeDash = { S, conf, api, connect };
