'use strict';
/* GeoTag IRL - real-life GPS tag / manhunt.
   Static PWA. Devices sync peer-to-peer through PeerJS (WebRTC); the host phone is the game server. */

/* ============================== config ============================== */
const PEER_PREFIX = 'geotagirl-';
const PEER_OPTS = {
  debug: 1,
  config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
    // Strict mobile carriers sometimes need a TURN relay. If players cannot connect,
    // add one here: { urls: 'turn:HOST:3478', username: '...', credential: '...' }
  ] }
};
const CODE_TTL = 60000;    // catch code rotates every 60 s
const CODE_GRACE = 10000;  // the previous code is still accepted for 10 s
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ============================== helpers ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function rid(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(x => ALPHABET[x % ALPHABET.length]).join('');
}
function code6() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, '0');
}
function fmt(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(ss).padStart(2, '0');
}
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago';
}
function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) {} }
function tx(c, o) { try { if (c && c.open) c.send(o); } catch (e) {} }
let toastT;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.classList.add('hidden'); return; }
  b.textContent = msg; b.classList.remove('hidden');
}

/* ----- geometry ----- */
function hav(a, b) {
  const R = 6371000, t = Math.PI / 180;
  const dLa = (b[0] - a[0]) * t, dLo = (b[1] - a[1]) * t;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function pip(pt, poly) { // ray casting; points are [lat, lng]
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (((yi > pt[0]) !== (yj > pt[0])) && (pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function centroid(pts) {
  let la = 0, lo = 0; pts.forEach(p => { la += p[0]; lo += p[1]; });
  return [la / pts.length, lo / pts.length];
}
function scaled(b, f) { // shrink a boundary towards its centre by factor f
  if (!b) return null;
  if (b.type === 'circle') return { type: 'circle', center: b.center, radius: b.radius * f };
  const c = centroid(b.pts);
  return { type: 'polygon', pts: b.pts.map(p => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f]) };
}
function inside(b, lat, lng) {
  return b.type === 'circle' ? hav(b.center, [lat, lng]) <= b.radius : pip([lat, lng], b.pts);
}

/* ============================== state ============================== */
const S = {
  mode: null,                 // 'host' | 'play'
  role: null,                 // player's current role
  name: '',
  room: '',
  pid: localStorage.getItem('gt_pid') || (() => { const v = rid(12); localStorage.setItem('gt_pid', v); return v; })(),
  cfg: { boundary: null, durationMin: 30, intervalSec: 0, storm: true, stormMin: 30, catchRange: 50 },
  phase: 'lobby',             // lobby | running | ended
  endAt: 0, durMs: 0, winner: null,
  peer: null,
  // host
  players: new Map(), banned: new Set(), drawMode: 'circle', poly: [], circ: { center: null, radius: 500 }, lastSync: 0,
  // player
  conn: null, joined: false, me: { id: null, status: 'alive' }, pos: null, lastSent: 0, watchId: null, out: false,
  others: new Map(), team: [], counts: { runnersAlive: 0, hunters: 0 }, code: null, codeEnd: 0, rt: null, fitted: false
};

/* ============================== map ============================== */
let lastView = null;
try { lastView = JSON.parse(localStorage.getItem('gt_view')); } catch (e) {}
const map = L.map('map', { zoomControl: false, attributionControl: false, tap: true })
  .setView(lastView ? lastView.c : [30.2, 66.99], lastView ? lastView.z : 5);
L.control.attribution({ position: 'topleft', prefix: false }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
map.on('moveend', () => {
  try { localStorage.setItem('gt_view', JSON.stringify({ c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() })); } catch (e) {}
});
const gBoundary = L.layerGroup().addTo(map);
const gDraw = L.layerGroup().addTo(map);
const markers = new Map();
let accCircle = null;

function shape(b, style) {
  return b.type === 'circle' ? L.circle(b.center, Object.assign({ radius: b.radius }, style)) : L.polygon(b.pts, style);
}
function stormF() {
  if (!S.cfg.storm || S.phase !== 'running' || !S.durMs) return 1;
  const left = Math.max(0, S.endAt - Date.now());
  const elapsed = clamp(1 - left / S.durMs, 0, 1);
  return 1 - (1 - S.cfg.stormMin / 100) * elapsed;
}
function renderBoundary() {
  gBoundary.clearLayers();
  const b = S.cfg.boundary; if (!b) return;
  if (S.cfg.storm && S.phase === 'running') {
    shape(b, { color: '#8b9bb0', weight: 1, dashArray: '2 6', fill: false, interactive: false }).addTo(gBoundary);
    shape(scaled(b, S.cfg.stormMin / 100), { color: '#f59e0b', weight: 2, dashArray: '8 8', fill: false, interactive: false }).addTo(gBoundary);
  }
  shape(scaled(b, stormF()), { color: '#3ddc84', weight: 3, fillColor: '#3ddc84', fillOpacity: 0.07, interactive: false }).addTo(gBoundary);
}
function boundaryBounds(b) {
  if (b.type === 'circle') return L.latLng(b.center).toBounds(b.radius * 2);
  return L.latLngBounds(b.pts);
}
function fitBoundary() {
  const b = S.cfg.boundary; if (!b) return;
  map.fitBounds(boundaryBounds(b), { paddingTopLeft: [30, 90], paddingBottomRight: [30, 280] });
}

function setMarker(id, o) {
  let m = markers.get(id);
  const icon = () => L.divIcon({ className: '', html: '<div class="dot ' + o.cls + '"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });
  const tip = () => { const s = document.createElement('span'); s.textContent = o.label; return s; };
  if (!m) {
    m = L.marker([o.lat, o.lng], { icon: icon(), interactive: false, keyboard: false, zIndexOffset: id === 'me' ? 1000 : 0 }).addTo(map);
    m._cls = o.cls;
    m.bindTooltip(tip(), { permanent: true, direction: 'top', offset: [0, -12], className: 'ntip' });
    markers.set(id, m);
  } else {
    m.setLatLng([o.lat, o.lng]);
    if (m._cls !== o.cls) { m.setIcon(icon()); m._cls = o.cls; }
    m.setTooltipContent(tip());
  }
}
function syncMarkers(items) {
  const keep = new Set();
  items.forEach(o => { keep.add(o.id); setMarker(o.id, o); });
  for (const id of [...markers.keys()]) if (!keep.has(id)) { map.removeLayer(markers.get(id)); markers.delete(id); }
}
function clearMarkers() { syncMarkers([]); if (accCircle) { map.removeLayer(accCircle); accCircle = null; } }

/* ============================== wake lock ============================== */
let wake = null, wantAwake = true;
async function keepAwake() {
  if (!wantAwake) return;
  try {
    if ('wakeLock' in navigator && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; wakeUi(); });
    }
  } catch (e) { wake = null; }
  wakeUi();
}
function wakeUi() {
  const b = $('#btnWake');
  b.classList.toggle('on', !!wake);
  b.title = 'wakeLock' in navigator ? (wake ? 'Screen will stay on' : 'Tap to keep screen on') : 'Not supported in this browser';
}
$('#btnWake').onclick = async () => {
  if (wake) { wantAwake = false; try { await wake.release(); } catch (e) {} wake = null; }
  else { wantAwake = true; await keepAwake(); if (!wake) toast('Keep-awake is not available here. Turn off auto-lock in your phone settings.', 4500); }
  wakeUi();
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode) keepAwake(); });

/* ============================== UI plumbing ============================== */
let activeTab = null, unread = 0;
function setView(v) {
  document.body.dataset.view = v;
  document.body.classList.toggle('is-runner', v === 'play' && S.role === 'runner');
  document.body.classList.toggle('is-hunter', v === 'play' && S.role === 'hunter');
}
function applyRole() {
  setView(S.mode === 'host' ? 'host' : 'play');
  const p = $('#hudRole');
  if (S.mode === 'host') { p.textContent = 'Host'; p.className = 'pill host'; }
  else { p.textContent = S.role === 'hunter' ? 'Hunter' : 'Runner'; p.className = 'pill ' + S.role; }
}
function setTab(name) {
  activeTab = name;
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'p-' + name));
  $('#sheet').classList.remove('collapsed');
  if (name === 'chat') { unread = 0; updBadge(); const l = $('#chatLog'); l.scrollTop = l.scrollHeight; }
}
function updBadge() { const b = $('#chatBadge'); b.textContent = unread; b.classList.toggle('hidden', !unread); }
$$('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$('#sheetHandle').onclick = () => $('#sheet').classList.toggle('collapsed');

function setConn(state) { $('#hudConn').className = 'cdot ' + ({ ok: 'ok', wait: 'wait', lost: 'lost' }[state] || ''); }

function addChat(m) {
  const log = $('#chatLog'), row = el('div', 'msg ' + (m.team || ''));
  const tag = m.team === 'all' ? 'ALL' : (m.team || '').toUpperCase();
  const b = el('b'); b.textContent = (S.mode === 'host' && m.team !== 'sys' ? '[' + tag + '] ' : (m.team === 'all' && S.mode === 'play' ? '[ALL] ' : '')) + m.from + (m.team === 'sys' ? ' ' : ': ');
  row.append(b, document.createTextNode(m.text));
  log.append(row);
  while (log.childElementCount > 150) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (activeTab !== 'chat' && m.team !== 'sys') { unread++; updBadge(); }
}
function sysChat(text) { addChat({ team: 'sys', from: '*', text }); }

function showEnd() {
  const w = S.winner;
  $('#endTitle').textContent = w === 'hunters' ? 'Hunters win' : w === 'runners' ? 'Runners survived' : 'Match ended';
  $('#endSub').textContent = w === 'hunters' ? 'Every runner was caught.' : w === 'runners' ? 'Time ran out with runners still free.' : 'The host ended the match.';
  $('#endOverlay').classList.remove('hidden');
  vibrate([300, 150, 300]);
}
$('#endClose').onclick = () => $('#endOverlay').classList.add('hidden');

function updateHud() {
  const now = Date.now(); let t = '--:--', sub = '';
  if (S.phase === 'running') {
    t = fmt(S.endAt - now);
    if (S.cfg.storm && S.cfg.boundary) {
      const f = stormF(), b = scaled(S.cfg.boundary, f);
      sub = b.type === 'circle' ? 'Zone radius ' + Math.round(b.radius) + ' m' : 'Zone at ' + Math.round(f * 100) + '%';
    }
  } else if (S.phase === 'lobby') { t = 'LOBBY'; sub = S.cfg.durationMin + ' min match'; }
  else t = 'ENDED';
  $('#hudTimer').textContent = t; $('#hudSub').textContent = sub;
}

/* ============================== HOST ============================== */
function startHost() {
  S.mode = 'host'; S.role = null; S.phase = 'lobby';
  applyRole(); setTab('setup'); setConn('wait'); keepAwake(); uiPhase();
  $('#hudRoom').textContent = '....';
  openRoom();
  map.locate({ setView: true, maxZoom: 16 });
  renderDraft(); renderPlayers();
}
function openRoom(tries = 0) {
  S.room = rid(4);
  const peer = new Peer(PEER_PREFIX + S.room, PEER_OPTS); S.peer = peer;
  peer.on('open', () => {
    $('#roomBig').textContent = S.room; $('#hudRoom').textContent = S.room; setConn('ok');
    toast('Room ' + S.room + ' is open. Draw the play area, then start.', 4000);
  });
  peer.on('connection', onHostConn);
  peer.on('disconnected', () => { setConn('wait'); try { peer.reconnect(); } catch (e) {} });
  peer.on('error', err => {
    if (err.type === 'unavailable-id' && tries < 6) { try { peer.destroy(); } catch (e) {} openRoom(tries + 1); }
    else { setConn('lost'); toast('Network problem: ' + err.type, 4000); }
  });
}
function onHostConn(c) {
  c.on('data', m => { try { hostMsg(c, m); } catch (e) { console.error(e); } });
  c.on('close', () => hostDrop(c));
  c.on('error', () => hostDrop(c));
}
function hostDrop(c) {
  for (const p of S.players.values()) if (p.conn === c) { p.connected = false; p.conn = null; sysChat(p.name + ' disconnected'); renderPlayers(); renderHostMarkers(); pushRoster(); }
}
function playerByConn(c) { for (const p of S.players.values()) if (p.conn === c) return p; return null; }
function stState() {
  return { phase: S.phase, remaining: S.phase === 'running' ? Math.max(0, S.endAt - Date.now()) : 0, dur: S.durMs, winner: S.winner };
}
function broadcast(obj, filter) { for (const p of S.players.values()) if (!filter || filter(p)) tx(p.conn, obj); }
function broadcastState() { broadcast(Object.assign({ t: 'st' }, stState())); }
function pushCfg() { renderBoundary(); clearTimeout(pushCfg.t); pushCfg.t = setTimeout(() => broadcast({ t: 'cfg', cfg: S.cfg }), 300); }

function pushRoster() {
  const runnersAlive = [...S.players.values()].filter(p => p.role === 'runner' && p.status === 'alive').length;
  const hunters = [...S.players.values()].filter(p => p.role === 'hunter').length;
  for (const p of S.players.values()) {
    const team = [...S.players.values()].filter(q => q.role === p.role)
      .map(q => ({ id: q.id, name: q.name, role: q.role, connected: q.connected, status: q.status }));
    tx(p.conn, { t: 'roster', team, runnersAlive, hunters });
  }
}
function issueCode(p) {
  p.prev = p.code; p.code = code6(); p.codeAt = Date.now();
  tx(p.conn, { t: 'code', code: p.code, ttl: CODE_TTL });
}

function hostMsg(c, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    const pid = String(m.pid || '').slice(0, 16); if (!pid) return;
    if (S.banned.has(pid)) { tx(c, { t: 'kicked' }); setTimeout(() => { try { c.close(); } catch (e) {} }, 300); return; }
    const name = String(m.name || 'Player').replace(/[<>]/g, '').trim().slice(0, 16) || 'Player';
    let p = S.players.get(pid);
    if (!p) {
      const role = m.role === 'hunter' ? 'hunter' : 'runner';
      p = { id: pid, name, role, baseRole: role, status: 'alive', conn: c, connected: true, pos: null, out: false,
            code: null, prev: null, codeAt: 0, seen: {}, fails: 0, lock: 0 };
      S.players.set(pid, p);
      sysChat(name + ' joined as ' + role);
    } else { p.conn = c; p.connected = true; p.name = name; sysChat(name + ' reconnected'); }
    tx(c, { t: 'welcome', id: pid, role: p.role, status: p.status, cfg: S.cfg, st: stState() });
    if (p.role === 'runner' && p.status === 'alive' && S.phase === 'running') {
      if (p.code && Date.now() - p.codeAt < CODE_TTL) tx(c, { t: 'code', code: p.code, ttl: CODE_TTL - (Date.now() - p.codeAt) });
      else issueCode(p);
    }
    pushRoster(); renderPlayers(); renderHostMarkers();
    return;
  }
  const p = playerByConn(c); if (!p) return;
  switch (m.t) {
    case 'pos': {
      const lat = +m.lat, lng = +m.lng;
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      p.pos = { lat, lng, acc: clamp(+m.acc || 0, 0, 9999), ts: Date.now() - clamp(+m.age || 0, 0, 600000) };
      const was = p.out;
      p.out = !!(S.cfg.boundary && S.phase === 'running' && !inside(scaled(S.cfg.boundary, stormF()), lat, lng));
      if (p.out && !was) { sysChat(p.name + ' is OUT OF BOUNDS'); toast(p.name + ' is out of bounds', 3000); }
      relayPos(p); renderHostMarkers();
      break;
    }
    case 'chat': {
      const text = String(m.text || '').slice(0, 200).trim(); if (!text) return;
      const msg = { t: 'chat', from: p.name, team: p.role, text, ts: Date.now() };
      broadcast(msg, q => q.role === p.role); addChat(msg);
      break;
    }
    case 'catch': hostCatch(p, String(m.code || '').replace(/\D/g, '')); break;
  }
}

function relayPos(p) {
  if (!p.pos) return;
  const item = { id: p.id, name: p.name, role: p.role, lat: p.pos.lat, lng: p.pos.lng, acc: p.pos.acc, ts: p.pos.ts };
  const now = Date.now(), gap = S.cfg.intervalSec * 1000;
  for (const q of S.players.values()) {
    if (q.id === p.id || !q.connected) continue;
    if (q.role === p.role) tx(q.conn, { t: 'pos', p: item });                       // teammates: always live
    else if (p.role === 'runner' && q.role === 'hunter' && S.phase === 'running') { // hunters see runners per ping interval
      if (!gap || now - (q.seen[p.id] || 0) >= gap) { q.seen[p.id] = now; tx(q.conn, { t: 'pos', p: Object.assign({ reveal: true }, item) }); }
    }
  }
}

function hostCatch(h, code) {
  const now = Date.now(), reply = (ok, msg) => tx(h.conn, { t: 'catchres', ok, msg });
  if (S.phase !== 'running') return reply(false, 'The match is not running.');
  if (h.role !== 'hunter') return reply(false, 'Only hunters can register catches.');
  if (now < h.lock) return reply(false, 'Too many wrong codes. Wait ' + Math.ceil((h.lock - now) / 1000) + ' s.');
  const r = [...S.players.values()].find(q => q.role === 'runner' && q.status === 'alive' && q.code &&
    (q.code === code || (q.prev === code && now - q.codeAt < CODE_GRACE)));
  if (!r) {
    h.fails++; if (h.fails >= 5) { h.lock = now + 30000; h.fails = 0; }
    return reply(false, 'Invalid or expired code.');
  }
  const rng = S.cfg.catchRange;
  if (rng > 0 && h.pos && r.pos && now - h.pos.ts < 30000 && now - r.pos.ts < 30000) {
    const d = hav([h.pos.lat, h.pos.lng], [r.pos.lat, r.pos.lng]);
    if (d > rng + h.pos.acc + r.pos.acc) return reply(false, 'You are not close enough to that runner (about ' + Math.round(d) + ' m apart).');
  }
  h.fails = 0; r.status = 'caught'; r.role = 'hunter'; r.code = null; r.prev = null; r.seen = {};
  reply(true, 'Caught ' + r.name + '!');
  tx(r.conn, { t: 'caught', by: h.name });
  broadcast({ t: 'rolechg', id: r.id, role: 'hunter', status: 'caught' }, q => q.id !== r.id);
  announce(r.name + ' was caught by ' + h.name + '.');
  pushRoster(); renderPlayers(); renderHostMarkers();
  if (![...S.players.values()].some(q => q.role === 'runner' && q.status === 'alive')) endGame('hunters');
}
function announce(text) {
  const msg = { t: 'chat', from: 'HOST', team: 'all', text, ts: Date.now() };
  broadcast(msg); addChat(msg);
}
function sendHostChat(text, target) {
  const msg = { t: 'chat', from: 'HOST', team: target, text, ts: Date.now() };
  broadcast(msg, q => target === 'all' || q.role === target); addChat(msg);
}

function endGame(winner) {
  if (S.phase !== 'running') return;
  S.phase = 'ended'; S.winner = winner;
  for (const p of S.players.values()) { p.code = null; p.out = false; }
  broadcastState(); uiPhase(); renderBoundary(); showEnd(); sysChat('Match over');
}
function startMatch() {
  if (!S.cfg.boundary) return toast('Draw a play area first.');
  const live = [...S.players.values()].filter(p => p.connected);
  if (!live.some(p => p.role === 'runner') || !live.some(p => p.role === 'hunter')) return toast('You need at least one runner and one hunter connected.', 3500);
  S.durMs = S.cfg.durationMin * 60000; S.endAt = Date.now() + S.durMs; S.phase = 'running'; S.winner = null;
  for (const p of S.players.values()) { p.seen = {}; if (p.role === 'runner' && p.status === 'alive') issueCode(p); }
  broadcastState(); uiPhase(); renderBoundary(); sysChat('Match started');
}
function newRound() {
  for (const p of S.players.values()) { p.role = p.baseRole; p.status = 'alive'; p.code = null; p.prev = null; p.out = false; p.seen = {}; }
  S.phase = 'lobby'; S.winner = null; S.endAt = 0;
  broadcastState();
  for (const p of S.players.values()) tx(p.conn, { t: 'rolechg', id: p.id, role: p.role, status: 'alive' });
  pushRoster(); uiPhase(); renderBoundary(); renderPlayers(); renderHostMarkers();
  $('#endOverlay').classList.add('hidden'); sysChat('New round - back in the lobby');
}
function kick(id) {
  const p = S.players.get(id); if (!p || !confirm('Remove ' + p.name + ' from this room?')) return;
  S.banned.add(id); tx(p.conn, { t: 'kicked' });
  setTimeout(() => { try { p.conn && p.conn.close(); } catch (e) {} }, 300);
  S.players.delete(id); pushRoster(); renderPlayers(); renderHostMarkers();
}

function renderPlayers() {
  const box = $('#plist'); box.textContent = '';
  if (!S.players.size) { const d = el('div', 'mut'); d.textContent = 'No players yet. Share the room code or invite link.'; box.append(d); return; }
  for (const p of S.players.values()) {
    const row = el('div', 'prow' + (p.out ? ' bad' : ''));
    const d = el('span', 'dot2 ' + p.role + (p.connected ? '' : ' off'));
    const nm = el('span', 'pname'); nm.textContent = p.name;
    const meta = el('span', 'meta');
    meta.textContent = [p.role, p.status === 'caught' ? 'caught' : '', p.out ? 'OUT OF BOUNDS' : '',
      p.connected ? (p.pos ? 'GPS ' + ago(p.pos.ts) : 'no GPS yet') : 'offline'].filter(Boolean).join(' | ');
    const x = el('button', 'x'); x.type = 'button'; x.textContent = 'x'; x.title = 'Remove player'; x.onclick = () => kick(p.id);
    row.append(d, nm, x, meta); box.append(row);
  }
}
function renderHostMarkers() {
  const items = [];
  for (const p of S.players.values()) {
    if (!p.pos) continue;
    items.push({ id: p.id, lat: p.pos.lat, lng: p.pos.lng,
      cls: p.role + (p.out ? ' out' : '') + (p.connected ? '' : ' off'),
      label: p.name + (p.out ? ' (OUT)' : '') + ' ' + ago(p.pos.ts) });
  }
  syncMarkers(items);
}
function uiPhase() {
  const lobby = S.phase === 'lobby';
  $('#btnStart').classList.toggle('hidden', !lobby);
  $('#btnEnd').classList.toggle('hidden', S.phase !== 'running');
  $('#btnNew').classList.toggle('hidden', S.phase !== 'ended');
  $$('#p-setup input, #p-setup select, #dmCircle, #dmPoly, #polyUndo, #polyClear').forEach(e => e.disabled = !lobby);
  updateHud();
}

/* ----- host: drawing the play area ----- */
function updateBoundaryFromDraft() {
  S.cfg.boundary = S.drawMode === 'polygon'
    ? (S.poly.length >= 3 ? { type: 'polygon', pts: S.poly.map(p => p.slice()) } : null)
    : (S.circ.center ? { type: 'circle', center: S.circ.center.slice(), radius: S.circ.radius } : null);
  renderDraft(); pushCfg();
}
function renderDraft() {
  gDraw.clearLayers();
  if (S.mode !== 'host' || S.phase !== 'lobby') return;
  const dot = ll => L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#3ddc84', fillOpacity: 1, interactive: false }).addTo(gDraw);
  if (S.drawMode === 'polygon') {
    S.poly.forEach(dot);
    if (S.poly.length === 2) L.polyline(S.poly, { color: '#3ddc84', weight: 3, dashArray: '6 6', interactive: false }).addTo(gDraw);
    $('#polyInfo').textContent = S.poly.length < 3 ? S.poly.length + ' of 3+ points' : S.poly.length + ' points';
  } else if (S.circ.center) dot(S.circ.center);
}
function setDrawMode(m) {
  S.drawMode = m;
  $('#dmCircle').classList.toggle('on', m === 'circle'); $('#dmPoly').classList.toggle('on', m === 'polygon');
  $('#circCtl').classList.toggle('hidden', m !== 'circle'); $('#polyCtl').classList.toggle('hidden', m !== 'polygon');
  updateBoundaryFromDraft();
}
map.on('click', e => {
  if (S.mode !== 'host' || S.phase !== 'lobby') return;
  const p = [+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)];
  if (S.drawMode === 'polygon') S.poly.push(p); else S.circ.center = p;
  updateBoundaryFromDraft();
});
$('#dmCircle').onclick = () => setDrawMode('circle');
$('#dmPoly').onclick = () => setDrawMode('polygon');
$('#rad').oninput = e => { S.circ.radius = +e.target.value; $('#radVal').textContent = S.circ.radius + ' m'; updateBoundaryFromDraft(); };
$('#polyUndo').onclick = () => { S.poly.pop(); updateBoundaryFromDraft(); };
$('#polyClear').onclick = () => { S.poly = []; updateBoundaryFromDraft(); };
$('#inDur').onchange = e => { S.cfg.durationMin = clamp(Math.round(+e.target.value) || 30, 1, 480); e.target.value = S.cfg.durationMin; pushCfg(); updateHud(); };
$('#inInt').onchange = e => { S.cfg.intervalSec = +e.target.value; pushCfg(); };
$('#inCatchR').onchange = e => { S.cfg.catchRange = +e.target.value; pushCfg(); };
$('#inStorm').onchange = e => { S.cfg.storm = e.target.checked; pushCfg(); };
$('#inStormMin').oninput = e => { S.cfg.stormMin = +e.target.value; $('#stormVal').textContent = S.cfg.stormMin + '%'; pushCfg(); };
$('#btnStart').onclick = startMatch;
$('#btnEnd').onclick = () => { if (confirm('End the match now?')) endGame(null); };
$('#btnNew').onclick = newRound;
$('#btnShare').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + S.room;
  try {
    if (navigator.share) await navigator.share({ title: 'GeoTag IRL', text: 'Join my match. Room code ' + S.room, url });
    else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  } catch (e) {}
};

/* ============================== PLAYER ============================== */
function joinGame(name, room, role) {
  S.mode = 'play'; S.name = name; S.room = room; S.role = role; S.joined = false;
  $('#homeErr').textContent = '';
  connectToHost();
}
function failJoin(msg) {
  clearTimeout(S.rt);
  try { S.peer && S.peer.destroy(); } catch (e) {}
  S.peer = null; S.conn = null; S.mode = null;
  setView('home'); $('#homeErr').textContent = msg; $('#btnJoin').disabled = false;
}
function scheduleReconnect() {
  clearTimeout(S.rt);
  S.rt = setTimeout(connectToHost, 3000);
}
function connectToHost() {
  clearTimeout(S.rt); setConn('wait');
  const make = () => {
    const c = S.peer.connect(PEER_PREFIX + S.room, { reliable: true, serialization: 'json' });
    S.conn = c; let opened = false;
    const to = setTimeout(() => {
      if (opened) return;
      try { c.close(); } catch (e) {}
      if (S.joined) { setConn('lost'); scheduleReconnect(); } else failJoin('Could not reach room ' + S.room + '. Check the code and your connection.');
    }, 12000);
    c.on('open', () => { opened = true; clearTimeout(to); tx(c, { t: 'hello', pid: S.pid, name: S.name, role: S.role }); });
    c.on('data', m => { try { clientMsg(m); } catch (e) { console.error(e); } });
    c.on('close', () => { if (S.conn === c && S.mode === 'play') { setConn('lost'); if (S.joined) { banner('Connection lost. Reconnecting...'); scheduleReconnect(); } } });
    c.on('error', () => {});
  };
  if (S.peer && !S.peer.destroyed && S.peer.open) return make();
  try { S.peer && S.peer.destroy(); } catch (e) {}
  const peer = new Peer(PEER_OPTS); S.peer = peer;
  peer.on('open', make);
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
  peer.on('error', e => {
    if (S.peer !== peer) return;
    if (e.type === 'peer-unavailable') {
      if (S.joined) { setConn('lost'); banner('Host is offline. Retrying...'); scheduleReconnect(); }
      else failJoin('Room ' + S.room + ' was not found. Check the code.');
    } else if (!S.joined) failJoin('Network error: ' + e.type);
    else { setConn('lost'); scheduleReconnect(); }
  });
}

function clientMsg(m) {
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'welcome':
      S.joined = true; S.me = { id: m.id, status: m.status }; S.role = m.role;
      setConn('ok'); banner(null); applyRole(); applyCfg(m.cfg); applySt(m.st);
      if (!activeTab || activeTab === 'setup' || activeTab === 'players') setTab('catch');
      startGeo(); keepAwake();
      break;
    case 'cfg': applyCfg(m.cfg); break;
    case 'st': applySt(m); break;
    case 'pos': S.others.set(m.p.id, Object.assign({}, m.p, { rx: Date.now() })); renderPlay(); break;
    case 'roster': S.team = m.team || []; S.counts = { runnersAlive: m.runnersAlive, hunters: m.hunters }; renderTeam(); break;
    case 'code': S.code = m.code; S.codeEnd = Date.now() + m.ttl; renderCode(); break;
    case 'chat': addChat(m); break;
    case 'catchres': {
      const e = $('#catchMsg'); e.textContent = m.msg; e.className = m.ok ? 'ok' : 'bad';
      if (m.ok) { $('#inCatch').value = ''; vibrate(200); } else vibrate([80, 60, 80]);
      break;
    }
    case 'caught':
      S.role = 'hunter'; S.me.status = 'caught'; S.code = null; S.others.clear(); applyRole(); renderCode(); renderPlay(); setTab('catch');
      toast('You were caught by ' + m.by + '. You are a hunter now.', 5000); vibrate([400, 150, 400]);
      break;
    case 'rolechg':
      if (m.id === S.me.id) { S.role = m.role; S.me.status = m.status; S.code = null; S.others.clear(); applyRole(); renderCode(); renderPlay(); }
      else { S.others.delete(m.id); renderPlay(); }
      break;
    case 'kicked': failJoin('The host removed you from this room.'); break;
  }
}
function applyCfg(cfg) {
  S.cfg = cfg; renderBoundary();
  if (!S.fitted && cfg.boundary) { S.fitted = true; fitBoundary(); }
  updateHud(); checkOob();
}
function applySt(m) {
  const prev = S.phase;
  S.phase = m.phase; S.durMs = m.dur || 0; S.winner = m.winner || null;
  S.endAt = m.phase === 'running' ? Date.now() + (m.remaining || 0) : 0;
  if (prev !== 'running' && m.phase === 'running') { toast('Match started. Good luck.', 4000); vibrate([200, 100, 200]); }
  if (m.phase === 'ended' && prev !== 'ended') showEnd();
  if (m.phase === 'lobby') { $('#endOverlay').classList.add('hidden'); S.others.clear(); S.code = null; renderCode(); }
  renderBoundary(); renderPlay(); updateHud(); checkOob();
}

/* ----- GPS ----- */
function startGeo() {
  if (S.watchId != null) return;
  if (!('geolocation' in navigator)) { banner('This browser has no location support.'); return; }
  S.watchId = navigator.geolocation.watchPosition(onGeo,
    e => banner(e.code === 1 ? 'Location permission denied. Allow location for this site in your browser settings.' : 'Waiting for GPS signal...'),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function onGeo(g) {
  const c = g.coords;
  S.pos = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, ts: Date.now() };
  if (!$('#banner').classList.contains('hidden') && !/Connection lost|Host is offline/.test($('#banner').textContent)) banner(null);
  renderPlay(); checkOob();
}
function checkOob() {
  const b = S.cfg.boundary; let out = false;
  if (S.mode === 'play' && b && S.phase === 'running' && S.pos) out = !inside(scaled(b, stormF()), S.pos.lat, S.pos.lng);
  if (out && !S.out) vibrate([300, 100, 300, 100, 300]);
  S.out = out; $('#oob').classList.toggle('hidden', !out);
}
function renderPlay() {
  if (S.mode !== 'play') return;
  const items = [];
  if (S.pos) items.push({ id: 'me', lat: S.pos.lat, lng: S.pos.lng, cls: 'me', label: 'You' });
  for (const o of S.others.values()) {
    items.push({ id: o.id, lat: o.lat, lng: o.lng, cls: o.role, label: o.name + (o.reveal ? ' ' + ago(o.rx) : '') });
  }
  syncMarkers(items);
  if (S.pos) {
    if (!accCircle) accCircle = L.circle([S.pos.lat, S.pos.lng], { radius: S.pos.acc, color: '#3b82f6', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    else { accCircle.setLatLng([S.pos.lat, S.pos.lng]); accCircle.setRadius(S.pos.acc); }
    if (!S.centered) { S.centered = true; if (!S.cfg.boundary) map.setView([S.pos.lat, S.pos.lng], 17); }
  }
}
function renderTeam() {
  $('#tcounts').textContent = 'Runners still free: ' + S.counts.runnersAlive + '   |   Hunters: ' + S.counts.hunters;
  const box = $('#tlist'); box.textContent = '';
  S.team.forEach(q => {
    const row = el('div', 'prow');
    const d = el('span', 'dot2 ' + q.role + (q.connected ? '' : ' off'));
    const nm = el('span', 'pname'); nm.textContent = q.name + (q.id === S.me.id ? ' (you)' : '');
    const meta = el('span', 'meta'); meta.textContent = [q.status === 'caught' ? 'caught earlier' : '', q.connected ? 'online' : 'offline'].filter(Boolean).join(' | ');
    row.append(d, nm, meta); box.append(row);
  });
}
function renderCode() {
  const v = $('#codeVal'), n = $('#codeNote');
  if (!S.code || S.phase !== 'running') { v.textContent = '------'; n.textContent = S.phase === 'running' ? '' : 'Your code appears when the match starts.'; $('#codeBar').style.width = '0'; return; }
  v.textContent = S.code.slice(0, 3) + ' ' + S.code.slice(3);
}
function tickCode() {
  if (!S.code || S.phase !== 'running') return;
  const left = S.codeEnd - Date.now();
  $('#codeBar').style.width = clamp(left / CODE_TTL, 0, 1) * 100 + '%';
  $('#codeNote').textContent = 'New code in ' + Math.max(0, Math.ceil(left / 1000)) + ' s';
}

$('#inCatch').oninput = e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
$('#btnCatch').onclick = () => {
  const v = $('#inCatch').value;
  if (v.length !== 6) { const e = $('#catchMsg'); e.textContent = 'Enter all 6 digits.'; e.className = 'bad'; return; }
  tx(S.conn, { t: 'catch', code: v });
};
$('#chatForm').onsubmit = e => {
  e.preventDefault();
  const i = $('#chatInput'), text = i.value.trim(); if (!text) return;
  if (S.mode === 'host') sendHostChat(text, $('#chatTarget').value); else tx(S.conn, { t: 'chat', text });
  i.value = '';
};

/* ============================== shared tick ============================== */
setInterval(() => {
  const now = Date.now();
  updateHud();
  if (S.mode === 'host') {
    if (S.phase === 'running') {
      if (now >= S.endAt) {
        const alive = [...S.players.values()].some(p => p.role === 'runner' && p.status === 'alive');
        endGame(alive ? 'runners' : 'hunters');
      } else {
        for (const p of S.players.values()) {
          if (p.role === 'runner' && p.status === 'alive' && p.connected && now - p.codeAt >= CODE_TTL) issueCode(p);
          if (p.pos && S.cfg.boundary) p.out = !inside(scaled(S.cfg.boundary, stormF()), p.pos.lat, p.pos.lng);
        }
        if (S.cfg.storm) renderBoundary();
      }
    }
    if (now - S.lastSync > 5000) { S.lastSync = now; broadcastState(); pushRoster(); }
    renderHostMarkers(); renderPlayers();
  } else if (S.mode === 'play') {
    if (S.pos && S.conn && S.conn.open && now - S.lastSent >= 2000) {
      S.lastSent = now;
      tx(S.conn, { t: 'pos', lat: S.pos.lat, lng: S.pos.lng, acc: S.pos.acc, age: now - S.pos.ts });
    }
    if (S.phase === 'running' && S.cfg.storm) renderBoundary();
    checkOob(); renderPlay(); tickCode();
  }
}, 1000);

/* ============================== home screen & boot ============================== */
$('#btnHost').onclick = () => startHost();
$('#btnJoinShow').onclick = () => { $('#joinForm').classList.toggle('hidden'); $('#inName').focus(); };
$('#inCode').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
$('#joinForm').onsubmit = e => {
  e.preventDefault();
  const name = $('#inName').value.replace(/[<>]/g, '').trim().slice(0, 16), room = $('#inCode').value.trim().toUpperCase();
  const role = ($('input[name=role]:checked') || {}).value || 'runner';
  if (!name) return ($('#homeErr').textContent = 'Enter your name.');
  if (room.length !== 4) return ($('#homeErr').textContent = 'The room code has 4 characters.');
  try { localStorage.setItem('gt_name', name); localStorage.setItem('gt_role', role); } catch (e2) {}
  $('#btnJoin').disabled = true; $('#homeErr').textContent = 'Connecting...';
  joinGame(name, room, role);
};
$('#btnLoc').onclick = () => {
  if (S.mode === 'host') map.locate({ setView: true, maxZoom: 17 });
  else if (S.pos) map.setView([S.pos.lat, S.pos.lng], Math.max(map.getZoom(), 16));
  else if (S.cfg.boundary) fitBoundary();
};
$('#btnExit').onclick = () => {
  if (confirm(S.mode === 'host' ? 'Close the room? Everyone will be disconnected.' : 'Leave this match?')) location.href = location.pathname;
};
map.on('locationerror', () => toast('Could not get your location. Allow location access to centre the map.', 4000));

(function boot() {
  try {
    const n = localStorage.getItem('gt_name'), r = localStorage.getItem('gt_role');
    if (n) $('#inName').value = n;
    if (r) { const i = $('input[name=role][value=' + r + ']'); if (i) i.checked = true; }
  } catch (e) {}
  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (room) { $('#inCode').value = room; $('#joinForm').classList.remove('hidden'); }
  wakeUi(); setView('home');

  // install affordances
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#btnInstall').classList.remove('hidden'); });
  $('#btnInstall').onclick = async () => { if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch (e) {} deferred = null; $('#btnInstall').classList.add('hidden'); };
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('#iosHint').classList.remove('hidden');

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
})();
