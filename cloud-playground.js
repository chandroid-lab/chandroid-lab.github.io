document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('cloud-canvas');
  if (!canvas) return;

  const statusEl = document.getElementById('cloud-status');

  // Visitors used to paste their own Gemini key; drop any copy left behind.
  try {
    localStorage.removeItem('cloud-playground-gemini-key');
  } catch (e) {
    // localStorage unavailable (private mode, etc.) — nothing to clean up.
  }

  const params = {
    color: [1, 1, 1],
    density: 0.6,
    puffiness: 0.68,
    turbulence: 0.3,
    height: 0.2,
  };

  // Spot stands on the ground plane (y = 0); the scene is in meters.
  const SPOT_POS = [0.1, 0, 2.35];
  const SPOT_YAW = 2.5;
  const SPOT_MAX_DIST = 20;

  // Starts a few meters back from Spot, roughly at eye level and tilted
  // slightly down toward it.
  const camera = {
    pos: [0, 1.15, 0],
    yaw: 0,
    pitch: -0.14,
  };
  const MIN_CAMERA_Y = 0.15;
  const keys = Object.create(null);
  let dragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

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
    uniform vec3 uSpotPos;
    uniform float uSpotYaw;
    const float SPOT_MAX_DIST = ${SPOT_MAX_DIST.toFixed(1)};

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
      // Thin the fog right around Spot so even the densest phrase leaves
      // the robot as a silhouette rather than swallowing it whole.
      float clearing = mix(0.35, 1.0, smoothstep(0.9, 2.6, length(p - uSpotPos - vec3(0.0, 0.6, 0.0))));
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

    // Soft blob shadow under Spot, nudged away from the sun. The fog keeps
    // the light diffuse, so a blurry footprint reads better than a crisp one.
    float spotGroundShade(vec3 gp) {
      vec2 d = gp.xz - uSpotPos.xz;
      float c = cos(uSpotYaw);
      float s = sin(uSpotYaw);
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
      vec3 right = normalize(vec3(cos(uYaw), 0.0, -sin(uYaw)));
      vec3 up = cross(forward, right);
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

      if (rd.y < 0.0) {
        float tg = -ro.y / rd.y;
        vec3 gp = ro + rd * tg;
        float grain = noise(gp * 2.5) * 0.6 + noise(gp * 11.0) * 0.4;
        vec3 ground = mix(vec3(0.24, 0.27, 0.25), vec3(0.34, 0.36, 0.33), grain);
        surf = ground * (0.5 + 0.5 * SUN_DIR.y) * mix(1.0, spotGroundShade(gp), uSpotLoaded);
        tHit = tg;
      }

      vec4 spot = texture2D(uSpotTex, gl_FragCoord.xy / uResolution);
      if (uSpotLoaded > 0.5 && spot.a > 0.0) {
        float ts = spot.a * SPOT_MAX_DIST;
        if (ts < tHit) {
          surf = spot.rgb;
          tHit = ts;
        }
      }

      if (tHit < 1e4) {
        col = mix(haze, surf, exp(-tHit * 0.09));
      }

      vec4 acc = raymarchClouds(ro, rd, tHit);
      col = mix(col, acc.rgb, acc.a);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const gl = canvas.getContext('webgl');
  let uResolution, uTime, uCloudColor, uDensity, uPuffiness, uTurbulence, uHeight;
  let uCamPos, uYaw, uPitch;
  let uSpotTex, uSpotLoaded, uSpotPos, uSpotYaw;
  let fogProgram, quadBuffer, quadPosLoc;
  let spot = null;

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
    uSpotPos = gl.getUniformLocation(program, 'uSpotPos');
    uSpotYaw = gl.getUniformLocation(program, 'uSpotYaw');

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

    resize();
    window.addEventListener('resize', resize);
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
    if (!dt) return;
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
  }

  // Pinch spread/pinch on mobile dollies forward/back along the view
  // direction — there's no real "zoom" to give since the FOV is fixed.
  function dollyCamera(amount) {
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
    const time = t * 0.001;

    let spotDrawn = false;
    if (spot) {
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch);
      const sp = Math.sin(camera.pitch);
      // Same basis as the fog shader: up = cross(forward, right).
      spotDrawn = spot.render({
        width: canvas.width,
        height: canvas.height,
        time,
        spotPos: SPOT_POS,
        spotYaw: SPOT_YAW,
        camera: {
          pos: camera.pos,
          forward: [sy * cp, sp, cy * cp],
          right: [cy, 0, -sy],
          up: [-sp * sy, cp, -sp * cy],
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
    gl.uniform3f(uSpotPos, SPOT_POS[0], SPOT_POS[1], SPOT_POS[2]);
    gl.uniform1f(uSpotYaw, SPOT_YAW);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, time);
    gl.uniform3f(uCloudColor, params.color[0], params.color[1], params.color[2]);
    gl.uniform1f(uDensity, params.density);
    gl.uniform1f(uPuffiness, params.puffiness);
    gl.uniform1f(uTurbulence, params.turbulence);
    gl.uniform1f(uHeight, params.height);
    gl.uniform3f(uCamPos, camera.pos[0], camera.pos[1], camera.pos[2]);
    gl.uniform1f(uYaw, camera.yaw);
    gl.uniform1f(uPitch, camera.pitch);
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
  }

  function syncLoop() {
    if (canvasIntersecting && document.visibilityState !== 'hidden') {
      startLoop();
    } else {
      stopLoop();
    }
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
      keys[key] = true;
    });
    canvas.addEventListener('keyup', (evt) => {
      keys[evt.key.toLowerCase()] = false;
    });
    canvas.addEventListener('click', () => canvas.focus());
  }

  if (!gl) {
    setStatus('WebGL is not available in this browser.', true);
  } else {
    try {
      initGL();
      setupControls();

      new IntersectionObserver((entries) => {
        canvasIntersecting = entries[0].isIntersecting;
        syncLoop();
      }, { threshold: 0.01 }).observe(canvas);
      document.addEventListener('visibilitychange', syncLoop);
    } catch (err) {
      setStatus(err.message || 'Could not start the WebGL renderer.', true);
    }
  }
});
