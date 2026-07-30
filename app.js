'use strict';
(() => {

/* ================= CONFIG ================= */

const CUBE = 46;             // front-layer cube size (scene units)
const CELL = CUBE + 8;
const COLS = 3, PER_LEVEL = 6;   // 3 columns x 2 depth layers per level
const MAX_CUBES = 24;        // jar capacity (2 hours)
const CUBE_MINUTES = 5;
const K = 0.24;              // ellipse squash: viewed slightly from above
const DENSITY = 0.9;         // floating ice: fraction of pile below waterline
const WATER_FACTOR = 0.55;   // melted cube area -> water height scaling
const STORAGE_KEY = 'iceStudy.v2';

// jar geometry (scene units, y grows downward, x centered on 0)
const JAR_R = (COLS * CELL + 28) / 2;   // inner radius
const JAR_H = 342;                       // rim to floor
const RIM_Y = 96;                        // leaves room above for lid lift + drops
const FLOOR_Y = RIM_Y + JAR_H;
const SCENE_W = JAR_R * 2 + 90;
const SCENE_H = FLOOR_Y + JAR_R * K + 34;

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

// slot(i): cubes fill bottom-up, front row first within each level
function slotOf(i) {
  const level = Math.floor(i / PER_LEVEL);
  const k = i % PER_LEVEL;
  return { level, depth: k < COLS ? 0 : 1, col: k % COLS };
}

// Melt progress per cube. Last-added melts first (top of the pile),
// so remaining cubes never change slots.
function meltState(elapsedMs, totalMs, N) {
  const cubeMs = totalMs / N;
  const p = [];
  for (let i = 0; i < N; i++) {
    p.push(Math.min(1, Math.max(0, (elapsedMs - (N - 1 - i) * cubeMs) / cubeMs)));
  }
  const meltedFrac = Math.min(1, Math.max(0, elapsedMs / totalMs));
  const waterH = (N * CUBE * CUBE * WATER_FACTOR * meltedFrac) / (JAR_R * 2);
  let activeIdx = -1;
  for (let i = 0; i < N; i++) if (p[i] > 0 && p[i] < 1) activeIdx = i;
  const cubesLeft = p.filter(v => v < 1).length;
  return { p, meltedFrac, waterH, activeIdx, cubesLeft };
}

/* ================= TIMER / STATE ================= */

let state = {
  status: 'idle',        // idle | running | paused | done
  totalMs: 0,
  bankedMs: 0,
  lastResumeEpoch: 0,
};

let prefs = {
  cubes: 5,              // idle selection: number of cubes in the jar
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

const droplets = [];  // {x, y, vy}  falling melt drops
const bubbles = [];   // {x, y, r}   rising in the water
const rings = [];     // {x, start, big}  surface ripple rings
let dropAnim = null;  // {idx, start}  cube being dropped into the jar
let lidLift = 0;
let seeds = [];       // per-cube random phase

function clearEffects() {
  droplets.length = 0;
  bubbles.length = 0;
  rings.length = 0;
  dropAnim = null;
}

function seedFor(i) {
  while (seeds.length <= i) {
    const rng = mulberry32((seeds.length + 1) * 2654435761);
    seeds.push(rng() * Math.PI * 2);
  }
  return seeds[i];
}

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

function ellipse(c, x, y, rx, ry) {
  c.beginPath();
  c.ellipse(x, y, rx, Math.max(0.1, ry), 0, 0, Math.PI * 2);
}

// pseudo-3D ice cube: front face + top face, melting into a rounded blob
function drawCube3D(c, bx, by, s, p, seed, t, soften, dim) {
  if (p >= 1 || s < 2) return;
  const fade = (p > 0.9 ? (1 - p) / 0.1 : 1) * dim;
  const x0 = bx - s / 2;
  const yTop = by - s;
  const round = Math.max(p, soften * 0.35);
  const rb = s * (0.12 + 0.42 * round);
  const wob = (ph) => Math.max(1, Math.min(s / 2, rb * (1 + 0.3 * Math.sin(t * 0.5 + seed + ph))));
  const radii = [wob(0), wob(1.7), wob(3.1), wob(4.6)];

  c.save();
  c.globalAlpha = fade;

  // top face (fades away as the cube melts round)
  const d = s * 0.3;
  c.globalAlpha = fade * (1 - p) * 0.9;
  c.fillStyle = 'rgba(235, 250, 255, 0.55)';
  c.beginPath();
  c.moveTo(x0 + radii[0] * 0.4, yTop);
  c.lineTo(x0 + s - radii[1] * 0.4, yTop);
  c.lineTo(x0 + s - radii[1] * 0.4 - s * 0.08, yTop - d);
  c.lineTo(x0 + radii[0] * 0.4 + s * 0.16, yTop - d);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = 0.8;
  c.stroke();
  c.globalAlpha = fade;

  // front face
  const grad = c.createLinearGradient(x0, yTop, x0 + s, by);
  grad.addColorStop(0, 'rgba(212, 236, 252, 0.5)');
  grad.addColorStop(0.55, 'rgba(160, 205, 235, 0.36)');
  grad.addColorStop(1, 'rgba(115, 165, 210, 0.4)');
  c.fillStyle = grad;
  c.beginPath();
  c.roundRect(x0, yTop, s, s, radii);
  c.fill();

  // right-side shading for depth
  const sideGrad = c.createLinearGradient(x0 + s * 0.7, 0, x0 + s, 0);
  sideGrad.addColorStop(0, 'rgba(80, 120, 165, 0)');
  sideGrad.addColorStop(1, `rgba(80, 120, 165, ${0.28 * (1 - p)})`);
  c.fillStyle = sideGrad;
  c.beginPath();
  c.roundRect(x0, yTop, s, s, radii);
  c.fill();

  // inner bright core
  c.fillStyle = 'rgba(238, 250, 255, 0.18)';
  c.beginPath();
  c.roundRect(x0 + s * 0.18, yTop + s * 0.18, s * 0.64, s * 0.64, rb * 0.8);
  c.fill();

  // specular on the top edge
  c.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  c.lineWidth = 1.3;
  c.beginPath();
  c.moveTo(x0 + radii[0] * 0.8, yTop + 1.2);
  c.lineTo(x0 + s * 0.6, yTop + 1.2);
  c.stroke();

  // faint cracks
  c.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(x0 + s * (0.25 + 0.1 * Math.sin(seed)), yTop + s * 0.32);
  c.lineTo(x0 + s * (0.55 + 0.1 * Math.cos(seed * 2)), yTop + s * 0.64);
  c.moveTo(x0 + s * 0.7, yTop + s * (0.2 + 0.1 * Math.sin(seed * 3)));
  c.lineTo(x0 + s * 0.5, yTop + s * 0.52);
  c.stroke();

  c.restore();
}

function draw(now) {
  const { w, h } = fitCanvas();
  ctx2d.clearRect(0, 0, w, h);
  const t = now / 1000;

  const isIdle = state.status === 'idle';
  const N = isIdle ? prefs.cubes : sessionCubes();
  const melt = isIdle || N === 0
    ? { p: new Array(N).fill(0), meltedFrac: 0, waterH: 0, activeIdx: -1, cubesLeft: N }
    : meltState(Math.min(elapsedMs(), state.totalMs), state.totalMs, N);

  const scale = Math.min(w / SCENE_W, h / SCENE_H);
  const c = ctx2d;
  c.save();
  c.translate(w / 2, (h - SCENE_H * scale) / 2);
  c.scale(scale, scale);
  // scene: x centered on 0, y from 0 (top)

  const R = JAR_R, ry = R * K;
  const waterY = FLOOR_Y - melt.waterH;

  /* ---- buoyant pile: rests on the floor until the water lifts it ---- */
  const levelsLeft = Math.ceil(Math.max(melt.cubesLeft, dropAnim ? 1 : 0) / PER_LEVEL);
  const pileH = levelsLeft * CELL;
  let pileBottom = FLOOR_Y - 3;
  let floating = false;
  if (melt.waterH > 2 && melt.cubesLeft > 0) {
    const buoyant = waterY + DENSITY * pileH;
    if (buoyant < pileBottom) {
      pileBottom = buoyant;
      floating = true;
    }
  }
  if (floating) {
    pileBottom += Math.sin(t * 1.1) * 2 + Math.sin(t * 0.63 + 1.7) * 1.2;
    pileBottom = Math.min(pileBottom, FLOOR_Y - 3);
  }

  const cubeBottomY = (i) => {
    const { level } = slotOf(i);
    return pileBottom - level * CELL;
  };
  const cubeX = (i) => {
    const { depth, col } = slotOf(i);
    const jitter = Math.sin(seedFor(i) * 5) * 3;
    return (col - 1) * CELL + jitter + (depth ? 4 : 0);
  };

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
  // back inner wall sheen
  const backGrad = c.createLinearGradient(0, RIM_Y, 0, FLOOR_Y);
  backGrad.addColorStop(0, 'rgba(120, 165, 210, 0.07)');
  backGrad.addColorStop(1, 'rgba(60, 95, 140, 0.05)');
  c.fillStyle = backGrad;
  ellipse(c, 0, RIM_Y, R, ry);
  c.fill();

  /* ---- spawn/advance effects ---- */
  const active = melt.activeIdx >= 0 ? melt.activeIdx : -1;
  if (state.status === 'running' && active >= 0) {
    if (t - lastDropletAt > 0.55 + Math.sin(t * 1.7) * 0.4) {
      lastDropletAt = t;
      const s = CUBE * Math.sqrt(1 - melt.p[active]);
      droplets.push({ x: cubeX(active) + (Math.random() - 0.5) * s * 0.6, y: cubeBottomY(active) - 2, vy: 0 });
    }
    if (melt.waterH > 14 && t - lastBubbleAt > 1.7) {
      lastBubbleAt = t;
      bubbles.push({ x: (Math.random() - 0.5) * R * 1.4, y: FLOOR_Y - 6, r: 1 + Math.random() * 1.8 });
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
        if (melt.waterH > 3) {
          rings.push({ x: dp.x, start: t, big: false });
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

  /* ---- ice cubes (clipped to the jar) ---- */
  c.save();
  c.beginPath();
  c.moveTo(-R, RIM_Y - 40);
  c.lineTo(-R, FLOOR_Y);
  c.ellipse(0, FLOOR_Y, R, ry, 0, Math.PI, 0, true);
  c.lineTo(R, RIM_Y - 40);
  c.closePath();
  c.clip();

  const soften = melt.meltedFrac;
  // back depth layer first, then front
  for (const depth of [1, 0]) {
    for (let i = 0; i < N; i++) {
      const slot = slotOf(i);
      if (slot.depth !== depth) continue;
      let by = cubeBottomY(i);
      let sMul = 1;
      // drop-in animation for the newest cube
      if (dropAnim && dropAnim.idx === i) {
        const age = t - dropAnim.start;
        if (age < 0.5) {
          const f = age / 0.5;
          by = (RIM_Y - 130) + (by - (RIM_Y - 130)) * f * f;   // gravity fall
        } else if (age < 1.1) {
          by -= 10 * Math.exp(-(age - 0.5) * 7) * Math.abs(Math.sin((age - 0.5) * 16));
        } else {
          dropAnim = null;
        }
      }
      const s = CUBE * Math.sqrt(1 - melt.p[i]) * (depth ? 0.86 : 1);
      const depthUp = depth ? ry * 0.75 : 0;
      drawCube3D(c, cubeX(i), by - depthUp, s * sMul, melt.p[i], seedFor(i), t, soften, depth ? 0.62 : 1);
    }
  }

  // falling melt droplets
  c.fillStyle = 'rgba(200, 230, 250, 0.7)';
  for (const dp of droplets) {
    c.beginPath();
    c.ellipse(dp.x, dp.y, 1.6, 2.4, 0, 0, Math.PI * 2);
    c.fill();
  }

  /* ---- water (over cubes -> submerged parts get tinted) ---- */
  if (melt.waterH > 0.5) {
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

    // water surface ellipse, gently breathing
    const surfRy = ry * (1 + 0.045 * Math.sin(t * 1.2));
    c.fillStyle = 'rgba(160, 210, 240, 0.22)';
    ellipse(c, 0, waterY, R, surfRy);
    c.fill();
    c.strokeStyle = 'rgba(220, 245, 255, 0.5)';
    c.lineWidth = 1.2;
    ellipse(c, 0, waterY, R, surfRy);
    c.stroke();
    // brighter back arc of the surface (light from above)
    c.strokeStyle = 'rgba(235, 250, 255, 0.35)';
    c.beginPath();
    c.ellipse(0, waterY, R * 0.97, surfRy * 0.9, 0, Math.PI * 1.1, Math.PI * 1.9);
    c.stroke();

    // ripple rings on the surface
    for (const rp of rings) {
      const age = t - rp.start;
      const f = age / 1.8;
      const rr = (rp.big ? 14 : 6) + f * R * 0.8;
      c.strokeStyle = `rgba(220, 245, 255, ${0.4 * (1 - f)})`;
      c.lineWidth = 1;
      c.beginPath();
      c.ellipse(rp.x * (1 - f * 0.4), waterY, Math.min(rr, R - 2), Math.min(rr, R - 2) * K, 0, 0, Math.PI * 2);
      c.stroke();
    }

    // soft caustic blobs in the body
    c.save();
    c.globalAlpha = 0.05;
    c.fillStyle = '#cfeaff';
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * R * 0.55 + Math.sin(t * 0.3 + i * 2) * 12;
      c.beginPath();
      c.ellipse(bx, (waterY + FLOOR_Y) / 2, 16, Math.max(3, melt.waterH * 0.12), 0.1, 0, Math.PI * 2);
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

  /* ---- glass front ---- */
  // walls
  c.strokeStyle = 'rgba(190, 220, 245, 0.5)';
  c.lineWidth = 2.2;
  c.beginPath(); c.moveTo(-R, RIM_Y); c.lineTo(-R, FLOOR_Y); c.stroke();
  c.beginPath(); c.moveTo(R, RIM_Y); c.lineTo(R, FLOOR_Y); c.stroke();
  c.strokeStyle = 'rgba(120, 160, 200, 0.22)';
  c.lineWidth = 5.5;
  c.beginPath(); c.moveTo(-R, RIM_Y); c.lineTo(-R, FLOOR_Y); c.stroke();
  c.beginPath(); c.moveTo(R, RIM_Y); c.lineTo(R, FLOOR_Y); c.stroke();
  // bottom front arc (thick glass base)
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
  // rim ellipse (mouth)
  c.strokeStyle = 'rgba(210, 235, 255, 0.55)';
  c.lineWidth = 1.8;
  ellipse(c, 0, RIM_Y, R, ry);
  c.stroke();
  c.strokeStyle = 'rgba(150, 195, 235, 0.25)';
  c.lineWidth = 4.5;
  ellipse(c, 0, RIM_Y, R + 3, ry + 1.5);
  c.stroke();

  // vertical speculars
  c.fillStyle = 'rgba(255, 255, 255, 0.05)';
  c.beginPath();
  c.roundRect(-R + 10, RIM_Y + 36, 6, JAR_H * 0.5, 3);
  c.fill();
  c.beginPath();
  c.roundRect(R - 16, RIM_Y + 60, 3.5, JAR_H * 0.36, 2);
  c.fill();

  // condensation dots (static, seeded)
  c.fillStyle = 'rgba(220, 240, 255, 0.13)';
  const crng = mulberry32(777);
  for (let i = 0; i < 26; i++) {
    const cx = (crng() * 2 - 1) * (R - 8);
    const cy = RIM_Y + 40 + crng() * (JAR_H - 70);
    c.beginPath();
    c.arc(cx, cy, 0.8 + crng() * 1.6, 0, Math.PI * 2);
    c.fill();
  }

  /* ---- lid (lifts open when adding ice) ---- */
  const lidTarget = dropAnim && (t - dropAnim.start) < 0.7 ? 1 : 0;
  lidLift += (lidTarget - lidLift) * 0.16;
  const ly = RIM_Y - 8 - lidLift * 36;
  c.save();
  c.translate(lidLift * 14, ly);
  c.rotate(-lidLift * 0.05);
  const LR = R + 9;
  // side band of the lid
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
  // top of the lid
  const woodTop = c.createRadialGradient(-LR * 0.25, -10 - LR * K * 0.3, 4, 0, -10, LR);
  woodTop.addColorStop(0, '#c79a68');
  woodTop.addColorStop(0.65, '#a0714a');
  woodTop.addColorStop(1, '#7c5638');
  c.fillStyle = woodTop;
  ellipse(c, 0, -10, LR, LR * K);
  c.fill();
  // subtle wood grain rings
  c.strokeStyle = 'rgba(90, 60, 38, 0.35)';
  c.lineWidth = 0.8;
  for (const f of [0.72, 0.45]) {
    ellipse(c, 0, -10, LR * f, LR * K * f);
    c.stroke();
  }
  // brass rim line
  c.strokeStyle = 'rgba(222, 186, 120, 0.6)';
  c.lineWidth = 1.4;
  ellipse(c, 0, -10, LR * 0.94, LR * K * 0.94);
  c.stroke();
  // knob
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
    const melt = meltState(Math.min(elapsedMs(), state.totalMs), state.totalMs, sessionCubes());
    el.cubeInfo.textContent = `のこり 氷${melt.cubesLeft}個`;
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
  dropAnim = { idx: prefs.cubes - 1, start: performance.now() / 1000 };
  playClink();
  save();
  syncUI();
}

function removeCube() {
  if (state.status !== 'idle' || prefs.cubes < 1) return;
  prefs.cubes--;
  dropAnim = null;
  save();
  syncUI();
}

el.addBtn.addEventListener('click', addCube);
el.removeBtn.addEventListener('click', removeCube);
canvas.addEventListener('click', () => { if (state.status === 'idle') addCube(); });

el.startBtn.addEventListener('click', () => {
  ensureAudioCtx();               // user gesture: unlock audio
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
syncUI();
if (prefs.rain && state.status === 'running') {
  const resumeRain = () => { setRain(true); document.removeEventListener('click', resumeRain); };
  document.addEventListener('click', resumeRain);
}
requestAnimationFrame(frame);

// expose pure functions for console spot-checks
window.iceStudy = { meltState, slotOf, CUBE_MINUTES, MAX_CUBES };

})();
