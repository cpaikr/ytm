# Changelog

## [0.5.0](https://github.com/cpaikr/ytm/compare/v0.4.1...v0.5.0) (2026-09-10)

### Features

* bound retrieval retries and deadlines across all interfaces ([11d534f](https://github.com/cpaikr/ytm/commit/11d534fe8955bf4d6438f2370a1137a3b8852598)), closes [#45](https://github.com/cpaikr/ytm/issues/45)
* expose bounded bulk retrieval controls and statistics ([297188f](https://github.com/cpaikr/ytm/commit/297188f7aad3d42c1736a88f6d3959069d410dbe))

### Bug Fixes

* **acceptance:** bind and bound candidate execution ([2e34c0d](https://github.com/cpaikr/ytm/commit/2e34c0dfbf656f5147efe967c740d81654ec3f47))
* address bulk retrieval review diagnostics and policy defaults ([55f16f6](https://github.com/cpaikr/ytm/commit/55f16f6b7f0b5e8265bf9b25ba90f458b75e2da0))
* **core:** keep custom context transport attempt counts unknown ([71a4c90](https://github.com/cpaikr/ytm/commit/71a4c904158d0d7d6e6f2b428d0e2b97203f1324))
* **python:** preserve cancellation when native bridge completion fails ([fcdbf94](https://github.com/cpaikr/ytm/commit/fcdbf9486e519be2a564e5e2612dccac98aa0d95))
* refine CLI policy diagnostics and preserve golden output bytes ([c4b7f0f](https://github.com/cpaikr/ytm/commit/c4b7f0f8a2f845b814b76d2cfca612a98c4bde11))

## [0.4.1](https://github.com/cpaikr/ytm/compare/v0.4.0...v0.4.1) (2026-09-09)

### Bug Fixes

* **docs:** reject shadowed Windows commands during verification ([1bc3e4a](https://github.com/cpaikr/ytm/commit/1bc3e4ab896c1f642682f38c729b809462ce3d3a))
* **install:** clarify Windows visibility and PATH recovery ([514b2a0](https://github.com/cpaikr/ytm/commit/514b2a0bc2981f3f32c825c042b1f47f2d5ea47f))

## [0.4.0](https://github.com/cpaikr/ytm/compare/v0.3.0...v0.4.0) (2026-09-09)

### Features

* **history:** select the latest count of numeric observation dates ([0ee948c](https://github.com/cpaikr/ytm/commit/0ee948ca8f325fdc0a271e136881e127c61fffb0))

### Bug Fixes

* **history:** address recovery guidance and close-test review feedback ([368eb5b](https://github.com/cpaikr/ytm/commit/368eb5b8be85bff974c6a9e20f807058df06552f))

## [0.3.0](https://github.com/cpaikr/ytm/compare/v0.1.1...v0.3.0) (2026-09-08)

### Release delivery

This release distributes standalone CLI archives, installers, and checksums
through GitHub Releases. Release Please and npm/PyPI publication have been
removed. Rust, Node, and Python SDK source and local development packaging
remain supported. The commit history below includes earlier delivery work
that was superseded before this release.

### ⚠ BREAKING CHANGES

* Node consumers must migrate from the legacy error behavior to the structured error codes and serialized error details.

### Features

* add lockstep KIS-NET package surfaces ([4877d40](https://github.com/cpaikr/ytm/commit/4877d4073f73ced6193cbfdeb3a1aa78bc8f6cf3))
* **cli:** add verified managed install upgrades ([607b437](https://github.com/cpaikr/ytm/commit/607b437e7d36483e62c38428b0e130b90b96637a))
* **cli:** export typed Excel workbooks with safe publication ([77a941b](https://github.com/cpaikr/ytm/commit/77a941b9f327d10ed1927f15060ce7a0da0207c2))
* **cli:** move ytm command to Rust ([8465077](https://github.com/cpaikr/ytm/commit/846507770c0b68cd48c82ae76ec0490a06791568))
* **core:** implement the Rust KIS-NET conformer ([3980fe8](https://github.com/cpaikr/ytm/commit/3980fe8d25951eeb763dd8fd9e8bf12f4be8e7e7))
* harden Nexacro XML handling ([d80a007](https://github.com/cpaikr/ytm/commit/d80a007849173e419512e4342d2a9891bdd72bdc))
* **node:** stage the thin native-backed product ([337ca4a](https://github.com/cpaikr/ytm/commit/337ca4a3dd9a854373f3b59fd7cf46f4c55c720b))
* **python:** add typed sync and async clients over the public Rust core ([a443c8c](https://github.com/cpaikr/ytm/commit/a443c8c20cd47ec2e0b237715161555fddf04924))
* **release:** build standalone CLI candidates ([d28d12f](https://github.com/cpaikr/ytm/commit/d28d12fb0307b074b0c0c7204d5bc2786d7dee55))
* **release:** establish unified product release authority ([4bcb2bd](https://github.com/cpaikr/ytm/commit/4bcb2bd66df7c32a6ff1f466f852c5b015f7a85c))
* **release:** integrate portable Python wheels and independent registry projections ([19d9353](https://github.com/cpaikr/ytm/commit/19d935347a4f201697f9b5e5567dbe844e4def56))
* **release:** publish exact tagged product candidates ([f2ab4de](https://github.com/cpaikr/ytm/commit/f2ab4de5e859ff020fffcc8998c6b5fc74fedab0))
* retrieve all-category YTM history across CLI and SDKs ([63ff49f](https://github.com/cpaikr/ytm/commit/63ff49fbe7b8a0e2f07752d9cb0ed72ccd7cdea4))
* **rust:** expose a typed public ytm SDK ([dd683fc](https://github.com/cpaikr/ytm/commit/dd683fc2d6078fb9b005124e08356d143d738c52))

### Bug Fixes

* address release review feedback ([39f9069](https://github.com/cpaikr/ytm/commit/39f90696e8bbb3459f04908ab73dc9274bccb04b))
* address XML hardening review feedback ([69bb468](https://github.com/cpaikr/ytm/commit/69bb4682a197592a55a6d39db88e2aaf432c8a6f))
* **ci:** resolve the Windows npm launcher absolutely ([3cd0799](https://github.com/cpaikr/ytm/commit/3cd0799f86ec95b787bf47e305597ee5799f2e48))
* **ci:** use the provisioned runtime for facade assembly ([bda2211](https://github.com/cpaikr/ytm/commit/bda2211b6f5db4cb8f2ec629bcb5c7a1944ddd6f))
* **cli:** advertise Excel export in top-level help ([3eff4ac](https://github.com/cpaikr/ytm/commit/3eff4acfbbb210037bb30244d9e03b917d3a103e))
* **cli:** close managed upgrade recovery gaps ([12f6906](https://github.com/cpaikr/ytm/commit/12f6906fa950d399228ab6181d08617fa9117fe3))
* **cli:** harden standalone delivery boundaries ([951861d](https://github.com/cpaikr/ytm/commit/951861ddc5fae8ed162df3eca151e24627256fc4))
* **cli:** honor interrupts while output is blocked ([1d5b5d6](https://github.com/cpaikr/ytm/commit/1d5b5d63de2a02e7f690f94ee32d599d1100676e))
* **cli:** keep help parsing aligned with command options ([a0b4e59](https://github.com/cpaikr/ytm/commit/a0b4e59d440ddc0c2c4978c706846b63d61dd7dd))
* harden CLI help and SDK input boundaries ([e6c6350](https://github.com/cpaikr/ytm/commit/e6c63503cd5c7d59a617129870b147ed2b8b13db))
* harden SDK CLI and native delivery contracts ([7f0b79b](https://github.com/cpaikr/ytm/commit/7f0b79b88422b9afef95e252a370f4169ce3acac))
* **history:** enforce SDK bounds and stabilize cancellation checks ([3d4f371](https://github.com/cpaikr/ytm/commit/3d4f3711137aba555e543a4370afec45350ac707))
* **judge:** normalize platform-specific native evidence ([0e08fb1](https://github.com/cpaikr/ytm/commit/0e08fb1dfa3804c6b059c3ab938e2aa4ec30806b))
* **node:** enforce typed client boundaries ([8943c10](https://github.com/cpaikr/ytm/commit/8943c1058d53e7504cf8eba7d814230b8d760ee2))
* **node:** harden serializer review edge cases ([a15ab3f](https://github.com/cpaikr/ytm/commit/a15ab3f2842413f66092358286f57298473e34f2))
* **node:** make native and error failures deterministic ([3405c8a](https://github.com/cpaikr/ytm/commit/3405c8acbd3b2ec994214436930a1eeb6f55db6e))
* **parser:** accept fixed-width padded yields ([6992a23](https://github.com/cpaikr/ytm/commit/6992a23b261e7df360bce22c2806ab59d56b208c))
* preserve KIS-NET protocol errors ([d87e626](https://github.com/cpaikr/ytm/commit/d87e626cbccdaf5343d1b9783b2b7c7e3f8a5299))
* **python:** validate the minimum interpreter and clarify boundary diagnostics ([43a3c1a](https://github.com/cpaikr/ytm/commit/43a3c1a7ca211413e36c57b20c3359f9f8d94f03))
* **release:** centralize native artifact planning ([a3793ae](https://github.com/cpaikr/ytm/commit/a3793ae02d0d1a59be91baba50f702bd04cbf432))
* **release:** harden CLI candidate validation ([f2578db](https://github.com/cpaikr/ytm/commit/f2578db699e5944dd5ce87a5b32c73ef2c54da9a))
* **release:** harden exact publication boundaries ([07c2bd8](https://github.com/cpaikr/ytm/commit/07c2bd847f81f57217b28bcc604390c3e1361cf8))
* **release:** harden Windows terminal status commits ([55b39f5](https://github.com/cpaikr/ytm/commit/55b39f5c2ef115b31190d2b32bb618c0c2d97ee0))
* **release:** keep lifecycle and license receipts truthful ([a3b9731](https://github.com/cpaikr/ytm/commit/a3b9731dd76142e79437d7175a69ea574f78ca1e))
* **release:** make Windows hashing module-independent ([e4d956b](https://github.com/cpaikr/ytm/commit/e4d956b3a23c3f8d2f9e9f97c59f27901385870a))
* **release:** normalize gzip platform metadata ([b7c9758](https://github.com/cpaikr/ytm/commit/b7c9758fa7b4d44c66063a092dccec7a7c1144a7))
* **release:** preserve canonical URL across draft publication ([f05c289](https://github.com/cpaikr/ytm/commit/f05c289f18f1468fe051f55fd4db7b8373d85865))
* **release:** preserve wheel source bytes and verify registry propagation ([068d6db](https://github.com/cpaikr/ytm/commit/068d6db6288fea38fdf6edfaacd3861d05cc9684))
* **review:** close parser and judge race windows ([beb7f2a](https://github.com/cpaikr/ytm/commit/beb7f2afc813914e41b35237c43558280fd745dd))
* **review:** harden CLI output and package guards ([f254b6b](https://github.com/cpaikr/ytm/commit/f254b6b0661d4ef418b51bcdf8e634e1889dfc08))
* **review:** harden cutover validation ([b5ad401](https://github.com/cpaikr/ytm/commit/b5ad4016097442a46081198ad39f23975be14f4a))
* **review:** harden final cutover boundaries ([b41e98c](https://github.com/cpaikr/ytm/commit/b41e98cfcffa069bc772eb43d2504e7c21e0874e)), closes [#12](https://github.com/cpaikr/ytm/issues/12)
* **rewrite:** harden the native candidate after review ([64a7ebf](https://github.com/cpaikr/ytm/commit/64a7ebf64437a844d0d5540b099d02efaab56ca3))
* **runtime:** harden cancellation and XML boundaries ([4228f7b](https://github.com/cpaikr/ytm/commit/4228f7b060055fde7b930e284915019c63a1ad0b))
* **sdk:** harden public contracts after review ([a962603](https://github.com/cpaikr/ytm/commit/a962603302f3755cdc33fe0c324e1e7a2eab2752))

This is the product changelog for the Rust core, standalone CLI, and Node SDK.
Entries before the unified `vX.Y.Z` lifecycle retain their historical tag links.

## [0.2.0](https://github.com/cpaikr/ytm/compare/v0.1.1...node-v0.2.0) (2026-07-17)

### ⚠ BREAKING CHANGES

- Node consumers must migrate from the legacy error behavior to the structured
  error codes and serialized error details.

### Features

- add lockstep KIS-NET package surfaces ([4877d40](https://github.com/cpaikr/ytm/commit/4877d4073f73ced6193cbfdeb3a1aa78bc8f6cf3))
- harden KIS-NET response handling and test coverage ([7958da2](https://github.com/cpaikr/ytm/commit/7958da2f9775fd291ee6bda2581a3c672974f052))
- harden Nexacro XML handling ([d80a007](https://github.com/cpaikr/ytm/commit/d80a007849173e419512e4342d2a9891bdd72bdc))

### Bug Fixes

- address XML hardening review feedback ([69bb468](https://github.com/cpaikr/ytm/commit/69bb4682a197592a55a6d39db88e2aaf432c8a6f))
- preserve KIS-NET protocol errors ([d87e626](https://github.com/cpaikr/ytm/commit/d87e626cbccdaf5343d1b9783b2b7c7e3f8a5299))
- preserve KIS-NET protocol errors across package surfaces ([b32a810](https://github.com/cpaikr/ytm/commit/b32a810722849afa216b78053f305a7dcb706073))

## [0.1.1](https://github.com/cpaikr/ytm/compare/v0.1.0...v0.1.1) (2026-06-10)

### Bug Fixes

- make npm release publish idempotent ([cfb33cf](https://github.com/cpaikr/ytm/commit/cfb33cf1ac7a7ebaca4568ccc17ef031a6ad1908))
