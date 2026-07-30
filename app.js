'use strict';
(() => {

/* ================= CONFIG ================= */

const CUBE = 44;            // logical cube size (scene units)
const GAP = 6;
const PAD = 16;             // inner padding between cube pile and glass wall
const DENSITY = 0.92;       // ice -> water volume factor
const CUBE_MINUTES = 5;
const MAX_CUBES = 48;       // 4 hours
const STORAGE_KEY = 'iceStudy.v1';

// debug: ?speed=60 makes time run 60x faster
const speed = (() => {
  const v = parseFloat(new URLSearchParams(location.search).get('speed'));
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

/* ================= PURE MODEL ================= */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cubeCountFor(minutes) {
  return Math.max(1, Math.min(MAX_CUBES, Math.ceil(minutes / CUBE_MINUTES)));
}

// Jar geometry + cube placement for N cubes. Scene coords: (0,0) = inner
// top-left of the glass, y grows downward, jar floor at y = innerH.
function layoutJar(N) {
  const cols = Math.ceil(Math.sqrt(N * 1.4));
  const rows = Math.ceil(N / cols);
  const cell = CUBE + GAP;
  const innerW = cols * cell - GAP + PAD * 2;
  const pileH = rows * cell - GAP;
  const waterFullH = (N * CUBE * CUBE * DENSITY) / innerW;
  const innerH = Math.max(pileH, waterFullH) + CUBE * 0.9; // headroom above pile

  const rng = mulberry32(N * 2654435761);
  const cubes = [];
  let remaining = N;
  for (let r = 0; r < rows; r++) {           // r = 0 is the bottom row
    const inRow = Math.min(cols, remaining);
    remaining -= inRow;
    const rowW = inRow * cell - GAP;
    const x0 = (innerW - rowW) / 2;
    for (let c = 0; c < inRow; c++) {
      cubes.push({
        row: r,
        x: x0 + c * cell,
        yBottom: innerH - r * cell,
        seed: rng() * Math.PI * 2,
        order: 0,
      });
    }
  }

  // Melt order: top row first (nothing ever has to fall), shuffled within a row.
  const byRow = new Map();
  cubes.forEach((cu, i) => {
    if (!byRow.has(cu.row)) byRow.set(cu.row, []);
    byRow.get(cu.row).push(i);
  });
  let order = 0;
  [...byRow.keys()].sort((a, b) => b - a).forEach(row => {
    const idxs = byRow.get(row);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    idxs.forEach(i => { cubes[i].order = order++; });
  });

  // static condensation droplets on the outside of the glass
  const conden = [];
  for (let i = 0; i < 22; i++) {
    conden.push({ x: rng() * innerW, y: innerH * (0.25 + rng() * 0.7), r: 0.8 + rng() * 1.6 });
  }

  return { N, cols, rows, innerW, innerH, waterFullH, cubes, conden };
}

// Melt progress for every cube at a given elapsed time.
function meltState(elapsedMs, totalMs, layout) {
  const { N, innerW, cubes } = layout;
  const cubeMs = totalMs / N;
  const p = cubes.map(cu =>
    Math.min(1, Math.max(0, (elapsedMs - cu.order * cubeMs) / cubeMs)));
  const meltedFrac = Math.min(1, Math.max(0, elapsedMs / totalMs));
  const waterH = (N * CUBE * CUBE * DENSITY * meltedFrac) / innerW;
  let activeIdx = -1;
  cubes.forEach((cu, i) => { if (p[i] > 0 && p[i] < 1) activeIdx = i; });
  const cubesLeft = p.filter(v => v < 1).length;
  return { p, meltedFrac, waterH, activeIdx, cubesLeft };
}

/* ================= TIMER / STATE ================= */

let state = {
  status: 'idle',        // idle | running | paused | done
  totalMs: 0,
  bankedMs: 0,           // effective elapsed ms accumulated up to lastResumeEpoch
  lastResumeEpoch: 0,
};

let prefs = {
  minutes: 25,
  showTime: true,
  rain: false,
  volume: 0.5,
  notify: false,
};

let layout = null;

function elapsedMs() {
  if (state.status === 'running') {
    return state.bankedMs + (Date.now() - state.lastResumeEpoch) * speed;
  }
  return state.bankedMs;
}

function startSession(minutes) {
  state = {
    status: 'running',
    totalMs: minutes * 60000,
    bankedMs: 0,
    lastResumeEpoch: Date.now(),
  };
  layout = layoutJar(cubeCountFor(minutes));
  particles.length = 0;
  bubbles.length = 0;
  ripples.length = 0;
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
  layout = null;
  particles.length = 0;
  bubbles.length = 0;
  ripples.length = 0;
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
    layout = layoutJar(cubeCountFor(state.totalMs / 60000));
    // real ice keeps melting while the tab is closed
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
    // looped white noise through a lowpass = soft rain
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

    // slow LFO on the filter so the rain "moves"
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

function playDrip() {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1400, t);
  osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  const delay = ctx.createDelay();
  delay.delayTime.value = 0.16;
  const fb = ctx.createGain();
  fb.gain.value = 0.25;
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  osc.connect(g);
  g.connect(audio.master);
  g.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(audio.master);
  osc.start(t);
  osc.stop(t + 0.35);
}

function playChime() {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const notes = [659.25, 880, 1046.5]; // E5 A5 C6 — soft pentatonic bell
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

/* ================= RENDER ================= */

const canvas = document.getElementById('scene');
const ctx2d = canvas.getContext('2d');

const particles = [];  // falling droplets {x, y, vy}   (scene coords)
const bubbles = [];    // rising bubbles  {x, y, r, vx}
const ripples = [];    // surface ripples {x, start}

let lastDropletAt = 0;
let lastBubbleAt = 0;

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

function jarInnerPath(c, lay) {
  const r = 18; // rounded floor corners
  c.beginPath();
  c.moveTo(0, -4);
  c.lineTo(0, lay.innerH - r);
  c.quadraticCurveTo(0, lay.innerH, r, lay.innerH);
  c.lineTo(lay.innerW - r, lay.innerH);
  c.quadraticCurveTo(lay.innerW, lay.innerH, lay.innerW, lay.innerH - r);
  c.lineTo(lay.innerW, -4);
}

function surfaceY(x, lay, waterH, t) {
  let y = lay.innerH - waterH;
  y += Math.sin(x * 0.05 + t * 1.3) * 1.2 + Math.sin(x * 0.11 - t * 0.9) * 0.7;
  for (const rp of ripples) {
    const age = t - rp.start;
    if (age < 0 || age > 2.2) continue;
    const d = (x - rp.x) / 26;
    y += 3.2 * Math.exp(-age * 2.4) * Math.exp(-d * d) * Math.cos(d * 4 - age * 9);
  }
  return y;
}

function drawCube(c, cu, p, t, softenAll) {
  if (p >= 1) return;
  const s = CUBE * Math.sqrt(1 - p);       // visual area matches melted volume
  if (s < 2) return;
  const cx = cu.x + CUBE / 2;
  const x = cx - s / 2;
  const y = cu.yBottom - s;

  const fade = p > 0.92 ? (1 - p) / 0.08 : 1;
  // corners round out as the cube melts; softenAll gives untouched cubes
  // a slow cosmetic rounding over the whole session
  const roundness = Math.max(p, softenAll * 0.4);
  const rb = s * (0.12 + 0.38 * roundness);
  const wob = (ph) => Math.max(1, Math.min(s / 2, rb * (1 + 0.35 * Math.sin(t * 0.5 + cu.seed + ph))));
  const radii = [wob(0), wob(1.7), wob(3.1), wob(4.6)];

  c.save();
  c.globalAlpha = fade;

  // body: translucent pale blue-white
  const grad = c.createLinearGradient(x, y, x + s, y + s);
  grad.addColorStop(0, 'rgba(210, 235, 250, 0.42)');
  grad.addColorStop(0.5, 'rgba(160, 205, 235, 0.30)');
  grad.addColorStop(1, 'rgba(120, 170, 215, 0.34)');
  c.fillStyle = grad;
  c.beginPath();
  c.roundRect(x, y, s, s, radii);
  c.fill();

  // brighter inner core
  c.fillStyle = 'rgba(235, 248, 255, 0.20)';
  c.beginPath();
  c.roundRect(x + s * 0.18, y + s * 0.18, s * 0.64, s * 0.64, rb * 0.8);
  c.fill();

  // specular on the top-left edge
  c.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  c.lineWidth = 1.4;
  c.beginPath();
  c.moveTo(x + radii[0] * 0.8, y + 1.2);
  c.lineTo(x + s * 0.62, y + 1.2);
  c.stroke();
  c.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  c.beginPath();
  c.moveTo(x + 1.2, y + radii[0] * 0.8);
  c.lineTo(x + 1.2, y + s * 0.55);
  c.stroke();

  // faint internal cracks (seeded, fixed per cube)
  c.strokeStyle = 'rgba(255, 255, 255, 0.13)';
  c.lineWidth = 0.8;
  const k = cu.seed;
  c.beginPath();
  c.moveTo(x + s * (0.25 + 0.1 * Math.sin(k)), y + s * 0.3);
  c.lineTo(x + s * (0.55 + 0.1 * Math.cos(k * 2)), y + s * 0.62);
  c.moveTo(x + s * 0.7, y + s * (0.2 + 0.1 * Math.sin(k * 3)));
  c.lineTo(x + s * 0.5, y + s * 0.5);
  c.stroke();

  c.restore();
}

function draw(now) {
  const { w, h } = fitCanvas();
  ctx2d.clearRect(0, 0, w, h);

  const t = now / 1000;
  const isIdle = state.status === 'idle';
  const lay = isIdle ? previewLayout() : layout;
  if (!lay) return;

  const elapsed = isIdle ? 0 : Math.min(elapsedMs(), state.totalMs);
  const melt = isIdle
    ? { p: lay.cubes.map(() => 0), meltedFrac: 0, waterH: 0, activeIdx: -1, cubesLeft: lay.N }
    : meltState(elapsed, state.totalMs, lay);

  // fit the jar into the canvas
  const wall = 9;
  const sceneW = lay.innerW + wall * 2 + 30;
  const sceneH = lay.innerH + wall + 50;
  const scale = Math.min((w * 0.86) / sceneW, (h * 0.74) / sceneH);
  const ox = (w - lay.innerW * scale) / 2;
  const oy = h * 0.86 - lay.innerH * scale;

  const c = ctx2d;
  c.save();
  c.translate(ox, oy);
  c.scale(scale, scale);

  // ---- glass back ----
  c.save();
  jarInnerPath(c, lay);
  c.lineTo(lay.innerW, -4);
  c.closePath();
  c.fillStyle = 'rgba(150, 190, 225, 0.045)';
  c.fill();
  c.restore();

  // ---- spawn/advance effects (running only) ----
  const active = melt.activeIdx >= 0 ? lay.cubes[melt.activeIdx] : null;
  if (state.status === 'running' && active) {
    if (t - lastDropletAt > 0.5 + Math.sin(t * 1.7) * 0.4) {
      lastDropletAt = t;
      const s = CUBE * Math.sqrt(1 - melt.p[melt.activeIdx]);
      particles.push({ x: active.x + CUBE / 2 + (Math.random() - 0.5) * s * 0.7, y: active.yBottom - 2, vy: 0 });
    }
  }
  if (state.status === 'running' && melt.waterH > 12 && t - lastBubbleAt > 1.6) {
    lastBubbleAt = t;
    bubbles.push({ x: lay.innerW * (0.15 + Math.random() * 0.7), y: lay.innerH - 4, r: 1 + Math.random() * 1.8, vx: (Math.random() - 0.5) * 3 });
  }

  const waterTopFlat = lay.innerH - melt.waterH;

  if (state.status === 'running') {
    for (let i = particles.length - 1; i >= 0; i--) {
      const dp = particles[i];
      dp.vy += 0.35;
      dp.y += dp.vy;
      const floor = Math.min(waterTopFlat, lay.innerH - 1.5);
      if (dp.y >= floor) {
        particles.splice(i, 1);
        if (melt.waterH > 3) {
          ripples.push({ x: dp.x, start: t });
          if (Math.random() < 0.5) playDrip();
        }
      }
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.y -= 0.35 + b.r * 0.1;
      b.x += Math.sin(t * 2 + b.r * 7) * 0.15 + b.vx * 0.01;
      if (b.y <= waterTopFlat + 3) bubbles.splice(i, 1);
    }
  }
  for (let i = ripples.length - 1; i >= 0; i--) {
    if (t - ripples[i].start > 2.2) ripples.splice(i, 1);
  }

  // ---- ice cubes ----
  c.save();
  jarInnerPath(c, lay);
  c.clip();
  const softenAll = melt.meltedFrac;
  lay.cubes.forEach((cu, i) => drawCube(c, cu, melt.p[i], t, softenAll));

  // falling droplets
  c.fillStyle = 'rgba(200, 230, 250, 0.7)';
  for (const dp of particles) {
    c.beginPath();
    c.ellipse(dp.x, dp.y, 1.6, 2.4, 0, 0, Math.PI * 2);
    c.fill();
  }

  // ---- water (drawn over cubes -> submerged parts get tinted) ----
  if (melt.waterH > 0.5) {
    c.beginPath();
    c.moveTo(0, surfaceY(0, lay, melt.waterH, t));
    for (let x = 4; x <= lay.innerW; x += 4) {
      c.lineTo(x, surfaceY(x, lay, melt.waterH, t));
    }
    c.lineTo(lay.innerW, lay.innerH);
    c.lineTo(0, lay.innerH);
    c.closePath();
    const wg = c.createLinearGradient(0, waterTopFlat, 0, lay.innerH);
    wg.addColorStop(0, 'rgba(110, 175, 225, 0.34)');
    wg.addColorStop(1, 'rgba(50, 100, 160, 0.44)');
    c.fillStyle = wg;
    c.fill();

    // meniscus highlight along the surface
    c.beginPath();
    c.moveTo(0, surfaceY(0, lay, melt.waterH, t));
    for (let x = 4; x <= lay.innerW; x += 4) {
      c.lineTo(x, surfaceY(x, lay, melt.waterH, t));
    }
    c.strokeStyle = 'rgba(220, 245, 255, 0.5)';
    c.lineWidth = 1.2;
    c.stroke();

    // slow caustic light bands in the water
    c.save();
    c.globalAlpha = 0.04;
    c.fillStyle = '#cfeaff';
    for (let i = 0; i < 3; i++) {
      const bx = lay.innerW * (0.2 + 0.3 * i) + Math.sin(t * 0.3 + i * 2) * 12;
      c.beginPath();
      c.ellipse(bx, (waterTopFlat + lay.innerH) / 2, 16, Math.max(2.5, melt.waterH * 0.14), 0.12, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // bubbles
    c.strokeStyle = 'rgba(220, 245, 255, 0.4)';
    c.lineWidth = 0.7;
    for (const b of bubbles) {
      c.beginPath();
      c.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      c.stroke();
    }
  }
  c.restore(); // jar clip

  // ---- glass front ----
  c.save();
  jarInnerPath(c, lay);
  c.strokeStyle = 'rgba(190, 220, 245, 0.5)';
  c.lineWidth = 2.4;
  c.stroke();
  jarInnerPath(c, lay);
  c.strokeStyle = 'rgba(120, 160, 200, 0.25)';
  c.lineWidth = 6;
  c.stroke();

  // rim
  c.beginPath();
  c.ellipse(lay.innerW / 2, -4, lay.innerW / 2 + 3, 5, 0, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(210, 235, 255, 0.45)';
  c.lineWidth = 1.6;
  c.stroke();

  // vertical specular streaks
  c.fillStyle = 'rgba(255, 255, 255, 0.045)';
  c.beginPath();
  c.roundRect(lay.innerW * 0.07, lay.innerH * 0.1, 5, lay.innerH * 0.5, 2.5);
  c.fill();
  c.beginPath();
  c.roundRect(lay.innerW * 0.9, lay.innerH * 0.16, 3, lay.innerH * 0.38, 1.5);
  c.fill();

  // condensation
  c.fillStyle = 'rgba(220, 240, 255, 0.14)';
  for (const d of lay.conden) {
    c.beginPath();
    c.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();

  c.restore(); // scene transform
}

let previewCache = { minutes: -1, layout: null };
function previewLayout() {
  if (previewCache.minutes !== prefs.minutes) {
    previewCache = { minutes: prefs.minutes, layout: layoutJar(cubeCountFor(prefs.minutes)) };
  }
  return previewCache.layout;
}

/* ================= UI ================= */

const el = {
  body: document.body,
  timeDisplay: document.getElementById('timeDisplay'),
  cubeInfo: document.getElementById('cubeInfo'),
  doneMsg: document.getElementById('doneMsg'),
  presets: document.getElementById('presets'),
  customMin: document.getElementById('customMin'),
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
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
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
  [...el.presets.children].forEach(b =>
    b.classList.toggle('selected', Number(b.dataset.min) === prefs.minutes));
  updateReadout();
}

function updateReadout() {
  if (state.status === 'idle') {
    el.timeDisplay.textContent = fmtTime(prefs.minutes * 60000);
    el.cubeInfo.textContent = `氷 ${cubeCountFor(prefs.minutes)}個(${prefs.minutes}分)`;
    document.title = '氷が溶けるまで勉強する';
    return;
  }
  const remaining = Math.max(0, state.totalMs - elapsedMs());
  el.timeDisplay.textContent = fmtTime(remaining);
  if (state.status === 'done') {
    el.cubeInfo.textContent = 'ぜんぶ溶けました';
    document.title = '✅ 氷が溶けるまで勉強する';
  } else {
    const melt = meltState(Math.min(elapsedMs(), state.totalMs), state.totalMs, layout);
    el.cubeInfo.textContent = `のこり 氷${melt.cubesLeft}個`;
    const mark = state.status === 'paused' ? '⏸ ' : '';
    document.title = prefs.showTime
      ? `${mark}${fmtTime(remaining)} | 氷が溶けるまで`
      : `${mark}氷が溶けるまで勉強する`;
  }
}

el.presets.addEventListener('click', e => {
  const btn = e.target.closest('button[data-min]');
  if (!btn) return;
  prefs.minutes = Number(btn.dataset.min);
  el.customMin.value = '';
  save();
  syncUI();
});

el.customMin.addEventListener('input', () => {
  const v = Number(el.customMin.value);
  if (Number.isFinite(v) && v >= 1) {
    prefs.minutes = Math.min(240, Math.floor(v));
    save();
    syncUI();
  }
});

el.startBtn.addEventListener('click', () => {
  ensureAudioCtx();               // user gesture: unlock audio
  if (prefs.rain) setRain(true);
  startSession(prefs.minutes);
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

// 1s heartbeat: catches completion while the tab is hidden (rAF is asleep)
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
if (prefs.minutes && !new Set([15, 25, 30, 45, 60, 90, 120]).has(prefs.minutes)) {
  el.customMin.value = prefs.minutes;
}
syncUI();
if (prefs.rain && state.status === 'running') {
  // browsers block audio before a gesture; rain resumes on the next click
  const resumeRain = () => { setRain(true); document.removeEventListener('click', resumeRain); };
  document.addEventListener('click', resumeRain);
}
requestAnimationFrame(frame);

// expose pure functions for console spot-checks
window.iceStudy = { layoutJar, meltState, cubeCountFor };

})();
