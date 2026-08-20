# Changelog

## [0.2.0](https://github.com/cpaikr/ytm/compare/python-v0.1.1...python-v0.2.0) (2026-07-17)


### ⚠ BREAKING CHANGES

* Node consumers must migrate from the legacy error behavior to the structured error codes and serialized error details.

### Features

* add lockstep KIS-NET package surfaces ([4877d40](https://github.com/cpaikr/ytm/commit/4877d4073f73ced6193cbfdeb3a1aa78bc8f6cf3))
* harden KIS-NET response handling and test coverage ([7958da2](https://github.com/cpaikr/ytm/commit/7958da2f9775fd291ee6bda2581a3c672974f052))
* harden Nexacro XML handling ([d80a007](https://github.com/cpaikr/ytm/commit/d80a007849173e419512e4342d2a9891bdd72bdc))


### Bug Fixes

* address release review feedback ([39f9069](https://github.com/cpaikr/ytm/commit/39f90696e8bbb3459f04908ab73dc9274bccb04b))
* address XML hardening review feedback ([69bb468](https://github.com/cpaikr/ytm/commit/69bb4682a197592a55a6d39db88e2aaf432c8a6f))
* preserve KIS-NET protocol errors ([d87e626](https://github.com/cpaikr/ytm/commit/d87e626cbccdaf5343d1b9783b2b7c7e3f8a5299))
* preserve KIS-NET protocol errors across package surfaces ([b32a810](https://github.com/cpaikr/ytm/commit/b32a810722849afa216b78053f305a7dcb706073))

## Changelog

Release Please maintains this file. The unpublished Python package starts from
the existing product baseline `0.1.1`; the first shared release version remains
subject to explicit confirmation.
