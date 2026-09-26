// The playground with the robots taken out: open ground under a pale sky, and
// fog rolling across it on the wind. Drag to look, keys or a pinch to walk.
// The robot chase lives on in cloud-playground.js, just not on the page.
document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('cloud-canvas');
  if (!canvas) return;

  const statusEl = document.getElementById('cloud-status');

  // Eye level, looking across the wind so the fog crosses the frame instead
  // of coming straight at you, tipped a little toward the ground.
  const camera = {
    pos: [0, 1.55, 0],
    yaw: 0,
    pitch: -0.12,
  };
  const MIN_CAMERA_Y = 0.15;
  const MOVE_SPEED = 2.2;
  const PITCH_LIMIT = 1.4;
  const keys = Object.create(null);
  let dragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  // The wind is the only thing moving here, so asking for less motion slows
  // it to a crawl rather than stopping the scene dead.
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const WIND_RATE = reducedMotion ? 0.25 : 1;
  let clock = 0;

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
    uniform vec3 uCamPos;
    uniform float uYaw;
    uniform float uPitch;

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

    // Octaves past the first few are finer than a pixel of this canvas, so
    // each caller asks only for the detail it can actually show.
    float fbm(vec3 p, int octaves) {
      float f = 0.0;
      float amp = 0.5;
      for (int i = 0; i < 6; i++) {
        if (i >= octaves) break;
        f += amp * noise(p);
        p *= 2.03;
        amp *= 0.5;
      }
      return f;
    }

    const vec3 SUN_DIR = normalize(vec3(0.4, 0.65, -0.35));
    // Meters per second. Across the default view, left to right, with a
    // little drift toward the camera.
    const vec3 WIND = vec3(0.34, 0.0, -0.1);

    // fine is false for the shadow probes, which only need a bank's broad
    // shape, not its ragged edge.
    float fogDensity(vec3 p, bool fine) {
      // Sampling upwind of p is what carries the whole field downwind.
      vec3 q = (p - WIND * uTime) * 0.92;
      // The warp churns the banks as they travel, so they change shape
      // instead of sliding past like a painted backdrop.
      q += 0.3 * vec3(
        fbm(q * 0.7 + uTime * 0.12, 3),
        fbm(q * 0.7 - uTime * 0.08, 3),
        0.0
      );
      float base = fbm(q, fine ? 5 : 3) - 0.35;
      // Small bites out of the edges, so a bank has a ragged front. The
      // shadow probes take the bites' average instead.
      base -= fine ? 0.15 * (1.0 - fbm(q * 4.0 + 7.3, 3)) : 0.08;
      // Lies on the ground: thickest below the shoulder, gone a couple of
      // meters up, so rising out of it shows the top of the bank.
      float layer = 1.0 - smoothstep(0.8, 1.8, abs(p.y - 0.96));
      // A pocket of thinner air travels with you. Without it, standing inside
      // the bank is a white screen; with it, the murk opens a few steps out.
      float pocket = mix(0.12, 1.0, smoothstep(0.6, 3.8, length(p - uCamPos)));
      return clamp(base, 0.0, 1.0) * layer * pocket;
    }

    // Marches a short hop toward the sun to see how much denser the fog gets
    // in that direction — a cheap stand-in for real self-shadowing.
    float sunLight(vec3 p) {
      float shadow = 0.0;
      vec3 pos = p;
      for (int i = 0; i < 3; i++) {
        pos += SUN_DIR * 0.22;
        shadow += fogDensity(pos, false);
      }
      return clamp(1.0 - shadow * 0.85, 0.05, 1.0);
    }

    // tMax is the distance to the ground, so fog behind it doesn't bleed
    // through.
    vec4 marchFog(vec3 ro, vec3 rd, float tMax) {
      vec4 acc = vec4(0.0);
      float t = 0.0;
      float tEnd = min(14.0, tMax);
      for (int i = 0; i < 80; i++) {
        if (acc.a > 0.99 || t > tEnd) break;
        vec3 p = ro + rd * t;
        float d = fogDensity(p, true);
        if (d > 0.01) {
          float lit = sunLight(p);
          vec3 shadowColor = vec3(0.47, 0.52, 0.64);
          vec3 litColor = vec3(1.04, 1.0, 0.95);
          vec3 shade = mix(shadowColor, litColor, lit);
          shade += (1.0 - exp(-d * 3.0)) * 0.12 * litColor * lit;
          float alpha = clamp(d * 0.3, 0.0, 1.0);
          acc.rgb += (1.0 - acc.a) * alpha * shade;
          acc.a += (1.0 - acc.a) * alpha;
          t += 0.12;
        } else {
          t += 0.12 + 0.05 * t;
        }
      }
      return acc;
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

      vec3 forward = vec3(sin(uYaw) * cos(uPitch), sin(uPitch), cos(uYaw) * cos(uPitch));
      vec3 right = normalize(vec3(cos(uYaw), 0.0, -sin(uYaw)));
      vec3 up = cross(forward, right);
      vec3 ro = uCamPos;
      vec3 rd = normalize(forward + uv.x * right + uv.y * up);

      // The horizon is the same haze the far ground fades into, so the world
      // has no edge; past the marched fog, that haze is the fog.
      vec3 haze = vec3(0.7, 0.74, 0.79);
      vec3 skyTop = vec3(0.46, 0.57, 0.72);
      vec3 col = mix(haze, skyTop, smoothstep(-0.02, 0.8, rd.y));
      float sunAmt = pow(clamp(dot(rd, SUN_DIR), 0.0, 1.0), 8.0);
      col += vec3(1.0, 0.9, 0.75) * sunAmt * 0.18;

      float tHit = 1e4;
      if (rd.y < 0.0) {
        float tg = -ro.y / rd.y;
        vec3 gp = ro + rd * tg;
        float grain = noise(gp * 2.5) * 0.6 + noise(gp * 11.0) * 0.4;
        vec3 ground = mix(vec3(0.24, 0.27, 0.25), vec3(0.34, 0.36, 0.33), grain);
        ground *= 0.5 + 0.5 * SUN_DIR.y;
        col = mix(haze, ground, exp(-tg * 0.13));
        tHit = tg;
      }

      vec4 acc = marchFog(ro, rd, tHit);
      col = mix(col, acc.rgb, acc.a);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // 'webgl' is what this was written against; the other two are only for
  // browsers that refuse it but hand out one of the aliases.
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
  let uResolution, uTime, uCamPos, uYaw, uPitch;

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

  // Fog is soft to begin with, so it's drawn at half the canvas's CSS size and
  // stretched to fit: a quarter of the pixels (a ninth on a retina screen) for
  // a picture that looks the same.
  const RENDER_SCALE = 0.5;

  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * RENDER_SCALE));
    const h = Math.max(1, Math.round(canvas.clientHeight * RENDER_SCALE));
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
    gl.useProgram(program);

    // One triangle that covers the screen; the shader does the rest.
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    uResolution = gl.getUniformLocation(program, 'uResolution');
    uTime = gl.getUniformLocation(program, 'uTime');
    uCamPos = gl.getUniformLocation(program, 'uCamPos');
    uYaw = gl.getUniformLocation(program, 'uYaw');
    uPitch = gl.getUniformLocation(program, 'uPitch');

    resize();
  }

  function forwardVector() {
    return [
      Math.sin(camera.yaw) * Math.cos(camera.pitch),
      Math.sin(camera.pitch),
      Math.cos(camera.yaw) * Math.cos(camera.pitch),
    ];
  }

  function moveCamera(forwardAmt, strafeAmt, dist) {
    const forward = forwardVector();
    const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    camera.pos[0] += (forward[0] * forwardAmt + right[0] * strafeAmt) * dist;
    camera.pos[1] += forward[1] * forwardAmt * dist;
    camera.pos[2] += (forward[2] * forwardAmt + right[2] * strafeAmt) * dist;
    camera.pos[1] = Math.max(MIN_CAMERA_Y, camera.pos[1]);
  }

  function updateCamera(dt) {
    const forwardAmt = (keys['w'] || keys['arrowup'] ? 1 : 0) - (keys['s'] || keys['arrowdown'] ? 1 : 0);
    const strafeAmt = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    if (forwardAmt || strafeAmt) moveCamera(forwardAmt, strafeAmt, MOVE_SPEED * dt);
  }

  // The shader is a fairly heavy per-pixel raymarch, so it only runs while
  // the canvas is scrolled into view and the tab is visible — otherwise it
  // burns GPU time from page load onward and the whole site feels laggy.
  let looping = false;
  let canvasIntersecting = false;
  let lastFrameTime = 0;
  // Wind this slow reads as smooth at 30 frames a second, and every frame
  // skipped is a whole raymarch the GPU doesn't have to do. The 2 ms of slack
  // keeps a 60 Hz screen on every other vsync instead of drifting off it.
  const FRAME_INTERVAL = 1000 / 30 - 2;

  function frame(t) {
    if (!looping) return;
    if (lastFrameTime && t - lastFrameTime < FRAME_INTERVAL) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = lastFrameTime ? Math.min((t - lastFrameTime) / 1000, 0.1) : 0;
    lastFrameTime = t;
    clock += dt * WIND_RATE;
    updateCamera(dt);
    resize();

    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, clock);
    gl.uniform3f(uCamPos, camera.pos[0], camera.pos[1], camera.pos[2]);
    gl.uniform1f(uYaw, camera.yaw);
    gl.uniform1f(uPitch, camera.pitch);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }

  function startLoop() {
    if (looping) return;
    looping = true;
    lastFrameTime = 0;
    requestAnimationFrame(frame);
  }

  function stopLoop() {
    looping = false;
  }

  function syncLoop() {
    if (!contextLost && canvasIntersecting && document.visibilityState !== 'hidden') startLoop();
    else stopLoop();
  }

  function beginDrag(x, y) {
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
    // pinching walks forward/back — there's no keyboard on a phone, so these
    // two gestures are the only way to explore.
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
        moveCamera(1, 0, (dist - lastPinchDist) * 0.012);
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
      keys[key] = true;
    });
    canvas.addEventListener('keyup', (evt) => {
      keys[evt.key.toLowerCase()] = false;
    });
    // Tabbing away mid-keypress never delivers the keyup.
    canvas.addEventListener('blur', () => {
      for (const k in keys) keys[k] = false;
    });
    canvas.addEventListener('click', () => canvas.focus());
  }

  let wired = false;

  // Everything that survives a context loss is hooked up once; initGL() is the
  // part that has to run again on every fresh context.
  function startRenderer() {
    initGL();
    if (wired) return;
    wired = true;
    setupControls();
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
