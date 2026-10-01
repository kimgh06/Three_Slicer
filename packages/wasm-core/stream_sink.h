// stream_sink.h — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  TimeFeeder keeps its inline bodies (it is instantiated inside slice()); the sink accessors and the PE tag
//  filter are defined in stream_sink.cpp.
#pragma once
#include "gcodeproc_bridge.h"

#include <emscripten/val.h>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace em = emscripten;

em::val& layer_sink();
void set_layer_sink(em::val cb);
void clear_layer_sink();
void strip_pe_tags(std::string& g);

#ifdef __EMSCRIPTEN_PTHREADS__
// (mt) Time estimate overlap — the emitting thread (producer) queues chunks on '\n' boundaries and a single worker (consumer)
//  exclusively runs gcodeproc_bridge::estimate_begin/feed. The bridge state (the file-static g_gp) is touched only by the worker between
//  begin and feed; finish()'s join establishes happens-before, after which estimate_end() runs on the caller's thread.
//  Chunk contents and order are unchanged -> identical estimates and no effect on G-code (golden-safe). Only wall-clock shrinks as emission and parsing overlap.
struct TimeFeeder {
  std::thread th; std::mutex mu; std::condition_variable cv;
  std::deque<std::string> q; bool done = false;
  bool threaded = false;   // no thread could be had (the pthread pool was empty): the caller feeds the estimate itself
  void begin(const gcodeproc_bridge::Limits& gl, const gcode_time::Limits* fallback) {
    try { th = std::thread([this, gl, fallback]{
      gcodeproc_bridge::estimate_begin(gl, fallback);
      for (;;) {
        std::string c;
        { std::unique_lock<std::mutex> lk(mu);
          cv.wait(lk, [&]{ return !q.empty() || done; });
          if (q.empty()) break;                       // done && queue drained -> exit
          c = std::move(q.front()); q.pop_front(); }
        gcodeproc_bridge::estimate_feed(c);
      }
    }); threaded = true; }
    catch (...) { gcodeproc_bridge::estimate_begin(gl, fallback); }
  }
  void feed(std::string c) {
    if (c.empty()) return;
    if (!threaded) { gcodeproc_bridge::estimate_feed(c); return; }
    { std::lock_guard<std::mutex> lk(mu); q.push_back(std::move(c)); }
    cv.notify_one();
  }
  gcodeproc_bridge::Result finish() {
    if (threaded) {
      { std::lock_guard<std::mutex> lk(mu); done = true; }
      cv.notify_one(); th.join();
    }
    return gcodeproc_bridge::estimate_end();
  }
};
#endif
