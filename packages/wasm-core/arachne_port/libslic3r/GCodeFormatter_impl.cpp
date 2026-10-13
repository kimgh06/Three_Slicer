// STAGE-8 PORT: GCodeFormatter::emit_axis definition extracted from src/libslic3r/GCodeWriter.cpp
// (unchanged). On wasm (non-__APPLE__) it uses std::to_chars — no boost::spirit needed.
#include "GCodeWriter.hpp"
#include <array>
#include <charconv>
#include <cstring>
#include <cmath>
namespace Slic3r {
void GCodeFormatter::emit_axis(const char axis, const double value, size_t digits) {
    assert(digits <= 9);
    static constexpr const std::array<int, 10> pow_10{1, 10, 100, 1000, 10000, 100000, 1000000, 10000000, 100000000, 1000000000};
    *ptr_err.ptr++ = ' ';
    *ptr_err.ptr++ = axis;

    char *base_ptr = this->ptr_err.ptr;
    auto  scaled_value = int64_t(std::round(value * pow_10[digits]));
    // Older stdlib on macOS doesn't support std::from_chars at all, so it is used boost::spirit::karma::generate instead of it.
    // That is a little bit slower than std::to_chars but not much.
#ifdef __APPLE__
    boost::spirit::karma::generate(this->ptr_err.ptr, boost::spirit::karma::int_generator<int64_t>(), scaled_value);
#else
    // this->buf_end minus 1 because we need space for adding the extra decimal point.
    this->ptr_err = std::to_chars(this->ptr_err.ptr, this->buf_end - 1, scaled_value);
#endif
    int sign_length = 0;
    if (scaled_value < 0)
        sign_length = 1;
    size_t writen_digits = (this->ptr_err.ptr - base_ptr) - sign_length;
    if (writen_digits < digits) {
        // Number is smaller than 10^digits, so that we will pad it with zeros.
        size_t remaining_digits = digits - writen_digits;
        // Move all newly inserted chars by remaining_digits to allocate space for padding with zeros.
        for (char *from_ptr = this->ptr_err.ptr - 1, *to_ptr = from_ptr + remaining_digits; from_ptr >= this->ptr_err.ptr - writen_digits; --to_ptr, --from_ptr)
            *to_ptr = *from_ptr;

        memset(this->ptr_err.ptr - writen_digits, '0', remaining_digits);
        this->ptr_err.ptr += remaining_digits;
    }

    // Move all newly inserted chars by one to allocate space for a decimal point.
    for (char *to_ptr = this->ptr_err.ptr, *from_ptr = to_ptr - 1; from_ptr >= this->ptr_err.ptr - digits; --to_ptr, --from_ptr)
        *to_ptr = *from_ptr;

    *(this->ptr_err.ptr - digits) = '.';
    for (size_t i = 0; i < digits; ++i) {
        if (*this->ptr_err.ptr != '0')
            break;
        this->ptr_err.ptr--;
    }
    if (*this->ptr_err.ptr == '.')
        this->ptr_err.ptr--;
    if ((this->ptr_err.ptr + 1) == base_ptr || *this->ptr_err.ptr == '-')
        *(++this->ptr_err.ptr) = '0';
    this->ptr_err.ptr++;

#if 0 // #ifndef NDEBUG
    {
        // Verify that the optimized formatter produces the same result as the standard sprintf().
        double formatted_value = atof(std::string(base_ptr, this->ptr_err.ptr).c_str());
        char sprintf_buffer[2048];
        sprintf(sprintf_buffer, "%.*lf", int(digits), value);
        double sprintf_value = atof(sprintf_buffer);
        // Numbers may differ when rounding at exactly or very close to 0.5 due to numerical issues when scaling the double to an integer.
        // Thus the complex assert.
//        assert(formatted_value == sprintf_value);
        assert(std::abs(formatted_value - value) * pow_10[digits] < 0.50001);
        assert(std::abs(sprintf_value - value) * pow_10[digits] < 0.50001);
    }
#endif // NDEBUG
}
} // namespace Slic3r
