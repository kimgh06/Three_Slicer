// The WGSL of the contour union pipeline (contour_gpu.js). This is the shader text of the measured experiment
//  (.omc/plans/gpu-parallel-topology-design.md, appendices D to F17), kept as it ran: every kernel here was checked
//  against Clipper on real slices, so it is edited only with a measurement beside it. The host that binds and
//  dispatches them, and the meaning of every buffer, is contour_gpu.js.
//
// Conventions shared by every kernel: a dispatch is two-dimensional (x up to 65535 workgroups of 256, y the overflow),
//  so an invocation's index is g.x + g.y * 16776960; a segment's index is also the id of the vertex it starts at; a
//  crossing's vertex id is segmentCount + its pair index.

const PRELUDE = /* wgsl */`// a range from a corrupt scan must not spin the GPU: a dispatch keeps running after its process is killed (measured). Observed max 107 per cell, 13 per segment.
const RANGE_CAP = 4096u;
fn badRange(lo: u32, hi: u32) -> bool { return hi < lo || hi - lo > RANGE_CAP; }

fn mulu(a: u32, b: u32) -> vec2<u32> {   // unsigned 32x32 -> 64 (lo, hi)
  let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u;
  let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
  var lo = ll; var hi = hh + (lh >> 16u) + (hl >> 16u);
  let t1 = lh << 16u; lo = lo + t1; if (lo < t1) { hi = hi + 1u; }
  let t2 = hl << 16u; lo = lo + t2; if (lo < t2) { hi = hi + 1u; }
  return vec2<u32>(lo, hi);
}
fn muls(a: i32, b: i32) -> vec2<u32> {   // signed 32x32 -> 64, two's complement
  let neg = (a < 0) != (b < 0);
  var r = mulu(u32(abs(a)), u32(abs(b)));
  if (neg) { r = neg64(r); }
  return r;
}
fn neg64(a: vec2<u32>) -> vec2<u32> { var lo = ~a.x; var hi = ~a.y; lo = lo + 1u; if (lo == 0u) { hi = hi + 1u; } return vec2<u32>(lo, hi); }
fn sub64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> { var hi = a.y - b.y; if (a.x < b.x) { hi = hi - 1u; } return vec2<u32>(a.x - b.x, hi); }
fn sign64(a: vec2<u32>) -> i32 { if ((a.y & 0x80000000u) != 0u) { return -1; } if (a.x == 0u && a.y == 0u) { return 0; } return 1; }
fn cross(ux: i32, uy: i32, vx: i32, vy: i32) -> vec2<u32> { return sub64(muls(ux, vy), muls(uy, vx)); }
fn orient(ax: i32, ay: i32, bx: i32, by: i32, cx: i32, cy: i32) -> i32 { return sign64(cross(bx - ax, by - ay, cx - ax, cy - ay)); }
fn u64f(a: vec2<u32>) -> f32 { return f32(a.y) * 4294967296.0 + f32(a.x); }   // non-negative values only
// exact rounded quotient round(num * |d| / den) for 0 <= num < den (u64), |d| < 2^31: restoring division in 128-bit arithmetic
fn add128u(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> { var r: vec4<u32>; r.x = a.x + b.x; var c = select(0u, 1u, r.x < a.x);
  let y = a.y + b.y; var c1 = select(0u, 1u, y < a.y); r.y = y + c; if (r.y < y) { c1 = 1u; } c = c1;
  let z = a.z + b.z; var c2 = select(0u, 1u, z < a.z); r.z = z + c; if (r.z < z) { c2 = 1u; } c = c2; r.w = a.w + b.w + c; return r; }
fn sub128u(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> { return add128u(a, add128u(vec4<u32>(~b.x, ~b.y, ~b.z, ~b.w), vec4<u32>(1u, 0u, 0u, 0u))); }
fn ge128(a: vec4<u32>, b: vec4<u32>) -> bool { if (a.w != b.w) { return a.w > b.w; } if (a.z != b.z) { return a.z > b.z; } if (a.y != b.y) { return a.y > b.y; } return a.x >= b.x; }
fn shl128(a: vec4<u32>, s: u32) -> vec4<u32> { if (s == 0u) { return a; } let t = 32u - s; return vec4<u32>(a.x << s, (a.y << s) | (a.x >> t), (a.z << s) | (a.y >> t), (a.w << s) | (a.z >> t)); }
fn roundedShift(num: vec2<u32>, den: vec2<u32>, d: i32) -> i32 {
  if (d == 0) { return 0; }
  let ad = u32(abs(d)); let lo = mulu(num.x, ad); let hi = mulu(num.y, ad);
  var n = vec4<u32>(lo.x, lo.y, 0u, 0u); n = add128u(n, vec4<u32>(0u, hi.x, hi.y, 0u));
  n = shl128(n, 1u); n = add128u(n, vec4<u32>(den.x, den.y, 0u, 0u));
  let dd = shl128(vec4<u32>(den.x, den.y, 0u, 0u), 1u);
  var q = 0u; var sh = shl128(dd, 31u);
  for (var b = 31; b >= 0; b--) { if (ge128(n, sh)) { n = sub128u(n, sh); q = q | (1u << u32(b)); }
    sh = vec4<u32>((sh.x >> 1u) | (sh.y << 31u), (sh.y >> 1u) | (sh.z << 31u), (sh.z >> 1u) | (sh.w << 31u), sh.w >> 1u); }
  if (d < 0) { return -i32(q); } return i32(q);
}
struct Params { n: u32, cells: u32, cs: i32, mode: u32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> segs: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> segInfo: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read> layerInfo: array<vec4<i32>>;   // gw, gh, cellBase, 0
fn vtx(v: u32) -> vec2<i32> { return segs[v].xy; }
fn orientSoS(p: u32, q: u32, r: u32) -> i32 {   // Simulation of Simplicity: higher id dominates, x displacement before y
  let P = vtx(p); let Q = vtx(q); let R = vtx(r);
  let d = orient(P.x, P.y, Q.x, Q.y, R.x, R.y); if (d != 0) { return d; }
  var ids = array<u32, 3>(p, q, r);
  var cv = array<vec2<i32>, 3>(R - Q, P - R, Q - P);
  for (var round = 0; round < 3; round++) {
    var top = 0u; var found = false;
    for (var k = 0; k < 3; k++) { if (ids[k] != 0xffffffffu && (!found || ids[k] > top)) { top = ids[k]; found = true; } }
    if (!found) { break; }
    var c = vec2<i32>(0, 0);
    for (var k = 0; k < 3; k++) { if (ids[k] == top) { c = c + cv[k]; ids[k] = 0xffffffffu; } }
    if (c.y != 0) { return -sign(c.y); }
    if (c.x != 0) { return sign(c.x); }
  }
  return 0;
}
fn cellRange(i: u32) -> vec4<i32> { let s = segs[i]; return vec4<i32>(min(s.x, s.z) / params.cs, min(s.y, s.w) / params.cs, max(s.x, s.z) / params.cs, max(s.y, s.w) / params.cs); }
`

export const BIN_SHADER = PRELUDE + /* wgsl */`
@group(0) @binding(4) var<storage, read_write> cellCount: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> cellStart: array<u32>;
@group(0) @binding(6) var<storage, read_write> cellList: array<vec2<u32>>;
@compute @workgroup_size(256) fn count(@builtin(global_invocation_id) gid_raw: vec3<u32>) { let gid = vec3<u32>(gid_raw.x + gid_raw.y * 16776960u, 0u, 0u);
  let i = gid.x; if (i >= params.n) { return; }
  let r = cellRange(i); let L = layerInfo[segInfo[i].x];
  for (var cy = r.y; cy <= r.w; cy++) { for (var cx = r.x; cx <= r.z; cx++) { atomicAdd(&cellCount[u32(L.z + cy * L.x + cx)], 1u); } }
}
@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) gid_raw: vec3<u32>) { let gid = vec3<u32>(gid_raw.x + gid_raw.y * 16776960u, 0u, 0u);
  let i = gid.x; if (i >= params.n) { return; }
  let r = cellRange(i); let L = layerInfo[segInfo[i].x];
  for (var cy = r.y; cy <= r.w; cy++) { for (var cx = r.x; cx <= r.z; cx++) { let c = u32(L.z + cy * L.x + cx); let k = atomicAdd(&cellCount[c], 1u); if (cellStart[c] + k < arrayLength(&cellList)) { cellList[cellStart[c] + k] = vec2<u32>(i, c); } } }
}`

export const INTERSECT_SHADER = PRELUDE + /* wgsl */`
@group(0) @binding(4) var<storage, read> cellStart: array<u32>;
@group(0) @binding(5) var<storage, read> cellList: array<vec2<u32>>;
@group(0) @binding(6) var<storage, read_write> evCount: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> events: array<vec4<u32>>;
@group(0) @binding(8) var<storage, read> evStart: array<u32>;
@group(0) @binding(9) var<storage, read_write> flags: array<atomic<u32>>;   // [0]: pair counter, [1]: collinear pivots
@group(0) @binding(10) var<storage, read_write> pairEdges: array<vec2<u32>>;
fn emit(seg: u32, num: vec2<u32>, den: vec2<u32>, delta: i32, px: i32, py: i32, vid: u32) {
  if (params.mode == 0u) { atomicAdd(&evCount[seg], 1u); return; }
  let k = atomicAdd(&evCount[seg], 1u); let at = (evStart[seg] + k) * 2u; if (at + 1u >= arrayLength(&events)) { return; }
  events[at] = vec4<u32>(num.x, num.y, den.x, den.y); events[at + 1u] = vec4<u32>(bitcast<u32>(delta), bitcast<u32>(px), bitcast<u32>(py), vid);
}
fn dotw(ux: i32, uy: i32, vx: i32, vy: i32) -> vec2<u32> { let a = muls(ux, vx); let b = muls(uy, vy); var lo = a.x + b.x; var hi = a.y + b.y; if (lo < a.x) { hi = hi + 1u; } return vec2<u32>(lo, hi); }
@compute @workgroup_size(256) fn intersect(@builtin(global_invocation_id) gid_raw: vec3<u32>) { let gid = vec3<u32>(gid_raw.x + gid_raw.y * 16776960u, 0u, 0u);
  let a0 = gid.x; if (a0 >= arrayLength(&cellList) || params.cells == 0u) { return; }
  let c = cellList[a0].y; if (c >= params.cells) { return; }
  let s0 = cellStart[c]; let s1 = cellStart[c + 1u]; if (a0 < s0 || a0 >= s1 || badRange(s0, s1)) { return; }
  let L = layerInfo[segInfo[cellList[s0].x].x];
  let cl = i32(c) - L.z; let cellX = cl % L.x; let cellY = cl / L.x;
  for (var a = a0; a < a0 + 1u; a++) {
    let i = cellList[a].x; let A = segs[i]; let a1 = segInfo[i].z;
    for (var b = a + 1u; b < s1; b++) {
      let j = cellList[b].x; let Bs = segs[j]; let b1 = segInfo[j].z;
      let lox = max(min(A.x, A.z), min(Bs.x, Bs.z)); let hix = min(max(A.x, A.z), max(Bs.x, Bs.z));
      let loy = max(min(A.y, A.w), min(Bs.y, Bs.w)); let hiy = min(max(A.y, A.w), max(Bs.y, Bs.w));
      if (lox > hix || loy > hiy) { continue; }
      if (lox / params.cs != cellX || loy / params.cs != cellY) { continue; }
      if (i == j || i == b1 || a1 == j || a1 == b1) { continue; }   // adjacent edges meet only at their shared vertex
      let o1 = orientSoS(i, a1, j); let o2 = orientSoS(i, a1, b1); let o3 = orientSoS(j, b1, i); let o4 = orientSoS(j, b1, a1);
      if (!(o1 * o2 < 0 && o3 * o4 < 0)) { continue; }
      var den = cross(A.z - A.x, A.w - A.y, Bs.z - Bs.x, Bs.w - Bs.y);
      var numI = vec2<u32>(0u, 0u); var denI = vec2<u32>(1u, 0u); var numJ = vec2<u32>(0u, 0u); var denJ = vec2<u32>(1u, 0u);
      var px = 0; var py = 0;
      if (sign64(den) != 0) {
        numI = cross(Bs.x - A.x, Bs.y - A.y, Bs.z - Bs.x, Bs.w - Bs.y); denI = den;
        if (sign64(denI) < 0) { numI = neg64(numI); denI = neg64(denI); }
        numJ = cross(A.x - Bs.x, A.y - Bs.y, A.z - A.x, A.w - A.y); denJ = neg64(den);
        if (sign64(denJ) < 0) { numJ = neg64(numJ); denJ = neg64(denJ); }
        // the point is computed along the lower-index segment: which of the two a cell lists first depends on atomic order, and the
        //  two parametrisations round differently in f32 (measured: 1-unit differences between identical runs)
        // exact integer rounding (f32 rounded 0.84 % of points differently on SwiftShader than on Metal), along the lower-index segment
        if (params.mode == 0u) { }
        else if (i < j) { px = A.x + roundedShift(numI, denI, A.z - A.x); py = A.y + roundedShift(numI, denI, A.w - A.y); }
        else { px = Bs.x + roundedShift(numJ, denJ, Bs.z - Bs.x); py = Bs.y + roundedShift(numJ, denJ, Bs.w - Bs.y); }
      } else {   // collinear pair made to cross by SoS: next to the pivot endpoint
        if (params.mode == 1u) { atomicAdd(&flags[1], 1u); }
        let top = max(max(i, a1), max(j, b1)); var pv = a1;
        if (top == b1) { pv = j; } else if (top == j) { pv = b1; } else if (top == a1) { pv = i; }
        let Pv = vtx(pv); px = Pv.x; py = Pv.y;
        if (pv == i) { numI = vec2<u32>(0u, 0u); } else if (pv == a1) { numI = vec2<u32>(1u, 0u); } else { numI = dotw(px - A.x, py - A.y, A.z - A.x, A.w - A.y); denI = dotw(A.z - A.x, A.w - A.y, A.z - A.x, A.w - A.y); }
        if (pv == j) { numJ = vec2<u32>(0u, 0u); } else if (pv == b1) { numJ = vec2<u32>(1u, 0u); } else { numJ = dotw(px - Bs.x, py - Bs.y, Bs.z - Bs.x, Bs.w - Bs.y); denJ = dotw(Bs.z - Bs.x, Bs.w - Bs.y, Bs.z - Bs.x, Bs.w - Bs.y); }
      }
      var vid = 0u;
      if (params.mode == 1u) { let pid = atomicAdd(&flags[0], 1u); vid = params.n + pid; if (pid < arrayLength(&pairEdges)) { pairEdges[pid] = vec2<u32>(i, j); } }
      var dI = -1; if (o3 < 0) { dI = 1; }
      var dJ = -1; if (o1 < 0) { dJ = 1; }
      emit(i, numI, denI, dI, px, py, vid);
      emit(j, numJ, denJ, dJ, px, py, vid);
    }
  }
}`

export const SORT_SHADER = PRELUDE + /* wgsl */`
@group(0) @binding(4) var<storage, read> evStart: array<u32>;
@group(0) @binding(5) var<storage, read_write> events: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read> pairEdges: array<vec2<u32>>;
fn add64(a: vec2<u32>, b: vec2<u32>) -> vec3<u32> { var lo = a.x + b.x; var c = 0u; if (lo < a.x) { c = 1u; } var hi = a.y + b.y + c; var c2 = 0u; if (hi < a.y || (c == 1u && hi == a.y)) { c2 = 1u; } return vec3<u32>(lo, hi, c2); }
fn mul128(a: vec2<u32>, b: vec2<u32>) -> vec4<u32> {
  let p00 = mulu(a.x, b.x); let p01 = mulu(a.x, b.y); let p10 = mulu(a.y, b.x); let p11 = mulu(a.y, b.y);
  var r0 = p00.x;
  let s1 = add64(vec2<u32>(p00.y, 0u), vec2<u32>(p01.x, p01.y));   // limbs 1,2 (+carry into 3)
  let s2 = add64(vec2<u32>(s1.x, s1.y), vec2<u32>(p10.x, p10.y));
  let s3 = add64(vec2<u32>(s2.y, s1.z + s2.z), vec2<u32>(p11.x, p11.y));
  return vec4<u32>(r0, s2.x, s3.x, s3.y);
}
fn lt128(x: vec4<u32>, y: vec4<u32>) -> bool {
  if (x.w != y.w) { return x.w < y.w; } if (x.z != y.z) { return x.z < y.z; } if (x.y != y.y) { return x.y < y.y; } return x.x < y.x;
}
fn before(p: vec4<u32>, q: vec4<u32>) -> bool { return lt128(mul128(p.xy, q.zw), mul128(q.xy, p.zw)); }
// ---- two events at the same place on a segment: ordered as if every vertex were moved by an infinitesimal amount,
//  higher vertex ids first, x before y (the same perturbation the crossing test uses). The order is the sign of the
//  difference of the two events' parameters' derivatives, each a fraction of signed integers up to 128 bits.
struct SM { m: vec4<u32>, neg: bool }
fn isZero128(a: vec4<u32>) -> bool { return a.x == 0u && a.y == 0u && a.z == 0u && a.w == 0u; }
fn add128(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {
  var r = vec4<u32>(0u); var carry = 0u;
  for (var k = 0; k < 4; k++) { let s1 = a[k] + b[k]; var c = 0u; if (s1 < a[k]) { c = 1u; } let s2 = s1 + carry; if (s2 < s1) { c = 1u; } r[k] = s2; carry = c; }
  return r; }
fn sub128(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {   // a >= b
  var r = vec4<u32>(0u); var borrow = 0u;
  for (var k = 0; k < 4; k++) { let d1 = a[k] - b[k]; var c = 0u; if (a[k] < b[k]) { c = 1u; } let d2 = d1 - borrow; if (d1 < borrow) { c = 1u; } r[k] = d2; borrow = c; }
  return r; }
fn smAdd(a: SM, b: SM) -> SM {
  if (a.neg == b.neg) { return SM(add128(a.m, b.m), a.neg); }
  if (lt128(a.m, b.m)) { return SM(sub128(b.m, a.m), b.neg); }
  return SM(sub128(a.m, b.m), a.neg); }
fn smNeg(a: SM) -> SM { return SM(a.m, !a.neg); }
fn smProd(u: vec2<u32>, x: i32) -> SM { return SM(mul128(u, vec2<u32>(u32(abs(x)), 0u)), x < 0); }   // unsigned 64 x signed 32
fn mul256(a: vec4<u32>, b: vec4<u32>) -> array<u32, 8> {
  var r: array<u32, 8>;
  for (var i = 0; i < 4; i++) { var carry = 0u;
    for (var j = 0; j < 4; j++) { let p = mulu(a[i], b[j]); let s1 = r[i + j] + p.x; var c = 0u; if (s1 < p.x) { c = 1u; } let s2 = s1 + carry; if (s2 < s1) { c = c + 1u; } r[i + j] = s2; carry = p.y + c; }
    r[i + 4] = carry; }
  return r; }
// sign of num1/den1 - num2/den2, by cross-multiplying (a zero denominator gives equal, as on the CPU)
fn cmpFrac(n1in: SM, d1: SM, n2in: SM, d2: SM) -> i32 {
  var n1 = n1in; var n2 = n2in; if (d1.neg) { n1.neg = !n1.neg; } if (d2.neg) { n2.neg = !n2.neg; }
  let l = mul256(n1.m, d2.m); let r = mul256(n2.m, d1.m);
  var lz = true; var rz = true; var mag = 0;
  for (var k = 7; k >= 0; k--) { if (l[k] != 0u) { lz = false; } if (r[k] != 0u) { rz = false; } if (mag == 0 && l[k] != r[k]) { if (l[k] < r[k]) { mag = -1; } else { mag = 1; } } }
  let ln = n1.neg && !lz; let rn = n2.neg && !rz;
  if (ln != rn) { if (ln) { return -1; } return 1; }
  if (ln) { return -mag; }
  return mag; }
struct Shift { num: SM, den: SM }
// the derivative of the event's parameter along segment A when vertex v moves in x (axis 0) or y (axis 1)
fn shiftOf(A: u32, n: vec2<u32>, d: vec2<u32>, C: u32, v: u32, axis: u32) -> Shift {
  let a0 = A; let a1 = segInfo[A].z; let c0 = C; let c1 = segInfo[C].z;
  let Pa0 = vtx(a0); let Pa1 = vtx(a1); let Pc0 = vtx(c0); let Pc1 = vtx(c1);
  let dAx = Pa1.x - Pa0.x; let dAy = Pa1.y - Pa0.y; let dCx = Pc1.x - Pc0.x; let dCy = Pc1.y - Pc0.y;
  var D = cross(dAx, dAy, dCx, dCy); let Dneg = sign64(D) < 0; if (Dneg) { D = neg64(D); }
  let den = SM(mul128(D, d), Dneg);
  // cg(u) = gx * u.y - gy * u.x, for u = (w - a0) * d - n * dA, and for u = dC
  var cgC = dCy; if (axis == 1u) { cgC = -dCx; }
  var num = SM(vec4<u32>(0u), false); var touched = false;
  if (v == c0 || v == c1) {
    var w = Pc1; if (v == c1) { w = Pc0; }
    var part: SM;
    if (axis == 0u) { part = smAdd(smProd(d, w.y - Pa0.y), smNeg(smProd(n, dAy))); }
    else { part = smNeg(smAdd(smProd(d, w.x - Pa0.x), smNeg(smProd(n, dAx)))); }
    if (v == c0) { num = smAdd(num, part); }
    if (v == c1) { num = smAdd(num, smNeg(part)); }
    touched = true; }
  if (v == c0 && v == c1) { touched = true; }
  if (v == a0) { let lo = d.x - n.x; var hi = d.y - n.y; if (d.x < n.x) { hi = hi - 1u; } num = smAdd(num, smNeg(smProd(vec2<u32>(lo, hi), cgC))); touched = true; }
  if (v == a1) { num = smAdd(num, smNeg(smProd(n, cgC))); touched = true; }
  if (!touched) { return Shift(SM(vec4<u32>(0u), false), SM(vec4<u32>(1u, 0u, 0u, 0u), false)); }
  return Shift(num, den); }
fn otherEdge(A: u32, vid: u32) -> u32 { let pid = vid - params.n; if (pid >= arrayLength(&pairEdges)) { return A; } let e = pairEdges[pid]; if (e.x == A) { return e.y; } return e.x; }
// -1: p first, 1: q first, 0: the perturbation does not separate them (two segments on one line)
fn sosOrder(A: u32, p0: vec4<u32>, p1: vec4<u32>, q0: vec4<u32>, q1: vec4<u32>) -> i32 {
  let Cp = otherEdge(A, p1.w); let Cq = otherEdge(A, q1.w);
  var ids = array<u32, 6>(A, segInfo[A].z, Cp, segInfo[Cp].z, Cq, segInfo[Cq].z);
  for (var round = 0; round < 6; round++) {
    var top = 0u; var found = false;
    for (var k = 0; k < 6; k++) { if (ids[k] != 0xffffffffu && (!found || ids[k] > top)) { top = ids[k]; found = true; } }
    if (!found) { break; }
    for (var k = 0; k < 6; k++) { if (ids[k] == top) { ids[k] = 0xffffffffu; } }
    for (var axis = 0u; axis < 2u; axis++) {
      let sp = shiftOf(A, p0.xy, p0.zw, Cp, top, axis); let sq = shiftOf(A, q0.xy, q0.zw, Cq, top, axis);
      let c = cmpFrac(sp.num, sp.den, sq.num, sq.den);
      if (c != 0) { return c; } } }
  return 0; }
fn beforeExact(A: u32, k0: vec4<u32>, k1: vec4<u32>, p0: vec4<u32>, p1: vec4<u32>) -> bool {
  if (before(k0, p0)) { return true; }
  if (before(p0, k0)) { return false; }
  if (params.mode == 0u) { return false; }
  return sosOrder(A, k0, k1, p0, p1) < 0; }
@compute @workgroup_size(256) fn sortEvents(@builtin(global_invocation_id) gid_raw: vec3<u32>) { let gid = vec3<u32>(gid_raw.x + gid_raw.y * 16776960u, 0u, 0u);
  let i = gid.x; if (i >= params.n) { return; }
  let r0 = evStart[i]; let r1 = evStart[i + 1u]; if (badRange(r0, r1)) { return; }
  for (var a = r0 + 1u; a < r1; a++) {
    let k0 = events[a * 2u]; let k1 = events[a * 2u + 1u]; var b = a;
    loop { if (b == r0) { break; } let p = events[(b - 1u) * 2u]; let p1 = events[(b - 1u) * 2u + 1u]; if (!beforeExact(i, k0, k1, p, p1)) { break; } events[b * 2u] = p; events[b * 2u + 1u] = p1; b = b - 1u; }
    events[b * 2u] = k0; events[b * 2u + 1u] = k1;
  }
}`

export const LINK_SHADER = /* wgsl */`
struct LP { e: u32, v: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> lp: LP;
@group(0) @binding(1) var<storage, read> pv: array<vec4<u32>>;          // start vid, end vid, layer
@group(0) @binding(2) var<storage, read> pc: array<vec4<i32>>;          // sx, sy, ex, ey
@group(0) @binding(3) var<storage, read_write> vcount: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> vstart: array<u32>;
@group(0) @binding(5) var<storage, read_write> vlist: array<u32>;
@group(0) @binding(6) var<storage, read_write> succ: array<u32>;
@group(0) @binding(7) var<storage, read_write> labA: array<vec2<u32>>;   // label, next
@group(0) @binding(8) var<storage, read_write> labB: array<vec2<u32>>;
@compute @workgroup_size(256) fn vcountK(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); if (g.x >= lp.e) { return; } atomicAdd(&vcount[pv[g.x].x], 1u); }
@compute @workgroup_size(256) fn vscatter(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); if (g.x >= lp.e) { return; } let v = pv[g.x].x; let k = atomicAdd(&vcount[v], 1u); vlist[vstart[v] + k] = g.x; }
@compute @workgroup_size(256) fn successor(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u);
  let e = g.x; if (e >= lp.e) { return; }
  let v = pv[e].y; let a = vstart[v]; let b = vstart[v + 1u];
  if (b == a) { succ[e] = e; labA[e] = vec2<u32>(e, e); return; }
  var best = vlist[a];
  if (b - a > 1024u) { atomicAdd(&vcount[lp.v], 1u); succ[e] = e; labA[e] = vec2<u32>(e, e); return; }   // out-degree cap: a corrupt vstart must not spin the GPU
  if (b - a > 1u) {   // first outgoing edge clockwise from the reverse of the incoming one
    let q = pc[e]; let rin = atan2(f32(q.y - q.w), f32(q.x - q.z)); var bestAng = 10.0;
    for (var k = a; k < b; k++) { let o = vlist[k]; let r = pc[o]; var ang = rin - atan2(f32(r.w - r.y), f32(r.z - r.x));
      if (!(ang > 0.0)) { ang = ang + 6.2831853; } if (ang > 6.2831853) { ang = ang - 6.2831853; }   // a difference of two atan2 lies in [-2pi, 2pi]: one step each, no loop
      if (ang < bestAng) { bestAng = ang; best = o; } }
  }
  succ[e] = best; labA[e] = vec2<u32>(min(e, best), best);
}
@compute @workgroup_size(256) fn jumpAB(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let e = g.x; if (e >= lp.e) { return; } let s = labA[e]; let t = labA[s.y]; labB[e] = vec2<u32>(min(s.x, t.x), t.y); }
@compute @workgroup_size(256) fn jumpBA(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let e = g.x; if (e >= lp.e) { return; } let s = labB[e]; let t = labB[s.y]; labA[e] = vec2<u32>(min(s.x, t.x), t.y); }
`

export const SCAN_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> sp: vec4<u32>;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> sums: array<u32>;
var<workgroup> tmp: array<u32, 256>;
@compute @workgroup_size(256) fn scanBlock(@builtin(global_invocation_id) g_raw: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>, @builtin(workgroup_id) wg_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let wg = vec3<u32>(wg_raw.x + wg_raw.y * 65535u, 0u, 0u);
  if (wg.x * 256u >= sp.x + 256u) { return; }   // a workgroup past the last block (the second dispatch row): nothing to scan, and sums[wg] would be out of range
  let i = g.x; var v = 0u; if (i < sp.x) { v = data[i]; } tmp[l.x] = v; workgroupBarrier();
  for (var off = 1u; off < 256u; off = off * 2u) { var t = 0u; if (l.x >= off) { t = tmp[l.x - off]; } workgroupBarrier(); tmp[l.x] = tmp[l.x] + t; workgroupBarrier(); }
  if (i < sp.x) { data[i] = tmp[l.x] - v; }
  if (l.x == 255u) { sums[wg.x] = tmp[255]; }
}
@compute @workgroup_size(256) fn addOff(@builtin(global_invocation_id) g_raw: vec3<u32>, @builtin(workgroup_id) wg_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let wg = vec3<u32>(wg_raw.x + wg_raw.y * 65535u, 0u, 0u); if (g.x < sp.x) { data[g.x] = data[g.x] + sums[wg.x]; } }`

export const CHECK_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> cp: vec4<u32>;   // n, cap
@group(0) @binding(1) var<storage, read> starts: array<u32>;
@group(0) @binding(2) var<storage, read_write> bad: array<atomic<u32>>;
@compute @workgroup_size(256) fn check(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let i = g.x; if (i >= cp.x) { return; }
  let lo = starts[i]; let hi = starts[i + 1u]; if (hi < lo || hi - lo > cp.y) { atomicAdd(&bad[0], 1u); } }`

export const GLUE_SHADER = PRELUDE + /* wgsl */`
struct GP { n: u32, polys: u32, fill: u32, mode: u32 }
@group(0) @binding(4) var<uniform> gp: GP;
@group(0) @binding(5) var<storage, read> evStart: array<u32>;
@group(0) @binding(6) var<storage, read> events: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read> polyInfo: array<vec4<u32>>;      // first, count, layer segStart, layer segEnd
@group(0) @binding(8) var<storage, read_write> work: array<u32>;
@group(0) @binding(9) var<storage, read_write> polyW: array<i32>;
fn leQ(v: u32, a0: u32, ay: i32, dA: vec2<i32>) -> bool {
  if (v == a0) { var s = sign(dA.y); if (s == 0) { s = sign(dA.x); } return s >= 0; }
  let d = vtx(v).y - ay; if (d != 0) { return d < 0; } return v < a0; }
@compute @workgroup_size(256) fn rays(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u);
  let p = g.x; if (p >= gp.polys) { return; }
  let pi = polyInfo[p]; let a0 = pi.x; let a1 = segInfo[a0].z; let A0 = vtx(a0); let dA = vtx(a1) - A0;
  var wn = 0;
  for (var c = pi.z; c < pi.w; c++) { let c1 = segInfo[c].z;
    if (leQ(c, a0, A0.y, dA) == leQ(c1, a0, A0.y, dA)) { continue; }
    var side = 1;
    if (c != a0) {
      if (c1 == a0) { side = orientSoS(c, c1, a1); if (side == 0) { let dc = vtx(c1) - vtx(c); side = sign(dc.x * dA.x + dc.y * dA.y); } }
      else { side = orientSoS(c, c1, a0); } }
    let C0 = vtx(c); let C1 = vtx(c1);
    if (C1.y > C0.y || (C1.y == C0.y && c1 > c)) { if (side > 0) { wn = wn + 1; } } else { if (side < 0) { wn = wn - 1; } } }
  polyW[p] = wn;
}
@compute @workgroup_size(256) fn deltaSums(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u);
  let a = g.x; if (a > gp.n) { return; } if (a == gp.n) { work[a] = 0u; return; }
  if (badRange(evStart[a], evStart[a + 1u])) { return; }
  var s = 0; for (var r = evStart[a]; r < evStart[a + 1u]; r++) { s = s + bitcast<i32>(events[r * 2u + 1u].x); } work[a] = bitcast<u32>(s);
}`

export const PIECES_SHADER = PRELUDE + /* wgsl */`
struct GP { n: u32, polys: u32, fill: u32, mode: u32 }
@group(0) @binding(4) var<uniform> gp: GP;
@group(0) @binding(5) var<storage, read> evStart: array<u32>;
@group(0) @binding(6) var<storage, read> events: array<vec4<u32>>;
@group(0) @binding(7) var<storage, read> leftW: array<vec2<u32>>;       // per segment: (scanned delta sum, polygon index)
@group(0) @binding(8) var<storage, read> polyInfoW: array<vec4<i32>>;   // first, count, start winding, 0
@group(0) @binding(9) var<storage, read_write> pieceCount: array<u32>;
@group(0) @binding(10) var<storage, read_write> pv: array<vec4<u32>>;   // start vid, end vid, layer
@group(0) @binding(11) var<storage, read_write> pcd: array<vec4<i32>>;   // two entries per piece: coordinates, parent direction
fn insideOf(w: i32) -> bool { if (gp.fill == 3u) { return (w & 1) != 0; } if (gp.fill == 2u) { return w < 0; } if (gp.fill == 1u) { return w > 0; } return w != 0; }
@compute @workgroup_size(256) fn pieces(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u);
  let a = g.x; if (a >= gp.n) { return; }
  let lw = leftW[a]; let pw = polyInfoW[lw.y]; let firstScan = leftW[u32(pw.x)].x;
  var wl = pw.z + bitcast<i32>(lw.x - firstScan);
  let S = segs[a]; var x = S.x; var y = S.y; var vid = a; let nxt = segInfo[a].z; let dir = vec2<i32>(S.z - S.x, S.w - S.y); let layer = segInfo[a].x;
  var k = 0u; let base = pieceCount[a]; let r0 = evStart[a]; let r1 = evStart[a + 1u]; if (badRange(r0, r1)) { return; }
  for (var r = r0; r <= r1; r++) {
    var nx = S.z; var ny = S.w; var nv = nxt; var d = 0;
    if (r < r1) { let e = events[r * 2u + 1u]; d = bitcast<i32>(e.x); nx = bitcast<i32>(e.y); ny = bitcast<i32>(e.z); nv = e.w; }
    let il = insideOf(wl); let ir = insideOf(wl - 1);
    if (il != ir) {
      if (gp.mode == 1u) { let o = base + k;
        if (il) { pv[o] = vec4<u32>(vid, nv, layer, 0u); pcd[o * 2u] = vec4<i32>(x, y, nx, ny); pcd[o * 2u + 1u] = vec4<i32>(0, 0, dir.x, dir.y); }
        else { pv[o] = vec4<u32>(nv, vid, layer, 0u); pcd[o * 2u] = vec4<i32>(nx, ny, x, y); pcd[o * 2u + 1u] = vec4<i32>(0, 0, -dir.x, -dir.y); } }
      k = k + 1u; }
    x = nx; y = ny; vid = nv; wl = wl + d; }
  if (gp.mode == 0u) { pieceCount[a] = k; }
}`

export const TIES_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> tp: vec4<u32>;
@group(0) @binding(1) var<storage, read> evStart: array<u32>;
@group(0) @binding(2) var<storage, read> events: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> tieList: array<atomic<u32>>;
fn mulu(a: u32, b: u32) -> vec2<u32> { let al = a & 0xffffu; let ah = a >> 16u; let bl = b & 0xffffu; let bh = b >> 16u; let ll = al * bl; let lh = al * bh; let hl = ah * bl; let hh = ah * bh;
  var lo = ll; var hi = hh + (lh >> 16u) + (hl >> 16u); let t1 = lh << 16u; lo = lo + t1; if (lo < t1) { hi = hi + 1u; } let t2 = hl << 16u; lo = lo + t2; if (lo < t2) { hi = hi + 1u; } return vec2<u32>(lo, hi); }
fn add128(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> { var r: vec4<u32>; r.x = a.x + b.x; var c = select(0u, 1u, r.x < a.x);
  let y = a.y + b.y; var c1 = select(0u, 1u, y < a.y); r.y = y + c; if (r.y < y) { c1 = 1u; } c = c1;
  let z = a.z + b.z; var c2 = select(0u, 1u, z < a.z); r.z = z + c; if (r.z < z) { c2 = 1u; } c = c2; r.w = a.w + b.w + c; return r; }
fn mul128(a: vec2<u32>, b: vec2<u32>) -> vec4<u32> { let p00 = mulu(a.x, b.x); let p01 = mulu(a.x, b.y); let p10 = mulu(a.y, b.x); let p11 = mulu(a.y, b.y);
  var r = vec4<u32>(p00.x, p00.y, p11.x, p11.y); r = add128(r, vec4<u32>(0u, p01.x, p01.y, 0u)); r = add128(r, vec4<u32>(0u, p10.x, p10.y, 0u)); return r; }
@compute @workgroup_size(256) fn ties(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u);
  let a = g.x; if (a >= tp.x) { return; } if (evStart[a + 1u] < evStart[a] || evStart[a + 1u] - evStart[a] > 4096u) { return; }   // RANGE_CAP (this shader has no prelude)
  for (var r = evStart[a] + 1u; r < evStart[a + 1u]; r++) { let p = events[(r - 1u) * 2u]; let q = events[r * 2u];
    if (all(mul128(p.xy, q.zw) == mul128(q.xy, p.zw))) { let k = atomicAdd(&tieList[0], 1u); atomicStore(&tieList[1u + k], a); return; } }
}`

export const ZIP_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> zp: vec4<u32>;
@group(0) @binding(1) var<storage, read> a: array<u32>;
@group(0) @binding(2) var<storage, read> b: array<u32>;
@group(0) @binding(3) var<storage, read_write> o: array<vec2<u32>>;
@compute @workgroup_size(256) fn zip(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); if (g.x < zp.x) { o[g.x] = vec2<u32>(a[g.x], b[g.x]); } }`

export const DIRECTIONS_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> dp: vec4<u32>;
@group(0) @binding(1) var<storage, read> pcd: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read_write> dirOut: array<vec4<i32>>;
@compute @workgroup_size(256) fn dirs(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); if (g.x < dp.x) { dirOut[g.x] = pcd[g.x * 2u + 1u]; } }`

export const EXPAND_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> ep: vec4<u32>;   // segments, polygons
@group(0) @binding(1) var<storage, read> pts: array<vec2<i32>>;
@group(0) @binding(2) var<storage, read> polyIn: array<vec4<u32>>;   // first, count, layer start, layer end
@group(0) @binding(3) var<storage, read> polyLayerIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> segOut: array<vec4<i32>>;
@group(0) @binding(5) var<storage, read_write> infoOut: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read_write> segPolyOut: array<u32>;
@compute @workgroup_size(256) fn expand(@builtin(global_invocation_id) g_raw: vec3<u32>) { let i = g_raw.x + g_raw.y * 16776960u; if (i >= ep.x || ep.y == 0u) { return; }
  var lo = 0u; var hi = ep.y;
  for (var step = 0u; step < 32u; step++) { if (hi - lo <= 1u) { break; } let mid = (lo + hi) / 2u; if (polyIn[mid].x <= i) { lo = mid; } else { hi = mid; } }
  let first = polyIn[lo].x; let count = polyIn[lo].y; let next = first + (i - first + 1u) % count; let prev = first + (i - first + count - 1u) % count;
  let a = pts[i]; let b = pts[next];
  segOut[i] = vec4<i32>(a.x, a.y, b.x, b.y);
  var flag = 0u; if (i == first) { flag = 1u; }
  infoOut[i] = vec4<u32>(polyLayerIn[lo], prev, next, flag);
  segPolyOut[i] = lo; }`

export const COMPACT_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> dp: vec4<u32>;
@group(0) @binding(1) var<storage, read> pcd: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> succIn: array<u32>;
@group(0) @binding(3) var<storage, read> pvIn: array<vec4<u32>>;
@group(0) @binding(4) var<storage, read_write> compactOut: array<vec4<i32>>;
@compute @workgroup_size(256) fn compact(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = g_raw.x + g_raw.y * 16776960u; if (g < dp.x) { let c = pcd[g * 2u]; compactOut[g] = vec4<i32>(c.x, c.y, bitcast<i32>(succIn[g]), bitcast<i32>(pvIn[g].z)); } }`

export const GATE_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> gu: vec4<u32>;   // x: index into src, y: use src (1) or the constant z
@group(0) @binding(1) var<storage, read> bad: array<u32>;
@group(0) @binding(2) var<storage, read> src: array<u32>;
@group(0) @binding(3) var<storage, read_write> dst: array<u32>;
// a count for a later kernel's uniform, zero once any range check has failed: every later loop is bounded by that count
@compute @workgroup_size(1) fn gate() { var v = gu.z; if (gu.y == 1u) { v = src[gu.x]; } if (bad[0] != 0u) { v = 0u; } dst[0] = v; }`

export const ARGS_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> au: vec4<u32>;   // x: workgroup size
@group(0) @binding(1) var<storage, read> cnt: array<u32>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
@compute @workgroup_size(1) fn argsK() { let groups = max(1u, (cnt[0] + au.x - 1u) / au.x); args[0] = min(groups, 65535u); args[1] = (groups + 65534u) / 65535u; args[2] = 1u; }`

export const POLYGON_WINDING_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> pu: vec4<u32>;
@group(0) @binding(1) var<storage, read> polyInfo: array<vec4<u32>>;
@group(0) @binding(2) var<storage, read> polyW: array<i32>;
@group(0) @binding(3) var<storage, read_write> polyInfoW: array<vec4<i32>>;
@compute @workgroup_size(256) fn polyWK(@builtin(global_invocation_id) g_raw: vec3<u32>) { let g = vec3<u32>(g_raw.x + g_raw.y * 16776960u, 0u, 0u); let p = g.x; if (p >= pu.x) { return; } let q = polyInfo[p]; polyInfoW[p] = vec4<i32>(i32(q.x), i32(q.y), polyW[p], 0); }`
