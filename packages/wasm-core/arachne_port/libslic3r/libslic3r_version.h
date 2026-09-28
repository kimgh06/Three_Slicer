// STUB (stage 7 Arachne port): real file is generated from libslic3r_version.h.in by CMake.
// libslic3r.h defines GCODEVIEWER_* itself, so we only supply SLIC3R_* here to avoid redefinition.
#pragma once
#define SLIC3R_APP_NAME "OrcaSlicer-RE"
#define SLIC3R_VERSION "0.0.0"
#define SLIC3R_BUILD_ID "arachne-port"
// (issue 63) PlaceholderParser exposes it to custom G-code as [version]. The value of set(SoftFever_VERSION) in
//  version.inc of the upstream checkout this port follows.
#define SoftFever_VERSION "2.5.0-dev"
