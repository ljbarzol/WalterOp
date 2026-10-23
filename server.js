// Servidor del laboratorio. Hace dos cosas:
//   1. Entrega las páginas web de la carpeta "public" (HTTP).
//   2. Hace de "recepcionista" (servidor de señalización) por WebSocket: presenta al
//      operador con el robot para que negocien la conexión WebRTC (ver README, Parte 4.2).
//
// El servidor NO entiende los mensajes: solo los reenvía al otro extremo. También reenvía
// los comandos cuando se prueba el modo "WebSocket", que imita cómo funciona Walter hoy
// (operador -> servidor Node.js -> robot).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const httpServer = http.createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Petición inválida');
    return;
  }
  if (path === '/') path = '/index.html';

  // Evita que alguien pida archivos fuera de "public" (por ejemplo con "../").
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Prohibido');
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', // para ver tus cambios al recargar
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});

// ---------------------------------------------------------------------------
// Señalización: como máximo un "robot" y un "operador" conectados a la vez.
// ---------------------------------------------------------------------------
const peers = { robot: null, operator: null };
const otherRole = (role) => (role === 'robot' ? 'operator' : 'robot');

const wss = new WebSocketServer({ server: httpServer, path: '/signal' });

function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const role = new URL(req.url, 'http://localhost').searchParams.get('role');
  if (!(role in peers)) {
    ws.close(1008, 'rol inválido');
    return;
  }

  // Si la página se recargó, el socket viejo puede seguir abierto: lo reemplazamos.
  const previous = peers[role];
  peers[role] = ws;
  if (previous) previous.close(4000, 'reemplazado por una conexión nueva');

  const other = otherRole(role);
  console.log(`[señalización] ${role} conectado`);
  sendJson(ws, { type: 'hello', role, peerPresent: Boolean(peers[other]) });
  sendJson(peers[other], { type: 'peer-joined', role });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    // Los comandos ("app") son muy frecuentes: no los mostramos en consola.
    if (msg.type !== 'app') console.log(`[señalización] ${role} -> ${other}: ${msg.type}`);
    sendJson(peers[other], msg);
  });

  ws.on('close', () => {
    if (peers[role] !== ws) return; // ya había sido reemplazado
    peers[role] = null;
    console.log(`[señalización] ${role} desconectado`);
    sendJson(peers[other], { type: 'peer-left', role });
  });
});

httpServer.listen(PORT, () => {
  console.log('\nLaboratorio Walter listo. Abre en el navegador:');
  console.log(`  Portada:        http://localhost:${PORT}/`);
  console.log(`  Walter falso:   http://localhost:${PORT}/robot.html`);
  console.log(`  Operador:       http://localhost:${PORT}/operator.html\n`);
  console.log('Para detenerlo: Ctrl + C\n');
});
