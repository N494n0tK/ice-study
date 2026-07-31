'use strict';
(() => {

/* ================= CONFIG ================= */

const CUBE = 58;             // base ice size (scene units) — chunky
const MAX_CUBES = 24;        // jar capacity (2 hours)
const CUBE_MINUTES = 5;
const K = 0.24;              // ellipse squash: viewed slightly from above
const DENSITY = 0.9;         // floating ice: fraction of height below waterline
const WATER_FACTOR = 0.5;    // melted cube area -> water height scaling
const STORAGE_KEY = 'iceStudy.v2';

// jar geometry (scene units, y grows downward, x centered on 0)
const JAR_R = 102;
const JAR_H = 380;
const RIM_Y = 96;
const FLOOR_Y = RIM_Y + JAR_H;
const SCENE_W = JAR_R * 2 + 90;
const SCENE_H = FLOOR_Y + JAR_R * K + 34;

// debug: ?speed=60 makes time run 60x faster
const speed = (() => {
  const v = parseFloat(new URLSearchParams(location.search).get('speed'));
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

/* ================= TIMER / STATE ================= */

let state = {
  status: 'idle',        // idle | running | paused | done
  totalMs: 0,
  bankedMs: 0,
  lastResumeEpoch: 0,
};

let prefs = {
  cubes: 5,
  showTime: true,
  rain: false,
  volume: 0.5,
  notify: false,
};

function sessionCubes() {
  return Math.max(1, Math.round(state.totalMs / 60000 / CUBE_MINUTES));
}

function elapsedMs() {
  if (state.status === 'running') {
    return state.bankedMs + (Date.now() - state.lastResumeEpoch) * speed;
  }
  return state.bankedMs;
}

// melt bookkeeping: k cubes fully gone, current one at `frac`
function meltInfo() {
  const N = sessionCubes();
  const cubeMs = state.totalMs / N;
  const e = Math.min(elapsedMs(), state.totalMs);
  const meltedFrac = state.totalMs > 0 ? e / state.totalMs : 0;
  let k = Math.floor(e / cubeMs);
  let frac = (e - k * cubeMs) / cubeMs;
  if (k >= N) { k = N; frac = 0; }
  const waterH = (N * CUBE * CUBE * WATER_FACTOR * meltedFrac) / (JAR_R * 2);
  return { N, k, frac, meltedFrac, waterH, cubesLeft: N - k };
}

function startSession() {
  if (prefs.cubes < 1) return;
  state = {
    status: 'running',
    totalMs: prefs.cubes * CUBE_MINUTES * 60000,
    bankedMs: 0,
    lastResumeEpoch: Date.now(),
  };
  clearEffects();
  save();
  syncUI();
}

function pauseSession() {
  if (state.status !== 'running') return;
  state.bankedMs = elapsedMs();
  state.status = 'paused';
  save();
  syncUI();
}

function resumeSession() {
  if (state.status !== 'paused') return;
  state.lastResumeEpoch = Date.now();
  state.status = 'running';
  save();
  syncUI();
}

function resetSession() {
  state = { status: 'idle', totalMs: 0, bankedMs: 0, lastResumeEpoch: 0 };
  clearEffects();
  rebuildSim();
  save();
  syncUI();
}

function completeSession(silent) {
  state.status = 'done';
  state.bankedMs = state.totalMs;
  save();
  syncUI();
  if (!silent) {
    playChime();
    if (prefs.notify && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('氷がぜんぶ溶けました', {
        body: 'おつかれさまでした。きょうの勉強はおしまいです。',
      });
    }
  }
}

/* ================= PERSISTENCE ================= */

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, prefs }));
  } catch (e) { /* private mode etc. */ }
}

function restore() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
  if (!data) return;
  if (data.prefs) prefs = { ...prefs, ...data.prefs };
  if (data.state && data.state.status && data.state.status !== 'idle') {
    state = data.state;
    if (elapsedMs() >= state.totalMs) {
      state.status = 'done';
      state.bankedMs = state.totalMs;
    }
  }
}

/* ================= AUDIO (Web Audio, all synthesized) ================= */

const audio = { ctx: null, master: null, rain: null };

function ensureAudioCtx() {
  if (!audio.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audio.ctx = new AC();
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = prefs.volume;
    audio.master.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}

function setRain(on) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  if (on && !audio.rain) {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0.055;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();

    src.connect(lp).connect(gain).connect(audio.master);
    src.start();
    audio.rain = { src, lfo, gain };
  } else if (!on && audio.rain) {
    const { src, lfo, gain } = audio.rain;
    gain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.2);
    setTimeout(() => { try { src.stop(); lfo.stop(); } catch (e) {} }, 600);
    audio.rain = null;
  }
}

function blip(freqFrom, freqTo, dur, vol, delayWet) {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqFrom, t);
  osc.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 4);
  osc.connect(g);
  g.connect(audio.master);
  if (delayWet > 0) {
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.16;
    const fb = ctx.createGain();
    fb.gain.value = 0.25;
    const wet = ctx.createGain();
    wet.gain.value = delayWet;
    g.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(audio.master);
  }
  osc.start(t);
  osc.stop(t + dur * 4 + 0.05);
}

function playDrip() { blip(1400, 400, 0.08, 0.12, 0.3); }
function playClink() { blip(1900, 1100, 0.045, 0.16, 0.15); blip(2600, 1600, 0.03, 0.08, 0); }

function playChime() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const notes = [659.25, 880, 1046.5];
  notes.forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.22;
    [0, 3].forEach(detune => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(g).connect(audio.master);
      osc.start(t);
      osc.stop(t + 1.5);
    });
  });
}

/* ================= ICE PHYSICS =================
   Each cube is simulated as a disc: gravity, buoyancy (ice floats with
   ~90% of its height submerged), wall/floor contacts and pairwise
   collisions solved by position relaxation. Cubes carry a random depth
   z in [0,1]; cubes far apart in depth pass in front/behind each other,
   which packs the jar like a real messy pile. */

let simCubes = [];   // {id,x,y,vx,vy,z,rot,type,sizeMul,seed,meltP,landed}
let nextId = 1;
let meltingId = null;

function cubeSize(cu) { return CUBE * cu.sizeMul * Math.sqrt(Math.max(0, 1 - cu.meltP)); }
function cubeR(cu) { return cubeSize(cu) * 0.5; }

function spawnCube(drop) {
  const cu = {
    id: nextId++,
    x: (Math.random() * 2 - 1) * JAR_R * 0.45,
    y: drop ? RIM_Y - 70 : RIM_Y + 60 + Math.random() * JAR_H * 0.5,
    vx: (Math.random() - 0.5) * 60,
    vy: drop ? 60 : 0,
    z: Math.random(),
    rot: (Math.random() - 0.5) * 0.55,
    type: Math.floor(Math.random() * 4),
    sizeMul: 0.85 + Math.random() * 0.3,
    seed: Math.random() * Math.PI * 2,
    meltP: 0,
    landed: !drop,
  };
  simCubes.push(cu);
  return cu;
}

function removeTopmost() {
  if (!simCubes.length) return;
  let top = 0;
  for (let i = 1; i < simCubes.length; i++) {
    if (simCubes[i].y < simCubes[top].y) top = i;
  }
  const [gone] = simCubes.splice(top, 1);
  if (meltingId === gone.id) meltingId = null;
}

function stepSim(dt, waterY, t, silent) {
  const G = 1500;
  for (const cu of simCubes) {
    const r = cubeR(cu);
    // fraction of the cube's height below the waterline
    const sub = Math.min(1, Math.max(0, ((cu.y + r) - waterY) / (2 * r)));
    // net acceleration: zero when submerged to DENSITY (=> floats)
    cu.vy += G * (1 - sub / DENSITY) * dt;
    const dragK = sub > 0.05 ? 3.2 : 0.12;
    cu.vx *= Math.exp(-dragK * dt);
    cu.vy *= Math.exp(-dragK * dt);
    if (sub > 0.3) {           // gentle water bobbing
      cu.vy += Math.sin(t * 1.25 + cu.seed) * 9 * dt;
      cu.vx += Math.sin(t * 0.7 + cu.seed * 2) * 5 * dt;
    }
    cu.x += cu.vx * dt;
    cu.y += cu.vy * dt;
  }

  for (let iter = 0; iter < 2; iter++) {
    for (const cu of simCubes) {
      const r = cubeR(cu) * 0.96;
      // side walls (slightly narrower for deeper cubes)
      const maxX = JAR_R - r - 5 - cu.z * 5;
      if (cu.x < -maxX) { cu.x = -maxX; cu.vx = Math.abs(cu.vx) * 0.3; }
      if (cu.x > maxX) { cu.x = maxX; cu.vx = -Math.abs(cu.vx) * 0.3; }
      // floor
      const maxY = FLOOR_Y - 4 - r;
      if (cu.y > maxY) {
        cu.y = maxY;
        if (cu.vy > 0) {
          if (!cu.landed && cu.vy > 90 && !silent) playClink();
          cu.landed = true;
          cu.vy = -cu.vy * 0.12;
        }
      }
    }
    // pairwise contacts (cubes at very different depths pass each other)
    for (let i = 0; i < simCubes.length; i++) {
      for (let j = i + 1; j < simCubes.length; j++) {
        const a = simCubes[i], b = simCubes[j];
        if (Math.abs(a.z - b.z) >= 0.5) continue;
        const minD = (cubeR(a) + cubeR(b)) * 0.9;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD) continue;
        let d = Math.sqrt(d2);
        if (d < 0.01) { dx = (a.seed - b.seed) || 0.1; dy = -0.5; d = Math.hypot(dx, dy); }
        const push = (minD - d) / d * 0.5;
        a.x -= dx * push; a.y -= dy * push;
        b.x += dx * push; b.y += dy * push;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const impact = Math.abs(rvx * dx / d + rvy * dy / d);
        if ((!a.landed || !b.landed) && impact > 90 && !silent) {
          playClink();
          a.landed = b.landed = true;
        }
        a.vx *= 0.92; a.vy *= 0.92; b.vx *= 0.92; b.vy *= 0.92;
      }
    }
  }
}

function presettle(waterY) {
  for (let i = 0; i < 260; i++) stepSim(1 / 60, waterY, i / 60, true);
  for (const cu of simCubes) cu.landed = true;
}

// rebuild the pile from scratch (page load / reset / restore)
function rebuildSim() {
  simCubes = [];
  meltingId = null;
  if (state.status === 'idle') {
    for (let i = 0; i < prefs.cubes; i++) spawnCube(false);
    presettle(FLOOR_Y + 999);
  } else if (state.status === 'running' || state.status === 'paused') {
    const m = meltInfo();
    for (let i = 0; i < m.cubesLeft; i++) spawnCube(false);
    presettle(FLOOR_Y - m.waterH);
  }
}

// keep the pile in sync with the melt schedule; returns the melting cube
function syncMelt() {
  if (state.status === 'idle') {
    while (simCubes.length > prefs.cubes) removeTopmost();
    while (simCubes.length < prefs.cubes) { spawnCube(false); presettle(FLOOR_Y + 999); }
    for (const cu of simCubes) cu.meltP = 0;
    return null;
  }
  if (state.status === 'done') {
    simCubes.length = 0;
    return null;
  }
  const m = meltInfo();
  while (simCubes.length > m.cubesLeft) removeTopmost();
  let melting = null;
  if (simCubes.length > 0 && m.k < m.N) {
    melting = simCubes.find(cu => cu.id === meltingId) || null;
    if (!melting) {
      // the topmost cube melts first (it is the most exposed)
      melting = simCubes.reduce((top, cu) => (cu.y < top.y ? cu : top), simCubes[0]);
      meltingId = melting.id;
    }
    for (const cu of simCubes) cu.meltP = cu === melting ? m.frac : 0;
  }
  return melting;
}

/* ================= RENDER ================= */

const canvas = document.getElementById('scene');
const ctx2d = canvas.getContext('2d');

const droplets = [];
const bubbles = [];
const rings = [];
let dropAnimUntil = 0;   // lid stays open until this time
let lidLift = 0;

function clearEffects() {
  droplets.length = 0;
  bubbles.length = 0;
  rings.length = 0;
  dropAnimUntil = 0;
}

let lastDropletAt = 0;
let lastBubbleAt = 0;
let lastFrameT = 0;

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function ellipse(c, x, y, rx, ry) {
  c.beginPath();
  c.ellipse(x, y, rx, Math.max(0.1, ry), 0, 0, Math.PI * 2);
}

/* ---- four ice designs, drawn centered on (0,0) ---- */

function iceFill(c, s, alpha) {
  const g = c.createLinearGradient(-s / 2, -s / 2, s / 2, s / 2);
  g.addColorStop(0, `rgba(214, 238, 252, ${0.52 * alpha})`);
  g.addColorStop(0.55, `rgba(160, 205, 235, ${0.36 * alpha})`);
  g.addColorStop(1, `rgba(112, 162, 208, ${0.42 * alpha})`);
  return g;
}

function drawCracks(c, s, seed, alpha) {
  c.strokeStyle = `rgba(255, 255, 255, ${0.15 * alpha})`;
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(-s * 0.22 + Math.sin(seed) * 4, -s * 0.15);
  c.lineTo(s * 0.08 + Math.cos(seed * 2) * 4, s * 0.16);
  c.moveTo(s * 0.2, -s * 0.25 + Math.sin(seed * 3) * 4);
  c.lineTo(0, s * 0.05);
  c.stroke();
}

// type 0: classic cube with a visible top face
function drawIceCube(c, s, p, seed, t, soften, alpha) {
  const h = s / 2;
  const round = Math.max(p, soften * 0.35);
  const rb = s * (0.1 + 0.4 * round);
  const wob = ph => Math.max(1, Math.min(h, rb * (1 + 0.3 * Math.sin(t * 0.5 + seed + ph))));
  const radii = [wob(0), wob(1.7), wob(3.1), wob(4.6)];
  // top face
  const d = s * 0.26;
  c.globalAlpha = alpha * (1 - p) * 0.85;
  c.fillStyle = 'rgba(238, 251, 255, 0.55)';
  c.beginPath();
  c.moveTo(-h + radii[0] * 0.4, -h);
  c.lineTo(h - radii[1] * 0.4, -h);
  c.lineTo(h - radii[1] * 0.4 - s * 0.1, -h - d);
  c.lineTo(-h + radii[0] * 0.4 + s * 0.16, -h - d);
  c.closePath();
  c.fill();
  c.globalAlpha = alpha;
  // front face
  c.fillStyle = iceFill(c, s, 1);
  c.beginPath(); c.roundRect(-h, -h, s, s, radii); c.fill();
  c.fillStyle = 'rgba(238, 250, 255, 0.16)';
  c.beginPath(); c.roundRect(-h * 0.62, -h * 0.62, s * 0.62, s * 0.62, rb * 0.7); c.fill();
  c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  c.lineWidth = 1.3;
  c.beginPath(); c.moveTo(-h + radii[0] * 0.8, -h + 1.2); c.lineTo(h * 0.55, -h + 1.2); c.stroke();
  drawCracks(c, s, seed, 1);
}

// type 1: flat-ish rectangular block
function drawIceBlock(c, s, p, seed, t, soften, alpha) {
  const w = s * 1.16, hgt = s * 0.82;
  const round = Math.max(p, soften * 0.35);
  const rb = s * (0.1 + 0.38 * round);
  const d = s * 0.22;
  c.globalAlpha = alpha * (1 - p) * 0.8;
  c.fillStyle = 'rgba(238, 251, 255, 0.5)';
  c.beginPath();
  c.moveTo(-w / 2 + rb * 0.4, -hgt / 2);
  c.lineTo(w / 2 - rb * 0.4, -hgt / 2);
  c.lineTo(w / 2 - rb * 0.4 - s * 0.12, -hgt / 2 - d);
  c.lineTo(-w / 2 + rb * 0.4 + s * 0.18, -hgt / 2 - d);
  c.closePath();
  c.fill();
  c.globalAlpha = alpha;
  c.fillStyle = iceFill(c, s, 1);
  c.beginPath(); c.roundRect(-w / 2, -hgt / 2, w, hgt, rb); c.fill();
  c.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  c.lineWidth = 1.2;
  c.beginPath(); c.moveTo(-w * 0.36, -hgt / 2 + 1.2); c.lineTo(w * 0.3, -hgt / 2 + 1.2); c.stroke();
  drawCracks(c, s * 0.9, seed, 1);
}

// type 2: tumbled, well-rounded lump
function drawIceTumbled(c, s, p, seed, t, soften, alpha) {
  const h = s / 2;
  const rb = s * 0.34;
  c.globalAlpha = alpha;
  c.fillStyle = iceFill(c, s, 1.05);
  c.beginPath(); c.roundRect(-h, -h * 0.94, s, s * 0.94, rb); c.fill();
  const g = c.createRadialGradient(-s * 0.15, -s * 0.18, 2, 0, 0, s * 0.6);
  g.addColorStop(0, 'rgba(245, 252, 255, 0.4)');
  g.addColorStop(1, 'rgba(245, 252, 255, 0)');
  c.fillStyle = g;
  c.beginPath(); c.roundRect(-h, -h * 0.94, s, s * 0.94, rb); c.fill();
  c.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.arc(-s * 0.08, -s * 0.16, s * 0.3, Math.PI * 1.05, Math.PI * 1.6);
  c.stroke();
}

// type 3: irregular faceted chunk
function drawIceChunk(c, s, p, seed, t, soften, alpha) {
  const n = 7;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + seed;
    const rad = s * 0.5 * (0.78 + 0.24 * Math.sin(seed * 3 + i * 2.4));
    pts.push([Math.cos(ang) * rad, Math.sin(ang) * rad * 0.92]);
  }
  const round = 1 - Math.max(p, soften * 0.3);
  c.globalAlpha = alpha;
  c.fillStyle = iceFill(c, s, 1);
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (i === 0) c.moveTo(mx, my);
    else c.quadraticCurveTo(x1, y1, mx, my);
    if (i === n - 1) c.quadraticCurveTo(pts[0][0], pts[0][1], (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  }
  c.closePath();
  c.fill();
  // facet highlights
  c.strokeStyle = `rgba(255, 255, 255, ${0.3 * round})`;
  c.lineWidth = 0.9;
  c.beginPath();
  c.moveTo(pts[1][0] * 0.85, pts[1][1] * 0.85);
  c.lineTo(pts[4][0] * 0.3, pts[4][1] * 0.3);
  c.lineTo(pts[5][0] * 0.8, pts[5][1] * 0.8);
  c.stroke();
  c.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  c.beginPath();
  c.moveTo(pts[2][0] * 0.95, pts[2][1] * 0.95);
  c.lineTo(pts[3][0] * 0.95, pts[3][1] * 0.95);
  c.stroke();
}

const ICE_PAINTERS = [drawIceCube, drawIceBlock, drawIceTumbled, drawIceChunk];

function drawIce(c, cu, t, soften, waterY) {
  const s = cubeSize(cu);
  if (s < 2) return;
  const p = cu.meltP;
  const fade = p > 0.9 ? (1 - p) / 0.1 : 1;
  const depthScale = 1 - cu.z * 0.14;
  const dim = 1 - cu.z * 0.42;
  const yv = cu.y - cu.z * JAR_R * K * 0.9;
  const r = cubeR(cu);
  const sub = Math.min(1, Math.max(0, ((cu.y + r) - waterY) / (2 * r)));
  const wobble = sub > 0.4 ? Math.sin(t * 1.3 + cu.seed) * 0.05 : 0;

  c.save();
  c.translate(cu.x, yv);
  c.rotate(cu.rot + wobble);
  c.scale(depthScale, depthScale);
  ICE_PAINTERS[cu.type](c, s, p, cu.seed, t, soften, fade * dim);
  c.restore();
  c.globalAlpha = 1;
}

function draw(now) {
  const { w, h } = fitCanvas();
  ctx2d.clearRect(0, 0, w, h);
  const t = now / 1000;
  const dt = Math.min(0.05, lastFrameT ? t - lastFrameT : 1 / 60);
  lastFrameT = t;

  const m = state.status === 'idle' || state.status === 'done'
    ? { waterH: state.status === 'done' ? (sessionCubes() * CUBE * CUBE * WATER_FACTOR) / (JAR_R * 2) : 0, meltedFrac: state.status === 'done' ? 1 : 0 }
    : meltInfo();
  const waterY = FLOOR_Y - (m.waterH || 0);

  const melting = syncMelt();
  stepSim(dt, waterY, t, false);

  const scale = Math.min(w / SCENE_W, h / SCENE_H);
  const c = ctx2d;
  c.save();
  c.translate(w / 2, (h - SCENE_H * scale) / 2);
  c.scale(scale, scale);

  const R = JAR_R, ry = R * K;

  /* ---- glass back ---- */
  c.fillStyle = 'rgba(150, 190, 225, 0.05)';
  c.beginPath();
  c.moveTo(-R, RIM_Y);
  c.lineTo(-R, FLOOR_Y);
  c.ellipse(0, FLOOR_Y, R, ry, 0, Math.PI, 0, true);
  c.lineTo(R, RIM_Y);
  c.ellipse(0, RIM_Y, R, ry, 0, 0, Math.PI, false);
  c.closePath();
  c.fill();
  const backGrad = c.createLinearGradient(0, RIM_Y, 0, FLOOR_Y);
  backGrad.addColorStop(0, 'rgba(120, 165, 210, 0.07)');
  backGrad.addColorStop(1, 'rgba(60, 95, 140, 0.05)');
  c.fillStyle = backGrad;
  ellipse(c, 0, RIM_Y, R, ry);
  c.fill();

  /* ---- effects bookkeeping ---- */
  if (state.status === 'running' && melting) {
    if (t - lastDropletAt > 0.55 + Math.sin(t * 1.7) * 0.4) {
      lastDropletAt = t;
      const s = cubeSize(melting);
      droplets.push({ x: melting.x + (Math.random() - 0.5) * s * 0.5, y: melting.y + cubeR(melting) - 2, vy: 0 });
    }
    if (m.waterH > 14 && t - lastBubbleAt > 1.7) {
      lastBubbleAt = t;
      bubbles.push({ x: (Math.random() - 0.5) * R * 1.4, y: FLOOR_Y - 8, r: 1 + Math.random() * 1.8 });
    }
  }
  if (state.status === 'running') {
    for (let i = droplets.length - 1; i >= 0; i--) {
      const dp = droplets[i];
      dp.vy += 0.35;
      dp.y += dp.vy;
      const floor = Math.min(waterY, FLOOR_Y - 2);
      if (dp.y >= floor) {
        droplets.splice(i, 1);
        if (m.waterH > 3) {
          rings.push({ x: dp.x, start: t });
          if (Math.random() < 0.5) playDrip();
        }
      }
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.y -= 0.35 + b.r * 0.1;
      b.x += Math.sin(t * 2 + b.r * 7) * 0.15;
      if (b.y <= waterY + 4) bubbles.splice(i, 1);
    }
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    if (t - rings[i].start > 1.8) rings.splice(i, 1);
  }

  /* ---- ice (clipped to the jar), back cubes first ---- */
  c.save();
  c.beginPath();
  c.moveTo(-R, RIM_Y - 60);
  c.lineTo(-R, FLOOR_Y);
  c.ellipse(0, FLOOR_Y, R, ry, 0, Math.PI, 0, true);
  c.lineTo(R, RIM_Y - 60);
  c.closePath();
  c.clip();

  const soften = m.meltedFrac || 0;
  const ordered = [...simCubes].sort((a, b) => b.z - a.z);
  for (const cu of ordered) drawIce(c, cu, t, soften, waterY);

  c.fillStyle = 'rgba(200, 230, 250, 0.7)';
  for (const dp of droplets) {
    c.beginPath();
    c.ellipse(dp.x, dp.y, 1.6, 2.4, 0, 0, Math.PI * 2);
    c.fill();
  }

  /* ---- water (over cubes -> submerged parts get tinted) ---- */
  if ((m.waterH || 0) > 0.5) {
    const wg = c.createLinearGradient(0, waterY, 0, FLOOR_Y);
    wg.addColorStop(0, 'rgba(110, 175, 225, 0.36)');
    wg.addColorStop(1, 'rgba(45, 95, 155, 0.48)');
    c.fillStyle = wg;
    c.beginPath();
    c.moveTo(-R, waterY);
    c.lineTo(-R, FLOOR_Y);
    c.ellipse(0, FLOOR_Y, R, ry, 0, Math.PI, 0, true);
    c.lineTo(R, waterY);
    c.ellipse(0, waterY, R, ry, 0, 0, Math.PI, false);
    c.closePath();
    c.fill();

    const surfRy = ry * (1 + 0.045 * Math.sin(t * 1.2));
    c.fillStyle = 'rgba(160, 210, 240, 0.22)';
    ellipse(c, 0, waterY, R, surfRy);
    c.fill();
    c.strokeStyle = 'rgba(220, 245, 255, 0.5)';
    c.lineWidth = 1.2;
    ellipse(c, 0, waterY, R, surfRy);
    c.stroke();
    c.strokeStyle = 'rgba(235, 250, 255, 0.35)';
    c.beginPath();
    c.ellipse(0, waterY, R * 0.97, surfRy * 0.9, 0, Math.PI * 1.1, Math.PI * 1.9);
    c.stroke();

    for (const rp of rings) {
      const age = t - rp.start;
      const f = age / 1.8;
      const rr = 6 + f * R * 0.8;
      c.strokeStyle = `rgba(220, 245, 255, ${0.4 * (1 - f)})`;
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(rp.x * (1 - f * 0.4), waterY, Math.min(rr, R - 2), Math.min(rr, R - 2) * K, 0, 0, Math.PI * 2);
      c.stroke();
    }

    c.save();
    c.globalAlpha = 0.05;
    c.fillStyle = '#cfeaff';
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * R * 0.55 + Math.sin(t * 0.3 + i * 2) * 12;
      c.beginPath();
      c.ellipse(bx, (waterY + FLOOR_Y) / 2, 16, Math.max(3, (m.waterH || 0) * 0.12), 0.1, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    c.strokeStyle = 'rgba(220, 245, 255, 0.4)';
    c.lineWidth = 0.7;
    for (const b of bubbles) {
      c.beginPath();
      c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      c.stroke();
    }
  }
  c.restore(); // jar clip

  /* ---- glass front ---- */
  c.strokeStyle = 'rgba(190, 220, 245, 0.5)';
  c.lineWidth = 2.2;
  c.beginPath(); c.moveTo(-R, RIM_Y); c.lineTo(-R, FLOOR_Y); c.stroke();
  c.beginPath(); c.moveTo(R, RIM_Y); c.lineTo(R, FLOOR_Y); c.stroke();
  c.strokeStyle = 'rgba(120, 160, 200, 0.22)';
  c.lineWidth = 5.5;
  c.beginPath(); c.moveTo(-R, RIM_Y); c.lineTo(-R, FLOOR_Y); c.stroke();
  c.beginPath(); c.moveTo(R, RIM_Y); c.lineTo(R, FLOOR_Y); c.stroke();
  c.strokeStyle = 'rgba(190, 220, 245, 0.55)';
  c.lineWidth = 2.2;
  c.beginPath();
  c.ellipse(0, FLOOR_Y, R, ry, 0, 0, Math.PI);
  c.stroke();
  c.strokeStyle = 'rgba(150, 195, 235, 0.3)';
  c.lineWidth = 4;
  c.beginPath();
  c.ellipse(0, FLOOR_Y + 5, R, ry, 0, 0.15, Math.PI - 0.15);
  c.stroke();
  c.strokeStyle = 'rgba(210, 235, 255, 0.55)';
  c.lineWidth = 1.8;
  ellipse(c, 0, RIM_Y, R, ry);
  c.stroke();
  c.strokeStyle = 'rgba(150, 195, 235, 0.25)';
  c.lineWidth = 4.5;
  ellipse(c, 0, RIM_Y, R + 3, ry + 1.5);
  c.stroke();

  c.fillStyle = 'rgba(255, 255, 255, 0.05)';
  c.beginPath();
  c.roundRect(-R + 10, RIM_Y + 36, 6, JAR_H * 0.5, 3);
  c.fill();
  c.beginPath();
  c.roundRect(R - 16, RIM_Y + 60, 3.5, JAR_H * 0.36, 2);
  c.fill();

  c.fillStyle = 'rgba(220, 240, 255, 0.13)';
  const crng = (() => { let a = 777; return () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; }; })();
  for (let i = 0; i < 26; i++) {
    const cx = (crng() * 2 - 1) * (R - 8);
    const cy = RIM_Y + 40 + crng() * (JAR_H - 70);
    c.beginPath();
    c.arc(cx, cy, 0.8 + crng() * 1.6, 0, Math.PI * 2);
    c.fill();
  }

  /* ---- lid ---- */
  const lidTarget = t < dropAnimUntil ? 1 : 0;
  lidLift += (lidTarget - lidLift) * 0.16;
  const ly = RIM_Y - 8 - lidLift * 36;
  c.save();
  c.translate(lidLift * 14, ly);
  c.rotate(-lidLift * 0.05);
  const LR = R + 9;
  const woodSide = c.createLinearGradient(-LR, 0, LR, 0);
  woodSide.addColorStop(0, '#7a5638');
  woodSide.addColorStop(0.5, '#a8794e');
  woodSide.addColorStop(1, '#6b4a30');
  c.fillStyle = woodSide;
  c.beginPath();
  c.moveTo(-LR, -10);
  c.lineTo(-LR, 0);
  c.ellipse(0, 0, LR, LR * K, 0, Math.PI, 0, true);
  c.lineTo(LR, -10);
  c.ellipse(0, -10, LR, LR * K, 0, 0, Math.PI, true);
  c.closePath();
  c.fill();
  const woodTop = c.createRadialGradient(-LR * 0.25, -10 - LR * K * 0.3, 4, 0, -10, LR);
  woodTop.addColorStop(0, '#c79a68');
  woodTop.addColorStop(0.65, '#a0714a');
  woodTop.addColorStop(1, '#7c5638');
  c.fillStyle = woodTop;
  ellipse(c, 0, -10, LR, LR * K);
  c.fill();
  c.strokeStyle = 'rgba(90, 60, 38, 0.35)';
  c.lineWidth = 0.8;
  for (const f of [0.72, 0.45]) {
    ellipse(c, 0, -10, LR * f, LR * K * f);
    c.stroke();
  }
  c.strokeStyle = 'rgba(222, 186, 120, 0.6)';
  c.lineWidth = 1.4;
  ellipse(c, 0, -10, LR * 0.94, LR * K * 0.94);
  c.stroke();
  const knobY = -10 - LR * K - 7;
  const knob = c.createRadialGradient(-2, knobY - 3, 1, 0, knobY, 9);
  knob.addColorStop(0, '#f4dfae');
  knob.addColorStop(0.6, '#caa15c');
  knob.addColorStop(1, '#8a6a34');
  c.fillStyle = knob;
  c.beginPath();
  c.arc(0, knobY, 7.5, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = woodTop;
  ellipse(c, 0, knobY + 7, 4.5, 2);
  c.fill();
  c.restore();

  c.restore(); // scene transform
}

/* ================= UI ================= */

const el = {
  body: document.body,
  timeDisplay: document.getElementById('timeDisplay'),
  cubeInfo: document.getElementById('cubeInfo'),
  doneMsg: document.getElementById('doneMsg'),
  addBtn: document.getElementById('addBtn'),
  removeBtn: document.getElementById('removeBtn'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  resetBtn: document.getElementById('resetBtn'),
  showTimeToggle: document.getElementById('showTimeToggle'),
  rainToggle: document.getElementById('rainToggle'),
  volumeSlider: document.getElementById('volumeSlider'),
  notifyToggle: document.getElementById('notifyToggle'),
};

function fmtTime(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const mnt = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(mnt).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function syncUI() {
  el.body.dataset.status = state.status;
  el.body.classList.toggle('hide-time', !prefs.showTime);
  el.doneMsg.hidden = state.status !== 'done';
  el.pauseBtn.textContent = state.status === 'paused' ? '再開する' : '❄ 冷凍庫に戻す';
  el.showTimeToggle.checked = prefs.showTime;
  el.rainToggle.checked = prefs.rain;
  el.volumeSlider.value = prefs.volume;
  el.notifyToggle.checked = prefs.notify;
  el.startBtn.disabled = prefs.cubes < 1;
  el.addBtn.disabled = prefs.cubes >= MAX_CUBES;
  el.removeBtn.disabled = prefs.cubes < 1;
  updateReadout();
}

function updateReadout() {
  if (state.status === 'idle') {
    el.timeDisplay.textContent = fmtTime(prefs.cubes * CUBE_MINUTES * 60000);
    el.cubeInfo.textContent = prefs.cubes > 0
      ? `氷 ${prefs.cubes}個 = ${prefs.cubes * CUBE_MINUTES}分`
      : '氷を入れてください';
    document.title = '氷が溶けるまで勉強する';
    return;
  }
  const remaining = Math.max(0, state.totalMs - elapsedMs());
  el.timeDisplay.textContent = fmtTime(remaining);
  if (state.status === 'done') {
    el.cubeInfo.textContent = 'ぜんぶ溶けました';
    document.title = '✅ 氷が溶けるまで勉強する';
  } else {
    el.cubeInfo.textContent = `のこり 氷${meltInfo().cubesLeft}個`;
    const mark = state.status === 'paused' ? '⏸ ' : '';
    document.title = prefs.showTime
      ? `${mark}${fmtTime(remaining)} | 氷が溶けるまで`
      : `${mark}氷が溶けるまで勉強する`;
  }
}

function addCube() {
  if (state.status !== 'idle' || prefs.cubes >= MAX_CUBES) return;
  ensureAudioCtx();
  prefs.cubes++;
  spawnCube(true);
  dropAnimUntil = performance.now() / 1000 + 0.7;
  save();
  syncUI();
}

function removeCube() {
  if (state.status !== 'idle' || prefs.cubes < 1) return;
  prefs.cubes--;
  removeTopmost();
  save();
  syncUI();
}

el.addBtn.addEventListener('click', addCube);
el.removeBtn.addEventListener('click', removeCube);
canvas.addEventListener('click', () => { if (state.status === 'idle') addCube(); });

el.startBtn.addEventListener('click', () => {
  ensureAudioCtx();
  if (prefs.rain) setRain(true);
  startSession();
});

el.pauseBtn.addEventListener('click', () => {
  if (state.status === 'paused') resumeSession();
  else pauseSession();
});

el.resetBtn.addEventListener('click', resetSession);

el.showTimeToggle.addEventListener('change', () => {
  prefs.showTime = el.showTimeToggle.checked;
  save();
  syncUI();
});

el.rainToggle.addEventListener('change', () => {
  prefs.rain = el.rainToggle.checked;
  setRain(prefs.rain);
  save();
});

el.volumeSlider.addEventListener('input', () => {
  prefs.volume = Number(el.volumeSlider.value);
  if (audio.master) audio.master.gain.value = prefs.volume;
  save();
});

el.notifyToggle.addEventListener('change', () => {
  prefs.notify = el.notifyToggle.checked;
  if (prefs.notify && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  save();
});

/* ================= LOOPS ================= */

function frame(now) {
  if (state.status === 'running' && elapsedMs() >= state.totalMs) {
    completeSession(false);
  }
  draw(now);
  if (state.status === 'running') updateReadout();
  requestAnimationFrame(frame);
}

setInterval(() => {
  if (state.status === 'running') {
    if (elapsedMs() >= state.totalMs) completeSession(false);
    else updateReadout();
    save();
  }
}, 1000);

document.addEventListener('visibilitychange', save);
window.addEventListener('pagehide', save);

/* ================= INIT ================= */

restore();
rebuildSim();
syncUI();
if (prefs.rain && state.status === 'running') {
  const resumeRain = () => { setRain(true); document.removeEventListener('click', resumeRain); };
  document.addEventListener('click', resumeRain);
}
requestAnimationFrame(frame);

// expose internals for console spot-checks
window.iceStudy = { meltInfo, simCubes: () => simCubes, CUBE_MINUTES, MAX_CUBES };

})();
