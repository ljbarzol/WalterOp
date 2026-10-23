// Página del "Walter falso": hace de robot. Captura una cámara (patrón de prueba o
// webcam), simula el movimiento y la temperatura de los motores, y recibe las órdenes
// del operador por WebSocket o por WebRTC (DataChannel).

import { ICE_SERVERS, connectSignaling, now, startTicker } from './common.js';
import { RobotSim, TEMP_ALARM, TEMP_WARNING } from './robot-sim.js';

const $ = (id) => document.getElementById(id);
const sim = new RobotSim();

// ---------------------------------------------------------------------------
// Bitácora de eventos en pantalla
// ---------------------------------------------------------------------------
function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').prepend(li);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}

// ---------------------------------------------------------------------------
// "Cámara" del robot
// ---------------------------------------------------------------------------
// Sin webcam usamos un patrón de prueba: un cuadro que se mueve y un reloj grande.
// El reloj sirve para medir el retraso del video comparando ambas pantallas
// (ver ejercicios en el README).
const canvas = $('pattern');
const ctx = canvas.getContext('2d');
function drawPattern() {
  const t = performance.now();
  const { width: w, height: h } = canvas;
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#12263f');
  gradient.addColorStop(1, '#2b6a5b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const bx = ((t / 4) % (w + 60)) - 60; // cuadro que cruza la imagen
  ctx.fillStyle = '#f2b134';
  ctx.fillRect(bx, h * 0.62, 60, 60);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 72px monospace';
  ctx.textAlign = 'center';
  ctx.fillText((t / 1000).toFixed(2) + ' s', w / 2, h * 0.38);
  ctx.font = '20px sans-serif';
  ctx.fillText('Cámara de prueba de Walter falso', w / 2, h - 20);
}
startTicker(33, drawPattern); // ~30 cuadros por segundo

let patternStream = canvas.captureStream(30);
let webcamStream = null;
let currentStream = patternStream;
$('preview').srcObject = currentStream;

async function chooseSource(kind) {
  if (kind === 'webcam') {
    try {
      webcamStream ??= await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 360 },
        audio: false,
      });
      currentStream = webcamStream;
      log('Cámara: webcam');
    } catch (err) {
      log(`No se pudo abrir la webcam (${err.name}). Se usa el patrón de prueba.`);
      $('source').value = 'pattern';
      currentStream = patternStream;
    }
  } else {
    currentStream = patternStream;
    log('Cámara: patrón de prueba');
  }
  $('preview').srcObject = currentStream;

  // Si ya hay una conexión, cambiamos el video sin renegociar.
  const sender = pc?.getSenders().find((s) => s.track?.kind === 'video');
  await sender?.replaceTrack(currentStream.getVideoTracks()[0]);
}
$('source').addEventListener('change', (e) => chooseSource(e.target.value));

// ---------------------------------------------------------------------------
// Conexión WebRTC (el robot es quien "contesta")
// ---------------------------------------------------------------------------
let pc = null;
const channels = {}; // DataChannels abiertos por el operador: 'rapido' y 'critico'
let lastChannel = 'ws'; // por dónde nos habló el operador la última vez
let chain = Promise.resolve(); // procesa los mensajes de señalización de a uno

const signaling = connectSignaling('robot', {
  onStatus: (status) => {
    $('st-signal').dataset.state = status === 'open' ? 'ok' : 'bad';
    $('st-signal').textContent = status === 'open' ? 'señalización conectada' : 'señalización caída';
  },
  onMessage: (msg) => {
    if (msg.type === 'app') return handleApp(msg.msg, (reply) => sendViaWs(reply), 'ws');
    chain = chain.then(() => handleSignal(msg)).catch((err) => log(`Error de señalización: ${err}`));
  },
});

const sendViaWs = (reply) => signaling.send({ type: 'app', msg: reply });

async function handleSignal(msg) {
  switch (msg.type) {
    case 'hello':
    case 'peer-joined':
      log(msg.peerPresent || msg.role === 'operator' ? 'Hay un operador en línea' : 'Esperando operador');
      break;
    case 'peer-left':
      log('El operador se desconectó');
      closePc();
      break;
    case 'offer':
      await answerOffer(msg.sdp);
      break;
    case 'candidate':
      await pc?.addIceCandidate(msg.candidate);
      break;
  }
}

async function answerOffer(offer) {
  closePc();
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => e.candidate && signaling.send({ type: 'candidate', candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    $('st-rtc').dataset.state = state === 'connected' ? 'ok' : state === 'failed' ? 'bad' : 'wait';
    $('st-rtc').textContent = `WebRTC: ${state}`;
    log(`WebRTC: ${state}`);
  };
  // El operador crea los DataChannel; aquí solo los recibimos.
  pc.ondatachannel = ({ channel }) => {
    channels[channel.label] = channel;
    channel.onmessage = (e) => {
      lastChannel = 'dc';
      handleApp(JSON.parse(e.data), (reply) => channel.readyState === 'open' && channel.send(JSON.stringify(reply)), 'dc');
    };
    log(`DataChannel "${channel.label}" abierto`);
  };

  await pc.setRemoteDescription(offer);
  for (const track of currentStream.getVideoTracks()) pc.addTrack(track, currentStream);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  signaling.send({ type: 'answer', sdp: pc.localDescription });
}

function closePc() {
  pc?.close();
  pc = null;
  for (const key of Object.keys(channels)) delete channels[key];
  $('st-rtc').dataset.state = 'wait';
  $('st-rtc').textContent = 'WebRTC: sin conexión';
}

// ---------------------------------------------------------------------------
// Mensajes de la aplicación (comandos del operador)
//   cmd    -> velocidad deseada       hb    -> "sigo conectado"
//   estop  -> parada de emergencia    reset -> liberar la parada
// Cada comando ejecutado se confirma con un "ack" que devuelve la marca de tiempo
// original: así el operador mide la latencia de ida y vuelta.
// ---------------------------------------------------------------------------
function handleApp(msg, reply, channel) {
  lastChannel = channel;
  const t = now();
  switch (msg.k) {
    case 'hb':
      sim.touchLink(t);
      break;
    case 'cmd': {
      const result = sim.applyCommand(msg, t);
      $('last-cmd').textContent = `v=${msg.vx.toFixed(2)} m/s, w=${msg.wz.toFixed(2)} rad/s (#${msg.seq})`;
      if (result.ok || result.reason !== 'vieja') reply({ k: 'ack', kind: 'cmd', seq: msg.seq, t: msg.t, ...result });
      break;
    }
    case 'estop':
      sim.emergencyStop('operador');
      log('PARADA DE EMERGENCIA recibida');
      reply({ k: 'ack', kind: 'estop', seq: msg.seq, t: msg.t, ok: true });
      break;
    case 'reset':
      sim.release();
      log('Parada de emergencia liberada');
      reply({ k: 'ack', kind: 'reset', seq: msg.seq, t: msg.t, ok: true });
      break;
  }
}

// Telemetría: se envía por el mismo medio por el que el operador nos habla.
function sendTelemetry() {
  const data = { k: 'tele', ts: now(), ...sim.telemetry() };
  if (lastChannel === 'dc') {
    const channel = channels.rapido;
    if (channel?.readyState === 'open') channel.send(JSON.stringify(data));
  } else {
    sendViaWs(data);
  }
}

// ---------------------------------------------------------------------------
// Bucle principal: simulación a 50 Hz, telemetría y pantalla a 10 Hz
// ---------------------------------------------------------------------------
let lastStep = now();
let ticks = 0;
startTicker(20, () => {
  const t = now();
  sim.step((t - lastStep) / 1000, t);
  lastStep = t;
  if (++ticks % 5 === 0) {
    sendTelemetry();
    render();
  }
});

const trail = [];
function render() {
  const tele = sim.telemetry();
  $('v-x').textContent = tele.x.toFixed(2);
  $('v-y').textContent = tele.y.toFixed(2);
  $('v-vx').textContent = tele.vx.toFixed(2);
  $('v-wz').textContent = tele.wz.toFixed(2);
  $('v-temp-l').textContent = tele.tempLeft.toFixed(1);
  $('v-temp-r').textContent = tele.tempRight.toFixed(1);
  $('v-stale').textContent = tele.discardedStale;
  for (const [id, temp] of [['temp-l', tele.tempLeft], ['temp-r', tele.tempRight]]) {
    $(id).dataset.level = temp >= TEMP_ALARM ? 'alarm' : temp >= TEMP_WARNING ? 'warn' : 'ok';
  }

  const safety = $('safety');
  if (tele.estop) {
    safety.dataset.state = 'bad';
    safety.textContent = 'PARADA DE EMERGENCIA activa';
  } else if (tele.linkLost) {
    safety.dataset.state = 'wait';
    safety.textContent = 'Sin heartbeat: robot detenido por seguridad';
  } else {
    safety.dataset.state = 'ok';
    safety.textContent = 'Operando';
  }

  drawMap(tele);
}

function drawMap(tele) {
  const map = $('map');
  const c = map.getContext('2d');
  const scale = 60; // píxeles por metro
  const cx = map.width / 2;
  const cy = map.height / 2;
  c.fillStyle = '#0f1722';
  c.fillRect(0, 0, map.width, map.height);

  c.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let m = -10; m <= 10; m++) {
    c.beginPath();
    c.moveTo(cx + m * scale - (tele.x * scale) % scale, 0);
    c.lineTo(cx + m * scale - (tele.x * scale) % scale, map.height);
    c.stroke();
    c.beginPath();
    c.moveTo(0, cy + m * scale + (tele.y * scale) % scale);
    c.lineTo(map.width, cy + m * scale + (tele.y * scale) % scale);
    c.stroke();
  }

  // El mapa sigue al robot; el eje y se invierte para que "arriba" sea +y.
  trail.push([tele.x, tele.y]);
  if (trail.length > 300) trail.shift();
  c.strokeStyle = '#f2b134';
  c.beginPath();
  trail.forEach(([px, py], i) => {
    const sx = cx + (px - tele.x) * scale;
    const sy = cy - (py - tele.y) * scale;
    i === 0 ? c.moveTo(sx, sy) : c.lineTo(sx, sy);
  });
  c.stroke();

  c.save();
  c.translate(cx, cy);
  c.rotate(-tele.theta);
  c.fillStyle = tele.estop ? '#e5484d' : '#4cc2a0';
  c.beginPath();
  c.moveTo(16, 0);
  c.lineTo(-10, 10);
  c.lineTo(-10, -10);
  c.closePath();
  c.fill();
  c.restore();
}

log('Walter falso iniciado');
