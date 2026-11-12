// A hash of the segment Voronoi diagrams of a fixed set of outlines: every vertex coordinate by bit pattern and
// every edge's twin, next, cell and start vertex. The kernel builds them with FastInt (voronoi_fast_int.h);
// compiled natively with -DVORONOI_REFERENCE_BUILDER the file is a program that prints the hash boost's own
// builder gives, which is the constant tests/test_voronoi_fast_int.mjs holds:
//   g++ -O2 -std=c++17 -DVORONOI_REFERENCE_BUILDER -I<boost> voronoi_fast_int_hash.cpp && ./a.out
// The outlines use +, -, *, / and floor only, so both programs build the same integers: two wavy rings a few
// millimetres apart in ~0.5 mm segments, where almost every circle event is recomputed in big integers, and a
// square with collinear and axis-aligned edges.
#include "voronoi_fast_int.h"
#include <boost/polygon/voronoi.hpp>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

namespace {
struct HashPoint { int x, y; };
struct HashSegment { HashPoint from, to; };
}

namespace boost { namespace polygon {
template <> struct geometry_concept<HashPoint> { typedef point_concept type; };
template <> struct point_traits<HashPoint> {
    typedef int coordinate_type;
    static int get(const HashPoint &point, orientation_2d orient) { if (orient == HORIZONTAL) return point.x; return point.y; }
};
template <> struct geometry_concept<HashSegment> { typedef segment_concept type; };
template <> struct segment_traits<HashSegment> {
    typedef int coordinate_type;
    typedef HashPoint point_type;
    static HashPoint get(const HashSegment &segment, direction_1d direction) { if (direction.to_int()) return segment.to; return segment.from; }
};
}}

namespace {
typedef boost::polygon::voronoi_diagram<double> Diagram;
#ifdef VORONOI_REFERENCE_BUILDER
typedef boost::polygon::default_voronoi_builder Builder;
#else
typedef boost::polygon::voronoi_builder<boost::polygon::detail::int32, voronoi_fast::CtypeTraits> Builder;
#endif

int to_nanometres(double millimetres) { return int(std::floor(millimetres * 1e6 + 0.5)); }

std::vector<HashSegment> hash_outline(unsigned seed)
{
    std::uint32_t state = seed * 2654435761u + 1u;
    std::vector<HashSegment> segments;
    for (int ring = 0; ring < 2; ++ring) {
        const double radius = 60.0 - (0.4 + 0.5 * seed) * ring;
        const int half = 380 - 6 * ring;      // points per half turn, ~0.5 mm apart
        const int waves = 3 + int(seed);
        std::vector<HashPoint> points;
        for (int side = 0; side < 2; ++side)
            for (int i = 0; i < half; ++i) {
                // The rational parametrisation of the half circle: no trigonometric function.
                const double t = -1.0 + 2.0 * i / half;
                double x = (1.0 - t * t) / (1.0 + t * t), y = 2.0 * t / (1.0 + t * t);
                if (side == 1) { x = -x; y = -y; }
                const int phase = ((side * half + i) * waves * 4) % (2 * half);
                double wave = double(phase) / half;                                  // a triangle wave in 0..2..0
                if (wave > 1.0)
                    wave = 2.0 - wave;
                state = state * 1664525u + 1013904223u;
                const double noise = (double(state >> 8) / 16777216.0 - 0.5) * 0.04;   // +-0.02 mm
                const double r = radius + 2.0 * (wave - 0.5) + noise;
                points.push_back({ to_nanometres(r * x), to_nanometres(r * y) });
            }
        for (std::size_t i = 0; i < points.size(); ++i)
            segments.push_back({ points[i], points[(i + 1) % points.size()] });
    }
    const HashPoint square[] = { { -5000000, -5000000 }, { 0, -5000000 }, { 5000000, -5000000 }, { 5000000, 5000000 }, { -5000000, 5000000 } };
    for (int i = 0; i < 5; ++i)
        segments.push_back({ square[i], square[(i + 1) % 5] });
    return segments;
}

struct Fnv {
    std::uint64_t value = 1469598103934665603ull;
    void add(std::uint64_t word) { for (int i = 0; i < 8; ++i) { value ^= (word >> (8 * i)) & 0xffu; value *= 1099511628211ull; } }
    void add(double number) { std::uint64_t bits; std::memcpy(&bits, &number, sizeof(bits)); add(bits); }
};
}

// vertices: the number of Voronoi vertices hashed. The hash is 16 hex digits.
void voronoi_fast_int_hash(int outlines, long &vertices, char hash_hex[17])
{
    Fnv fnv;
    vertices = 0;
    for (int seed = 1; seed <= outlines; ++seed) {
        const std::vector<HashSegment> segments = hash_outline(unsigned(seed));
        Diagram diagram;
        Builder builder;
        boost::polygon::insert(segments.begin(), segments.end(), &builder);
        builder.construct(&diagram);
        vertices += long(diagram.num_vertices());
        fnv.add(std::uint64_t(diagram.num_vertices())); fnv.add(std::uint64_t(diagram.num_edges())); fnv.add(std::uint64_t(diagram.num_cells()));
        for (const Diagram::vertex_type &vertex : diagram.vertices()) { fnv.add(vertex.x()); fnv.add(vertex.y()); }
        for (const Diagram::edge_type &edge : diagram.edges()) {
            fnv.add(std::uint64_t(edge.twin() - &diagram.edges()[0]));
            fnv.add(std::uint64_t(edge.next() - &diagram.edges()[0]));
            fnv.add(std::uint64_t(edge.cell() - &diagram.cells()[0]));
            std::uint64_t start = ~std::uint64_t(0);
            if (edge.vertex0() != nullptr)
                start = std::uint64_t(edge.vertex0() - &diagram.vertices()[0]);
            fnv.add(start);
        }
    }
    std::snprintf(hash_hex, 17, "%016llx", static_cast<unsigned long long>(fnv.value));
}

#ifdef VORONOI_REFERENCE_BUILDER
int main()
{
    long vertices = 0;
    char hash_hex[17];
    voronoi_fast_int_hash(12, vertices, hash_hex);
    std::printf("%ld %s\n", vertices, hash_hex);
    return 0;
}
#endif
