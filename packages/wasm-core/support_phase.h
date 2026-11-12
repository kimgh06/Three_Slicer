// support_phase.h — the organic tree support's branches made outside the kernel (the GPU path,
// engine/src/support_gpu.js), between two calls of slice() like the contour phase (contour_phase.h).
//   CAPTURE  the slice runs PASS1 and the surfaces, the tree support places its tips (overhang detection and
//            generate_initial_areas, upstream as they are) and stops there: slice() returns {supportCaptured: true} and
//            keeps its layers. `request` then holds what the branches are made from: every layer's outline, the tips,
//            and the settings upstream derives its branch shape from.
//   INJECT   the next slice() takes the kept layers (no PASS1, no surfaces) and the tree support as the capture left
//            it (the facade print in treesupport_bridge_impl.cpp, the group's layers in TreeSupport3D.cpp: no overhang
//            detection, no volumes, no tips a second time), and reads the support body of every layer from `injected`
//            where upstream would propagate its influence areas and draw the branches (create_layer_pathing,
//            create_nodes_from_area, organic_draw_branches). Interfaces and toolpaths are upstream's, from those
//            polygons. An INJECT that does not follow its own capture (another layer count, nothing injected) drops
//            what was kept and is the plain slice.
//   RESUME   the next slice() takes the kept layers and runs upstream's whole support: the slice the kernel would have
//            made without the capture, for a caller whose GPU failed after it. test_support_phase.mjs pins it
//            byte-identical to the plain slice.
// OFF is the kernel as it was. Coordinates are millimetres in the tree bridge's frame (the slice frame minus the model
// centre, support.cpp), which is the frame the outlines are handed to upstream in.
// Not captured, so the slice comes back whole: a raft (the support layers are no longer the object's), any style that
// is not organic, multi-material.
#pragma once
#include <vector>

namespace support_phase {

enum Mode { OFF = 0, CAPTURE = 1, INJECT = 2, RESUME = 3 };
extern int mode;
extern bool captured;      // the last CAPTURE slice stopped at the tips
extern bool layersKept;    // slice() holds that slice's layers for the next call
// A CAPTURE precalculates only the volumes placing the tips reads (TreeModelVolumes::precalculate tips_only). With this
//  set it precalculates all of them, as a plain slice does: test_support_phase.mjs compares the tips of the two.
extern bool fullVolumes;

// rings as three flat arrays: layerRingStart[layer] .. layerRingStart[layer + 1] are the layer's rings,
//  ringStart[ring] .. ringStart[ring + 1] its points, points holds x, y per point
struct Rings {
  std::vector<unsigned> layerRingStart, ringStart;
  std::vector<float> points;
  void clear() { layerRingStart.clear(); ringStart.clear(); points.clear(); }
};

struct Request {
  Rings outlines;                 // the object's outline per layer, as the tree support reads it
  std::vector<double> layerZ;     // print z per layer
  std::vector<float> tips;        // x, y, layer, radius per tip
  int supportLayers = 0;          // layers the tree support works on (tips sit below this)
  // upstream's TreeSupportSettings, in mm and layers
  double layerHeight = 0, xyDistance = 0, maxMove = 0, minRadius = 0, branchRadius = 0, radiusIncreasePerLayer = 0, lineWidth = 0;
  int tipLayers = 0, zDistanceTopLayers = 0, zDistanceBottomLayers = 0;
  double bedMinX = 0, bedMinY = 0, bedMaxX = 0, bedMaxY = 0;
};
extern Request request;
extern Rings injected;            // INJECT: the support body per layer

void reset();                     // back to OFF, everything released

}  // namespace support_phase
