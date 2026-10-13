// Stage-20 probe: exercise the selector_bridge path (construct/paint/project_layers) with printf,
// replicating the wasm scenario exactly to isolate the footprint-projection behavior.
#include <cstdio>
#include <vector>
#include <map>
#include <array>
#include <cmath>
#include "../selector_bridge.h"

// build a welded (verts,tris) table mesh like slicer_core::selector_prepare (XY-centered, z-min=0).
static void weld_table(std::vector<float>& vertex_coords, std::vector<int>& triangle_indices) {
    auto box=[&](std::vector<std::array<double,9>>& out,double origin_x,double origin_y,double origin_z,double size_x,double size_y,double size_z){
        double corners[8][3]={{0,0,0},{size_x,0,0},{size_x,size_y,0},{0,size_y,0},{0,0,size_z},{size_x,0,size_z},{size_x,size_y,size_z},{0,size_y,size_z}};
        int faces[12][3]={{0,1,2},{0,2,3},{4,6,5},{4,7,6},{0,1,5},{0,5,4},{1,2,6},{1,6,5},{2,3,7},{2,7,6},{3,0,4},{3,4,7}};
        for(auto&face:faces){
            std::array<double,9> triangle;
            for(int k=0;k<3;k++){
                triangle[k*3]=corners[face[k]][0]+origin_x;
                triangle[k*3+1]=corners[face[k]][1]+origin_y;
                triangle[k*3+2]=corners[face[k]][2]+origin_z;
            }
            out.push_back(triangle);
        }
    };
    std::vector<std::array<double,9>> soup;
    box(soup,7,7,0,6,6,10);
    box(soup,0,0,10,20,20,4);
    double min_x=1e18;
    double min_y=1e18;
    double min_z=1e18;
    double max_x=-1e18;
    double max_y=-1e18;
    for(auto&triangle:soup)
        for(int k=0;k<3;k++){
            min_x=std::min(min_x,triangle[k*3]);
            max_x=std::max(max_x,triangle[k*3]);
            min_y=std::min(min_y,triangle[k*3+1]);
            max_y=std::max(max_y,triangle[k*3+1]);
            min_z=std::min(min_z,triangle[k*3+2]);
        }
    double center_x=(min_x+max_x)/2;
    double center_y=(min_y+max_y)/2;
    std::map<std::array<long long,3>,int> vertex_ids;
    auto add=[&](double x,double y,double z)->int{
        std::array<long long,3> key{(long long)std::llround(x*1e4),(long long)std::llround(y*1e4),(long long)std::llround(z*1e4)};
        auto it=vertex_ids.find(key);
        if(it!=vertex_ids.end())return it->second;
        int id=(int)(vertex_coords.size()/3);
        vertex_coords.push_back(x);
        vertex_coords.push_back(y);
        vertex_coords.push_back(z);
        vertex_ids[key]=id;
        return id;
    };
    for(auto&triangle:soup)
        for(int k=0;k<3;k++) triangle_indices.push_back(add(triangle[k*3]-center_x,triangle[k*3+1]-center_y,triangle[k*3+2]-min_z));
}

int main() {
    std::vector<float> vertex_coords;
    std::vector<int> triangle_indices;
    weld_table(vertex_coords, triangle_indices);
    selector_bridge::construct(vertex_coords, triangle_indices);
    printf("selector: facet_count=%d verts=%zu\n", selector_bridge::facet_count(), vertex_coords.size()/3);
    selector_bridge::paint(12, 0,0,10, 0,0,-40, 20.f, selector_bridge::STATE_ENFORCER, selector_bridge::CURSOR_SPHERE);   // enforcer on cap underside
    printf("enforcer painted facets=%d\n", selector_bridge::painted_count(true));
    std::vector<float> overlay_coords = selector_bridge::overlay(true);
    printf("overlay tris=%zu\n", overlay_coords.size()/9);
    std::vector<double> zs;
    for(double z=0.1; z<14; z+=0.2) zs.push_back(z);
    auto projected = selector_bridge::project_layers(zs, true);
    int nonempty_layers=0;
    for(size_t i=0;i<projected.size();++i)
        if(!projected[i].empty()){
            if(nonempty_layers<4) printf("  layer z=%.2f rings=%zu\n",zs[i],projected[i].size());
            nonempty_layers++;
        }
    printf("footprint nonzero layers=%d\n", nonempty_layers);
    const char* verdict = "FAIL";
    if (selector_bridge::facet_count()>0 && selector_bridge::painted_count(true)>0 && nonempty_layers>0) verdict = "PASS";
    printf("CHECK: %s\n", verdict);
    return 0;
}
