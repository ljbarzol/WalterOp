import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RobotSim, LIMITS } from '../public/js/robot-sim.js';

// Avanza la simulación `seconds` segundos, manteniendo vivo el enlace como lo haría el operador.
function run(sim, seconds, { now = 0, cmd = null, keepAlive = true } = {}) {
  const dt = 0.02;
  let t = now;
  for (let i = 0; i < seconds / dt; i++) {
    t += dt * 1000;
    if (keepAlive && cmd) sim.applyCommand(cmd, t);
    else if (keepAlive) sim.touchLink(t);
    sim.step(dt, t);
  }
  return t;
}

test('avanza en línea recta con el límite de velocidad', () => {
  const sim = new RobotSim();
  run(sim, 2, { cmd: { vx: 10, wz: 0 } }); // pide 10 m/s: debe recortarse
  assert.ok(sim.vx <= LIMITS.maxLinear + 1e-9);
  assert.ok(sim.x > 0.5 && Math.abs(sim.y) < 1e-6);
});

test('descarta una orden vieja que llega después de una más nueva', () => {
  const sim = new RobotSim();
  assert.equal(sim.applyCommand({ vx: 0.3, wz: 0, seq: 5 }, 0).ok, true);
  const old = sim.applyCommand({ vx: -0.3, wz: 0, seq: 4 }, 10);
  assert.deepEqual(old, { ok: false, reason: 'vieja' });
  assert.equal(sim.targetVx, 0.3);
  assert.equal(sim.discardedStale, 1);
});

test('se detiene solo si dejan de llegar mensajes (heartbeat)', () => {
  const sim = new RobotSim();
  let t = run(sim, 1, { cmd: { vx: 0.4, wz: 0 } });
  assert.ok(sim.vx > 0.3);
  run(sim, 2, { now: t, keepAlive: false }); // el operador "desaparece"
  assert.equal(sim.vx, 0);
  assert.equal(sim.linkLost, true);
});

test('una orden vencida detiene el robot aunque haya heartbeat', () => {
  const sim = new RobotSim();
  let t = run(sim, 1, { cmd: { vx: 0.4, wz: 0 } });
  run(sim, 2, { now: t }); // heartbeat sí, comandos no
  assert.equal(sim.vx, 0);
  assert.equal(sim.commandExpired, true);
});

test('la parada de emergencia frena de inmediato e ignora órdenes hasta liberar', () => {
  const sim = new RobotSim();
  let t = run(sim, 1, { cmd: { vx: 0.4, wz: 0 } });
  sim.emergencyStop();
  assert.equal(sim.vx, 0);
  assert.deepEqual(sim.applyCommand({ vx: 0.4, wz: 0 }, t + 20), { ok: false, reason: 'estop' });
  sim.release();
  assert.equal(sim.applyCommand({ vx: 0.4, wz: 0 }, t + 40).ok, true);
});

test('los motores se calientan con carga y se enfrían en reposo', () => {
  const sim = new RobotSim();
  let t = run(sim, 30, { cmd: { vx: 0.5, wz: 0 } });
  const hot = sim.tempLeft;
  assert.ok(hot > 40, `temperatura tras 30 s: ${hot}`);
  run(sim, 60, { now: t });
  assert.ok(sim.tempLeft < hot - 10);
});
