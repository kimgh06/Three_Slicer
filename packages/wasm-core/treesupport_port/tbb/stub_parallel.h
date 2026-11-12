// (performance) Shared part of the real-parallel tbb stubs — for treesupport_port only.
//  Serial by default, exactly as before. parallel_for/task_group use real threads only inside a scope the bridge
//  (generate_normal, grid/snug) opened with ParallelScope, or around one tree-path loop with ParallelSection. The rest of
//  the tree path stays serial because the concurrent_* stubs are not thread-safe (they are std aliases): a loop is
//  threaded there only after its shared state is locked or made per-index (TreeSupport.cpp: detect_overhangs' layer
//  loops, draw_circles, generate_toolpaths, the avoidance precompute, drop_nodes' spanning trees and move pass; and
//  TreeSupport::generate takes one thread with take(1) to build the preview cache beside detect_overhangs). The organic
//  path (TreeSupport3D.cpp) opens one section around the whole generate_tree_support_3D: upstream wrote its loops for
//  real TBB, with per-index writes and locked caches.
//  budget: a global budget so spawning cannot exceed the emscripten pthread pool (hardwareConcurrency).
//  When the budget runs out the work runs serially on the calling thread (same results). Threads are started from the
//  runtime's main thread only (threaded_here below); a nested start from a pthread can hang.
#pragma once
#include <atomic>
#include <thread>
#include "../../thread_limit.h"
#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/threading.h>
#endif

namespace tbb_stub {

inline std::atomic<bool>& enabled() { static std::atomic<bool> flag{false}; return flag; }

// Slice cancel flag — the UI thread writes it directly via SAB (observable even while the worker/wasm is blocked).
//  Kernel loops and the ports' canceled() poll it per iteration. Reset to 0 when slice() is entered.
inline std::atomic<unsigned>& cancel() { static std::atomic<unsigned> flag{0}; return flag; }

// Width hw-1 — the early crashes were resolved by disabling task_group threading (large models are st==mt byte-identical), and
//  the parallel_for-only full-width configuration is verified with golden plus a g-code comparison on large models.
inline int initial_budget() {
  if (std::thread::hardware_concurrency() > 1) return (int)(std::thread::hardware_concurrency() - 1);
  return 0;
}
inline std::atomic<int>& budget() {
  static std::atomic<int> available_threads(initial_budget());
  return available_threads;
}
// Under the host's thread limit (thread_limit.h) the threads already taken and the ones granted here stay below it,
//  the calling thread counted as one.
inline int take(int want) {
  int available = budget().load(std::memory_order_relaxed);
  while (available > 0) {
    int granted = available;
    if (want < available) granted = want;
    const int limit = (int)thread_limit::value().load(std::memory_order_relaxed);
    if (limit > 0) {
      const int room = limit - 1 - (initial_budget() - available);
      if (room <= 0) return 0;
      if (room < granted) granted = room;
    }
    if (budget().compare_exchange_weak(available, available - granted)) return granted;
  }
  return 0;
}
inline void give(int count) { budget().fetch_add(count); }

// Real support progress counter — raised by completed parallel_for indices and completed task_group runs.
//  The UI (main thread) polls it directly via SAB (progress display for stretches where callbacks are impossible). Unit: roughly "one layer processed".
inline std::atomic<uint32_t>& prog() { static std::atomic<uint32_t> counter{0}; return counter; }

// RAII wrapper the bridge uses around a parallel-capable scope — resets the progress counter on entry
struct ParallelScope {
  ParallelScope()  {
    prog().store(0);
    enabled().store(true);
  }
  ~ParallelScope() { enabled().store(false); }
};

// One loop of the tree path that runs threaded: turns the flag on for its lifetime and restores it, leaving the progress
//  counter alone (the tree path counts its whole support band on it). Only for a loop whose iterations write disjoint
//  state and read shared state only, so the output does not depend on the thread count (draw_circles: one layer each).
struct ParallelSection {
  bool was_enabled;
  ParallelSection() : was_enabled(enabled().exchange(true)) {}
  ~ParallelSection() { enabled().store(was_enabled); }
};

// Keeps the loops called on THIS thread serial for its lifetime, while other threads stay threaded. It is per thread
//  because the threads of one loop each open it: a global flag that each of them turned off and restored would end in
//  whatever state the last restore left. For work that is already threaded one level up and whose inner loops are
//  either too small to pay for a thread or append under a lock in thread order (TriangleMeshSlicer's slice_make_lines).
inline int &serial_depth() { thread_local int depth = 0; return depth; }
struct SerialSection {
  SerialSection()  { ++serial_depth(); }
  ~SerialSection() { --serial_depth(); }
};
// Whether a loop entered on this thread may use threads. Only the runtime's main thread starts any. A thread started from
//  another pthread is created through the main thread, and the pthread it joins goes back to the pool through a message
//  the main thread only reads once the slice has returned: while the main thread waits on a lock or a join, the nested
//  start can wait forever, and the pool runs dry for the kernel's own threads after the support pass (precompute has no
//  fallback for that). A loop entered on a pthread therefore runs on that pthread.
inline bool threaded_here() {
#ifdef __EMSCRIPTEN_PTHREADS__
  if (!emscripten_is_main_runtime_thread()) return false;
#endif
  return enabled().load(std::memory_order_relaxed) && serial_depth() == 0;
}

} // namespace tbb_stub
