// STUB -> real parallelism (WP-tbb): inside an enabled scope run() spawns a thread (within budget), otherwise it stays inline as before.
#pragma once
#include "stub_parallel.h"
#include <vector>
#include <thread>
#include <utility>
#include <functional>
namespace tbb {
class task_group {
  std::vector<std::thread> ths;
public:
  // First pass: task_group stays inline (threading disabled). Under investigation for mt aborts on large models — about 85% of the bottleneck
  //  (top_contacts 18.4s / base 7.2s / trim 3.5s, measured with sup-prof) is on the parallel_for side, so little is lost.
  //  Re-enabling task_group parallelism waits until the crash cause is confirmed. (The threaded version is in the git history.)
  // [Confirmed] task_group threading still reproduces the abort at 774k tri even after the early simplification (4x less heap) (3/3, second soak)
  //  -> the cause is a race/UB inside the port, not memory pressure. Permanently inline. (The threaded version is in the git history.)
  template<class F> void run(F&& f){
    f();
    tbb_stub::prog().fetch_add(1);   // real progress tick (for UI polling)
  }

  void wait(){
    for (auto& worker : ths) worker.join();
    ths.clear();
  }
  ~task_group(){ wait(); }
};
}
