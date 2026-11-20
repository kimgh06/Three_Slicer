// The most threads one slice of this kernel runs at once, set by the host between slices (set_thread_limit, 0 = no
//  limit, the default). A run of many plates gives each of its workers a share of the cores: with every worker free to
//  start one thread per core, eight workers ran 64 threads on eight cores. Measured on a 28-plate project (8 cores,
//  Chrome): 4 workers without a limit 22.0-22.2 s, 8 workers at 2 threads 21.5-21.8 s.
//  The limit changes how many threads share the work and nothing else: every threaded loop here gives the serial result.
#pragma once
#include <atomic>
#include <thread>

namespace thread_limit {

inline std::atomic<unsigned>& value() { static std::atomic<unsigned> limit{0}; return limit; }

// std::thread::hardware_concurrency() under the limit. An unknown count stays 0, as the callers expect.
inline unsigned hardware_threads() {
  const unsigned hardware = std::thread::hardware_concurrency();
  const unsigned limit = value().load(std::memory_order_relaxed);
  if (limit > 0 && limit < hardware) return limit;
  return hardware;
}

} // namespace thread_limit
