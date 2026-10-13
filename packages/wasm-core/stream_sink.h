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
void set_layer_sink(em::val callback);
void clear_layer_sink();
void strip_pe_tags(std::string& gcode);

#ifdef __EMSCRIPTEN_PTHREADS__
// (mt) Time estimate overlap — the emitting thread (producer) queues chunks on '\n' boundaries and a single worker (consumer)
//  exclusively runs gcodeproc_bridge::estimate_begin/feed. The bridge state (the file-static g_gp) is touched only by the worker between
//  begin and feed; finish()'s join establishes happens-before, after which estimate_end() runs on the caller's thread.
//  Chunk contents and order are unchanged -> identical estimates and no effect on G-code (golden-safe). Only wall-clock shrinks as emission and parsing overlap.
struct TimeFeeder {
  std::thread worker;
  std::mutex queue_mutex;
  std::condition_variable queue_changed;
  std::deque<std::string> chunks;
  bool done = false;
  bool threaded = false;   // no thread could be had (the pthread pool was empty): the caller feeds the estimate itself
  void begin(const gcodeproc_bridge::Limits& limits, const gcode_time::Limits* fallback) {
    try {
      worker = std::thread([this, limits, fallback]{
        gcodeproc_bridge::estimate_begin(limits, fallback);
        for (;;) {
          std::string chunk;
          {
            std::unique_lock<std::mutex> lock(queue_mutex);
            queue_changed.wait(lock, [&]{ return !chunks.empty() || done; });
            if (chunks.empty()) break;                       // done && queue drained -> exit
            chunk = std::move(chunks.front());
            chunks.pop_front();
          }
          gcodeproc_bridge::estimate_feed(chunk);
        }
      });
      threaded = true;
    }
    catch (...) { gcodeproc_bridge::estimate_begin(limits, fallback); }
  }
  void feed(std::string chunk) {
    if (chunk.empty()) return;
    if (!threaded) {
      gcodeproc_bridge::estimate_feed(chunk);
      return;
    }
    {
      std::lock_guard<std::mutex> lock(queue_mutex);
      chunks.push_back(std::move(chunk));
    }
    queue_changed.notify_one();
  }
  gcodeproc_bridge::Result finish() {
    if (threaded) {
      {
        std::lock_guard<std::mutex> lock(queue_mutex);
        done = true;
      }
      queue_changed.notify_one();
      worker.join();
    }
    return gcodeproc_bridge::estimate_end();
  }
};
#endif
