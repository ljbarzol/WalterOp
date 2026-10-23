# Laboratorio de teleoperación de Walter

Un laboratorio para practicar, **sin necesitar el robot**, las ideas de tu investigación técnica: WebRTC, canales separados para video y comandos, heartbeat, parada de emergencia, telemetría y medición de latencia.

Todo está en JavaScript. Hay tres piezas que corren en tu computador:

```
   Operador (navegador)                         Walter falso (navegador)
   ┌────────────────────┐   video (WebRTC)      ┌────────────────────┐
   │ ve el video        │ ◄──────────────────── │ "cámara" (patrón   │
   │ manda comandos     │ ───── comandos ─────► │  de prueba/webcam) │
   │ mide la latencia   │ ◄──── telemetría ──── │ robot simulado     │
   └─────────┬──────────┘                       └─────────┬──────────┘
             │          server.js (Node.js)               │
             └──────►  "recepcionista": los presenta  ◄───┘
                       y reenvía comandos en modo WebSocket
```

| Pieza | Archivos | Qué es |
|---|---|---|
| Servidor | `server.js` | Entrega las páginas y hace la señalización (Parte 4.2 de tu investigación). |
| Walter falso | `public/robot.html`, `public/js/robot.js`, `public/js/robot-sim.js` | El robot simulado: cámara, movimiento, temperatura de motores, heartbeat y parada de emergencia. |
| Operador | `public/operator.html`, `public/js/operator.js` | La interfaz: video, controles, métricas de latencia y de video, telemetría. |

Cuando tengas acceso a Walter, la idea es reemplazar solo el «Walter falso» por un programa que hable con el robot real. La interfaz del operador se queda casi igual.

## 0. Opción más fácil: usarlo en GitHub Codespaces (sin instalar nada)

Codespaces te da un VS Code en el navegador con Node.js ya instalado. El proyecto trae su configuración en `.devcontainer/`.

1. En GitHub, abre el repositorio, pulsa el botón verde **Code**, pestaña **Codespaces**, y **Create codespace on main**. Espera a que cargue (la primera vez tarda un par de minutos y ejecuta `npm install` solo).
2. En la terminal de abajo escribe:
   ```
   npm start
   ```
3. Abre la pestaña **Puertos** (junto a la terminal). Verás el puerto **3000**. Pasa el mouse por la columna «Dirección» y pulsa el ícono del **globo** para abrirlo en el navegador. Es una dirección `https://...app.github.dev`.
4. Esa portada te lleva a las dos páginas. Abre **robot.html** y **operator.html** en **dos ventanas** del navegador de tu computador (sigue los pasos de la sección 2, desde el punto 1, usando esa dirección en lugar de `localhost:3000`).

Lo que debes saber:

- **Los dos navegadores están en tu computador.** El video y el DataChannel van directo de una ventana a la otra. Codespaces solo hace de servidor de señalización.
- **La webcam funciona**, porque la dirección es `https`.
- **Deja el puerto en «Privado»** (es lo normal). Funciona si ambas ventanas son del mismo navegador, con tu sesión de GitHub iniciada.
- **Las latencias en modo WebSocket salen más altas que en tu computador**, porque ahí los comandos viajan hasta el servidor en la nube y vuelven. En DataChannel no, porque va directo entre tus ventanas. La diferencia ya no es solo «TCP contra UDP». Para una comparación limpia del ejercicio 2, ejecútalo en tu propio Windows (secciones 1 y 2). En Codespaces sí sirve para aprender, ver el código y demostrar el funcionamiento.
- **Clumsy (sección 5) no aplica en Codespaces**, porque interfiere con la red de tu computador y no con la de la nube.
- **Codespaces se apaga solo** tras un rato sin uso y tiene una cuota gratuita mensual de horas. Revisa tu cuota en GitHub, y detén el codespace cuando termines.
- No he podido probar esta configuración en Codespaces desde aquí. Si falla, copia el mensaje exacto de la terminal.

---

## 1. Instalar en Windows

1. Instala **Node.js (versión LTS)** desde <https://nodejs.org>. Acepta las opciones por defecto.
2. Instala **Chrome** o **Edge** si no los tienes.
3. Descomprime esta carpeta donde quieras (por ejemplo `Documentos\walter-lab`).
4. Comprueba la instalación: abre una terminal (tecla Windows, escribe `cmd`, Enter) y escribe `node --version`. Debe mostrar un número como `v22.x`.

## 2. Ponerlo a funcionar

**Opción fácil:** haz doble clic en `iniciar-laboratorio.bat`. Instala lo necesario la primera vez, arranca el servidor y abre la portada.

**Opción manual:** abre una terminal dentro de la carpeta (en el Explorador de archivos, escribe `cmd` en la barra de direcciones y pulsa Enter) y ejecuta:

```
npm install
npm start
```

La primera vez, Windows puede preguntar si permites el acceso a la red a Node.js. Puedes aceptar en «redes privadas».

Después sigue estos pasos:

1. Abre <http://localhost:3000/robot.html> (el **Walter falso**).
2. Abre <http://localhost:3000/operator.html> en **otra ventana** del navegador (no otra pestaña) y colócala al lado de la primera. Las pestañas ocultas pueden funcionar más lento.
3. En el operador pulsa **Conectar WebRTC**. Debe aparecer el video.
4. Mantén pulsada la tecla **W** (o la flecha ↑): el robot avanza en su mapa. **A** y **D** giran. **Espacio** es la parada de emergencia.

Mira también la terminal donde corre el servidor. Verás pasar los mensajes `offer`, `answer` y `candidate`: es la señalización de WebRTC en vivo.

Para detener el servidor, pulsa `Ctrl + C` en esa terminal.

## 3. Qué estás viendo

| En pantalla | Concepto de tu investigación |
|---|---|
| Insignias de arriba (señalización, WebRTC, telemetría) | Señalización, ICE, estado de la conexión (4.2) |
| **Comandos por WebSocket** | Lo que usa Walter hoy: operador → servidor Node.js → robot (4.1) |
| **Comandos por DataChannel** | La variante del tutor: comandos por WebRTC, directo al robot (4.2, Parte 6) |
| Latencia (último, promedio, percentil 95, máximo) | Latencia y jitter (1.4); criterio de aceptación «latencia orden → ejecución» (8.2) |
| Calidad del video (fps, bitrate, pérdida, jitter) | `getStats` (4.2, 8.2) |
| Telemetría: temperatura de motores | Dashboard del MVP (Parte 9) |
| Parada de emergencia | E-Stop con canal garantizado (8.1) |
| «Sin heartbeat: robot detenido» | Heartbeat (8.1) |
| «Órdenes viejas descartadas» | Plazo de vigencia / «el último valor manda» (Parte 6) |
| **Red mala simulada** | Bloqueo de cabeza de línea de TCP frente a UDP (2.2) |

### Los dos canales de WebRTC
El operador abre dos DataChannels al conectarse, definidos en `operator.js`:

- `rapido`: `ordered: false, maxRetransmits: 0`. Es para velocidades. Si un mensaje se pierde, no se reenvía, porque llegaría viejo.
- `critico`: confiable y ordenado. Es para la parada de emergencia, que no puede perderse.

### Cómo se mide la latencia
Cada comando sale con su hora. El robot lo ejecuta y responde con un «ack» que repite esa hora. El operador calcula `hora de llegada − hora de salida` con **un solo reloj**, el suyo, y por eso es un número fiable. Es el **ida y vuelta**. La ida sola es aproximadamente la mitad. El botón **Descargar CSV** guarda cada medición para analizarla en Excel.

## 4. Ejercicios para aprender

1. **Mide el retraso del video «de pantalla a pantalla».** El patrón de prueba tiene un reloj grande. Pon las dos ventanas lado a lado y toma una foto o captura de ambas a la vez. La diferencia entre los dos relojes es el retraso del video. Repítelo con la webcam y con ambas ventanas visibles.
2. **WebSocket contra DataChannel con mala red.** Sube el retraso a 150 ms y la pérdida a 20 %. Conduce 20 segundos en cada modo y compara. En nuestras pruebas el DataChannel mantuvo unos 150 ms y perdió algunos comandos. WebSocket no perdió ninguno, pero su latencia subió a cientos de milisegundos. Es el bloqueo de cabeza de línea. ¿Cuál preferirías para manejar un robot? ¿Y para la parada de emergencia?
3. **Prueba el heartbeat.** Mientras el robot avanza, cierra la ventana del operador. El robot debe frenar solo en menos de un segundo.
4. **Alarga los plazos de seguridad.** En `robot-sim.js` cambia `heartbeatTimeoutMs` y `commandTtlMs` a 5000 y repite el ejercicio 3. El robot tardará unos 5 segundos en frenar. Por eso estos plazos deben ser cortos.
5. **Calienta los motores.** Avanza a velocidad máxima unos 20 s y mira cómo la temperatura pasa a amarillo y luego a rojo. Los umbrales están en `robot-sim.js`.
6. **Cambia la confiabilidad del canal rápido.** En `operator.js` cambia `maxRetransmits: 0` por `maxRetransmits: 3`. El simulador de la página no reproduce los reintentos, así que el efecto solo se ve con una red mala real (sección 5).
7. **Usa la webcam.** En el Walter falso elige «Webcam» y observa el bitrate en el operador.
8. **Maneja desde otro dispositivo.** Con ambos en la misma red Wi-Fi, abre en tu celular `http://IP-DE-TU-PC:3000/operator.html`. La IP la ves con `ipconfig`. El operador no necesita cámara, así que funciona. Solo el Walter falso con webcam exige `localhost`.
9. **Analiza el CSV en Excel.** Descarga un CSV por modo y compara los percentiles. Sirve para el informe de pruebas.

## 5. Probar con una red mala de verdad (Windows)

El simulador de la página es un **modelo** y solo afecta a los comandos. Para degradar también el video, usa un programa que interfiera la red del sistema, por ejemplo **Clumsy** (gratuito, se busca por «clumsy network simulator windows»). Se ejecuta como administrador, y con un filtro como `udp` se aplica a WebRTC. Activa *Lag* (por ejemplo 100 ms) y *Drop* (por ejemplo 5 %) y observa cómo reaccionan el video y los comandos. No lo he probado aquí porque esta sesión corre en Linux; las instrucciones son las habituales de esa herramienta.

Las herramientas de red del navegador (DevTools) **no** sirven para esto: no afectan a WebRTC.

## 6. Mapa del código

```
walter-lab/
├─ server.js                 Servidor HTTP + señalización WebSocket (reenvía mensajes)
├─ iniciar-laboratorio.bat   Arranque con doble clic en Windows
├─ package.json              Una sola dependencia: "ws" (WebSocket para Node.js)
├─ public/
│  ├─ index.html             Portada con los pasos
│  ├─ robot.html             Pantalla del Walter falso
│  ├─ operator.html          Pantalla del operador
│  ├─ css/style.css          Estilos
│  └─ js/
│     ├─ common.js           Señalización, reloj sin freno y simulador de red mala (NetSim)
│     ├─ robot-sim.js        Cerebro del robot: movimiento, temperatura, heartbeat, E-Stop
│     ├─ robot.js            WebRTC del lado del robot, cámara, mapa, telemetría
│     └─ operator.js         WebRTC del lado del operador, control, métricas, CSV
└─ tests/
   └─ robot-sim.test.js      Pruebas automáticas de la lógica del robot (npm test)
```

Mensajes de la aplicación, en JSON: `cmd` (velocidad deseada), `hb` (heartbeat), `estop`, `reset`, `ack` (confirmación del robot) y `tele` (telemetría).

## 7. Límites de este laboratorio (conviene saberlo)

- **No hay robot ni ROS 2.** El robot es una simulación sencilla: ruedas diferenciales, sin obstáculos ni física real.
- **Sin audio todavía.** El video sí viaja por WebRTC; el audio queda como siguiente paso.
- **Las latencias en una sola computadora son casi cero** (1 a 3 ms). Son una referencia mínima. Los números reales saldrán con Wi-Fi, otra red y el robot.
- **Sin TURN.** `ICE_SERVERS` está vacío (en `common.js`), lo que sirve en la misma computadora o red. Entre redes distintas hay que agregar servidores STUN/TURN.
- **El simulador de red es un modelo.** Afecta solo al sentido operador → robot.
- **Seguridad de laboratorio:** no hay inicio de sesión ni cifrado en la señalización. No lo expongas a internet.
- **Probado** con un navegador Chromium en Linux (conexión WebRTC, ambos modos de comandos, parada de emergencia, heartbeat y mala red simulada) y con las pruebas automáticas del robot. **No se ha probado en Windows** (ni el `.bat`) **ni en Codespaces**. Si algo falla ahí, avísame con el mensaje exacto.

## 8. Próximos pasos sugeridos

1. Agregar **audio** (`getUserMedia` con audio y un segundo transceiver).
2. Mover los comandos por **gRPC** o **Zenoh** en un servidor intermedio y comparar con lo ya medido.
3. Instalar **ROS 2** (en WSL2 o Docker) y mover un robot simulado con `rosbridge_suite`. Responde si hace falta un middleware propio.
4. Probar **MediaMTX** para comparar protocolos de video (RTSP, SRT, WebRTC).
5. Sustituir el Walter falso por un puente al robot real, usando la ficha técnica.
