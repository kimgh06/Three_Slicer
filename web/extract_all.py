#!/usr/bin/env python3
"""Extractor for the OrcaSlicer reverse-engineering artifacts.
Output: packages/data/{ui-tree,config-schema,invalidation-map,toggle-rules,preset-keys}.json + printers.json/processes.js/filaments.js
Upstream sources live in slicers/slicer/; paths are derived from __file__ (no hardcoded absolute paths).
"""
import re, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))   # .../<repo>/web
REPO = os.path.dirname(HERE)                          # repository root
SRC  = os.path.join(REPO, 'slicers', 'slicer')                   # upstream OrcaSlicer sources (moved in stage 33)
OUT  = os.path.join(REPO, 'packages', 'data')         # stage 33 phase 3: generated JSON goes into the @three-slicer/data package
os.makedirs(OUT, exist_ok=True)

def read(p):
    return open(os.path.join(SRC, p), encoding='utf-8', errors='replace').read()

# PrusaSlicer checkout — the SLA (resin) reference. Orca dropped the SLA pipeline, so the resin option
#  definitions and the resin tabs can only come from here. The pass is optional: without the checkout the
#  committed artifacts simply keep whatever SLA entries they already carry.
PRUSA = os.path.join(REPO, 'slicers', 'PrusaSlicer')

def read_prusa(p):
    return open(os.path.join(PRUSA, p), encoding='utf-8', errors='replace').read()

# ---------------------------------------------------------------- ui-tree
def extract_ui_tree(src=None, implicit_pages=False):
    # implicit_pages: PrusaSlicer's TabSLAPrint::build_sla_support_params builds groups onto a page it receives
    #  as an argument, so there is no add_options_page call to open one — a synthesized unnamed page keeps those
    #  groups instead of dropping them. Off for the Orca pass, so its output stays byte-identical.
    if src is None:
        src = read('src/slic3r/GUI/Tab.cpp')
    lines = src.split('\n')
    # Function boundaries: every Tab-family member function
    funcs = []  # (name, start_line_idx)
    for i, l in enumerate(lines):
        m = re.match(r'(?:void|PageShp|bool)\s+(Tab\w*)::(\w+)\(', l)
        if m:
            funcs.append((f'{m.group(1)}::{m.group(2)}', i))
    result = {}
    for fi, (fname, start) in enumerate(funcs):
        end = funcs[fi + 1][1] if fi + 1 < len(funcs) else len(lines)
        body = '\n'.join(lines[start:end])
        # Upstream builds some groups from local string vectors instead of literal calls
        #  (Tab.cpp build_kinematics_page: `for (const auto &axis : axes) append_option_line(optgroup, "machine_max_acceleration_" + axis)`).
        #  Resolve the vectors and the loop variables bound to them so those options are recovered instead of coming out as empty groups.
        vectors = {name: re.findall(r'"([^"]+)"', items)
                   for name, items in re.findall(r'const\s+std::vector<std::string>\s+(\w+)\s*\{([^}]*)\}', body, re.S)}
        loop_vars = {var: vec for var, vec in re.findall(r'for\s*\(\s*const\s+(?:std::string|auto)\s*&\s*(\w+)\s*:\s*(\w+)\s*\)', body)
                     if vec in vectors}
        def expand(expr):
            """`"lit"` / `"prefix_" + var` / `var` -> the list of option keys it appends."""
            m = re.match(r'"([^"]*)"\s*$', expr)
            if m: return [m.group(1)]
            m = re.match(r'"([^"]*)"\s*\+\s*(\w+)\s*$', expr)
            if m and m.group(2) in loop_vars: return [m.group(1) + v for v in vectors[loop_vars[m.group(2)]]]
            if expr in loop_vars: return vectors[loop_vars[expr]]
            return []
        pages = []
        cur_page = cur_group = None
        for ln in range(start, end):
            l = lines[ln]
            if l.lstrip().startswith('//'): continue      # commented-out groups/options are not part of the UI
            m = re.search(r'add_options_page\(L\("([^"]+)"\)(?:,\s*"([^"]*)")?', l)
            if m:
                cur_page = {'page': m.group(1), 'icon': m.group(2) or '', 'line': ln + 1, 'groups': []}
                pages.append(cur_page); cur_group = None; continue
            m = re.search(r'new_optgroup\(L\("([^"]*)"\)', l)
            if m:
                if cur_page is None:
                    if not implicit_pages: continue
                    cur_page = {'page': '', 'icon': '', 'line': ln + 1, 'groups': []}
                    pages.append(cur_page)
                cur_group = {'group': m.group(1), 'line': ln + 1, 'options': []}
                cur_page['groups'].append(cur_group); continue
            m = re.search(r'append_single_option_line\("([^"]+)"(?:\s*,\s*"([^"]*)")?', l)
            if m and cur_group is not None:
                cur_group['options'].append(m.group(1)); continue
            # PrusaSlicer's SLA support page appends one line holding an option per prefix column
            #  (add_options_into_line(optgroup, prefixes, "key")); the plain spelling names the line.
            m = re.search(r'add_options_into_line\(\s*optgroup\s*,\s*\w+\s*,\s*"([^"]+)"', l)
            if m and cur_group is not None:
                cur_group['options'].append(m.group(1)); continue
            # Free helper `append_option_line(optgroup, <expr>, ...)` — the key is the 2nd argument and may be built from a loop variable
            m = re.search(r'append_option_line\(\s*optgroup\s*,\s*([^,)]+?)\s*[,)]', l)
            if m and cur_group is not None:
                cur_group['options'].extend(expand(m.group(1).strip())); continue
            # optgroup->append_line(...) custom widgets / via an Option object
            if cur_group is not None and re.search(r'optgroup->append_line\(', l) \
               and 'append_single_option_line' not in l:
                mm = re.search(r'get_option\("([^"]+)"\)', l)
                cur_group['options'].append(mm.group(1) if mm else '<custom-widget line:%d>' % (ln + 1))
        # Rows appended by a local lambda driven by an inline brace list (the filament "Setting Overrides" page,
        #  Tab.cpp ~4035, is the only one): the scanner above sees just the lambda's append_line, so the group came
        #  out holding a placeholder instead of its 17 override keys. Attach the list to the last group opened
        #  before the loop, which is the one the lambda captures.
        for m in re.finditer(r'for\s*\(\s*const\s+std::string\s+\w+\s*:\s*\{(.*?)\}\s*\)', body, re.S):
            keys = re.findall(r'"([a-z0-9_]+)"', re.sub(r'//[^\n]*', '', m.group(1)))
            loop_line = start + body.count('\n', 0, m.start()) + 1
            target = None
            for page in pages:
                for group in page['groups']:
                    if group['line'] <= loop_line: target = group
            if not keys or target is None: continue
            target['options'] = [o for o in target['options'] if not o.startswith('<custom-widget')] + keys
        if pages:
            result[fname] = pages
    return result

# ---------------------------------------------------------------- config-schema
def _unquote(expr):
    """L("a" "b") / "a" -> a Python string. Adjacent literals are concatenated."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', expr)
    if not parts:
        return None
    s = ''.join(parts)
    return s.replace('\\"', '"').replace('\\n', '\n').replace('\\\\', '\\')

def _parse_macros():
    """The #define constant table from PrintConfigConstants.hpp."""
    out = {}
    try:
        for m in re.finditer(r'#define\s+(\w+)\s+([\w.\-]+)', read('src/libslic3r/PrintConfigConstants.hpp')):
            v = m.group(2)
            if v == 'true': out[m.group(1)] = True
            elif v == 'false': out[m.group(1)] = False
            else:
                try: out[m.group(1)] = float(v) if '.' in v else int(v)
                except ValueError: pass
    except FileNotFoundError:
        pass
    return out

def _parse_enum_maps(src):
    """s_keys_map_<Enum> { {"key", cppIdent}, ... }
    Entry values look like `spAligned` / `Enum::Ident` / `int(Enum::Ident)` -> matched on the last identifier."""
    ident2key, enum_keys, per_enum = {}, {}, {}
    for m in re.finditer(r'static (?:const )?t_config_enum_values s_keys_map_(\w+)\s*=?\s*\{(.*?)\n\};', src, re.S):
        name, body = m.group(1), m.group(2)
        keys, scoped = [], {}
        for e in re.finditer(r'\{\s*"([^"]+)"\s*,\s*[^,}]*?(\w+)\s*\)?\s*\}', body):
            keys.append(e.group(1))
            ident2key[e.group(2)] = e.group(1)
            scoped[e.group(2)] = e.group(1)
        enum_keys[name] = keys
        per_enum[name] = scoped
    return ident2key, enum_keys, per_enum

def _parse_list_items(raw, macros):
    """Inside a brace list -> a Python value list. Items that cannot be parsed keep their source text."""
    items = []
    pat = (r'"((?:[^"\\]|\\.)*)"'                                        # 1: string
           r'|FloatOrPercent\(\s*([0-9.\-]+)\s*,\s*(true|false)\s*\)'    # 2,3: FloatOrPercent
           r'|Vec2d\(\s*([0-9.\-]+)\s*,\s*([0-9.\-]+)\s*\)'              # 4,5: coordinates
           r'|([A-Za-z_][\w.]*|[0-9.\-]+)')                              # 6: identifier/number
    for m in re.finditer(pat, raw):
        s, fov, fob, vx, vy, ident = m.groups()
        if s is not None:
            items.append(s)
        elif fov is not None:
            items.append(fov + ('%' if fob == 'true' else ''))
        elif vx is not None:
            items.append([float(vx), float(vy)])
        elif ident is not None:
            if ident in ('true', 'false'): items.append(ident == 'true')
            elif ident in macros: items.append(macros[ident])
            else:
                try: items.append(float(ident) if '.' in ident else int(ident))
                except ValueError: items.append(ident)
    return items

def extract_schema():
    src = read('src/libslic3r/PrintConfig.cpp')
    options = _options_from_src(src, _parse_macros())
    options.update(_parse_axis_limits(src))
    options.update(_parse_filament_overrides(src, options))
    return options

# The `def = this->add("key", coType)` statement grammar. The SLA pass widens it: PrusaSlicer registers the
#  support options through a prefix argument (one plain and one 'branching' spelling per option) and a few tilt
#  options through add_nullable.
ADD_RE = r'(?:auto (?P<name>\w+) = )?def ?= ?this->add\(\s*"(?P<key>[^"]+)"\s*,\s*(?P<ctype>co\w+)\s*\)'
SLA_ADD_RE = r'(?:auto (?P<name>\w+) = )?def ?= ?this->add(?:_nullable)?\(\s*(?P<prefix>prefix \+ )?"(?P<key>[^"]+)"\s*,\s*(?P<ctype>co\w+)\s*\)'
FUNC_RE = r'void\s+(?:\w+)ConfigDef::(\w+)\(\)'
SLA_FUNC_RE = r'void\s+(?:\w+)ConfigDef::(\w+)\([^)]*\)'

def _options_from_src(src, macros, add_re=ADD_RE, func_re=FUNC_RE):
    ident2key, enum_keys_maps, per_enum_maps = _parse_enum_maps(src)
    # Comment stripping happens in the tokenizer, which recognizes strings (protecting https:// inside tooltips)
    # Offset map used to track which function (init_common_params, …) a statement belongs to
    func_marks = [(m.start(), m.group(1) or 'ctor') for m in
                  re.finditer(func_re, src)]
    def func_of(pos):
        name = 'unknown'
        for p, n in func_marks:
            if p <= pos: name = n
            else: break
        return name
    line_of = lambda pos: src.count('\n', 0, pos) + 1

    stmts = []  # (pos, stmt_text)
    buf, depth, start, i, n = [], 0, 0, 0, len(src)
    while i < n:
        c = src[i]
        if c == '"':                              # consume the whole string literal
            buf.append(c); i += 1
            while i < n:
                if src[i] == '\\': buf.append(src[i:i+2]); i += 2; continue
                buf.append(src[i]); i += 1
                if src[i-1] == '"': break
            continue
        if c == "'":                              # character literal
            j = i + 1
            while j < n and src[j] != "'":
                if src[j] == '\\': j += 1
                j += 1
            buf.append(src[i:j+1]); i = j + 1; continue
        if c == '#' and (i == 0 or src[i-1] == '\n'):  # preprocessor lines are excluded from statements
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '/':
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if c == '/' and i + 1 < n and src[i+1] == '*':
            j = src.find('*/', i + 2); i = n if j < 0 else j + 2; continue
        if c in '([': depth += 1                  # braces are ignored: the point is to split statements inside a function body
        elif c in ')]': depth -= 1
        elif c == ';' and depth <= 0:
            stmts.append((start, ''.join(buf).strip())); buf = []; i += 1; start = i
            continue
        buf.append(c); i += 1

    options = {}
    named_defs = {}   # tracks auto def_x = def;
    cur = None
    STR_FIELDS = ['label', 'full_label', 'category', 'tooltip', 'sidetext', 'cli',
                  'cli_params', 'ratio_over', 'gui_flags', 'plugin_type']
    NUM_FIELDS = ['min', 'max', 'max_literal', 'height', 'width']
    BOOL_FIELDS = ['multiline', 'full_width', 'is_code', 'readonly', 'nullable']
    for pos, st in stmts:
        st_flat = ' '.join(st.split()).lstrip('{} ')  # drop leftover opening/closing braces of a block
        m = re.match(add_re, st_flat)
        if m:
            key, ctype = m.group('key'), m.group('ctype')
            # With no mode given, the C++ default is comSimple (Config.hpp ConfigOptionDef)
            cur = {'type': ctype, 'mode': 'simple', 'defined_in': func_of(pos), 'line': line_of(pos)}
            if m.groupdict().get('prefix'):     # registered under a prefix argument -> both spellings exist
                cur['prefixed'] = True
            options[key] = cur
            if m.group('name'):                 # auto def_x = def = this->add(...)
                named_defs[m.group('name')] = cur
            continue
        if cur is None:
            continue
        m = re.match(r'auto (\w+) = def$', st_flat)
        if m:
            named_defs[m.group(1)] = cur
            continue
        m = re.match(r'def->(\w+) = (.*)$', st_flat, re.S)
        if m:
            field, val = m.group(1), m.group(2).strip()
            if field in STR_FIELDS:
                cur[field] = _unquote(val) if '"' in val else val
            elif field in NUM_FIELDS:
                try: cur[field] = float(val) if '.' in val else int(val)
                except ValueError: cur[field] = val
            elif field in BOOL_FIELDS:
                cur[field] = (val == 'true')
            elif field == 'mode':
                cur['mode'] = val.replace('com', '').lower()
            elif field == 'gui_type':
                cur['gui_type'] = val.split('::')[-1]
            elif field in ('enum_values', 'enum_labels'):
                if val.startswith('{'):          # brace literal list
                    cur[field] = re.findall(r'"((?:[^"\\]|\\.)*)"', val)
                else:
                    mm = re.match(r'(\w+)->enum_(?:values|labels)$', val)
                    if mm and mm.group(1) in named_defs:
                        cur[field] = list(named_defs[mm.group(1)].get(field, []))
                        cur[field + '_copied_from'] = mm.group(1)
            elif field == 'enum_keys_map':
                mm = re.search(r'ConfigOptionEnum<(\w+)>|s_keys_map_(\w+)', val)
                cur['enum_type'] = (mm.group(1) or mm.group(2)) if mm else val
            elif field in ('aliases', 'shortcut'):
                cur[field] = re.findall(r'"([^"]+)"', val)
            continue
        m = re.match(r'def->enum_(values|labels)\.(?:push_back|emplace_back)\((.*)\)$', st_flat, re.S)
        if m:
            cur.setdefault('enum_' + m.group(1), []).append(_unquote(m.group(2)) or m.group(2))
            continue
        m = re.match(r'def->set_default_value\(\s*new ConfigOptionEnum<(\w+)>\s*\(\s*(?:\w+::)?(\w+)\s*\)\s*\)$', st_flat)
        if m:                                     # enum default: cpp identifier -> serialization key
            cur['default_type'] = 'Enum<%s>' % m.group(1)
            cur['default_raw'] = m.group(2)
            scoped = per_enum_maps.get(m.group(1), {})   # per-enum scope wins (avoids identifier collisions)
            key = scoped.get(m.group(2), ident2key.get(m.group(2)))
            if key is not None:
                cur['default'] = key
            continue
        m = re.match(r'def->set_default_value\(\s*new ConfigOption(\w+)\s*[\({](.*)[\)}]\s*\)$', st_flat, re.S)
        if m:
            t, raw = m.group(1), m.group(2).strip()
            cur['default_type'] = t
            cur['default_raw'] = raw
            base = t[:-8] if t.endswith('Nullable') else t   # FloatsNullable → Floats
            if base in ('Float', 'Int', 'Percent'):
                v = macros.get(raw)
                if v is None:
                    lit = raw.rstrip('fF')          # 1.f → 1.
                    try: v = float(lit) if '.' in lit else int(lit)
                    except ValueError: v = None
                if v is not None: cur['default'] = v
            elif base == 'Bool':
                if raw in ('true', 'false'): cur['default'] = (raw == 'true')
                elif raw in ('0', '1'): cur['default'] = (raw == '1')
                elif isinstance(macros.get(raw), bool): cur['default'] = macros[raw]
            elif base == 'Point':
                mm = re.match(r'Vec2d\(\s*([0-9.\-]+)\s*,\s*([0-9.\-]+)\s*\)$', raw)
                if mm: cur['default'] = [float(mm.group(1)), float(mm.group(2))]
            elif base == 'EnumsGeneric':               # vector enum (per-extruder)
                idents = re.findall(r'\w+', raw)
                key = next((ident2key[i] for i in reversed(idents) if i in ident2key), None)
                if key is not None: cur['default'] = [key]
            elif base == 'String':
                cur['default'] = _unquote(raw) if '"' in raw else ''
            elif base == 'FloatOrPercent':
                mm = re.match(r'([0-9.\-]+)\s*,\s*(true|false)', raw)
                if mm: cur['default'] = mm.group(1) + ('%' if mm.group(2) == 'true' else '')
            elif base in ('Floats', 'Ints', 'Percents', 'Bools', 'Strings',
                          'FloatsOrPercents', 'Points'):
                cur['default'] = _parse_list_items(raw, macros)
            continue
    # Options that have enum_keys_map but no enum_values: filled in from the s_keys_map_* tables
    for o in options.values():
        et = o.get('enum_type')
        if et and et in enum_keys_maps and not o.get('enum_values'):
            o['enum_values'] = list(enum_keys_maps[et])
            o['enum_values_from'] = 'keys_map'
    return options

# ---------------------------------------------------------------- SLA pass (PrusaSlicer sources)
def extract_sla_schema():
    """PrusaSlicer's resin option definitions (init_sla_params / init_sla_support_params / init_sla_tilt_params).
    Only these functions are taken — the FFF half of that file is Orca's job. A prefixed option is emitted under
    both its plain and its 'branching' spelling, mirroring the two init_sla_support_params registrations."""
    try:
        src = read_prusa('src/libslic3r/PrintConfig.cpp')
    except FileNotFoundError:
        return {}
    opts = _options_from_src(src, {}, add_re=SLA_ADD_RE, func_re=SLA_FUNC_RE)
    sla_funcs = {'init_sla_params', 'init_sla_support_params', 'init_sla_tilt_params'}
    out = {}
    for key, o in opts.items():
        if o.get('defined_in') not in sla_funcs:
            continue
        if o.pop('prefixed', False):
            out[key] = o
            out['branching' + key] = dict(o)
        else:
            out[key] = o
    return out

def extract_sla_ui():
    """PrusaSlicer's resin tabs, under upstream's own builder names — the same keying the Orca tree uses, which is
    what lets a settings panel pick builders by printer technology. The support-parameter groups live in a helper
    that receives its page as an argument; they are spliced back into the Supports page the way upstream calls it."""
    try:
        src = read_prusa('src/slic3r/GUI/Tab.cpp')
    except FileNotFoundError:
        return {}
    tree = extract_ui_tree(src, implicit_pages=True)
    support_params = tree.get('TabSLAPrint::build_sla_support_params')
    main = tree.get('TabSLAPrint::build')
    if main and support_params:
        target = next((p for p in main if p['page'] == 'Supports'), None)
        if target:
            target['groups'].extend(g for p in support_params for g in p['groups'])
    keep = ('TabSLAPrint::build', 'TabSLAMaterial::build', 'TabPrinter::build_sla')
    return {k: v for k, v in tree.items() if k in keep and v}

def _parse_filament_overrides(src, options):
    """The `filament_*` retraction overrides (PrintConfig.cpp ~7864) are generated by a loop over
    filament_extruder_override_keys that clones the machine option of the same name, so the statement scanner
    never sees them — which left the TabFilament overrides page referring to 18 keys the schema did not define.
    Upstream registers them with add_nullable: no default of their own, because an unset override means
    "keep the printer's value". That is exactly what an absent default gives here, so none is emitted."""
    m = re.search(r'filament_extruder_override_keys\s*=\s*\{(.*?)\n\s*\};', src, re.S)
    if not m: return {}
    # comSimple for the four upstream promotes out of the machine tab's develop mode, comAdvanced otherwise
    simple = {'filament_retraction_length', 'filament_z_hop',
              'filament_long_retractions_when_cut', 'filament_retraction_distances_when_cut'}
    out = {}
    for key in re.findall(r'"([a-z0-9_]+)"', m.group(1)):
        base = options.get(key[len('filament_'):])
        if not base: continue                     # the machine option is missing -> nothing to clone
        clone = {k: v for k, v in base.items()
                 if k in ('type', 'label', 'full_label', 'tooltip', 'sidetext', 'enum_values', 'enum_labels',
                          'enum_type', 'enum_values_from', 'min', 'max')}
        clone['mode'] = 'simple' if key in simple else 'advanced'
        clone['nullable'] = True
        out[key] = clone
    return out

def _parse_axis_limits(src):
    """The machine limits (machine_max_{speed,acceleration,jerk}_{x,y,z,e}) are generated by a loop over an
    AxisDefault table (PrintConfig.cpp ~4890), so the statement scanner above never sees them. Parsing them here
    keeps the labels, units, modes and per-axis defaults coming from the source instead of being spelled out."""
    m = re.search(r'std::vector<AxisDefault>\s+axes\s*\{(.*?)\n\s*\};', src, re.S)
    if not m: return {}
    # { "x", { 500., 200. }, { 1000., 1000. }, { 10., 10. } }  ->  x: [feedrate[], acceleration[], jerk[]]
    axis_defaults = {}
    for row in re.finditer(r'\{\s*"(\w+)"\s*,\s*(\{[^{}]*\})\s*,\s*(\{[^{}]*\})\s*,\s*(\{[^{}]*\})\s*\}', m.group(1)):
        axis_defaults[row.group(1)] = [[float(v) for v in re.findall(r'-?[\d.]+', g)] for g in row.groups()[1:]]
    if not axis_defaults: return {}
    # The loop body that follows the table: one `def = this->add("<family>" + axis.name, ...)` block per limit family
    body = src[m.end():]
    body = body[:body.find('\n    }\n')] if '\n    }\n' in body else body[:8000]
    # `axis.max_feedrate` is the 1st table column, `max_acceleration` the 2nd, `max_jerk` the 3rd
    COLUMN = {'max_feedrate': 0, 'max_acceleration': 1, 'max_jerk': 2}
    out = {}
    blocks = re.split(r'def\s*=\s*this->add\(\s*"([^"]+)"\s*\+\s*axis\.name\s*,\s*(co\w+)\s*\)', body)
    for i in range(1, len(blocks) - 1, 3):
        prefix, ctype, chunk = blocks[i], blocks[i + 1], blocks[i + 2]
        fields = dict(re.findall(r'def->(\w+)\s*=\s*(.+?);', chunk))
        col = next((c for f, c in COLUMN.items() if f in fields.get('set_default_value', '')
                    or ('axis.' + f) in chunk.split('set_default_value')[-1][:80]), None)
        for axis, defaults in axis_defaults.items():
            opt = {'type': ctype, 'mode': 'simple', 'defined_in': 'init_fff_params',
                   'generated_by_loop': 'PrintConfig.cpp AxisDefault loop'}
            for field, raw in fields.items():
                if field in ('full_label', 'tooltip'):
                    fmt = _unquote(raw)
                    if fmt: opt[field] = fmt.replace('%1%', axis.upper())
                elif field in ('category', 'sidetext'): opt[field] = _unquote(raw)
                elif field == 'min':
                    try: opt['min'] = float(raw) if '.' in raw else int(raw)
                    except ValueError: pass
                elif field == 'mode': opt['mode'] = raw.replace('com', '').lower()
                elif field == 'readonly': opt['readonly'] = (raw == 'true')
            if col is not None: opt['default'] = defaults[col]
            out[prefix + axis] = opt
    return out

# ---------------------------------------------------------------- printers
# Per-printer settings from resources/profiles/<Vendor>/machine/*.json. The profiles carry ~62 keys each;
# only what the kernel actually consumes is kept, because an extracted key the kernel ignores is dead weight
# in every consumer's bundle. Add a key here the moment the kernel starts reading it.
PRINTER_KEYS = [
    # Motion limits — drive the print time estimate
    'machine_max_speed_x', 'machine_max_speed_y', 'machine_max_speed_z', 'machine_max_speed_e',
    'machine_max_acceleration_x', 'machine_max_acceleration_y', 'machine_max_acceleration_z', 'machine_max_acceleration_e',
    'machine_max_acceleration_extruding', 'machine_max_acceleration_retracting', 'machine_max_acceleration_travel',
    'machine_max_jerk_x', 'machine_max_jerk_y', 'machine_max_jerk_z', 'machine_max_jerk_e',
    'machine_max_junction_deviation',
    # NB: default_acceleration / travel_acceleration / *_wall_acceleration are deliberately NOT here. They are the
    #  accelerations the printer is actually driven at, which upstream keeps in the process profile (1355 of them
    #  set it, against 28 machine profiles). Claiming them here would let a printer pick block a quality preset.
    # Geometry / hardware — the bed and nozzle the viewer draws and the kernel slices against
    'printable_area', 'printable_height', 'nozzle_diameter', 'z_hop', 'extruder_offset',
    # NB: machine_start_gcode / machine_end_gcode are deliberately absent. 256 of the 264 distinct vendor pairs are
    #  templates ("M140 S[bed_temperature_initial_layer]", "{if max_layer_z < printable_height}…"), and the kernel has
    #  no PlaceholderParser to expand them — emitting them verbatim produces invalid G-code. The kernel accepts both
    #  options, so a host can still supply literal G-code; wiring the vendor profiles needs the parser first.
]

def _coerce(value, ctype):
    """Profile JSON stores everything as strings ("220x0", "500"); the schema (and therefore the settings
    map the panel edits) wants the option's real type. Coercing by ctype keeps this key-agnostic."""
    def num(tok):
        try: return float(tok) if ('.' in str(tok) or 'e' in str(tok).lower()) else int(tok)
        except (TypeError, ValueError): return tok
    if ctype == 'coPoints':          # ["0x0","220x0"] -> [[0,0],[220,0]]
        pts = []
        for tok in (value if isinstance(value, list) else [value]):
            parts = str(tok).split('x')
            if len(parts) == 2: pts.append([num(parts[0]), num(parts[1])])
        return pts or None
    if ctype in ('coFloat', 'coInt', 'coPercent'):
        return num(value[0] if isinstance(value, list) and value else value)
    if ctype in ('coFloats', 'coInts', 'coPercents'):
        # Upstream repeats these per machine mode (normal/silent/…); the kernel has no silent mode and both
        # the panel and settingScalar only ever read [0], so keep one entry instead of four identical-ish ones.
        seq = value if isinstance(value, list) else [value]
        return [num(seq[0])] if seq else None
    if ctype in ('coBool', 'coBools'):
        first = value[0] if isinstance(value, list) and value else value
        return str(first) in ('1', 'true', 'True')
    return value                      # strings / enums pass through unchanged

def _kernel_keys(schema):
    """The option keys the kernel actually consumes: the list gen_kernel_params.mjs PROBES out of
    deriveKernelParams, one schema key at a time. It used to be a regex over engine/src/settings.js, which
    silently shrank to 3 keys when the mapping moved into viewer-package — and a comment quoting a key widened it.
    Missing or empty is an error, never an empty preset set: both callers write whatever this returns."""
    path = os.path.join(REPO, 'viewer-package', 'src', 'settings', 'kernel_setting_keys.js')
    with open(path, encoding='utf-8') as fh:
        keys = sorted({k for k in re.findall(r'"([a-z0-9_]+)"', fh.read()) if k in schema})
    if not keys:
        raise SystemExit(f'{path} lists no schema keys; run node packages/types/gen_kernel_params.mjs first')
    return keys

def extract_processes(schema):
    """Print (process) presets — where the print-side accelerations and speeds live. Joined to printers by the
    profile's own `compatible_printers` list, which names machine profiles exactly as printers.json keys them."""
    root = os.path.join(SRC, 'resources', 'profiles')
    kernel_keys = _kernel_keys(schema)
    if not os.path.isdir(root) or not kernel_keys: return {'keys': [], 'sets': [], 'presets': [], 'byPrinter': {}}
    profiles = {}
    for vendor in sorted(os.listdir(root)):
        pdir = os.path.join(root, vendor, 'process')
        if not os.path.isdir(pdir): continue
        for fn in sorted(os.listdir(pdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(pdir, fn), encoding='utf-8') as fh: prof = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof

    def resolve(vendor, prof, depth=0):
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, depth + 1))
        for key in kernel_keys:
            raw = prof.get(key)
            if raw is None: continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    entries = []
    for (vendor, name), prof in sorted(profiles.items()):
        compat = prof.get('compatible_printers')
        if not compat: continue                       # abstract parents carry no printer list
        vals = resolve(vendor, prof)
        if not vals: continue
        entries.append((name, vals, compat))

    # Only the kernel keys some process preset actually sets. The kernel key list also covers the filament-owned
    #  options (nozzle_temperature, the fan keys, …), which no process profile touches — carrying them here as
    #  all-null columns would make a consumer clear the picked material's values on every quality change.
    keys = sorted({k for _n, vals, _c in entries for k in vals})

    # Same column layout as printers.json, and byPrinter holds preset indices: a preset name averages 30 chars
    #  and each is listed by every compatible printer, so spelling them out costs more than all the values.
    sets, index, names, seen_name, by_printer = [], {}, [], {}, {}
    for name, vals, compat in entries:
        row = [vals.get(k) for k in keys]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        if name not in seen_name:
            seen_name[name] = len(names); names.append([name, index[sig]])
        for printer in compat:
            by_printer.setdefault(printer, []).append(seen_name[name])
    return {'keys': keys, 'sets': sets, 'presets': names, 'byPrinter': by_printer}

# ---------------------------------------------------------------- filaments
def extract_filaments(schema):
    """Filament (material) presets. Same column layout and same `compatible_printers` join as the process presets,
    with three differences:
      - the profiles nest one folder deeper (<Vendor>/filament/<Brand>/*.json), so this walks instead of listdir;
      - `filament_type` / `filament_vendor` ride on the entry, so a picker can group by material without a second
        file. Both are declared on the abstract `@base` parent, hence the inherits walk;
      - `defaultsByModel` is the vendor's recommended material list, which upstream keeps on the machine_model
        (not on the filament and not on the nozzle-variant machine profile) — joined by printers.json's model field.
    Preset names are globally unique across vendors (verified: 6282 instantiable profiles, 0 collisions), so the
    name-keyed lookup the process presets use holds here too."""
    root = os.path.join(SRC, 'resources', 'profiles')
    kernel_keys = _kernel_keys(schema)
    empty = {'keys': [], 'sets': [], 'presets': [], 'byPrinter': {}, 'defaultsByModel': {}}
    if not os.path.isdir(root) or not kernel_keys: return empty

    profiles, model_materials = {}, {}
    for vendor in sorted(os.listdir(root)):
        for dirpath, _dirs, files in os.walk(os.path.join(root, vendor, 'filament')):
            for fn in sorted(files):
                if not fn.endswith('.json'): continue
                try:
                    with open(os.path.join(dirpath, fn), encoding='utf-8') as fh: prof = json.load(fh)
                except (ValueError, OSError): continue
                if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof
        mdir = os.path.join(root, vendor, 'machine')
        if not os.path.isdir(mdir): continue
        for fn in sorted(os.listdir(mdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(mdir, fn), encoding='utf-8') as fh: model = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(model, dict) and model.get('type') == 'machine_model' and model.get('default_materials'):
                model_materials[model.get('name', '')] = [m.strip() for m in model['default_materials'].split(';') if m.strip()]

    def resolve(vendor, prof, depth=0):
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, depth + 1))
        for key in kernel_keys:
            raw = prof.get(key)
            if raw is None: continue
            first = raw[0] if isinstance(raw, list) and raw else raw
            # "nil" on a nullable override means "keep the machine's value", and it has to clear what an
            #  ancestor set rather than be skipped — 51 profiles state nil over a parent that named a number.
            if str(first) == 'nil': out.pop(key, None); continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    def inherited(vendor, prof, key, depth=0):
        """Metadata (not a kernel key) from the nearest ancestor that declares it."""
        if key in prof: return prof[key]
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        return inherited(vendor, parent, key, depth + 1) if parent is not None else None

    def label(raw):     # filament_type/vendor are per-extruder arrays upstream; one material per preset here
        first = raw[0] if isinstance(raw, list) and raw else raw
        return first if isinstance(first, str) else ''

    # `instantiation:false` profiles are abstract parents that exist only to be inherited. A preset that sets none
    #  of the kernel keys is still kept: its name and material type are what the picker shows, and it dedupes into
    #  the one all-null row. As settings.js grows filament keys, those presets fill in with no change here.
    entries = []
    for (vendor, name), prof in sorted(profiles.items()):
        if str(prof.get('instantiation')) != 'true': continue
        compat = inherited(vendor, prof, 'compatible_printers')
        if not compat: continue                       # nothing to attach it to
        entries.append((name, resolve(vendor, prof),
                        label(inherited(vendor, prof, 'filament_type')),
                        label(inherited(vendor, prof, 'filament_vendor')), compat))

    # Only the kernel keys some filament actually sets: this list is what a consumer clears before applying a
    #  different material, so carrying process-owned keys here would wipe the print preset on every switch.
    keys = sorted({k for _n, vals, _t, _v, _c in entries for k in vals})

    sets, index, presets, seen_name, by_printer = [], {}, [], {}, {}
    for name, vals, ftype, fvendor, compat in entries:
        row = [vals.get(k) for k in keys]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        if name not in seen_name:
            seen_name[name] = len(presets); presets.append([name, index[sig], ftype, fvendor])
        for printer in compat:
            by_printer.setdefault(printer, []).append(seen_name[name])

    # Recommendations name presets that may not exist (typos, materials pulled from a newer profile set) — drop those
    #  rather than emit an index the consumer has to guard.
    defaults_by_model = {}
    for model, materials in sorted(model_materials.items()):
        idx = [seen_name[m] for m in materials if m in seen_name]
        if idx: defaults_by_model[model] = idx
    return {'keys': keys, 'sets': sets, 'presets': presets, 'byPrinter': by_printer, 'defaultsByModel': defaults_by_model}

def extract_printers(schema):
    root = os.path.join(SRC, 'resources', 'profiles')
    if not os.path.isdir(root): return {'keys': PRINTER_KEYS, 'sets': [], 'byVendor': {}}
    # Load every machine profile first: `inherits` points at a sibling profile by name and chains up to 5 deep
    profiles = {}   # (vendor, name) -> dict
    for vendor in sorted(os.listdir(root)):
        mdir = os.path.join(root, vendor, 'machine')
        if not os.path.isdir(mdir): continue
        for fn in sorted(os.listdir(mdir)):
            if not fn.endswith('.json'): continue
            try:
                with open(os.path.join(mdir, fn), encoding='utf-8') as fh: prof = json.load(fh)
            except (ValueError, OSError): continue
            if isinstance(prof, dict) and prof.get('name'): profiles[(vendor, prof['name'])] = prof

    def resolve(vendor, prof, keys, depth=0):
        """Flatten the inherits chain down to the given keys, in the schema's own representation."""
        out = {}
        parent = profiles.get((vendor, prof.get('inherits'))) if depth < 10 else None
        if parent is not None: out.update(resolve(vendor, parent, keys, depth + 1))
        for key in keys:
            raw = prof.get(key)
            if raw is None: continue
            val = _coerce(raw, (schema.get(key) or {}).get('type', ''))
            if val is not None: out[key] = val
        return out

    # Column layout: the key names are written once and each printer's values are a positional row.
    #  Repeating ~20 long key names per set costs several hundred KB — more than the values themselves.
    sets, index, by_vendor = [], {}, {}
    for (vendor, name), prof in sorted(profiles.items()):
        # Abstract "…_common" parents carry no printer_model/variant — they exist only to be inherited
        if not (prof.get('printer_model') or prof.get('printer_variant')): continue
        vals = resolve(vendor, prof, PRINTER_KEYS)
        if not vals: continue
        row = [vals.get(k) for k in PRINTER_KEYS]
        sig = json.dumps(row, sort_keys=True)
        if sig not in index:
            index[sig] = len(sets); sets.append(row)
        nozzle = vals.get('nozzle_diameter')
        nozzle = str(nozzle[0]) if isinstance(nozzle, list) and nozzle else ''
        # model = the profile name minus the nozzle suffix, so the UI can offer model and nozzle separately.
        # default_print_profile is the vendor's recommended process preset — profile metadata, not a setting,
        #  so it rides on the entry rather than in the value row.
        model = re.sub(r'\s+[\d.]+\s*nozzle$', '', name).strip()
        default_preset = prof.get('default_print_profile') or ''
        if not default_preset:      # only the concrete leaf carries it in some vendors; walk the chain
            cur, depth = prof, 0
            while cur is not None and depth < 10 and not default_preset:
                default_preset = cur.get('default_print_profile') or ''
                cur = profiles.get((vendor, cur.get('inherits'))); depth += 1
        by_vendor.setdefault(vendor, {})[name] = [nozzle, index[sig], model, default_preset]
    return {'keys': PRINTER_KEYS, 'sets': sets, 'byVendor': by_vendor}

# ---------------------------------------------------------------- SLA printers (PrusaSlicer vendor bundles)
# The keys an SLA machine sets on top of the shared geometry keys. Appended to printers.json `keys`; the FFF
#  rows stay short and every reader already skips missing tail cells.
SLA_PRINTER_KEYS = ['printer_technology', 'display_width', 'display_height', 'display_pixels_x', 'display_pixels_y',
    # The machine's default sla_print preset rides on the same row until a resin preset picker exists —
    #  upstream keeps these in the sla_print PRESET ('0.05 Normal'), not in the printer, and without them the
    #  support tree ran on the vestigial schema defaults (zigzag became dynamic, head necks a third the length).
    'layer_height', 'supports_enable', 'support_head_front_diameter', 'support_head_penetration',
    'support_head_width', 'support_pillar_diameter', 'support_pillar_connection_mode',
    'support_base_diameter', 'support_base_height', 'support_critical_angle', 'support_max_bridge_length',
    'support_object_elevation', 'support_points_density_relative', 'pad_enable',
    # The machine's default resin MATERIAL (printer_model default_materials) rides along the same way — the
    #  exposure family lives in the sla_material preset in upstream's layering.
    'exposure_time', 'initial_exposure_time', 'initial_layer_height', 'sla_material_settings_id']

def _parse_ini_sections(text):
    sections, cur = {}, None
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        if line.startswith('[') and line.endswith(']'):
            cur = {}; sections[line[1:-1]] = cur; continue
        if cur is None or '=' not in line: continue
        k, _, v = line.partition('=')
        cur[k.strip()] = v.strip()
    return sections

def extract_sla_printers(sch_ref):
    """PrusaSlicer's SLA vendor bundles (INI, inherits-chained) -> the column layout extract_printers builds.
    Orca ships no SLA machines at all, so this is the only source the resin printer picker can have."""
    base = os.path.join(PRUSA, 'resources', 'profiles')
    if not os.path.isdir(base): return None
    all_keys = PRINTER_KEYS + SLA_PRINTER_KEYS
    sets, index, by_vendor, tech_by_vendor, resins = [], {}, {}, {}, []
    for fname in sorted(os.listdir(base)):
        if not fname.endswith('.ini'): continue
        try: text = open(os.path.join(base, fname), encoding='utf-8', errors='replace').read()
        except OSError: continue
        if 'printer_technology = SLA' not in text: continue
        vendor = fname[:-4]
        sections = _parse_ini_sections(text)
        printers = {name.split(':', 1)[1]: kv for name, kv in sections.items() if name.startswith('printer:')}
        def resolve(name, depth=0):
            kv = printers.get(name)
            if kv is None or depth > 10: return {}
            out = {}
            for parent in [s.strip() for s in kv.get('inherits', '').split(';') if s.strip()]:
                out.update(resolve(parent, depth + 1))
            out.update({k: v for k, v in kv.items() if k != 'inherits'})
            return out
        sla_prints = {name.split(':', 1)[1]: kv for name, kv in sections.items() if name.startswith('sla_print:')}
        sla_models = {name.split(':', 1)[1]: kv for name, kv in sections.items() if name.startswith('printer_model:')}
        sla_mats = {name.split(':', 1)[1]: kv for name, kv in sections.items() if name.startswith('sla_material:')}
        def resolve_mat(name, depth=0):
            kv = sla_mats.get(name)
            if kv is None or depth > 10: return {}
            out = {}
            for parent in [s.strip() for s in kv.get('inherits', '').split(';') if s.strip()]:
                out.update(resolve_mat(parent, depth + 1))
            out.update({k: v for k, v in kv.items() if k != 'inherits'})
            return out
        # Material catalog for the picker: every concrete material, inherits flattened. The layer-height
        #  compatibility condition becomes a plain number so the card can filter without an expression engine.
        for name in sorted(sla_mats):
            if name.startswith('*'): continue
            m = resolve_mat(name)
            entry = {'name': name, 'bundle': vendor,
                     'type': m.get('material_type', ''), 'vendor': m.get('material_vendor', ''),
                     'colour': m.get('material_colour', '')}
            for key in ('exposure_time', 'initial_exposure_time', 'initial_layer_height'):
                try: entry[key] = float(m[key])
                except (KeyError, ValueError): pass
            lh_m = re.search(r'layer_height\s*==\s*([0-9.]+)', m.get('compatible_prints_condition', ''))
            if lh_m: entry['layerHeight'] = float(lh_m.group(1))
            resins.append(entry)
        def resolve_print(name, depth=0):
            kv = sla_prints.get(name)
            if kv is None or depth > 10: return {}
            out = {}
            for parent in [s.strip() for s in kv.get('inherits', '').split(';') if s.strip()]:
                out.update(resolve_print(parent, depth + 1))
            out.update({k: v for k, v in kv.items() if k != 'inherits'})
            return out
        for name in sorted(printers):
            if name.startswith('*'): continue
            vals = resolve(name)
            if vals.get('printer_technology') != 'SLA': continue
            # Merge the machine's default resin print preset (support/pad values) into the applied row.
            preset = resolve_print(vals.get('default_sla_print_profile', ''))
            for key, raw in preset.items():
                if key in SLA_PRINTER_KEYS and key not in vals:
                    vals[key] = raw
            # ...and the default MATERIAL's exposure family. The printer section's default_sla_material_profile
            #  is a stale pre-rename pointer in the current bundles — printer_model.default_materials is live.
            model_kv = sla_models.get(vals.get('printer_model', ''), {})
            default_mat = model_kv.get('default_materials', '') or vals.get('default_sla_material_profile', '')
            mat = resolve_mat(default_mat)
            if mat:
                vals.setdefault('sla_material_settings_id', default_mat)
                for key in ('exposure_time', 'initial_exposure_time', 'initial_layer_height'):
                    if key in mat and key not in vals:
                        vals[key] = mat[key]
            row_vals = {'printer_technology': 'SLA'}
            for key in SLA_PRINTER_KEYS[5:]:
                if key not in vals: continue
                coerced = _coerce(vals[key], (sch_ref.get(key) or {}).get('type', ''))
                if coerced is not None: row_vals[key] = coerced
            for key in ('display_width', 'display_height'):
                try: row_vals[key] = float(vals[key])
                except (KeyError, ValueError): pass
            for key in ('display_pixels_x', 'display_pixels_y'):
                try: row_vals[key] = int(float(vals[key]))
                except (KeyError, ValueError): pass
            try: row_vals['printable_height'] = float(vals['max_print_height'])
            except (KeyError, ValueError): pass
            if 'bed_shape' in vals:   # "0x0,120.96x0,…" -> [[x, y], …], the pair list every printable_area consumer indexes
                pts = []
                for entry in vals['bed_shape'].split(','):
                    xy = entry.split('x')
                    if len(xy) == 2:
                        try: pts.append([float(xy[0]), float(xy[1])])
                        except ValueError: pass
                if len(pts) >= 3: row_vals['printable_area'] = pts
            row = [row_vals.get(k) for k in all_keys]
            sig = json.dumps(row, sort_keys=True)
            if sig not in index:
                index[sig] = len(sets); sets.append(row)
            model = vals.get('printer_model', name)
            by_vendor.setdefault(vendor, {})[name] = ['', index[sig], model, vals.get('default_sla_print_profile', '')]
        if vendor in by_vendor: tech_by_vendor[vendor] = 'SLA'
    if not by_vendor: return None
    return {'keys': all_keys, 'sets': sets, 'byVendor': by_vendor, 'techByVendor': tech_by_vendor, 'resins': resins}

# ---------------------------------------------------------------- invalidation
def extract_invalidation():
    def parse(path, fn_sig):
        src = read(path)
        i = src.find(fn_sig)
        if i < 0:
            return None
        # Function body: from the first { to the balanced }
        j = src.find('{', i); depth = 0; k = j
        while k < len(src):
            if src[k] == '{': depth += 1
            elif src[k] == '}':
                depth -= 1
                if depth == 0: break
            k += 1
        body = src[j:k]
        base_line = src.count('\n', 0, i) + 1
        # if/else-if chains: the opt_key == "..." values in conditions + the ps*/pos* tokens inside the block
        branches = []
        for m in re.finditer(r'(?:else\s+)?if\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}', body):
            cond, blk = m.group(1), m.group(2)
            keys = re.findall(r'opt_key == "([^"]+)"', cond)
            if not keys:
                continue
            steps = sorted(set(re.findall(r'\b(ps[A-Z]\w+|pos[A-Z]\w+)\b', blk)))
            special = []
            if 'invalidate_all_steps' in blk: special.append('invalidate_all_steps')
            if 'm_force_update' in blk or 'osteps' in blk: pass
            branches.append({'keys': keys, 'steps': steps, 'special': special,
                             'line': base_line + body.count('\n', 0, m.start())})
        return branches
    return {
        'Print':  parse('src/libslic3r/Print.cpp',
                        'Print::invalidate_state_by_config_options'),
        'PrintObject': parse('src/libslic3r/PrintObject.cpp',
                        'PrintObject::invalidate_state_by_config_options'),
        'note': 'An opt_key absent from the conditions (the default branch) invalidates everything. steps are the step tokens referenced in the branch block.'
    }

# ---------------------------------------------------------------- toggle-rules
def _extract_toggles_from(src, func_pat, call_pat):
    funcs = [(m.group(1), src.count('\n', 0, m.start()) + 1, m.start())
             for m in re.finditer(func_pat, src)]
    out = {}
    for fi, (fname, fline, fpos) in enumerate(funcs):
        fend = funcs[fi + 1][2] if fi + 1 < len(funcs) else len(src)
        body = src[fpos:fend]
        base = fline
        rec = {'locals': {}, 'rules': []}
        # local bool variable = condition
        for m in re.finditer(r'\b(?:const\s+)?(?:bool|auto)\s+(\w+)\s*=\s*((?:[^;{]|\{[^}]*\})+);', body):
            if re.search(r'config->|opt_|have_|is_|==|!=|&&|\|\|', m.group(2)):
                rec['locals'][m.group(1)] = ' '.join(m.group(2).split())
        # for (auto el : {"a","b"}) ... toggle_xxx(el, cond)
        for m in re.finditer(r'for \(auto (?:const\s*&?\s*)?(\w+) : \{([^}]*)\}\)\s*(?:\{)?\s*' + call_pat + r'\(\s*\1\s*,\s*([^;]+?)\)\s*;', body):
            keys = re.findall(r'"([^"]+)"', m.group(2))
            rec['rules'].append({'fields': keys, 'enable_if': ' '.join(m.group(4).split()),
                                 'kind': m.group(3), 'line': base + body.count('\n', 0, m.start())})
        # single toggle_xxx("key", cond[, idx])
        for m in re.finditer(call_pat + r'\(\s*"([^"]+)"\s*,\s*((?:[^();]|\([^()]*\))+?)\)\s*;', body):
            rec['rules'].append({'fields': [m.group(2)], 'enable_if': ' '.join(m.group(3).split()),
                                 'kind': m.group(1), 'line': base + body.count('\n', 0, m.start())})
        # count of toggle calls that were not parsed (honesty)
        total = len(re.findall(call_pat + r'\(', body))
        covered = sum(len(r['fields']) if r['fields'] and r['fields'][0] != '<var>' else 1
                      for r in rec['rules'])
        rec['stats'] = {'toggle_calls_in_source': total, 'rules_extracted': len(rec['rules'])}
        if rec['rules'] or rec['locals']:
            out[fname] = rec
    return out

def extract_toggles():
    out = _extract_toggles_from(read('src/slic3r/GUI/ConfigManipulation.cpp'),
                                r'void\s+ConfigManipulation::(\w+)\(', r'toggle_(field|line)')
    tab = _extract_toggles_from(read('src/slic3r/GUI/Tab.cpp'),
                                r'void\s+(Tab\w*::toggle_options)\(', r'toggle_(option)')
    out.update(tab)
    return out

def extract_preset_keys(schema):
    """Which option keys belong to which preset type — upstream's own answer, not ours.

    printers.json carries the 21 columns the kernel reads, which is the right thing for a picker but far too
    few to WRITE a machine preset another slicer will accept: upstream's Preset::printer_options() is ~231 keys.
    The three lists are plain static initializers in Preset.cpp (plus the per-extruder set, which lives in
    PrintConfig.cpp because it is derived from the config def), so they extract the same way everything else here
    does. Reading them from the source rather than curating a list by hand is the point — a key upstream adds to a
    preset type shows up on the next extraction instead of being missing from an exported file forever.
    """
    preset = read('src/libslic3r/Preset.cpp')
    config = read('src/libslic3r/PrintConfig.cpp')

    def static_list(src, name):
        m = re.search(r'\b' + name + r'\s*(?:=\s*)?\{(.*?)\n\s*\};', src, re.S)
        if not m:
            raise SystemExit(f'extract_preset_keys: {name} not found — upstream layout changed')
        return re.findall(r'"([a-z0-9_]+)"', m.group(1))

    # Preset::printer_options() = printer + machine limits + the per-extruder keys, in that order.
    printer = static_list(preset, 's_Preset_printer_options')
    printer += static_list(preset, 's_Preset_machine_limits_options')
    printer += static_list(config, 'm_extruder_option_keys')

    # printer_options() appends three lists that already overlap, so dedup is part of reproducing it.
    # Keys the config schema does not define are dropped: every consumer coerces values BY schema type, so a key
    # with no type cannot be serialized or read back — carrying it would only move the failure downstream. The
    # names are printed rather than swallowed, because a growing list here means the schema extractor is missing
    # options the presets actually use.
    def clean(keys, label):
        seen, out, unknown = set(), [], []
        for k in keys:
            if k in seen:
                continue
            seen.add(k)
            (out if k in schema else unknown).append(k)
        if unknown:
            print(f'  preset-keys[{label}]: dropped {len(unknown)} key(s) absent from config-schema: '
                  + ', '.join(unknown))
        return out

    return {
        'printer':  clean(printer, 'printer'),
        'process':  clean(static_list(preset, 's_Preset_print_options'), 'process'),
        'filament': clean(static_list(preset, 's_Preset_filament_options'), 'filament'),
    }


# ---------------------------------------------------------------- main
if __name__ == '__main__':
    ui = extract_ui_tree()
    sch = extract_schema()

    # SLA pass: resin tabs + resin option definitions from the PrusaSlicer checkout. Schema keys Orca already
    #  defines are kept as Orca defined them (its vestigial SLA entries are what the committed artifacts and the
    #  derive defaults were measured against); only the missing ones are added.
    sla_ui = extract_sla_ui()
    sla_sch = extract_sla_schema()
    sla_added = [k for k in sla_sch if k not in sch]
    for k in sla_added:
        sch[k] = sla_sch[k]
    ui.update(sla_ui)
    if sla_ui or sla_added:
        print(f"sla: +{len(sla_added)} schema keys, +{len(sla_ui)} builders (PrusaSlicer pass)")
    else:
        print("sla: PrusaSlicer checkout absent — SLA pass skipped, committed entries kept")

    json.dump(ui, open(os.path.join(OUT, 'ui-tree.json'), 'w'), ensure_ascii=False, indent=1)

    # A reduced ui-tree: per builder, just the option keys in order. The page and group NAMES are upstream's
    #  authored labels and the `line` fields point back into its sources; a consumer that only needs "which
    #  options belong to the filament tab" needs neither. Anything that RENDERS the tabs keeps the full tree.
    lean_ui = {builder: [key for page in pages for group in page['groups'] for key in group['options']]
               for builder, pages in ui.items()}
    json.dump(lean_ui, open(os.path.join(OUT, 'ui-tree-keys.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    # The permissive package ships its own copies of the three prose-free artifacts.
    import shutil
    MIT_DATA = os.path.join(REPO, 'viewer-package', 'data'); os.makedirs(MIT_DATA, exist_ok=True)
    for name in ('config-schema-lean.json', 'ui-tree-keys.json', 'preset-keys.json'):
        if os.path.exists(os.path.join(OUT, name)): shutil.copy(os.path.join(OUT, name), os.path.join(MIT_DATA, name))
    npages = sum(len(v) for v in ui.values())
    nopts = sum(len(g['options']) for v in ui.values() for p in v for g in p['groups'])

    json.dump(sch, open(os.path.join(OUT, 'config-schema.json'), 'w'), ensure_ascii=False, indent=1)

    # A second, REDUCED schema carrying only the fields code reads: type, default, enum_values and the numeric
    #  bounds. Everything dropped here is upstream's authored text — `label`, `tooltip`, `full_label` — plus the
    #  pointers back into its sources (`defined_in`, `line`), which together are ~45% of the file and are the
    #  part that cannot be relicensed (packages/PROVENANCE.md section 5).
    #
    #  Measured: engine/src/settings.js reads exactly `.type`, `.default` and `enum_values` out of 976 keys and
    #  never touches a label or a tooltip, so dropping the prose changes no behaviour. What is left is a
    #  key -> type map: facts about an option set rather than expression. Anything that RENDERS a settings form
    #  still needs the full schema and keeps using it.
    # `defined_in` and `line` stay: settings.js selects the SLA keys by `defined_in` (`'sla_'` in the upstream
    #  init function's name) and cites both in SLA_SETTING_CONTRACT. They are a function name and a line
    #  number — facts about where an option is declared, not authored text — so they cost nothing to keep.
    #  `mode`, `gui_type`, `is_code`, `multiline` are layout flags and `sidetext` is the unit ("mm", "%"): the
    #  settings form needs them to lay a field out, and none of them is authored text. label/tooltip/enum_labels
    #  stay out — those are the prose, and the form falls back to the key name without them.
    KEEP = ('type', 'default', 'enum_values', 'min', 'max', 'default_type', 'defined_in', 'line',
            'mode', 'gui_type', 'is_code', 'multiline', 'sidetext')
    lean = {key: {f: opt[f] for f in KEEP if f in opt} for key, opt in sch.items()}
    json.dump(lean, open(os.path.join(OUT, 'config-schema-lean.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    full_bytes = os.path.getsize(os.path.join(OUT, 'config-schema.json'))
    lean_bytes = os.path.getsize(os.path.join(OUT, 'config-schema-lean.json'))
    print(f"schema: {len(sch)} keys - full {full_bytes//1024}KB, lean {lean_bytes//1024}KB "
          f"({100 - lean_bytes * 100 // full_bytes}% dropped as prose)")

    inv = extract_invalidation()
    json.dump(inv, open(os.path.join(OUT, 'invalidation-map.json'), 'w'), ensure_ascii=False, indent=1)

    tog = extract_toggles()
    json.dump(tog, open(os.path.join(OUT, 'toggle-rules.json'), 'w'), ensure_ascii=False, indent=1)

    pr = extract_printers(sch)
    # SLA machines ride in the same artifact: keys appended (FFF rows stay short), set rows offset, new vendors,
    #  plus the per-vendor technology map the printer picker filters on.
    sla_pr = extract_sla_printers(sch)
    if sla_pr:
        base_sets = len(pr['sets'])
        pr['keys'] = pr['keys'] + SLA_PRINTER_KEYS
        pr['sets'].extend(sla_pr['sets'])
        for vendor, models in sla_pr['byVendor'].items():
            pr['byVendor'][vendor] = {name: [e[0], e[1] + base_sets, e[2], e[3]] for name, e in models.items()}
        pr['techByVendor'] = sla_pr['techByVendor']
        pr['resins'] = sla_pr['resins']
        print(f"sla printers: +{sum(len(v) for v in sla_pr['byVendor'].values())} across {len(sla_pr['byVendor'])} vendors; {len(sla_pr['resins'])} resin materials")
    json.dump(pr, open(os.path.join(OUT, 'printers.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    nprinters = sum(len(v) for v in pr['byVendor'].values())

    pk = extract_preset_keys(sch)
    json.dump(pk, open(os.path.join(OUT, 'preset-keys.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

    # Emitted as a JS module, not JSON: this one is dynamically imported, and a dynamic JSON import needs
    #  `with { type: 'json' }` in Node while that same attribute makes browsers reject Vite's text/javascript
    #  response. A plain module satisfies both and still code-splits.
    proc = extract_processes(sch)
    with open(os.path.join(OUT, 'processes.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by web/extract_all.py — do not edit. See types/data/processes.js.d.ts.\nexport default ')
        json.dump(proc, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')

    fil = extract_filaments(sch)          # a JS module for the same reason as processes.js above
    with open(os.path.join(OUT, 'filaments.js'), 'w', encoding='utf-8') as fh:
        fh.write('// Generated by web/extract_all.py — do not edit. See types/data/filaments.js.d.ts.\nexport default ')
        json.dump(fil, fh, ensure_ascii=False, separators=(',', ':'))
        fh.write('\n')

    print(f"ui-tree: {len(ui)} builders, {npages} pages, {nopts} option refs")
    print(f"schema: {len(sch)} options; with enum_values: {sum(1 for o in sch.values() if o.get('enum_values'))}; with tooltip: {sum(1 for o in sch.values() if o.get('tooltip'))}")
    pb = inv['Print'] or []; pob = inv['PrintObject'] or []
    print(f"invalidation: Print {len(pb)} branches / PrintObject {len(pob)} branches")
    print(f"printers: {nprinters} printers across {len(pr['byVendor'])} vendors; {len(pr['sets'])} distinct setting sets")
    print(f"processes: {len(proc['presets'])} presets over {len(proc['keys'])} kernel keys; {len(proc['sets'])} distinct sets; {len(proc['byPrinter'])} printers mapped")
    print(f"filaments: {len(fil['presets'])} presets over {len(fil['keys'])} kernel keys; {len(fil['sets'])} distinct sets; "
          f"{len(fil['byPrinter'])} printers mapped; {len(set(p[2] for p in fil['presets']))} material types; {len(fil['defaultsByModel'])} models with recommendations")
    print(f"toggle: {sum(len(v['rules']) for v in tog.values())} rules across {len(tog)} functions; "
          f"calls in source: {sum(v['stats']['toggle_calls_in_source'] for v in tog.values())}")
