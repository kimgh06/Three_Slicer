// raft.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  zShift (the model z offset the raft introduces) is returned instead of being assigned to slice()'s local.
#include "slice_ctx.h"

#include "clip_util.h"
#include "emit.h"

#include <algorithm>
#include <cstdio>
#include <vector>

// A raft is support material upstream, so its lines take the support flow ratio (emit.cpp role_flow_ratio).
static void raft_support_flow(GW& gw, const Params& p) { gw.set_role_flow(role_flow_ratio(p, FlowRole::Support, gw.on_first_layer)); }

double raft_emit(GW& gw, const Params& p, std::vector<LayerData>& L, double w, int nraft,
                 int fTravel, int fFirst, SeamCtx& seamCtx, const FlushFn& flush_layer) {
  double zShift = 0.0;
  if (nraft > 0 && !L.empty() && !L[0].contour.empty()) {
    const double raftFirstH = p.raft_first_layer_height;   // stage 33: the 0.30 constant -> a parameter
    Paths base = L[0].contour;
    base = union_paths(base, L[0].supIface);
    base = union_paths(base, L[0].supBase);
    Paths raftArea = offset_paths(base, p.raft_expansion); // stage 33: the +3.0 constant -> raft_expansion (upstream default 1.5)
    double rz = raftFirstH;
    gw.set_fan(0);                               // fan off for the raft (the first layers)
    for (int k=0;k<nraft;++k) {
      double rh = (k==0) ? raftFirstH : p.layer_height;
      gw.role_flow = 1.0; gw.on_first_layer = (k == 0);   // the raft's first layer is the print's first layer
      gw.set_e_per_mm(rh, p); gw.z = rz;
      std::vector<float> tp, widths; g_seg_w = &widths; g_seg_w_cur = (float)w;   // stage 21: record raft widths
      char cm[64]; std::snprintf(cm,sizeof cm,"; raft %d Z%.3f",k,rz); gw.raw(cm);
      gw.layer_z(rz, fTravel);
      if (k == 1) gw.second_layer_begin();   // the raft's second layer is the print's second layer
      // The raft is support material upstream (support_speed; the first layer's infill speed on the first layer). Every
      //  raft layer prints at fFirst without per-role speeds, as it always did.
      const RoleFeeds feeds = role_feeds(p, k == 0, k, nraft, fFirst, fFirst, -1.0);
      if (k==0) {
        gw.set_feature((int)FlowRole::Skirt);
        for (int s=0;s<p.skirt_loops;++s){ Paths r=offset_paths(raftArea,(p.skirt_distance+w*0.5+s*w)); emit_loops(gw,tp,r,rz,4.0f,feeds.of(FlowRole::Skirt),fTravel,-1,seamCtx); }
        raft_support_flow(gw, p);
        gw.set_feature((int)FlowRole::Support);
        emit_lines(gw, tp, infill_clipped(raftArea, 0.0, w), rz, 6.0f, feeds.of(FlowRole::Support), fTravel);        // first raft layer: solid
      } else {
        raft_support_flow(gw, p);
        gw.set_feature((int)FlowRole::Support);
        double angle = 0.0;
        if (k % 2) angle = 90.0;
        emit_lines(gw, tp, infill_clipped(raftArea, angle, w/0.5), rz, 6.0f, feeds.of(FlowRole::Support), fTravel); // afterwards: sparse
      }
      flush_layer(rz, k, tp, widths);
      rz += p.layer_height;
    }
    g_seg_w = nullptr;   // stage 21: the local raft widths goes out of scope here -> prevents dangling
    // Stage 33: wiring up raft_contact_distance — the gap between the raft top surface and the model's first layer (an air gap for separation).
    zShift = raftFirstH + (nraft-1)*p.layer_height + p.raft_contact_distance;   // the model's first layer Z = zShift + first_layer_height
  }
  return zShift;
}
