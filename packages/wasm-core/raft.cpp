// raft.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  zShift (the model z offset the raft introduces) is returned instead of being assigned to slice()'s local.
#include "slice_ctx.h"

#include "clip_util.h"
#include "emit.h"

#include <algorithm>
#include <cstdio>
#include <vector>

// A raft is support material upstream, so its lines take the support flow ratio (emit.cpp role_flow_ratio).
static void raft_support_flow(GcodeWriter& writer, const Params& params) { writer.set_role_flow(role_flow_ratio(params, FlowRole::Support, writer.on_first_layer)); }

double raft_emit(GcodeWriter& writer, const Params& params, std::vector<LayerData>& layers, double lineWidth, int raftLayerCount,
                 int travelFeed, int firstLayerFeed, SeamContext& seamContext, const LayerFlushCallback& flush_layer) {
  double zShift = 0.0;
  if (raftLayerCount > 0 && !layers.empty() && !layers[0].contour.empty()) {
    const double raftFirstLayerHeight = params.raft_first_layer_height;   // stage 33: the 0.30 constant -> a parameter
    Paths base = layers[0].contour;
    base = union_paths(base, layers[0].supportInterface);
    base = union_paths(base, layers[0].supportBase);
    Paths raftArea = offset_paths(base, params.raft_expansion); // stage 33: the +3.0 constant -> raft_expansion (upstream default 1.5)
    double raftZ = raftFirstLayerHeight;
    writer.set_fan(0);                               // fan off for the raft (the first layers)
    for (int k=0;k<raftLayerCount;++k) {
      double raftLayerHeight;
      if (k==0) {
        raftLayerHeight = raftFirstLayerHeight;
      } else {
        raftLayerHeight = params.layer_height;
      }
      writer.role_flow = 1.0;
      writer.on_first_layer = (k == 0);   // the raft's first layer is the print's first layer
      writer.set_e_per_mm(raftLayerHeight, params);
      writer.z = raftZ;
      std::vector<float> toolpath, widths;
      g_segment_widths = &widths;
      g_current_segment_width = (float)lineWidth;   // stage 21: record raft widths
      char comment[64];
      std::snprintf(comment,sizeof comment,"; raft %d Z%.3f",k,raftZ);
      writer.raw(comment);
      writer.layer_z(raftZ, travelFeed);
      if (k == 1) writer.second_layer_begin();   // the raft's second layer is the print's second layer
      // The raft is support material upstream (support_speed; the first layer's infill speed on the first layer). Every
      //  raft layer prints at firstLayerFeed without per-role speeds, as it always did.
      const RoleFeeds feeds = role_feeds(params, k == 0, k, raftLayerCount, firstLayerFeed, firstLayerFeed, -1.0);
      if (k==0) {
        writer.set_feature((int)FlowRole::Skirt);
        for (int loop=0;loop<params.skirt_loops;++loop){
          Paths skirtLoop=offset_paths(raftArea,(params.skirt_distance+lineWidth*0.5+loop*lineWidth));
          emit_loops(writer,toolpath,skirtLoop,raftZ,4.0f,feeds.of(FlowRole::Skirt),travelFeed,-1,seamContext);
        }
        raft_support_flow(writer, params);
        writer.set_feature((int)FlowRole::Support);
        emit_lines(writer, toolpath, infill_clipped(raftArea, 0.0, lineWidth), raftZ, 6.0f, feeds.of(FlowRole::Support), travelFeed);        // first raft layer: solid
      } else {
        raft_support_flow(writer, params);
        writer.set_feature((int)FlowRole::Support);
        double angle = 0.0;
        if (k % 2) angle = 90.0;
        emit_lines(writer, toolpath, infill_clipped(raftArea, angle, lineWidth/0.5), raftZ, 6.0f, feeds.of(FlowRole::Support), travelFeed); // afterwards: sparse
      }
      flush_layer(raftZ, k, toolpath, widths);
      raftZ += params.layer_height;
    }
    g_segment_widths = nullptr;   // stage 21: the local raft widths goes out of scope here -> prevents dangling
    // Stage 33: wiring up raft_contact_distance — the gap between the raft top surface and the model's first layer (an air gap for separation).
    zShift = raftFirstLayerHeight + (raftLayerCount-1)*params.layer_height + params.raft_contact_distance;   // the model's first layer Z = zShift + first_layer_height
  }
  return zShift;
}
