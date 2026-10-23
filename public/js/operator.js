// Página del operador: ve el video del robot por WebRTC, lo maneja con teclado o botones,
// vigila la telemetría y mide la latencia de los comandos. Los comandos pueden viajar por
// dos caminos para compararlos:
//   - "ws": WebSocket a través del servidor Node.js (como funciona Walter hoy).
//   - "dc": DataChannel de WebRTC, directo al robot (la variante propuesta por el tutor).

import {
  COMMAND_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  ICE_SERVERS,
  NetSim,
  connectSignaling,
  now,
  startTicker,
} from './common.js';
import { LIMITS } from './robot-sim.js';

const $ = (id) => document.getElementById(id);
const netsim = new NetSim();

const state = {
  mode: 'ws',
  robotPresent: false,
  keys: { fwd: false, back: false, left: false, right: false },
  speedFraction: 0.5,
  tele: null,
  teleAt: 0,
  // Se parte de la hora actual para que, si recargas la página, los números de orden
  // sigan creciendo y el robot no descarte tus comandos como "viejos".
  seq: Date.now(),
};

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------
function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').prepend(li);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}

function setBadge(id, stateName, text) {
  $(id).dataset.state = stateName;
  $(id).textContent = text;
}

// ---------------------------------------------------------------------------
// Señalización y conexión WebRTC (el operador es quien "ofrece")
// ---------------------------------------------------------------------------
let pc = null;
let dcFast = null; // "rapido": no ordenado, sin reintentos -> velocidades (último valor manda)
let dcCrit = null; // "critico": confiable y ordenado -> parada de emergencia
let chain = Promise.resolve();

const signaling = connectSignaling('operator', {
  onStatus: (status) => {
    setBadge('st-signal', status === 'open' ? 'ok' : 'bad', status === 'open' ? 'señalización conectada' : 'señalización caída');
  },
  onMessage: (msg) => {
    if (msg.type === 'app') return handleApp(msg.msg);
    chain = chain.then(() => handleSignal(msg)).catch((err) => log(`Error de señalización: ${err}`));
  },
});

async function handleSignal(msg) {
  switch (msg.type) {
    case 'hello':
      state.robotPresent = msg.peerPresent;
      updateRobotBadge();
      break;
    case 'peer-joined':
      state.robotPresent = true;
      log('El robot (Walter falso) se conectó');
      updateRobotBadge();
      break;
    case 'peer-left':
      state.robotPresent = false;
      log('El robot se desconectó');
      updateRobotBadge();
      closePc();
      break;
    case 'answer':
      await pc?.setRemoteDescription(msg.sdp);
      break;
    case 'candidate':
      await pc?.addIceCandidate(msg.candidate);
      break;
  }
}

function updateRobotBadge() {
  setBadge('st-robot', state.robotPresent ? 'ok' : 'wait', state.robotPresent ? 'robot en línea' : 'robot no encontrado');
}

async function connectWebRtc() {
  if (!state.robotPresent) {
    log('Primero abre la página "Walter falso" (robot.html).');
    return;
  }
  closePc();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => e.candidate && signaling.send({ type: 'candidate', candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    setBadge('st-rtc', s === 'connected' ? 'ok' : s === 'failed' ? 'bad' : 'wait', `WebRTC: ${s}`);
    log(`WebRTC: ${s}`);
    $('btn-connect').textContent = s === 'connected' ? 'Reconectar' : 'Conectar WebRTC';
  };
  pc.ontrack = (e) => {
    $('video').srcObject = e.streams[0] ?? new MediaStream([e.track]);
    log('Llegó el video del robot');
  };

  // "recvonly": solo queremos recibir video. Audio queda para una etapa posterior.
  pc.addTransceiver('video', { direction: 'recvonly' });

  dcFast = pc.createDataChannel('rapido', { ordered: false, maxRetransmits: 0 });
  dcCrit = pc.createDataChannel('critico', { ordered: true });
  for (const channel of [dcFast, dcCrit]) {
    channel.onopen = () => log(`DataChannel "${channel.label}" abierto`);
    channel.onclose = () => log(`DataChannel "${channel.label}" cerrado`);
    channel.onmessage = (e) => handleApp(JSON.parse(e.data));
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.send({ type: 'offer', sdp: pc.localDescription });
  log('Oferta enviada al robot');
}

function closePc() {
  pc?.close();
  pc = dcFast = dcCrit = null;
  $('video').srcObject = null;
  setBadge('st-rtc', 'wait', 'WebRTC: sin conexión');
  videoStats.prevBytes = null;
}

// ---------------------------------------------------------------------------
// Envío de mensajes al robot (pasan por el simulador de mala red)
// ---------------------------------------------------------------------------
function channelReady() {
  return state.mode === 'ws'
    ? signaling.isOpen && state.robotPresent
    : dcFast?.readyState === 'open' && dcCrit?.readyState === 'open';
}

function sendToRobot(msg, { critical = false } = {}) {
  if (state.mode === 'ws') {
    if (!signaling.isOpen) return false;
    return netsim.send(() => signaling.send({ type: 'app', msg }), { reliable: true, orderedStream: 'ws' });
  }
  const channel = critical ? dcCrit : dcFast;
  if (channel?.readyState !== 'open') return false;
  const deliver = () => channel.readyState === 'open' && channel.send(JSON.stringify(msg));
  return critical
    ? netsim.send(deliver, { reliable: true, orderedStream: 'critico' })
    : netsim.send(deliver, { reliable: false });
}

// ---------------------------------------------------------------------------
// Medición de latencia
// Cada comando lleva su hora de salida (t). El robot la devuelve en el "ack" cuando lo
// ejecuta. RTT = hora de llegada del ack - hora de salida, medido con un solo reloj
// (el de esta página), por eso es confiable. La latencia de ida es aproximadamente RTT/2.
// ---------------------------------------------------------------------------
const pending = new Map(); // seq -> { t, kind, mode, simDelay, simJitter, simLoss }
const rttWindow = []; // últimos RTT de comandos de velocidad
const records = []; // todo lo medido, para descargar como CSV
const counters = { sent: 0, acked: 0, rejected: 0, noReply: 0 };
let lastCriticalRtt = null;
const PENDING_TIMEOUT_MS = 3000;

function track(seq, kind, t) {
  pending.set(seq, {
    t, kind, mode: state.mode,
    simDelay: netsim.delayMs, simJitter: netsim.jitterMs, simLoss: netsim.lossPct,
  });
  if (kind === 'cmd') counters.sent += 1;
}

function record(seq, entry, rtt, status) {
  records.push([new Date().toISOString(), entry.mode, entry.kind, seq,
    rtt === null ? '' : rtt.toFixed(1), status, entry.simDelay, entry.simJitter, entry.simLoss]);
}

function sweepPending() {
  const t = now();
  for (const [seq, entry] of pending) {
    if (t - entry.t > PENDING_TIMEOUT_MS) {
      pending.delete(seq);
      if (entry.kind === 'cmd') counters.noReply += 1;
      record(seq, entry, null, 'sin_respuesta');
    }
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// ---------------------------------------------------------------------------
// Mensajes que llegan del robot: ack y telemetría
// ---------------------------------------------------------------------------
function handleApp(msg) {
  if (msg.k === 'tele') {
    state.tele = msg;
    state.teleAt = now();
    return;
  }
  if (msg.k !== 'ack') return;

  const entry = pending.get(msg.seq);
  if (!entry) return; // ya se había dado por perdido
  pending.delete(msg.seq);
  const rtt = now() - msg.t;

  if (!msg.ok) {
    counters.rejected += 1;
    record(msg.seq, entry, rtt, `rechazado_${msg.reason}`);
    return;
  }
  record(msg.seq, entry, rtt, 'ok');
  if (entry.kind === 'cmd') {
    counters.acked += 1;
    rttWindow.push(rtt);
    if (rttWindow.length > 100) rttWindow.shift();
  } else {
    lastCriticalRtt = rtt;
    log(`${entry.kind === 'estop' ? 'Parada de emergencia' : 'Liberación'} confirmada por el robot en ${rtt.toFixed(0)} ms`);
  }
}

// ---------------------------------------------------------------------------
// Control: teclado y botones
// ---------------------------------------------------------------------------
const KEY_MAP = {
  ArrowUp: 'fwd', w: 'fwd', W: 'fwd',
  ArrowDown: 'back', s: 'back', S: 'back',
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
};

function setKey(name, down) {
  state.keys[name] = down;
  document.querySelector(`[data-key="${name}"]`)?.classList.toggle('active', down);
}

function emergencyStop() {
  const msg = { k: 'estop', seq: ++state.seq, t: now() };
  track(msg.seq, 'estop', msg.t);
  if (!sendToRobot(msg, { critical: true })) log('E-Stop NO enviado: no hay canal abierto');
  else log('E-Stop enviado');
}

function releaseEstop() {
  const msg = { k: 'reset', seq: ++state.seq, t: now() };
  track(msg.seq, 'reset', msg.t);
  sendToRobot(msg, { critical: true });
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.key === ' ' || e.key === 'Escape') {
    e.preventDefault();
    if (!e.repeat) emergencyStop();
    return;
  }
  const key = KEY_MAP[e.key];
  if (key) {
    e.preventDefault();
    setKey(key, true);
  }
});
document.addEventListener('keyup', (e) => {
  const key = KEY_MAP[e.key];
  if (key) setKey(key, false);
});
// Seguridad: si la ventana pierde el foco, soltamos todas las teclas.
window.addEventListener('blur', () => Object.keys(state.keys).forEach((k) => setKey(k, false)));

for (const button of document.querySelectorAll('.pad [data-key]')) {
  const name = button.dataset.key;
  button.addEventListener('pointerdown', (e) => {
    button.setPointerCapture(e.pointerId);
    setKey(name, true);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, () => setKey(name, false));
  }
}

$('btn-estop').addEventListener('click', emergencyStop);
$('btn-release').addEventListener('click', releaseEstop);
$('btn-connect').addEventListener('click', () => connectWebRtc().catch((err) => log(`Error: ${err}`)));
$('btn-disconnect').addEventListener('click', () => {
  closePc();
  log('Conexión WebRTC cerrada');
});

$('speed').addEventListener('input', (e) => {
  state.speedFraction = Number(e.target.value) / 100;
  $('speed-out').textContent = `${e.target.value}%`;
});

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', () => {
    state.mode = radio.value;
    pending.clear();
    netsim.reset();
    log(`Comandos por: ${state.mode === 'ws' ? 'WebSocket (vía servidor)' : 'DataChannel de WebRTC'}`);
  });
}

for (const [id, field] of [['sim-delay', 'delayMs'], ['sim-jitter', 'jitterMs'], ['sim-loss', 'lossPct']]) {
  $(id).addEventListener('input', (e) => {
    netsim[field] = Number(e.target.value);
    $(`${id}-out`).textContent = e.target.value;
  });
}

// Tras usar un control con el mouse, quitamos el foco para que las flechas no lo muevan.
document.addEventListener('change', (e) => e.target.blur?.());

$('btn-csv').addEventListener('click', () => {
  const header = 'hora_iso,modo,tipo,seq,rtt_ms,estado,sim_retraso_ms,sim_jitter_ms,sim_perdida_pct';
  const csv = [header, ...records.map((row) => row.join(','))].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `latencia-walter-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});
$('btn-clear').addEventListener('click', () => {
  records.length = 0;
  rttWindow.length = 0;
  Object.assign(counters, { sent: 0, acked: 0, rejected: 0, noReply: 0 });
  lastCriticalRtt = null;
  log('Mediciones borradas');
});

// ---------------------------------------------------------------------------
// Bucle de envío: 20 comandos por segundo + heartbeat cada 200 ms
// ---------------------------------------------------------------------------
let sendTicks = 0;
startTicker(COMMAND_INTERVAL_MS, () => {
  if (channelReady()) {
    const { keys } = state;
    const vx = ((keys.fwd ? 1 : 0) - (keys.back ? 1 : 0)) * state.speedFraction * LIMITS.maxLinear;
    const wz = ((keys.left ? 1 : 0) - (keys.right ? 1 : 0)) * state.speedFraction * LIMITS.maxAngular;
    const cmd = { k: 'cmd', seq: ++state.seq, t: now(), vx, wz };
    track(cmd.seq, 'cmd', cmd.t);
    sendToRobot(cmd);

    if (++sendTicks % Math.round(HEARTBEAT_INTERVAL_MS / COMMAND_INTERVAL_MS) === 0) {
      sendToRobot({ k: 'hb', t: now() });
    }
  }
  sweepPending();
});

// ---------------------------------------------------------------------------
// Estadísticas del video (getStats) y pantalla, una vez por segundo / 10 veces por segundo
// ---------------------------------------------------------------------------
const videoStats = { prevBytes: null, prevAt: 0, data: {} };

async function pollVideoStats() {
  if (!pc || pc.connectionState !== 'connected') return;
  const report = await pc.getStats();
  const t = now();
  const d = {};
  report.forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      d.fps = r.framesPerSecond;
      d.size = r.frameWidth ? `${r.frameWidth}x${r.frameHeight}` : null;
      d.lost = r.packetsLost;
      d.jitter = r.jitter !== undefined ? r.jitter * 1000 : null;
      d.buffer = r.jitterBufferEmittedCount ? (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000 : null;
      if (videoStats.prevBytes !== null) {
        d.kbps = ((r.bytesReceived - videoStats.prevBytes) * 8) / (t - videoStats.prevAt);
      }
      videoStats.prevBytes = r.bytesReceived;
      videoStats.prevAt = t;
    }
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      d.netRtt = r.currentRoundTripTime !== undefined ? r.currentRoundTripTime * 1000 : null;
    }
  });
  videoStats.data = d;
}

const fmt = (v, digits = 0, unit = '') => (v === null || v === undefined || Number.isNaN(v) ? '–' : `${v.toFixed(digits)}${unit}`);

function render() {
  const rtts = rttWindow;
  const avg = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
  $('l-last').textContent = fmt(rtts.at(-1), 1);
  $('l-avg').textContent = fmt(avg, 1);
  $('l-p95').textContent = fmt(percentile(rtts, 95), 1);
  $('l-max').textContent = fmt(rtts.length ? Math.max(...rtts) : null, 1);
  $('l-estop').textContent = fmt(lastCriticalRtt, 1);
  const resolved = counters.acked + counters.noReply;
  $('l-loss').textContent = resolved ? `${((counters.noReply / resolved) * 100).toFixed(1)} %` : '–';
  $('l-count').textContent = `${counters.acked} confirmados · ${counters.noReply} sin respuesta · ${counters.rejected} rechazados`;
  $('csv-count').textContent = `${records.length} filas`;

  const v = videoStats.data;
  $('s-fps').textContent = fmt(v.fps, 0);
  $('s-size').textContent = v.size ?? '–';
  $('s-kbps').textContent = fmt(v.kbps, 0);
  $('s-lost').textContent = fmt(v.lost, 0);
  $('s-jitter').textContent = fmt(v.jitter, 1);
  $('s-buffer').textContent = fmt(v.buffer, 0);
  $('s-netrtt').textContent = fmt(v.netRtt, 0);

  const tele = state.tele;
  const teleAge = now() - state.teleAt;
  setBadge('st-tele', tele && teleAge < 1000 ? 'ok' : 'bad', tele ? (teleAge < 1000 ? 'telemetría activa' : `sin telemetría hace ${(teleAge / 1000).toFixed(1)} s`) : 'sin telemetría');
  if (tele) {
    $('t-temp-l').textContent = tele.tempLeft.toFixed(1);
    $('t-temp-r').textContent = tele.tempRight.toFixed(1);
    $('t-speed').textContent = tele.vx.toFixed(2);
    $('t-turn').textContent = tele.wz.toFixed(2);
    $('t-pos').textContent = `${tele.x.toFixed(2)}, ${tele.y.toFixed(2)}`;
    $('t-stale').textContent = tele.discardedStale;
    for (const [id, temp] of [['tile-temp-l', tele.tempLeft], ['tile-temp-r', tele.tempRight]]) {
      $(id).dataset.level = temp >= 55 ? 'alarm' : temp >= 45 ? 'warn' : 'ok';
    }
    const safety = tele.estop ? ['bad', `E-Stop activo (${tele.estopReason})`]
      : tele.linkLost ? ['wait', 'Robot detenido: sin heartbeat']
      : ['ok', 'Robot operando'];
    setBadge('st-safety', safety[0], safety[1]);
  }

  $('channel-note').textContent = channelReady()
    ? 'Canal listo: los comandos se están enviando.'
    : state.mode === 'ws'
      ? 'Esperando al robot: abre la página "Walter falso".'
      : 'Pulsa "Conectar WebRTC" para abrir el DataChannel.';
}

let renderTicks = 0;
startTicker(100, () => {
  if (++renderTicks % 10 === 0) pollVideoStats().catch(() => {});
  render();
});

log('Operador iniciado');
