# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.4.0...v0.5.0) (2026-10-19)

### Added

* **oracle:** add live qualification workflow ([5063f21](https://github.com/doberkofler/codeindex-mcp/commit/5063f21f660ad7beda6fd5729002a4e5df2cdbf9))
* **oracle:** add static oracle 19c adapter ([e4d6c09](https://github.com/doberkofler/codeindex-mcp/commit/e4d6c099a04cf93e23ec05322936bce3b4b4e394))

### Fixed

* **oracle:** anchor member references at the member name ([ea8f1c9](https://github.com/doberkofler/codeindex-mcp/commit/ea8f1c902cc0f9168b588af326930ffc31f08e4b))
* **oracle:** skip disabled branches and recover case blocks ([7592eac](https://github.com/doberkofler/codeindex-mcp/commit/7592eacfbc899092c2a52589840301d5ff2fd9cf))
* **oracle:** skip named-argument labels as references ([12b4723](https://github.com/doberkofler/codeindex-mcp/commit/12b4723af8dfb6cb4a1f84e82d28b754bc230824))

### Changed

* **cli:** use operation-adapter command names ([aa46321](https://github.com/doberkofler/codeindex-mcp/commit/aa463217c3c3cefcdafb157e0c22986499f5a62c))

### Documentation

* **oracle:** record failed qualification gates ([5a2848c](https://github.com/doberkofler/codeindex-mcp/commit/5a2848c65d593716490339a57f0e14ae74ab25ec))

## [0.4.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.3.0...v0.4.0) (2026-10-19)

### Added

* **benchmark:** add resumable reference qualification suites ([2a236f0](https://github.com/doberkofler/codeindex-mcp/commit/2a236f0c4e716aa7164c24966aebc81eafe4ea04))
* **benchmark:** report progress and ETA during suites ([20b0a76](https://github.com/doberkofler/codeindex-mcp/commit/20b0a762419ef9fa923ea65fd2f6f4acfcf1dc29))

### Fixed

* **benchmark:** size the xl edit-to-fresh gate for the xl corpus ([5f655ed](https://github.com/doberkofler/codeindex-mcp/commit/5f655ed2922c7650a5f9ec8d0f2432a08cc098f3))
* **benchmark:** skip lifecycle scripts when preparing public projects ([8de8486](https://github.com/doberkofler/codeindex-mcp/commit/8de8486ad1a8424742945fa761e92275f9d9902f))
* **benchmark:** strip forwarded argument separators ([0d2f6eb](https://github.com/doberkofler/codeindex-mcp/commit/0d2f6ebfa01102edfe3017ee9eab1e07aca24158))
* **ci:** resolve reference corpus project file inside the configured root ([e30fdcf](https://github.com/doberkofler/codeindex-mcp/commit/e30fdcfa7cfd6785e29ef63ad27c2bd1ea0543bd))
* **ci:** select benchmark baseline and reference by profile ([048f580](https://github.com/doberkofler/codeindex-mcp/commit/048f5801b38c277e2ba167a8c6d7c98e39b8214d))
* **extractor:** bound build memory for large TypeScript projects ([b9c3596](https://github.com/doberkofler/codeindex-mcp/commit/b9c35968c7fc13a360fc2782ccff77a73c107a0e))
* **storage:** close worker connections before reporting build completion ([382ec40](https://github.com/doberkofler/codeindex-mcp/commit/382ec4054f98cc58d882d774ecf5bbed36aeb1d8))
* **storage:** keep lease heartbeat alive under write contention ([1c2e451](https://github.com/doberkofler/codeindex-mcp/commit/1c2e451470f21a26f90955f6af1fc51fcb0397d3))

### Changed

* **storage:** cut edit-to-fresh latency on large indexes ([3d51e7d](https://github.com/doberkofler/codeindex-mcp/commit/3d51e7d4a0769fc312f6078e2f3ed458fc24e8b6))

## [0.3.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.2.0...v0.3.0) (2026-10-19)

### Added

* add model-free benchmark scenarios and resource sampling ([c3988db](https://github.com/doberkofler/codeindex-mcp/commit/c3988dbf61c8579d69d9940beadc91c92784ba19))
* **benchmark:** add versioned gates and CI reporting ([9e09995](https://github.com/doberkofler/codeindex-mcp/commit/9e09995c22db08bb8a62da3fe40002a93c7ec64e))
* **console:** remove install MCP entry and benchmark cards ([ff767c9](https://github.com/doberkofler/codeindex-mcp/commit/ff767c9e8a4789cd200eeb61ba21496b3d03e092))

### Fixed

* **benchmark:** append GitHub step summary ([c9eeb9d](https://github.com/doberkofler/codeindex-mcp/commit/c9eeb9d926fc2c8c11a296837d9844ede07b6997))
* **benchmark:** compare nightly runs against the previous report ([9fbd520](https://github.com/doberkofler/codeindex-mcp/commit/9fbd520934b33baeb17b4dc1eeee352fccd08946))
* **benchmark:** gate generated corpus counts without a reference ([8d85a89](https://github.com/doberkofler/codeindex-mcp/commit/8d85a898907ff9eb33ed0982e8750cccf961a507))
* **benchmark:** mark generated corpora and reject unrelated workspaces ([fb355f0](https://github.com/doberkofler/codeindex-mcp/commit/fb355f08dd13a20d2af79b2ce55721acd8305b69))
* **benchmark:** poll without retaining promise chains ([207adc0](https://github.com/doberkofler/codeindex-mcp/commit/207adc0a61ac5648aeb088dee0a85c732c258abd))
* **benchmark:** remove temporary workspaces on failure ([064395c](https://github.com/doberkofler/codeindex-mcp/commit/064395ce8281c3d4cedc4f9d5ee64bf6bd602922))
* **benchmark:** replace polling loop with recursive poll ([2401fda](https://github.com/doberkofler/codeindex-mcp/commit/2401fda0ad6194198832ee8000bdd555c0e261e5))
* **benchmark:** validate reference schema and workspace identity ([f668a9c](https://github.com/doberkofler/codeindex-mcp/commit/f668a9c378234b7f523aa48853899016580205fe))
* **cleanup:** refuse deletion while a database owner is alive ([2bd6987](https://github.com/doberkofler/codeindex-mcp/commit/2bd6987020900ad557ad23274afd4eee2d041ad6))
* **config:** resolve project file overrides from the working directory ([568865d](https://github.com/doberkofler/codeindex-mcp/commit/568865d8657372eb5f32ac61711e241ccc6b571a))
* **console:** enable unicode regex flag in chunk groups ([445cec3](https://github.com/doberkofler/codeindex-mcp/commit/445cec335d503d166658b798569155c5344cb768))
* **console:** manage trigger focus for MUI overlays ([7dbe727](https://github.com/doberkofler/codeindex-mcp/commit/7dbe7270f104f0e4ef06ed00e5527b26a4bd065a))
* **console:** split vendor chunks to stay under size limit ([3396d12](https://github.com/doberkofler/codeindex-mcp/commit/3396d1209bb92577e258e2e36fdca184b27d354d))
* **console:** validate API responses with Zod ([dfd9d65](https://github.com/doberkofler/codeindex-mcp/commit/dfd9d65b64e5bef23d159065b97a0c9c9fb66b9d))
* **console:** validate origins against the allocated port ([98383b8](https://github.com/doberkofler/codeindex-mcp/commit/98383b8f60e79aa854d8fe778e4763f92fc82004))
* **index:** require a live lease before publication ([59c9cca](https://github.com/doberkofler/codeindex-mcp/commit/59c9ccadee5d0b76f73077113d8bd862642c39e0))
* **index:** serialize manual and background refreshes ([866fbb7](https://github.com/doberkofler/codeindex-mcp/commit/866fbb71b296a7c4dfbd28b2fb44e4503671d4a1))
* **mcp:** bound error envelopes and hide internal messages ([29d9a22](https://github.com/doberkofler/codeindex-mcp/commit/29d9a222ecaf3dbd7340dd23282d5bec3d8f0403))
* **mcp:** bound read_symbol source to the response envelope ([f1a1553](https://github.com/doberkofler/codeindex-mcp/commit/f1a15536b6d3f4d7af795ec176629983e9bd002d))
* **scan:** skip deleted indexed paths during refresh ([bfc5ee7](https://github.com/doberkofler/codeindex-mcp/commit/bfc5ee744e931043a462b78b0fdeb1a9d4365562))
* **scan:** watch TypeScript config chains through compiler resolution ([edcecdd](https://github.com/doberkofler/codeindex-mcp/commit/edcecdded07eb38b06c62e55da49058f97bd2885))
* **storage:** inject VCS provenance at composition roots ([6a97c52](https://github.com/doberkofler/codeindex-mcp/commit/6a97c527b76ffc7a839be93e3e374c660bd2024c))
* **storage:** persist workspace-relative identity paths ([cf11beb](https://github.com/doberkofler/codeindex-mcp/commit/cf11beb729239ace45bbf5334debf0df6355a2b5))
* **typescript:** verify imported source identity against compiler text ([52b2cc2](https://github.com/doberkofler/codeindex-mcp/commit/52b2cc2449b42caf9728a04305abae58b50c460a))

### Changed

* **benchmark:** extract gate and compatibility modules ([0cf4afd](https://github.com/doberkofler/codeindex-mcp/commit/0cf4afd1184c816c397b525b4e6531e6e99b88d5))

### Documentation

* **benchmark:** describe retained reference identity ([3200c5f](https://github.com/doberkofler/codeindex-mcp/commit/3200c5f412c4bd3f89a414af7690928b73dd3c5e))

## [0.2.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.1.3...v0.2.0) (2026-10-19)

### Added

* index multiple TypeScript project contexts ([8006ca7](https://github.com/doberkofler/codeindex-mcp/commit/8006ca785d5ee42ae1db86c69922ce6f3d6480ef))

### Changed

* restructure source tree around adapters and transports ([e0d57a9](https://github.com/doberkofler/codeindex-mcp/commit/e0d57a9d9e6225bdaffc8bcb6f104a7c438c4a6f))

### Documentation

* document multi-language adapter roadmap ([515f887](https://github.com/doberkofler/codeindex-mcp/commit/515f887e0921bc15b967058a47586ee8dbf5ed91))

### Fixed

* derive the reported version from the package manifest instead of a stale literal

## [0.1.3](https://github.com/doberkofler/codeindex-mcp/compare/v0.1.2...v0.1.3) (2026-10-18)

### Fixed

* report the program version instead of a stale constant ([fa3b3bf](https://github.com/doberkofler/codeindex-mcp/commit/fa3b3bfe29b116fd919264f2496b812ff97063ea))

## [0.1.2](https://github.com/doberkofler/codeindex-mcp/compare/v0.1.1...v0.1.2) (2026-10-18)

### Added

* add explicit MCP path to install command ([d3aac33](https://github.com/doberkofler/codeindex-mcp/commit/d3aac33d68a67b780a2e6f11ba0915bcadc21089))

## [0.1.1](https://github.com/doberkofler/codeindex-mcp/compare/v0.1.0...v0.1.1) (2026-10-18)

### Added

* add CodeIndex configuration support to MCP install ([4374da3](https://github.com/doberkofler/codeindex-mcp/commit/4374da36e69c7eb1e945a117d9380df29cfc2e87))

### Documentation

* add architecture, user, and evaluation documentation ([fd2f184](https://github.com/doberkofler/codeindex-mcp/commit/fd2f1846f142bd5a4fcdedebeb63fe826c46bb8b))

## 0.1.0 (2026-10-18)

### Added

* initialize CodeIndex MCP 0.1.0 ([dc5c27d](https://github.com/doberkofler/codeindex-mcp/commit/dc5c27dae658d2989a8477fda10f7d3488c92f06))
