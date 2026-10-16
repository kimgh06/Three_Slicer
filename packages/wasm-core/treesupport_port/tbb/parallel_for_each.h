#pragma once
#include <algorithm>
namespace tbb {
template<class It, class F> void parallel_for_each(It b, It e, F f){ std::for_each(b,e,f); }
template<class C, class F> void parallel_for_each(C& c, F f){ for(auto& element:c) f(element); }
}
