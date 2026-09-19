// Draws the real Spot + Arm meshes (RAI Institute's spot_description, baked by
// tools/build_spot.py into models/spot.bin) into an offscreen texture: RGB is
// the lit surface color, alpha is the distance from the camera / MAX_DIST.
// The fog shader in cloud-playground.js composites that texture, so fog in
// front of the robot covers it and fog behind it doesn't. The pose comes from
// outside (spot-gait.js); this file only puts the links where it says.
window.createSpotRenderer = function (gl, url) {
  const MAX_DIST = 20.0;
  const NEAR = 0.05;
  const FAR = 50.0;

  const VERT_SRC = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    attribute float aMat;
    uniform mat4 uModel;
    uniform vec3 uMin;
    uniform vec3 uSpan;
    uniform vec3 uCamPos;
    uniform vec3 uCamRight;
    uniform vec3 uCamUp;
    uniform vec3 uCamFwd;
    uniform float uAspect;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vMat;

    void main() {
      vec3 local = uMin + (aPos + 32768.0) / 65535.0 * uSpan;
      vec4 world = uModel * vec4(local, 1.0);
      vWorld = world.xyz;
      vNormal = (uModel * vec4(aNormal, 0.0)).xyz;
      vMat = aMat;

      // Same pinhole camera the fog shader builds its rays from:
      // rd = forward + uv.x * right + uv.y * up, uv.y spanning -0.5..0.5.
      vec3 d = world.xyz - uCamPos;
      float z = dot(d, uCamFwd);
      gl_Position = vec4(
        2.0 * dot(d, uCamRight) / uAspect,
        2.0 * dot(d, uCamUp),
        z * ${((FAR + NEAR) / (FAR - NEAR)).toFixed(6)} - ${((2 * FAR * NEAR) / (FAR - NEAR)).toFixed(6)},
        z
      );
    }
  `;

  const FRAG_SRC = `
    precision highp float;
    uniform vec3 uCamPos;
    // The body paint, so two robots in the same scene can be told apart.
    uniform vec3 uPaint;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vMat;

    const vec3 SUN_DIR = normalize(vec3(0.4, 0.65, -0.35));
    const vec3 SPOT_DARK = vec3(0.09, 0.09, 0.1);

    void main() {
      vec3 n = normalize(vNormal);
      vec3 v = normalize(uCamPos - vWorld);
      // Meshes are drawn double-sided; face the normal toward the viewer.
      if (dot(n, v) < 0.0) n = -n;

      bool yellow = vMat > 0.5;
      vec3 albedo = yellow ? uPaint : SPOT_DARK;
      float diff = max(dot(n, SUN_DIR), 0.0);
      float sky = 0.5 + 0.5 * n.y;
      float spec = pow(max(dot(n, normalize(SUN_DIR + v)), 0.0), yellow ? 48.0 : 24.0);
      float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
      vec3 col = albedo * (0.42 * sky + 0.7 * diff)
        + vec3(1.0, 0.97, 0.9) * spec * diff * (yellow ? 0.35 : 0.2)
        + vec3(0.7, 0.75, 0.8) * rim * 0.08;

      float dist = length(vWorld - uCamPos);
      gl_FragColor = vec4(col, clamp(dist / ${MAX_DIST.toFixed(1)}, 1.0 / 255.0, 1.0));
    }
  `;

  // --- 4x4 column-major matrix helpers -------------------------------------

  function mul(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  }

  function axisAngle(axis, angle) {
    const [x, y, z] = axis;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    return new Float32Array([
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ]);
  }

  // --- GL setup --------------------------------------------------------------

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'Spot shader compile failed.');
    }
    return sh;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'Spot program link failed.');
  }

  const attr = {
    pos: gl.getAttribLocation(program, 'aPos'),
    normal: gl.getAttribLocation(program, 'aNormal'),
    mat: gl.getAttribLocation(program, 'aMat'),
  };
  const uni = {};
  ['uModel', 'uMin', 'uSpan', 'uCamPos', 'uCamRight', 'uCamUp', 'uCamFwd', 'uAspect', 'uPaint'].forEach((name) => {
    uni[name] = gl.getUniformLocation(program, name);
  });

  // 32-bit indices are an extension in WebGL 1 and core in WebGL 2, where the
  // extension is gone; without this check a WebGL 2 context would quietly drop
  // every mesh part that needs them.
  const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const hasUint32 = isGL2 || !!gl.getExtension('OES_element_index_uint');

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const depth = gl.createRenderbuffer();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  let fboWidth = 0;
  let fboHeight = 0;

  function resizeTarget(w, h) {
    if (w === fboWidth && h === fboHeight) return;
    fboWidth = w;
    fboHeight = h;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --- Model loading ---------------------------------------------------------

  let meshes = null;
  let chain = null;
  // The baked kinematics, handed to the gait solver once the model is in.
  let model = null;
  let loading = false;

  function parse(buffer) {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== 'SPT1') throw new Error('Unexpected Spot model format.');
    const headerLen = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
    const base = 8 + headerLen;

    chain = header.chain.map((j) => ({ ...j, origin: new Float32Array(j.origin) }));
    model = {
      footZ: header.footZ,
      standPose: header.standPose,
      legs: header.legs,
      chain,
    };
    meshes = header.meshes
      .filter((m) => !m.index32 || hasUint32)
      .map((m) => {
        const n = m.vertexCount;
        const makeBuffer = (target, data) => {
          const b = gl.createBuffer();
          gl.bindBuffer(target, b);
          gl.bufferData(target, data, gl.STATIC_DRAW);
          return b;
        };
        const IndexArray = m.index32 ? Uint32Array : Uint16Array;
        return {
          link: m.link,
          min: m.min,
          span: m.span,
          count: m.indexCount,
          indexType: m.index32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
          pos: makeBuffer(gl.ARRAY_BUFFER, new Int16Array(buffer, base + m.position, n * 3)),
          normal: makeBuffer(gl.ARRAY_BUFFER, new Int8Array(buffer, base + m.normal, n * 3)),
          mat: makeBuffer(gl.ARRAY_BUFFER, new Uint8Array(buffer, base + m.material, n)),
          index: makeBuffer(gl.ELEMENT_ARRAY_BUFFER, new IndexArray(buffer, base + m.index, m.indexCount)),
        };
      });
  }

  function load() {
    if (meshes || loading) return;
    loading = true;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load Spot model (${res.status}).`);
        return res.arrayBuffer();
      })
      .then(parse)
      .catch((err) => {
        loading = false;
        console.warn(err);
      });
  }

  // --- Pose ------------------------------------------------------------------

  // The body's place in the scene. URDF is z-up; the scene is y-up. Columns:
  // where body x, y, z land. The fog shader's camera is left-handed (looking
  // down +z, screen right is +x), so this includes a flip that keeps Spot
  // from showing mirrored.
  function bodyMatrix(pose) {
    const c = Math.cos(pose.yaw);
    const s = Math.sin(pose.yaw);
    const stance = new Float32Array([
      c, 0, -s, 0,
      s, 0, c, 0,
      0, 1, 0, 0,
      pose.pos[0], pose.pos[1], pose.pos[2], 1,
    ]);
    // Pitch and roll are about the body's own axes, so they go on the inside.
    return mul(stance, mul(axisAngle([0, 1, 0], pose.pitch || 0),
      axisAngle([1, 0, 0], pose.roll || 0)));
  }

  function linkTransforms(worldFromBody, joints) {
    const out = { body: worldFromBody };
    chain.forEach((j) => {
      let m = mul(out[j.parent], j.origin);
      if (j.type === 'revolute') m = mul(m, axisAngle(j.axis, joints[j.joint] || 0));
      out[j.link] = m;
    });
    return out;
  }

  const SPOT_YELLOW = [0.9, 0.68, 0.2];

  // opts.poses is every robot in the scene; they share one target, so the
  // depth test sorts them against each other for free. A pose may carry a
  // `paint` color; without one it's Spot yellow.
  function render(opts) {
    const { width, height, camera } = opts;
    const poses = (opts.poses || [opts.pose]).filter(Boolean);
    resizeTarget(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!meshes || !poses.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return false;
    }

    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.uniform3fv(uni.uCamPos, camera.pos);
    gl.uniform3fv(uni.uCamRight, camera.right);
    gl.uniform3fv(uni.uCamUp, camera.up);
    gl.uniform3fv(uni.uCamFwd, camera.forward);
    gl.uniform1f(uni.uAspect, width / height);

    gl.enableVertexAttribArray(attr.pos);
    gl.enableVertexAttribArray(attr.normal);
    gl.enableVertexAttribArray(attr.mat);
    poses.forEach((pose) => {
      const transforms = linkTransforms(bodyMatrix(pose), pose.joints);
      gl.uniform3fv(uni.uPaint, pose.paint || SPOT_YELLOW);
      meshes.forEach((m) => {
        gl.uniformMatrix4fv(uni.uModel, false, transforms[m.link || 'body']);
        gl.uniform3fv(uni.uMin, m.min);
        gl.uniform3fv(uni.uSpan, m.span);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
        gl.vertexAttribPointer(attr.pos, 3, gl.SHORT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.normal);
        gl.vertexAttribPointer(attr.normal, 3, gl.BYTE, true, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.mat);
        gl.vertexAttribPointer(attr.mat, 1, gl.UNSIGNED_BYTE, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.index);
        gl.drawElements(gl.TRIANGLES, m.count, m.indexType, 0);
      });
    });
    gl.disableVertexAttribArray(attr.normal);
    gl.disableVertexAttribArray(attr.mat);

    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  // Where one link sits in the scene for a given pose, without drawing
  // anything: the page rides the arm camera on this.
  function linkTransform(pose, link) {
    if (!chain || !pose) return null;
    return linkTransforms(bodyMatrix(pose), pose.joints)[link] || null;
  }

  return {
    load,
    render,
    linkTransform,
    texture,
    maxDistance: MAX_DIST,
    getModel: () => model,
  };
};
