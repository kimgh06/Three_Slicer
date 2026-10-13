// surfaces.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
#include "slice_ctx.h"

#include "clip_util.h"

#include <algorithm>
#include <atomic>
#include <thread>
#include <vector>

void surfaces_run(SliceCtx& context) {
  std::vector<LayerData>& layers = *context.L;
  const int layerCount = context.N;
  // ---- PASS 1.5: surface detection (this layer's fill − the neighboring contour) ----
  //  Per-layer independent (reads: immutable neighboring contours, writes: its own topSurf/botSurf) -> the same layer parallelism as PASS1.
  {
    auto detectLayerSurfaces = [&](int i){
      if (layers[i].fill.empty()) return;
      Paths above;
      if (i+1<layerCount) above = layers[i+1].contour;
      Paths below;
      if (i-1>=0) below = layers[i-1].contour;
      layers[i].topSurf = clip_paths(layers[i].fill, above, ctDifference);  // nothing above -> a top surface
      layers[i].botSurf = clip_paths(layers[i].fill, below, ctDifference);  // nothing below -> a bottom surface
    };
#ifdef __EMSCRIPTEN_PTHREADS__
    {
      unsigned hardwareThreads = std::thread::hardware_concurrency();
      if (hardwareThreads == 0) hardwareThreads = 4;
      unsigned threadCount = std::max(1u, std::min<unsigned>(hardwareThreads, (unsigned)std::max(1, layerCount)));
      std::atomic<int> nextLayer{0};
      auto worker = [&]{
        int i;
        while ((i = nextLayer.fetch_add(1)) < layerCount) detectLayerSurfaces(i);
      };
      std::vector<std::thread> threads;
      threads.reserve(threadCount-1);
      for (unsigned threadIndex=1; threadIndex<threadCount; ++threadIndex) {
        try { threads.emplace_back(worker); } catch (...) { break; }
      }
      worker();
      for (auto& thread : threads) thread.join();
    }
#else
    for (int i=0;i<layerCount;++i) detectLayerSurfaces(i);
#endif
  }
}
