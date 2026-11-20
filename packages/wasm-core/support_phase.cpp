// support_phase.cpp — see support_phase.h.
#include "support_phase.h"
#include "treesupport_bridge.h"

namespace support_phase {

int mode = OFF;
bool captured = false;
bool layersKept = false;
bool fullVolumes = false;
Request request;
Rings injected;

void reset() {
  mode = OFF;
  captured = false;
  fullVolumes = false;
  request = Request();
  Rings().points.swap(injected.points);
  injected.clear();
  treesupport_bridge::drop_captured();
}

}  // namespace support_phase
