// The nlopt algorithms the SLA support chain never selects, stubbed. PrusaSlicer's Optimize/NLoptOptimizer.hpp
//  instantiates GN_ESCH, LN_SBPLX, LN_NELDERMEAD, LN_COBYLA and GN_MLSL only, but nlopt_optimize()'s switch
//  (api/optimize.c) names every algorithm, so wasm-ld cannot drop the others: DIRECT, CDIRECT, PRAXIS, the Luksan
//  family, CRS, MMA/CCSA, NEWUOA, BOBYQA, AUGLAG, ISRES and SLSQP. Their sources are left out of build.sh's NLOPT_SRC and
//  each entry point answers NLOPT_INVALID_ARGS here. Measured on the st kernel: 6,506,892 -> 6,319,314 bytes raw,
//  1,457,481 -> 1,397,191 brotli. Adding an algorithm back is removing its line here and restoring its sources.
#include "nlopt-internal.h"
#include "direct.h"
#include "cdirect.h"
#include "praxis.h"
#include "luksan.h"
#include "crs.h"
#include "mma.h"
#include "newuoa.h"
#include "bobyqa.h"
#include "auglag.h"
#include "isres.h"
#include "slsqp.h"
direct_return_code direct_optimize(direct_objective_func f, void *f_data, int dimension, const double *lb, const double *ub, double *x, double *minf, int max_feval, int max_iter, double start, double maxtime, double magic_eps, double magic_eps_abs, double volume_reltol, double sigma_reltol, int *force_stop, double fglobal, double fglobal_reltol, FILE *logfile, direct_algorithm algorithm) { return DIRECT_INVALID_ARGS; }
nlopt_result cdirect_unscaled(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, double magic_eps, int which_alg) { return NLOPT_INVALID_ARGS; }
nlopt_result cdirect(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, double magic_eps, int which_alg) { return NLOPT_INVALID_ARGS; }
nlopt_result cdirect_hybrid(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, nlopt_algorithm local_alg, int local_maxeval, int randomized_div) { return NLOPT_INVALID_ARGS; }
nlopt_result cdirect_hybrid_unscaled(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, nlopt_algorithm local_alg, int local_maxeval, int randomized_div) { return NLOPT_INVALID_ARGS; }
nlopt_result praxis_(double t0, double machep, double h0, int n, double *x, praxis_func f, void *f_data, nlopt_stopping *stop, double *minf) { return NLOPT_INVALID_ARGS; }
nlopt_result luksan_plis(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, int mf) { return NLOPT_INVALID_ARGS; }
nlopt_result luksan_plip(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, int mf, int method) { return NLOPT_INVALID_ARGS; }
nlopt_result luksan_pnet(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, int mf, int mos1, int mos2) { return NLOPT_INVALID_ARGS; }
nlopt_result crs_minimize(int n, nlopt_func f, void *f_data, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, int population, int random) { return NLOPT_INVALID_ARGS; }
nlopt_result mma_minimize(unsigned n, nlopt_func f, void *f_data, unsigned m, nlopt_constraint *fc, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, nlopt_opt dual_opt) { return NLOPT_INVALID_ARGS; }
nlopt_result ccsa_quadratic_minimize(unsigned n, nlopt_func f, void *f_data, unsigned m, nlopt_constraint *fc, nlopt_precond pre, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, nlopt_opt dual_opt) { return NLOPT_INVALID_ARGS; }
nlopt_result newuoa(int n, int npt, double *x, const double *lb, const double *ub, double rhobeg, nlopt_stopping *stop, double *minf, newuoa_func calfun, void *calfun_data) { return NLOPT_INVALID_ARGS; }
nlopt_result bobyqa(int n, int npt, double *x, const double *lb, const double *ub, const double *dx, nlopt_stopping *stop, double *minf, nlopt_func f, void *f_data) { return NLOPT_INVALID_ARGS; }
nlopt_result auglag_minimize(int n, nlopt_func f, void *f_data, int m, nlopt_constraint *fc, int p, nlopt_constraint *h, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, nlopt_opt sub_opt, int sub_has_fc) { return NLOPT_INVALID_ARGS; }
nlopt_result isres_minimize(int n, nlopt_func f, void *f_data, int m, nlopt_constraint *fc, int p, nlopt_constraint *h, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop, int population) { return NLOPT_INVALID_ARGS; }
nlopt_result nlopt_slsqp(unsigned n, nlopt_func f, void *f_data, unsigned m, nlopt_constraint *fc, unsigned p, nlopt_constraint *h, const double *lb, const double *ub, double *x, double *minf, nlopt_stopping *stop) { return NLOPT_INVALID_ARGS; }
