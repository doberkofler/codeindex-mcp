# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.6.0...v0.7.0) (2026-10-24)

### Added

* **evaluation:** retain reference-workstation baseline ([e95e18e](https://github.com/doberkofler/codeindex-mcp/commit/e95e18ef283745c97d23efacf0c8a15ca5a4bc2e))

### Fixed

* **evaluation:** settle every started provider request ([d72b668](https://github.com/doberkofler/codeindex-mcp/commit/d72b668918416dc17c2df716b05296800b981cff))
* **facts:** keep one site per binding at a shared source location ([74db2e7](https://github.com/doberkofler/codeindex-mcp/commit/74db2e747a10d6b0e2fe8f4377acde871afcdc2b))
* **generation:** take over expired build leases ([a301f4d](https://github.com/doberkofler/codeindex-mcp/commit/a301f4dd94cc0d7f60c8b7a4fe2365ef58a7f1f2)), references [#49](https://github.com/doberkofler/codeindex-mcp/issues/49)
* **storage:** refresh query-planner statistics at publication ([b883a0c](https://github.com/doberkofler/codeindex-mcp/commit/b883a0c7790a4b1ae2bce0ae7bcf446cec044e71))

### Changed

* **query:** restore index-bounded find_symbol and outline pages ([c0816f5](https://github.com/doberkofler/codeindex-mcp/commit/c0816f5e46bee4be08a722f0069b34a97aa9625c))

### Documentation

* consolidate publication and evaluation policy ([dbc5d90](https://github.com/doberkofler/codeindex-mcp/commit/dbc5d9034057b5eb4c2a50de55799c2a67094176))
* document pnpm 12 approvals for GitHub installs ([769fa1e](https://github.com/doberkofler/codeindex-mcp/commit/769fa1e36e268b680d6d23e849b39611e95ffc22))
* move actionable enhancements to service requests ([8e18f58](https://github.com/doberkofler/codeindex-mcp/commit/8e18f5851763360c17ddb780cd1bbe7e490807d4))
* **query:** record PROD-008 evidence and plans ([18d1b3a](https://github.com/doberkofler/codeindex-mcp/commit/18d1b3ac1c9d6b9ccf2a729535f7d0873733cacb)), references [#48](https://github.com/doberkofler/codeindex-mcp/issues/48)

## [0.6.0](https://github.com/doberkofler/codeindex-mcp/compare/v0.5.0...v0.6.0) (2026-10-23)

### Added

* add isolated OpenCode process runner ([a5eddbe](https://github.com/doberkofler/codeindex-mcp/commit/a5eddbefe2302523c9e7d6df1558c42bcaf58fb0))
* add treatment planning and equivalence validation ([00d6368](https://github.com/doberkofler/codeindex-mcp/commit/00d6368094ee5c7d9450a5f74e5ccb652e1ef4ca))
* add versioned evaluation schemas ([ccffd72](https://github.com/doberkofler/codeindex-mcp/commit/ccffd728d07f88a36ae4340e7f163b45083d6131))
* **evaluation:** add CodeIndex repository cases ([0201bb5](https://github.com/doberkofler/codeindex-mcp/commit/0201bb58d4fd76b8fc256fc6fede0fd632be2976))
* **evaluation:** add controlled TypeScript semantic cases ([1118faf](https://github.com/doberkofler/codeindex-mcp/commit/1118faf196d3493a579165a31cf1449ace3064df))
* **evaluation:** add deterministic operational soak and recovery ([2c0680f](https://github.com/doberkofler/codeindex-mcp/commit/2c0680fa2b7e1e9961992846889180177a1ab0ca))
* **evaluation:** add final frontier certification ([6f3218d](https://github.com/doberkofler/codeindex-mcp/commit/6f3218d4a779e229faff3bc98260cd4b7ec0f7a7))
* **evaluation:** add fixed-artifact local-model qualification ([64e608a](https://github.com/doberkofler/codeindex-mcp/commit/64e608a033457a71f3aad9859b65c88084f4ca49))
* **evaluation:** add paired reports, statistics, and harness verification ([c0d565d](https://github.com/doberkofler/codeindex-mcp/commit/c0d565d20e9ec264290bc0a37a5d816e7eb70b71))
* **evaluation:** add validity gates and disjoint A/A calibration ([e8baa94](https://github.com/doberkofler/codeindex-mcp/commit/e8baa9491856a8edffa4448d5bfdb70c92f70fba))
* **evaluation:** automate targeted diagnostics and local regression ([af3c3af](https://github.com/doberkofler/codeindex-mcp/commit/af3c3af9e55100139d3f09b96d53dbdbc17e414c))
* **evaluation:** calibrate local model candidates ([18334bb](https://github.com/doberkofler/codeindex-mcp/commit/18334bb8b7ede2823ac9561ae5d299b947f7b6ce))
* **evaluation:** decouple hosted release from local regression ([5001906](https://github.com/doberkofler/codeindex-mcp/commit/5001906810c7d316baa2de7ee08959c98630ce4d))
* **evaluation:** freeze cost-valid metric contract ([2c2a886](https://github.com/doberkofler/codeindex-mcp/commit/2c2a886f64c74aec42c85e68af323d66f75a5e11))
* **evaluation:** freeze release suite and calibration subset ([3eda766](https://github.com/doberkofler/codeindex-mcp/commit/3eda766df9c617bd262622e9f46fa8e75ee79942))
* **evaluation:** guarantee request-1 MCP readiness and surface ([68a391b](https://github.com/doberkofler/codeindex-mcp/commit/68a391bf7aae3b25673f0f7d03061392badf6d61))
* **evaluation:** implement complete-route model-free comparison ([fb8fa58](https://github.com/doberkofler/codeindex-mcp/commit/fb8fa580f14c918f0c8b3576730de1c6e249deac))
* **evaluation:** isolate corpus staging and preflight every case ([c62cec8](https://github.com/doberkofler/codeindex-mcp/commit/c62cec89a4e69782ab947d64cbaffa5c16f366de))
* **evaluation:** meter every provider request and task cost ([6fd1e91](https://github.com/doberkofler/codeindex-mcp/commit/6fd1e91bbdf1e9bf1afb43c5d51d3e46770650cd))
* **evaluation:** persist atomic results and resume by complete identity ([1679dc9](https://github.com/doberkofler/codeindex-mcp/commit/1679dc9159bb957b2caa7a10a3cd0f45990f8a63))
* **evaluation:** pilot and select the external corpus ([9179df3](https://github.com/doberkofler/codeindex-mcp/commit/9179df35f4099dcc0cfbcdd4cc969e0f06f77fc7))
* **evaluation:** pin hosted reference and gate release campaign ([0535a91](https://github.com/doberkofler/codeindex-mcp/commit/0535a91ad23ef54e569a21755549e1c531fc1040))
* **evaluation:** pin local-model environment and run accepted smoke ([dcbb340](https://github.com/doberkofler/codeindex-mcp/commit/dcbb340b79197af2f81b3b936ea8bf80cdd3472f))
* **evaluation:** repair calibration and qualify regression sentinel ([9eff11b](https://github.com/doberkofler/codeindex-mcp/commit/9eff11bf38a95139f65520461290823bab42829b))
* **evaluation:** run budgeted A/B development pilot ([7d04def](https://github.com/doberkofler/codeindex-mcp/commit/7d04def953c80b3f8b8e2fd6eabbb48652f8b66b))
* **events:** normalize agent events and token telemetry ([0818e0d](https://github.com/doberkofler/codeindex-mcp/commit/0818e0d822f67c83cd4ef4e0d580eebba9d794ac))
* **facts:** introduce publication fact seam ([a678d4a](https://github.com/doberkofler/codeindex-mcp/commit/a678d4a6f708de722374a1fac9416588bbab23ab))
* **grade:** add exact correctness and workflow graders ([03d25ea](https://github.com/doberkofler/codeindex-mcp/commit/03d25ea63b757e2e8be3230815858f4d27e0bc98))
* harden queue processing ([a82cf1e](https://github.com/doberkofler/codeindex-mcp/commit/a82cf1e17d5274a78673636c781d4c996725c256))
* implement one-call grouped find_references results ([703b36f](https://github.com/doberkofler/codeindex-mcp/commit/703b36f5670f18b6e5400fe5ca83e1e16a88afde))
* **mcp:** add bounded status summary and authoritative result guidance ([e74254b](https://github.com/doberkofler/codeindex-mcp/commit/e74254b42ce3583966a9e5acab1323db33083de5))
* **mcp:** default outline and find_symbol to compact detail ([fed1b6e](https://github.com/doberkofler/codeindex-mcp/commit/fed1b6e499e6a8a171c6300d262eed85daf8520c))
* **oracle:** add ANTLR performance profiling and SLL fallback ([7573a8b](https://github.com/doberkofler/codeindex-mcp/commit/7573a8bb5e69eceb14f9eed0912185cbd5b77505))
* **oracle:** add ANTLR references, dependencies, and qualification v2 ([ad8faff](https://github.com/doberkofler/codeindex-mcp/commit/ad8faff439b20ff92bcfcbfdf7870dca22804fd0))
* **oracle:** add phase 8 parser selection and quality evidence ([76961fe](https://github.com/doberkofler/codeindex-mcp/commit/76961feb140504e9f5d79143d0aa4b090954c8e8))
* **oracle:** add pinned ANTLR parser and freeze phase 0 baseline ([0eef4ce](https://github.com/doberkofler/codeindex-mcp/commit/0eef4ce18548bdd363a98e78b4143d859f0cf759))
* **publication:** add independent G-A2 source association ([82f9ff9](https://github.com/doberkofler/codeindex-mcp/commit/82f9ff9f5b64bf189d6d782b6e76ee45eb364586))
* **publication:** add phase 2 measurement and prototypes ([c26a7ab](https://github.com/doberkofler/codeindex-mcp/commit/c26a7abc6a29769764d12f183e87188417dc54b8))
* **publication:** add schema and persistence for finalized facts ([34b3cba](https://github.com/doberkofler/codeindex-mcp/commit/34b3cbabda1fdb1d77c4f55eff19c2a0975bdce1))
* **publication:** complete evidence checkpoint ([fa0440f](https://github.com/doberkofler/codeindex-mcp/commit/fa0440f0be55f494bff3e5163ec7717b170434c6))
* **publication:** implement Oracle vertical slice ([76cf51f](https://github.com/doberkofler/codeindex-mcp/commit/76cf51fde98b97b62aa5f17104a0622b1905f3b0))
* **publication:** implement Phase 6 defaults and enforcement ([bf4db6f](https://github.com/doberkofler/codeindex-mcp/commit/bf4db6f2193d279b566c8f3de343556c98367be4))
* **publication:** implement TypeScript vertical slice ([8a663a0](https://github.com/doberkofler/codeindex-mcp/commit/8a663a08da140b033b2f182b65f4936ce4179d31))
* **publication:** record provisional per-root ceilings ([8785b81](https://github.com/doberkofler/codeindex-mcp/commit/8785b81cbd05ad71bcd7afa6c07a60003e6fbd46))
* **qualification:** recompile installed Oracle objects for live qualification ([76e0174](https://github.com/doberkofler/codeindex-mcp/commit/76e017471fa1bc60a1be24db41f0a56ba697486c))
* **qualification:** report Oracle apply progress as steps with ETA ([08fadd4](https://github.com/doberkofler/codeindex-mcp/commit/08fadd442cbe62096e46323ac4d70aa89acd5650))
* **qualification:** run Oracle live qualification from a source root ([ecfdaa0](https://github.com/doberkofler/codeindex-mcp/commit/ecfdaa0146fd023ec592042598eb55fbd276df83))
* **qualification:** stream Oracle recompilation progress ([ef3fe71](https://github.com/doberkofler/codeindex-mcp/commit/ef3fe71dac0eabd715a7cc11c4b28dac5c45bc0b))
* **queue:** expose logs and tool details ([62a6224](https://github.com/doberkofler/codeindex-mcp/commit/62a6224e820aa832490b2b51a40483b16382bf51))
* **scripts:** allow queue model override ([4fcbcc9](https://github.com/doberkofler/codeindex-mcp/commit/4fcbcc921e72f0b3d0d613bf71a0dc91f56a7923))
* **scripts:** default queue runs to deepseek flash ([f007bb8](https://github.com/doberkofler/codeindex-mcp/commit/f007bb8b4a8622147171ed0888a6eb4046ccb8db))
* **scripts:** process GitHub issue queues ([6ff14cf](https://github.com/doberkofler/codeindex-mcp/commit/6ff14cf4f71e1b2c72d8fe87a393088cbf4eec4b))
* **scripts:** stream queue progress and persist logs ([c2e09cf](https://github.com/doberkofler/codeindex-mcp/commit/c2e09cfd5be673dc104fafaa4ad8a00b467fd940))
* verify checkout restoration and artifacts ([e0a788d](https://github.com/doberkofler/codeindex-mcp/commit/e0a788d712d8adae5210345daeb19b207e58a9cd))

### Fixed

* **ci:** declare the hosted pull-request budget instead of inheriting the reference one ([4e68ae6](https://github.com/doberkofler/codeindex-mcp/commit/4e68ae639cce21f5bebfd5a1ec3c3bfcf9add86b))
* **evaluation:** add current CodeIndexError reference case ([f7514b3](https://github.com/doberkofler/codeindex-mcp/commit/f7514b317b86de1b59bb0583cd2740898d385fe9))
* **evaluation:** aggregate treatments in one campaign identity ([6d42666](https://github.com/doberkofler/codeindex-mcp/commit/6d42666fca554fd32ef96092775550698283afe5))
* **evaluation:** clean up detached MCP processes ([0e3ea2a](https://github.com/doberkofler/codeindex-mcp/commit/0e3ea2a7b356b42454d16f0fec17d64e537a796e))
* **evaluation:** close private servers on termination ([a9656b2](https://github.com/doberkofler/codeindex-mcp/commit/a9656b293054c095fb570d93015f75022994b2ed))
* **evaluation:** correct non-inferiority direction ([63a46d7](https://github.com/doberkofler/codeindex-mcp/commit/63a46d74a659408e1f684e3edb51869e69e4f8cf))
* **evaluation:** enforce request-1 surface retries ([080a2e9](https://github.com/doberkofler/codeindex-mcp/commit/080a2e986e2f6c931d041155866c40111e45e725))
* **evaluation:** gate the diagnostic on artifact-controlled metrics ([8a39c47](https://github.com/doberkofler/codeindex-mcp/commit/8a39c4761cc44d67a8fd28aa103f79fe94d7f7e5))
* **evaluation:** isolate route contract probes by database ([0f6014a](https://github.com/doberkofler/codeindex-mcp/commit/0f6014acf94e5ae3a7b54463d495bc2ec34d2dfe))
* **evaluation:** replay timeouts explicitly and pace only live slots ([b0368d5](https://github.com/doberkofler/codeindex-mcp/commit/b0368d57e22c2e3e5eabf4f867caa6b751b5089a))
* **evaluation:** require complete diagnostic slot coverage ([7a77506](https://github.com/doberkofler/codeindex-mcp/commit/7a77506c7bc42ce5d700b556a6a1a1906acde4b0))
* **evaluation:** stop certification when the route gate fails ([653fc6c](https://github.com/doberkofler/codeindex-mcp/commit/653fc6ce6248ad190949ef7ab027e97f8241aa8d))
* **evaluation:** use raw strings for search patterns ([11ac12d](https://github.com/doberkofler/codeindex-mcp/commit/11ac12d85ae45398e99279fa2871e2e95bebb2fd))
* **evaluation:** wait for current index freshness in route gates ([c084e06](https://github.com/doberkofler/codeindex-mcp/commit/c084e0604af815cff96b526e444fa62d8532409a))
* **oracle:** close most remaining reference recall gap ([651ef54](https://github.com/doberkofler/codeindex-mcp/commit/651ef54a5412162b4e6aabca35c18104191e41d9))
* **oracle:** eliminate reference qualification extras ([2bccd12](https://github.com/doberkofler/codeindex-mcp/commit/2bccd12468f08a68c4ab78236d5afd525f2e0ef0))
* **oracle:** pass publication gates on the frozen corpus ([ffccba0](https://github.com/doberkofler/codeindex-mcp/commit/ffccba0dec184210103817c5cff7694af78357ac))
* **publication:** pass full-corpus G-A2 gates ([01dcc36](https://github.com/doberkofler/codeindex-mcp/commit/01dcc369e0220ac03e4cf73206ffe1f1412518a0))
* **publication:** pass VS Code G-A2 source association ([1863901](https://github.com/doberkofler/codeindex-mcp/commit/1863901e75982ba0424f3594652378e820e982bb))
* **qualification:** fail when an approved dependent cannot be restored ([135fe79](https://github.com/doberkofler/codeindex-mcp/commit/135fe79cebda5c50628eefc375c2db6e5cc305e0))
* **qualification:** filter Oracle plans to installed objects ([4ca694f](https://github.com/doberkofler/codeindex-mcp/commit/4ca694f6a9ad942557e0d4a5c4b7733681085d88))
* **qualification:** match Oracle candidates by installed source ([df1e349](https://github.com/doberkofler/codeindex-mcp/commit/df1e349b1b9c66edf1c669719e3bfb133d0bcb2c))
* **qualification:** print a runnable apply command ([90d80b2](https://github.com/doberkofler/codeindex-mcp/commit/90d80b21e0ce3d8803fb868253c55c449b8a1341))
* **qualification:** reconcile invalid objects against a pre-DDL baseline ([4486bfd](https://github.com/doberkofler/codeindex-mcp/commit/4486bfdf3a46d1c3a3d2c422f812c01c64d7d522))
* **qualification:** topologically restore Oracle dependents ([f868d3c](https://github.com/doberkofler/codeindex-mcp/commit/f868d3c6e4cef3e5a21369e738409992d40cca62))
* **runner:** release pipes when a descendant escapes the group ([d58d8e5](https://github.com/doberkofler/codeindex-mcp/commit/d58d8e5992a23675e4e58a60c95059c8cb2bd51f))
* **scripts:** harden queue processing ([30f8ab7](https://github.com/doberkofler/codeindex-mcp/commit/30f8ab7716b33105275caf80fb2e920d47f951dc))
* **scripts:** protect queue from agent edits ([e30f9d6](https://github.com/doberkofler/codeindex-mcp/commit/e30f9d64b04c48a271ab6304b510af507b5b60b5))
* **scripts:** run available opencode binary unattended ([fbc853a](https://github.com/doberkofler/codeindex-mcp/commit/fbc853ab44caaf7aa28131f29169ed3f9ab66f27))
* **soak:** canonicalize workspace root so injected failure is observed ([327d466](https://github.com/doberkofler/codeindex-mcp/commit/327d466e58bad59cdaa33b145c01c8001d0efa74))

### Changed

* **cli:** consolidate command parsing on Commander ([5663fea](https://github.com/doberkofler/codeindex-mcp/commit/5663fead778b2a08931dc24d85d7123458a5ce54))
* **evaluation:** host the harness in the public workspace ([0d32844](https://github.com/doberkofler/codeindex-mcp/commit/0d328442857cdd499fab302ecf305c80d3b79841))
* **evaluation:** lint and typecheck the harness in the standard gate ([d52b095](https://github.com/doberkofler/codeindex-mcp/commit/d52b095453f72386ec85550f12e8800fa0a9f0b7))
* **evaluation:** unify harness type rules and tests on vitest ([b8c07d3](https://github.com/doberkofler/codeindex-mcp/commit/b8c07d3fe84a9f560b66e0b196bde11b327b5951))
* **freshness:** adopt Chokidar for workspace watching ([0fa0c04](https://github.com/doberkofler/codeindex-mcp/commit/0fa0c04a5abdf61901aa57c44737c0d3eca23a65))
* **oracle:** remove SQL*Plus from live qualification ([edd301e](https://github.com/doberkofler/codeindex-mcp/commit/edd301e4e9317ddb5fcf4cd797237588caefb5f7))
* **qualification:** adopt CSV codec libraries ([2a9efda](https://github.com/doberkofler/codeindex-mcp/commit/2a9efda75c434750393d3518178a457078c3065d))

### Documentation

* accept publication policy contract ([158c70d](https://github.com/doberkofler/codeindex-mcp/commit/158c70d58bcc9b3b9ece3ccaa0caf23fd10fc136))
* add dependency removal enhancement backlog ([0e4abbf](https://github.com/doberkofler/codeindex-mcp/commit/0e4abbf3d868e38074676ab56f5a9090558f6178))
* add evaluation strategy and v1 scope ([3e8698e](https://github.com/doberkofler/codeindex-mcp/commit/3e8698e3c293b96f8d5d1ec32a828c4c6efa54cf))
* add post-release monitoring and rollback triggers ([374f283](https://github.com/doberkofler/codeindex-mcp/commit/374f28399c94e41d1422769f67a881f95ee5f6bb))
* add publication policy progress tracker ([29c2394](https://github.com/doberkofler/codeindex-mcp/commit/29c239433ad94a932a42eb71fbd024a08c4db044))
* catalogue every test fixture ([5ebc11a](https://github.com/doberkofler/codeindex-mcp/commit/5ebc11ad6f2ac08f61cd91e0d487ba5f60cbd40d))
* codify evaluation execution contract ([2132676](https://github.com/doberkofler/codeindex-mcp/commit/2132676bdf807693684cf668ed68437dded2036c))
* consolidate publication policy redesign ([584cda3](https://github.com/doberkofler/codeindex-mcp/commit/584cda3b1b87e0d0968fcdf943553931dd3acf14))
* define evaluation result and identity contract ([9643b53](https://github.com/doberkofler/codeindex-mcp/commit/9643b5384da67f8d4c3b8a1e579d649eee691390))
* **evaluation:** align the local diagnostic contract ([7f0e1e7](https://github.com/doberkofler/codeindex-mcp/commit/7f0e1e718ae3bb358c191736739e42d278f1a51e)), references [pre-#35](https://github.com/pre-/issues/35)
* **evaluation:** audit Q2 case ground truth ([8b79f35](https://github.com/doberkofler/codeindex-mcp/commit/8b79f358701d679722f7f4fdda30c9353e1fd6da))
* **evaluation:** describe normalized agent events ([79d0db5](https://github.com/doberkofler/codeindex-mcp/commit/79d0db5e4e7f3ebb12989638ece3ce54b2e90dff))
* **evaluation:** publish final frontier certification ([e29bc3d](https://github.com/doberkofler/codeindex-mcp/commit/e29bc3d75e05ce63417a223d98c0d176ee0dc7f4))
* **evaluation:** record E3 validity correction ([9ec26cb](https://github.com/doberkofler/codeindex-mcp/commit/9ec26cb702ea8bc361c95b066be3a4107e6a3cc1))
* **evaluation:** record model-free accepted-versus-candidate gate ([b9f5f08](https://github.com/doberkofler/codeindex-mcp/commit/b9f5f080003c4a3ac9f63f85831298f2346da4fc))
* **evaluation:** record the E3 frontier release campaign ([fe414b4](https://github.com/doberkofler/codeindex-mcp/commit/fe414b4a8858875aba120048c0b601b0d69620e7))
* **evaluation:** record the E3 targeted diagnostic ([9c7c368](https://github.com/doberkofler/codeindex-mcp/commit/9c7c3682622e60460e93c5a7a1202b59a1a1fe3e))
* **evaluation:** specify correctness and workflow graders ([9be2c66](https://github.com/doberkofler/codeindex-mcp/commit/9be2c661407634a49fec26d652b15ff77109be2b))
* **evaluation:** split model qualification from release gate ([88f3bde](https://github.com/doberkofler/codeindex-mcp/commit/88f3bdee9c1d04bc0fc355c9207d0d5db2929583))
* **test:** correct the inventory file total ([1d9aebd](https://github.com/doberkofler/codeindex-mcp/commit/1d9aebd6d5ed03b12a791c150340a594ed875ff8))
* **test:** inventory tests by class and ownership ([9a03ce1](https://github.com/doberkofler/codeindex-mcp/commit/9a03ce1b569f432b951e948c3ed40771f83f86f0))
* update publication redesign follow-up ([8fdc407](https://github.com/doberkofler/codeindex-mcp/commit/8fdc4077c513db94a49ebef4b3f91df95909f14e))

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
