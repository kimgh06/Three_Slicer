// STUB (stage 15) -> real parallelism (WP-tbb): serial by default, exactly as before. Only inside a tbb_stub::enabled() scope
//  (the bridge's generate_normal — grid/snug) is the blocked_range split across threads.
//  Split boundaries are deterministic and the upstream tbb-using code writes into per-index independent slots, so results are identical
//  (verified byte-identical on the golden grid case). When the budget (tbb_stub::budget) runs out it falls back to serial — deadlock is impossible.
#pragma once
#include "blocked_range.h"
#include "stub_parallel.h"
#include <vector>
#include <thread>
namespace tbb {
struct simple_partitioner {};
struct auto_partitioner {};
struct affinity_partitioner {};
template<class I, class F> void parallel_for(const blocked_range<I>& r, const F& f) {
#ifdef __EMSCRIPTEN_PTHREADS__
  const size_t range_size = r.size();
  if (range_size > 1 && tbb_stub::enabled().load(std::memory_order_relaxed)) {
    int extra = tbb_stub::take((int)range_size - 1);
    if (extra > 0) {
      const size_t thread_count = (size_t)extra + 1;
      // Dynamic distribution — with per-layer cost variance (only layers with overhangs are heavy), an even n/nt split left threads idle
      //  (measured: top_contact_layers reached only 2.75x on 14 threads while the structurally identical base_layers hit 10x).
      //  Small chunks + an atomic index for work stealing. Chunk boundaries are deterministic and results are per-index independent -> identical output.
      const size_t chunk = std::max<size_t>(1, range_size / (thread_count * 4));
      std::atomic<size_t> next{0};
      const I range_begin = r.begin();
      auto work = [&]{
        for (;;) {
          size_t chunk_begin = next.fetch_add(chunk);
          if (chunk_begin >= range_size) break;
          size_t chunk_end = range_size;
          if (chunk_begin + chunk < range_size) chunk_end = chunk_begin + chunk;
          f(blocked_range<I>(range_begin + (I)chunk_begin, range_begin + (I)chunk_end));
          tbb_stub::prog().fetch_add((uint32_t)(chunk_end - chunk_begin));   // real progress tick (for UI polling)
        }
      };
      std::vector<std::thread> workers;
      workers.reserve(thread_count - 1);
      for (size_t thread_index = 1; thread_index < thread_count; ++thread_index) {
        // Returning workers to the emscripten pool is asynchronous, so a momentary exhaustion makes pthread_create return EAGAIN -> std::thread throws.
        //  Instead of dying, the caller plus the existing workers absorb the remaining chunks (identical results).
        try { workers.emplace_back(work); }
        catch (...) { break; }
      }
      work();
      for (auto& worker : workers) worker.join();
      tbb_stub::give(extra);
      return;
    }
  }
#endif
  f(r);
  // The serial path has to tick too. The counter is what the UI polls through the SAB to animate the support band,
  //  and the tree path runs serial ON PURPOSE (see stub_parallel.h) — so without this the progress bar sat at exactly
  //  36% for the whole of a tree-support slice (measured 71.5s of 76s on a 53.9MB plate) and read as a hang.
  tbb_stub::prog().fetch_add((uint32_t)r.size());
}
template<class R, class F> void parallel_for(const R& r, const F& f){ f(r); }
template<class R, class F, class P> void parallel_for(const R& r, const F& f, P&&){ parallel_for(r, f); }
template<class I, class F> void parallel_for(I b, I e, const F& f){
#ifdef __EMSCRIPTEN_PTHREADS__
  if (e > b && tbb_stub::enabled().load(std::memory_order_relaxed)) {
    parallel_for(blocked_range<I>(b, e), [&f](const blocked_range<I>& sub){
      for (I i = sub.begin(); i < sub.end(); ++i) f(i);
    });
    return;
  }
#endif
  for (I i = b; i < e; ++i) f(i);
  //  Serial only — the threaded branch above returns early, so this never double-counts what it already ticked.
  if (e > b) tbb_stub::prog().fetch_add((uint32_t)(e - b));
}
namespace this_task_arena { inline int max_concurrency(){ return 1; } }
}
