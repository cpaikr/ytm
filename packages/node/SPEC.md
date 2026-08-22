# Current Node package boundary

The public toolset contract is defined by the repository
[`SPEC.md`](https://github.com/cpaikr/ytm/blob/main/SPEC.md). External HTTP
and Nexacro details are owned only by
[`contracts/kisnet/openapi.yaml`](https://github.com/cpaikr/ytm/blob/main/contracts/kisnet/openapi.yaml).

The package requires Node.js 22 or newer and supports Linux GNU x64/ARM64,
macOS ARM64, and Windows x64 through exact-version optional native packages.
Use toolset discovery methods for the current public operation contract.

The package is the Rust-backed Node SDK and has no `bin` entry or JavaScript
CLI. It does not own HTTP, XML, fallback, or command-line behavior; the
standalone CLI lives in `crates/ytm-cli` and depends directly on `ytm-core`.
