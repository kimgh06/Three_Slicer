// (performance) Shared part of the real-parallel tbb stubs — for treesupport_port only.
//  Serial by default, exactly as before. parallel_for/task_group use real threads only inside a scope the bridge
//  (generate_normal, grid/snug) opened with ParallelScope, or around one tree-path loop with ParallelSection. The rest of
//  the tree path stays serial because the concurrent_* stubs are not thread-safe (they are std aliases): a loop is
//  threaded there only after its shared state is locked or made per-index (TreeSupport.cpp: detect_overhangs' layer
//  loops, draw_circles, generate_toolpaths, the avoidance precompute, drop_nodes' spanning trees and move pass; and
//  TreeSupport::generate takes one thread with take(1) to build the preview cache beside detect_overhangs).
//  budget: a global budget so nested spawning cannot exceed the emscripten pthread pool (hardwareConcurrency).
//  When the budget runs out the work runs serially on the calling thread (same results, deadlock impossible).
#pragma once
#include <atomic>
#include <thread>

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
inline int take(int want) {
  int available = budget().load(std::memory_order_relaxed);
  while (available > 0) {
    int granted = available;
    if (want < available) granted = want;
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

} // namespace tbb_stub
