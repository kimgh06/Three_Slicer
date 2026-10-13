// Stage-11: node driver for the embind config-probe. Verifies the ported real Config/PrintConfig
// subsystem exposes a sane print_config_def + FullPrintConfig, and writes the build-based schema
// dump to reverse_engineering/config-schema-builddump.json for the config-schema cross-check.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import createConfigProbe from './config_probe.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    console.log(`  ok: ${message}`);
    return;
  }
  console.log(`  FAIL: ${message}`);
  fail++;
};

const probe = await createConfigProbe();

const optionCount = probe.option_count();
const fullConfigKeys = probe.full_print_config_keys();
console.log(`[stage11 config port]`);
console.log(`  option_count (print_config_def) = ${optionCount}`);
console.log(`  full_print_config_keys          = ${fullConfigKeys}`);
ok(optionCount > 700, `print_config_def option count is substantial (${optionCount})`);
ok(fullConfigKeys > 500, `FullPrintConfig instantiated with keys (${fullConfigKeys})`);

// Spot checks (task-specified expected values)
ok(probe.default_of('layer_height') === '0.2', `layer_height default == 0.2 (got '${probe.default_of('layer_height')}')`);
ok(probe.default_of('seam_position') === 'aligned', `seam_position default == aligned (got '${probe.default_of('seam_position')}')`);
ok(probe.enum_count('sparse_infill_pattern') === 26, `sparse_infill_pattern enum count == 26 (got ${probe.enum_count('sparse_infill_pattern')})`);

// A few more sanity spot checks
ok(probe.default_of('wall_loops') !== '', `wall_loops has a default ('${probe.default_of('wall_loops')}')`);
ok(probe.enum_count('seam_position') > 0, `seam_position is an enum (${probe.enum_count('seam_position')} values)`);

// Write the build-based schema dump
const dump = probe.dump_schema_json();
const parsed = JSON.parse(dump); // validates JSON
const outPath = resolve(__dirname, '../../config-schema-builddump.json');
writeFileSync(outPath, JSON.stringify(parsed, null, 1));
console.log(`  wrote build dump: ${outPath} (${Object.keys(parsed).length} keys)`);
ok(Object.keys(parsed).length === optionCount, `dump key count == option_count (${Object.keys(parsed).length})`);

if (fail === 0) {
  console.log('\nCONFIG PROBE OK');
  process.exit(0);
}
console.log(`\nCONFIG PROBE FAILED (${fail})`);
process.exit(1);
