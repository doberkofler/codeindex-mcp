# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
