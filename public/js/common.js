// Piezas compartidas por la página del robot y la del operador.

// Servidores STUN/TURN (Parte 4.2). En una misma computadora o red local no hacen falta.
// Para probar entre redes distintas agrega, por ejemplo:
//   { urls: 'stun:stun.l.google.com:19302' }
export const ICE_SERVERS = [];

export const HEARTBEAT_INTERVAL_MS = 200; // "sigo conectado" cada 200 ms
export const COMMAND_INTERVAL_MS = 50; // 20 comandos por segundo

export const now = () => performance.now();

// Reloj que NO se frena cuando la pestaña queda en segundo plano. Los navegadores
// reducen los setInterval de pestañas ocultas a ~1 por segundo, lo cual rompería el
// robot (el heartbeat se perdería). Los Web Workers no sufren ese freno.
export function startTicker(intervalMs, fn) {
  const code = `setInterval(() => postMessage(0), ${intervalMs});`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = fn;
  return () => {
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

// ---------------------------------------------------------------------------
// Señalización: conexión WebSocket con server.js (la "recepcionista").
// Se reconecta sola si el servidor se reinicia.
// ---------------------------------------------------------------------------
export function connectSignaling(role, { onMessage, onStatus }) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/signal?role=${role}`;
  let ws = null;
  let closedByUser = false;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => onStatus?.('open');
    ws.onclose = () => {
      onStatus?.('closed');
      if (!closedByUser) setTimeout(open, 1000);
    };
    ws.onmessage = (event) => onMessage(JSON.parse(event.data));
  };
  open();

  return {
    send(obj) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    get isOpen() {
      return ws?.readyState === WebSocket.OPEN;
    },
    close() {
      closedByUser = true;
      ws?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Simulador de mala red a nivel de aplicación (solo para el sentido operador -> robot).
//
// OJO: esto es un MODELO, no una red real. Sirve para ver el efecto de forma rápida.
// Para una red mala de verdad (también sobre el video) usa Clumsy (ver README).
//
//  - delayMs / jitterMs: retraso fijo y variación aleatoria.
//  - lossPct: porcentaje de paquetes "perdidos".
//  - Canal NO confiable (DataChannel "rapido"): un paquete perdido se descarta.
//  - Canal confiable (WebSocket/TCP o DataChannel "critico"): un paquete perdido se
//    retransmite, o sea llega tarde. Y si el canal es ordenado, los mensajes que vienen
//    detrás esperan al retrasado: es el bloqueo de cabeza de línea de la Parte 2.2.
// ---------------------------------------------------------------------------
export class NetSim {
  constructor() {
    this.delayMs = 0;
    this.jitterMs = 0;
    this.lossPct = 0;
    this.queues = new Map(); // por canal ordenado: mensajes esperando su turno
    this.timers = new Map();
  }

  get active() {
    return this.delayMs > 0 || this.jitterMs > 0 || this.lossPct > 0;
  }

  // Descarta lo que esté "viajando" (al cambiar de modo, por ejemplo).
  reset() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.queues.clear();
    this.timers.clear();
  }

  // Ejecuta deliver() como si el mensaje hubiera pasado por la red simulada.
  // Devuelve false si el mensaje se "perdió" definitivamente.
  send(deliver, { reliable, orderedStream = null }) {
    let delay = this.delayMs + Math.random() * this.jitterMs;
    if (Math.random() * 100 < this.lossPct) {
      if (!reliable) return false;
      delay += Math.max(200, 3 * (this.delayMs + this.jitterMs)); // costo de retransmitir
    }
    const due = now() + delay;

    if (orderedStream) {
      this.#enqueueOrdered(orderedStream, due, deliver);
    } else if (delay <= 0.5) {
      deliver();
    } else {
      setTimeout(deliver, delay);
    }
    return true;
  }

  // Canal ordenado (TCP): un mensaje nunca se entrega antes que el anterior.
  #enqueueOrdered(stream, due, deliver) {
    const queue = this.queues.get(stream) ?? [];
    this.queues.set(stream, queue);
    queue.push({ due: Math.max(due, queue.at(-1)?.due ?? 0), deliver });
    this.#drain(stream);
  }

  #drain(stream) {
    clearTimeout(this.timers.get(stream));
    const queue = this.queues.get(stream);
    while (queue.length && queue[0].due <= now() + 0.5) queue.shift().deliver();
    if (queue.length) {
      this.timers.set(stream, setTimeout(() => this.#drain(stream), Math.max(0, queue[0].due - now())));
    }
  }
}
