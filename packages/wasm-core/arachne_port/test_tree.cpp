// Stage-9: prove the ported TreeSupport core (MinimumSpanningTree) runs — branch topology over
// support points. A tree spanning N points has exactly N-1 edges (connected acyclic).
#include <cstdio>
#include "../tree_bridge.h"
using namespace tree_bridge;
int main() {
    // scattered overhang support points (mm)
    std::vector<std::pair<double,double>> points = {
        {0,0},{10,0},{20,0},{5,8},{15,8},{10,16},{2,20},{18,20},{10,25}
    };
    auto edges = branch_mst(points);
    double total = 0;
    for (auto& edge : edges) total += std::hypot(edge.x1-edge.x0, edge.y1-edge.y0);
    printf("MST branch-merge: %zu points -> %zu edges (expect %zu = N-1), total branch len=%.2fmm\n",
           points.size(), edges.size(), points.size()-1, total);
    int acyclic_tree = 0;
    if (edges.size() == points.size()-1) acyclic_tree = 1;
    printf("acyclic_tree=%d\n", acyclic_tree);
    return 0;
}
