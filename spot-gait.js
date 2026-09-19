// Turns a locomotion command into a walking Spot.
//
// A command is a gait, a speed, a turn rate, a body height and a few things
// about how hard to work; update() runs a phase-based gait generator that
// places each foot on the ground plane and solves the leg IK for it. Every
// kinematic number comes from the URDF baked into models/spot.bin by
// tools/build_spot.py, so this file holds no hand-copied link lengths.
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
      // How long the body takes to reach a new command, in seconds. Everything
      // steady runs on the default; a cut drops it so the plant reads as one
      // hard beat instead of a slide.
      tau: 0.35,
      // A commanded body roll, on top of the lean the turn rate already gives.
      // The legs hold their ground under it, so this is the robot dropping a
      // shoulder rather than the whole body tipping over.
      bank: 0,
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
    bank: 0,
    armAmp: 1,
    // Free-running so the arm keeps swinging while Spot stands still.
    armPhase: 0,
  };
  let looking = false;

  const pose = {
    pos: [start.pos[0], start.pos[1], start.pos[2]],
    yaw: start.yaw,
    pitch: 0,
    roll: 0,
    joints: Object.create(null),
  };

  // What the arm can be asked to do, beyond following the gait.
  const ARM_MODES = ['look', 'swing', 'wave', 'reach', 'stow'];

  // Every command comes in from the playground, so this is the only thing
  // standing between a typo and a robot with a NaN for a position — which
  // clamp() would sail straight through and never recover from.
  const NUMERIC = {
    speed: [-2.2, 2.2], strafe: [-1.5, 1.5], turn: [-3, 3], height: HEIGHT_RANGE,
    stepHeight: [0.03, 0.2], cadence: [0.5, 1.6], lean: [-0.2, 0.2], armAmp: [0.2, 2],
    tau: [0.06, 1], bank: [-0.45, 0.45],
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
        if (v === 'auto' || ARM_MODES.indexOf(v) >= 0) out.arm = v;
      } else if (key === 'label') {
        if (typeof v === 'string') out.label = v.slice(0, 40);
      }
    });
    return out;
  }

  function setCommand(next) {
    Object.assign(command, sanitize(next));
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

  // Where the arm camera is pointed, when the page has asked for it.
  let lookAt = null;

  // Signed angle from where Spot is pointing to (vx, vz), measured toward its
  // left, which is the direction a positive turn rate takes it.
  function bearing(vx, vz) {
    const ahead = vx * Math.cos(state.yaw) - vz * Math.sin(state.yaw);
    const toLeft = vx * Math.sin(state.yaw) + vz * Math.cos(state.yaw);
    return Math.atan2(toLeft, ahead);
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

  function update(dt, time) {
    const step = Math.min(dt, 0.05);
    const ease = 1 - Math.exp(-step / Math.max(0.06, command.tau));

    state.speed += (command.speed - state.speed) * ease;
    state.strafe += (command.strafe - state.strafe) * ease;
    state.height += (command.height - state.height) * ease;
    state.stepHeight += (command.stepHeight - state.stepHeight) * ease;
    state.lean += (command.lean - state.lean) * ease;
    state.bank += (command.bank - state.bank) * ease;
    state.armAmp += (command.armAmp - state.armAmp) * ease;
    state.turn += (command.turn - state.turn) * ease;

    const gait = GAITS[command.gait] || GAITS.stand;
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

    // Body attitude first: the feet are placed in a level frame at the body
    // position, so a bobbing or leaning body cannot drag them through the
    // ground. What the legs get is that target rotated back into body axes.
    const bob = moving ? gait.bob * Math.sin(4 * Math.PI * state.phase) : 0;
    const pitch = state.lean + 0.06 * clamp(state.speed / 1.5, -1, 1)
      + (moving ? gait.bob * 0.6 * Math.sin(4 * Math.PI * state.phase + 1.2) : 0);
    // Roll into a turn the way a real dog leans into a corner, plus whatever
    // bank the command asked for on top.
    const roll = state.bank - 0.12 * clamp(state.turn / 1.5, -1, 1)
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
    setCommand,
    sanitize,
    // Raises the arm into its camera pose, for the view through the gripper.
    // A phrase that asks the arm for something specific wins over it, ride
    // and all — "stop" hands the steady pose back. `at`, if given, is asked
    // every frame for a point {x, z} to pan the camera toward.
    setLook: (on, at) => { looking = !!on; lookAt = at || null; },
    update,
    command,
    state,
    pose,
    gaits: Object.keys(GAITS),
  };
};
