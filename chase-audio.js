// The sound of the chase, built in the browser.
//
// There is no audio file anywhere in this page: a kick is a sine with its
// pitch falling out from under it, the bass is two detuned sines a hair apart,
// and the hats are noise through a highpass. Everything is scheduled a beat
// ahead of the clock, which is what keeps it in time when the frame rate isn't.
//
// The scene drives it. `intensity` is the gear the chase is in — it opens the
// filter, fills in the pattern and leans on the sub — and `rate` is the
// playground's own time scale, so when a cut drops the picture into slow
// motion the beat drops with it.
window.createChaseAudio = function (existingContext) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx && !existingContext) return null;
  const ctx = existingContext || new Ctx();
  // A context handed in for rendering has no clock to resume, and asking it to
  // throws. Only a live one is ever woken up.
  const live = typeof ctx.resume === 'function'
    && !(window.OfflineAudioContext && ctx instanceof window.OfflineAudioContext);

  const BPM = 85;
  const STEP = 60 / BPM / 4;   // one sixteenth, at rate 1
  const LOOKAHEAD = 0.12;      // how far ahead of the clock notes are placed
  // E1, and the two notes it leans on. Low enough to be felt rather than heard.
  const ROOT = 41.2;
  const LINE = [1, 1, 1, 1, 0.75, 0.75, 1, 1.125];

  // --- the graph -------------------------------------------------------------

  const master = ctx.createGain();
  master.gain.value = 0;
  // Nothing here is mixed against anything else, so a compressor is cheaper
  // insurance than getting every envelope exactly right.
  const guard = ctx.createDynamicsCompressor();
  guard.threshold.value = -5;
  guard.ratio.value = 5;
  guard.attack.value = 0.003;
  guard.release.value = 0.2;
  master.connect(guard).connect(ctx.destination);

  // Everything but the kick runs through one filter, so the whole bed opens
  // up together as the chase winds on.
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 320;
  tone.Q.value = 1.2;
  tone.connect(master);

  // A slab of noise, reused by every hat and swell.
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

  // The drone under it all: a detuned pair held open the whole time, quiet
  // enough that you notice it going rather than being there.
  const drone = ctx.createGain();
  drone.gain.value = 0.05;
  drone.connect(tone);
  [0, 0.6].forEach((detune) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = ROOT;
    o.detune.value = detune * 20;
    o.connect(drone);
    o.start();
  });

  function env(node, at, peak, attack, decay) {
    const g = node.gain;
    g.setValueAtTime(0.0001, at);
    g.exponentialRampToValueAtTime(Math.max(0.0001, peak), at + attack);
    g.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  // --- voices ----------------------------------------------------------------

  function kick(at, level) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, at);
    o.frequency.exponentialRampToValueAtTime(38, at + 0.09);
    env(g, at, level, 0.004, 0.32);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + 0.4);
    // The click is the part a small speaker can reproduce, and it's what makes
    // the beat findable before the body of the kick arrives.
    const c = ctx.createBufferSource();
    const hp = ctx.createBiquadFilter();
    const cg = ctx.createGain();
    c.buffer = noise;
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    env(cg, at, level * 0.16, 0.001, 0.03);
    c.connect(hp).connect(cg).connect(master);
    c.start(at, Math.random());
    c.stop(at + 0.06);
  }

  // A sub on its own is a rumour on a laptop speaker: 41 Hz is below what one
  // can move at all. The octave and the triangle above it are what actually
  // carries the note there, while the sub is still underneath for anyone on
  // headphones.
  const BASS_LAYERS = [
    { type: 'sine', mult: 1, gain: 1, detune: 0 },
    { type: 'sine', mult: 1, gain: 0.9, detune: 7 },
    { type: 'sine', mult: 2, gain: 0.45, detune: -5 },
    { type: 'triangle', mult: 2, gain: 0.22, detune: 4 },
  ];

  function bass(at, mult, level, hold) {
    const g = ctx.createGain();
    env(g, at, level, 0.02, hold);
    g.connect(tone);
    BASS_LAYERS.forEach((layer) => {
      const o = ctx.createOscillator();
      const lg = ctx.createGain();
      lg.gain.value = layer.gain;
      o.type = layer.type;
      o.frequency.value = ROOT * mult * layer.mult;
      o.detune.value = layer.detune;
      o.connect(lg).connect(g);
      o.start(at);
      o.stop(at + hold + 0.1);
    });
  }

  function hat(at, level) {
    const s = ctx.createBufferSource();
    const hp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    s.buffer = noise;
    s.playbackRate.value = 1.4;
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    env(g, at, level, 0.002, 0.05);
    s.connect(hp).connect(g).connect(master);
    s.start(at, Math.random() * 1.5);
    s.stop(at + 0.1);
  }

  // A body of noise swelling and dying: the sound of something going past.
  function sweep(at, level, len, from, to) {
    const s = ctx.createBufferSource();
    const bp = ctx.createBiquadFilter();
    const g = ctx.createGain();
    s.buffer = noise;
    s.loop = true;
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(from, at);
    bp.frequency.exponentialRampToValueAtTime(to, at + len);
    env(g, at, level, len * 0.35, len * 0.65);
    s.connect(bp).connect(g).connect(master);
    s.start(at, Math.random());
    s.stop(at + len + 0.1);
  }

  // The sub falling off a cliff — what a cut sounds like.
  function drop(at) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(ROOT * 2, at);
    o.frequency.exponentialRampToValueAtTime(24, at + 0.55);
    env(g, at, 0.9, 0.01, 0.7);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + 0.8);
  }

  // --- the pattern -----------------------------------------------------------

  let step = 0;
  let nextAt = 0;
  let intensity = 0;
  let rate = 1;
  let running = false;

  function scheduleStep(i, at) {
    const bar = i % 16;
    const heavy = intensity > 0.45;
    const hard = intensity > 0.8;

    // Kick: two in a bar at a lope, filled in as it winds up.
    if (bar === 0 || bar === 6 || (heavy && bar === 10) || (hard && bar === 13)) {
      kick(at, bar === 0 ? 0.95 : 0.6);
    }
    // Bass: on the kick, and on the off-eighth once there is some urgency.
    if (bar === 0 || bar === 6 || (heavy && bar === 11)) {
      const note = LINE[Math.floor(i / 16) % LINE.length];
      bass(at, note, 0.5 + 0.35 * intensity, bar === 0 ? 0.55 : 0.3);
    }
    if (heavy && bar % 4 === 2) hat(at, 0.05 + 0.08 * intensity);
    if (hard && bar % 4 === 0) hat(at, 0.04);
  }

  function pump() {
    if (!running) return;
    // Sampling the rate here is what lets the tempo follow the picture: the
    // next note is placed at whatever speed the scene is running now.
    while (nextAt < ctx.currentTime + LOOKAHEAD) {
      if (nextAt < ctx.currentTime) nextAt = ctx.currentTime + 0.01;
      scheduleStep(step, nextAt);
      nextAt += STEP / Math.max(0.2, rate);
      step += 1;
    }
  }

  return {
    ctx,
    // The last node before the speakers, so a caller can tap or re-route the
    // mix instead of having to guess at the graph.
    out: guard,

    start() {
      running = true;
      step = 0;
      nextAt = ctx.currentTime + 0.05;
      // A context started before the page had a gesture comes up suspended;
      // a refused resume is the browser's call to make, not an error here.
      if (live && ctx.state !== 'running') ctx.resume().catch(() => {});
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.6);
    },

    stop() {
      running = false;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.35);
    },

    // Called every frame: the gear the chase is in, and how fast time is
    // running for it.
    update(dt, state) {
      if (!running) return;
      intensity = Math.max(0, Math.min(1, state.intensity));
      rate = state.rate || 1;
      const at = ctx.currentTime;
      tone.frequency.setTargetAtTime(220 + 1500 * intensity * intensity, at, 0.25);
      drone.gain.setTargetAtTime(0.03 + 0.05 * intensity, at, 0.4);
      pump();
    },

    // One-shots off the chase itself.
    hit(kind) {
      if (!running) return;
      const at = ctx.currentTime + 0.01;
      if (kind === 'dive') {
        kick(at, 0.5);
        sweep(at, 0.16, 0.5, 900, 180);
      } else if (kind === 'cut') {
        drop(at);
        sweep(at, 0.22, 0.7, 240, 3200);
      } else if (kind === 'broken') {
        sweep(at, 0.2, 1.1, 3000, 300);
        bass(at, 0.75, 0.8, 0.9);
      }
    },

    close() {
      running = false;
      if (ctx.close) ctx.close();
    },
  };
};
