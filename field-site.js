// The places the playground can turn into, and the props that make them.
//
// A site is nothing but props standing on the ground plane: boxes and upright
// cylinders, at most MAX_PROPS of them, placed in meters around the robots'
// starting clearing. The fog shader in cloud-playground.js ray-tests them from
// a small data texture, and spot-gait.js walks around their footprints. They
// are never walkable: the gait only knows the ground at y = 0.
window.FieldSite = (function () {
  const MAX_PROPS = 16;

  // Shape 0 is a box (hx, hz are half extents), 1 an upright cylinder (hx is
  // the radius). `id` is what the shader colors by. Words are what a visitor
  // might call one, English and Korean, singular and plural.
  const KINDS = {
    crate: { id: 1, shape: 0, words: /^(crates?|box(es)?|상자|박스|크레이트)$/i, one: 'a crate', many: 'crates' },
    barrel: { id: 2, shape: 1, words: /^(barrels?|drums?|드럼통?|통|배럴)$/i, one: 'a barrel', many: 'barrels' },
    post: { id: 3, shape: 0, words: /^(posts?|poles?|pillars?|columns?|기둥|말뚝)$/i, one: 'a post', many: 'posts' },
    slab: { id: 4, shape: 0, words: /^(slabs?|rubble|blocks?|debris|잔해|블록|판)$/i, one: 'a slab', many: 'slabs' },
    pallet: { id: 5, shape: 0, words: /^(pallets?|팔레트|파레트)$/i, one: 'a pallet', many: 'pallets' },
    cone: { id: 6, shape: 1, words: /^(cones?|bollards?|콘|고깔|볼라드)$/i, one: 'a cone', many: 'cones' },
    rack: { id: 7, shape: 0, words: /^(racks?|shel(f|ves)|선반|랙)$/i, one: 'a rack', many: 'racks' },
    tree: { id: 8, shape: 1, words: /^(trees?|trunks?|나무)$/i, one: 'a tree', many: 'trees' },
    rock: { id: 9, shape: 0, words: /^(rocks?|boulders?|stones?|바위|돌)$/i, one: 'a rock', many: 'rocks' },
    wall: { id: 10, shape: 0, words: /^(walls?|벽|담)$/i, one: 'a wall', many: 'walls' },
  };

  // x is toward the camera's right, z away from it; (0, 0) is the middle of
  // the robots' clearing. [kind, x, z, hx, hz, height]
  const SITES = [
    {
      id: 'yard', title: 'yard',
      words: /\b(yard|courtyard|parking lot)\b|마당|야드/i,
      props: [
        ['crate', 1.9, 1.2, 0.3, 0.3, 0.6], ['crate', 2.45, 1.35, 0.25, 0.25, 0.5], ['crate', 2.1, 1.9, 0.32, 0.28, 0.62],
        ['post', -2.3, 2.2, 0.07, 0.07, 1.5], ['pallet', -2.6, 0.1, 0.6, 0.5, 0.14],
      ],
    },
    {
      id: 'warehouse', title: 'warehouse',
      words: /\b(warehouse|storage|depot|logistics|fulfil+ment)\b|창고|물류/i,
      props: [
        ['rack', -2.6, 2.6, 0.45, 1.3, 1.9], ['rack', 2.8, 2.9, 0.45, 1.3, 1.9],
        ['pallet', -1.3, 3.3, 0.6, 0.5, 0.14], ['crate', -1.3, 3.3, 0.35, 0.3, 0.75],
        ['pallet', 1.5, 0.6, 0.6, 0.5, 0.14], ['crate', 1.35, 0.55, 0.28, 0.28, 0.56], ['crate', 1.75, 0.7, 0.22, 0.25, 0.9],
        ['crate', 0.3, 3.4, 0.3, 0.3, 0.6], ['post', -3.4, 0.4, 0.08, 0.08, 1.2],
      ],
    },
    {
      id: 'rubble', title: 'rubble field',
      words: /\b(rubble|debris|ruins?|collapsed?|disaster|wreck(age)?|earthquake)\b|잔해|폐허|무너진|붕괴/i,
      props: [
        ['slab', 1.4, 0.9, 0.7, 0.4, 0.18], ['slab', -2.9, 2.0, 0.5, 0.65, 0.26], ['rock', 0.9, 2.3, 0.28, 0.24, 0.35],
        ['slab', 2.4, 2.6, 0.55, 0.3, 0.42], ['rock', -0.8, 3.1, 0.35, 0.3, 0.5], ['slab', -2.6, 0.2, 0.4, 0.35, 0.12],
        ['rock', 1.9, -0.6, 0.2, 0.22, 0.25], ['post', -2.0, 2.8, 0.1, 0.1, 0.9], ['slab', 0.1, 4.2, 0.9, 0.35, 0.3],
        ['rock', -1.2, -1.1, 0.18, 0.2, 0.2],
      ],
    },
    {
      id: 'slalom', title: 'cone slalom',
      words: /\b(slalom|obstacle course|course|zig ?zag|training)\b|슬라럼|장애물|지그재그|훈련/i,
      props: [
        ['cone', -2.2, 3.4, 0.16, 0.16, 0.5], ['cone', -0.9, 2.8, 0.16, 0.16, 0.5], ['cone', 0.4, 3.4, 0.16, 0.16, 0.5],
        ['cone', 1.7, 2.8, 0.16, 0.16, 0.5], ['cone', 3.0, 3.4, 0.16, 0.16, 0.5], ['cone', 1.6, 0.9, 0.16, 0.16, 0.5],
      ],
    },
    {
      id: 'forest', title: 'forest',
      words: /\b(forest|woods?|woodland|grove|jungle)\b|숲|산림|정글/i,
      props: [
        ['tree', -2.2, 1.6, 0.16, 0.16, 3.2], ['tree', 1.8, 2.4, 0.2, 0.2, 3.2], ['tree', 0.4, 4.3, 0.18, 0.18, 3.2],
        ['tree', -2.8, -0.4, 0.14, 0.14, 3.2], ['tree', 3.0, 0.2, 0.17, 0.17, 3.2], ['tree', -3.2, 3.9, 0.22, 0.22, 3.2],
        ['rock', 0.9, 1.3, 0.25, 0.2, 0.3], ['tree', -1.5, 4.8, 0.15, 0.15, 3.2],
      ],
    },
    {
      id: 'plant', title: 'drum yard',
      words: /\b(factory|refinery|drums|barrels|industrial)\b|공장|드럼통들|산업/i,
      props: [
        ['barrel', 1.6, 1.0, 0.28, 0.28, 0.88], ['barrel', 2.2, 1.1, 0.28, 0.28, 0.88], ['barrel', 1.9, 1.55, 0.28, 0.28, 0.88],
        ['barrel', -1.9, 2.2, 0.28, 0.28, 0.88], ['barrel', -2.45, 2.5, 0.28, 0.28, 0.88],
        ['wall', 0.2, 4.4, 2.2, 0.12, 1.1], ['pallet', 1.6, -1.2, 0.6, 0.5, 0.14],
      ],
    },
    {
      id: 'corridor', title: 'narrow corridor',
      words: /\b(corridor|hallway|alley|narrow|passage|tunnel|canyon)\b|복도|골목|통로|좁은|협곡/i,
      props: [
        ['wall', 2.9, 0.95, 2.0, 0.12, 1.0], ['wall', 2.9, 2.35, 2.0, 0.12, 1.0],
        ['post', 0.8, 0.95, 0.12, 0.12, 1.3], ['post', 0.8, 2.35, 0.12, 0.12, 1.3], ['crate', 4.4, 1.65, 0.25, 0.25, 0.5],
      ],
    },
    {
      id: 'clear', title: 'open ground',
      words: /\b(empty|clear( it| the (ground|field|site))?|open field|flat|nothing|reset)\b|비워|빈 ?곳|평지|아무것도|초기화/i,
      props: [],
    },
  ];

  function kindOf(word) {
    const w = String(word || '').trim();
    return Object.keys(KINDS).find((k) => KINDS[k].words.test(w)) || null;
  }

  function find(id) {
    return SITES.find((s) => s.id === id) || null;
  }

  // A place named in the phrase, if any.
  function match(text) {
    return SITES.find((s) => s.words.test(text)) || null;
  }

  // The first site that has a prop of this kind, for "go to the trees" said
  // somewhere without any.
  function withKind(kind) {
    return SITES.find((s) => s.props.some((p) => p[0] === kind)) || null;
  }

  function next(id) {
    const i = SITES.findIndex((s) => s.id === id);
    // Skip the empty one when cycling on its own.
    const pool = SITES.filter((s) => s.props.length);
    const j = pool.findIndex((s) => s.id === (SITES[i] || {}).id);
    return pool[(j + 1) % pool.length];
  }

  // A site as props in scene coordinates, with anything that would come up
  // around a robot or the camera pushed clear of it, or dropped.
  function place(site, center, keepOut) {
    const props = [];
    site.props.slice(0, MAX_PROPS).forEach((p) => {
      const kind = KINDS[p[0]];
      if (!kind) return;
      const prop = {
        kind: p[0], x: center[0] + p[1], z: center[2] + p[2],
        hx: p[3], hz: kind.shape ? p[3] : p[4], h: p[5], round: kind.shape === 1,
      };
      for (let tries = 0; tries < 3; tries++) {
        const hit = keepOut.find((k) => edgeDistance(prop, k.x, k.z) < k.r);
        if (!hit) break;
        let dx = prop.x - hit.x;
        let dz = prop.z - hit.z;
        const len = Math.hypot(dx, dz) || 1;
        if (len < 1e-3) { dx = 1; dz = 0; }
        const shove = hit.r - edgeDistance(prop, hit.x, hit.z) + 0.05;
        prop.x += (dx / len) * shove;
        prop.z += (dz / len) * shove;
      }
      if (keepOut.some((k) => edgeDistance(prop, k.x, k.z) < k.r)) return;
      props.push(prop);
    });
    return props;
  }

  function edgeDistance(prop, x, z) {
    if (prop.round) return Math.hypot(x - prop.x, z - prop.z) - prop.hx;
    const dx = Math.max(Math.abs(x - prop.x) - prop.hx, 0);
    const dz = Math.max(Math.abs(z - prop.z) - prop.hz, 0);
    return Math.hypot(dx, dz);
  }

  // Row 0: x, z (5 cm steps around the center), hx, hz (1 cm). Row 1: height
  // (1 cm), kind id, shape. Unused slots are all zero, which the shader skips.
  function pack(props, center, out) {
    out.fill(0);
    const q = (v, step) => Math.max(0, Math.min(255, Math.round(v / step)));
    props.slice(0, MAX_PROPS).forEach((p, i) => {
      const a = i * 4;
      const b = (MAX_PROPS + i) * 4;
      out[a] = q(p.x - center[0] + 6.4, 0.05);
      out[a + 1] = q(p.z - center[2] + 6.4, 0.05);
      out[a + 2] = q(p.hx, 0.01);
      out[a + 3] = q(p.hz, 0.01);
      out[b] = q(p.h, 0.01);
      out[b + 1] = KINDS[p.kind].id;
      out[b + 2] = p.round ? 255 : 0;
    });
    return out;
  }

  // A site written by the model: trust nothing, clamp everything.
  function fromReply(reply) {
    if (!reply || !Array.isArray(reply.props)) return null;
    const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
    const props = [];
    reply.props.slice(0, MAX_PROPS).forEach((p) => {
      if (!p || !KINDS[p.kind]) return;
      const x = num(p.x, -5.5, 5.5);
      const z = num(p.z, -2.5, 5.5);
      const sx = num(p.sx, 0.05, 2.5);
      const sz = num(p.sz, 0.05, 2.5);
      const h = num(p.h, 0.05, 2.5);
      if ([x, z, sx, sz, h].some((v) => v === null)) return;
      props.push([p.kind, x, z, sx / 2, sz / 2, h]);
    });
    const title = typeof reply.title === 'string' ? reply.title.slice(0, 32).toLowerCase() : 'somewhere new';
    return { id: 'gen:' + title, title, props, words: /$^/ };
  }

  return { MAX_PROPS, KINDS, SITES, kindOf, find, match, withKind, next, place, pack, edgeDistance, fromReply };
})();
