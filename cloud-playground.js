document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('cloud-canvas');
  if (!canvas) return;

  const apiKeyInput = document.getElementById('cloud-api-key');
  const saveKeyBtn = document.getElementById('cloud-save-key-btn');
  const textInput = document.getElementById('cloud-text');
  const generateBtn = document.getElementById('cloud-generate-btn');
  const statusEl = document.getElementById('cloud-status');
  const descriptionEl = document.getElementById('cloud-description');

  const STORAGE_KEY = 'cloud-playground-gemini-key';
  // "-latest" alias so this doesn't 404 as Google retires dated model snapshots.
  const MODEL = 'gemini-flash-latest';

  try {
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) apiKeyInput.value = savedKey;
  } catch (e) {
    // localStorage unavailable (private mode, etc.) — key just won't persist.
  }

  let params = {
    color: [1, 1, 1],
    density: 0.72,
    puffiness: 0.68,
    turbulence: 0.3,
    height: 0.65,
  };

  // Mirrors the bandCenter mix() in the shader's cloudDensity() — used so
  // the camera can start out sitting inside the cloud layer.
  const CLOUD_BAND_MIN = 1.2;
  const CLOUD_BAND_MAX = 3.5;
  const startY = CLOUD_BAND_MIN + params.height * (CLOUD_BAND_MAX - CLOUD_BAND_MIN);

  const camera = {
    pos: [0, startY, 0],
    yaw: 0,
    pitch: 0,
  };
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
      float bandCenter = mix(1.2, 3.5, uHeight);
      float band = 1.0 - smoothstep(0.8, 1.8, abs(p.y - bandCenter));
      return clamp(base, 0.0, 1.0) * band;
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

    vec4 raymarchClouds(vec3 ro, vec3 rd) {
      vec4 acc = vec4(0.0);
      float t = 0.0;
      for (int i = 0; i < 72; i++) {
        if (acc.a > 0.99 || t > 11.0) break;
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

    const float OCEAN_Y = -4.0;

    // A distant mountain range, drawn purely from the ray's world-space
    // azimuth so it reads as an infinitely-far backdrop behind the sea.
    vec3 mountainLayer(vec3 col, vec3 rd) {
      float az = atan(rd.z, rd.x);
      float ridge = 0.05 * sin(az * 2.3 + 1.0)
                  + 0.03 * sin(az * 5.1 + 4.0)
                  + 0.018 * sin(az * 11.0 + 2.0);
      float horizonLevel = -0.015 + ridge;
      float mask = smoothstep(horizonLevel + 0.02, horizonLevel - 0.015, rd.y);
      vec3 near = vec3(0.42, 0.48, 0.62);
      vec3 far = vec3(0.72, 0.78, 0.88);
      vec3 mountainColor = mix(near, far, clamp((rd.y - horizonLevel) / 0.25 + 0.5, 0.0, 1.0));
      return mix(col, mountainColor, mask);
    }

    // Ray/plane hit against a sine-waved sea, with a sun glint and
    // distance fog so it fades into the sky instead of cutting off.
    vec3 oceanLayer(vec3 col, vec3 ro, vec3 rd, vec3 skyBottom) {
      if (rd.y >= -0.02 || ro.y <= OCEAN_Y) return col;
      float tOcean = (OCEAN_Y - ro.y) / rd.y;
      if (tOcean <= 0.0 || tOcean > 60.0) return col;

      vec3 p = ro + rd * tOcean;
      float wave = sin(p.x * 0.9 + uTime * 0.6) + sin(p.z * 1.3 - uTime * 0.8 + p.x * 0.4);
      vec3 deepSea = vec3(0.02, 0.13, 0.29);
      vec3 shallowSea = vec3(0.10, 0.36, 0.46);
      vec3 seaColor = mix(deepSea, shallowSea, clamp(wave * 0.25 + 0.5, 0.0, 1.0));

      vec3 waveNormal = normalize(vec3(
        -cos(p.x * 0.9 + uTime * 0.6) * 0.9 * 0.15,
        1.0,
        -cos(p.z * 1.3 - uTime * 0.8 + p.x * 0.4) * 1.3 * 0.15
      ));
      vec3 reflectDir = reflect(-SUN_DIR, waveNormal);
      float spec = pow(clamp(dot(reflectDir, -rd), 0.0, 1.0), 60.0);
      seaColor += vec3(1.0, 0.9, 0.7) * spec * 1.5;

      float fog = clamp(tOcean / 34.0, 0.0, 1.0);
      return mix(seaColor, skyBottom, fog);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;

      vec3 skyTop = vec3(0.10, 0.35, 0.80);
      vec3 skyBottom = vec3(0.55, 0.75, 0.98);
      vec3 col = mix(skyBottom, skyTop, clamp(uv.y + 0.5, 0.0, 1.0));

      vec3 forward = vec3(sin(uYaw) * cos(uPitch), sin(uPitch), cos(uYaw) * cos(uPitch));
      vec3 right = normalize(vec3(cos(uYaw), 0.0, -sin(uYaw)));
      vec3 up = cross(forward, right);
      vec3 ro = uCamPos;
      vec3 rd = normalize(forward + uv.x * right + uv.y * up);

      float sunAmt = pow(clamp(dot(rd, SUN_DIR), 0.0, 1.0), 8.0);
      col += vec3(1.0, 0.85, 0.6) * sunAmt * 0.35;

      col = mountainLayer(col, rd);
      col = oceanLayer(col, ro, rd, skyBottom);

      vec4 acc = raymarchClouds(ro, rd);
      col = mix(col, acc.rgb, acc.a);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const gl = canvas.getContext('webgl');
  let uResolution, uTime, uCloudColor, uDensity, uPuffiness, uTurbulence, uHeight;
  let uCamPos, uYaw, uPitch;

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
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

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
  }

  // Pinch spread/pinch on mobile dollies forward/back along the view
  // direction — there's no real "zoom" to give since the FOV is fixed.
  function dollyCamera(amount) {
    const forward = forwardVector();
    camera.pos[0] += forward[0] * amount;
    camera.pos[1] += forward[1] * amount;
    camera.pos[2] += forward[2] * amount;
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
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uTime, t * 0.001);
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

  function clamp01(v) {
    v = Number(v);
    if (!isFinite(v)) return 0.5;
    return Math.min(1, Math.max(0, v));
  }

  function hexToRgb(hex) {
    if (typeof hex !== 'string') return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  async function callGemini(apiKey, text) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const schema = {
      type: 'object',
      properties: {
        description: { type: 'string' },
        colorHex: { type: 'string' },
        density: { type: 'number' },
        puffiness: { type: 'number' },
        turbulence: { type: 'number' },
        height: { type: 'number' },
      },
      required: ['description', 'colorHex', 'density', 'puffiness', 'turbulence', 'height'],
    };

    const prompt = `A visitor typed this short phrase: "${text}"\n\n` +
      'Imagine it as a single cloud floating in a blue sky, and respond with JSON only:\n' +
      '- description: one vivid sentence (max ~25 words) picturing this cloud.\n' +
      '- colorHex: a hex color (e.g. "#ffffff") for the cloud body, from stormy grey to sunlit white or pink, matching the mood.\n' +
      '- density: 0 to 1, how thick and opaque the cloud is.\n' +
      '- puffiness: 0 to 1, how large and rounded (1) versus wispy and fine-grained (0) the shapes are.\n' +
      '- turbulence: 0 to 1, how chaotic and stormy (1) versus calm and smooth (0) it looks.\n' +
      '- height: 0 to 1, how high (1) or low (0) the cloud mass sits in frame.';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      }),
    });

    if (!res.ok) {
      if (res.status === 400 || res.status === 403) {
        throw new Error('Gemini rejected the request — check your API key.');
      }
      if (res.status === 404) {
        throw new Error('Gemini model not found for this key — it may not have Gemini API access enabled yet.');
      }
      if (res.status === 429) {
        throw new Error('Gemini rate limit hit — try again in a moment.');
      }
      throw new Error(`Gemini request failed (${res.status}).`);
    }

    const data = await res.json();
    const raw = data && data.candidates && data.candidates[0]
      && data.candidates[0].content && data.candidates[0].content.parts
      && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    if (!raw) throw new Error('Gemini returned an empty response.');
    return JSON.parse(raw);
  }

  async function generateCloud() {
    const text = (textInput.value || '').trim();
    const apiKey = (apiKeyInput.value || '').trim();

    if (!text) {
      setStatus('Type a short phrase first.', true);
      return;
    }
    if (text.length > 20) {
      setStatus('Keep it to 20 characters or fewer.', true);
      return;
    }
    if (!apiKey) {
      setStatus('Enter your Gemini API key.', true);
      return;
    }
    if (!gl) {
      setStatus('WebGL is not available in this browser.', true);
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, apiKey);
    } catch (e) {
      // localStorage unavailable — key just won't persist across visits.
    }

    generateBtn.disabled = true;
    descriptionEl.hidden = true;
    setStatus('Asking Gemini to imagine a cloud...', false);

    try {
      const result = await callGemini(apiKey, text);
      params = {
        color: hexToRgb(result.colorHex) || params.color,
        density: clamp01(result.density),
        puffiness: clamp01(result.puffiness),
        turbulence: clamp01(result.turbulence),
        height: clamp01(result.height),
      };
      if (result.description) {
        descriptionEl.textContent = result.description;
        descriptionEl.hidden = false;
      }
      setStatus('', false);
    } catch (err) {
      setStatus(err.message || 'Something went wrong talking to Gemini.', true);
    } finally {
      generateBtn.disabled = false;
    }
  }

  generateBtn.addEventListener('click', generateCloud);
  textInput.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') generateCloud();
  });

  saveKeyBtn.addEventListener('click', () => {
    const apiKey = (apiKeyInput.value || '').trim();
    if (!apiKey) {
      setStatus('Enter a key to save.', true);
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, apiKey);
      setStatus('API key saved in this browser.', false);
    } catch (e) {
      setStatus('Could not save the key (local storage unavailable).', true);
    }
  });
});
