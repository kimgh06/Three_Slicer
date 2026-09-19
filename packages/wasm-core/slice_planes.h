// slice_planes.h — extracted from slicer_core.cpp; the static helpers became `inline`. Segments are oriented
//  (tri_plane) so the loops can be filled NonZero, as upstream's Regular slicing mode does.
#pragma once
#include "clip_util.h"
#include "stl_parse.h"

#include <algorithm>
#include <cmath>
#include <unordered_map>
#include <vector>

// ---- Triangle-plane intersection -> segments ------------------------------------
struct Seg { double x0, y0, x1, y1; };
inline bool tri_plane(const Tri& t, double z, Seg& out) {
  double px[3], py[3]; int c = 0;
  for (int e = 0; e < 3; ++e) {
    const V3& a = t.v[e]; const V3& b = t.v[(e + 1) % 3];
    if ((a.z < z && b.z >= z) || (b.z < z && a.z >= z)) {
      double f = (z - a.z) / (b.z - a.z);
      if (c < 2) { px[c] = a.x + f*(b.x-a.x); py[c] = a.y + f*(b.y-a.y); }
      ++c;
    }
  }
  if (c != 2) return false;
  // Oriented like upstream's IntersectionLine: the solid on the LEFT, so an outer loop runs CCW and a hole CW. The
  //  facet normal comes from the vertex winding (the STL's stored normal is not trusted, as upstream does not); the
  //  segment is flipped when that normal's XY part points to its left. Without this every segment's direction was
  //  whichever edge the loop above met first, so only an even-odd fill could make sense of the loops — and even-odd
  //  counts two coincident shells as "inside twice" = outside: two objects on the same spot sliced to nothing.
  const double e1x = t.v[1].x - t.v[0].x, e1y = t.v[1].y - t.v[0].y, e1z = t.v[1].z - t.v[0].z;
  const double e2x = t.v[2].x - t.v[0].x, e2y = t.v[2].y - t.v[0].y, e2z = t.v[2].z - t.v[0].z;
  const double nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z;
  const double dx = px[1] - px[0], dy = py[1] - py[0];
  if (dy * nx - dx * ny < 0) out = { px[1],py[1],px[0],py[0] };   // normal must lie on the right of travel
  else out = { px[0],py[0],px[1],py[1] };
  return true;
}
inline long long qkey(double x, double y) {
  long long qx=(long long)std::llround(x/1e-3), qy=(long long)std::llround(y/1e-3);
  return (qx << 32) ^ (qy & 0xffffffffLL);
}
// Segments arrive oriented (tri_plane), and a loop keeps the direction of its first segment: at each point the
//  continuation that STARTS there is preferred, so where two shells touch or coincide (four segments meeting) the
//  walk does not turn back along an incoming one. A loop assembled mostly against its segments' own direction — a
//  shell with flipped facets — is reversed, so it still winds the way its majority of facets says. With a
//  consistently oriented manifold mesh there is exactly one unused continuation and it always starts at the point,
//  so the chain visits what it did before; only the direction of a loop can differ.
inline Paths chain_polys(std::vector<Seg>& segs) {
  int N=(int)segs.size();
  std::vector<char> used(N,0);
  std::unordered_map<long long,std::vector<int>> m; m.reserve(N*2);
  for (int i=0;i<N;++i){ m[qkey(segs[i].x0,segs[i].y0)].push_back(i*2); m[qkey(segs[i].x1,segs[i].y1)].push_back(i*2+1); }
  Paths out;
  for (int i=0;i<N;++i){
    if (used[i]) continue; used[i]=1;
    double sx=segs[i].x0, sy=segs[i].y0, cx=segs[i].x1, cy=segs[i].y1;
    Path poly;
    poly.push_back(IntPoint((cInt)std::llround(sx*SCALE),(cInt)std::llround(sy*SCALE)));
    poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    int forward=1, backward=0;
    for (int g=0;g<N;++g){
      if (qkey(cx,cy)==qkey(sx,sy)) break;
      auto it=m.find(qkey(cx,cy)); int nxt=-1,ne=-1;
      if (it!=m.end()) for (int ref:it->second){ int si=ref/2; if(used[si])continue;
        if (nxt<0 || (ne!=0 && ref%2==0)) { nxt=si; ne=ref%2; }
        if (ne==0) break; }
      if (nxt<0) break; used[nxt]=1;
      if (ne==0){ cx=segs[nxt].x1; cy=segs[nxt].y1; ++forward; } else { cx=segs[nxt].x0; cy=segs[nxt].y0; ++backward; }
      poly.push_back(IntPoint((cInt)std::llround(cx*SCALE),(cInt)std::llround(cy*SCALE)));
    }
    if (backward > forward) std::reverse(poly.begin(), poly.end());
    if (poly.size()>=3) out.push_back(std::move(poly));
  }
  return out;
}
