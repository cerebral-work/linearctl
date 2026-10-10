# Changelog

## [0.18.0](https://github.com/cerebral-work/linearctl/compare/v0.17.0...v0.18.0) (2026-10-10)


### Features

* model the projectUnarchive issue cascade and plan the archived-project sandwich ([d3848f4](https://github.com/cerebral-work/linearctl/commit/d3848f4d45252d952bd4c9a4e188f620e704b8cb))
* model the projectUnarchive issue cascade and plan the archived-project sandwich ([2ceffcb](https://github.com/cerebral-work/linearctl/commit/2ceffcba73d7d512dc8631195b086b479042ed1d))


### Bug Fixes

* warn on sandwich plans and keep the triple atomic through the phase-5 reorder ([7b02457](https://github.com/cerebral-work/linearctl/commit/7b0245796be4dc54931278ca895110c0bab47e7e))

## [0.17.0](https://github.com/cerebral-work/linearctl/compare/v0.16.0...v0.17.0) (2026-10-10)


### Features

* refuse archived-project, open-issue archive, and last-team ops in reorg --check ([ba01eef](https://github.com/cerebral-work/linearctl/commit/ba01eeff46c7058d719403ed9bd42ebf6683fb2a))
* refuse archived-project, open-issue archive, and last-team ops in reorg --check ([2bc70d9](https://github.com/cerebral-work/linearctl/commit/2bc70d949e280d9457ff0de140ea8ecff2010c9e))

## [0.16.0](https://github.com/cerebral-work/linearctl/compare/v0.15.0...v0.16.0) (2026-10-09)


### Features

* **cli:** add dedicated linearctl relate command and blocking relations ([3a91c55](https://github.com/cerebral-work/linearctl/commit/3a91c552e4a895c886a5ee1bf190d1b5e206b242))
* **cli:** add dedicated linearctl relate command and blocking relations ([d482fbb](https://github.com/cerebral-work/linearctl/commit/d482fbb69dfe33dcb15cc23c60f2c370e6b0718e))

## [0.15.0](https://github.com/cerebral-work/linearctl/compare/v0.14.0...v0.15.0) (2026-10-09)


### Features

* **operator:** add configurable probe connect timeout for readiness and liveness ([833901f](https://github.com/cerebral-work/linearctl/commit/833901f8aa78f9d4bf9b6de2f6301c677b2d9b4c))
* **operator:** add configurable probe connect timeout for readiness and liveness ([4baf1fd](https://github.com/cerebral-work/linearctl/commit/4baf1fdacef2ab27d92de3c1fe54258a44c42267))

## [0.14.0](https://github.com/cerebral-work/linearctl/compare/v0.13.1...v0.14.0) (2026-10-09)


### Features

* **cache:** add offline viewer resolution for assignee me and team funnel index ([7c67a04](https://github.com/cerebral-work/linearctl/commit/7c67a043f176cad9080d0a66372594fc5626201a))
* **cache:** offline viewer resolution for assignee me and team funnel index ([1654eba](https://github.com/cerebral-work/linearctl/commit/1654ebacccefb1bf2e8ef0943443958996bd4753))

## [0.13.1](https://github.com/cerebral-work/linearctl/compare/v0.13.0...v0.13.1) (2026-10-09)


### Documentation

* author product and architecture roadmap ([b13c23e](https://github.com/cerebral-work/linearctl/commit/b13c23ee27028d24b14e1295ab9c0ced55aa90c6))
* author product and architecture roadmap ([8337014](https://github.com/cerebral-work/linearctl/commit/8337014b03d32e6814032f22362c6978a468c3a4))

## [0.13.0](https://github.com/cerebral-work/linearctl/compare/v0.12.0...v0.13.0) (2026-10-09)


### Features

* **team:** add team list and resolve commands with cache support ([#28](https://github.com/cerebral-work/linearctl/issues/28)) ([b70a7f9](https://github.com/cerebral-work/linearctl/commit/b70a7f98bdb048b128d2b27c1a6ea74517af87b9))
* **team:** add team list and resolve commands with cache support ([#28](https://github.com/cerebral-work/linearctl/issues/28)) ([249dea7](https://github.com/cerebral-work/linearctl/commit/249dea720a85342d44d166bb33b88df6682c0e4e))


### Bug Fixes

* **reorg:** re-read after a batch write error and accept landed members ([00cd4ed](https://github.com/cerebral-work/linearctl/commit/00cd4edc7301cee163528b43308f3a130dd896c0))
* **reorg:** re-read after a batch write error and accept landed members ([3382035](https://github.com/cerebral-work/linearctl/commit/33820354f2bc0769bfc3534ce122eb26000c4226))

## [0.12.0](https://github.com/cerebral-work/linearctl/compare/v0.11.1...v0.12.0) (2026-10-08)


### Features

* **cache:** add verification suite, latency benchmarks, and documentation (CER-2662, CER-2663, CER-2664) ([4d3c35d](https://github.com/cerebral-work/linearctl/commit/4d3c35d7625282fba7919255116c9e45ea3c2595))
* **cache:** add verification suite, latency benchmarks, and documentation (Phase 5) ([a536478](https://github.com/cerebral-work/linearctl/commit/a5364781eebe83f658650846745145518ca4a120))

## [0.11.1](https://github.com/cerebral-work/linearctl/compare/v0.11.0...v0.11.1) (2026-10-07)


### Bug Fixes

* **docker:** copy examples/ into the image build context ([84e6db1](https://github.com/cerebral-work/linearctl/commit/84e6db18f2c86f4484667c952febbf48904119a6))
* **docker:** copy examples/ into the image build context ([a3a6b60](https://github.com/cerebral-work/linearctl/commit/a3a6b6018c09357cc937ad8181b1005df801439d))
* **docker:** run on distroless base-nossl, drop the unused libssl3 ([ef90d18](https://github.com/cerebral-work/linearctl/commit/ef90d18009707d9e3ec6d76f2a3e077e0a766c16))
* **docker:** run on distroless base-nossl, drop the unused libssl3 ([c3ce2bd](https://github.com/cerebral-work/linearctl/commit/c3ce2bd34a51bfa690f30553745c96b79279b5eb))

## [0.11.0](https://github.com/cerebral-work/linearctl/compare/v0.10.6...v0.11.0) (2026-10-07)


### Features

* **cache:** implement local ticket copy ORM cache with SQLite and Drizzle ([8738de2](https://github.com/cerebral-work/linearctl/commit/8738de2b2cb0a622de8fb3cd53e055df5fd11737))
* **cache:** implement local ticket copy ORM cache with SQLite and Drizzle ([e6840cb](https://github.com/cerebral-work/linearctl/commit/e6840cb0a73c1a396e6de73d0c41bc8b21cba0f8))

## [0.10.6](https://github.com/cerebral-work/linearctl/compare/v0.10.5...v0.10.6) (2026-10-06)


### Bug Fixes

* **reorg:** record state inheritance in the census and plan around inherited views ([39bf4b2](https://github.com/cerebral-work/linearctl/commit/39bf4b226fe91e7cc4d83f422fbea16abb0dabf9))

## [0.10.5](https://github.com/cerebral-work/linearctl/compare/v0.10.4...v0.10.5) (2026-10-06)


### Bug Fixes

* **io:** read stdin from fd 0 so file redirects are not silently dropped ([fac3589](https://github.com/cerebral-work/linearctl/commit/fac358914eac2075886683d44b92953d76804466))
* **io:** read stdin from fd 0 so file redirects are not silently dropped ([d7046ac](https://github.com/cerebral-work/linearctl/commit/d7046ac38dca40d53e300d9da0e8922403e1e033))
* **reorg:** re-read after a write error; stop when a delete did not land ([0c01d5a](https://github.com/cerebral-work/linearctl/commit/0c01d5a6420aa16e9e71d9155d78c62b0afdcd09))
* **reorg:** stop when a delete's re-read still finds the target ([ba14a00](https://github.com/cerebral-work/linearctl/commit/ba14a00aebc38a8af9fd3aa8c5d8a509f11e2c29))

## [0.10.4](https://github.com/cerebral-work/linearctl/compare/v0.10.3...v0.10.4) (2026-10-06)


### Bug Fixes

* **ci:** evaluate all command segments in guard-main-push ([bbd41a1](https://github.com/cerebral-work/linearctl/commit/bbd41a16bdb238ba1c6b8fdbbea42357885299d7))
* **ci:** guard-main-push joins backslash-newline continuations, narrows fail-closed ([bf04409](https://github.com/cerebral-work/linearctl/commit/bf0440994f4dcd9f0898503e8dddb0eaff307dc2))
* **ci:** guard-main-push parses git -C push and stops worktree false-positive ([c326124](https://github.com/cerebral-work/linearctl/commit/c3261247721f505946993e040c242dbf2e2bc473))
* **ci:** guard-main-push parses git -C push and stops worktree false-positive ([fc1a61d](https://github.com/cerebral-work/linearctl/commit/fc1a61deeee53c4b0ffcacf027fbda848518103d))
* **ci:** guard-main-push performance and command-substitution gaps ([25dcfaf](https://github.com/cerebral-work/linearctl/commit/25dcfaf2d01bd4a3c4ddd583d43fd7e65a82ab2e))
* **reorg:** mark a census partial when a scan stalls on a stuck cursor ([ccca6e1](https://github.com/cerebral-work/linearctl/commit/ccca6e1e24070501a1fe4d5c83fc4cdc45f2dd03))
* **reorg:** mark a census partial when a scan stalls on a stuck cursor ([5644982](https://github.com/cerebral-work/linearctl/commit/5644982590d3ef4cd478973997ef28a5da806f7c))


### Documentation

* **reorg:** document the stalled-scan partial census and plan warning ([975da04](https://github.com/cerebral-work/linearctl/commit/975da04d2886c36b18570f423d33b7ab868d4aa7))

## [0.10.3](https://github.com/cerebral-work/linearctl/compare/v0.10.2...v0.10.3) (2026-10-06)


### Bug Fixes

* **reorg:** check and dry run refuse mixed batch groups before apply writes ([58c8d6d](https://github.com/cerebral-work/linearctl/commit/58c8d6d123a9ab71cded5fefb9ed785bdced26c3))
* **reorg:** check explains unresolved name: refs whose create has not run ([15f93b7](https://github.com/cerebral-work/linearctl/commit/15f93b71f2435edd7fa87fbcceaee3f7c195a083))
* **reorg:** refuse mixed batch groups in check, dry run and apply before any write ([3e72eaf](https://github.com/cerebral-work/linearctl/commit/3e72eaf2e8522c31e3ae0d858e69d959055a9922))


### Documentation

* **reorg:** document batch grouping and mixed-group refusal ([881d557](https://github.com/cerebral-work/linearctl/commit/881d5576af81b6c8d709b9a1038e01d868283d26))

## [0.10.2](https://github.com/cerebral-work/linearctl/compare/v0.10.1...v0.10.2) (2026-10-05)


### Bug Fixes

* **reorg:** fail closed on unknown team visibility, report allowed changes, document ([aac2059](https://github.com/cerebral-work/linearctl/commit/aac20595377455fed2253d9385cc887d34469dcd))
* **reorg:** private-to-private widens only when the destination gains members ([42aa46d](https://github.com/cerebral-work/linearctl/commit/42aa46d5d46cc7b824e2d5f89c1be9bd50071ebc))
* **reorg:** refuse moves that widen a private team's visibility ([c00cb91](https://github.com/cerebral-work/linearctl/commit/c00cb9159c5c69ba02884ac88b7a49ab512c4a87))
* **reorg:** refuse moves that widen a private team's visibility ([51b603a](https://github.com/cerebral-work/linearctl/commit/51b603abc95d87f8692117e283eb8823dcb517d2))

## [0.10.1](https://github.com/cerebral-work/linearctl/compare/v0.10.0...v0.10.1) (2026-10-05)


### Bug Fixes

* **reorg:** accept moves already completed by a parent's cascade ([968d88b](https://github.com/cerebral-work/linearctl/commit/968d88bb8df9dd7cb2d3917cd94df0d969aa6da9))
* **reorg:** accept moves already completed by a parent's cascade ([e384c88](https://github.com/cerebral-work/linearctl/commit/e384c8804ca943fd894a55196ccdacfc71d2c824))
* **reorg:** case-insensitive label-name preflight + clear case-variant refusal ([f09b39f](https://github.com/cerebral-work/linearctl/commit/f09b39f4a7cde6ca191168b8dd20030fa255afa0))
* **reorg:** case-insensitive label-name preflight + clear case-variant refusal ([2837b26](https://github.com/cerebral-work/linearctl/commit/2837b262345fcb740c05b79584fc2b9765660a75))
* **reorg:** guard the refusal-path conflict re-read ([1a86cc2](https://github.com/cerebral-work/linearctl/commit/1a86cc2c190ddc3552c73325e83650305117c114))
* **reorg:** guard the refusal-path conflict re-read ([e458969](https://github.com/cerebral-work/linearctl/commit/e4589697e115396d35abd9eb79b4d44fcb9a0111))
* **reorg:** limit rollback cascade acceptance to team moves ([7603af4](https://github.com/cerebral-work/linearctl/commit/7603af4111eef4489756685717a349fec4a39326))
* **reorg:** tighten superseded-op rules in verify ([21e4f8d](https://github.com/cerebral-work/linearctl/commit/21e4f8d41428283947488600cb9bcd64f0cca359))
* **reorg:** verify each target against the last op that changed it ([799ffb3](https://github.com/cerebral-work/linearctl/commit/799ffb3fd1ab8220302f41b5ecda96c467facffc))
* **reorg:** verify each target against the last op that changed it ([ccaa9dc](https://github.com/cerebral-work/linearctl/commit/ccaa9dc953cb807a49e8fc371f0fa8dce88a6bfa))

## [0.10.0](https://github.com/cerebral-work/linearctl/compare/v0.9.2...v0.10.0) (2026-10-05)


### Features

* **reorg:** carry source-team labels into the destination on team moves ([3746a8b](https://github.com/cerebral-work/linearctl/commit/3746a8b0fcd8e59ebcdd5551dc5b15ebc75653d8))

## [0.9.2](https://github.com/cerebral-work/linearctl/compare/v0.9.1...v0.9.2) (2026-10-05)


### Bug Fixes

* **reorg:** archive projects instead of trashing them ([f9e0859](https://github.com/cerebral-work/linearctl/commit/f9e0859e21a44ccaf714b7d671c4125fe7ca25d7))
* **reorg:** archive projects instead of trashing them ([bd03449](https://github.com/cerebral-work/linearctl/commit/bd03449a907ac494aa80b9556a002d5c51e3b72c))
* **reorg:** give create-project-status a position and validate mutation inputs against the schema ([e54030a](https://github.com/cerebral-work/linearctl/commit/e54030a1d2c25db96ef2f4f0195488016db34153))


### Documentation

* **reorg:** document archive-project archive-not-trash semantics ([11a8c24](https://github.com/cerebral-work/linearctl/commit/11a8c242c2d1f8cac47dd6acbb0e6eecf3dd43a7))

## [0.9.1](https://github.com/cerebral-work/linearctl/compare/v0.9.0...v0.9.1) (2026-10-05)


### Bug Fixes

* **reorg:** correct GraphQL variable types and filterless lookups ([11cec47](https://github.com/cerebral-work/linearctl/commit/11cec471c5be9ee4a54a2475e9ce09d02a09d0f3))
* **reorg:** correct GraphQL variable types and filterless lookups ([25382b6](https://github.com/cerebral-work/linearctl/commit/25382b65a308262366dc42dd148b9fcb3a34f7c8))
* **reorg:** validate generated documents, guard probe paging, name archived blockers ([02808e2](https://github.com/cerebral-work/linearctl/commit/02808e235fdf8cda6de55c11903a3466acde75f3))

## [0.9.0](https://github.com/cerebral-work/linearctl/compare/v0.8.0...v0.9.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* **backup:** backup verification mismatch and drift now exit 6; backup usage now exits 2 instead of 3.

### Features

* **issues:** add duplicate-of and actionable GraphQL errors (CER-2344) ([bf804a1](https://github.com/cerebral-work/linearctl/commit/bf804a15ac3099699236c05de61efed560090407))
* **issues:** add verified duplicate-of update and close ([ed6181d](https://github.com/cerebral-work/linearctl/commit/ed6181d11126a23ab03c6eb2710de0aee06aa264))
* **milestone:** add membership filters and issue detail ([3f3e617](https://github.com/cerebral-work/linearctl/commit/3f3e617b35b0be92e34141815c6917c6b801a984))
* **reorg:** plan-file-driven workspace reorganization engine ([5be0075](https://github.com/cerebral-work/linearctl/commit/5be00751da25a4d49ed2568651ead11667f6295a))
* **reorg:** planner gaps — label refs, selectors, by-id, three ops, archive-state gating ([dc5f033](https://github.com/cerebral-work/linearctl/commit/dc5f03357f4bd613451e1d0947f465b8297305b8))
* **reorg:** planner gaps — label refs, selectors, by-id, three ops, archive-state gating ([0f1460e](https://github.com/cerebral-work/linearctl/commit/0f1460e05c52d664564a2910c75684516714f64a))
* **reorg:** rename-label op + rename-before-create ordering + --check name preflight ([cdbc460](https://github.com/cerebral-work/linearctl/commit/cdbc460ea18747330662111c6a5b855dd2fac6a2))


### Bug Fixes

* **backup:** align exit codes with the agent contract ([fa14d94](https://github.com/cerebral-work/linearctl/commit/fa14d942d93a8f01b0ff8275ee5191bfaa5e68e5))
* **backup:** correct verification help exit codes ([f252b62](https://github.com/cerebral-work/linearctl/commit/f252b625994dbf502139f2317a95437709fae5eb))
* **cli:** preserve GraphQL user-input diagnostics ([4a1d2f3](https://github.com/cerebral-work/linearctl/commit/4a1d2f37a98b0933d4156f2f85af2478aa5a37d1))
* **issues:** drop the stray --duplicate-of flag on show; neutral fixtures and docs ([bbc0f08](https://github.com/cerebral-work/linearctl/commit/bbc0f08ffe65c32d1530c6278d78273439deff5c))
* **label:** make --limit the prefix of the whole sorted listing ([9c302d2](https://github.com/cerebral-work/linearctl/commit/9c302d2bea79c427c6848d2fe3f5c8d9b56ef0dc))
* **label:** paginate label list and flag truncation (CER-2349) ([8dd3798](https://github.com/cerebral-work/linearctl/commit/8dd3798e230e92074a1ee5792572dbde48210d10))
* **label:** paginate label list and flag truncation (CER-2349) ([8e611be](https://github.com/cerebral-work/linearctl/commit/8e611bef8bd9ee23a368922f7f8a1bedd6d7cd43))
* **project:** stop double-counting paginated listings ([bff8adf](https://github.com/cerebral-work/linearctl/commit/bff8adf079fa75225f7b5d7ccce1fc16869f337e))
* **project:** stop double-counting paginated listings ([930c39d](https://github.com/cerebral-work/linearctl/commit/930c39dffa60fb3ed38a27005b2c046c93de2644))
* **reorg:** check-mode ref guard + propagated-rename preflight exclusion ([8a76b55](https://github.com/cerebral-work/linearctl/commit/8a76b557ca51ba585f2609abcece74b183737ba0))
* **reorg:** check-mode ref guard + propagated-rename preflight exclusion ([bb59a11](https://github.com/cerebral-work/linearctl/commit/bb59a11803bd202ec86d1cad53751e78d881d1af))
* **reorg:** from-completeness + re-decided label scope support ([4b26529](https://github.com/cerebral-work/linearctl/commit/4b26529dd73d3364703c6609bc4faa94d0430942))
* **reorg:** gate rollback behind --apply and fix rename-label inverse ([f1b11f8](https://github.com/cerebral-work/linearctl/commit/f1b11f847e629971283eeec24b46a1390800c192))
* **reorg:** gate rollback behind --apply and restore journaled pre-write state ([f251252](https://github.com/cerebral-work/linearctl/commit/f251252be54ea5bfb93e14d60237e5c755532028))
* **reorg:** inherited-label handling ([8c69a17](https://github.com/cerebral-work/linearctl/commit/8c69a17684159e0976529422fe858c48d88821c3))
* **reorg:** inherited-label handling (CER-2353) ([5aebdee](https://github.com/cerebral-work/linearctl/commit/5aebdeecae434607059847872aaf70fc205e5c86))
* **reorg:** pin batch exclusion; rollback skips already-applied rows by default ([eec3218](https://github.com/cerebral-work/linearctl/commit/eec32187e38a8d36ed0c0cd907d1fa3fc23ac674))
* **reorg:** read every rollback target before the first write ([15d0763](https://github.com/cerebral-work/linearctl/commit/15d07636a9a99008565b8dd65f473dbc5369c9a1))
* **reorg:** refuse rollback of unrecorded fields and unreadable targets before writing ([4465dc4](https://github.com/cerebral-work/linearctl/commit/4465dc4ca70cb8815de25e945ae8d07275140e28))
* **reorg:** restore the census fetch cap and mark a capped census partial ([82af8b7](https://github.com/cerebral-work/linearctl/commit/82af8b7776e19af1201a8326d131aa83ab57e298))
* **reorg:** retry post-write verify and detect already-applied ops ([dc79134](https://github.com/cerebral-work/linearctl/commit/dc79134de94d46ecd1bdaeb21bde4fb63e33035c))
* **reorg:** retry post-write verify and detect already-applied ops ([75c2194](https://github.com/cerebral-work/linearctl/commit/75c219484a4815a83396bf2d1e7ee77f620ae7f3))
* **reorg:** round 1 — census owner inclusion, wider guard, team-aware mapping ([358d865](https://github.com/cerebral-work/linearctl/commit/358d865abe89cba3cafaf45ad13a4585608f5d34))


### Documentation

* **agent:** refresh the listing audit and state what census --limit caps ([6a6c1fa](https://github.com/cerebral-work/linearctl/commit/6a6c1fa8a3f2e0614a69aaf387d8beeb3004b027))
* **agent:** refresh the listing audit and state what census --limit caps ([757d51f](https://github.com/cerebral-work/linearctl/commit/757d51ffad538449d390726dc506c0dfec046a4e))
* **agent:** write the listing contract and audit listings against it ([0b5323f](https://github.com/cerebral-work/linearctl/commit/0b5323f3f697e192a29ead3d6b0d52e92b5e8fc3))
* **agent:** write the listing contract and audit listings against it ([f8f509e](https://github.com/cerebral-work/linearctl/commit/f8f509e8e91b2dd1e981c06fe88ead9a983d2e99))
* **issues:** drop a redundant rollback sentence from the duplicate-of feature doc ([31ef654](https://github.com/cerebral-work/linearctl/commit/31ef654f5685832d79a616dbe54228d314fa72e0))

## [0.8.0](https://github.com/cerebral-work/linearctl/compare/v0.7.0...v0.8.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* **cli:** add agent help, embedded examples, and stable error exits

### Features

* **agent:** role catalog + scheduler + intake-triage + grooming + guardrails (CER-1188 / Track 1) ([b17d601](https://github.com/cerebral-work/linearctl/commit/b17d6019c4b26c901e790fe4da5d18b438b215c5))
* apply terrarium federation standards ([2c185d3](https://github.com/cerebral-work/linearctl/commit/2c185d38b3a90aa46e3b3eaee0f846a180558f57))
* **auth:** OAuth actor=app scaffolding — linearctl auth (CER-1148) ([#112](https://github.com/cerebral-work/linearctl/issues/112)) ([8a8854d](https://github.com/cerebral-work/linearctl/commit/8a8854d3bda62a3639b2a67e28b85d224f1ee12f))
* backlog reconciliation + milestone create, project update, roadmap view (CER-1604/1686/1687/1688) ([#67](https://github.com/cerebral-work/linearctl/issues/67)) ([1caf7a2](https://github.com/cerebral-work/linearctl/commit/1caf7a2cda69d70d201181acf6d3e2fba1d073a2))
* **backup:** read-only workspace dump with manifest and verifier ([292188d](https://github.com/cerebral-work/linearctl/commit/292188de0647c8696a0879cb9acd0f1bea989c39))
* **backup:** read-only workspace dump with verifier ([1f07787](https://github.com/cerebral-work/linearctl/commit/1f0778750710589c3b65f273547abba28d769507))
* **cli:** add agent help, embedded examples, and stable error exits ([08e2da6](https://github.com/cerebral-work/linearctl/commit/08e2da6f97f3a2e4ccc41594d7d6ce9a26a93c54))
* **cli:** interactive mode — prompts + spinners (M3) ([#37](https://github.com/cerebral-work/linearctl/issues/37)) ([2096d59](https://github.com/cerebral-work/linearctl/commit/2096d592938c2e74ca83b122df07c9493db648f2))
* **cli:** interactive slices — fuzzy issue picker (show/close) + xref --fix confirm gate (CER-1551) ([#41](https://github.com/cerebral-work/linearctl/issues/41)) ([b4c521e](https://github.com/cerebral-work/linearctl/commit/b4c521e339e70516159e485054fa7dff847adbb2))
* **cli:** TTY-gated styled tables — picocolors + cli-table3 behind isStyled() ([#35](https://github.com/cerebral-work/linearctl/issues/35)) ([40fb7c1](https://github.com/cerebral-work/linearctl/commit/40fb7c197968d9329e0258d9a102b235970a11d4))
* **comment:** add headless comment command + comment_issue MCP tool ([#33](https://github.com/cerebral-work/linearctl/issues/33)) ([0e2f94f](https://github.com/cerebral-work/linearctl/commit/0e2f94f84b4240fb6ecc67570df612dfb99f16e7))
* **comments:** comments-by-author — the 'what did X say' scan in one query (CER-1187) ([#55](https://github.com/cerebral-work/linearctl/issues/55)) ([e7317e1](https://github.com/cerebral-work/linearctl/commit/e7317e1568adfd1e28a4549b21a61b7939c66b63))
* **cycle:** current-cycle review — scope, burn-down, at-risk, carry-over (CER-1143) ([#50](https://github.com/cerebral-work/linearctl/issues/50)) ([ac3efae](https://github.com/cerebral-work/linearctl/commit/ac3efae6effae4d3e45f3e38f5eacdbdbb5115ee))
* **deploy:** Dockerfile + chart update for linearctl operator daemon + GHCR build-push ([#120](https://github.com/cerebral-work/linearctl/issues/120)) ([cd1d0b1](https://github.com/cerebral-work/linearctl/commit/cd1d0b1b86d3ff6d6759eb50003a0184ad7dbd78))
* **doc:** list / create / update Linear documents (CER-1344) ([#57](https://github.com/cerebral-work/linearctl/issues/57)) ([a710502](https://github.com/cerebral-work/linearctl/commit/a7105020c2f90c4c393f38d3b17919c3c8d288d7))
* **doc:** project overview get/set — mirror plan docs to Linear headlessly ([#26](https://github.com/cerebral-work/linearctl/issues/26)) ([b1a4d54](https://github.com/cerebral-work/linearctl/commit/b1a4d54a43c401c6a3078cf3d735236c36e663e0))
* **dupcheck:** fuzzy title match before filing + file --check-dups guard (CER-1559) ([#44](https://github.com/cerebral-work/linearctl/issues/44)) ([2b3726a](https://github.com/cerebral-work/linearctl/commit/2b3726a5315c11ddea75915ada5e91b92d72408a))
* **file:** --assignee / --priority / --milestone parity with update ([#43](https://github.com/cerebral-work/linearctl/issues/43)) ([2a85052](https://github.com/cerebral-work/linearctl/commit/2a85052e5154b1369c51e075e737ef9171d6ba91))
* **file:** --stdin batch mode with pre-flight quota gate (CER-1141) ([#53](https://github.com/cerebral-work/linearctl/issues/53)) ([b2ba83f](https://github.com/cerebral-work/linearctl/commit/b2ba83fc602d6f87561cffa80df7886c634bd056))
* **file,update:** add --cycle to assign issues to a cycle (OPS-593) ([#64](https://github.com/cerebral-work/linearctl/issues/64)) ([eb4379e](https://github.com/cerebral-work/linearctl/commit/eb4379e4a545dbbe3c83a6e1c0af94c2b0ba2325))
* **file:** headless issue creation ([#7](https://github.com/cerebral-work/linearctl/issues/7)) ([2150f52](https://github.com/cerebral-work/linearctl/commit/2150f5226b88371330c32dc93970df77e3c0771b))
* first-class K8s orchestrator — Helm chart + README rewrite ([#102](https://github.com/cerebral-work/linearctl/issues/102)) ([8d69ed0](https://github.com/cerebral-work/linearctl/commit/8d69ed09a645207ce19c4f55f30e700fbc069c89))
* **funnel:** pull command + soma WorkSource funnel contract ([#88](https://github.com/cerebral-work/linearctl/issues/88)) ([a028c3a](https://github.com/cerebral-work/linearctl/commit/a028c3ad86bdb9346345c16ea1235eaddfeb7509))
* **funnel:** soma parity — id field, multi-state --state-set, clobber guard ([#89](https://github.com/cerebral-work/linearctl/issues/89)) ([759a91b](https://github.com/cerebral-work/linearctl/commit/759a91bf4c68f0407287ae26682a0337fb8ae14b))
* **graph:** --parent / --blocked-by / --related-to on file+update, link command (CER-1342, CER-1192) ([#51](https://github.com/cerebral-work/linearctl/issues/51)) ([0ebd92f](https://github.com/cerebral-work/linearctl/commit/0ebd92fc542cb4d4ea4b9c4b293a316984844a78))
* **handoff:** CRUD — create/list/show/resolve session handoff notes (Track 6-B) ([1e94ff9](https://github.com/cerebral-work/linearctl/commit/1e94ff9ce85d10658e7dc719c60f4c1259ecefdd))
* **history:** issue activity timeline — the audit trail show doesn't surface (CER-1561) ([#48](https://github.com/cerebral-work/linearctl/issues/48)) ([d1a6f13](https://github.com/cerebral-work/linearctl/commit/d1a6f13ca9c040f645414c2789febd4bea99584c))
* **label:** list / create / rename — headless label management (CER-1558) ([#47](https://github.com/cerebral-work/linearctl/issues/47)) ([91ff620](https://github.com/cerebral-work/linearctl/commit/91ff62046de06a2392d3f0fce4eb232f81fc0177))
* linearctl bulk-remediation + robustness (batch, retry, --project, bulk, milestone delete, label-team fix) ([#23](https://github.com/cerebral-work/linearctl/issues/23)) ([bac522d](https://github.com/cerebral-work/linearctl/commit/bac522d63084b26fc3d6bab7792d9192f31e9a1a))
* **llm:** driveAgentLoop reasoning via tailnet LLM gateway (Track 3) ([66da658](https://github.com/cerebral-work/linearctl/commit/66da658a7d04579817ca33d390398fd740ddda0d))
* **loops:** 4 new recipes + loops lint validator command + tests ([#100](https://github.com/cerebral-work/linearctl/issues/100)) ([5303928](https://github.com/cerebral-work/linearctl/commit/53039286d9aafae7f9aa89328e529260e1dd6656))
* **loops:** Linear Loop recipe catalog ([#97](https://github.com/cerebral-work/linearctl/issues/97)) ([2794af0](https://github.com/cerebral-work/linearctl/commit/2794af0a83888939c25ee2272a62fe2da6e742c4))
* **mcp:** issue update/close — CLI commands + MCP write tools ([#11](https://github.com/cerebral-work/linearctl/issues/11)) ([fa1cd99](https://github.com/cerebral-work/linearctl/commit/fa1cd993370f59d732eda7e9c234c9f8e1b6e409))
* **mcp:** linearctl mcp serve — stdio MCP server + v1 tools ([#10](https://github.com/cerebral-work/linearctl/issues/10)) ([97de5b8](https://github.com/cerebral-work/linearctl/commit/97de5b823e9c2b8dddadaf046c7dcd885b2f994e))
* **mcp:** read tools — digest/triage/milestone/stale ([#17](https://github.com/cerebral-work/linearctl/issues/17)) ([ff174a0](https://github.com/cerebral-work/linearctl/commit/ff174a044c7229f183a5e74a30c55c6dad8189c9))
* **milestone:** gap view — empty miles + unassigned issues + doc-section gaps (Track 6-A) ([47dcf64](https://github.com/cerebral-work/linearctl/commit/47dcf64dfe88a84b7b5b8bad34b826c566fe1925))
* **milestone:** milestone update command + react-devtools-core build fix (CER-1759) ([#119](https://github.com/cerebral-work/linearctl/issues/119)) ([c068eb5](https://github.com/cerebral-work/linearctl/commit/c068eb5d9d5567386dd10ff6fef071ff562ae7f2))
* **milestone:** per-milestone burn-down + extract mapPool ([#16](https://github.com/cerebral-work/linearctl/issues/16)) ([cd4cd90](https://github.com/cerebral-work/linearctl/commit/cd4cd90930771669c2c76e34c0d6c9325e21465e))
* mine + initiative commands — assignee and initiative catch-up views (OPS-975) ([9a5ba2e](https://github.com/cerebral-work/linearctl/commit/9a5ba2efe643aa8966017d968f8aa7c0d57245d7))
* mine + initiative commands — assignee and initiative catch-up views (OPS-975) ([8e53c06](https://github.com/cerebral-work/linearctl/commit/8e53c065bb236f200e0909cdf48ff415c47e85fd))
* **operator:** containment set + dual-writer deny rule (OPS-1214) ([813c9a8](https://github.com/cerebral-work/linearctl/commit/813c9a8a78e80f3aecfecd64b75ebbac01dfde82))
* **operator:** containment set + dual-writer deny rule (OPS-1214) ([13703f9](https://github.com/cerebral-work/linearctl/commit/13703f954ee9556cf27b6a54d2b234405a8ac988))
* **operator:** HMAC-signed queue message verification (forgery defense) ([dcf24b9](https://github.com/cerebral-work/linearctl/commit/dcf24b9ef98764849ce179f4c439bbaabb6a82ae))
* **operator:** HMAC-signed queue message verification (forgery defense) ([2ac8e33](https://github.com/cerebral-work/linearctl/commit/2ac8e3356d44302f94c47df2a08924c123244d7b))
* **operator:** linearctl operator daemon + watch delegate-to-operator (CER-1149) ([#118](https://github.com/cerebral-work/linearctl/issues/118)) ([9fa0183](https://github.com/cerebral-work/linearctl/commit/9fa018326621387d801361522e1f6d856b446342))
* **park:** file user stories straight into Backlog (CER-1557) ([#46](https://github.com/cerebral-work/linearctl/issues/46)) ([ffab9b1](https://github.com/cerebral-work/linearctl/commit/ffab9b1653f0ca4c83ffab67b40c5311c5feb470))
* **plugin:** Claude Code plugin + Claude Desktop .mcpb packaging ([#12](https://github.com/cerebral-work/linearctl/issues/12)) ([f8ca133](https://github.com/cerebral-work/linearctl/commit/f8ca133e9882479061277a834ca1ff0aac1bdc6e))
* **project:** create + list Linear projects ([#6](https://github.com/cerebral-work/linearctl/issues/6)) ([eb80447](https://github.com/cerebral-work/linearctl/commit/eb8044729538faeed62c18afe3a1227ed25b4e56))
* **pull:** add --limit for bounded smoke loops + updatedAt load-bearing invariant ([#96](https://github.com/cerebral-work/linearctl/issues/96)) ([987a9d9](https://github.com/cerebral-work/linearctl/commit/987a9d92d1d55ca6bfc349fab48b2661988341f1))
* **release-notes:** markdown notes from completed issues in a range (CER-1146) ([#56](https://github.com/cerebral-work/linearctl/issues/56)) ([b4c7c7e](https://github.com/cerebral-work/linearctl/commit/b4c7c7e80eb3606bad5d41fe30a1e329466ff156))
* scaffold linear-workflows (lw) — headless Linear workflow CLI ([6258215](https://github.com/cerebral-work/linearctl/commit/62582158d935d946a2c5774849618ae0b8b47cc2))
* **search:** arbitrary-criteria issue search — the grep for Linear (CER-1560) ([#40](https://github.com/cerebral-work/linearctl/issues/40)) ([fb68eff](https://github.com/cerebral-work/linearctl/commit/fb68eff559c04e251a0bcb842ebd6c77ce3c9558))
* show + ratelimit + xref --fix — the reads and remediation the sweep sessions lacked ([#25](https://github.com/cerebral-work/linearctl/issues/25)) ([42a317d](https://github.com/cerebral-work/linearctl/commit/42a317d5aecaccc3be22049d362107d1707d17b3))
* **stale:** stale-issue sweep by last-update age ([#14](https://github.com/cerebral-work/linearctl/issues/14)) ([23eaf6f](https://github.com/cerebral-work/linearctl/commit/23eaf6f9eef028da13c9badcf15de4268d441fc2))
* standup --slack — operator-gated Slack send (CER-1730) ([#104](https://github.com/cerebral-work/linearctl/issues/104)) ([e027156](https://github.com/cerebral-work/linearctl/commit/e027156940d5fe4b2e752b143902b6a68abc3351))
* **standup:** render digest as a standup — no auto-posting by design (CER-1147) ([#58](https://github.com/cerebral-work/linearctl/issues/58)) ([d5ad6ef](https://github.com/cerebral-work/linearctl/commit/d5ad6ef62a53981981d3bfacb0ae7b852362723c))
* **template:** file issues from reusable markdown templates (CER-1562) ([#49](https://github.com/cerebral-work/linearctl/issues/49)) ([24f5b78](https://github.com/cerebral-work/linearctl/commit/24f5b78d3e38f268a135de59e0083be4804ee517))
* **triage,digest:** finish the grooming surface verbs ([#13](https://github.com/cerebral-work/linearctl/issues/13)) ([5c6e133](https://github.com/cerebral-work/linearctl/commit/5c6e1330f5a11b2cc848ac87419452904efd42f4))
* **tui:** all 5 panes live — digest, milestone, xref, stale (CER-1550) ([8490817](https://github.com/cerebral-work/linearctl/commit/84908174da7dc9873057a705b0d33836f92cf1a3))
* **tui:** all 5 panes live — digest, milestone, xref, stale (CER-1550) ([440b460](https://github.com/cerebral-work/linearctl/commit/440b460b27f4968e267ad44675a190f01be4e808))
* **tui:** first slice — Ink ADR-0008, Triage pane, TTY gate (CER-1550) (Track 2) ([2b08cb0](https://github.com/cerebral-work/linearctl/commit/2b08cb0e68c9ac22b5014dc2f392bd4743e382d4))
* **update:** edit title and description (CER-1341) ([#45](https://github.com/cerebral-work/linearctl/issues/45)) ([f401985](https://github.com/cerebral-work/linearctl/commit/f401985316f7dc3eecfc3a1760f83b4556e71db5))
* **watch:** linearctl watch — full-loop fallback path (CER-1149) ([#116](https://github.com/cerebral-work/linearctl/issues/116)) ([24b7baf](https://github.com/cerebral-work/linearctl/commit/24b7baf87c9675003fb6431efaf336687703badd))
* **xref:** PR&lt;-&gt;ticket cross-ref audit (read-only) ([#15](https://github.com/cerebral-work/linearctl/issues/15)) ([05f725f](https://github.com/cerebral-work/linearctl/commit/05f725f8a9249ab46c8f8d677a4e16785b962e21))


### Bug Fixes

* add  to SearchOptions. ([6403d1f](https://github.com/cerebral-work/linearctl/commit/6403d1f15edd6302043522a6c73bf2637a95709c))
* **backup:** batch history checkpoints, reuse finished history, tolerate live edits in verify ([53c9992](https://github.com/cerebral-work/linearctl/commit/53c9992f8a31c4f5a241a0d896da391165cf2a37))
* **ci:** approve-auto-render-ci — add checkout, use API for run listing ([d9da15a](https://github.com/cerebral-work/linearctl/commit/d9da15aee4a18c2d573f1ab2a263a2468dc09d52))
* **ci:** approve-auto-render-ci — trigger on velocity completion ([de697c0](https://github.com/cerebral-work/linearctl/commit/de697c01d8fada72a8e2ce661c60f34c01d6955b))
* **ci:** approve-auto-render-ci — trigger on velocity completion ([#80](https://github.com/cerebral-work/linearctl/issues/80)) ([de697c0](https://github.com/cerebral-work/linearctl/commit/de697c01d8fada72a8e2ce661c60f34c01d6955b))
* **ci:** approve-auto-render-ci — trigger on velocity completion, not CI request ([a12a763](https://github.com/cerebral-work/linearctl/commit/a12a763bbd76dc05394f27a4d047cc211fb21bec))
* **ci:** auto-approve CI runs on GITHUB_TOKEN-created auto-render PRs ([bbe63a7](https://github.com/cerebral-work/linearctl/commit/bbe63a787b19c784e509ff0733e9b7e1dc0a1962))
* **ci:** drive linear-release from release.yml (close tag-trigger gap) ([#21](https://github.com/cerebral-work/linearctl/issues/21)) ([2fc7a0b](https://github.com/cerebral-work/linearctl/commit/2fc7a0b2c010c57e48d2ce93d32f2d73dfadb8cb))
* **ci:** gaze-upon velocity — auto-merge PRs when CI passes ([f8c866b](https://github.com/cerebral-work/linearctl/commit/f8c866b84c86b2f660b136d0fc9012dbb8c36426))
* **ci:** gaze-upon velocity — auto-merge PRs when CI passes ([ea2454d](https://github.com/cerebral-work/linearctl/commit/ea2454d3db55330d2e3a1e79497b23f444130eab))
* **ci:** gaze-upon velocity — auto-merge PRs when CI passes ([#73](https://github.com/cerebral-work/linearctl/issues/73)) ([f8c866b](https://github.com/cerebral-work/linearctl/commit/f8c866b84c86b2f660b136d0fc9012dbb8c36426))
* **ci:** gaze-upon velocity — push to auto-branch + PR merge, not direct push ([f7c879d](https://github.com/cerebral-work/linearctl/commit/f7c879db29b7cf729d5dcc59c175fb71bbcca79d))
* **ci:** gaze-upon velocity — push to auto-branch + PR merge, not direct push ([ea2b587](https://github.com/cerebral-work/linearctl/commit/ea2b58732c6c7d62bd47f4fd0c137b7da2e82f5b))
* **ci:** gaze-upon velocity — push to auto-branch + PR merge, not direct push ([#71](https://github.com/cerebral-work/linearctl/issues/71)) ([f7c879d](https://github.com/cerebral-work/linearctl/commit/f7c879db29b7cf729d5dcc59c175fb71bbcca79d))
* **ci:** render-roadmap.sh — rate-limit guard + graceful degradation ([815b34d](https://github.com/cerebral-work/linearctl/commit/815b34d1a76be211306def7403caa778bd673ac5))
* **ci:** render-roadmap.sh — rate-limit guard + graceful degradation ([864a120](https://github.com/cerebral-work/linearctl/commit/864a1206280ac3ce8b998b678b30ed818d67c1f2))
* **ci:** render-roadmap.sh — rate-limit guard + graceful degradation ([#74](https://github.com/cerebral-work/linearctl/issues/74)) ([815b34d](https://github.com/cerebral-work/linearctl/commit/815b34d1a76be211306def7403caa778bd673ac5))
* **cli:** add the backup example and stop using 'backup' as the unknown-command fixture ([6655e70](https://github.com/cerebral-work/linearctl/commit/6655e70d422faf7be2ffa935c36a1f31e2698dca))
* **cli:** add the backup example and stop using 'backup' as the unknown-command fixture ([40251fe](https://github.com/cerebral-work/linearctl/commit/40251fef79a90b6900a3f1769003c739060aaa42))
* **cli:** picker direct-entry choice appends last, not first ([#42](https://github.com/cerebral-work/linearctl/issues/42)) ([047c0b6](https://github.com/cerebral-work/linearctl/commit/047c0b67d2e8e314d0cdf55fe4352a23ac4f6153))
* **cli:** refuse empty stdin for '-' body flags — no more silent title-only issues (CER-1872) ([f1aafd7](https://github.com/cerebral-work/linearctl/commit/f1aafd7d098880b249b8114c362624e46dab7189))
* **cli:** refuse empty stdin for '-' body flags (CER-1872) ([d08813b](https://github.com/cerebral-work/linearctl/commit/d08813bf311e29bca4b6ee56bd14a279bac4192e))
* **cli:** reject unknown help commands and clarify invocation hints ([31fb94e](https://github.com/cerebral-work/linearctl/commit/31fb94e16c98c039639b8075f70452cf96dd9d31))
* **core:** add limit field to SearchOptions ([#92](https://github.com/cerebral-work/linearctl/issues/92)) ([6403d1f](https://github.com/cerebral-work/linearctl/commit/6403d1f15edd6302043522a6c73bf2637a95709c))
* **core:** eliminate N+1 lazy-relation fetches — grooming reads select state/assignee inline ([#38](https://github.com/cerebral-work/linearctl/issues/38)) ([35e8fe3](https://github.com/cerebral-work/linearctl/commit/35e8fe30178e900d7c11e10db42f162119afd771))
* **core:** paginate project list — was silently truncating at 50 (CER-1771) ([c0d983b](https://github.com/cerebral-work/linearctl/commit/c0d983b613e4c168635ed9660fc2d28675d2f2b0))
* **core:** paginate project list — was silently truncating at 50 (CER-1771) ([e7bf632](https://github.com/cerebral-work/linearctl/commit/e7bf6320b6b730aefb54c8afb44a2e3f2946cfcd))
* **core:** treat 'duplicate' state type as terminal in every sweep ([6864693](https://github.com/cerebral-work/linearctl/commit/686469337236e3cee9df414e877ba4c6969b1ae8))
* **core:** treat Linear's 'duplicate' state type as terminal in every sweep ([2fb5b7e](https://github.com/cerebral-work/linearctl/commit/2fb5b7e9664e2f59cdec63b6ed960624f85fbae5))
* **image:** drop stale react-devtools stub copy ([#121](https://github.com/cerebral-work/linearctl/issues/121)) ([7f9674d](https://github.com/cerebral-work/linearctl/commit/7f9674d33e69ce82c273cd71c14e55bac26714d0))
* **operator:** close containment fail-open paths per review (10 verified findings) ([3719db8](https://github.com/cerebral-work/linearctl/commit/3719db8bea847fdd80d081ce132e06f87d4b6e7c))
* read --version from package.json instead of hardcoding ([#20](https://github.com/cerebral-work/linearctl/issues/20)) ([ce4ba7d](https://github.com/cerebral-work/linearctl/commit/ce4ba7d495dd08dbe356da311c7e20b6615b04a8))


### Code Refactoring

* **core:** extract src/core from command bodies ([#9](https://github.com/cerebral-work/linearctl/issues/9)) ([e69b75e](https://github.com/cerebral-work/linearctl/commit/e69b75e39aa5a6872969807bdf8ce0cf61d05951))


### Documentation

* add feature proposals + TUI/CLI library landscape reference ([6c036c8](https://github.com/cerebral-work/linearctl/commit/6c036c839f8eec5d84685e12e3eddd7ed8eef678))
* add tui + interactive mode feature proposals ([b0e6d5c](https://github.com/cerebral-work/linearctl/commit/b0e6d5cf906d28623e05bf20862c786b3d0e5d74))
* **backup:** API surface, alternatives, live-drift semantics ([f2716ed](https://github.com/cerebral-work/linearctl/commit/f2716ed4dec49ec566f1f429ed255830390ebc8f))
* **backup:** feature doc and README line ([ef6d538](https://github.com/cerebral-work/linearctl/commit/ef6d5385c5a332260f2c98be41c046b5d0e37c7e))
* **features:** mark proposals ticketed with CER IDs after dogfood filing ([#34](https://github.com/cerebral-work/linearctl/issues/34)) ([4d9569c](https://github.com/cerebral-work/linearctl/commit/4d9569ca42e1b3d5ee671fdf4228725137db06e4))
* **handoff:** CER-1148 status — live mint verified + URL decisions ([#114](https://github.com/cerebral-work/linearctl/issues/114)) ([eee5441](https://github.com/cerebral-work/linearctl/commit/eee5441ea72f9ad6580e37a59110e134857961ac))
* **loops:** document verified GraphQL API status — WorkflowDefinition exists, no mutations ([#101](https://github.com/cerebral-work/linearctl/issues/101)) ([2aaf392](https://github.com/cerebral-work/linearctl/commit/2aaf392045f897918325f4ebbce479c6e55863ab))
* merge style is merge-commit, never squash — align with estate merge-style SOP (2026-08-06) ([08c5f0f](https://github.com/cerebral-work/linearctl/commit/08c5f0fd37cf244babecbc3fdeef10af58846773))
* merge style is merge-commit, never squash (estate SOP 2026-08-06) ([954dc12](https://github.com/cerebral-work/linearctl/commit/954dc126aeec369c0717527a27f3c8543ff31292))
* plugin + Desktop install guides; refresh stale status ([#19](https://github.com/cerebral-work/linearctl/issues/19)) ([d3f2db2](https://github.com/cerebral-work/linearctl/commit/d3f2db25b74c10ac25312828a8dbb202ff7eddeb))
* **punch-list:** mark CER-1148 shipped; add handoff note ([#113](https://github.com/cerebral-work/linearctl/issues/113)) ([0dc655b](https://github.com/cerebral-work/linearctl/commit/0dc655b73ec2cae9cd50c7e5ab2c250f891640ce))
* **roadmaps:** corpus drift refresh 2026-07-29 + render infra fixes ([#122](https://github.com/cerebral-work/linearctl/issues/122)) ([919db7d](https://github.com/cerebral-work/linearctl/commit/919db7daaf45e2664e3a188e71ea9c315fb150ae))
* spec the linearctl plugin (Claude Code + Claude Desktop) ([#8](https://github.com/cerebral-work/linearctl/issues/8)) ([87c66e2](https://github.com/cerebral-work/linearctl/commit/87c66e23941e08b599ed92f88c5c334ce42b9b9d))
* **spec:** §6.18 auth — flip 'live mint pending' to verified ([#115](https://github.com/cerebral-work/linearctl/issues/115)) ([202b241](https://github.com/cerebral-work/linearctl/commit/202b241e10ff13eacac7c1ce61b73e58376859fb))
* sync roadmap — update spec ticket table (T1-T18 shipped), create roadmap-linearctl.md, refresh punch-list ([#98](https://github.com/cerebral-work/linearctl/issues/98)) ([a5067b9](https://github.com/cerebral-work/linearctl/commit/a5067b9fcdbe41cba18c7e9b8258437595c1c961))
* track5 — test counts, standup Slack shipped, agent-facility.md ref, CodeQL workflow ([b83cdfe](https://github.com/cerebral-work/linearctl/commit/b83cdfe2e2e98ee6c6007a623afa2a1b5f7e4a58))
* use stable 1Password item ID in the op run auth example ([1babe20](https://github.com/cerebral-work/linearctl/commit/1babe2074ae4e43da1429b3867793c5696c88fc5))

## [Unreleased]

### Breaking Changes

* **cli:** standardize exits (0 success, 2 usage, 3 auth, 4 not found, 5 rate limit, 6 refused, 1 other); dry-run write previews and partial batch failures now return nonzero. JSON failures use one stderr envelope.

### Agent tooling

* **cli:** add command-specific invocation hints, team/label suggestions, and embedded `examples [command]` shell scripts.


### Features

* **milestone:** filter `pull` and `search` by milestone UUID/name; include milestone identity and target date in `show` for membership verification.

* **milestone:** `milestone create` subcommand — create project milestones headless (CER-1686)
* **project:** `project update` subcommand — update project state, name, description (CER-1687)
* **roadmap:** milestone timeline view with progress and issue lists per milestone (CER-1688)
* **watch:** `linearctl watch --once --payload` — full-loop fallback path for AgentSessionEvent payloads; loop driver library (`emitThought` → `driveAgentLoop` → `moveToStartedIfDelegated`) with 10s-SLA thought-first ordering (CER-1149)
* **operator:** `linearctl operator` long-running daemon — CF Queue `linear-agent-events` consumer + Unix-socket control (POST /delegate, GET /healthz) for `linearctl watch` delegation; token cache, graceful SIGINT/SIGTERM shutdown (CER-1149)
* **handoff:** `linearctl handoff` command tree — create / list / show / resolve session handoff notes persisted as markdown under `~/.local/state/linearctl/handoffs/` (XDG state dir shared with the operator socket); cross-session memory bridge for the maintainer-agent (Track 6 sub-feature B)


### Bug Fixes

* **file:** `--stdin` dry-run now validates project name resolution so the preview matches `--apply` (CER-1604)
* **operator:** make readiness and drain timing monotonic, acknowledge each queue message exactly once, keep authenticated queue response bodies out of logs, and remove CI-only test races.
* **roles:** escape backslashes before pipes in intake-triage Markdown table titles.
* **image:** remove the deleted react-devtools stub from the container build context so rootless BuildKit can compile the operator image.


## [0.7.0](https://github.com/cerebral-work/linearctl/compare/v0.6.0...v0.7.0) (2026-07-11)


### Features

* **comments:** comments-by-author — the 'what did X say' scan in one query (CER-1187) ([#55](https://github.com/cerebral-work/linearctl/issues/55)) ([1273fbc](https://github.com/cerebral-work/linearctl/commit/1273fbcc188a9ec385662c6a47ed18098b82bffe))
* **doc:** list / create / update Linear documents (CER-1344) ([#57](https://github.com/cerebral-work/linearctl/issues/57)) ([2f6dc94](https://github.com/cerebral-work/linearctl/commit/2f6dc947c6325ebe75ff4198f18e0f9523894ae2))
* **file:** --stdin batch mode with pre-flight quota gate (CER-1141) ([#53](https://github.com/cerebral-work/linearctl/issues/53)) ([08ab4ef](https://github.com/cerebral-work/linearctl/commit/08ab4ef7c6303335e3f0c0a43e1f8f5709404060))
* **graph:** --parent / --blocked-by / --related-to on file+update, link command (CER-1342, CER-1192) ([#51](https://github.com/cerebral-work/linearctl/issues/51)) ([5af6d80](https://github.com/cerebral-work/linearctl/commit/5af6d80fe0a57352e9c7b4f0121570154a8daff4))
* **release-notes:** markdown notes from completed issues in a range (CER-1146) ([#56](https://github.com/cerebral-work/linearctl/issues/56)) ([81b8689](https://github.com/cerebral-work/linearctl/commit/81b8689d6813f8a01ba173932b3341b9faf5a423))
* **standup:** render digest as a standup — no auto-posting by design (CER-1147) ([#58](https://github.com/cerebral-work/linearctl/issues/58)) ([f44046c](https://github.com/cerebral-work/linearctl/commit/f44046ccf5e7e9906c72d4e32db1d3656547a9e7))

## [0.6.0](https://github.com/cerebral-work/linearctl/compare/v0.5.0...v0.6.0) (2026-07-11)


### Features

* **cli:** interactive slices — fuzzy issue picker (show/close) + xref --fix confirm gate (CER-1551) ([#41](https://github.com/cerebral-work/linearctl/issues/41)) ([6bf30b9](https://github.com/cerebral-work/linearctl/commit/6bf30b9150a42df13517a64470fe12c6d54a8f42))
* **cycle:** current-cycle review — scope, burn-down, at-risk, carry-over (CER-1143) ([#50](https://github.com/cerebral-work/linearctl/issues/50)) ([4619967](https://github.com/cerebral-work/linearctl/commit/4619967c851e98eccb6a836b6e8d1c04562afa4f))
* **dupcheck:** fuzzy title match before filing + file --check-dups guard (CER-1559) ([#44](https://github.com/cerebral-work/linearctl/issues/44)) ([278e169](https://github.com/cerebral-work/linearctl/commit/278e1692eb65ae885a87329f8419e1293081f6be))
* **file:** --assignee / --priority / --milestone parity with update ([#43](https://github.com/cerebral-work/linearctl/issues/43)) ([3e8942b](https://github.com/cerebral-work/linearctl/commit/3e8942b12b879bbdf86d39d2b7f77ae91d825951))
* **history:** issue activity timeline — the audit trail show doesn't surface (CER-1561) ([#48](https://github.com/cerebral-work/linearctl/issues/48)) ([64d2e35](https://github.com/cerebral-work/linearctl/commit/64d2e35a7d92935f4802bc4162ada270c2604c02))
* **label:** list / create / rename — headless label management (CER-1558) ([#47](https://github.com/cerebral-work/linearctl/issues/47)) ([4f0c23d](https://github.com/cerebral-work/linearctl/commit/4f0c23da128b862b26f045eaceadb9c6964b8381))
* **park:** file user stories straight into Backlog (CER-1557) ([#46](https://github.com/cerebral-work/linearctl/issues/46)) ([2321f6f](https://github.com/cerebral-work/linearctl/commit/2321f6f36c24b14e375835d31440cc3c700d5553))
* **search:** arbitrary-criteria issue search — the grep for Linear (CER-1560) ([#40](https://github.com/cerebral-work/linearctl/issues/40)) ([e0908f3](https://github.com/cerebral-work/linearctl/commit/e0908f31903731ab16f5169a51d87b9139f5eca4))
* **template:** file issues from reusable markdown templates (CER-1562) ([#49](https://github.com/cerebral-work/linearctl/issues/49)) ([0049059](https://github.com/cerebral-work/linearctl/commit/0049059e585c6a604c57365c429182dea1046853))
* **update:** edit title and description (CER-1341) ([#45](https://github.com/cerebral-work/linearctl/issues/45)) ([e1e0620](https://github.com/cerebral-work/linearctl/commit/e1e0620902ebc319f7f80ce57337726c1b6211fc))


### Bug Fixes

* **cli:** picker direct-entry choice appends last, not first ([#42](https://github.com/cerebral-work/linearctl/issues/42)) ([c2142af](https://github.com/cerebral-work/linearctl/commit/c2142af247ea79e10cf5517bf56f120bdbdd2c8e))
* **core:** eliminate N+1 lazy-relation fetches — grooming reads select state/assignee inline ([#38](https://github.com/cerebral-work/linearctl/issues/38)) ([df941f1](https://github.com/cerebral-work/linearctl/commit/df941f194e525f8f718a708474bc8157467bae31))

## [0.5.0](https://github.com/cerebral-work/linearctl/compare/v0.4.0...v0.5.0) (2026-07-10)


### Features

* **cli:** interactive mode — prompts + spinners (M3) ([#37](https://github.com/cerebral-work/linearctl/issues/37)) ([e21fccb](https://github.com/cerebral-work/linearctl/commit/e21fccbaa9b7980656e6c42ba76f2a13ac649183))
* **cli:** TTY-gated styled tables — picocolors + cli-table3 behind isStyled() ([#35](https://github.com/cerebral-work/linearctl/issues/35)) ([e892f37](https://github.com/cerebral-work/linearctl/commit/e892f37a74d671be63030bb6470f68e922ed7389))
* **comment:** add headless comment command + comment_issue MCP tool ([#33](https://github.com/cerebral-work/linearctl/issues/33)) ([596a229](https://github.com/cerebral-work/linearctl/commit/596a229dc3e008dbd91dc8a13fee3f583a41c89d))


### Documentation

* add feature proposals + TUI/CLI library landscape reference ([06931b6](https://github.com/cerebral-work/linearctl/commit/06931b69526e3d66f613bf87f6dd7a9e0a48cb4c))
* add tui + interactive mode feature proposals ([bc61c40](https://github.com/cerebral-work/linearctl/commit/bc61c404d7ce76f8724ae202d764c1fa2ddcb023))
* **features:** mark proposals ticketed with CER IDs after dogfood filing ([#34](https://github.com/cerebral-work/linearctl/issues/34)) ([a2672c3](https://github.com/cerebral-work/linearctl/commit/a2672c348ccef9708052a52094d024773f6bed10))

## [0.4.0](https://github.com/cerebral-work/linearctl/compare/v0.3.0...v0.4.0) (2026-07-02)


### Features

* **doc:** project overview get/set — mirror plan docs to Linear headlessly ([#26](https://github.com/cerebral-work/linearctl/issues/26)) ([36e6625](https://github.com/cerebral-work/linearctl/commit/36e66256f322c6458ac26b8965cdb0b1c6fc1208))

## [0.3.0](https://github.com/cerebral-work/linearctl/compare/v0.2.0...v0.3.0) (2026-07-01)


### Features

* linearctl bulk-remediation + robustness (batch, retry, --project, bulk, milestone delete, label-team fix) ([#23](https://github.com/cerebral-work/linearctl/issues/23)) ([abb0743](https://github.com/cerebral-work/linearctl/commit/abb07430db75f7727ceb17d33a52ef0c75a07fdf))
* show + ratelimit + xref --fix — the reads and remediation the sweep sessions lacked ([#25](https://github.com/cerebral-work/linearctl/issues/25)) ([a840a0e](https://github.com/cerebral-work/linearctl/commit/a840a0e7cd6286322e6e9c9ef88eae31a06af639))

## [0.2.0](https://github.com/cerebral-work/linearctl/compare/v0.1.0...v0.2.0) (2026-06-05)


### Features

* **file:** headless issue creation ([#7](https://github.com/cerebral-work/linearctl/issues/7)) ([8a0fa84](https://github.com/cerebral-work/linearctl/commit/8a0fa84e26172d7dc78027092cfff3cf9f7b1418))
* **mcp:** issue update/close — CLI commands + MCP write tools ([#11](https://github.com/cerebral-work/linearctl/issues/11)) ([d2a8f89](https://github.com/cerebral-work/linearctl/commit/d2a8f8920bb21e5602159182201a28c094aae224))
* **mcp:** linearctl mcp serve — stdio MCP server + v1 tools ([#10](https://github.com/cerebral-work/linearctl/issues/10)) ([8a4137d](https://github.com/cerebral-work/linearctl/commit/8a4137dca4ac456edf1c65aaee3cb670da41fc19))
* **mcp:** read tools — digest/triage/milestone/stale ([#17](https://github.com/cerebral-work/linearctl/issues/17)) ([d420108](https://github.com/cerebral-work/linearctl/commit/d42010866ca2a98bff3f4cf85a6d1f8923b59ac2))
* **milestone:** per-milestone burn-down + extract mapPool ([#16](https://github.com/cerebral-work/linearctl/issues/16)) ([5232e2f](https://github.com/cerebral-work/linearctl/commit/5232e2ffeffb2960ded084adb8053c739215ebc4))
* **plugin:** Claude Code plugin + Claude Desktop .mcpb packaging ([#12](https://github.com/cerebral-work/linearctl/issues/12)) ([0211196](https://github.com/cerebral-work/linearctl/commit/0211196a8cb1054ac9daa217d7813bb6d82fafb2))
* **project:** create + list Linear projects ([#6](https://github.com/cerebral-work/linearctl/issues/6)) ([7199209](https://github.com/cerebral-work/linearctl/commit/7199209ace6410d95fa7e780949c65848448f766))
* scaffold linear-workflows (lw) — headless Linear workflow CLI ([fcd38eb](https://github.com/cerebral-work/linearctl/commit/fcd38ebc8ca4c02ed6ed63d6fa10796629e8c642))
* **stale:** stale-issue sweep by last-update age ([#14](https://github.com/cerebral-work/linearctl/issues/14)) ([6731c38](https://github.com/cerebral-work/linearctl/commit/6731c38a4f8086810d605e5c43b4e58cb376fcc7))
* **triage,digest:** finish the grooming surface verbs ([#13](https://github.com/cerebral-work/linearctl/issues/13)) ([da2479b](https://github.com/cerebral-work/linearctl/commit/da2479ba08d3274a55ce38b94fc1a761f6155fae))
* **xref:** PR&lt;-&gt;ticket cross-ref audit (read-only) ([#15](https://github.com/cerebral-work/linearctl/issues/15)) ([413d61e](https://github.com/cerebral-work/linearctl/commit/413d61ee3531c678d0194b12b4437b923ec940bf))


### Bug Fixes

* **ci:** drive linear-release from release.yml (close tag-trigger gap) ([#21](https://github.com/cerebral-work/linearctl/issues/21)) ([9b207fe](https://github.com/cerebral-work/linearctl/commit/9b207febbbedf22ed3c5909d36b6e702d8b4f18e))
* read --version from package.json instead of hardcoding ([#20](https://github.com/cerebral-work/linearctl/issues/20)) ([af6f258](https://github.com/cerebral-work/linearctl/commit/af6f2589d7274288b4fa313368ed4e78bc680024))


### Code Refactoring

* **core:** extract src/core from command bodies ([#9](https://github.com/cerebral-work/linearctl/issues/9)) ([9c8cd82](https://github.com/cerebral-work/linearctl/commit/9c8cd8226cccecf36b4429191da5ee181568ab57))


### Documentation

* plugin + Desktop install guides; refresh stale status ([#19](https://github.com/cerebral-work/linearctl/issues/19)) ([dfec263](https://github.com/cerebral-work/linearctl/commit/dfec26341ca1b624f1bb20f84fe86d9705570f76))
* spec the linearctl plugin (Claude Code + Claude Desktop) ([#8](https://github.com/cerebral-work/linearctl/issues/8)) ([6c98105](https://github.com/cerebral-work/linearctl/commit/6c98105cca9b02257d3d467053273e6ece4868f7))
* use stable 1Password item ID in the op run auth example ([1e8aa60](https://github.com/cerebral-work/linearctl/commit/1e8aa60d3ece9a7a9172473cdc1f6e3014293e51))
