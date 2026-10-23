// Simulación del robot ("el cerebro" del Walter falso). No usa el navegador ni la red:
// solo calcula cómo se movería un robot de base con ruedas y cómo se calentarían sus
// motores. Por eso se puede probar con "npm test" y, más adelante, reemplazar por el
// robot real manteniendo la misma interfaz (applyCommand, heartbeat, emergencyStop...).

export const LIMITS = {
  maxLinear: 0.5, // m/s: velocidad máxima de avance (límite de seguridad, ver Parte 8.1)
  maxAngular: 1.0, // rad/s: velocidad máxima de giro
};

const MAX_LINEAR_ACCEL = 1.0; // m/s^2: el robot no arranca de golpe
const MAX_ANGULAR_ACCEL = 3.0; // rad/s^2
const HALF_TRACK = 0.2; // m: mitad de la distancia entre las ruedas
const AMBIENT_TEMP = 25; // °C
const MAX_TEMP_RISE = 35; // °C que sube un motor a plena carga
const THERMAL_TIME_CONSTANT = 20; // s: qué tan rápido se calienta o enfría
export const TEMP_WARNING = 45;
export const TEMP_ALARM = 55;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const moveToward = (v, target, maxDelta) =>
  v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target);

export class RobotSim {
  constructor({ heartbeatTimeoutMs = 600, commandTtlMs = 400 } = {}) {
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.commandTtlMs = commandTtlMs;

    this.x = 0;
    this.y = 0;
    this.theta = 0; // orientación en radianes (0 = mirando hacia la derecha del mapa)
    this.vx = 0; // velocidad actual
    this.wz = 0;
    this.targetVx = 0; // velocidad pedida por el operador
    this.targetWz = 0;

    this.estop = false;
    this.estopReason = null;

    this.lastSeq = -1;
    this.lastCommandAt = -Infinity;
    this.lastLinkAt = -Infinity; // último mensaje del operador (comando o heartbeat)
    this.linkLost = true;
    this.commandExpired = false;

    this.tempLeft = AMBIENT_TEMP;
    this.tempRight = AMBIENT_TEMP;

    this.discardedStale = 0;
  }

  // Recibe la velocidad deseada. Devuelve { ok, reason }.
  applyCommand({ vx, wz, seq }, nowMs) {
    this.touchLink(nowMs);
    if (this.estop) return { ok: false, reason: 'estop' };

    // Una orden vieja que llega después de una más nueva se descarta: importa la
    // frescura ("el último valor manda"), no entregar todo (ver Parte 6).
    if (seq !== undefined) {
      if (seq <= this.lastSeq) {
        this.discardedStale += 1;
        return { ok: false, reason: 'vieja' };
      }
      this.lastSeq = seq;
    }

    this.targetVx = clamp(Number(vx) || 0, -LIMITS.maxLinear, LIMITS.maxLinear);
    this.targetWz = clamp(Number(wz) || 0, -LIMITS.maxAngular, LIMITS.maxAngular);
    this.lastCommandAt = nowMs;
    return { ok: true };
  }

  // "Sigo conectado". Si dejan de llegar, el robot se detiene solo (ver Parte 8.1).
  touchLink(nowMs) {
    this.lastLinkAt = nowMs;
  }

  emergencyStop(reason = 'operador') {
    this.estop = true;
    this.estopReason = reason;
    this.targetVx = 0;
    this.targetWz = 0;
    this.vx = 0; // la parada de emergencia frena de inmediato, sin rampa
    this.wz = 0;
  }

  release() {
    this.estop = false;
    this.estopReason = null;
  }

  // Avanza la simulación dt segundos. nowMs es el reloj actual en milisegundos.
  step(dt, nowMs) {
    this.linkLost = nowMs - this.lastLinkAt > this.heartbeatTimeoutMs;
    this.commandExpired = nowMs - this.lastCommandAt > this.commandTtlMs;

    // Vigilante de seguridad: sin enlace o con la orden vencida, el objetivo es 0.
    if (this.linkLost || this.commandExpired) {
      this.targetVx = 0;
      this.targetWz = 0;
    }

    this.vx = moveToward(this.vx, this.targetVx, MAX_LINEAR_ACCEL * dt);
    this.wz = moveToward(this.wz, this.targetWz, MAX_ANGULAR_ACCEL * dt);

    this.x += this.vx * Math.cos(this.theta) * dt;
    this.y += this.vx * Math.sin(this.theta) * dt;
    this.theta += this.wz * dt;
    if (this.theta > Math.PI) this.theta -= 2 * Math.PI;
    if (this.theta < -Math.PI) this.theta += 2 * Math.PI;

    // Velocidad de cada rueda (robot diferencial) y temperatura del motor asociado.
    const wheelLeft = this.vx - this.wz * HALF_TRACK;
    const wheelRight = this.vx + this.wz * HALF_TRACK;
    this.tempLeft = this.#heat(this.tempLeft, wheelLeft, dt);
    this.tempRight = this.#heat(this.tempRight, wheelRight, dt);
  }

  #heat(temp, wheelSpeed, dt) {
    const load = Math.min(1, Math.abs(wheelSpeed) / LIMITS.maxLinear);
    const target = AMBIENT_TEMP + MAX_TEMP_RISE * load;
    return temp + (target - temp) * Math.min(1, dt / THERMAL_TIME_CONSTANT);
  }

  // Lo que el robot reporta al operador (telemetría).
  telemetry() {
    const r = (v, d = 2) => Number(v.toFixed(d));
    return {
      x: r(this.x),
      y: r(this.y),
      theta: r(this.theta),
      vx: r(this.vx),
      wz: r(this.wz),
      tempLeft: r(this.tempLeft, 1),
      tempRight: r(this.tempRight, 1),
      estop: this.estop,
      estopReason: this.estopReason,
      linkLost: this.linkLost,
      discardedStale: this.discardedStale,
    };
  }
}
