# Dependency audit

CI retains the moderate-severity audit gate for runtime and development dependencies. One existing advisory is deferred explicitly for the reviewed development toolchain: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), minimatch glob preprocessing amplification.

The reviewed lock contains minimatch 10.2.6 through ESLint 10.13.0 and @eslint/config-array 0.23.5. Every affected dependency is development-only and absent from the published package; the runtime dependency tree contains htmlparser2 and its dependencies. These consumers use minimatch's default optimization level 1, whereas the advisory affects level 2 preprocessing. The full npm report remains visible in CI, including its propagated development-tool findings.

On 2026-10-31, the current ESLint 10.14.0 and config-array 0.23.5 still require minimatch 10.x; the patched minimatch release starts at 11.0.1. Updating ESLint alone cannot select that incompatible major. No dependency override or lockfile substitution is used.

The checker accepts only this advisory, moderate severity, development-only nodes, minimatch 10.2.6, and the exact reviewed tool versions. Runtime use, changed versions, new advisories, higher severity and incomplete audit responses fail CI. Revisit this exception when the compatible lint toolchain adopts a patched minimatch release.
