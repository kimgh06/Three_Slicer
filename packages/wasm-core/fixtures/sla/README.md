# Prusa 2.9.6 SLA oracle fixtures

These fixtures are intentionally small, deterministic input descriptions. They are **not** sliced by the
three-slicer kernel to create an expected value. `baseline.json` contains only feature-disabled facts that
are required by the fixture configuration; real parity observables are committed as `oracle.json` only by
the native adapter protocol below.

Regeneration requires both a verified 2.9.6 binary and an adapter capable of reading Prusa's native SLA
intermediate data. The stock CLI's SL1 archive is insufficient because it cannot expose support points,
role-5/role-6 paths, or decoded raster masks.

```sh
node packages/wasm-core/tools/build_sla_oracle.mjs \
  --prusa-source slicers/PrusaSlicer --out /abs/sla_oracle
PRUSA_SLICER_BIN=/abs/prusa-slicer PRUSA_NATIVE_ORACLE=/abs/sla_oracle \
  node packages/wasm-core/tools/generate_sla_oracle.mjs --fixtures packages/wasm-core/fixtures/sla
```

The adapter is `/abs/sla_oracle/sla-oracle-adapter`. It receives `--prusa-bin`, `--fixture`, and `--out`,
must set the manifest's fixed locale/thread/seed environment, and must write the
`three-slicer.sla-native-oracle-observable.v1` JSON schema. Its output must include canonical layer
polygons, support points, role-5/role-6 paths, support/pad mesh bounds, decoded mask pixels, and normalized
archive members. ZIP timestamps and container bytes are never compared.
