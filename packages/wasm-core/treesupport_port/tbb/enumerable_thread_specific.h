#pragma once
#include <list>
namespace tbb {
template<class T> class enumerable_thread_specific {
public:
    T& local(){
        if(m.empty()) m.emplace_back();
        return m.back();
    }
    auto begin(){return m.begin();}
    auto end(){return m.end();}
    std::list<T> m;
};
}
