// The big integer of boost.polygon's exact Voronoi predicates, with a row-wise multiplication.
//  The sweep computes each circle event in double first and recomputes it in big integers when the error bound is too
//  wide. On a finely tessellated outline that is almost every event, because three neighbouring segments of a smooth
//  curve are close to collinear: measured on a 1469-segment outline (native), 7214 of 7214 point-segment-segment and
//  1827 of 1827 segment-segment-segment events were recomputed, and the recomputation was 15.3 of the build's 18.6 ms.
//  boost's extended_int multiplies column by column, testing both limb indices on every step. FastInt holds the same
//  value in the same 32-bit limbs with the same count and the same truncation at 64 limbs, so the doubles the predicates
//  return are the same bits (voronoi_fast_int_hash.cpp: the diagrams' hash against boost's own builder).
#pragma once
#include <boost/polygon/detail/voronoi_ctypes.hpp>
#include <cstring>
#include <cstdlib>
#include <utility>

namespace voronoi_fast {
using boost::polygon::detail::int32;
using boost::polygon::detail::int64;
using boost::polygon::detail::uint32;
using boost::polygon::detail::uint64;
using boost::polygon::detail::fpt64;

class FastInt {
public:
    static constexpr std::size_t N = 64;

    FastInt() {}
    FastInt(int32 that) { assign(static_cast<int64>(that)); }
    FastInt(int64 that) { assign(that); }
    FastInt(const FastInt &that) { copy(that); }
    FastInt &operator=(const FastInt &that) { copy(that); return *this; }
    FastInt &operator=(int32 that) { assign(static_cast<int64>(that)); return *this; }
    FastInt &operator=(int64 that) { assign(that); return *this; }

    const uint32 *chunks() const { return chunks_; }
    int32 count() const { return count_; }
    std::size_t size() const { return static_cast<std::size_t>(std::abs(count_)); }

    FastInt operator-() const { FastInt result(*this); result.count_ = -result.count_; return result; }
    FastInt operator+(const FastInt &that) const { FastInt result; result.add(*this, that); return result; }
    FastInt operator-(const FastInt &that) const { FastInt result; result.dif(*this, that); return result; }
    FastInt operator*(const FastInt &that) const { FastInt result; result.mul(*this, that); return result; }
    FastInt operator*(int32 that) const { return *this * FastInt(that); }
    FastInt operator*(int64 that) const { return *this * FastInt(that); }

    // extended_int::p(): the top three limbs as a double, and the exponent of the rest.
    std::pair<fpt64, int> p() const
    {
        std::pair<fpt64, int> result(0, 0);
        const std::size_t limbs = size();
        if (limbs == 0)
            return result;
        if (limbs == 1) {
            result.first = static_cast<fpt64>(chunks_[0]);
        } else if (limbs == 2) {
            result.first = static_cast<fpt64>(chunks_[1]) * static_cast<fpt64>(0x100000000LL) + static_cast<fpt64>(chunks_[0]);
        } else {
            for (std::size_t i = 1; i <= 3; ++i) {
                result.first *= static_cast<fpt64>(0x100000000LL);
                result.first += static_cast<fpt64>(chunks_[limbs - i]);
            }
            result.second = static_cast<int>((limbs - 3) << 5);
        }
        if (count_ < 0)
            result.first = -result.first;
        return result;
    }

    void add(const FastInt &e1, const FastInt &e2)
    {
        if (!e1.count_) { copy(e2); return; }
        if (!e2.count_) { copy(e1); return; }
        if ((e1.count_ > 0) ^ (e2.count_ > 0))
            dif(e1.chunks_, e1.size(), e2.chunks_, e2.size());
        else
            add(e1.chunks_, e1.size(), e2.chunks_, e2.size());
        if (e1.count_ < 0)
            count_ = -count_;
    }

    void dif(const FastInt &e1, const FastInt &e2)
    {
        if (!e1.count_) { copy(e2); count_ = -count_; return; }
        if (!e2.count_) { copy(e1); return; }
        if ((e1.count_ > 0) ^ (e2.count_ > 0))
            add(e1.chunks_, e1.size(), e2.chunks_, e2.size());
        else
            dif(e1.chunks_, e1.size(), e2.chunks_, e2.size());
        if (e1.count_ < 0)
            count_ = -count_;
    }

    void mul(const FastInt &e1, const FastInt &e2)
    {
        if (!e1.count_ || !e2.count_) { count_ = 0; return; }
        mul(e1.chunks_, e1.size(), e2.chunks_, e2.size());
        if ((e1.count_ > 0) ^ (e2.count_ > 0))
            count_ = -count_;
    }

private:
    void assign(int64 that)
    {
        if (that == 0) { count_ = 0; return; }
        const bool negative = that < 0;
        uint64 magnitude = static_cast<uint64>(that);
        if (negative)
            magnitude = 0 - magnitude;
        chunks_[0] = static_cast<uint32>(magnitude);
        chunks_[1] = static_cast<uint32>(magnitude >> 32);
        count_ = 1;
        if (chunks_[1])
            count_ = 2;
        if (negative)
            count_ = -count_;
    }

    void copy(const FastInt &that)
    {
        count_ = that.count_;
        std::memcpy(chunks_, that.chunks_, that.size() * sizeof(uint32));
    }

    void add(const uint32 *c1, std::size_t sz1, const uint32 *c2, std::size_t sz2)
    {
        if (sz1 < sz2) { add(c2, sz2, c1, sz1); return; }
        count_ = static_cast<int32>(sz1);
        uint64 carry = 0;
        for (std::size_t i = 0; i < sz2; ++i) {
            carry += static_cast<uint64>(c1[i]) + static_cast<uint64>(c2[i]);
            chunks_[i] = static_cast<uint32>(carry);
            carry >>= 32;
        }
        for (std::size_t i = sz2; i < sz1; ++i) {
            carry += static_cast<uint64>(c1[i]);
            chunks_[i] = static_cast<uint32>(carry);
            carry >>= 32;
        }
        if (carry && static_cast<std::size_t>(count_) != N) {
            chunks_[count_] = static_cast<uint32>(carry);
            ++count_;
        }
    }

    // |c1| - |c2|, the sign in count_. extended_int::dif leaves the top limbs of the result zero when they cancel
    // and counts sz1 - 1 or sz1 limbs; the same count is kept here, since p() reads the top three limbs.
    void dif(const uint32 *c1, std::size_t sz1, const uint32 *c2, std::size_t sz2, bool recursive = false)
    {
        if (sz1 < sz2) { dif(c2, sz2, c1, sz1, true); count_ = -count_; return; }
        if (sz1 == sz2 && !recursive) {
            do {
                --sz1;
                if (c1[sz1] < c2[sz1]) { ++sz1; dif(c2, sz1, c1, sz1, true); count_ = -count_; return; }
                if (c1[sz1] > c2[sz1]) { ++sz1; break; }
            } while (sz1);
            if (!sz1) { count_ = 0; return; }
            sz2 = sz1;
        }
        count_ = static_cast<int32>(sz1 - 1);
        uint32 borrow = 0;
        for (std::size_t i = 0; i < sz2; ++i) {
            const uint64 difference = static_cast<uint64>(c1[i]) - static_cast<uint64>(c2[i]) - borrow;
            chunks_[i] = static_cast<uint32>(difference);
            borrow = static_cast<uint32>(difference >> 63);
        }
        for (std::size_t i = sz2; i < sz1; ++i) {
            const uint64 difference = static_cast<uint64>(c1[i]) - borrow;
            chunks_[i] = static_cast<uint32>(difference);
            borrow = static_cast<uint32>(difference >> 63);
        }
        if (chunks_[count_])
            ++count_;
    }

    void mul(const uint32 *c1, std::size_t sz1, const uint32 *c2, std::size_t sz2)
    {
        if (sz1 + sz2 > N) { mul_truncating(c1, sz1, c2, sz2); return; }
        if (sz1 < sz2) { std::swap(c1, c2); std::swap(sz1, sz2); }
        // c1 or c2 may be this object's own limbs only through operator*, which writes to a fresh result.
        uint64 carry = 0;
        const uint64 first = c2[0];
        for (std::size_t i = 0; i < sz1; ++i) {
            carry += first * c1[i];
            chunks_[i] = static_cast<uint32>(carry);
            carry >>= 32;
        }
        chunks_[sz1] = static_cast<uint32>(carry);
        for (std::size_t j = 1; j < sz2; ++j) {
            const uint64 factor = c2[j];
            carry = 0;
            for (std::size_t i = 0; i < sz1; ++i) {
                carry += factor * c1[i] + chunks_[i + j];
                chunks_[i + j] = static_cast<uint32>(carry);
                carry >>= 32;
            }
            chunks_[sz1 + j] = static_cast<uint32>(carry);
        }
        count_ = static_cast<int32>(sz1 + sz2 - 1);
        if (chunks_[count_])
            ++count_;
    }

    // extended_int::mul as written, for a product that does not fit N limbs (it drops the limbs above N).
    void mul_truncating(const uint32 *c1, std::size_t sz1, const uint32 *c2, std::size_t sz2)
    {
        uint64 current = 0, next, product;
        count_ = static_cast<int32>((std::min)(N, sz1 + sz2 - 1));
        for (std::size_t shift = 0; shift < static_cast<std::size_t>(count_); ++shift) {
            next = 0;
            for (std::size_t first = 0; first <= shift; ++first) {
                if (first >= sz1)
                    break;
                const std::size_t second = shift - first;
                if (second >= sz2)
                    continue;
                product = static_cast<uint64>(c1[first]) * static_cast<uint64>(c2[second]);
                current += static_cast<uint32>(product);
                next += product >> 32;
            }
            chunks_[shift] = static_cast<uint32>(current);
            current = next + (current >> 32);
        }
        if (current && static_cast<std::size_t>(count_) != N) {
            chunks_[count_] = static_cast<uint32>(current);
            ++count_;
        }
    }

    uint32 chunks_[N];
    int32  count_;
};

inline bool is_pos(const FastInt &that) { return that.count() > 0; }
inline bool is_neg(const FastInt &that) { return that.count() < 0; }
inline bool is_zero(const FastInt &that) { return !that.count(); }

struct ToFpt : boost::polygon::detail::type_converter_fpt {
    using boost::polygon::detail::type_converter_fpt::operator();
    fpt64 operator()(const FastInt &that) const { const std::pair<fpt64, int> p = that.p(); return std::ldexp(p.first, p.second); }
};

struct ToEfpt {
    boost::polygon::detail::extended_exponent_fpt<fpt64> operator()(const FastInt &that) const
    {
        const std::pair<fpt64, int> p = that.p();
        return boost::polygon::detail::extended_exponent_fpt<fpt64>(p.first, p.second);
    }
};

struct CtypeTraits {
    typedef int32 int_type;
    typedef int64 int_x2_type;
    typedef uint64 uint_x2_type;
    typedef FastInt big_int_type;
    typedef fpt64 fpt_type;
    typedef boost::polygon::detail::extended_exponent_fpt<fpt_type> efpt_type;
    typedef boost::polygon::detail::ulp_comparison<fpt_type> ulp_cmp_type;
    typedef ToFpt to_fpt_converter_type;
    typedef ToEfpt to_efpt_converter_type;
};
} // namespace voronoi_fast
