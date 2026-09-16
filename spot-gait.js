// Turns a short phrase into a walking Spot.
//
// parse() maps text onto a locomotion command (gait, speed, turn rate, body
// height...); update() runs a phase-based gait generator that places each foot
// on the ground plane and solves the leg IK for it. Every kinematic number
// comes from the URDF baked into models/spot.bin by tools/build_spot.py, so
// this file holds no hand-copied link lengths.
window.createSpotGait = function (model, start) {
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const frac = (t) => t - Math.floor(t);

  const chain = {};
  model.chain.forEach((j) => {
    chain[j.joint] = j;
  });
  // Joint origins are column-major 4x4; the translation is the last column.
  const originXyz = (joint) => [chain[joint].origin[12], chain[joint].origin[13], chain[joint].origin[14]];

  const legs = model.legs.map((leg) => {
    const hip = originXyz(leg.hipX);
    const plane = originXyz(leg.hipY)[1];
    const knee = originXyz(leg.knee);
    return {
      name: leg.name,
      hipXJoint: leg.hipX,
      hipYJoint: leg.hipY,
      kneeJoint: leg.knee,
      hip,
      // hip_x abducts until the foot reaches this lateral plane, where the
      // rest of the leg is a flat two-link chain.
      plane,
      l1: Math.hypot(knee[0], knee[2]),
      // The upper leg isn't straight: the knee sits 25mm ahead of the hip, so
      // the first link points slightly forward of straight down.
      bend: Math.atan2(-knee[0], -knee[2]),
      l2: -leg.foot[2],
    };
  });

  function limitOf(joint) {
    return chain[joint].limit || [-Infinity, Infinity];
  }

  // Foot target (body frame, URDF axes: x forward, y left, z up) -> joint angles.
  // Out of reach targets come back with the leg stretched straight at them,
  // which is what the acos clamps do.
  function solve(leg, x, y, z, out) {
    const py = y - leg.hip[1];
    const pz = z - leg.hip[2];
    const px = x - leg.hip[0];
    const r = Math.hypot(py, pz) || 1e-6;
    const hipX = Math.atan2(pz, py) + Math.acos(clamp(leg.plane / r, -1, 1));
    // The foot as seen in the leg's own swing plane, once abduction is undone.
    const vz = Math.cos(hipX) * pz - Math.sin(hipX) * py;
    const reach = Math.hypot(px, vz);
    const cosKnee = (reach * reach - leg.l1 * leg.l1 - leg.l2 * leg.l2) / (2 * leg.l1 * leg.l2);
    // Spot's knees always fold backwards, so take the negative branch.
    const fold = -Math.acos(clamp(cosKnee, -1, 1));
    const lead = Math.atan2(leg.l2 * Math.sin(fold), leg.l1 + leg.l2 * Math.cos(fold));
    const hipY = Math.atan2(-px, -vz) - leg.bend - lead;
    const hx = limitOf(leg.hipXJoint);
    const hy = limitOf(leg.hipYJoint);
    const kn = limitOf(leg.kneeJoint);
    out[leg.hipXJoint] = clamp(hipX, hx[0], hx[1]);
    out[leg.hipYJoint] = clamp(hipY, hy[0], hy[1]);
    out[leg.kneeJoint] = clamp(fold + leg.bend, kn[0], kn[1]);
  }

  // The visible rubber of the foot hangs a little below the contact point the
  // IK aims at, so the body rides that much higher than the leg extension.
  const GROUND_OFFSET = (() => {
    const leg = legs[0];
    const hipY = model.standPose.hip_y;
    const knee = model.standPose.knee;
    const kx = originXyz(leg.kneeJoint)[0];
    const kz = originXyz(leg.kneeJoint)[2];
    // Forward kinematics of the stand pose, inside the leg's swing plane.
    const ax = kx - leg.l2 * Math.sin(knee);
    const az = kz - leg.l2 * Math.cos(knee);
    const footZ = -Math.sin(hipY) * ax + Math.cos(hipY) * az;
    return footZ - model.footZ;
  })();

  // Phase offsets are in leg order (front left, front right, rear left, rear
  // right); duty is the fraction of each cycle a foot spends on the ground.
  const GAITS = {
    stand: { offsets: [0, 0, 0, 0], duty: 1, freq: 0, bob: 0, sway: 0 },
    walk: { offsets: [0, 0.5, 0.75, 0.25], duty: 0.75, freq: 1.1, bob: 0.008, sway: 0.03 },
    trot: { offsets: [0, 0.5, 0.5, 0], duty: 0.55, freq: 1.9, bob: 0.018, sway: 0.012 },
    pace: { offsets: [0, 0.5, 0, 0.5], duty: 0.55, freq: 1.7, bob: 0.014, sway: 0.05 },
    bound: { offsets: [0, 0, 0.5, 0.5], duty: 0.45, freq: 2.2, bob: 0.035, sway: 0 },
  };

  const MAX_STRIDE = 0.42;
  const HEIGHT_RANGE = [0.34, 0.58];

  function defaultCommand() {
    return {
      gait: 'stand',
      speed: 0,
      strafe: 0,
      turn: 0,
      height: 0.50,
      stepHeight: 0.09,
      cadence: 1,
      lean: 0,
      arm: 'auto',
      armAmp: 1,
      label: 'standing',
    };
  }

  const command = defaultCommand();
  const state = {
    pos: [start.pos[0], start.pos[1], start.pos[2]],
    yaw: start.yaw,
    phase: 0,
    // Commands ease in rather than snapping, so a new phrase doesn't teleport
    // the feet mid-stride.
    speed: 0,
    strafe: 0,
    turn: 0,
    height: 0.50,
    stepHeight: 0.09,
    lean: 0,
    armAmp: 1,
    // Free-running so the arm keeps swinging while Spot stands still.
    armPhase: 0,
  };
  let looking = false;
  const home = [start.pos[0], start.pos[1], start.pos[2]];

  const pose = {
    pos: [start.pos[0], start.pos[1], start.pos[2]],
    yaw: start.yaw,
    pitch: 0,
    roll: 0,
    joints: Object.create(null),
  };

  // --- text -> command -------------------------------------------------------

  // Applied in passes so word order doesn't matter: a style preset first, then
  // anything the phrase says explicitly overrides it.
  const STYLES = [
    { re: /(sneak|stealth|creep|quiet|tiptoe|살금|몰래|조용)/i, c: { gait: 'walk', speed: 0.35, height: 0.40, stepHeight: 0.05, cadence: 0.8, label: 'sneaking' } },
    { re: /(march|parade|행진|열병)/i, c: { gait: 'walk', speed: 0.6, height: 0.54, stepHeight: 0.17, cadence: 0.9, label: 'marching' } },
    { re: /(prance|skip|excited|happy|신나|방방|깡충)/i, c: { gait: 'bound', speed: 1.1, height: 0.52, stepHeight: 0.16, cadence: 1.15, label: 'prancing' } },
    { re: /(tired|limp|slow.?down|지친|피곤|힘없)/i, c: { gait: 'walk', speed: 0.3, height: 0.44, stepHeight: 0.05, cadence: 0.6, label: 'trudging' } },
    { re: /(patrol|inspect|survey|순찰|정찰)/i, c: { gait: 'walk', speed: 0.55, turn: 0.22, height: 0.52, label: 'patrolling' } },
    { re: /(sprint|dash|charge|전력|질주)/i, c: { gait: 'bound', speed: 1.8, height: 0.50, stepHeight: 0.14, cadence: 1.2, label: 'sprinting' } },
  ];

  const VERB = { stand: 'standing', walk: 'walking', trot: 'trotting', pace: 'pacing', bound: 'bounding' };

  // What the arm should be doing, independent of the legs.
  const ARM_WORDS = [
    { re: /(\bwave|\bgreet|\bhello|\bhi\b|인사|손 ?흔)/i, arm: 'wave' },
    { re: /(\bswing|\bsway|\bflail|흔들|휘저)/i, arm: 'swing' },
    { re: /(\bstow|\btuck|\bfold|접|집어넣|말아)/i, arm: 'stow' },
    { re: /(\bpoint|\breach|\bextend|뻗|가리키)/i, arm: 'reach' },
  ];
  const ARM_SAY = { swing: 'arm swinging', wave: 'arm waving', stow: 'arm stowed', reach: 'arm reaching' };

  const GAIT_WORDS = [
    { re: /(\bstand|\bhalt|\bstop|\bstay|\bidle|서 ?있|멈|정지|가만)/i, gait: 'stand' },
    { re: /(trot|속보)/i, gait: 'trot' },
    { re: /(\bpace|\bamble|측대)/i, gait: 'pace' },
    { re: /(\bbound|\bgallop|\bleap|\bhop|바운드|도약|뛰어)/i, gait: 'bound' },
    { re: /(\brun|\bsprint|\bjog|\bdash|달리|달려|뛰)/i, gait: 'bound' },
    { re: /(\bwalk|\bstep|\bstroll|걷|걸어|보행|성큼)/i, gait: 'walk' },
  ];

  function parse(text) {
    const s = (text || '').trim();
    if (!s) return null;
    const c = defaultCommand();
    let hit = false;

    STYLES.forEach((style) => {
      if (style.re.test(s)) {
        Object.assign(c, style.c);
        hit = true;
      }
    });

    // First match wins, so "stop walking" stands still instead of walking.
    const word = GAIT_WORDS.find((g) => g.re.test(s));
    if (word) {
      c.gait = word.gait;
      if (word.gait === 'stand') {
        c.speed = 0;
        c.strafe = 0;
        c.turn = 0;
        c.label = 'standing';
      } else if (!c.speed) {
        c.speed = word.gait === 'walk' ? 0.55 : word.gait === 'bound' ? 1.5 : 0.95;
        c.label = word.gait === 'bound' ? 'running' : VERB[word.gait];
      }
      hit = true;
    }

    // Direction. "backwards" has to win over a bare "back".
    if (/(backward|back(?!\s*flip)|reverse|뒤로|후진)/i.test(s)) {
      if (!c.speed) c.speed = 0.5;
      c.speed = -Math.abs(c.speed);
      if (c.gait === 'stand') c.gait = 'walk';
      c.label = 'backing up';
      hit = true;
    } else if (/(forward|ahead|앞으로|전진)/i.test(s)) {
      if (!c.speed) c.speed = 0.7;
      c.speed = Math.abs(c.speed);
      if (c.gait === 'stand') c.gait = 'walk';
      hit = true;
    }

    if (/(spin|circle|빙글|제자리.?돌|회전)/i.test(s)) {
      c.turn = 1.4;
      if (c.gait === 'stand') c.gait = 'trot';
      c.label = 'spinning';
      hit = true;
    }
    if (/(left|왼쪽|왼|좌회전|좌로)/i.test(s)) {
      if (/(strafe|sideways|side.?step|게걸음|옆으로)/i.test(s)) {
        c.strafe = 0.5;
        if (c.gait === 'stand') c.gait = 'walk';
        c.label = 'side-stepping';
      } else {
        c.turn = Math.abs(c.turn || 0.6);
        if (c.gait === 'stand') c.gait = 'walk';
        if (!c.speed) c.speed = 0.5;
      }
      hit = true;
    } else if (/(right|오른쪽|오른|우회전|우로)/i.test(s)) {
      if (/(strafe|sideways|side.?step|게걸음|옆으로)/i.test(s)) {
        c.strafe = -0.5;
        if (c.gait === 'stand') c.gait = 'walk';
        c.label = 'side-stepping';
      } else {
        c.turn = -Math.abs(c.turn || 0.6);
        if (c.gait === 'stand') c.gait = 'walk';
        if (!c.speed) c.speed = 0.5;
      }
      hit = true;
    } else if (/(turn|돌아|돌려)/i.test(s) && !c.turn) {
      c.turn = 0.6;
      if (c.gait === 'stand') c.gait = 'walk';
      if (!c.speed) c.speed = 0.5;
      hit = true;
    }

    // Speed words scale whatever the phrase settled on.
    if (/(slow|gentle|careful|천천|느리|살살)/i.test(s)) {
      c.speed *= 0.5;
      c.cadence *= 0.75;
      hit = true;
    }
    if (/(\bfast|\bquick|\bhurry|빨리|빠르|급하)/i.test(s)) {
      c.speed *= 1.7;
      c.cadence *= 1.15;
      hit = true;
    }

    // The arm takes its own orders. "hardly" keeps its English meaning here:
    // barely, not hard — "swing the arm hard" is the big one.
    const armWord = ARM_WORDS.find((a) => a.re.test(s));
    if (armWord) {
      // "stop waving" asks for the opposite of "wave".
      c.arm = word && word.gait === 'stand' ? 'auto' : armWord.arm;
      hit = true;
    }
    if (/(\bhardly|\bbarely|\bslight|\bgentl|\bsoft|\bsmall|\btiny|살짝|살살|조금|약하)/i.test(s)) {
      c.armAmp = 0.35;
      hit = true;
    } else if (/(\bhard\b|\bwild|\bvigorous|\bfierce|\bbig|\bwide|\bstrong|세게|크게|힘차|격하)/i.test(s)) {
      c.armAmp = 1.7;
      hit = true;
    }

    // An explicit speed beats every guess above.
    const mps = s.match(/(-?\d+(?:\.\d+)?)\s*(m\/s|mps|미터)/i);
    if (mps) {
      c.speed = parseFloat(mps[1]);
      if (c.gait === 'stand') c.gait = Math.abs(c.speed) > 1.2 ? 'bound' : Math.abs(c.speed) > 0.7 ? 'trot' : 'walk';
      hit = true;
    }

    if (/(high.?step|\bstomp|\bknee|성큼|높이.?들)/i.test(s)) {
      c.stepHeight = 0.18;
      hit = true;
    } else if (/(\btall|\bhigh|\bstretch|\btiptoe|높게|높이|쭉)/i.test(s)) {
      c.height = 0.57;
      hit = true;
    }
    if (/(\bcrouch|\blow|\bduck|\bhunker|낮게|낮추|숙여|엎드)/i.test(s)) {
      c.height = 0.38;
      hit = true;
    }

    if (!hit) return null;

    c.speed = clamp(c.speed, -2.2, 2.2);
    c.strafe = clamp(c.strafe, -1, 1);
    c.turn = clamp(c.turn, -2, 2);
    c.height = clamp(c.height, HEIGHT_RANGE[0], HEIGHT_RANGE[1]);
    c.armAmp = clamp(c.armAmp, 0.2, 2);
    if (c.gait !== 'stand' && !c.speed && !c.strafe && !c.turn) c.speed = 0.6;
    if (c.gait === 'stand') c.label = 'standing';
    return c;
  }

  // What the visitor sees echoed back, built from the command that will
  // actually run rather than from whatever words matched.
  function describe(c) {
    const arm = c.arm === 'auto' ? '' :
      ARM_SAY[c.arm] + (c.armAmp > 1.3 ? ' hard' : c.armAmp < 0.6 ? ' gently' : '');
    if (c.gait === 'stand') {
      return ['standing still', arm, `body ${c.height.toFixed(2)} m`]
        .filter(Boolean).join(' \u00b7 ');
    }
    const parts = [c.label && c.label !== 'standing' ? c.label : VERB[c.gait]];
    if (c.speed) parts.push(`${c.speed > 0 ? 'forward' : 'backward'} at ${Math.abs(c.speed).toFixed(2)} m/s`);
    if (c.strafe) parts.push(`sliding ${c.strafe > 0 ? 'left' : 'right'}`);
    if (c.turn) parts.push(`turning ${c.turn > 0 ? 'left' : 'right'} ${Math.round(Math.abs(c.turn) * 57.3)}°/s`);
    if (c.stepHeight > 0.15) parts.push('high steps');
    if (arm) parts.push(arm);
    parts.push(`body ${c.height.toFixed(2)} m`);
    return parts.join(' · ');
  }

  // Anything that didn't come out of parse() (a queued step, a model reply)
  // goes through the same limits parse() applies. A NaN would otherwise sail
  // through clamp() and take the robot's position with it for good.
  const NUMERIC = {
    speed: [-2.2, 2.2], strafe: [-1, 1], turn: [-2, 2], height: HEIGHT_RANGE,
    stepHeight: [0.03, 0.2], cadence: [0.5, 1.4], lean: [-0.2, 0.2], armAmp: [0.2, 2],
  };

  function sanitize(next) {
    const out = {};
    Object.keys(next || {}).forEach((key) => {
      const v = next[key];
      if (NUMERIC[key]) {
        if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(v, NUMERIC[key][0], NUMERIC[key][1]);
      } else if (key === 'gait') {
        if (GAITS[v]) out.gait = v;
      } else if (key === 'arm') {
        if (v === 'auto' || ARM_SAY[v]) out.arm = v;
      } else if (key === 'label') {
        if (typeof v === 'string') out.label = v.slice(0, 40);
      }
    });
    return out;
  }

  function setCommand(next) {
    Object.assign(command, sanitize(next));
    return describe(command);
  }

  // --- gait ------------------------------------------------------------------

  // --- arm -------------------------------------------------------------------

  // Arm poses are targets, not positions: update() eases the joints toward
  // whichever one is current, so changing your mind is a move and not a cut.
  const ARM_JOINTS = ['arm_sh0', 'arm_sh1', 'arm_el0', 'arm_el1', 'arm_wr0', 'arm_wr1', 'arm_f1x'];
  const armLimits = {};
  ARM_JOINTS.forEach((j) => { armLimits[j] = limitOf(j); });
  const armWanted = Object.create(null);
  const armHeld = Object.create(null);
  // While holding the camera the shoulder can pan toward a point instead of
  // sweeping: the bearing to it, in body terms, or null to sweep; and the wrist
  // tips down by lookTilt so something standing on the ground stays in frame.
  let lookBearing = null;
  let lookTilt = 0;

  function armTargetPose(mode, t, phase, amp, effort, out) {
    // The slow idle loop everything else departs from: the arm looks around,
    // tightening up the faster Spot moves.
    const stow = 1 - 0.35 * effort;
    const sh1 = -1.85 + 0.12 * Math.sin(t * 0.6) * stow;
    const el0 = 2.1 - 0.18 * Math.sin(t * 0.6 + 1.2) * stow;
    out.arm_sh0 = 0.55 * Math.sin(t * 0.35) * stow;
    out.arm_sh1 = sh1;
    out.arm_el0 = el0;
    out.arm_el1 = 0.15 * Math.sin(t * 0.45) * stow;
    out.arm_wr0 = 0.55 - (sh1 + el0) * 0.3 + 0.25 * Math.sin(t * 0.8 + 0.5) * stow;
    out.arm_wr1 = 0.3 * Math.sin(t * 0.5 + 2.0) * stow;
    out.arm_f1x = -0.25 - 0.45 * (0.5 + 0.5 * Math.sin(t * 1.1));

    if (mode === 'look') {
      // Holding the camera: the wrist cancels the shoulder and elbow so the
      // gripper ends up just below level, and the rolls zero out so the
      // horizon stays put while it pans.
      const aiming = lookBearing !== null;
      const s = -1.85 + (aiming ? 0.015 : 0.05) * Math.sin(t * 0.5);
      out.arm_sh0 = aiming ? clamp(lookBearing, -2.4, 2.4) : 0.4 * Math.sin(t * 0.3);
      out.arm_sh1 = s;
      out.arm_el0 = 2.1;
      out.arm_el1 = 0;
      out.arm_wr0 = -(s + 2.1) - 0.08 + (aiming ? 0.02 : 0.1) * Math.sin(t * 0.45) + lookTilt;
      out.arm_wr1 = 0;
    } else if (mode === 'swing') {
      // A pendulum on the stride: shoulder and elbow sweep the gripper fore
      // and aft, with the shoulder pan a quarter cycle behind.
      const sw = Math.sin(2 * Math.PI * phase);
      out.arm_sh0 = 0.3 * amp * Math.cos(2 * Math.PI * phase);
      out.arm_sh1 = -1.85 + 0.5 * amp * sw;
      out.arm_el0 = 2.1 - 0.3 * amp * sw;
      out.arm_el1 = 0;
      out.arm_wr0 = 0.55 - (out.arm_sh1 + out.arm_el0) * 0.3;
      out.arm_wr1 = 0.2 * amp * sw;
    } else if (mode === 'wave') {
      out.arm_sh0 = 0.15;
      out.arm_sh1 = -2.35;
      out.arm_el0 = 1.55;
      out.arm_el1 = 0;
      out.arm_wr0 = 0.4;
      out.arm_wr1 = amp * Math.sin(2 * Math.PI * 1.4 * t);
    } else if (mode === 'reach') {
      out.arm_sh0 = 0;
      out.arm_sh1 = -0.2 + 0.05 * Math.sin(t * 0.7);
      out.arm_el0 = 0.15;
      out.arm_el1 = 0;
      out.arm_wr0 = 0.05;
      out.arm_wr1 = 0;
      out.arm_f1x = -0.1;
    } else if (mode === 'stow') {
      out.arm_sh0 = 0;
      out.arm_sh1 = -2.9;
      out.arm_el0 = 2.9;
      out.arm_el1 = 0;
      out.arm_wr0 = 0.1;
      out.arm_wr1 = 0;
      out.arm_f1x = -0.05;
    }
  }

  armTargetPose('auto', 0, 0, 1, 0, armHeld);

  function poseArm(joints, mode, t, phase, amp, effort, step) {
    armTargetPose(mode, t, phase, amp, effort, armWanted);
    const k = 1 - Math.exp(-step / 0.15);
    for (let i = 0; i < ARM_JOINTS.length; i++) {
      const j = ARM_JOINTS[i];
      const lim = armLimits[j];
      armHeld[j] += (armWanted[j] - armHeld[j]) * k;
      joints[j] = clamp(armHeld[j], lim[0], lim[1]);
    }
  }

  // How far Spot wanders from where it started before it steers back.
  const LEASH = 5;

  // --- going somewhere -------------------------------------------------------

  // A target is a function the page hands over, asked every frame where to
  // be: { x, z, radius, speed, turn, yaw, gait, faceX, faceZ, prop }. x/z is
  // the spot to reach; speed/turn/yaw describe how that spot itself is moving
  // (a point beside another robot moves with it); faceX/faceZ is what to turn
  // toward once there; prop is the obstacle it leads to, if any. It steers
  // instead of the command's speed and turn, and never writes into the
  // command, so a later phrase can't inherit it.
  let target = null;
  let arrived = false;
  let lookAt = null;
  // Props on the ground: { x, z, hx, hz, round }. Spot can't climb them, so
  // it slides around their footprint and steers off them before it gets there.
  let obstacles = [];
  const BODY_RADIUS = 0.42;

  // Signed angle from where Spot is pointing to (vx, vz), measured toward its
  // left, which is the direction a positive turn rate takes it.
  function bearing(vx, vz) {
    const ahead = vx * Math.cos(state.yaw) - vz * Math.sin(state.yaw);
    const toLeft = vx * Math.sin(state.yaw) + vz * Math.cos(state.yaw);
    return Math.atan2(toLeft, ahead);
  }

  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  // The nearest point of a footprint, and how far that is.
  function nearestOn(o, px, pz, out) {
    if (o.round) {
      const dx = px - o.x;
      const dz = pz - o.z;
      const d = Math.hypot(dx, dz) || 1e-6;
      out[0] = o.x + (dx / d) * o.hx;
      out[1] = o.z + (dz / d) * o.hx;
      return Math.max(0, d - o.hx);
    }
    out[0] = clamp(px, o.x - o.hx, o.x + o.hx);
    out[1] = clamp(pz, o.z - o.hz, o.z + o.hz);
    return Math.hypot(px - out[0], pz - out[1]);
  }
  const near = [0, 0];

  // Turn away from anything close ahead, harder the closer it is, except the
  // prop Spot was sent to, which it is supposed to walk up to.
  function avoidTurn(ignore) {
    let bias = 0;
    for (let i = 0; i < obstacles.length; i++) {
      if (obstacles[i] === ignore) continue;
      const d = nearestOn(obstacles[i], state.pos[0], state.pos[2], near);
      if (d > BODY_RADIUS + 0.6) continue;
      const b = bearing(near[0] - state.pos[0], near[1] - state.pos[2]);
      if (Math.abs(b) > 1.2) continue;
      const push = 1 - clamp((d - BODY_RADIUS) / 0.6, 0, 1);
      bias -= Math.sign(b || 1) * push * 1.3;
    }
    return bias;
  }

  // Spot's footprint never overlaps a prop's: whatever the stride says, the
  // body is put back outside it.
  function pushOut() {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const d = nearestOn(o, state.pos[0], state.pos[2], near);
      if (d >= BODY_RADIUS) continue;
      let nx = state.pos[0] - near[0];
      let nz = state.pos[2] - near[1];
      let len = Math.hypot(nx, nz);
      if (len < 1e-4) {
        // The center is inside a box: leave by the closest side.
        const ex = o.hx - Math.abs(state.pos[0] - o.x);
        const ez = o.hz - Math.abs(state.pos[2] - o.z);
        if (ex < ez) { nx = Math.sign(state.pos[0] - o.x) || 1; nz = 0; } else { nx = 0; nz = Math.sign(state.pos[2] - o.z) || 1; }
        near[0] = o.x + nx * o.hx;
        near[1] = o.z + nz * o.hz;
        len = 1;
      }
      state.pos[0] = near[0] + (nx / len) * BODY_RADIUS;
      state.pos[2] = near[1] + (nz / len) * BODY_RADIUS;
    }
  }

  // Scratch for the foot placement below, so a walking Spot allocates nothing
  // per frame.
  const foot = [0, 0];
  const lift = [0, 0];
  const land = [0, 0];

  // Where a foot planted at mid-stance under nom sits dt seconds later, as
  // seen from the body: the body has translated and turned under it. Placing
  // feet on that arc instead of along a straight line is what keeps them from
  // scrubbing sideways through a turn.
  function plant(nomX, nomY, dt, out) {
    const w = state.turn;
    const a = w * dt;
    // Distance travelled along the arc, resolved in the body axes held at
    // mid-stance. For a straight line (w -> 0) this collapses to v * dt.
    const alongF = Math.abs(a) > 1e-4 ? Math.sin(a) / w : dt;
    const alongL = Math.abs(a) > 1e-4 ? (1 - Math.cos(a)) / w : 0;
    const dx = nomX - (state.speed * alongF - state.strafe * alongL);
    const dy = nomY - (state.speed * alongL + state.strafe * alongF);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    out[0] = ca * dx + sa * dy;
    out[1] = -sa * dx + ca * dy;
  }

  // Where the target wants Spot this frame, as a speed, turn and gait. This
  // runs ahead of the eases below, which are the only smoothing there is:
  // anything decided after them would reach the feet as a step.
  const steer = { speed: 0, turn: 0, gait: 'stand' };

  function steerToTarget(goal) {
    const vx = goal.x - state.pos[0];
    const vz = goal.z - state.pos[2];
    const dist = Math.hypot(vx, vz);
    const radius = goal.radius || 0.3;
    const goalSpeed = Math.max(0, goal.speed || 0);
    // Only a target that is standing still can be arrived at; one that is
    // moving has to be kept up with.
    if (goalSpeed < 0.05 && dist < radius) arrived = true;
    else if (goalSpeed >= 0.05 || dist > radius + 0.45) arrived = false;

    if (arrived) {
      const fx = goal.faceX === undefined ? goal.x : goal.faceX;
      const fz = goal.faceZ === undefined ? goal.z : goal.faceZ;
      const err = Math.hypot(fx - state.pos[0], fz - state.pos[2]) > 0.2 ? bearing(fx - state.pos[0], fz - state.pos[2]) : 0;
      steer.speed = 0;
      steer.turn = Math.abs(err) > 0.2 ? clamp(1.4 * err, -0.8, 0.8) : 0;
      steer.gait = steer.turn ? 'walk' : 'stand';
      return;
    }

    // Far off, head for the point; close to a moving one, match its heading
    // instead, since the bearing to a point a few cm away is just noise.
    const w = smoothstep(clamp((dist - 0.2) / 0.6, 0, 1));
    const toPoint = dist > 1e-3 ? bearing(vx, vz) : 0;
    const matchYaw = goal.yaw === undefined ? toPoint : wrap(state.yaw - goal.yaw);
    const err = w * toPoint + (1 - w) * matchYaw;
    steer.turn = clamp(2.0 * err + (1 - w) * (goal.turn || 0), -1.4, 1.4);
    // Keep pace with the target and close the gap on top of that, easing off
    // while still pointed the wrong way.
    const cap = Math.max(0.9, goalSpeed * 1.4 + 0.3);
    const facing = 1 - 0.85 * smoothstep(clamp((Math.abs(err) - 0.5) / 0.9, 0, 1));
    steer.speed = clamp(goalSpeed + 1.2 * Math.max(0, dist - (goalSpeed < 0.05 ? radius * 0.5 : 0)), 0, cap) * facing;
    // A standing gait doesn't step, so moving at all means picking one that does.
    const wanted = goal.gait && goal.gait !== 'stand' ? goal.gait : command.gait !== 'stand' ? command.gait : 'walk';
    steer.gait = steer.speed > 1.1 && wanted === 'walk' ? 'trot' : wanted;
  }

  function update(dt, time) {
    const step = Math.min(dt, 0.05);
    const ease = 1 - Math.exp(-step / 0.35);

    let speedCmd = command.speed;
    let strafeCmd = command.strafe;
    let turnCmd = command.turn;
    let gaitName = command.gait;
    const goal = target ? target() : null;
    if (goal) {
      steerToTarget(goal);
      speedCmd = steer.speed;
      strafeCmd = 0;
      turnCmd = steer.turn;
      gaitName = steer.gait;
    } else {
      arrived = false;
      // Spot stays in the clearing it started in: past the leash it steers
      // home instead of walking off into the fog. A target has its own idea
      // of where to be, so the leash stays out of its way.
      const dx = state.pos[0] - home[0];
      const dz = state.pos[2] - home[2];
      if (Math.hypot(dx, dz) > LEASH && state.speed > 0.05) {
        turnCmd = clamp(turnCmd + bearing(-dx, -dz) * 0.9, -1.2, 1.2);
      }
    }
    if (obstacles.length && state.speed > 0.05) turnCmd = clamp(turnCmd + avoidTurn(goal && goal.prop), -1.6, 1.6);

    state.speed += (speedCmd - state.speed) * ease;
    state.strafe += (strafeCmd - state.strafe) * ease;
    state.height += (command.height - state.height) * ease;
    state.stepHeight += (command.stepHeight - state.stepHeight) * ease;
    state.lean += (command.lean - state.lean) * ease;
    state.armAmp += (command.armAmp - state.armAmp) * ease;
    state.turn += (turnCmd - state.turn) * ease;

    const gait = GAITS[gaitName] || GAITS.stand;
    const planar = Math.hypot(state.speed, state.strafe);
    // Cadence follows speed: a longer stride than this would scrape the ground.
    let freq = gait.freq * command.cadence;
    if (freq > 0 && planar * gait.duty / freq > MAX_STRIDE) {
      freq = planar * gait.duty / MAX_STRIDE;
    }
    const moving = gait.freq > 0 && (planar > 0.02 || Math.abs(state.turn) > 0.05);
    // With nothing to walk to the phase holds, which leaves every foot planted
    // under its hip instead of marching in place.
    if (moving) state.phase = frac(state.phase + freq * step);

    // Integrate the root. Body x is forward, body y is left; the render frame
    // maps them onto the ground plane with a mirror, so yaw turns clockwise.
    const cy = Math.cos(state.yaw);
    const sy = Math.sin(state.yaw);
    state.yaw -= state.turn * step;
    state.pos[0] += (cy * state.speed + sy * state.strafe) * step;
    state.pos[2] += (-sy * state.speed + cy * state.strafe) * step;
    if (obstacles.length) pushOut();

    // Body attitude first: the feet are placed in a level frame at the body
    // position, so a bobbing or leaning body cannot drag them through the
    // ground. What the legs get is that target rotated back into body axes.
    const bob = moving ? gait.bob * Math.sin(4 * Math.PI * state.phase) : 0;
    const pitch = state.lean + 0.06 * clamp(state.speed / 1.5, -1, 1)
      + (moving ? gait.bob * 0.6 * Math.sin(4 * Math.PI * state.phase + 1.2) : 0);
    // Roll into a turn the way a real dog leans into a corner.
    const roll = -0.12 * clamp(state.turn / 1.5, -1, 1)
      + (moving ? gait.sway * Math.sin(2 * Math.PI * state.phase) : 0);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);

    const stance = gait.duty / Math.max(freq, 1e-3);
    const joints = pose.joints;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const nomX = leg.hip[0];
      const nomY = leg.hip[1] + leg.plane;
      const th = frac(state.phase + gait.offsets[i]);
      let fz = -(state.height + bob);
      if (!moving) {
        foot[0] = nomX;
        foot[1] = nomY;
      } else if (th < gait.duty) {
        // Planted: the foot tracks the ground while the body rides over it.
        plant(nomX, nomY, (th / gait.duty - 0.5) * stance, foot);
      } else {
        // Swinging: ease from lift-off to the next touchdown over a low arc.
        const u = (th - gait.duty) / (1 - gait.duty);
        plant(nomX, nomY, stance * 0.5, lift);
        plant(nomX, nomY, -stance * 0.5, land);
        const k = smoothstep(u);
        foot[0] = lift[0] + (land[0] - lift[0]) * k;
        foot[1] = lift[1] + (land[1] - lift[1]) * k;
        fz += state.stepHeight * Math.sin(Math.PI * u);
      }
      const fx = foot[0];
      const fy = foot[1];

      // Level frame -> body frame, undoing the pitch and roll the renderer
      // will apply to the body.
      const bx = cp * fx - sp * fz;
      const tz = sp * fx + cp * fz;
      const by = cr * fy + sr * tz;
      const bz = -sr * fy + cr * tz;
      solve(leg, bx, by, bz, joints);
    }

    // The arm swings at the stride rate while walking, and idles along at its
    // own pace when Spot is standing.
    state.armPhase = frac(state.armPhase + (moving ? freq : 0.7) * step);
    const aim = looking && lookAt ? lookAt() : null;
    lookBearing = aim ? bearing(aim.x - state.pos[0], aim.z - state.pos[2]) : null;
    // The camera rides about a meter up and half a meter out along the arm;
    // tip it toward the middle of whatever it's pointed at.
    lookTilt = aim ? clamp(Math.atan2(0.6, Math.max(0.6, Math.hypot(aim.x - state.pos[0], aim.z - state.pos[2]) - 0.5)), 0, 0.7) : 0;
    poseArm(joints, looking && command.arm === 'auto' ? 'look' : command.arm, time, state.armPhase,
      state.armAmp, clamp(planar / 1.6, 0, 1), step);

    pose.pos[0] = state.pos[0];
    pose.pos[1] = state.height + GROUND_OFFSET + bob;
    pose.pos[2] = state.pos[2];
    pose.yaw = state.yaw;
    pose.pitch = pitch;
    pose.roll = roll;
    return pose;
  }

  return {
    parse,
    setCommand,
    sanitize,
    // Raises the arm into its camera pose, for the view through the gripper.
    // A phrase that asks the arm for something specific wins over it, ride
    // and all — "stop" hands the steady pose back. `at`, if given, is asked
    // every frame for a point {x, z} to pan the camera toward.
    setLook: (on, at) => { looking = !!on; lookAt = at || null; },
    setTarget: (fn) => { target = fn || null; arrived = false; },
    hasTarget: () => !!target,
    arrived: () => arrived,
    setObstacles: (list) => { obstacles = list || []; },
    describe,
    update,
    command,
    state,
    pose,
    gaits: Object.keys(GAITS),
  };
};
