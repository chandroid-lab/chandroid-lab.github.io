document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('cloud-canvas');
  if (!canvas) return;

  const statusEl = document.getElementById('cloud-status');
  const povEl = document.getElementById('cloud-pov');
  const povTagEl = document.getElementById('cloud-povtag');

  // Visitors used to paste their own Gemini key; drop any copy left behind.
  try {
    localStorage.removeItem('cloud-playground-gemini-key');
  } catch (e) {
    // localStorage unavailable (private mode, etc.) — nothing to clean up.
  }

  const params = {
    color: [1, 1, 1],
    density: 0.68,
    puffiness: 0.68,
    turbulence: 0.3,
    height: 0.2,
  };

  // Where Spot starts on the ground plane (y = 0); the scene is in meters.
  // From here on spot-gait.js owns its pose, and the fog follows it.
  const SPOT_POS = [0.1, 0, 2.35];
  const SPOT_YAW = 2.5;
  const SPOT_MAX_DIST = 20;
  // Echo, the second robot, starts off Spot's shoulder facing the same way,
  // in graphite so the two can be told apart at a glance.
  const ECHO_POS = [
    SPOT_POS[0] + 0.2 * Math.cos(SPOT_YAW) - 1.8 * Math.sin(SPOT_YAW), 0,
    SPOT_POS[2] - 0.2 * Math.sin(SPOT_YAW) - 1.8 * Math.cos(SPOT_YAW),
  ];
  const ECHO_PAINT = [0.3, 0.32, 0.35];
  // Seconds Echo's arm clock runs ahead of Spot's; anything that isn't a
  // neat fraction of the idle loop will do.
  const ECHO_CLOCK = 4.3;

  // Starts a few meters back from Spot, roughly at eye level and tilted
  // slightly down toward it; from there trackPair() covers the chase.
  const camera = {
    pos: [0, 1.55, -2.9],
    yaw: 0,
    pitch: -0.17,
  };
  const MIN_CAMERA_Y = 0.15;
  // Riding the gripper camera: the free camera is parked here until you come back.
  let pov = false;
  let parkedCamera = null;
  // Only the arm camera rolls; the free camera keeps the horizon level.
  let camRoll = 0;
  const keys = Object.create(null);
  let dragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  // Scene time, which a cut briefly runs slower than the wall clock.
  let clock = 0;
  let timeScale = 1;
  let shake = 0;
  let touchedAt = -Infinity;
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setStatus(msg, isError) {
    if (!statusEl) return;
    if (!msg) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }

  const VERT_SRC = `
    attribute vec2 aPos;
    void main() {
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const FRAG_SRC = `
    precision highp float;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform vec3 uCloudColor;
    uniform float uDensity;
    uniform float uPuffiness;
    uniform float uTurbulence;
    uniform float uHeight;
    uniform vec3 uCamPos;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uRoll;

    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    float noise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
            mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
            mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
        f.z);
    }

    float fbm(vec3 p) {
      float f = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 6; i++) {
        f += amp * noise(p);
        p *= 2.03;
        amp *= 0.5;
      }
      return f;
    }

    const vec3 SUN_DIR = normalize(vec3(0.4, 0.65, -0.35));

    // Spot itself is rasterized by spot-renderer.js into uSpotTex
    // (rgb = lit color, a = camera distance / SPOT_MAX_DIST).
    uniform sampler2D uSpotTex;
    uniform float uSpotLoaded;
    // Both robots on the ground: x, z, yaw.
    uniform vec3 uSpotA;
    uniform vec3 uSpotB;
    const float SPOT_MAX_DIST = ${SPOT_MAX_DIST.toFixed(1)};

    // The pair runs inside a pocket of thinner air, so the chase stays legible
    // from far enough back to see a cut instead of a robot filling the frame.
    float clearingAround(vec3 p, vec3 robot) {
      return mix(0.2, 1.0, smoothstep(1.2, 4.6, length(p - vec3(robot.x, 0.6, robot.y))));
    }

    float cloudDensity(vec3 p) {
      float scale = mix(1.6, 0.6, uPuffiness);
      vec3 q = p * scale;
      q.x -= uTime * 0.05;
      q += uTurbulence * vec3(
        fbm(q * 0.7 + uTime * 0.15),
        fbm(q * 0.7 - uTime * 0.1),
        0.0
      );
      float base = fbm(q) - (1.0 - uDensity) * 1.1;
      // High-frequency detail carves in the small cauliflower-like bumps
      // real cumulus edges have, instead of smooth blobby silhouettes.
      base -= 0.15 * (1.0 - fbm(q * 4.0 + 7.3));
      float bandCenter = mix(0.6, 2.4, uHeight);
      float band = 1.0 - smoothstep(0.8, 1.8, abs(p.y - bandCenter));
      // Thin the fog right around each robot so it stays a silhouette in the
      // murk rather than being swallowed whole.
      float clearing = min(clearingAround(p, uSpotA), clearingAround(p, uSpotB));
      return clamp(base, 0.0, 1.0) * band * clearing;
    }

    // Marches a short hop toward the sun to see how much denser the cloud
    // gets in that direction — a cheap stand-in for real self-shadowing.
    float sunLight(vec3 p) {
      float shadow = 0.0;
      float stepLen = 0.22;
      vec3 pos = p;
      for (int i = 0; i < 3; i++) {
        pos += SUN_DIR * stepLen;
        shadow += cloudDensity(pos);
      }
      return clamp(1.0 - shadow * 0.85, 0.05, 1.0);
    }

    // tMax is the distance to the nearest solid surface, so fog in front of
    // Spot or the ground covers it but fog behind it doesn't bleed through.
    vec4 raymarchClouds(vec3 ro, vec3 rd, float tMax) {
      vec4 acc = vec4(0.0);
      float t = 0.0;
      float tEnd = min(11.0, tMax);
      for (int i = 0; i < 72; i++) {
        if (acc.a > 0.99 || t > tEnd) break;
        vec3 p = ro + rd * t;
        float d = cloudDensity(p);
        if (d > 0.01) {
          float lit = sunLight(p);
          vec3 shadowColor = vec3(0.45, 0.5, 0.65);
          vec3 litColor = vec3(1.05, 1.0, 0.95);
          vec3 shade = mix(shadowColor, litColor, lit) * uCloudColor;
          float powder = 1.0 - exp(-d * 3.0);
          shade += powder * 0.12 * litColor * lit;
          float alpha = clamp(d * 0.35, 0.0, 1.0);
          acc.rgb += (1.0 - acc.a) * alpha * shade;
          acc.a += (1.0 - acc.a) * alpha;
          t += 0.12;
        } else {
          t += 0.12 + 0.05 * t;
        }
      }
      return acc;
    }

    // Soft blob shadow under a robot, nudged away from the sun. The fog keeps
    // the light diffuse, so a blurry footprint reads better than a crisp one.
    float spotGroundShade(vec3 gp, vec3 robot) {
      vec2 d = gp.xz - robot.xy;
      float c = cos(robot.z);
      float s = sin(robot.z);
      vec2 local = vec2(c * d.x - s * d.y, s * d.x + c * d.y);
      float contact = length(local / vec2(0.5, 0.26));
      vec2 sunShift = -SUN_DIR.xz / SUN_DIR.y * 0.45;
      vec2 ds = d - sunShift;
      vec2 localSun = vec2(c * ds.x - s * ds.y, s * ds.x + c * ds.y);
      float castDist = length(localSun / vec2(0.6, 0.3));
      float shade = 1.0 - 0.45 * (1.0 - smoothstep(0.3, 1.2, contact));
      shade *= 1.0 - 0.3 * (1.0 - smoothstep(0.4, 1.4, castDist));
      return shade;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

      vec3 forward = vec3(sin(uYaw) * cos(uPitch), sin(uPitch), cos(uYaw) * cos(uPitch));
      vec3 level = normalize(vec3(cos(uYaw), 0.0, -sin(uYaw)));
      vec3 sky = cross(forward, level);
      // Rolling the basis about the view axis is what lets the arm camera tip
      // the horizon over; it stays zero for the free camera.
      vec3 right = cos(uRoll) * level - sin(uRoll) * sky;
      vec3 up = cos(uRoll) * sky + sin(uRoll) * level;
      vec3 ro = uCamPos;
      vec3 rd = normalize(forward + uv.x * right + uv.y * up);

      // A pale, washed-out sky: the horizon is the same haze color that
      // distant ground fades into, so there's no visible edge to the world.
      vec3 haze = mix(vec3(0.66, 0.71, 0.77), uCloudColor * vec3(0.72, 0.75, 0.8), 0.3);
      vec3 skyTop = vec3(0.42, 0.55, 0.72);
      vec3 col = mix(haze, skyTop, smoothstep(-0.02, 0.8, rd.y));
      float sunAmt = pow(clamp(dot(rd, SUN_DIR), 0.0, 1.0), 8.0);
      col += vec3(1.0, 0.9, 0.75) * sunAmt * 0.18;

      float tHit = 1e4;
      vec3 surf = vec3(0.0);

      bool onGround = false;
      vec3 gp = vec3(0.0);
      float robotShade = 1.0;
      if (rd.y < 0.0) {
        float tg = -ro.y / rd.y;
        gp = ro + rd * tg;
        float grain = noise(gp * 2.5) * 0.6 + noise(gp * 11.0) * 0.4;
        vec3 ground = mix(vec3(0.24, 0.27, 0.25), vec3(0.34, 0.36, 0.33), grain);
        robotShade = mix(1.0, spotGroundShade(gp, uSpotA) * spotGroundShade(gp, uSpotB), uSpotLoaded);
        surf = ground * (0.5 + 0.5 * SUN_DIR.y) * robotShade;
        tHit = tg;
        onGround = true;
      }

      bool onRobot = false;
      vec4 spot = texture2D(uSpotTex, gl_FragCoord.xy / uResolution);
      if (uSpotLoaded > 0.5 && spot.a > 0.0) {
        float ts = spot.a * SPOT_MAX_DIST;
        if (ts < tHit) {
          surf = spot.rgb;
          tHit = ts;
          onGround = false;
          onRobot = true;
        }
      }

      if (tHit < 1e4) col = mix(haze, surf, exp(-tHit * 0.09));

      vec4 acc = raymarchClouds(ro, rd, tHit);
      col = mix(col, acc.rgb, acc.a);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // 'webgl' is what this playground was written against; the other two are only
  // for browsers that refuse it but hand out one of the aliases.
  const CONTEXT_NAMES = ['webgl', 'experimental-webgl', 'webgl2'];

  function createContext() {
    for (const name of CONTEXT_NAMES) {
      try {
        const ctx = canvas.getContext(name);
        if (ctx) return ctx;
      } catch (e) {
        // A few browsers throw here instead of returning null; try the next.
      }
    }
    return null;
  }

  let gl = null;
  let contextLost = false;
  let uResolution, uTime, uCloudColor, uDensity, uPuffiness, uTurbulence, uHeight;
  let uCamPos, uYaw, uPitch, uRoll;
  let uSpotTex, uSpotLoaded, uSpotA, uSpotB;
  let fogProgram, quadBuffer, quadPosLoc;
  let spot = null;
  // Spot carries the ball; Echo is the one chasing it.
  let spotGait = null;
  let echoGait = null;

  function compileShader(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log || 'Shader compile failed.');
    }
    return sh;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function initGL() {
    const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Program link failed.');
    }
    fogProgram = program;
    gl.useProgram(program);

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    quadPosLoc = gl.getAttribLocation(program, 'aPos');

    uSpotTex = gl.getUniformLocation(program, 'uSpotTex');
    uSpotLoaded = gl.getUniformLocation(program, 'uSpotLoaded');
    uSpotA = gl.getUniformLocation(program, 'uSpotA');
    uSpotB = gl.getUniformLocation(program, 'uSpotB');

    // The fog scene still works if the robot can't be drawn for some reason.
    if (window.createSpotRenderer) {
      try {
        spot = window.createSpotRenderer(gl, 'models/spot.bin?v=1');
      } catch (err) {
        console.warn(err);
      }
    }

    uResolution = gl.getUniformLocation(program, 'uResolution');
    uTime = gl.getUniformLocation(program, 'uTime');
    uCloudColor = gl.getUniformLocation(program, 'uCloudColor');
    uDensity = gl.getUniformLocation(program, 'uDensity');
    uPuffiness = gl.getUniformLocation(program, 'uPuffiness');
    uTurbulence = gl.getUniformLocation(program, 'uTurbulence');
    uHeight = gl.getUniformLocation(program, 'uHeight');
    uCamPos = gl.getUniformLocation(program, 'uCamPos');
    uYaw = gl.getUniformLocation(program, 'uYaw');
    uPitch = gl.getUniformLocation(program, 'uPitch');
    uRoll = gl.getUniformLocation(program, 'uRoll');

    resize();
  }

  const MOVE_SPEED = 2.2;
  const PITCH_LIMIT = 1.4;
  let lastFrameTime = 0;

  function forwardVector() {
    return [
      Math.sin(camera.yaw) * Math.cos(camera.pitch),
      Math.sin(camera.pitch),
      Math.cos(camera.yaw) * Math.cos(camera.pitch),
    ];
  }

  function updateCamera(dt) {
    if (!dt || pov) return;
    const forwardAmt = (keys['w'] || keys['arrowup'] ? 1 : 0) - (keys['s'] || keys['arrowdown'] ? 1 : 0);
    const strafeAmt = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    if (!forwardAmt && !strafeAmt) return;

    const forward = forwardVector();
    const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const dist = MOVE_SPEED * dt;
    camera.pos[0] += (forward[0] * forwardAmt + right[0] * strafeAmt) * dist;
    camera.pos[1] += forward[1] * forwardAmt * dist;
    camera.pos[2] += (forward[2] * forwardAmt + right[2] * strafeAmt) * dist;
    camera.pos[1] = Math.max(MIN_CAMERA_Y, camera.pos[1]);
    touchedAt = clock;
  }

  // A chase runs away from a tripod, so the camera covers it: it keeps its
  // heading on the middle of the pair and holds a working distance, backing
  // off when they come at it and closing when they get away. The dead zone
  // keeps small steps from dragging the view around. Anything the visitor
  // does — a drag, a fly, a pinch — hands the camera over for a few seconds.
  const TRACK_DEAD_ZONE = 0.18;
  const TRACK_RANGE = 2.9;
  const TRACK_EYE = 1.3;
  const HANDOVER = 6;
  // Where the camera wants to stand relative to the way they are running:
  // a cut seen from straight behind is just a robot getting smaller, so it
  // slides around until their line of travel crosses the frame.
  const COVER = { lo: 1.25, hi: 2.6, want: 1.95, rate: 0.5 };

  function trackPair(dt) {
    if (!dt || dragging || pov || !spotGait || !echoGait) return;
    if (clock - touchedAt < HANDOVER) return;
    const mx = (spotGait.state.pos[0] + echoGait.state.pos[0]) / 2;
    const mz = (spotGait.state.pos[2] + echoGait.state.pos[2]) / 2;
    const dx = mx - camera.pos[0];
    const dz = mz - camera.pos[2];
    const flat = Math.hypot(dx, dz);

    // Camera forward is (sin yaw, *, cos yaw).
    if (flat > 0.8) {
      let err = Math.atan2(dx, dz) - camera.yaw;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      if (Math.abs(err) > TRACK_DEAD_ZONE) {
        const aim = err - Math.sign(err) * TRACK_DEAD_ZONE;
        // Well off the side, or behind: that is not a nudge, that is a swing.
        const rate = Math.abs(err) > 0.9 ? 4.2 : 2.6;
        camera.yaw += clamp(aim * rate, -3, 3) * dt;
      }
    }

    // Slide around them when the angle goes bad, at a walking pace so the
    // move reads as coverage rather than the world spinning.
    if (flat > 1.5) {
      const travel = Math.atan2(Math.cos(spotGait.state.yaw), -Math.sin(spotGait.state.yaw));
      const bear = Math.atan2(-dx, -dz);
      let rel = bear - travel;
      while (rel > Math.PI) rel -= 2 * Math.PI;
      while (rel < -Math.PI) rel += 2 * Math.PI;
      const side = rel < 0 ? -1 : 1;
      const mag = Math.abs(rel);
      if (mag < COVER.lo || mag > COVER.hi) {
        // bear points from the pair out to the camera, so the new position is
        // that bearing turned by a step, at the same range.
        const step = clamp(side * COVER.want - rel, -COVER.rate * dt, COVER.rate * dt);
        camera.pos[0] = mx + Math.sin(bear + step) * flat;
        camera.pos[2] = mz + Math.cos(bear + step) * flat;
      }
    }

    // Hold the range along the ground, not along the view axis, so a tilted
    // camera doesn't fly itself into the dirt correcting its distance.
    const gap = flat - TRACK_RANGE;
    if (Math.abs(gap) > 0.6 && flat > 1e-3) {
      const k = clamp(gap * 1.1, -2.6, 2.6) * dt;
      camera.pos[0] += (dx / flat) * k;
      camera.pos[2] += (dz / flat) * k;
    }
    camera.pos[1] += (TRACK_EYE - camera.pos[1]) * (1 - Math.exp(-dt / 1.2));
    // Aim down at them by however much the eye height calls for.
    const want = Math.atan2(0.55 - camera.pos[1], Math.max(2, flat));
    camera.pitch += (want - camera.pitch) * (1 - Math.exp(-dt / 1.2));
  }

  // Pinch spread/pinch on mobile dollies forward/back along the view
  // direction — there's no real "zoom" to give since the FOV is fixed.
  function dollyCamera(amount) {
    touchedAt = clock;
    const forward = forwardVector();
    camera.pos[0] += forward[0] * amount;
    camera.pos[1] += forward[1] * amount;
    camera.pos[2] += forward[2] * amount;
    camera.pos[1] = Math.max(MIN_CAMERA_Y, camera.pos[1]);
  }

  // The shader is a fairly heavy per-pixel raymarch, so it only runs while
  // the canvas is actually scrolled into view and the tab is visible —
  // otherwise it'd burn GPU time continuously from page load onward, which
  // is what made the whole site feel laggy even before scrolling down.
  let looping = false;
  let canvasIntersecting = false;

  function frame(t) {
    if (!looping) return;
    const dt = lastFrameTime ? Math.min((t - lastFrameTime) / 1000, 0.1) : 0;
    lastFrameTime = t;
    updateCamera(dt);
    resize();

    // A cut at close quarters drops the scene into slow motion for a beat and
    // punches the camera. Input keeps running on the wall clock, so dragging
    // never goes sticky while that plays out.
    if (timeScale < 1) timeScale = Math.min(1, timeScale + dt / 0.5);
    if (shake > 0) shake = Math.max(0, shake - dt / 0.3);
    const sim = dt * timeScale;
    clock += sim;

    // The gait solver needs the link lengths out of the model file, so it can
    // only be built once that has landed.
    if (spot && !spotGait && spot.getModel()) {
      spotGait = window.createSpotGait(spot.getModel(), { pos: SPOT_POS, yaw: SPOT_YAW });
      echoGait = window.createSpotGait(spot.getModel(), { pos: ECHO_POS, yaw: SPOT_YAW });
      echoGait.pose.paint = ECHO_PAINT;
      updateEchoLook();
    }

    if (spotGait) tickChase(sim);

    let spotDrawn = false;
    // Spot first: Echo reads off where Spot is this frame. Echo is handed a
    // clock of its own, a few seconds out of step, because the idle arm loop
    // runs off that time directly: on the same clock the two robots wave in
    // perfect sync, which reads as choreography rather than two machines.
    const pose = spotGait ? spotGait.update(sim, clock) : null;
    const echoPose = echoGait ? echoGait.update(sim, clock + ECHO_CLOCK) : null;
    if (echoPose) keepApart();
    trackPair(dt);
    if (pov && echoPose) rideHandCamera(echoPose);

    // The punch is a render-time offset only: the camera the visitor is
    // steering never actually moves, so it settles back exactly where it was.
    const jolt = shake * shake;
    const camYaw = camera.yaw + jolt * 0.024 * Math.sin(t * 0.043);
    const camPitch = camera.pitch + jolt * 0.017 * Math.sin(t * 0.061);
    if (spot) {
      const cy = Math.cos(camYaw);
      const sy = Math.sin(camYaw);
      const cp = Math.cos(camPitch);
      const sp = Math.sin(camPitch);
      const cr = Math.cos(camRoll);
      const sr = Math.sin(camRoll);
      // Same basis the fog shader builds: level/sky from yaw and pitch, then
      // both rolled about the view axis.
      const level = [cy, 0, -sy];
      const sky = [-sp * sy, cp, -sp * cy];
      spotDrawn = spot.render({
        width: canvas.width,
        height: canvas.height,
        poses: [pose, echoPose],
        camera: {
          pos: camera.pos,
          forward: [sy * cp, sp, cy * cp],
          right: [cr * level[0] - sr * sky[0], cr * level[1] - sr * sky[1], cr * level[2] - sr * sky[2]],
          up: [cr * sky[0] + sr * level[0], cr * sky[1] + sr * level[1], cr * sky[2] + sr * level[2]],
        },
      });
    }

    gl.useProgram(fogProgram);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(quadPosLoc);
    gl.vertexAttribPointer(quadPosLoc, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, spot ? spot.texture : null);
    gl.uniform1i(uSpotTex, 0);
    gl.uniform1f(uSpotLoaded, spotDrawn ? 1 : 0);
    const a = pose || { pos: SPOT_POS, yaw: SPOT_YAW };
    const b = echoPose || { pos: ECHO_POS, yaw: SPOT_YAW };
    gl.uniform3f(uSpotA, a.pos[0], a.pos[2], a.yaw);
    gl.uniform3f(uSpotB, b.pos[0], b.pos[2], b.yaw);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, clock);
    gl.uniform3f(uCloudColor, params.color[0], params.color[1], params.color[2]);
    gl.uniform1f(uDensity, params.density);
    gl.uniform1f(uPuffiness, params.puffiness);
    gl.uniform1f(uTurbulence, params.turbulence);
    gl.uniform1f(uHeight, params.height);
    gl.uniform3f(uCamPos, camera.pos[0], camera.pos[1], camera.pos[2]);
    gl.uniform1f(uYaw, camYaw);
    gl.uniform1f(uPitch, camPitch);
    gl.uniform1f(uRoll, camRoll);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }

  function startLoop() {
    if (looping) return;
    looping = true;
    // Fetch the robot mesh only once the playground is actually on screen.
    if (spot) spot.load();
    lastFrameTime = 0;
    requestAnimationFrame(frame);
  }

  function stopLoop() {
    looping = false;
    // Scrolled away or in a background tab: stop making noise about it.
    if (audio && soundOn) audio.stop();
  }

  function syncLoop() {
    if (!contextLost && canvasIntersecting && document.visibilityState !== 'hidden') {
      startLoop();
      if (audio && soundOn) audio.start();
    } else {
      stopLoop();
    }
  }

  function beginDrag(x, y) {
    touchedAt = clock;
    dragging = true;
    lastPointerX = x;
    lastPointerY = y;
  }

  function updateDrag(x, y) {
    if (!dragging) return;
    const dx = x - lastPointerX;
    const dy = y - lastPointerY;
    lastPointerX = x;
    lastPointerY = y;
    camera.yaw -= dx * 0.005;
    camera.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camera.pitch - dy * 0.005));
  }

  function endDrag() {
    dragging = false;
  }

  function touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function setupControls() {
    canvas.addEventListener('mousedown', (evt) => {
      beginDrag(evt.clientX, evt.clientY);
      canvas.focus();
    });
    window.addEventListener('mouseup', endDrag);
    window.addEventListener('mousemove', (evt) => {
      updateDrag(evt.clientX, evt.clientY);
    });

    // Touch: one finger drags to look around, like the mouse. Two fingers
    // pinching moves forward/back — there's no keyboard on a phone, so
    // these two gestures are the only way to explore.
    let pinching = false;
    let lastPinchDist = 0;

    canvas.addEventListener('touchstart', (evt) => {
      if (evt.touches.length === 2) {
        pinching = true;
        dragging = false;
        lastPinchDist = touchDistance(evt.touches);
      } else if (evt.touches.length === 1) {
        pinching = false;
        beginDrag(evt.touches[0].clientX, evt.touches[0].clientY);
      }
      canvas.focus();
    }, { passive: true });
    canvas.addEventListener('touchmove', (evt) => {
      if (pinching && evt.touches.length === 2) {
        evt.preventDefault();
        const dist = touchDistance(evt.touches);
        dollyCamera((dist - lastPinchDist) * 0.012);
        lastPinchDist = dist;
        return;
      }
      if (!pinching && dragging && evt.touches.length === 1) {
        evt.preventDefault();
        const t = evt.touches[0];
        updateDrag(t.clientX, t.clientY);
      }
    }, { passive: false });
    canvas.addEventListener('touchend', (evt) => {
      if (evt.touches.length === 1) {
        // Dropped from two fingers to one — resume look-drag from here.
        pinching = false;
        beginDrag(evt.touches[0].clientX, evt.touches[0].clientY);
      } else if (evt.touches.length === 0) {
        pinching = false;
        endDrag();
      }
    });
    canvas.addEventListener('touchcancel', () => {
      pinching = false;
      endDrag();
    });

    const NAV_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
    canvas.addEventListener('keydown', (evt) => {
      const key = evt.key.toLowerCase();
      if (!NAV_KEYS.has(key)) return;
      evt.preventDefault();
      touchedAt = clock;
      keys[key] = true;
    });
    canvas.addEventListener('keyup', (evt) => {
      keys[evt.key.toLowerCase()] = false;
    });
    canvas.addEventListener('click', () => canvas.focus());
  }

  // --- arm camera ------------------------------------------------------------

  // Mounted on top of the gripper housing, in the wrist link's frame, looking
  // out along it — roughly where Spot's real hand camera sits. The shader's
  // vertical half-angle is atan(0.5), so sitting 34mm above the housing and
  // 50mm behind its front edge leaves the open jaws across the bottom of the
  // frame, which is roughly what a real gripper camera sees of itself.
  const HAND_EYE = [0.185, 0, 0.072];
  const HAND_LINK = 'arm_link_wr1';

  function rideHandCamera(pose) {
    const m = spot && spot.linkTransform(pose, HAND_LINK);
    if (!m) return;
    // Column-major: columns 0-2 are the link axes in the scene, column 3 its origin.
    const len = Math.hypot(m[0], m[1], m[2]) || 1;
    const fx = m[0] / len;
    const fy = m[1] / len;
    const fz = m[2] / len;
    camera.pos[0] = m[12] + m[0] * HAND_EYE[0] + m[4] * HAND_EYE[1] + m[8] * HAND_EYE[2];
    camera.pos[1] = m[13] + m[1] * HAND_EYE[0] + m[5] * HAND_EYE[1] + m[9] * HAND_EYE[2];
    camera.pos[2] = m[14] + m[2] * HAND_EYE[0] + m[6] * HAND_EYE[1] + m[10] * HAND_EYE[2];
    // No pitch clamp here: the drag limit exists to keep you from flipping the
    // free camera, and the arm is allowed to point wherever it likes.
    camera.yaw = Math.atan2(fx, fz);
    camera.pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    // How far the gripper's own up axis has twisted off the level basis.
    const cy = Math.cos(camera.yaw);
    const sy = Math.sin(camera.yaw);
    const cp = Math.cos(camera.pitch);
    const sp = Math.sin(camera.pitch);
    const ulen = Math.hypot(m[8], m[9], m[10]) || 1;
    const ux = m[8] / ulen;
    const uy = m[9] / ulen;
    const uz = m[10] / ulen;
    camRoll = Math.atan2(ux * cy - uz * sy, -ux * sp * sy + uy * cp - uz * sp * cy);
  }

  // The view rides Echo's arm, and Echo holds its camera on Spot, so there is
  // always somebody in the shot.
  function setPov(on) {
    if (on === pov) return;
    pov = on;
    if (pov) {
      parkedCamera = { pos: camera.pos.slice(), yaw: camera.yaw, pitch: camera.pitch };
    } else {
      if (parkedCamera) {
        camRoll = 0;
        camera.pos = parkedCamera.pos;
        camera.yaw = parkedCamera.yaw;
        camera.pitch = parkedCamera.pitch;
        parkedCamera = null;
      }
    }
    updateEchoLook();
    if (povTagEl) povTagEl.hidden = !pov;
    if (povEl) {
      povEl.setAttribute('aria-pressed', pov ? 'true' : 'false');
      povEl.title = pov ? 'Back to the free camera (Esc)' : "Look through Echo's arm camera";
    }
  }

  function setupPov() {
    if (!povEl) return;
    povEl.addEventListener('click', () => {
      setPov(!pov);
      canvas.focus();
    });
    canvas.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape' && pov) {
        evt.preventDefault();
        setPov(false);
      }
    });
  }

  // --- the chase -------------------------------------------------------------

  // Spot carries, Echo chases. Echo closes a little faster than Spot cruises,
  // so it always eventually arrives — and then it has to commit to a dive,
  // which is the moment Spot cuts out from under it. Nothing tags anybody:
  // the drama is entirely in what the dive costs Echo when it misses.
  //
  // Both robots are driven straight from here. spot-gait.js turns a command
  // into feet on the ground and nothing else, so every beat of the chase is a
  // command written on a clock, which is what makes it tunable.

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smoothstep = (t) => t * t * (3 - 2 * t);

  // The middle of the ground the chase is run on.
  const HOME = [SPOT_POS[0], 0, SPOT_POS[2]];

  // Signed angle from where a robot is pointing to the direction (vx, vz),
  // positive toward its left — the way a positive turn rate takes it.
  function bearingFrom(g, vx, vz) {
    const cy = Math.cos(g.state.yaw);
    const sy = Math.sin(g.state.yaw);
    return Math.atan2(vx * sy + vz * cy, vx * cy - vz * sy);
  }

  const spotPoint = () => ({ x: spotGait.state.pos[0], z: spotGait.state.pos[2] });

  // How Spot runs between cuts, before the tempo scales it. The chase keeps
  // the turn rate and the speed for itself; this is everything else.
  const CRUISE = {
    gait: 'trot', speed: 1.45, strafe: 0, turn: 0, height: 0.50, stepHeight: 0.12,
    cadence: 1.05, lean: 0.03, bank: 0, lift: 0, tau: 0.3, arm: 'auto', armAmp: 1,
    label: 'running',
  };
  const cruise = CRUISE;

  const CHASE = {
    speed: 1.9,       // Echo's flat out, which is quicker than Spot cruises
    standoff: 1.7,    // but it settles in at arm's length and paces him there
    lungeAt: 2.15,    // before committing from somewhere inside this
    lungeFor: 0.6,
    lungeSpeed: 2.2,
    carryFor: 0.45,   // how long the dive carries it past before it can brake
    whiffFor: 1.25,
    cooldown: 2.2,    // no second dive straight off the back of one
    beaten: 1.4,      // a dive that never got this close was broken
  };

  const chase = { phase: 'close', t: 0, cool: 0, closest: Infinity };
  let broken = 0;

  // The chase doesn't run at one speed. It drops into a lope where Echo sits
  // off Spot's shoulder and neither commits, winds back up, and now and then
  // breaks into a flat sprint with the feet leaving the ground. Everything
  // typed sets the base that this scales, so "sneak" still sneaks — it just
  // sneaks in waves. `tau` is how long each wind-up takes: dropping back into
  // a lope should sag, opening it up should snap.
  const TEMPO = {
    lope: { scale: 0.42, standoff: 2.7, tau: 1.7, span: [4, 7.5] },
    press: { scale: 1, standoff: 1.7, tau: 1.1, span: [5, 9] },
    burst: { scale: 1.6, standoff: 1.45, tau: 0.45, span: [3, 5] },
  };
  const AFTER = { lope: 'press', press: 'burst', burst: 'lope' };
  const tempo = { phase: 'press', t: 0, span: 7, scale: 1, standoff: 1.7, want: 1, hold: 0 };

  function setTempo(phase) {
    // While the knob is being driven, the scene doesn't get a vote.
    if (tempo.hold > 0) return;
    tempo.phase = phase;
    tempo.t = 0;
    const span = TEMPO[phase].span;
    tempo.span = span[0] + Math.random() * (span[1] - span[0]);
    // Opening it up is where a leap belongs; nothing jumps at a lope.
    if (phase === 'burst' && Math.random() < 0.55 && !move && !queued.length && !pending) {
      queued.push(hurdleMove());
    }
  }

  function tickTempo(dt) {
    if (tempo.hold > 0) {
      tempo.hold -= dt;
      // A knob has to answer straight away or it feels broken.
      tempo.scale += (tempo.want - tempo.scale) * (1 - Math.exp(-dt / 0.3));
      // Whoever is driving, the gear is the gear: name it from the speed so
      // the readout and the automatic phases agree.
      tempo.phase = tempo.scale > 1.3 ? 'burst' : tempo.scale < 0.62 ? 'lope' : 'press';
      tempo.t = 0;
    } else {
      tempo.t += dt;
      if (tempo.t > tempo.span) setTempo(AFTER[tempo.phase]);
      const want = TEMPO[tempo.phase];
      tempo.scale += (want.scale - tempo.scale) * (1 - Math.exp(-dt / want.tau));
    }
    // Echo works closer the harder the chase is being run.
    const gear = clamp((tempo.scale - 0.42) / 1.18, 0, 1);
    tempo.standoff += (2.7 - 1.25 * gear - tempo.standoff) * (1 - Math.exp(-dt / 0.8));
  }

  // --- what Spot does about it ----------------------------------------------

  // A cut is three beats: dip and fake one way, drive off the planted foot
  // the other way, then run out of it. The short tau on the first two is what
  // makes them land as beats instead of easing into each other.
  function jukeMove(side) {
    return { name: side > 0 ? 'cutting left' : 'cutting right', call: side > 0 ? 'cuts left' : 'cuts right', cut: 1, steps: [
      { t: 0.20, cmd: { gait: 'trot', speed: 0.8, strafe: -0.2 * side, turn: -0.4 * side,
        bank: -0.20 * side, height: 0.41, stepHeight: 0.07, cadence: 1.3, tau: 0.10,
        arm: 'stow', label: 'planting' } },
      { t: 0.45, cmd: { gait: 'bound', speed: 0.95, strafe: 1.3 * side, turn: 1.6 * side,
        bank: 0.36 * side, height: 0.44, stepHeight: 0.16, cadence: 1.35, tau: 0.09,
        arm: 'stow', label: 'cutting' } },
      { t: 0.8, cmd: { gait: 'bound', speed: 2.1, strafe: 0, turn: 0.3 * side, bank: 0.1 * side,
        height: 0.50, stepHeight: 0.15, cadence: 1.25, tau: 0.18, arm: 'auto', label: 'breaking away' } },
    ] };
  }

  // Same idea, but it turns its back on Echo and comes off the other side.
  function spinMove(side) {
    return { name: 'spinning', call: 'spins out of it', cut: 1, steps: [
      { t: 0.18, cmd: { gait: 'trot', speed: 0.55, height: 0.42, cadence: 1.2, bank: -0.14 * side,
        tau: 0.10, label: 'planting' } },
      { t: 0.7, cmd: { gait: 'trot', speed: 0.45, turn: 2.7 * side, bank: 0.3 * side, height: 0.44,
        stepHeight: 0.13, cadence: 1.45, tau: 0.10, arm: 'stow', label: 'spinning' } },
      { t: 0.5, cmd: { gait: 'bound', speed: 1.85, turn: 0.2 * side, bank: 0.08 * side, height: 0.50,
        stepHeight: 0.15, cadence: 1.2, tau: 0.2, arm: 'auto', label: 'breaking away' } },
    ] };
  }

  // Straight over the top of the dive instead of around it: gather, leave the
  // ground, absorb the landing, run on.
  function hurdleMove() {
    return { name: 'hurdling', call: 'goes over the top', cut: 1, steps: [
      { t: 0.18, cmd: { gait: 'trot', speed: 0.95, height: 0.39, stepHeight: 0.06, cadence: 1.35,
        lean: -0.06, lift: 0, tau: 0.08, arm: 'stow', label: 'gathering' } },
      { t: 0.42, cmd: { gait: 'bound', speed: 1.85, height: 0.47, stepHeight: 0.18, cadence: 1,
        lean: 0.13, lift: 0.3, tau: 0.07, arm: 'stow', label: 'in the air' } },
      { t: 0.26, cmd: { gait: 'bound', speed: 1.6, height: 0.42, stepHeight: 0.1, cadence: 1.1,
        lean: -0.04, lift: 0, tau: 0.08, label: 'landing' } },
      { t: 0.45, cmd: { gait: 'bound', speed: 1.95, height: 0.50, stepHeight: 0.15, cadence: 1.2,
        lean: 0.05, lift: 0, tau: 0.2, arm: 'auto', label: 'breaking away' } },
    ] };
  }

  // The move being run right now, anything typed to follow it, and a move
  // waiting out Spot's reaction time. Without that last one Spot and Echo
  // move on the very same frame, which reads as choreography rather than as
  // one robot answering the other.
  const REACTION = 0.13;
  let move = null;
  let queued = [];
  let pending = null;

  function startMove(m) {
    move = { steps: m.steps, name: m.name, call: m.call, cut: !!m.cut, i: -1, t: 0 };
    nextBeat();
  }

  function nextBeat() {
    move.i += 1;
    move.t = 0;
    if (move.i >= move.steps.length) {
      move = null;
      return;
    }
    const beat = move.steps[move.i];
    spotGait.setCommand(Object.assign({}, cruise, beat.cmd));
    // The cut itself is the moment worth slowing down for, and only when
    // Echo is close enough that it costs it something.
    if (move.cut && move.i === 1 && !reducedMotion && echoGait) {
      const d = Math.hypot(spotGait.state.pos[0] - echoGait.state.pos[0],
        spotGait.state.pos[2] - echoGait.state.pos[2]);
      if (d < 2.6) {
        timeScale = 0.45;
        shake = 1;
        if (audio) audio.hit('cut');
      }
    }
  }

  // Which way to cut. Away from Echo when it has committed to a side; when it
  // is coming straight up the back there is no wrong answer, so alternate
  // rather than break the same way every time. Either way, never cut so wide
  // that the next ten meters are fog.
  let lastSide = -1;

  function cutSide() {
    const s = spotGait.state;
    const e = echoGait.state;
    const toEcho = bearingFrom(spotGait, e.pos[0] - s.pos[0], e.pos[2] - s.pos[2]);
    let side = Math.abs(toEcho) < 2.3 ? (toEcho > 0 ? -1 : 1) : -lastSide;
    const toHome = bearingFrom(spotGait, HOME[0] - s.pos[0], HOME[2] - s.pos[2]);
    const wide = Math.hypot(s.pos[0] - HOME[0], s.pos[2] - HOME[2]) > 3.2;
    if (wide && Math.abs(toHome) > 0.5 && Math.sign(toHome) !== side) side = Math.sign(toHome);
    lastSide = side;
    return side;
  }

  // Cruising: hold the commanded run, and bend it back toward the middle so
  // the chase keeps happening in front of the camera instead of off in the fog.
  function runSpeed() {
    return cruise.speed * tempo.scale;
  }

  function tickCruise() {
    const s = spotGait.state;
    const dx = HOME[0] - s.pos[0];
    const dz = HOME[2] - s.pos[2];
    const dist = Math.hypot(dx, dz);
    const pull = smoothstep(clamp((dist - 1.8) / 2.4, 0, 1));
    const wander = 0.34 * Math.sin(clock * 0.37) * (1 - pull);
    const inward = bearingFrom(spotGait, dx, dz);
    const speed = runSpeed();
    const turn = speed > 0.15 ? clamp(wander + 1.4 * pull * inward, -1.1, 1.1) : 0;
    // A gait is just what a speed looks like, so there is nothing else to
    // decide: a sprint bounds, a lope walks.
    const gait = speed > 1.5 ? 'bound' : speed > 0.45 ? 'trot' : speed > 0.05 ? 'walk' : 'stand';
    spotGait.setCommand(Object.assign({}, cruise, {
      turn, speed, gait,
      // Feet leave the ground harder the faster it is going.
      stepHeight: cruise.stepHeight * (0.85 + 0.55 * tempo.scale),
    }));
  }

  function tickSpot(dt) {
    tickTempo(dt);
    if (pending) {
      pending.t -= dt;
      if (pending.t <= 0) {
        startMove(pending.m);
        pending = null;
      }
    }
    if (!move && queued.length) startMove(queued.shift());
    if (!move) {
      tickCruise();
      return;
    }
    move.t += dt;
    if (move.t >= move.steps[move.i].t) nextBeat();
  }

  // --- what Echo does about it ----------------------------------------------

  function tickEcho(dt, dist, aim) {
    if (chase.cool > 0) chase.cool -= dt;
    chase.t += dt;

    if (chase.phase === 'lunge') {
      chase.closest = Math.min(chase.closest, dist);
      if (chase.t < CHASE.lungeFor) return;
      // The dive is spent. Whether it was worth it is just how close it got.
      chase.phase = 'whiff';
      chase.t = 0;
      chase.cool = CHASE.cooldown;
      if (chase.closest > CHASE.beaten) {
        broken += 1;
        setTempo('burst');
        if (audio) audio.hit('broken');
        flash(`${broken === 1 ? 'Broken tackle' : `${broken} broken tackles`} · Echo went past`, 2);
      } else {
        flash('Echo gets a hand on him \u2014 Spot stays up', 1.6);
      }
      return;
    }

    if (chase.phase === 'whiff') {
      // A dive that misses doesn't stop where it missed: Echo is carried past
      // first, and only then gets the feet back under it and turns around.
      const carried = chase.t < CHASE.carryFor;
      echoGait.setCommand({
        gait: carried ? 'bound' : 'trot',
        speed: carried ? 1.5 : 0.35,
        strafe: 0,
        turn: carried ? clamp(0.5 * aim, -0.6, 0.6) : clamp(2.4 * aim, -2.4, 2.4),
        height: carried ? 0.44 : 0.46, stepHeight: carried ? 0.15 : 0.1,
        cadence: carried ? 1.2 : 1, lean: carried ? 0.08 : -0.05, bank: 0,
        tau: carried ? 0.2 : 0.14, arm: 'auto',
        label: carried ? 'carried past' : 'turning back',
      });
      if (chase.t > CHASE.whiffFor) {
        chase.phase = 'close';
        chase.t = 0;
      }
      return;
    }

    // Closing: run at the point Spot is heading for rather than where it is,
    // since a pure tail chase never actually catches up to anything. Inside
    // the standoff it just paces him — everything closer has to be dived for.
    const pace = Math.abs(spotGait.state.speed);
    const flatOut = CHASE.speed * (0.7 + 0.3 * tempo.scale);
    const want = Math.max(0, Math.min(flatOut, pace + 0.75 * (dist - tempo.standoff)))
      * (1 - 0.75 * smoothstep(clamp((Math.abs(aim) - 0.45) / 1.0, 0, 1)));
    echoGait.setCommand({
      gait: want > 1.05 ? 'bound' : want > 0.35 ? 'trot' : 'walk',
      speed: want, strafe: 0, turn: clamp(2.4 * aim, -2.2, 2.2),
      height: 0.48, stepHeight: 0.1 + 0.05 * tempo.scale, cadence: 1.1, lean: 0.05, bank: 0, tau: 0.24,
      arm: 'auto', label: 'chasing',
    });

    // Committed, and it cannot steer out of it — which is what a cut is for.
    if (chase.cool <= 0 && dist < CHASE.lungeAt && Math.abs(aim) < 0.8 && runSpeed() > 0.4) {
      chase.phase = 'lunge';
      chase.t = 0;
      chase.closest = dist;
      echoGait.setCommand({
        gait: 'bound', speed: CHASE.lungeSpeed, strafe: 0, turn: clamp(1.5 * aim, -1.2, 1.2),
        height: 0.42, stepHeight: 0.18, cadence: 1.35, lean: 0.12, bank: 0, tau: 0.10,
        // The arm goes out with the dive, unless somebody is riding it: a
        // camera operator keeps the shot rather than joining in.
        arm: pov ? 'auto' : 'reach', label: 'diving',
      });
      if (audio) audio.hit('dive');
      // Spot sees it coming. A typed move already in flight has the right of
      // way — the visitor's cut beats the automatic one.
      if (!move && !queued.length && !pending) {
        const m = jukeMove(cutSide());
        pending = { m, t: REACTION };
        flash(`Echo dives — Spot ${m.call}`, 1.4);
      }
    }
  }

  function tickChase(dt) {
    const s = spotGait.state;
    const e = echoGait.state;
    const dx = s.pos[0] - e.pos[0];
    const dz = s.pos[2] - e.pos[2];
    const dist = Math.hypot(dx, dz);
    // Echo aims where Spot will be, not where it is.
    const lead = clamp(dist / 3.4, 0, 0.5);
    const aim = bearingFrom(echoGait,
      dx + Math.cos(s.yaw) * s.speed * lead,
      dz - Math.sin(s.yaw) * s.speed * lead);

    tickSpot(dt);
    tickEcho(dt, dist, aim);
    updateStatus(dt, dist);
    if (knobShow) knobShow(paceToKnob(tempo.scale));
    if (audio) audio.update(dt, { intensity: audioIntensity(dist), rate: timeScale });
  }

  // Whatever the chase does, the two bodies never overlap: Echo is stopped at
  // arm's length, which is what makes a dive a near miss instead of a pile-up.
  function keepApart() {
    const a = spotGait.state.pos;
    const b = echoGait.state.pos;
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const d = Math.hypot(dx, dz);
    const MIN_GAP = 1.15;
    if (d >= MIN_GAP) return;
    if (d < 1e-4) {
      dx = 1;
      dz = 0;
    } else {
      dx /= d;
      dz /= d;
    }
    b[0] += dx * (MIN_GAP - d);
    b[2] += dz * (MIN_GAP - d);
    echoGait.pose.pos[0] = b[0];
    echoGait.pose.pos[2] = b[2];
  }

  // Echo holds the camera up on Spot whenever someone is looking through it.
  function updateEchoLook() {
    if (!echoGait) return;
    echoGait.setLook(pov, spotPoint);
  }

  // --- the line under the box ------------------------------------------------

  // Events pin a line for a moment; the rest of the time it is a live readout
  // of how much room Spot has left.
  let pinned = 0;
  let statusAt = 0;

  function flash(msg, hold) {
    pinned = hold || 1.5;
    setStatus(msg);
  }

  function updateStatus(dt, dist) {
    if (pinned > 0) {
      pinned -= dt;
      return;
    }
    statusAt -= dt;
    if (statusAt > 0) return;
    statusAt = 0.25;
    const gear = tempo.phase === 'burst' ? 'flat out'
      : tempo.phase === 'lope' ? 'loping'
      : 'running';
    const doing = move ? move.name
      : runSpeed() < 0.15 ? 'standing'
      : `${gear} at ${spotGait.state.speed.toFixed(1)} m/s`;
    const gap = `Echo ${dist.toFixed(1)} m`;
    const tail = chase.phase === 'lunge' ? 'diving'
      : chase.phase === 'whiff' ? 'turning around'
      : dist < 2.6 ? 'closing' : 'chasing';
    setStatus(`Spot ${doing} · ${gap} ${tail}${broken ? ` · ${broken} broken` : ''}`);
  }

  // --- the deck --------------------------------------------------------------

  // The whole interface is one knob and three pads. The knob is the gear the
  // chase runs in: hold it and you drive, let go and the chase takes itself
  // back a few seconds later. It reads the tempo out the rest of the time, so
  // it turns itself while the scene winds up and down.
  const PACE = { lo: 0.35, hi: 1.85, grab: 8, sens: 150 };

  function paceToKnob(scale) {
    return clamp((scale - PACE.lo) / (PACE.hi - PACE.lo), 0, 1);
  }

  function setPace(v) {
    tempo.want = PACE.lo + clamp(v, 0, 1) * (PACE.hi - PACE.lo);
    tempo.hold = PACE.grab;
  }

  function setupDeck() {
    const knob = document.getElementById('cloud-pace');
    const dial = knob && knob.querySelector('i');

    document.querySelectorAll('[data-move]').forEach((pad) => {
      pad.addEventListener('click', () => {
        if (!spotGait) return;
        const kind = pad.dataset.move;
        const m = kind === 'spin' ? spinMove(cutSide())
          : kind === 'hurdle' ? hurdleMove()
          : jukeMove(cutSide());
        // A pad has to answer on the press. Queueing it behind whatever the
        // chase was already doing means up to a second and a half of nothing
        // followed by a move at a moment nobody asked for, which reads as the
        // button being broken. The call takes over instead.
        pending = null;
        queued.length = 0;
        startMove(m);
        flash(`Spot ${m.call}`, 1.2);
        pad.classList.add('lit');
        setTimeout(() => pad.classList.remove('lit'), 140);
      });
    });

    if (!knob) return;
    let held = null;

    const show = (v) => {
      if (dial) dial.style.transform = `rotate(${-140 + v * 280}deg)`;
      knob.setAttribute('aria-valuenow', Math.round(v * 100));
    };
    knobShow = show;
    show(paceToKnob(tempo.scale));

    knob.addEventListener('pointerdown', (evt) => {
      evt.preventDefault();
      knob.setPointerCapture(evt.pointerId);
      held = { y: evt.clientY, v: paceToKnob(tempo.scale) };
      knob.focus();
    });
    knob.addEventListener('pointermove', (evt) => {
      if (!held) return;
      // Up is faster, which is the way every knob like this has ever worked.
      held.v = clamp(held.v + (held.y - evt.clientY) / PACE.sens, 0, 1);
      held.y = evt.clientY;
      setPace(held.v);
      show(held.v);
    });
    const release = (evt) => {
      if (!held) return;
      held = null;
      if (knob.hasPointerCapture(evt.pointerId)) knob.releasePointerCapture(evt.pointerId);
    };
    knob.addEventListener('pointerup', release);
    knob.addEventListener('pointercancel', release);

    knob.addEventListener('keydown', (evt) => {
      const step = evt.key === 'ArrowUp' || evt.key === 'ArrowRight' ? 0.08
        : evt.key === 'ArrowDown' || evt.key === 'ArrowLeft' ? -0.08
        : evt.key === 'Home' ? -1 : evt.key === 'End' ? 1 : 0;
      if (!step) return;
      evt.preventDefault();
      const v = clamp(paceToKnob(tempo.scale) + step, 0, 1);
      setPace(v);
      show(v);
    });
  }

  // Set once the knob exists; the frame loop turns it while the chase drives.
  let knobShow = null;

  // --- sound -----------------------------------------------------------------

  // Nothing plays until somebody asks for it: browsers block audio without a
  // gesture, and a page that makes noise on its own deserves to be closed.
  let audio = null;
  let soundOn = false;

  function setSound(on) {
    const btn = document.getElementById('cloud-sound');
    if (on && !audio && window.createChaseAudio) {
      try {
        audio = window.createChaseAudio();
      } catch (err) {
        console.warn(err);
      }
    }
    if (on && !audio) return;
    soundOn = on;
    if (audio) {
      if (on) audio.start();
      else audio.stop();
    }
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setupSound() {
    const btn = document.getElementById('cloud-sound');
    if (!btn) return;
    btn.addEventListener('click', () => setSound(!soundOn));
  }

  // How hard the music should be working: the gear the chase is in, leaned on
  // when Echo is close enough to do something about it.
  function audioIntensity(dist) {
    const gear = clamp((tempo.scale - PACE.lo) / (PACE.hi - PACE.lo), 0, 1);
    const near = 1 - smoothstep(clamp((dist - 1.4) / 2.2, 0, 1));
    return clamp(0.65 * gear + 0.35 * near, 0, 1);
  }

  let wired = false;

  // Everything that survives a context loss is hooked up once; initGL() is the
  // part that has to run again on every fresh context.
  function startRenderer() {
    initGL();
    if (wired) return;
    wired = true;
    setupControls();
    setupDeck();
    setupSound();
    setupPov();
    window.addEventListener('resize', resize);
    new IntersectionObserver((entries) => {
      canvasIntersecting = entries[0].isIntersecting;
      syncLoop();
    }, { threshold: 0.01 }).observe(canvas);
    document.addEventListener('visibilitychange', syncLoop);
  }

  // Without preventDefault the browser never bothers to fire 'restored'.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    stopLoop();
    spot = null;
    setStatus('The browser dropped the 3D view — waiting for it to come back…', true);
  });

  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    try {
      startRenderer();
      setStatus('');
      syncLoop();
    } catch (err) {
      setStatus(err.message || 'Could not restart the WebGL renderer.', true);
    }
  });

  // Hand the context back on the way out. Browsers cap how many can be alive at
  // once, so a page that keeps its own on every visit is why the next one fails
  // to get a context at all. A bfcache hide may come straight back, so leave it.
  window.addEventListener('pagehide', (e) => {
    stopLoop();
    if (e.persisted || !gl) return;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  });

  // A browser at its context limit, or one whose GPU process is restarting,
  // returns null for a moment and then recovers — so ask more than once.
  let attempts = 0;

  function tryStart() {
    gl = createContext();
    if (!gl) {
      attempts += 1;
      if (attempts < 3) {
        setTimeout(tryStart, attempts * 400);
        return;
      }
      setStatus('WebGL is not available in this browser.', true);
      return;
    }
    try {
      startRenderer();
    } catch (err) {
      setStatus(err.message || 'Could not start the WebGL renderer.', true);
    }
  }

  tryStart();
});
