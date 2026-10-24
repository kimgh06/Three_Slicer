# Third-party notices

`three-slicer` is licensed AGPL-3.0-or-later (see `LICENSE.txt`). The distributed artifacts — the WASM
kernels embedded in `engine/src/slicer_core.js` / `slicer_core.mt.js` —
contain compiled or bundled code from the following projects. Full license texts ship in the source
repository at the paths given (the package's `repository` field points there); the kernel's vendored copies
live under `packages/wasm-core/third_party/deps_src/`.

## Compiled into the WASM kernels

| Component | License | Source of the vendored copy |
| --- | --- | --- |
| OrcaSlicer (the FFF slicing code this package is ported from) | AGPL-3.0-or-later | github.com/SoftFever/OrcaSlicer |
| PrusaSlicer 2.9.6 (the SLA support/pad chain, ported verbatim under `packages/wasm-core/slasupport_port/`) | AGPL-3.0-or-later | github.com/prusa3d/PrusaSlicer |
| Clipper (Angus Johnson) | BSL-1.0 | `deps_src/clipper/` |
| Clipper2 | BSL-1.0 | `deps_src/clipper2/` |
| Boost (header-only use) | BSL-1.0 | headers at build time |
| Eigen (header-only) | MPL-2.0 | headers at build time |
| CGAL 6 (header-only use, GMP/MPFR disabled) | GPL-3.0-or-later | headers at build time |
| libigl (headers; both the Orca-generation copy and Prusa's bundled copy) | MPL-2.0 | `deps_src/libigl/`, `deps_src/libigl_prusa/` |
| libnest2d (headers) | LGPL-3.0 | `deps_src/libnest2d/` (its `LICENSE.txt`) |
| NLopt 2.5.0 | LGPL-2.1-or-later for the combined library (`deps_src/nlopt/COPYING`); per-algorithm terms in each `algs/*/COPYRIGHT` — the most restrictive is `algs/luksan` (LGPL-2.1+), most others (e.g. `algs/newuoa`) are MIT-style Powell/MIT notices | `deps_src/nlopt/` |
| SGI glu-libtess (the GLU tessellator) | SGI Free Software License B 2.0 | `deps_src/glu-libtess/` (header of each source file) |
| Emscripten runtime (the generated JS glue around the kernels) | MIT | emscripten.org |

## The viewer and the settings panel

The viewer and the settings panel are `three-slicer-viewer` (MIT), a separate package with its own
`THIRD-PARTY-NOTICES.md`. This package bundles no viewer code of its own; since 0.4.0 it does not re-export it either.

## Bundled into the viewer/components builds (historical — see above)

| Component | License | Note |
| --- | --- | --- |
| fflate (via three.js examples) | MIT | zip/unzip in the 3mf and SL1 codecs |

`three`, `react` and `react-dom` are peer dependencies and are not bundled or redistributed by this package.

The LGPL components (NLopt's luksan directory, libnest2d headers) are compiled into a work distributed under
AGPL-3.0-or-later, which satisfies their license terms; their complete license texts accompany the source
repository as noted above. Nothing in this file overrides a component's own license — where this summary and
a vendored license file disagree, the vendored file is authoritative.
