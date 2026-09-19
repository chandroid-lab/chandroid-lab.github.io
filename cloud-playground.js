document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('cloud-canvas');
  if (!canvas) return;

  const statusEl = document.getElementById('cloud-status');
  const formEl = document.getElementById('cloud-form');
  const inputEl = document.getElementById('cloud-input');
  const povEl = document.getElementById('cloud-pov');
  const povTagEl = document.getElementById('cloud-povtag');
  const siteEl = document.getElementById('cloud-site');
  const Site = window.FieldSite;

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

  // Where Spot starts on the ground plane (y = 0); the scene is in meters.
  // From here on spot-gait.js owns its pose, and the fog follows it.
  const SPOT_POS = [0.1, 0, 2.35];
  const SPOT_YAW = 2.5;
  const SPOT_MAX_DIST = 20;
  // Echo, the second robot, starts in its place beside Spot (STANDOFF below)
  // facing the same way, in graphite so the two can be told apart at a glance.
  const ECHO_POS = [
    SPOT_POS[0] + 0.2 * Math.cos(SPOT_YAW) - 1.8 * Math.sin(SPOT_YAW), 0,
    SPOT_POS[2] - 0.2 * Math.sin(SPOT_YAW) - 1.8 * Math.cos(SPOT_YAW),
  ];
  const ECHO_PAINT = [0.3, 0.32, 0.35];
  const MAX_PROPS = Site ? Site.MAX_PROPS : 16;

  // A Worker (worker/ in the repo) that asks Gemini to lay out a place it has
  // never heard of. Left empty, only the built-in places exist and nothing
  // leaves the browser.
  const CLOUD_ENDPOINT = '';

  // Starts a few meters back from Spot, roughly at eye level and tilted
  // slightly down toward it.
  const camera = {
    pos: [0, 1.15, 0],
    yaw: 0,
    pitch: -0.14,
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

    // The fog curtain: 0 is the normal scene, 1 has everything but the robots
    // gone behind haze, which is what a change of place happens under.
    uniform float uVeil;

    // Props, packed by field-site.js into a ${MAX_PROPS}x2 texture: row 0 is x, z
    // (5 cm steps around SITE_CENTER) and half extents, row 1 height, kind
    // and shape. A texture rather than uniforms because WebGL only promises
    // sixteen uniform slots to a fragment shader.
    uniform sampler2D uProps;
    uniform float uPropCount;
    const vec2 SITE_CENTER = vec2(${SPOT_POS[0].toFixed(3)}, ${SPOT_POS[2].toFixed(3)});

    float clearingAround(vec3 p, vec3 robot) {
      return mix(0.35, 1.0, smoothstep(0.9, 2.6, length(p - vec3(robot.x, 0.6, robot.y))));
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
      // Thin the fog right around each robot so even the densest phrase
      // leaves it as a silhouette rather than swallowing it whole. The
      // curtain lets most of it back in.
      float clearing = min(clearingAround(p, uSpotA), clearingAround(p, uSpotB));
      clearing = mix(clearing, 1.0, uVeil * 0.6);
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

    // Axis-aligned box standing on the ground. Returns the hit distance, or
    // -1, and the face normal. Starting inside one counts as a miss.
    float boxHit(vec3 ro, vec3 rd, vec2 c, vec2 ext, float h, out vec3 n) {
      vec3 lo = vec3(c.x - ext.x, 0.0, c.y - ext.y);
      vec3 hi = vec3(c.x + ext.x, h, c.y + ext.y);
      vec3 inv = 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-5);
      vec3 t0 = (lo - ro) * inv;
      vec3 t1 = (hi - ro) * inv;
      vec3 tn = min(t0, t1);
      vec3 tf = max(t0, t1);
      float tNear = max(max(tn.x, tn.y), tn.z);
      float tFar = min(min(tf.x, tf.y), tf.z);
      n = vec3(0.0, 1.0, 0.0);
      if (tFar < tNear || tNear <= 0.0) return -1.0;
      if (tNear == tn.x) n = vec3(-sign(rd.x), 0.0, 0.0);
      else if (tNear == tn.z) n = vec3(0.0, 0.0, -sign(rd.z));
      return tNear;
    }

    // Upright cylinder of radius r standing on the ground: side, then lid.
    float cylHit(vec3 ro, vec3 rd, vec2 c, float r, float h, out vec3 n) {
      vec2 oc = ro.xz - c;
      float t = 1e4;
      n = vec3(0.0, 1.0, 0.0);
      float a = dot(rd.xz, rd.xz);
      if (a > 1e-6) {
        float b = dot(oc, rd.xz);
        float disc = b * b - a * (dot(oc, oc) - r * r);
        if (disc >= 0.0) {
          float ts = (-b - sqrt(disc)) / a;
          float y = ro.y + rd.y * ts;
          if (ts > 0.0 && y >= 0.0 && y <= h) {
            t = ts;
            n = vec3((oc.x + rd.x * ts) / r, 0.0, (oc.y + rd.z * ts) / r);
          }
        }
      }
      if (abs(rd.y) > 1e-6) {
        float tc = (h - ro.y) / rd.y;
        vec2 q = oc + rd.xz * tc;
        if (tc > 0.0 && tc < t && dot(q, q) <= r * r) {
          t = tc;
          n = vec3(0.0, 1.0, 0.0);
        }
      }
      return t < 1e4 ? t : -1.0;
    }

    // Kind ids match field-site.js.
    vec3 propColor(float kind, vec3 p) {
      if (kind < 1.5) return vec3(0.5, 0.36, 0.21) * (fract(p.y * 6.0) < 0.1 ? 0.7 : 1.0);
      if (kind < 2.5) return vec3(0.17, 0.3, 0.47) * (abs(fract(p.y * 3.4) - 0.5) < 0.04 ? 0.7 : 1.0);
      if (kind < 3.5) return vec3(0.16, 0.17, 0.18);
      if (kind < 4.5) return vec3(0.45, 0.45, 0.43);
      if (kind < 5.5) return vec3(0.58, 0.46, 0.29);
      if (kind < 6.5) return p.y > 0.24 && p.y < 0.34 ? vec3(0.92, 0.92, 0.88) : vec3(0.95, 0.4, 0.09);
      if (kind < 7.5) return fract(p.y * 1.7) < 0.07 ? vec3(0.9, 0.55, 0.12) : vec3(0.2, 0.32, 0.52);
      if (kind < 8.5) return vec3(0.24, 0.18, 0.13);
      if (kind < 9.5) return vec3(0.37, 0.35, 0.32);
      return vec3(0.55, 0.54, 0.5);
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

      // Props: the nearest one in front of the ground wins, and the ground
      // picks up a contact shadow and a short cast shadow from each.
      float propShade = 1.0;
      for (int i = 0; i < ${MAX_PROPS}; i++) {
        if (float(i) >= uPropCount) break;
        float u = (float(i) + 0.5) / ${MAX_PROPS.toFixed(1)};
        vec4 pa = texture2D(uProps, vec2(u, 0.25));
        vec4 pb = texture2D(uProps, vec2(u, 0.75));
        vec2 c = SITE_CENTER + (pa.rg * 255.0 - 128.0) * 0.05;
        vec2 ext = pa.ba * 2.55;
        float h = pb.r * 2.55;
        bool isRound = pb.b > 0.5;
        vec3 n;
        float t = isRound ? cylHit(ro, rd, c, ext.x, h, n) : boxHit(ro, rd, c, ext, h, n);
        if (t > 0.0 && t < tHit) {
          vec3 p = ro + rd * t;
          vec3 albedo = propColor(floor(pb.g * 255.0 + 0.5), p);
          float diff = max(dot(n, SUN_DIR), 0.0);
          surf = albedo * (0.42 * (0.5 + 0.5 * n.y) + 0.72 * diff);
          // Darker toward the base, where the ground crowds out the sky.
          surf *= mix(0.62, 1.0, smoothstep(0.0, 0.3, p.y));
          tHit = t;
          onGround = false;
        }
        if (onGround) {
          vec2 q = gp.xz - c;
          vec2 qs = q + SUN_DIR.xz / SUN_DIR.y * h * 0.5;
          float contact = isRound ? length(q) - ext.x : length(max(abs(q) - ext, 0.0));
          float castDist = isRound ? length(qs) - ext.x : length(max(abs(qs) - ext, 0.0));
          propShade *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.25, contact));
          propShade *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.7, castDist));
        }
      }
      if (onGround) surf *= propShade;

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

      if (tHit < 1e4) {
        // The curtain is a much thicker haze on everything but the robots,
        // so they keep walking in plain sight while the place goes white.
        float extinction = 0.09 + uVeil * (onRobot ? 0.08 : 1.6);
        col = mix(haze, surf, exp(-tHit * extinction));
        // Their contact shadows stay, so they stand on something instead of
        // floating in the white.
        if (onGround) col *= mix(1.0, robotShade, uVeil * 0.7);
      } else {
        col = mix(col, haze, uVeil);
      }

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
  let uSpotTex, uSpotLoaded, uSpotA, uSpotB, uVeil, uProps, uPropCount;
  let fogProgram, quadBuffer, quadPosLoc, propTex;
  let spot = null;
  // Spot takes the orders; Echo keeps a place relative to it.
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
    uVeil = gl.getUniformLocation(program, 'uVeil');
    uProps = gl.getUniformLocation(program, 'uProps');
    uPropCount = gl.getUniformLocation(program, 'uPropCount');

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

    propTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, propTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MAX_PROPS, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, propBytes);
    gl.activeTexture(gl.TEXTURE0);
    // On a restore this puts the place the visitor was in back, not the default.
    if (Site) applySite(Site.find(siteId) || Site.find('yard'));

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
  }

  // While the robots are walking they would otherwise stroll straight out of
  // frame, so the camera eases its heading to keep the middle of the pair in
  // view. It never moves itself, stops inside a dead zone so small steps don't
  // drag the view around, and a drag always wins.
  const TRACK_DEAD_ZONE = 0.22;

  function trackPair(dt) {
    if (!dt || dragging || pov || !spotGait || !echoGait) return;
    const still = (g) => Math.abs(g.state.speed) < 0.05 && Math.abs(g.state.turn) < 0.05;
    if (still(spotGait) && still(echoGait)) return;
    const dx = (spotGait.state.pos[0] + echoGait.state.pos[0]) / 2 - camera.pos[0];
    const dz = (spotGait.state.pos[2] + echoGait.state.pos[2]) / 2 - camera.pos[2];
    if (Math.hypot(dx, dz) < 1.2) return;
    // Camera forward is (sin yaw, *, cos yaw).
    let err = Math.atan2(dx, dz) - camera.yaw;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    if (Math.abs(err) < TRACK_DEAD_ZONE) return;
    const aim = err - Math.sign(err) * TRACK_DEAD_ZONE;
    camera.yaw += Math.max(-1.2, Math.min(1.2, aim * 2.2)) * dt;
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

    // The gait solver needs the link lengths out of the model file, so it can
    // only be built once that has landed.
    if (spot && !spotGait && spot.getModel()) {
      spotGait = window.createSpotGait(spot.getModel(), { pos: SPOT_POS, yaw: SPOT_YAW });
      echoGait = window.createSpotGait(spot.getModel(), { pos: ECHO_POS, yaw: SPOT_YAW });
      echoGait.pose.paint = ECHO_PAINT;
      spotGait.setObstacles(props);
      echoGait.setObstacles(props);
      setRelation('abreast');
      if (pendingText) {
        applyText(pendingText);
        pendingText = '';
      }
    }

    tickCurtain(dt);
    if (spotGait) {
      tickQueue(dt);
      tickScout(dt);
      tickIdle(dt);
    }

    let spotDrawn = false;
    // Spot first: Echo's target is read off where Spot is this frame.
    const pose = spotGait ? spotGait.update(dt, time) : null;
    const echoPose = echoGait ? echoGait.update(dt, time) : null;
    if (echoPose) keepApart();
    trackPair(dt);
    if (pov && echoPose) rideHandCamera(echoPose);
    if (spot) {
      const cy = Math.cos(camera.yaw);
      const sy = Math.sin(camera.yaw);
      const cp = Math.cos(camera.pitch);
      const sp = Math.sin(camera.pitch);
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
    const v = Math.min(1, Math.max(0, curtain.veil));
    gl.uniform1f(uVeil, v * v * (3 - 2 * v));
    // The robot target may have been resized on unit 0 since last frame, so
    // the props go back on unit 1 every time rather than trusting it.
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, propTex);
    gl.uniform1i(uProps, 1);
    gl.uniform1f(uPropCount, props.length);
    gl.activeTexture(gl.TEXTURE0);
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
  }

  function syncLoop() {
    if (!contextLost && canvasIntersecting && document.visibilityState !== 'hidden') {
      startLoop();
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
      curtain.cut = false;
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

  // --- the pair --------------------------------------------------------------

  // Where Echo keeps itself relative to Spot, in Spot's body frame: meters
  // forward, meters to the left. Far enough that Spot fits in Echo's camera
  // once the arm has reached out toward it. `scout` and `free` have no fixed
  // place.
  const STANDOFF = { follow: [-2.2, 0], abreast: [0.2, -1.8] };
  let relation = 'abreast';
  // The place Echo goes back to after scouting or being told off on its own.
  let pairRelation = 'abreast';
  // While Echo is away looking at a prop: { prop, stage: 'going' | 'looking', t }.
  let scout = null;

  const spotPoint = () => ({ x: spotGait.state.pos[0], z: spotGait.state.pos[2] });

  function echoStandoff() {
    const s = spotGait.state;
    const off = STANDOFF[relation] || STANDOFF[pairRelation];
    const fx = Math.cos(s.yaw);
    const fz = -Math.sin(s.yaw);
    const x = s.pos[0] + fx * off[0] + Math.sin(s.yaw) * off[1];
    const z = s.pos[2] + fz * off[0] + Math.cos(s.yaw) * off[1];
    return {
      x, z, radius: 0.3,
      speed: s.speed, turn: s.turn, yaw: s.yaw, gait: spotGait.command.gait,
      // Parked, it looks the way Spot looks.
      faceX: x + fx * 3, faceZ: z + fz * 3,
    };
  }

  // A point just clear of the prop, on whichever side the robot is coming from.
  function propApproach(g, prop) {
    return () => {
      let dx = g.state.pos[0] - prop.x;
      let dz = g.state.pos[2] - prop.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const reach = (prop.round ? prop.hx : Math.abs(dx) * prop.hx + Math.abs(dz) * prop.hz) + 0.62;
      return { x: prop.x + dx * reach, z: prop.z + dz * reach, radius: 0.3, faceX: prop.x, faceZ: prop.z, prop };
    };
  }

  function partnerOf(g) {
    const other = g === spotGait ? echoGait : spotGait;
    return () => ({ x: other.state.pos[0], z: other.state.pos[2], radius: 1.1 });
  }

  function nearestProp(g, kind, minDist) {
    let best = null;
    let bestD = Infinity;
    props.forEach((p) => {
      if (kind && p.kind !== kind) return;
      const d = Math.hypot(p.x - g.state.pos[0], p.z - g.state.pos[2]);
      if (d >= (minDist || 0) && d < bestD) {
        best = p;
        bestD = d;
      }
    });
    return best;
  }

  function setRelation(rel) {
    scout = null;
    relation = rel;
    if (rel === 'follow' || rel === 'abreast') {
      pairRelation = rel;
      echoGait.setTarget(echoStandoff);
    } else if (rel === 'free') {
      echoGait.setTarget(null);
      echoGait.setCommand({ gait: 'stand', speed: 0, strafe: 0, turn: 0, label: 'standing' });
    }
    updateEchoLook();
  }

  function startScout(prop) {
    if (!prop) return false;
    setRelation('scout');
    scout = { prop, stage: 'going', t: 0 };
    echoGait.setTarget(propApproach(echoGait, prop));
    return true;
  }

  function tickScout(dt) {
    if (!scout) return;
    scout.t += dt;
    if (scout.stage === 'going' && (echoGait.arrived() || scout.t > 14)) {
      scout.stage = 'looking';
      scout.t = 0;
      updateEchoLook();
    } else if (scout.stage === 'looking' && scout.t > 3.5) {
      setRelation(pairRelation);
      if (statusEl && statusEl.textContent.includes('Echo scouting')) {
        setStatus(statusEl.textContent.replace(/Echo scouting the \w+/, echoSays()));
      }
    }
  }

  // Echo's arm holds the camera up whenever someone might be looking through
  // it: at the prop it is scouting, otherwise at Spot.
  function updateEchoLook() {
    if (!echoGait) return;
    if (scout && scout.stage === 'looking') {
      const prop = scout.prop;
      echoGait.setLook(true, () => ({ x: prop.x, z: prop.z }));
    } else if (pov || curtain.phase !== 'open') {
      echoGait.setLook(true, spotPoint);
    } else {
      echoGait.setLook(false);
    }
  }

  // Whatever the servo does, the two bodies never overlap; Echo gives way.
  function keepApart() {
    const a = spotGait.state.pos;
    const b = echoGait.state.pos;
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    const d = Math.hypot(dx, dz);
    const MIN_GAP = 0.95;
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

  function echoSays() {
    if (scout) return `Echo scouting the ${scout.prop.kind}`;
    if (relation === 'follow') return 'Echo following';
    if (relation === 'abreast') return 'Echo alongside';
    return `Echo ${echoGait.hasTarget() ? 'heading off' : echoGait.describe(echoGait.command)}`;
  }

  // --- places and the fog curtain -------------------------------------------

  const propBytes = new Uint8Array(MAX_PROPS * 2 * 4);
  let props = [];
  let siteId = null;
  let siteTitle = '';

  function applySite(site) {
    const keepOut = [];
    [spotGait || { state: { pos: SPOT_POS } }, echoGait || { state: { pos: ECHO_POS } }].forEach((g) => {
      keepOut.push({ x: g.state.pos[0], z: g.state.pos[2], r: 0.8 });
    });
    const eye = parkedCamera ? parkedCamera.pos : camera.pos;
    if (eye[1] < 2.2) keepOut.push({ x: eye[0], z: eye[2], r: 0.8 });
    props = Site.place(site, SPOT_POS, keepOut);
    siteId = site.id;
    siteTitle = site.title;
    Site.pack(props, SPOT_POS, propBytes);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, propTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAX_PROPS, 2, gl.RGBA, gl.UNSIGNED_BYTE, propBytes);
    gl.activeTexture(gl.TEXTURE0);
    if (siteEl) siteEl.textContent = site.props.length ? site.title : '';
    if (spotGait) {
      spotGait.setObstacles(props);
      echoGait.setObstacles(props);
      // Nobody keeps walking toward a prop that is no longer there.
      if (scout) setRelation(pairRelation);
      if (spotGait.hasTarget()) spotGait.setTarget(null);
      if (relation === 'free' && echoGait.hasTarget()) echoGait.setTarget(null);
    }
  }

  // Changing place happens behind the fog. It closes over everything but the
  // robots, the view cuts to Echo's arm camera on Spot, the props change while
  // nothing can be seen, the fog lifts on the new place from Echo's side, and
  // then the view cuts back. A place that has to be asked for (a promise)
  // keeps the fog closed until it answers, or until patience runs out.
  const CURTAIN = { close: 0.7, hold: 0.5, lift: 1.6, linger: 1.4, patience: 9 };
  const curtain = { phase: 'open', t: 0, veil: 0, site: null, ready: false, error: null, cut: false, token: 0 };
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawCurtain(siteOrPromise) {
    const token = ++curtain.token;
    curtain.site = null;
    curtain.ready = false;
    curtain.error = null;
    Promise.resolve(siteOrPromise).then((site) => {
      if (token !== curtain.token) return;
      curtain.site = site;
      curtain.ready = true;
    }, (err) => {
      if (token !== curtain.token) return;
      curtain.error = err;
      curtain.ready = true;
    });
    if (curtain.phase !== 'closing' && curtain.phase !== 'closed') {
      // From wherever the veil already is, so a second place mid-lift
      // doesn't snap.
      curtain.phase = 'closing';
      curtain.t = curtain.veil * CURTAIN.close;
    }
    updateEchoLook();
  }

  function curtainBusy() {
    return curtain.phase === 'closing' || curtain.phase === 'closed';
  }

  function tickCurtain(dt) {
    if (curtain.phase === 'open') return;
    curtain.t += dt;
    if (curtain.phase === 'closing') {
      curtain.veil = Math.min(1, curtain.t / CURTAIN.close);
      if (curtain.veil >= 1) {
        curtain.phase = 'closed';
        curtain.t = 0;
        if (!pov && !reducedMotion && spotGait) {
          setPov(true);
          curtain.cut = true;
        }
      }
    } else if (curtain.phase === 'closed') {
      if ((curtain.ready && curtain.t > CURTAIN.hold) || curtain.t > CURTAIN.patience) {
        if (curtain.site) {
          applySite(curtain.site);
          if (statusEl && statusEl.textContent.startsWith('Looking for')) setStatus('');
        } else {
          setStatus(curtain.error && curtain.error.message
            ? curtain.error.message
            : 'The fog came back empty \u2014 staying here.', true);
        }
        curtain.token++;
        curtain.phase = 'lifting';
        curtain.t = 0;
      }
    } else if (curtain.phase === 'lifting') {
      curtain.veil = Math.max(0, 1 - curtain.t / CURTAIN.lift);
      if (curtain.veil <= 0) {
        curtain.phase = 'lingering';
        curtain.t = 0;
      }
    } else if (curtain.phase === 'lingering' && curtain.t > CURTAIN.linger) {
      curtain.phase = 'open';
      if (curtain.cut) setPov(false);
      updateEchoLook();
    }
  }

  // Places nobody built in: a Gemini call through the worker, one at a time
  // and not too often, remembered for the rest of the visit.
  const asked = new Map();
  let lastAskAt = -Infinity;
  const ASK_COOLDOWN = 15;

  function askForPlace(text) {
    const key = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    if (asked.has(key)) return asked.get(key);
    lastAskAt = clock;
    const request = fetch(CLOUD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 60) }),
    })
      .then((res) => res.json().catch(() => ({})).then((body) => {
        if (!res.ok) throw new Error(body.error || 'Could not reach the field server \u2014 staying here.');
        const site = Site.fromReply(body);
        if (!site) throw new Error('That place came back empty \u2014 staying here.');
        return site;
      }));
    asked.set(key, request);
    request.catch(() => asked.delete(key));
    return request;
  }

  // --- text -> the pair ------------------------------------------------------

  // Parsing lives in the gait solver, so a phrase typed before the model has
  // landed waits here and runs the moment the solver exists.
  let pendingText = '';

  // One phrase can be several steps: "walk to the crates, stop, then wave".
  // Never on a bare "and", which too often joins one instruction.
  const SPLIT = /\s*(?:[,;]|\band then\b|\bthen\b|\bafter that\b|그리고|그 ?다음에?|다음에)\s*/i;
  const NAMES = [
    { who: 'both', re: /\b(both( of you)?|you two|the two of you|the pair|everyone)\b|둘 ?다|둘이|모두/i },
    { who: 'echo', re: /\becho\b|에코/i },
    { who: 'spot', re: /\bspot\b|스팟/i },
  ];
  // What Echo does relative to Spot. Stripped before the gait parser sees
  // the words, since "come back" would read as backing up and "stay side by
  // side" as standing still.
  const RELATIONS = [
    { rel: 'follow', re: /\b(follow(ing)?( me| him| it| spot| along)?|tag along|fall in behind|get behind)\b|따라/i },
    { rel: 'abreast', re: /\b(side by side|abreast|alongside|next to (each other|spot)|together)\b|나란히|옆에서|함께/i },
    { rel: 'scout', re: /\b(scout( ahead)?|explore|go look|check (it|that) out)\b|정찰|탐색|살펴/i },
    { rel: 'regroup', re: /\b(regroup|come back|come here|return|back to spot|rejoin)\b|돌아와|모여|이리 ?와|합류/i },
    { rel: 'free', re: /\b(split up|separate(ly)?|on your own|go your own way|alone)\b|흩어|따로|혼자/i },
  ];
  const LOOK = /\bwhat (do|can|did) (you|they|we) see\b|\bwhat'?s (there|around|out there|in front)\b|\bdescribe\b|\blook around\b|뭐가 ?보|뭐 ?보여|무엇이 ?보|보이는 ?(게|것)|주변 ?(을 ?)?설명/i;
  const TO_WORD = /\b(?:over |up )?(?:to|toward|towards)\s+(?:the |a |an |that |this |your |each )?([a-z]+)/i;
  const KO_TO = /([가-힣]+?)(쪽으로|한테로|에게로|한테|에게|으로|까지|로|에)(?=\s|$)/g;
  const PARTNER = /^(other|partner|friend|echo|spot|에코|스팟|친구|서로)$/i;

  // One clause into steps. ctx carries who is being addressed from one clause
  // to the next, so "Echo, trot, then stop" is all Echo.
  function readClause(clause, ctx) {
    let text = ` ${clause} `;
    const steps = [];

    if (LOOK.test(text)) return [{ look: true }];

    // The first robot named is the one being talked to; a second one named
    // is who it's talking about.
    let first = null;
    NAMES.forEach((n) => {
      const m = text.match(n.re);
      if (m && (!first || m.index < first.index)) first = { who: n.who, index: m.index };
    });
    if (first) ctx.who = first.who;
    const who = ctx.who;

    let relation = null;
    RELATIONS.forEach((r) => {
      if (!relation && r.re.test(text)) {
        relation = r.rel;
        text = text.replace(r.re, ' ');
      }
    });

    // "to the crates", "상자로": a prop kind, or the other robot.
    let to = null;
    const en = text.match(TO_WORD);
    if (en) {
      const kind = Site.kindOf(en[1]);
      if (kind) to = { kind };
      else if (PARTNER.test(en[1])) to = { partner: true };
      if (to) text = text.replace(en[0], ' ');
    }
    if (!to) {
      let m;
      KO_TO.lastIndex = 0;
      while (!to && (m = KO_TO.exec(text))) {
        const kind = Site.kindOf(m[1]);
        if (kind) to = { kind };
        else if (PARTNER.test(m[1])) to = { partner: true };
        if (to) text = text.replace(m[0], ' ');
      }
    }

    const place = Site.match(text);
    if (place) text = text.replace(place.words, ' ');
    NAMES.forEach((n) => { text = text.replace(n.re, ' '); });

    let cmd = text.trim() ? spotGait.parse(text) : null;
    if (to && (!cmd || cmd.gait === 'stand')) {
      cmd = Object.assign(cmd || {}, { gait: 'walk', speed: 0.55, label: 'walking' });
    }

    if (place) steps.push({ site: place });
    if (to && to.kind && !place && !props.some((p) => p.kind === to.kind)) {
      const home = Site.withKind(to.kind);
      if (home) steps.push({ site: home });
    }
    if (relation) steps.push({ who, relation, to });
    else if (to || cmd) steps.push({ who, cmd, to });

    // A bare name is an address, not an instruction.
    if (!steps.length && first && !text.replace(/[^\p{L}\p{N}]/gu, '')) return [];
    return steps.length ? steps : null;
  }

  function styleOf(cmd) {
    return {
      gait: cmd.gait, height: cmd.height, stepHeight: cmd.stepHeight, cadence: cmd.cadence,
      lean: cmd.lean, label: cmd.label, speed: 0, strafe: 0, turn: 0,
    };
  }

  // Starts a step and returns when it is done, as a function of how long it
  // has been running. The last step of a phrase is never done: it is what the
  // pair keeps doing.
  function runStep(step) {
    if (step.look) {
      setStatus(describeView());
      return () => true;
    }
    if (step.site) {
      drawCurtain(step.site);
      return () => !curtainBusy();
    }

    const who = step.who || 'spot';
    if (step.relation) {
      if (step.relation === 'scout') {
        const prop = step.to && step.to.kind ? nearestProp(echoGait, step.to.kind) : nearestProp(echoGait, null, 1.2);
        if (!startScout(prop)) setStatus('Nothing out here to scout \u2014 name a place first, like "warehouse".');
        else setStatus(`Spot ${spotGait.describe(spotGait.command)} \u00b7 ${echoSays()}`);
        return () => !scout || scout.stage === 'looking';
      }
      setRelation(step.relation === 'regroup' ? pairRelation : step.relation);
      setStatus(`Spot ${spotGait.describe(spotGait.command)} \u00b7 ${echoSays()}`);
      return (t) => relation === 'free' || echoGait.arrived() || t > 4;
    }

    const cmd = step.cmd;
    if (who === 'echo') {
      relation = 'free';
      scout = null;
      if (cmd) echoGait.setCommand(cmd);
      if (step.to) {
        const prop = step.to.kind && nearestProp(echoGait, step.to.kind);
        if (step.to.partner) setRelation(pairRelation);
        else if (prop) echoGait.setTarget(propApproach(echoGait, prop));
        else echoGait.setTarget(null);
      } else {
        echoGait.setTarget(null);
      }
      updateEchoLook();
      setStatus(step.to && step.to.kind
        ? `Echo heading to the ${step.to.kind} \u00b7 Spot ${spotGait.describe(spotGait.command)}`
        : `${echoSays()} \u00b7 Spot ${spotGait.describe(spotGait.command)}`);
      return (t) => (step.to ? echoGait.arrived() || t > 15 : t > (cmd && cmd.gait !== 'stand' ? 3 : 1.2));
    }

    // Spot, or both: Spot does it and Echo comes along the way it was.
    if (who === 'both' && relation !== 'follow' && relation !== 'abreast') setRelation(pairRelation);
    if (cmd) spotGait.setCommand(cmd);
    if (relation !== 'free' && cmd) echoGait.setCommand(styleOf(cmd));
    if (!step.to) {
      spotGait.setTarget(null);
      setStatus(`Spot ${spotGait.describe(spotGait.command)} \u00b7 ${echoSays()}`);
      return (t) => t > (cmd && cmd.gait !== 'stand' ? 3 : 1.2);
    }
    const going = spotGait.command.label && spotGait.command.label !== 'standing' ? spotGait.command.label : 'walking';
    if (step.to.partner) {
      spotGait.setTarget(partnerOf(spotGait));
      setStatus(`Spot ${going} over to Echo`);
      // Once there it stops for good: left pointed at Echo, it would turn
      // after Echo forever while Echo walks around to its own place.
      return (t) => {
        if (!spotGait.arrived() && t < 15) return false;
        spotGait.setTarget(null);
        spotGait.setCommand({ gait: 'stand', speed: 0, strafe: 0, turn: 0, label: 'standing' });
        return true;
      };
    }
    const prop = nearestProp(spotGait, step.to.kind);
    spotGait.setTarget(prop ? propApproach(spotGait, prop) : null);
    setStatus(prop ? `Spot ${going} to the ${prop.kind} \u00b7 ${echoSays()}` : `No ${Site.KINDS[step.to.kind].many} here.`);
    return (t) => spotGait.arrived() || !spotGait.hasTarget() || t > 15;
  }

  let queue = [];
  let current = null;

  function tickQueue(dt) {
    if (current && !current.finished) {
      current.t += dt;
      // The last step keeps running once done; only a step with more after it
      // makes way.
      if (current.done(current.t)) {
        current.finished = true;
        if (queue.length) current = null;
      }
    }
    while (!current && queue.length) {
      const step = queue.shift();
      current = { t: 0, done: runStep(step) };
      if (queue.length && current.done(0)) current = null;
    }
  }

  function applyText(text) {
    idle = null;
    typedAt = clock;
    touchedAt = clock;
    const ctx = { who: 'spot' };
    const steps = [];
    const unknown = [];
    text.split(SPLIT).map((c) => c.trim()).filter(Boolean).forEach((clause) => {
      const got = readClause(clause, ctx);
      if (got) steps.push(...got);
      else unknown.push(clause);
    });

    // Only a phrase that names something no built-in place has goes out to
    // the model, and never more than once every few seconds.
    if (unknown.length && CLOUD_ENDPOINT && !steps.some((s) => s.site)) {
      const ask = unknown.join(' ');
      if (/[a-z]{3,}|[가-힣]{2,}/i.test(ask)) {
        if (clock - lastAskAt < ASK_COOLDOWN) {
          setStatus('One new place at a time \u2014 give the fog a few seconds.');
          return;
        }
        steps.unshift({ site: askForPlace(ask) });
        setStatus(`Looking for \u201c${ask}\u201d\u2026`);
      }
    }
    if (!steps.length && !unknown.length) {
      const name = ctx.who === 'echo' ? 'Echo' : ctx.who === 'both' ? 'Both' : 'Spot';
      setStatus(`${name} listening \u2014 say what to do, like "${name.toLowerCase()}, trot forward".`);
      return;
    }
    if (!steps.length) {
      setStatus('Not sure what that means \u2014 try "trot forward", "follow", "go to the crates", or a place like "warehouse".', true);
      return;
    }
    queue = steps;
    current = null;
    tickQueue(0);
  }

  function setupPrompt() {
    if (!formEl || !inputEl) return;
    formEl.addEventListener('submit', (evt) => {
      evt.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;
      if (!spotGait) {
        pendingText = text;
        setStatus('Waiting for the robots to load\u2026');
        return;
      }
      applyText(text);
    });
  }

  // --- what the camera sees --------------------------------------------------

  // Answered from where things are, not from pixels: every robot and prop is
  // projected into the current camera and read off left to right.
  function describeView() {
    if (curtain.veil > 0.5) return 'Nothing but fog right now.';
    const fwd = forwardVector();
    const right = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
    const halfWidth = 0.5 * canvas.width / canvas.height;
    const seen = [];
    const consider = (name, x, y, z, group) => {
      const v = [x - camera.pos[0], y - camera.pos[1], z - camera.pos[2]];
      const depth = v[0] * fwd[0] + v[1] * fwd[1] + v[2] * fwd[2];
      if (depth < 0.3) return;
      const across = (v[0] * right[0] + v[2] * right[2]) / depth;
      const dist = Math.hypot(v[0], v[2]);
      if (Math.abs(across) > halfWidth * 1.05 || dist > 9.5) return;
      const side = across < -halfWidth / 3 ? 'on the left' : across > halfWidth / 3 ? 'on the right' : 'ahead';
      seen.push({ name, dist, side, group });
    };
    consider('Spot', spotGait.pose.pos[0], 0.5, spotGait.pose.pos[2]);
    if (!pov) consider('Echo', echoGait.pose.pos[0], 0.5, echoGait.pose.pos[2]);
    props.forEach((p) => consider(p.kind, p.x, p.h / 2, p.z, true));

    const parts = [];
    seen.filter((s) => !s.group).forEach((s) => parts.push(`${s.name} ${s.dist.toFixed(1)} m ${s.side}`));
    const groups = {};
    seen.filter((s) => s.group).forEach((s) => {
      const key = `${s.name}|${s.side}`;
      if (!groups[key] || groups[key].dist > s.dist) groups[key] = { ...s, n: (groups[key] ? groups[key].n : 0) + 1 };
      else groups[key].n += 1;
    });
    Object.values(groups).sort((a, b) => a.dist - b.dist).forEach((g) => {
      const kind = Site.KINDS[g.name];
      parts.push(`${g.n > 1 ? `${g.n} ${kind.many}` : kind.one} ${g.side}, ${g.dist.toFixed(1)} m`);
    });
    const from = pov ? 'Echo cam' : 'From here';
    return parts.length ? `${from}: ${parts.join(' \u00b7 ')}` : `${from}: just fog and open ground.`;
  }

  // --- when nobody is typing -------------------------------------------------

  // Most visitors never type, so the pair keeps itself busy: a slow stroll
  // with Echo alongside, a stop while Echo scouts the nearest prop, a rest,
  // and now and then a change of place, which only happens while nobody has
  // touched the canvas for a while, so it never yanks the view from under a
  // drag.
  const IDLE_START = 8;
  const IDLE_AFTER_TYPING = 40;
  const PLACE_EVERY = 2;
  let clock = 0;
  let typedAt = -Infinity;
  let touchedAt = -Infinity;
  let idle = null;
  let idleRounds = 0;

  const IDLE_STAGES = [
    { name: 'stroll', enter: () => {
      setRelation(pairRelation);
      spotGait.setTarget(null);
      const cmd = { gait: 'walk', speed: 0.35, turn: 0.2, height: 0.5, stepHeight: 0.09, cadence: 1, lean: 0, arm: 'auto', label: 'strolling' };
      spotGait.setCommand(cmd);
      echoGait.setCommand(styleOf(cmd));
    }, done: (t) => t > 12 },
    { name: 'pause', enter: () => {
      const cmd = { gait: 'stand', speed: 0, turn: 0, strafe: 0, label: 'standing' };
      spotGait.setCommand(cmd);
      echoGait.setCommand(styleOf(cmd));
    }, done: (t) => t > 2.5 },
    { name: 'scout', enter: () => startScout(nearestProp(echoGait, null, 1.2)), done: (t) => !scout || t > 20 },
    { name: 'rest', enter: () => {}, done: (t) => t > 5 },
    { name: 'place', enter: () => {
      idleRounds += 1;
      const quiet = clock - touchedAt > 20 && !pov && !reducedMotion;
      if (quiet && idleRounds % PLACE_EVERY === 0) drawCurtain(Site.next(siteId));
    }, done: () => curtain.phase === 'open' },
  ];

  function tickIdle(dt) {
    clock += dt;
    if (!idle) {
      const wait = typedAt > -Infinity ? typedAt + IDLE_AFTER_TYPING : IDLE_START;
      if (clock < wait || current && queue.length || curtainBusy()) return;
      idle = { stage: -1, t: 0 };
      queue = [];
      current = null;
    }
    idle.t += dt;
    const stage = IDLE_STAGES[idle.stage];
    if (!stage || stage.done(idle.t)) {
      idle.stage = (idle.stage + 1) % IDLE_STAGES.length;
      idle.t = 0;
      IDLE_STAGES[idle.stage].enter();
    }
  }

  let wired = false;

  // Everything that survives a context loss is hooked up once; initGL() is the
  // part that has to run again on every fresh context.
  function startRenderer() {
    initGL();
    if (wired) return;
    wired = true;
    setupControls();
    setupPrompt();
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
