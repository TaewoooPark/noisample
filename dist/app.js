import { BeatEngine } from './engine.js';
import { PLACEMENT_SECONDS } from './patterns.js';

const placementMs = PLACEMENT_SECONDS * 1000;

const canvas = document.querySelector('#instrument');
const ctx = canvas.getContext('2d', { alpha: false });
const status = document.querySelector('#status');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const input = new Float32Array(2048);
const history = new Float32Array(960);
const arrivals = new Map();
const hits = new Map();
let flights = [];
let historyHead = 0;
let lastFrame = performance.now();
let waveCarry = 0;
let state = 'idle';
let width = 0;
let height = 0;
let frameId;
let geometry;
let captureStarted = null;
let melodyVisible = false;
let melodyNotes = [];

const stateDescriptions = {
  idle: '화면을 터치하고 마이크 사용을 허용하세요.',
  requesting: '마이크 연결 중입니다. 브라우저의 마이크 권한을 허용하세요.',
  running: '소리 수집 중. 주변에서 손뼉을 치거나 짧은 소리를 내보세요.',
  suspended: '재생이 일시 정지되었습니다. 화면을 터치하면 다시 시작합니다.',
  denied: '마이크 권한이 없습니다. 브라우저 사이트 설정에서 마이크를 허용한 뒤 화면을 터치하세요.',
  error: '마이크를 연결할 수 없습니다. HTTPS 주소와 마이크 연결을 확인한 뒤 화면을 터치하세요.',
};

const engine = new BeatEngine({
  onState(next) {
    state = next;
    if (next !== 'running') captureStarted = null;
    document.documentElement.dataset.state = next;
    status.textContent = stateDescriptions[next] || stateDescriptions.error;
    canvas.setAttribute('aria-label', status.textContent);
  },
  onCapture(sample) {
    const now = performance.now();
    captureStarted = null;
    arrivals.set(sample.id, now);
    flights.push({ sample, born: now });
    // All presentation state is bounded alongside the engine's sample bank.
    if (arrivals.size > 100) arrivals.delete(arrivals.keys().next().value);
  },
  onLevels(level) {
    if (level.capturing) captureStarted ??= performance.now();
    else captureStarted = null;
  },
  onHit(hit) {
    const when = performance.now() + Math.max(0, hit.delayMs || 0);
    hits.set(`${hit.sampleId}:${hit.step}`, when);
    if (hits.size > 256) hits.delete(hits.keys().next().value);
  },
  onMelodyState(update) {
    const next = typeof update === 'string' ? update : update.state;
    if (next === 'playing' && !melodyVisible) {
      melodyVisible = true;
      resize();
    }
  },
  onMelodyNote(note) {
    if (!melodyVisible) {
      melodyVisible = true;
      resize();
    }
    const step = Number.isFinite(note.step) ? note.step : engine.getPosition();
    melodyNotes.push({ ...note, step: (step % 32 + 32) % 32, born: performance.now() + Math.max(0, note.delayMs || 0) });
    if (melodyNotes.length > 128) melodyNotes.splice(0, melodyNotes.length - 128);
  },
});

function resize() {
  const box = canvas.getBoundingClientRect();
  width = box.width;
  height = box.height;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const margin = width < 600 ? 24 : Math.max(64, width * 0.08);
  const compact = height < 440;
  const top = compact ? height * 0.40 : height * 0.43;
  const bottom = compact ? height * 0.84 : Math.min(height * 0.80, height - 118);
  geometry = {
    left: margin, right: width - margin, length: width - margin * 2,
    waveY: compact ? height * 0.20 : height * 0.245,
    waveHeight: Math.min(76, height * 0.085),
    top, bottom, gap: (bottom - top) / (melodyVisible ? 6 : 5),
    step: (width - margin * 2) / 32,
  };
}

function line(x1, y1, x2, y2, color = '#111', thickness = 1) {
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawMic(x, y, now) {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.3;
  if (state === 'running') {
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(0, 0, 2.25, 0, Math.PI * 2); ctx.fill();
  } else if (state === 'requesting') {
    ctx.rotate(now / 450);
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 1.5); ctx.stroke();
  } else if (state === 'suspended') {
    line(-3, -5, -3, 5); line(3, -5, 3, 5);
  } else {
    if (state === 'idle' && !reducedMotion) ctx.globalAlpha = 0.65 + Math.sin(now / 650) * 0.25;
    ctx.beginPath(); ctx.roundRect(-3.4, -9, 6.8, 12.5, 3.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 6.6, 0, Math.PI); ctx.stroke();
    line(0, 6.6, 0, 10); line(-3.7, 10, 3.7, 10);
    if (state === 'error' || state === 'denied') line(-10, -11, 10, 11, '#111', 1.5);
  }
  ctx.restore();
}

function updateWave(delta) {
  engine.getWaveform(input);
  waveCarry += Math.min(delta, 80) * 0.24;
  const count = Math.min(32, Math.floor(waveCarry));
  waveCarry -= count;
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * input.length / count);
    const to = Math.floor((i + 1) * input.length / count);
    let peak = 0;
    for (let j = from; j < to; j++) if (Math.abs(input[j]) > Math.abs(peak)) peak = input[j];
    history[historyHead] = state === 'running' ? peak : 0;
    historyHead = (historyHead + 1) % history.length;
  }
}

function drawWave(now) {
  const { left, right, length, waveY, waveHeight } = geometry;
  line(left, waveY, right, waveY, '#e5e5e5');
  ctx.save();
  ctx.beginPath(); ctx.rect(left, waveY - waveHeight - 3, length, waveHeight * 2 + 6); ctx.clip();
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  for (let i = 0; i < history.length; i++) {
    const v = history[(historyHead + i) % history.length];
    const amplitude = Math.sign(v) * Math.min(1, Math.pow(Math.abs(v), 0.68) * 2.2);
    const x = left + i / (history.length - 1) * length;
    const y = waveY - amplitude * waveHeight;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
  if (captureStarted !== null) {
    const elapsed = (now - captureStarted) / 1000 + 0.032;
    const selectionWidth = Math.min(length, Math.max(2, elapsed / 4 * length));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.035)';
    ctx.fillRect(right - selectionWidth, waveY - waveHeight - 3, selectionWidth, waveHeight * 2 + 6);
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.75;
    ctx.strokeRect(right - selectionWidth, waveY - waveHeight - 3, selectionWidth, waveHeight * 2 + 6);
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(right - 12, waveY - 15, 26, 30);
  drawMic(right, waveY, now);
}

function sampleShape(sample, x, y, w, h, active = false, opacity = 1, from = 0, to = 1) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = active ? '#111' : '#fff';
  ctx.fillRect(x, y - h / 2, w, h);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 0.85;
  ctx.strokeRect(x + 0.4, y - h / 2 + 0.4, Math.max(0, w - 0.8), h - 0.8);
  const peaks = sample.peaks || [];
  const columns = Math.max(2, Math.min(peaks.length, Math.floor(w - 4)));
  ctx.strokeStyle = active ? '#fff' : '#111'; ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let i = 0; i < columns; i++) {
    const index = Math.min(peaks.length - 1, Math.floor((from + i / columns * (to - from)) * peaks.length));
    const val = Math.abs(peaks[index] || 0.03);
    const a = Math.max(0.7, Math.min(1, val) * (h / 2 - 3));
    const px = x + 2 + (w - 4) * i / Math.max(1, columns - 1);
    ctx.moveTo(px, y - a); ctx.lineTo(px, y + a);
  }
  ctx.stroke(); ctx.restore();
}

function blockWidth(sample) {
  const secondsPerStep = 60 / engine.bpm / 4;
  const fullWidth = sample.duration / secondsPerStep * geometry.step;
  // The pulse row shows distinct quarter-note triggers even when raw tails overlap.
  return Math.max(5, sample.isAnchor ? Math.min(fullWidth, geometry.step * 3.6) : fullWidth);
}

function drawSequencer(now) {
  const { left, right, top, bottom, step, gap } = geometry;
  const blockHeight = Math.max(11, Math.min(26, gap * 0.42));
  // Beat marks are deliberately confined to the six baselines.
  for (let lane = 0; lane < 6; lane++) {
    const y = top + gap * lane;
    line(left, y, right, y, '#dedede', 0.8);
    for (let beat = 0; beat <= 32; beat += 4) {
      const x = left + beat * step;
      line(x, y - 2, x, y + 2, beat % 16 === 0 ? '#aaa' : '#ddd', 0.8);
    }
    const bank = engine.samples?.[lane] || [];
    for (const sample of bank) {
      const arrived = arrivals.get(sample.id) || 0;
      const age = now - arrived;
      if (age < (reducedMotion ? 100 : placementMs)) continue;
      for (let i = 0; i < sample.steps.length; i++) {
        const s = sample.steps[i];
        const fade = Math.min(1, Math.max(0, (age - (reducedMotion ? 100 : placementMs) - i * 10) / 100));
        const hitAt = hits.get(`${sample.id}:${s}`) || -10000;
        const sinceHit = now - hitAt;
        const active = sinceHit >= 0 && sinceHit < (sample.isAnchor ? 160 : sample.duration * 1000);
        const fullWidth = blockWidth(sample);
        const x = left + s * step;
        const w = Math.min(fullWidth, right - x);
        sampleShape(sample, x, y, w, blockHeight, active, fade, 0, w / fullWidth);
        // Clips can continue across the two-bar boundary without being cut.
        if (fullWidth > w) {
          sampleShape(sample, left, y, fullWidth - w, blockHeight, active, fade, w / fullWidth, 1);
        }
      }
    }
  }
  if (melodyVisible) drawMelody(now);
  if (state === 'running' || state === 'suspended') {
    const pos = engine.getPosition();
    const x = left + (Number.isFinite(pos) ? pos : 0) * step;
    line(x, top - blockHeight / 2 - 9, x, bottom + blockHeight / 2 + 9, '#111', 1.05);
    ctx.fillStyle = '#111';
    ctx.fillRect(x - 1.5, top - blockHeight / 2 - 12, 3, 3);
  }
}

function drawMelody(now) {
  const { left, right, top, gap, step } = geometry;
  const y = top + gap * 6;
  const secondsPerStep = 60 / engine.bpm / 4;
  const loopMs = secondsPerStep * 32 * 1000;
  line(left, y, right, y, '#dedede', 0.8);
  for (let beat = 0; beat <= 32; beat += 4) {
    line(left + beat * step, y - 2, left + beat * step, y + 2, '#ddd', 0.8);
  }
  melodyNotes = melodyNotes.filter(note => now - note.born < loopMs);
  for (const note of melodyNotes) {
    const age = now - note.born;
    if (age < 0) continue;
    const active = state === 'running' && age < note.duration * 1000;
    const pitch = Math.max(-1, Math.min(1, (note.midi - 64) / 24));
    const noteY = y - pitch * Math.min(16, gap * 0.3);
    const noteHeight = note.part === 'chord' ? 2 : 4;
    const x = left + note.step * step;
    const fullWidth = Math.max(3, note.duration / secondsPerStep * step);
    const firstWidth = Math.min(fullWidth, right - x);
    ctx.save();
    ctx.globalAlpha = active ? 1 : 0.3;
    ctx.fillStyle = '#111';
    ctx.fillRect(x, noteY - noteHeight / 2, firstWidth, noteHeight);
    if (fullWidth > firstWidth) ctx.fillRect(left, noteY - noteHeight / 2, Math.min(fullWidth - firstWidth, right - left), noteHeight);
    ctx.restore();
  }
}

function drawFlights(now) {
  const { left, right, waveY, top, gap, step } = geometry;
  flights = flights.filter(f => now - f.born < placementMs + 220);
  for (const flight of flights) {
    const age = now - flight.born;
    if (reducedMotion) continue;
    const sample = flight.sample;
    const captureWidth = Math.min(geometry.length * 0.48, Math.max(24, sample.duration / 4 * geometry.length));
    const startX = right - captureWidth;
    const destX = left + sample.steps[0] * step;
    const destY = top + sample.lane * gap;
    const p = Math.min(1, Math.max(0, (age - 60) / (placementMs - 60)));
    const ease = 1 - Math.pow(1 - p, 3);
    const x = startX + (destX - startX) * ease;
    const y = waveY + (destY - waveY) * ease;
    const h = Math.min(26, gap * 0.42);
    const targetWidth = Math.min(blockWidth(sample), right - destX);
    const w = (captureWidth + (targetWidth - captureWidth) * ease) * Math.min(1, age / 60);
    if (p < 1) {
      // A stretched trace lets the original cut visibly travel into its lane.
      ctx.save(); ctx.globalAlpha = Math.sin(p * Math.PI) * 0.20;
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.moveTo(startX, waveY - h / 2);
      ctx.bezierCurveTo(startX, y, x, waveY, x, y - h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.bezierCurveTo(x + w, waveY, startX + captureWidth, y, startX + captureWidth, waveY + h / 2);
      ctx.closePath(); ctx.fill(); ctx.restore();
      sampleShape(sample, x, y, w, h, false);
    } else {
      const alpha = Math.max(0, 1 - (age - placementMs) / 220);
      const expand = (age - placementMs) / 35;
      ctx.save(); ctx.globalAlpha = alpha * 0.35;
      ctx.strokeStyle = '#111'; ctx.lineWidth = 0.8;
      ctx.strokeRect(destX - expand, destY - h / 2 - expand, targetWidth + expand * 2, h + expand * 2);
      ctx.restore();
    }
  }
}

function frame(now) {
  const delta = now - lastFrame;
  lastFrame = now;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  updateWave(delta);
  drawWave(now);
  drawSequencer(now);
  drawFlights(now);
  frameId = requestAnimationFrame(frame);
}

async function activate() {
  // Every completed tap can unlock iOS audio, including while permission/setup
  // is pending. The engine coalesces permission requests and running transports.
  try { await engine.start(); } catch { /* The engine exposes actionable states to the live region. */ }
}

canvas.addEventListener('click', activate);
canvas.addEventListener('keydown', event => {
  if (event.code === 'Space' || event.code === 'Enter') { event.preventDefault(); activate(); }
});
document.querySelector('#reset').addEventListener('click', () => {
  history.fill(0);
  historyHead = 0;
  waveCarry = 0;
  arrivals.clear();
  hits.clear();
  flights = [];
  captureStarted = null;
  melodyVisible = false;
  melodyNotes = [];
  resize();
  engine.reset();
  // Keep this call inside the same trusted click; no reload or second prompt.
  activate();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(frameId);
  else { lastFrame = performance.now(); frameId = requestAnimationFrame(frame); }
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) engine.destroy();
});
new ResizeObserver(resize).observe(canvas);
resize();
frameId = requestAnimationFrame(frame);
