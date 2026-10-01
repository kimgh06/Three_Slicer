// WGSL of the GPU front of PASS1 (contour_front_gpu.js): tri_plane -> chain_polys -> cancel_coincident ->
//  build_gpu_input, every layer at once. Ported from the measured experiment (.omc/plans/gpu-work/fullport/gpu_slice.mjs,
//  design report gpu-full-port-trial-2026-10-01.md section 3); edited only with a measurement beside it, as
//  contour_gpu_shaders.js.
//
// Invocation index: dispatches put at most 65535 workgroups of 256 on x and the rest on y (contour_gpu.js), so an
//  invocation's index is g.x + g.y * 16776960.

export const NONE = 0xffffffff
export const LIST_LIMIT = 16   // segment ends meeting at one chain key that the matcher sorts; more is reported

const TID = /* wgsl */`fn tid(g: vec3<u32>) -> u32 { return g.x + g.y * 16776960u; }`

// The kernel interpolates in double and rounds to 1e-6 mm; plain f32 gives another integer in 885k of 1M random
//  cases, double-float (two f32) in none. Metal compiles with fast math, which folds two_sum's error term away (measured:
//  errors of thousands of units), so every intermediate the error terms depend on goes through opaque(): an XOR with a
//  uniform zero the compiler cannot see through. The shader declares that uniform as `dfZero`.
const DOUBLE_FLOAT = /* wgsl */`
fn opaque(a: f32) -> f32 { return bitcast<f32>(bitcast<u32>(a) ^ dfZero); }
fn two_sum(a: f32, b: f32) -> vec2<f32> { let s = opaque(a + b); let bb = opaque(s - a); return vec2<f32>(s, opaque(a - opaque(s - bb)) + opaque(b - bb)); }
fn quick_two_sum(a: f32, b: f32) -> vec2<f32> { let s = opaque(a + b); return vec2<f32>(s, b - opaque(s - a)); }
fn df_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var s = two_sum(a.x, b.x); let t = two_sum(a.y, b.y);
  s.y = s.y + t.x; s = quick_two_sum(s.x, s.y); s.y = s.y + t.y; return quick_two_sum(s.x, s.y); }
fn df_neg(a: vec2<f32>) -> vec2<f32> { return vec2<f32>(-a.x, -a.y); }
fn df_sub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return df_add(a, df_neg(b)); }
fn two_prod(a: f32, b: f32) -> vec2<f32> { let p = opaque(a * b); return vec2<f32>(p, fma(a, b, -p)); }
fn df_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { var p = two_prod(a.x, b.x); p.y = p.y + (a.x * b.y + a.y * b.x); return quick_two_sum(p.x, p.y); }
fn df_div(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let q1 = opaque(a.x / b.x); var r = df_sub(a, df_mul(b, vec2<f32>(q1, 0.0)));
  let q2 = opaque(r.x / b.x); r = df_sub(r, df_mul(b, vec2<f32>(q2, 0.0)));
  let q3 = opaque(r.x / b.x); return df_add(quick_two_sum(q1, q2), vec2<f32>(q3, 0.0)); }
// nearest integer of a df value below 2^31 in magnitude, ties away from zero (llround)
fn df_round_i32(a: vec2<f32>) -> i32 {
  let hiInt = round(a.x);
  let rest = two_sum(opaque(a.x - hiInt), a.y);
  let r = rest.x + rest.y;
  var fl = floor(r); let fr = opaque(r - fl);
  if (fr > 0.5 || (fr == 0.5 && r > 0.0)) { fl = fl + 1.0; }
  return i32(hiInt) + i32(fl);
}`

// ---- triangle -> segments (count mode writes the per-triangle count, emit mode the segments)
export const CUT_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;                  // triangles, layers, emit
@group(0) @binding(1) var<storage, read> tris: array<f32>;
@group(0) @binding(2) var<storage, read> zs: array<vec2<f32>>;     // each layer's z as hi + lo
@group(0) @binding(3) var<storage, read_write> counts: array<u32>; // count mode: per triangle; emit mode: its first segment
@group(0) @binding(4) var<storage, read_write> segPoints: array<vec4<i32>>;   // x0 y0 x1 y1 (1e-6 mm)
@group(0) @binding(5) var<storage, read_write> segKeys: array<vec4<i32>>;     // the chain keys of both ends (1e-3 mm)
@group(0) @binding(6) var<storage, read_write> segLayer: array<u32>;
@group(0) @binding(7) var<uniform> dfZero: u32;
${DOUBLE_FLOAT}
${TID}
fn vBelow(v: f32, L: u32) -> bool { let z = zs[L]; return v < z.x || (v == z.x && z.y > 0.0); }   // v < z exactly
fn zBelow(L: u32, v: f32) -> bool { let z = zs[L]; return z.x < v || (z.x == v && z.y < 0.0); }   // z < v exactly
fn vtx(t: u32, k: u32) -> vec3<f32> { let b = t * 9u + k * 3u; return vec3<f32>(tris[b], tris[b + 1u], tris[b + 2u]); }
fn df(v: f32) -> vec2<f32> { return vec2<f32>(v, 0.0); }
fn dfSign(a: vec2<f32>) -> f32 { if (a.x != 0.0) { return a.x; } return a.y; }
struct Cut { ok: bool, x0: vec2<f32>, y0: vec2<f32>, x1: vec2<f32>, y1: vec2<f32> }
fn cut(t: u32, L: u32) -> Cut {
  var r: Cut; r.ok = false;
  var cx: array<vec2<f32>, 2>; var cy: array<vec2<f32>, 2>; var n = 0u;
  let z = zs[L];
  for (var e = 0u; e < 3u; e = e + 1u) {
    let s = vtx(t, e); let en = vtx(t, (e + 1u) % 3u);
    let crosses = (vBelow(s.z, L) && !vBelow(en.z, L)) || (vBelow(en.z, L) && !vBelow(s.z, L));
    if (crosses) {
      if (n < 2u) {
        let f = df_div(df_sub(z, df(s.z)), df_sub(df(en.z), df(s.z)));
        cx[n] = df_add(df(s.x), df_mul(f, df_sub(df(en.x), df(s.x))));
        cy[n] = df_add(df(s.y), df_mul(f, df_sub(df(en.y), df(s.y))));
      }
      n = n + 1u;
    }
  }
  if (n != 2u) { return r; }
  let a = vtx(t, 0u); let b = vtx(t, 1u); let c = vtx(t, 2u);
  let e1x = df_sub(df(b.x), df(a.x)); let e1y = df_sub(df(b.y), df(a.y)); let e1z = df_sub(df(b.z), df(a.z));
  let e2x = df_sub(df(c.x), df(a.x)); let e2y = df_sub(df(c.y), df(a.y)); let e2z = df_sub(df(c.z), df(a.z));
  let nx = df_sub(df_mul(e1y, e2z), df_mul(e1z, e2y));
  let ny = df_sub(df_mul(e1z, e2x), df_mul(e1x, e2z));
  let dx = df_sub(cx[1], cx[0]); let dy = df_sub(cy[1], cy[0]);
  let along = df_sub(df_mul(dy, nx), df_mul(dx, ny));
  r.ok = true;
  if (dfSign(along) < 0.0) { r.x0 = cx[1]; r.y0 = cy[1]; r.x1 = cx[0]; r.y1 = cy[0]; }
  else { r.x0 = cx[0]; r.y0 = cy[0]; r.x1 = cx[1]; r.y1 = cy[1]; }
  return r;
}
fn firstLayer(zmin: f32) -> u32 {   // lower_bound: the first layer whose z is not below zmin
  var lo = 0u; var hi = P.y;
  while (lo < hi) { let mid = (lo + hi) / 2u; if (zBelow(mid, zmin)) { lo = mid + 1u; } else { hi = mid; } }
  return lo;
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = tid(g); if (t >= P.x) { return; }
  let a = vtx(t, 0u); let b = vtx(t, 1u); let c = vtx(t, 2u);
  let zmin = min(a.z, min(b.z, c.z)); let zmax = max(a.z, max(b.z, c.z));
  var L = firstLayer(zmin); var k = 0u;
  var out = 0u; if (P.z == 1u) { out = counts[t]; }
  loop {
    if (L >= P.y || !zBelow(L, zmax)) { break; }
    let r = cut(t, L);
    if (r.ok) {
      if (P.z == 1u) {
        let s = out + k;
        let m = df(1000000.0); let q = df(1000.0);
        segPoints[s] = vec4<i32>(df_round_i32(df_mul(r.x0, m)), df_round_i32(df_mul(r.y0, m)), df_round_i32(df_mul(r.x1, m)), df_round_i32(df_mul(r.y1, m)));
        segKeys[s] = vec4<i32>(df_round_i32(df_mul(r.x0, q)), df_round_i32(df_mul(r.y0, q)), df_round_i32(df_mul(r.x1, q)), df_round_i32(df_mul(r.y1, q)));
        segLayer[s] = L;
      }
      k = k + 1u;
    }
    L = L + 1u;
  }
  if (P.z == 0u) { counts[t] = k; }
}`

export const HASH_SHADER = /* wgsl */`
fn mix(h0: u32, v: u32) -> u32 { var h = h0 ^ (v * 0x9E3779B1u); h = (h ^ (h >> 16u)) * 0x85EBCA6Bu; h = (h ^ (h >> 13u)) * 0xC2B2AE35u; return h ^ (h >> 16u); }`

// ---- cancel_coincident: segments that coincide exactly in opposite directions are removed in pairs
export const CANCEL_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments, table mask
@group(0) @binding(1) var<storage, read> segPoints: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> segLayer: array<u32>;
@group(0) @binding(3) var<storage, read_write> owner: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> headForward: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> headBackward: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> next: array<u32>;
@group(0) @binding(7) var<storage, read_write> dead: array<u32>;
${HASH_SHADER}
${TID}
fn startIsLow(p: vec4<i32>) -> bool { return p.x < p.z || (p.x == p.z && p.y < p.w); }
fn place(s: u32) -> vec4<i32> { let p = segPoints[s]; if (startIsLow(p)) { return p; } return vec4<i32>(p.z, p.w, p.x, p.y); }
fn samePlace(a: u32, b: u32) -> bool { return segLayer[a] == segLayer[b] && all(place(a) == place(b)); }
fn zeroLength(s: u32) -> bool { let p = segPoints[s]; return p.x == p.z && p.y == p.w; }
@compute @workgroup_size(256) fn insert(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x || zeroLength(s)) { return; }
  let pl = place(s);
  var slot = mix(mix(mix(mix(mix(0u, segLayer[s]), bitcast<u32>(pl.x)), bitcast<u32>(pl.y)), bitcast<u32>(pl.z)), bitcast<u32>(pl.w)) & P.y;
  loop {
    let o = atomicLoad(&owner[slot]);
    if (o == 0u) { let r = atomicCompareExchangeWeak(&owner[slot], 0u, s + 1u); if (r.exchanged) { break; } continue; }
    if (samePlace(o - 1u, s)) { break; }
    slot = (slot + 1u) & P.y;
  }
  if (startIsLow(segPoints[s])) { next[s] = atomicExchange(&headForward[slot], s + 1u); }
  else { next[s] = atomicExchange(&headBackward[slot], s + 1u); }
}
// the first min(forward, backward) of each direction by segment order die (exact duplicates: which ones is immaterial)
fn sortedList(head: u32, out: ptr<function, array<u32, ${LIST_LIMIT}>>) -> u32 {
  var n = 0u; var cur = head;
  while (cur != 0u && n < ${LIST_LIMIT}u) { (*out)[n] = cur - 1u; n = n + 1u; cur = next[cur - 1u]; }
  for (var i = 1u; i < n; i = i + 1u) { let v = (*out)[i]; var j = i; while (j > 0u && (*out)[j - 1u] > v) { (*out)[j] = (*out)[j - 1u]; j = j - 1u; } (*out)[j] = v; }
  return n;
}
@compute @workgroup_size(256) fn pair(@builtin(global_invocation_id) g: vec3<u32>) {
  let slot = tid(g); if (slot > P.y) { return; }
  if (atomicLoad(&owner[slot]) == 0u) { return; }
  var f: array<u32, ${LIST_LIMIT}>; var b: array<u32, ${LIST_LIMIT}>;
  let nf = sortedList(atomicLoad(&headForward[slot]), &f); let nb = sortedList(atomicLoad(&headBackward[slot]), &b);
  let pairs = min(nf, nb);
  for (var k = 0u; k < pairs; k = k + 1u) { dead[f[k]] = 1u; dead[b[k]] = 1u; }
}`

// ---- chain: each live segment's successor is a live segment starting at its end key
export const CHAIN_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments, table mask
@group(0) @binding(1) var<storage, read> segKeys: array<vec4<i32>>;
@group(0) @binding(2) var<storage, read> segLayer: array<u32>;
@group(0) @binding(3) var<storage, read> dead: array<u32>;
@group(0) @binding(4) var<storage, read_write> owner: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> startHead: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> endHead: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> startNext: array<u32>;
@group(0) @binding(8) var<storage, read_write> endNext: array<u32>;
@group(0) @binding(9) var<storage, read_write> successor: array<u32>;   // also [P.x]: matcher overflow count, [P.x+1]: open ends
${HASH_SHADER}
${TID}
fn slotOf(L: u32, x: i32, y: i32) -> u32 { return mix(mix(mix(0u, L), bitcast<u32>(x)), bitcast<u32>(y)) & P.y; }
@compute @workgroup_size(256) fn insertStarts(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  successor[s] = ${NONE}u;
  if (dead[s] != 0u) { return; }
  let k = segKeys[s]; let L = segLayer[s];
  var slot = slotOf(L, k.x, k.y);
  loop {
    let o = atomicLoad(&owner[slot]);
    if (o == 0u) { let r = atomicCompareExchangeWeak(&owner[slot], 0u, s + 1u); if (r.exchanged) { break; } continue; }
    let other = o - 1u; let ok = segKeys[other];
    if (segLayer[other] == L && ok.x == k.x && ok.y == k.y) { break; }
    slot = (slot + 1u) & P.y;
  }
  startNext[s] = atomicExchange(&startHead[slot], s + 1u);
}
@compute @workgroup_size(256) fn insertEnds(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x || dead[s] != 0u) { return; }
  let k = segKeys[s]; let L = segLayer[s];
  var slot = slotOf(L, k.z, k.w);
  loop {
    let o = atomicLoad(&owner[slot]);
    if (o == 0u) { return; }   // no segment starts here: an open end (counted by the matcher's absence)
    let other = o - 1u; let ok = segKeys[other];
    if (segLayer[other] == L && ok.x == k.z && ok.y == k.w) { break; }
    slot = (slot + 1u) & P.y;
  }
  endNext[s] = atomicExchange(&endHead[slot], s + 1u);
}
fn sortedStarts(head: u32, out: ptr<function, array<u32, ${LIST_LIMIT}>>) -> u32 {
  var n = 0u; var cur = head;
  while (cur != 0u && n < ${LIST_LIMIT}u) { (*out)[n] = cur - 1u; n = n + 1u; cur = startNext[cur - 1u]; }
  if (cur != 0u) { return ${LIST_LIMIT + 1}u; }
  for (var i = 1u; i < n; i = i + 1u) { let v = (*out)[i]; var j = i; while (j > 0u && (*out)[j - 1u] > v) { (*out)[j] = (*out)[j - 1u]; j = j - 1u; } (*out)[j] = v; }
  return n;
}
fn sortedEnds(head: u32, out: ptr<function, array<u32, ${LIST_LIMIT}>>) -> u32 {
  var n = 0u; var cur = head;
  while (cur != 0u && n < ${LIST_LIMIT}u) { (*out)[n] = cur - 1u; n = n + 1u; cur = endNext[cur - 1u]; }
  if (cur != 0u) { return ${LIST_LIMIT + 1}u; }
  for (var i = 1u; i < n; i = i + 1u) { let v = (*out)[i]; var j = i; while (j > 0u && (*out)[j - 1u] > v) { (*out)[j] = (*out)[j - 1u]; j = j - 1u; } (*out)[j] = v; }
  return n;
}
// chain_polys' greedy walk at one key: an arriving end takes the smallest unused segment starting there. A segment whose
//  two ends share the key (a sub-micron sliver) is taken only when it comes first, and then its own end takes the next
//  start; one left over closes on itself (a 1-segment loop, which chain_polys drops). Arriving ends are served in
//  segment order — the kernel's order whenever one end arrives at a key, which is the manifold case.
@compute @workgroup_size(256) fn pairEnds(@builtin(global_invocation_id) g: vec3<u32>) {
  let slot = tid(g); if (slot > P.y) { return; }
  if (atomicLoad(&owner[slot]) == 0u) { return; }
  var st: array<u32, ${LIST_LIMIT}>; var en: array<u32, ${LIST_LIMIT}>;
  let ns = sortedStarts(atomicLoad(&startHead[slot]), &st); let ne = sortedEnds(atomicLoad(&endHead[slot]), &en);
  if (ns > ${LIST_LIMIT}u || ne > ${LIST_LIMIT}u) { successor[P.x] = 1u; return; }
  var used = 0u; var selfKey = 0u;   // bit masks over st
  for (var i = 0u; i < ns; i = i + 1u) { for (var j = 0u; j < ne; j = j + 1u) { if (en[j] == st[i]) { selfKey = selfKey | (1u << i); } } }
  for (var j = 0u; j < ne; j = j + 1u) {
    var arriving = en[j]; var isSelf = false;
    for (var i = 0u; i < ns; i = i + 1u) { if (st[i] == arriving) { isSelf = true; } }
    if (isSelf) { continue; }
    loop {
      var pick = ${LIST_LIMIT}u;
      for (var i = 0u; i < ns; i = i + 1u) { if ((used & (1u << i)) == 0u) { pick = i; break; } }
      if (pick == ${LIST_LIMIT}u) { break; }
      used = used | (1u << pick); successor[arriving] = st[pick];
      if ((selfKey & (1u << pick)) == 0u) { break; }
      arriving = st[pick];
    }
  }
  for (var i = 0u; i < ns; i = i + 1u) { if ((selfKey & (1u << i)) != 0u && (used & (1u << i)) == 0u) { successor[st[i]] = st[i]; } }
}`

// ---- pointer jumping: every segment's loop head (the smallest id on its cycle), then its distance to the loop's last
export const JUMP_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments, mode (0 init labels, 1 label round, 2 init ranks, 3 rank round)
@group(0) @binding(1) var<storage, read> successor: array<u32>;
@group(0) @binding(2) var<storage, read> dead: array<u32>;
@group(0) @binding(3) var<storage, read_write> valueIn: array<u32>;
@group(0) @binding(4) var<storage, read_write> nextIn: array<u32>;
@group(0) @binding(5) var<storage, read_write> valueOut: array<u32>;
@group(0) @binding(6) var<storage, read_write> nextOut: array<u32>;
@group(0) @binding(7) var<storage, read> label: array<u32>;
@group(0) @binding(8) var<storage, read> reach: array<u32>;   // NONE: not on a cycle
${TID}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  if (P.y == 0u) { if (dead[s] != 0u) { valueOut[s] = ${NONE}u; nextOut[s] = ${NONE}u; return; } valueOut[s] = s; nextOut[s] = successor[s]; return; }
  if (P.y == 2u) {
    let nx = successor[s];
    if (dead[s] != 0u || nx == ${NONE}u || reach[s] == ${NONE}u) { valueOut[s] = 0u; nextOut[s] = ${NONE}u; return; }
    if (nx == label[s]) { valueOut[s] = 0u; nextOut[s] = s; return; }   // the last segment before the head
    valueOut[s] = 1u; nextOut[s] = nx; return;
  }
  let nx = nextIn[s];
  if (nx == ${NONE}u) { valueOut[s] = valueIn[s]; nextOut[s] = nx; return; }
  if (P.y == 1u) { valueOut[s] = min(valueIn[s], valueIn[nx]); }
  else { if (nx == s) { valueOut[s] = valueIn[s]; } else { valueOut[s] = valueIn[s] + valueIn[nx]; } }
  nextOut[s] = nextIn[nx];
}`

// ---- cycle members: succ^(2^R) of anything lands on a cycle, and every cycle element is hit, so the hit set is exactly
//  the cycle elements. A tail leading into a cycle (a successor that two segments share) is left out as open; without
//  this, a tail's head took a rank that never stops growing and every slot after it was misplaced (measured on offset
//  pieces: 3,923 merges in 2.84M pieces left 6 % of the area).
export const CYCLES_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments, mode (0 mark, 1 flag)
@group(0) @binding(1) var<storage, read_write> reach: array<u32>;   // in: succ^(2^R), out: 0 on a cycle, NONE otherwise
@group(0) @binding(2) var<storage, read_write> hit: array<u32>;
${TID}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  if (P.y == 0u) { let r = reach[s]; if (r != ${NONE}u) { hit[r] = 1u; } return; }
  reach[s] = select(${NONE}u, 0u, hit[s] == 1u); }`

// ---- loops: heads, sort by (layer, head), lay every segment out in loop order, drop what the kernel drops
export const LOOPS_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments, heads (padded), layers, stage parameter
@group(0) @binding(1) var<storage, read> successor: array<u32>;
@group(0) @binding(2) var<storage, read> label: array<u32>;
@group(0) @binding(3) var<storage, read> rank: array<u32>;          // distance to the loop's last segment
@group(0) @binding(4) var<storage, read> segLayer: array<u32>;
@group(0) @binding(5) var<storage, read_write> headFlag: array<u32>; // flag, then (after the scan) the head's index
@group(0) @binding(6) var<storage, read_write> heads: array<vec2<u32>>; // (layer, head) sorted
@group(0) @binding(7) var<storage, read_write> polyOf: array<u32>;   // head segment -> sorted polygon index
@group(0) @binding(8) var<storage, read_write> loopStart: array<u32>;// per sorted polygon: its length, then (scan) its first slot
@group(0) @binding(9) var<storage, read_write> order: array<u32>;    // slot -> segment
@group(0) @binding(10) var<storage, read> reach: array<u32>;
${TID}
fn closed(s: u32) -> bool { return successor[s] != ${NONE}u && reach[s] != ${NONE}u; }
fn isHead(s: u32) -> bool { return closed(s) && label[s] == s; }
@compute @workgroup_size(256) fn flagHeads(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; } headFlag[s] = select(0u, 1u, isHead(s)); }
@compute @workgroup_size(256) fn gatherHeads(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  if (isHead(s)) { heads[headFlag[s]] = vec2<u32>(segLayer[s], s); } }
@compute @workgroup_size(256) fn padHeads(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = tid(g) + P.w; if (i >= P.y) { return; } heads[i] = vec2<u32>(${NONE}u, ${NONE}u); }
fn less(a: vec2<u32>, b: vec2<u32>) -> bool { return a.x < b.x || (a.x == b.x && a.y < b.y); }
@compute @workgroup_size(256) fn bitonic(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = tid(g); if (i >= P.y) { return; }
  let j = P.z; let k = P.w; let partner = i ^ j;
  if (partner <= i) { return; }
  let a = heads[i]; let b = heads[partner];
  let ascending = (i & k) == 0u;
  if (less(b, a) == ascending) { heads[i] = b; heads[partner] = a; }
}
@compute @workgroup_size(256) fn lengths(@builtin(global_invocation_id) g: vec3<u32>) {
  let p = tid(g); if (p >= P.w) { return; }
  let h = heads[p].y; polyOf[h] = p; loopStart[p] = rank[h] + 2u; }   // the kernel's n + 1 points: start(s0), end(s0..s(n-1))
@compute @workgroup_size(256) fn place(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  if (!closed(s)) { return; }
  let p = polyOf[label[s]];
  let length = loopStart[p + 1u] - loopStart[p];
  order[loopStart[p] + 1u + (length - 2u - rank[s])] = s;
  if (label[s] == s) { order[loopStart[p]] = s | 0x80000000u; } }`

// ---- the union's input: a point per kept segment, layer-relative; per-layer and per-polygon tables
export const OUTPUT_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // slots, polygons, layers, stage
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> segPoints: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read> segLayer: array<u32>;
@group(0) @binding(4) var<storage, read> successor: array<u32>;
@group(0) @binding(5) var<storage, read> loopStart: array<u32>;      // per polygon: first slot (P.y + 1 entries)
@group(0) @binding(6) var<storage, read_write> kept: array<u32>;     // per slot, then scanned
@group(0) @binding(7) var<storage, read_write> polyKept: array<u32>; // per polygon: kept count, then valid flag, then scanned
@group(0) @binding(8) var<storage, read_write> layerAcc: array<atomic<i32>>;  // per layer: minx miny maxx maxy count, pad
@group(0) @binding(9) var<storage, read_write> slotPoly: array<u32>; // slot -> polygon
${TID}
fn pointOf(i: u32) -> vec2<i32> { let e = order[i]; let p = segPoints[e & 0x7fffffffu]; if ((e & 0x80000000u) != 0u) { return p.xy; } return p.zw; }
fn layerOf(i: u32) -> u32 { return segLayer[order[i] & 0x7fffffffu]; }
@compute @workgroup_size(256) fn slotPolygons(@builtin(global_invocation_id) g: vec3<u32>) {
  let p = tid(g); if (p >= P.y) { return; }
  for (var i = loopStart[p]; i < loopStart[p + 1u]; i = i + 1u) { slotPoly[i] = p; } }
// a point is kept unless it equals the next point of its loop (write_polygon), and the layer box takes every live end
@compute @workgroup_size(256) fn keep(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = tid(g); if (i >= P.x) { return; }
  let p = slotPoly[i]; var nx = i + 1u; if (nx == loopStart[p + 1u]) { nx = loopStart[p]; }
  let a = pointOf(i); let b = pointOf(nx);
  kept[i] = select(0u, 1u, any(a != b));
  if (loopStart[p + 1u] - loopStart[p] < 3u) { return; }   // chain_polys keeps a loop of 3 points or more
  let L = layerOf(i);
  atomicMin(&layerAcc[L * 8u], a.x); atomicMin(&layerAcc[L * 8u + 1u], a.y);
  atomicMax(&layerAcc[L * 8u + 2u], a.x); atomicMax(&layerAcc[L * 8u + 3u], a.y); }
@compute @workgroup_size(256) fn polygonCounts(@builtin(global_invocation_id) g: vec3<u32>) {
  let p = tid(g); if (p >= P.y) { return; }
  var n = 0u; for (var i = loopStart[p]; i < loopStart[p + 1u]; i = i + 1u) { n = n + kept[i]; }
  polyKept[p] = select(0u, 1u, n >= 2u && loopStart[p + 1u] - loopStart[p] >= 3u); }
@compute @workgroup_size(256) fn keepValid(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = tid(g); if (i >= P.x) { return; }
  let p = slotPoly[i];
  if (polyKept[p] == 0u) { kept[i] = 0u; } }`

export const WRITE_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // slots, polygons, layers
@group(0) @binding(1) var<storage, read> order: array<u32>;
@group(0) @binding(2) var<storage, read> segPoints: array<vec4<i32>>;
@group(0) @binding(3) var<storage, read> segLayer: array<u32>;
@group(0) @binding(4) var<storage, read> keptFlag: array<u32>;   // per slot: kept (0/1)
@group(0) @binding(5) var<storage, read> keptAt: array<u32>;     // per slot: exclusive scan of kept
@group(0) @binding(6) var<storage, read> layerBox: array<i32>;   // per layer: minx miny maxx maxy, 8 words
@group(0) @binding(7) var<storage, read_write> points: array<vec2<i32>>;
@group(0) @binding(8) var<storage, read_write> layerCount: array<atomic<u32>>;
${TID}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = tid(g); if (i >= P.x || keptFlag[i] == 0u) { return; }
  let e = order[i]; let s = e & 0x7fffffffu; let L = segLayer[s];
  var q = segPoints[s].zw; if ((e & 0x80000000u) != 0u) { q = segPoints[s].xy; }
  points[keptAt[i]] = q - vec2<i32>(layerBox[L * 8u], layerBox[L * 8u + 1u]);
  atomicAdd(&layerCount[L], 1u); }`

export const TABLES_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // slots, polygons, layers, cell size
@group(0) @binding(1) var<storage, read> layerBox: array<i32>;
@group(0) @binding(2) var<storage, read_write> layerStart: array<u32>;   // per layer count, scanned (L + 1)
@group(0) @binding(3) var<storage, read_write> layerInfo: array<u32>;    // gw gh cellOffset 0
@group(0) @binding(4) var<storage, read> polyValidAt: array<u32>;        // scanned valid flags (P.y + 1)
@group(0) @binding(5) var<storage, read> loopStart: array<u32>;
@group(0) @binding(6) var<storage, read> keptAt: array<u32>;
@group(0) @binding(7) var<storage, read> order: array<u32>;
@group(0) @binding(8) var<storage, read> segLayer: array<u32>;
@group(0) @binding(9) var<storage, read_write> polyInfo: array<u32>;     // start count layerStart layerEnd; polyLayer after
${TID}
@compute @workgroup_size(1) fn cells() {   // a serial pass over the layers (hundreds)
  var cells = 0u;
  for (var L = 0u; L < P.z; L = L + 1u) {
    var gw = 1u; var gh = 1u;
    if (layerBox[L * 8u + 2u] >= layerBox[L * 8u]) {
      gw = u32(layerBox[L * 8u + 2u] - layerBox[L * 8u]) / P.w + 1u; gh = u32(layerBox[L * 8u + 3u] - layerBox[L * 8u + 1u]) / P.w + 1u; }
    layerInfo[L * 4u] = gw; layerInfo[L * 4u + 1u] = gh; layerInfo[L * 4u + 2u] = cells; layerInfo[L * 4u + 3u] = 0u;
    cells = cells + gw * gh;
  }
  layerInfo[P.z * 4u] = cells; }
@compute @workgroup_size(256) fn polygons(@builtin(global_invocation_id) g: vec3<u32>) {
  let p = tid(g); if (p >= P.y) { return; }
  if (polyValidAt[p + 1u] == polyValidAt[p]) { return; }
  let q = polyValidAt[p];
  let first = keptAt[loopStart[p]]; let count = keptAt[loopStart[p + 1u]] - first;
  let L = segLayer[order[loopStart[p]] & 0x7fffffffu];
  polyInfo[q * 4u] = first; polyInfo[q * 4u + 1u] = count; polyInfo[q * 4u + 2u] = layerStart[L]; polyInfo[q * 4u + 3u] = layerStart[L + 1u];
  polyInfo[polyValidAt[P.y] * 4u + q] = L; }`

// per kept point, the grid cells of the segment ending at it (the union pipeline's cell list size)
export const ENTRIES_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // polygons, cell size
@group(0) @binding(1) var<storage, read> polyInfo: array<u32>;
@group(0) @binding(2) var<storage, read> points: array<vec2<i32>>;
@group(0) @binding(3) var<storage, read_write> total: array<atomic<u32>>;
${TID}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let p = tid(g); if (p >= P.x) { return; }
  let first = polyInfo[p * 4u]; let n = polyInfo[p * 4u + 1u]; let c = i32(P.y);
  var a = points[first + n - 1u]; var sum = 0u;
  for (var i = 0u; i < n; i = i + 1u) { let b = points[first + i];
    sum = sum + u32(max(a.x, b.x) / c - min(a.x, b.x) / c + 1) * u32(max(a.y, b.y) / c - min(a.y, b.y) / c + 1); a = b; }
  atomicAdd(&total[0], sum); }`


// ---- the layers whose chains did not close: a live segment off every cycle (contour_phase's open_layers)
export const OPEN_LAYERS_SHADER = /* wgsl */`
@group(0) @binding(0) var<uniform> P: vec4<u32>;   // segments
@group(0) @binding(1) var<storage, read> dead: array<u32>;
@group(0) @binding(2) var<storage, read> reach: array<u32>;          // CYCLES_SHADER's output: NONE off every cycle
@group(0) @binding(3) var<storage, read> segLayer: array<u32>;
@group(0) @binding(4) var<storage, read_write> openLayer: array<u32>;
${TID}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let s = tid(g); if (s >= P.x) { return; }
  if (dead[s] == 0u && reach[s] == ${NONE}u) { openLayer[segLayer[s]] = 1u; } }`
