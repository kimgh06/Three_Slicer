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
  vec2 dir = length(flat2) > 1e-9 ? normalize(flat2) : vec2(1.0, 0.0);
  vec3 side = vec3(-dir.y, dir.x, 0.0);
  vec3 up   = vec3(0.0, 0.0, 1.0);

  float halfHeight = iHW.x * 0.5;
  float halfWidth  = iHW.y * 0.5;

  float ring = tpl.y;
  vec3 offset;
  if (ring < 0.5)      offset =  side * halfWidth;
  else if (ring < 1.5) offset =  up   * halfHeight;
  else if (ring < 2.5) offset = -side * halfWidth;
  else                 offset = -up   * halfHeight;

  vec3 world = mix(iStart, iEnd, tpl.x) + offset;

  vNormal = normalize(mat3(modelViewMatrix) * normalize(offset));
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
  // Two-sided: the layer slider cuts the plate open, so back faces are seen and must not go black.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  // A single head-on light plus a generous ambient. The point is to read the bead's ROUNDING — which
  //  face is up, which is the side — not to look lit.
  float lambert = max(dot(n, normalize(vec3(0.35, 0.35, 1.0))), 0.0);
  fragColor = vec4(vColor * (0.55 + 0.45 * lambert), 1.0);
}
`
