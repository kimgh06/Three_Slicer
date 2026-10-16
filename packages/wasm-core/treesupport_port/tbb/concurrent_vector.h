#pragma once
#include <vector>
namespace tbb {
template<class T> class concurrent_vector : public std::vector<T> {
public: using std::vector<T>::vector;
    // tbb grow_by returns an iterator to the first new element.
    typename std::vector<T>::iterator grow_by(size_t n){
        size_t old_size=this->size();
        this->resize(old_size+n);
        return this->begin()+old_size;
    }
    typename std::vector<T>::iterator push_back(const T& v){
        std::vector<T>::push_back(v);
        return this->end()-1;
    }
};
}
