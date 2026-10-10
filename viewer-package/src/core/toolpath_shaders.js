// The toolpath shader pair, GLSL ES 3.0.
//
// Written from viewer/TOOLPATH_SPEC.md §7. The attribute layout is this module's own contract with
// scene/toolpath_mesh.js and nothing else — no consumer outside the two sees it.
//
// One instance per extrusion segment. The template carries only WHICH corner of the bead a vertex is
// (`tpl` = [end, ring]); the segment's real endpoints, size, orientation and colour arrive as per-instance
// attributes, so a plate of millions of segments is one draw call and one small template buffer.
//
// The bead is a four-sided prism swept along the segment: two horizontal corners at +/- half the line width
// and two vertical ones at +/- half the layer height. That shape is what makes a wall read as a wall — a
// flat ribbon cannot show the layer stacking, and a full cylinder costs triangles nobody can see.
//
// Where a segment joins the next one (toolpath_segments.js linkJoins), its two side corners at that end sit on the
// bisector of the two headings, pushed out by 1/cos(half the turn), so both beads end on the same line and share
// the corner's normal: no wedge on the outside of a turn, no corner of a short segment sticking out, no change of
// shade from one segment to the next. A turn past MITER_MAX_TURN keeps the square end, because the miter's reach
// grows without bound towards a full reversal (zigzag infill). The shared normal is only used up to
// SMOOTH_MAX_TURN: the normal is interpolated over the whole segment, so a box corner's 45-degree normal shaded
// every wall of the cabin as a gradient. A sharper turn keeps the miter's position and its own side normal.

// The two joined headings ride in one float, JOIN_STEPS levels each (start * JOIN_STEPS + end), exact below 2^24.
//  A 2pi/4095 step moves a straight continuation's side corner by width * 4e-4 — far below a pixel.
export const JOIN_STEPS = 4096
const MITER_MAX_TURN = 140 * Math.PI / 180
const SMOOTH_MAX_TURN = 45 * Math.PI / 180

const quantizeHeading = (heading) => Math.round((heading + Math.PI) / (2 * Math.PI) * (JOIN_STEPS - 1))

/** The per-instance join attribute from the start and end endpoints' joined headings (radians). */
export function packJoin(startHeading, endHeading) {
  return quantizeHeading(startHeading) * JOIN_STEPS + quantizeHeading(endHeading)
}

export const SEG_VS = `
precision highp float;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float uLayerLo;
uniform float uLayerHi;

in vec2  tpl;       // [end 0|1, ring 0..3]
in vec3  iStart;
in vec3  iEnd;
in vec2  iHW;       // [height, width]
in float iColor;    // r<<16 | g<<8 | b
in float iLayer;
in float iJoin;     // packJoin(start heading, end heading)

out vec3 vColor;
out vec3 vNormal;

// The colour rides in one float rather than three: it is swapped on every view-type change, and one
// attribute upload beats three. Exact below 2^24, which 0xffffff is.
vec3 unpackColor(float p) {
  float r = floor(p / 65536.0);
  float g = floor(mod(p / 256.0, 256.0));
  float b = mod(p, 256.0);
  return vec3(r, g, b) / 255.0;
}

void main() {
  // Out of range: collapse the whole instance to one point so it rasterizes nothing. A uniform does this
  //  without touching a buffer, which is what keeps dragging the layer slider smooth.
  if (iLayer < uLayerLo - 0.5 || iLayer > uLayerHi + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vColor = vec3(0.0);
    vNormal = vec3(0.0, 0.0, 1.0);
    return;
  }

  vec3 axis = iEnd - iStart;
  // A zero-length segment has no direction to orient against; pick one rather than emitting NaN.
  vec2 flat2 = axis.xy;
  vec2 dir = vec2(1.0, 0.0);
  if (length(flat2) > 1e-9) dir = normalize(flat2);
  vec2 ownSide = vec2(-dir.y, dir.x);

  float joinStart = floor(iJoin / ${JOIN_STEPS}.0);
  float joined = joinStart;
  if (tpl.x > 0.5) joined = iJoin - joinStart * ${JOIN_STEPS}.0;
  joined = joined * (6.283185307179586 / ${JOIN_STEPS - 1}.0) - 3.141592653589793;
  vec2 bisector = dir + vec2(cos(joined), sin(joined));
  vec2 side2 = ownSide;
  vec2 facing2 = ownSide;
  if (length(bisector) > 1e-6) {
    vec2 tangent = normalize(bisector);
    vec2 miterSide = vec2(-tangent.y, tangent.x);
    float halfTurnCos = dot(miterSide, ownSide);
    if (halfTurnCos > ${Math.cos(MITER_MAX_TURN / 2)}) side2 = miterSide / halfTurnCos;
    if (halfTurnCos > ${Math.cos(SMOOTH_MAX_TURN / 2)}) facing2 = miterSide;
  }
  vec3 side = vec3(side2, 0.0);
  vec3 facing = vec3(facing2, 0.0);
  vec3 up   = vec3(0.0, 0.0, 1.0);

  float halfHeight = iHW.x * 0.5;
  float halfWidth  = iHW.y * 0.5;

  float ring = tpl.y;
  vec3 offset;
  vec3 normal;
  if (ring < 0.5)      { offset =  side * halfWidth;  normal =  facing; }
  else if (ring < 1.5) { offset =  up   * halfHeight; normal =  up; }
  else if (ring < 2.5) { offset = -side * halfWidth;  normal = -facing; }
  else                 { offset = -up   * halfHeight; normal = -up; }

  vec3 world = mix(iStart, iEnd, tpl.x) + offset;

  vNormal = normalize(mat3(modelViewMatrix) * normal);
  vColor = unpackColor(iColor);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`

export const SEG_FS = `
precision highp float;

in vec3 vColor;
in vec3 vNormal;
out vec4 fragColor;

void main() {
  // Front faces only (the material culls the rest), so the normal never needs flipping.
  vec3 n = normalize(vNormal);
  // A single head-on light plus a generous ambient. The point is to read the bead's ROUNDING — which
  //  face is up, which is the side — not to look lit.
  float lambert = max(dot(n, normalize(vec3(0.35, 0.35, 1.0))), 0.0);
  fragColor = vec4(vColor * (0.55 + 0.45 * lambert), 1.0);
}
`
