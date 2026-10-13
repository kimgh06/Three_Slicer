// stream_sink.cpp — extracted verbatim from slicer_core.cpp (pure code move; no behavior change).
//  `static` dropped because stream_sink.h now declares these for slice() and the embind block.
#include "stream_sink.h"

// =============================================================================
// Stage 30: layer streaming sink. When the viewer (worker) registers one with set_layer_sink(cb), slice() emits each layer via
//  cb(z, layerIndex, gcodeChunk, pathsF32, widthsF32) and frees that layer's buffers from the heap instead of keeping them resident
//  (the §6.8 output streaming round). With no sink registered the old batch path runs (byte-identical). It is a function-local static so it is
//  initialized safely on the first call after runtime startup (avoiding global em::val static initialization order issues). Only one slice at a time is assumed.
em::val& layer_sink() {
  static em::val sink = em::val::undefined();
  return sink;
}
void set_layer_sink(em::val callback) { layer_sink() = callback; }
void clear_layer_sink() { layer_sink() = em::val::undefined(); }

// PE tag stripping (a stateless line filter) — applied to the whole g-code in batch mode and per chunk when streaming (chunks end on '\n',
//  so no line is cut and the result is the same). Deletes ;_EXTRUSION_ROLE/;_EXTRUDE_END lines and strips the trailing
//  ;_EXTRUDE_SET_SPEED/;_EXTERNAL_PERIMETER comments (the G1 F lines are kept).
void strip_pe_tags(std::string& gcode) {
  std::string out;
  out.reserve(gcode.size());
  size_t lineStart=0, length=gcode.size();
  while (lineStart<length) {
    size_t lineEnd=gcode.find('\n', lineStart);
    if (lineEnd==std::string::npos) lineEnd=length;
    std::string line=gcode.substr(lineStart, lineEnd-lineStart);
    bool drop=false;
    if (line.compare(0,17,";_EXTRUSION_ROLE:")==0) drop=true;
    else if (line.compare(0,13,";_EXTRUDE_END")==0) drop=true;
    if (!drop) {
      size_t tagPos;
      if ((tagPos=line.find(" ;_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(tagPos);
      else if ((tagPos=line.find(";_EXTRUDE_SET_SPEED"))!=std::string::npos) line.erase(tagPos);
      if ((tagPos=line.find(";_EXTERNAL_PERIMETER"))!=std::string::npos) line.erase(tagPos);
      while (!line.empty() && (line.back()==' '||line.back()=='\t')) line.pop_back();
      out += line;
      out += '\n';
    }
    lineStart = lineEnd+1;
  }
  gcode.swap(out);
}
