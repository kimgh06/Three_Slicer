"""The extractor's C++ default parsing, on a fixture instead of upstream's PrintConfig.cpp, so it runs without
slicers/. Run: python3 web/test_extract_all.py

A C++ float literal is one number: `280.f` was once split into [280, "f"], which broke six schema defaults, among
them flush_volumes_matrix, and every template-path tool change purged nothing."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_all import _cpp_unescape, _unquote, _options_from_src, _parse_list_items, extract_ui_tree, drop_unknown_options

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

TAB_FIXTURE = '''
void TabFilament::build()
{
    auto page = add_options_page(L("Filament"), "icon");
    auto optgroup = page->new_optgroup(L("Print temperature"), L"param");
    Line line = { L("Nozzle"), L("Nozzle temperature when printing") };
    line.append_option(optgroup->get_option("nozzle_temperature_initial_layer", 0));
    line.append_option(optgroup->get_option("nozzle_temperature", 0));
    optgroup->append_line(line);
    optgroup = page->new_optgroup(L("Chamber"), L"param");
    line = { L("Chamber temperature"), L("Target") };
    Option target = optgroup->get_option("chamber_temperature");
    target.opt.label = L("Target");
    line.append_option(target);
    optgroup->append_line(line);
    optgroup = page->new_optgroup(L("Start"), L"param");
    Option option = optgroup->get_option("filament_start_gcode");
    option.opt.height = 150;
    optgroup->append_single_option_line(option);
    optgroup = page->new_optgroup(L("Corrections"));
    line = Line{ m_config->def()->get("material_correction")->full_label, "" };
    for (auto& axis : { "X", "Y", "Z" }) {
        auto opt = optgroup->get_option(std::string("material_correction_") + char(std::tolower(axis[0])));
        opt.opt.label = axis;
        line.append_option(opt);
    }
    optgroup->append_line(line);
    line = Line{ "", "" };
    line.widget = [this](wxWindow* parent) { return description_line_widget(parent, &m_description); };
    optgroup->append_line(line);
    optgroup = page->new_optgroup(L("Custom"));
    optgroup->append_line(make_custom_line());
}
'''

options = _options_from_src(FIXTURE, {})
eq('0.f is 0', options['scalar_dot_f']['default'], 0.0)
eq('0.01f is 0.01', options['scalar_decimal_f']['default'], 0.01)
eq('{ 60.0f } is [60]', options['list_one']['default'], [60.0])
eq('{ 0.f, 280.f, 280.f, 0.f } is four numbers', options['list_many']['default'], [0.0, 280.0, 280.0, 0.0])
eq('plain, negative and integer items keep their values', options['list_mixed']['default'], [1.5, -2.0, 3])
eq('a string item is not split', _parse_list_items('"0x0", "f"', {}), ['0x0', 'f'])
eq('an identifier is kept', _parse_list_items('nvtStandard', {}), ['nvtStandard'])

eq('a unicode escape in a unit', _unquote('L(u8"\\u2103" /* C */)'), '℃')
eq('a newline in a list default', _parse_list_items('"0,0,0\\n0,0,0"', {}), ['0,0,0\n0,0,0'])
eq('an escaped backslash stays one', _cpp_unescape('a\\\\nb'), 'a\\nb')

groups = extract_ui_tree(TAB_FIXTURE)['TabFilament::build'][0]['groups']
eq('a composite row lists its options', groups[0]['options'], ['nozzle_temperature_initial_layer', 'nozzle_temperature'])
eq('and keeps its title beside them', groups[0]['line_titles'], {'nozzle_temperature_initial_layer': 'Nozzle', 'nozzle_temperature': 'Nozzle'})
eq('an option variable in a composite row', groups[1]['options'], ['chamber_temperature'])
eq('an option variable in a single line', groups[2]['options'], ['filament_start_gcode'])
eq('an axis loop, and no row for a description', groups[3]['options'], ['material_correction_x', 'material_correction_y', 'material_correction_z'])
eq('an unknown row stays a placeholder', groups[4]['options'][0].startswith('<custom-widget'), True)
tree = {'b': [{'groups': [{'options': ['known', 'unknown', '<custom-widget line:1>']}]}]}
drop_unknown_options(tree, {'known': {}})
eq('a key the schema lacks is dropped', tree['b'][0]['groups'][0]['options'], ['known', '<custom-widget line:1>'])

if failures:
    print(f'{failures} FAILED'); sys.exit(1)
print('extractor default parsing passed')
