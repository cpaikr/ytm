# Current Node package boundary

The public Node client contract is defined by the repository
[`SPEC.md`](https://github.com/cpaikr/ytm/blob/main/SPEC.md). External HTTP
and Nexacro details are owned only by
[`contracts/kisnet/openapi.yaml`](https://github.com/cpaikr/ytm/blob/main/contracts/kisnet/openapi.yaml).

The package requires Node.js 22 or newer and supports Linux GNU x64/ARM64,
macOS ARM64, and Windows x64 through exact-version optional native packages.
The GNU/Linux artifacts require glibc 2.28 or newer.
The root package export provides `YtmClient` with typed `matrix()` and `kinds()`
methods. `validateMatrixInput()` and `validateKindsInput()` return
`{ ok: true, input }` or `{ ok: false, error }` without network I/O;
validation and execution errors expose stable `name` and `message` fields,
project `code`/`reason`, and a tagged `recoveryAction`.

The package is the Rust-backed Node SDK and has no `bin` entry or JavaScript
CLI. It mirrors public fallback-input validation but does not own HTTP, XML,
fallback execution, source semantics, or command-line behavior; the standalone
CLI lives in `crates/ytm-cli` and depends directly on `ytm-core`.

Native loader failures remain distinct: `unsupported_platform` means the
runtime is outside the supported target policy, `native_package_unavailable`
means the platform package is missing, and `native_package_corrupt` means the
installed native loader or artifact could not be loaded. These categories are
actionable and are not collapsed into `internal_error`.
