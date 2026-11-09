#!/usr/bin/env perl
# Drops the UI-only strings from PrintConfig.cpp on its way into the kernel build: the tooltip, label, sidetext,
#  category and full_label assignments and the enum_labels pushes. The kernel reads option names, types, defaults,
#  enum values and limits; the labels reach only Config.cpp's error messages and CLI help. Run by build.sh into
#  /tmp/ws_obj/gen/PrintConfig.cpp, so the upstream file stays verbatim. Measured on the st kernel: -236 KB raw,
#  -45 KB brotli (the tooltip text alone is 94 KB of the data section).
# Each statement is matched up to the first ';' outside a string literal, so a ';' inside a tooltip is kept whole.
local $/; my $source = <STDIN>;
my $string_literal = qr/"(?:[^"\\]|\\.)*"/;
my $expression = qr/(?:[^;"]|$string_literal)*?/;
$source =~ s/\bdef->(?:tooltip|label|sidetext|category|full_label)\s*=\s*$expression;/;/g;
$source =~ s/\bdef->enum_labels\.(?:push_back|emplace_back)\($expression\);/;/g;
print $source;
