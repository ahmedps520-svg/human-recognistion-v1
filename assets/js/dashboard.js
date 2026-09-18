// Home dashboard: talks to the home server's API (server/) and shows the
// camera feed, visits, Minecraft server, air conditioning, door and lights.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => new Date(d).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const fmtDuration = (ms) => {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

const CONF_KEY = 'hr.dash.v1';
const conf = { serverUrl: '', token: '', cameraUrl: '' };
try {
  Object.assign(conf, JSON.parse(localStorage.getItem(CONF_KEY) || '{}'));
} catch {
  /* ignore */
}
// Quick setup through the URL: dashboard.html?token=…[&server=…]
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

const state = { status: null, es: null, connected: false, streamRetry: null, lastFrameAt: 0, busy: new Set() };

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 3000);
}

const base = () => conf.serverUrl.replace(/\/$/, '');
const withToken = (path) => `${base()}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(conf.token)}`;

async function api(path, { method = 'GET', body } = {}) {
  if (!conf.serverUrl || !conf.token) throw new Error('Not connected: set the server URL and token');
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${conf.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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

function setBusy(tileId, on) {
  $(tileId).classList.toggle('busy', on);
}

async function act(tileId, fn) {
  setBusy(tileId, true);
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'error');
    return null;
  } finally {
    setBusy(tileId, false);
  }
}

// ---------------------------------------------------------------- connection
function setConnected(on, label) {
  state.connected = on;
  const pill = $('connPill');
  pill.textContent = label || (on ? 'Connected' : 'Not connected');
  pill.className = `status-pill ${on ? 'ok' : 'warn'}`;
}

async function connect() {
  if (!conf.serverUrl || !conf.token) {
    setConnected(false, 'Not connected');
    openConnDialog();
    return;
  }
  try {
    const status = await api('/api/status');
    render(status);
    setConnected(true, `Connected${status.mock ? ' · mock devices' : ''}`);
    $('dashVersion').textContent = `server v${status.version}`;
    openEvents();
    startStream();
  } catch (e) {
    setConnected(false, `Error: ${e.message}`);
    toast(e.message, 'error');
  }
}

function openEvents() {
  state.es?.close();
  const es = new EventSource(withToken('/api/events'));
  state.es = es;
  const parse = (ev) => {
    try {
      return JSON.parse(ev.data);
    } catch {
      return null;
    }
  };
  es.addEventListener('status', (ev) => {
    const s = parse(ev);
    if (s) render(s);
  });
  es.addEventListener('camera', (ev) => {
    const s = parse(ev);
    if (!s) return;
    state.lastFrameAt = s.at;
    renderCameraPresence(s.presence, true);
    if ($('camStream').hidden) startStream();
    $('camMeta').textContent = `Last frame ${fmtTime(s.at)}`;
  });
  es.addEventListener('visit', () => {
    refreshVisits();
    refreshCameraStatus();
  });
  es.addEventListener('minecraft', () => setTimeout(refreshMinecraft, 1500));
  es.addEventListener('ac', (ev) => {
    const s = parse(ev);
    if (s?.state) renderAc(s.state);
  });
  es.addEventListener('door', (ev) => {
    const s = parse(ev);
    if (s?.state) renderDoor(s.state);
  });
  es.addEventListener('lights', () => refreshLights());
  es.onerror = () => setConnected(false, 'Reconnecting…');
  es.onopen = () => setConnected(true, 'Connected');
}

// ---------------------------------------------------------------- camera
function startStream() {
  const img = $('camStream');
  img.hidden = false;
  img.src = withToken('/api/camera/stream') + `&t=${Date.now()}`;
  img.onerror = () => {
    img.hidden = true;
    $('camOffline').classList.remove('hidden');
    clearTimeout(state.streamRetry);
    state.streamRetry = setTimeout(startStream, 5000);
  };
  img.onload = () => {
    $('camOffline').classList.add('hidden');
    img.hidden = false;
  };
  $('lnkSnapshot').href = withToken('/api/camera/frame.jpg');
}

function renderCameraPresence(p, online) {
  const people = p?.people || 0;
  $('camPeople').textContent = people ? `${people} ${people === 1 ? 'person' : 'people'}` : online ? 'Nobody' : 'Offline';
  $('camPeople').className = `badge ${people ? 'warn' : ''}`;
  $('camArmed').textContent = p?.armed ? 'Armed' : 'Disarmed';
  $('camArmed').className = `badge ${p?.armed ? 'on' : 'off'}`;
  $('camRec').classList.toggle('hidden', !p?.recording);
}

function renderCamera(c) {
  const online = !!c?.online;
  renderCameraPresence(c?.presence, online);
  if (online) {
    $('camOffline').classList.add('hidden');
    if ($('camStream').hidden) startStream();
  } else if (!$('camStream').naturalWidth) {
    // nothing has ever rendered: show the placeholder, keep the stream request open so frames appear as soon as they arrive
    $('camOffline').classList.remove('hidden');
  }
  $('camMeta').textContent = c?.lastFrameAt ? `Last frame ${fmtTime(c.lastFrameAt)} · ${c.visitsToday || 0} visits today` : 'Waiting for the camera app to send frames.';
  $('visitsToday').textContent = c?.visitsToday != null ? `· ${c.visitsToday} today` : '';
}

async function refreshCameraStatus() {
  try {
    renderCamera(await api('/api/camera/status'));
  } catch {
    /* transient */
  }
}

async function refreshVisits() {
  try {
    const events = await api('/api/camera/events?limit=8');
    const list = $('visitList');
    if (!events.length) {
      list.innerHTML = '<li class="muted">No visits yet.</li>';
      return;
    }
    list.innerHTML = events
      .map((e) => {
        const parts = e.clipPaths?.length ? e.clipPaths : e.clipPath ? [e.clipPath] : [];
        const dur = e.endedAt ? fmtDuration(new Date(e.endedAt) - new Date(e.startedAt)) : 'ongoing';
        const who = e.personName ? esc(e.personName) : 'Visit';
        return `<li>
          ${e.snapshotPath ? `<img src="${withToken(`/api/camera/media/${e.snapshotPath}`)}" alt="" loading="lazy">` : '<div class="no-thumb">no snapshot</div>'}
          <div class="when"><b>${who}</b> ${e.alarmTriggered ? '<span class="tag alarm">alarm</span>' : ''}<small>${esc(fmtDate(e.startedAt))} → ${e.endedAt ? esc(fmtTime(e.endedAt)) : 'now'} · ${dur}</small>${e.features?.ai?.summary ? `<small>${esc(e.features.ai.summary)}</small>` : ''}</div>
          <div>${parts.map((p, i) => `<a class="button small-btn" href="${withToken(`/api/camera/media/${p}`)}" target="_blank" rel="noopener">▶${parts.length > 1 ? ` ${i + 1}` : ''}</a>`).join(' ')}</div>
        </li>`;
      })
      .join('');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------- minecraft
function renderMinecraft(mc) {
  const badge = $('mcState');
  if (!mc || mc.enabled === false) {
    badge.textContent = 'Disabled';
    badge.className = 'badge off';
    $('mcInfo').innerHTML = '<dt>Config</dt><dd class="muted">minecraft.enabled is false</dd>';
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
  } else {
    rows.push(['Status', `not reachable${mc.error ? ` (${esc(mc.error)})` : ''}`]);
  }
  if (mc.host) rows.push(['Address', `${esc(mc.host)}:${mc.port}`]);
  $('mcInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

async function refreshMinecraft() {
  try {
    renderMinecraft(await api('/api/minecraft'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------- ac
function renderAc(ac) {
  state.ac = ac;
  const badge = $('acState');
  if (!ac || ac.enabled === false || ac.adapter === 'none') {
    badge.textContent = 'Not configured';
    badge.className = 'badge off';
    $('acNote').textContent = 'Set ac.adapter in server/config.json (sensibo, homeassistant or webhook).';
    return;
  }
  if (ac.error) {
    badge.textContent = 'Error';
    badge.className = 'badge danger';
    $('acNote').textContent = ac.error;
    return;
  }
  badge.textContent = ac.power ? `On · ${ac.mode || ''}` : 'Off';
  badge.className = `badge ${ac.power ? 'on' : 'off'}`;
  $('acTarget').textContent = ac.targetTemp ?? '–';
  $('acNow').textContent = [ac.currentTemp != null ? `Room ${Number(ac.currentTemp).toFixed(1)} °C` : '', ac.humidity != null ? `${Math.round(ac.humidity)} % humidity` : ''].filter(Boolean).join(' · ');
  $('acPower').textContent = ac.power ? 'Turn off' : 'Turn on';
  $('acPower').classList.toggle('primary', !ac.power);
  for (const b of $('acModes').querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === ac.mode);
  if (ac.fanLevel) $('acFan').value = ['auto', 'low', 'medium', 'high'].includes(ac.fanLevel) ? ac.fanLevel : 'auto';
  $('acNote').textContent = `${ac.adapter}${ac.room ? ` · ${ac.room}` : ''}${ac.entityId ? ` · ${ac.entityId}` : ''}`;
}

async function setAc(changes) {
  const s = await act('tileAc', () => api('/api/ac', { method: 'POST', body: changes }));
  if (s) renderAc(s);
}

// ---------------------------------------------------------------- door
function renderDoor(d) {
  const badge = $('doorState');
  if (!d || d.enabled === false) {
    badge.textContent = 'Not configured';
    badge.className = 'badge off';
    $('doorNote').textContent = 'Set door.adapter in server/config.json (shelly, tasmota, homeassistant or webhook).';
    return;
  }
  if (d.error) {
    badge.textContent = 'Error';
    badge.className = 'badge danger';
    $('doorNote').textContent = d.error;
    return;
  }
  const on = d.on === true;
  badge.textContent = on ? 'Open / unlocked' : 'Closed / locked';
  badge.className = `badge ${on ? 'warn' : 'on'}`;
  $('doorIcon').classList.toggle('open', on);
  $('doorNote').textContent = `${d.adapter}${d.pulseMs ? ` · pulse ${d.pulseMs} ms` : ''}${d.lastAction ? ` · last: ${d.lastAction.action} at ${fmtTime(d.lastAction.at)}` : ''}`;
}

async function setDoor(action) {
  const s = await act('tileDoor', () => api('/api/door', { method: 'POST', body: { action } }));
  if (s) renderDoor(s);
}

// ---------------------------------------------------------------- lights
const rgbHex = (c) => (c ? `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('')}` : '#ffffff');
const hexRgb = (h) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function renderLights(l) {
  const list = $('lightList');
  if (!l || l.enabled === false) {
    list.innerHTML = '<p class="muted">Add your Govee API key to server/config.json (govee.apiKey). Get one in the Govee Home app under Settings → Apply for API key.</p>';
    return;
  }
  if (l.error) {
    list.innerHTML = `<p class="muted">${esc(l.error)}</p>`;
    return;
  }
  if (!l.devices.length) {
    list.innerHTML = '<p class="muted">No Govee devices on this account.</p>';
    return;
  }
  list.innerHTML = l.devices
    .map((d) => {
      const s = d.state || {};
      const offline = s.online === false;
      return `<div class="light ${offline ? 'offline' : ''}" data-device="${esc(d.device)}">
        <div class="row1"><span class="name"><i class="swatch" style="background:${s.power ? rgbHex(s.color) : '#333'}"></i>${esc(d.deviceName)}</span>
          <button type="button" class="switch ${s.power ? 'on' : ''}" data-power="${s.power ? '0' : '1'}" aria-label="power"></button></div>
        ${s.error ? `<div class="muted small">${esc(s.error)}</div>` : ''}
        <label>Brightness <input type="range" min="1" max="100" value="${s.brightness ?? 50}" data-brightness></label>
        <label>Colour <input type="color" value="${rgbHex(s.color)}" data-color> <span class="muted">${esc(d.sku || '')}${offline ? ' · offline' : ''}</span></label>
      </div>`;
    })
    .join('');
}

async function refreshLights() {
  try {
    renderLights(await api('/api/lights'));
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function setLight(device, changes) {
  await act('tileLights', async () => {
    await api(`/api/lights/${encodeURIComponent(device)}`, { method: 'POST', body: changes });
    await refreshLights();
  });
}

// ---------------------------------------------------------------- render all
function render(s) {
  state.status = s;
  renderCamera(s.camera);
  renderMinecraft(s.minecraft);
  renderAc(s.ac);
  renderDoor(s.door);
  renderLights(s.lights);
  refreshVisits();
}

async function refreshAll() {
  try {
    render(await api('/api/status'));
    setConnected(true, 'Connected');
  } catch (e) {
    setConnected(false, `Error: ${e.message}`);
  }
}

// ---------------------------------------------------------------- dialog
function openConnDialog() {
  const f = $('connForm');
  f.elements.serverUrl.value = conf.serverUrl;
  f.elements.token.value = conf.token;
  f.elements.cameraUrl.value = conf.cameraUrl;
  $('connDialog').showModal();
}

// ---------------------------------------------------------------- bind
function bind() {
  $('btnConn').addEventListener('click', openConnDialog);
  $('btnConnCancel').addEventListener('click', () => $('connDialog').close());
  $('connForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    conf.serverUrl = f.elements.serverUrl.value.trim();
    conf.token = f.elements.token.value.trim();
    conf.cameraUrl = f.elements.cameraUrl.value.trim();
    saveConf();
    $('connDialog').close();
    $('lnkCameraApp').href = conf.cameraUrl || 'index.html';
    connect();
  });
  $('btnRefresh').addEventListener('click', refreshAll);
  $('btnArm').addEventListener('click', () => act('tileCamera', () => api('/api/camera/command', { method: 'POST', body: { action: 'arm' } }).then(() => toast('Arm command sent to the camera'))));
  $('btnDisarm').addEventListener('click', () => act('tileCamera', () => api('/api/camera/command', { method: 'POST', body: { action: 'disarm' } }).then(() => toast('Disarm command sent'))));

  for (const b of document.querySelectorAll('button[data-mc]')) {
    b.addEventListener('click', () =>
      act('tileMinecraft', async () => {
        const out = await api(`/api/minecraft/${b.dataset.mc}`, { method: 'POST' });
        $('rconOut').textContent = out.stdout || `${b.dataset.mc}: ok`;
        setTimeout(refreshMinecraft, 1500);
      }),
    );
  }
  $('rconForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const command = $('rconInput').value.trim();
    if (!command) return;
    act('tileMinecraft', async () => {
      const out = await api('/api/minecraft/rcon', { method: 'POST', body: { command } });
      $('rconOut').textContent = `> ${command}\n${out.output || '(no output)'}`;
      $('rconInput').value = '';
    });
  });

  $('acUp').addEventListener('click', () => setAc({ targetTemp: (state.ac?.targetTemp ?? 23) + 1 }));
  $('acDown').addEventListener('click', () => setAc({ targetTemp: (state.ac?.targetTemp ?? 23) - 1 }));
  $('acPower').addEventListener('click', () => setAc({ power: !state.ac?.power }));
  $('acModes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setAc({ mode: b.dataset.mode, power: true });
  });
  $('acFan').addEventListener('change', (e) => setAc({ fanLevel: e.target.value }));

  for (const b of document.querySelectorAll('button[data-door]')) b.addEventListener('click', () => setDoor(b.dataset.door));

  for (const b of document.querySelectorAll('button[data-all]')) {
    b.addEventListener('click', () => act('tileLights', async () => {
      await api('/api/lights/all', { method: 'POST', body: { power: b.dataset.all === 'on' } });
      await refreshLights();
    }));
  }
  $('lightList').addEventListener('click', (e) => {
    const sw = e.target.closest('button[data-power]');
    if (!sw) return;
    setLight(sw.closest('.light').dataset.device, { power: sw.dataset.power === '1' });
  });
  $('lightList').addEventListener('change', (e) => {
    const card = e.target.closest('.light');
    if (!card) return;
    if (e.target.matches('[data-brightness]')) setLight(card.dataset.device, { brightness: Number(e.target.value), power: true });
    if (e.target.matches('[data-color]')) setLight(card.dataset.device, { color: hexRgb(e.target.value), power: true });
  });

  setInterval(() => {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, 1000);
  setInterval(() => {
    if (state.connected) {
      refreshMinecraft();
      refreshLights();
    }
  }, 30000);
  $('lnkCameraApp').href = conf.cameraUrl || 'index.html';
}

bind();
connect();
window.homeDash = { state, conf, api, refreshAll };
