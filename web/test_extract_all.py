"""The extractor's C++ default parsing, on a fixture instead of upstream's PrintConfig.cpp, so it runs without
slicers/. Run: python3 web/test_extract_all.py

A C++ float literal is one number: `280.f` was once split into [280, "f"], which broke six schema defaults, among
them flush_volumes_matrix, and every template-path tool change purged nothing."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_all import _options_from_src, _parse_list_items

FIXTURE = '''
    def = this->add("scalar_dot_f", coFloat);
    def->set_default_value(new ConfigOptionFloat(0.f));
    def = this->add("scalar_decimal_f", coFloat);
    def->set_default_value(new ConfigOptionFloat(0.01f));
    def = this->add("list_one", coFloats);
    def->set_default_value(new ConfigOptionFloats{ 60.0f });
    def = this->add("list_many", coFloats);
    def->set_default_value(new ConfigOptionFloats{ 0.f, 280.f, 280.f, 0.f });
    def = this->add("list_mixed", coFloats);
    def->set_default_value(new ConfigOptionFloats{ 1.5, -2.f, 3 });
'''

failures = 0
def eq(label, got, want):
    global failures
    ok = got == want and [type(v) for v in [got]] == [type(v) for v in [want]]
    if not ok: failures += 1
    print(('ok  ' if ok else 'FAIL') + f' {label}' + ('' if ok else f'  got {got!r}, want {want!r}'))

options = _options_from_src(FIXTURE, {})
eq('0.f is 0', options['scalar_dot_f']['default'], 0.0)
eq('0.01f is 0.01', options['scalar_decimal_f']['default'], 0.01)
eq('{ 60.0f } is [60]', options['list_one']['default'], [60.0])
eq('{ 0.f, 280.f, 280.f, 0.f } is four numbers', options['list_many']['default'], [0.0, 280.0, 280.0, 0.0])
eq('plain, negative and integer items keep their values', options['list_mixed']['default'], [1.5, -2.0, 3])
eq('a string item is not split', _parse_list_items('"0x0", "f"', {}), ['0x0', 'f'])
eq('an identifier is kept', _parse_list_items('nvtStandard', {}), ['nvtStandard'])

if failures:
    print(f'{failures} FAILED'); sys.exit(1)
print('extractor default parsing passed')
