# Changelog

## [2.6.0](https://github.com/antelm-dev/shadergrove/compare/v2.5.0...v2.6.0) (2026-10-08)


### Features

* **glsl-analysis:** add opt-in compiler-backed observation catalogue and insertion contract ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **i18n:** ship the en/fr language packs 1.0.5 ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **plugins:** ship Grove Amber and ISF as official plugins ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** add the inspection tab preference and en/fr strings ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** capture the actual frame and accepted programs for inspection ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** inspect frozen GPU frames and observe typed shader values ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** integrate glslang analysis into the editor ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** measure one frozen GPU variable in the render inspector ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** use the website grove mark as desktop icon and favicon ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))


### Bug Fixes

* **deps:** align the nx toolchain on 23.2.1 and patch brace-expansion ([#166](https://github.com/antelm-dev/shadergrove/issues/166)) ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **deps:** update Electron to 41 [security] ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **glsl-analysis:** read #line as a logical preprocessor directive ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **glsl-analysis:** refuse unbraced control assignments and comment-prefixed #line in observation ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** count every frame, capture draw-time uniforms, guard publication and compare behind effects ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** hide generated helpers by exact signature, not remapped line ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** keep user helper overloads and let a store revert complete analysis ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** look up generated helpers by own property only ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** refuse a replay that is NaN on only one side of the pre-effect comparison ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** release the observer's render target and clear colour after each draw ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** remap cached analysis, scope generated names per stage, cancel pending units ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** supersede pending observations on edit and keep skipped nonfinite output unverified ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))
* **studio:** treat array parameters as user overloads of generated helpers ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))


### Performance Improvements

* **studio:** load the GPU observer and inspection panel on demand ([dc90d83](https://github.com/antelm-dev/shadergrove/commit/dc90d83eff5b49e1c18acb5444e670a4eaba0e9a))

## [2.5.0](https://github.com/antelm-dev/shadergrove/compare/v2.4.1...v2.5.0) (2026-10-08)


### Features

* transactional shader history domain and transports ([#167](https://github.com/antelm-dev/shadergrove/issues/167)) ([19d2e05](https://github.com/antelm-dev/shadergrove/commit/19d2e0521fe546caf8c05085bc0efbdedf22b99b))

## [2.4.1](https://github.com/antelm-dev/shadergrove/compare/v2.4.0...v2.4.1) (2026-10-08)


### Bug Fixes

* **studio:** apply on Enter in a Controls builder field typed into before the view updates ([#208](https://github.com/antelm-dev/shadergrove/issues/208)) ([655f137](https://github.com/antelm-dev/shadergrove/commit/655f137b8be55f1e2caba04f4226730076f6fefb))

## [2.4.0](https://github.com/antelm-dev/shadergrove/compare/v2.3.0...v2.4.0) (2026-10-07)


### Features

* **studio:** make editor shell, panel and controls group-aware ([#204](https://github.com/antelm-dev/shadergrove/issues/204)) ([460de78](https://github.com/antelm-dev/shadergrove/commit/460de789eb8717ac6af76f17cf82730899c5c5af))

## [2.3.0](https://github.com/antelm-dev/shadergrove/compare/v2.2.0...v2.3.0) (2026-10-07)


### Features

* **shared:** versioned contained-editor split-tree layout contract ([#170](https://github.com/antelm-dev/shadergrove/issues/170)) ([ebc238a](https://github.com/antelm-dev/shadergrove/commit/ebc238a44b939589624ad5d8b589c70ab479d0a7))
* **studio:** visual Controls builder for the Config document ([#202](https://github.com/antelm-dev/shadergrove/issues/202)) ([3dab184](https://github.com/antelm-dev/shadergrove/commit/3dab18447793eccc31e955259d49029b0e93694d))

## [2.2.0](https://github.com/antelm-dev/shadergrove/compare/v2.1.1...v2.2.0) (2026-10-07)


### Features

* **plugins:** open project importers in a generic import dialog ([#171](https://github.com/antelm-dev/shadergrove/issues/171)) ([b338450](https://github.com/antelm-dev/shadergrove/commit/b3384503375aeeb39770fb48dd0c4edf4aa96b26))
* **studio:** keep Explore searches in the URL and restore browsing ([#169](https://github.com/antelm-dev/shadergrove/issues/169)) ([0fd00e0](https://github.com/antelm-dev/shadergrove/commit/0fd00e08a7bef05a4a7913d46e0731c3dd51f4f3))

## [2.1.1](https://github.com/antelm-dev/shadergrove/compare/v2.1.0...v2.1.1) (2026-10-07)


### Bug Fixes

* **deps:** align Angular on 22.2 and patch axios and js-yaml advisories ([#163](https://github.com/antelm-dev/shadergrove/issues/163)) ([d46635d](https://github.com/antelm-dev/shadergrove/commit/d46635d8934329345af0e2b6efcebcf74bcc9fb5))

## [2.1.0](https://github.com/antelm-dev/shadergrove/compare/v2.0.0...v2.1.0) (2026-10-07)


### Features

* **glsl-analysis:** add bounded ESSL analysis Worker ([b655607](https://github.com/antelm-dev/shadergrove/commit/b6556075b57ebbca2e6daf4296bf6eb6d30cf8a0))
* **glsl-analysis:** replay reviewed foundation and P3 follow-up ([5aabea0](https://github.com/antelm-dev/shadergrove/commit/5aabea0bb086bb3c02ca1262c0c6e37e4655f9d9))


### Bug Fixes

* **ci:** restore plugin compatibility and isolate desktop tests ([df621f8](https://github.com/antelm-dev/shadergrove/commit/df621f860d8fcc81b772b5f0c040472f6547b90f))
* **glsl-analysis:** raise cache-probe errors after finally ([16f4d66](https://github.com/antelm-dev/shadergrove/commit/16f4d66a4ae6d5c12dfda475f2843f54de5129ee))

## [2.0.0](https://github.com/antelm-dev/shadergrove/compare/v1.5.0...v2.0.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **plugins:** importing from Shadertoy and exporting to Wallpaper Engine require installing and enabling the official plugins from Plugins → Available.

### Features

* **i18n:** speak the active language packs, over the bundled English ([47f3370](https://github.com/antelm-dev/shadergrove/commit/47f3370daff58aeb77bc190f81af42c07b1308e7))
* **plugins:** cut Shadertoy import and Wallpaper Engine export over to plugins ([ba508c2](https://github.com/antelm-dev/shadergrove/commit/ba508c21636885729003906ad270818200b0fba8))
* **plugins:** data-only theme and language packs as official defaults ([ac6a461](https://github.com/antelm-dev/shadergrove/commit/ac6a4616ecd3c817d77b80e8b849b2d15b440fee))
* **plugins:** default theme and language packs ([e009c80](https://github.com/antelm-dev/shadergrove/commit/e009c80b08ff0383140f59386b5367592e541cd5))
* **plugins:** install and run official project plugins from the Plugins tab ([cbb52c0](https://github.com/antelm-dev/shadergrove/commit/cbb52c09a739a9d982dee272307aa3c0d98772a8))
* **plugins:** offer plugin commands only while their plugin is active ([076b3dc](https://github.com/antelm-dev/shadergrove/commit/076b3dcb086da4200f3b261018c7c93dab4c67f5))
* **plugins:** offer plugin commands only while their plugin is active ([f40b1c8](https://github.com/antelm-dev/shadergrove/commit/f40b1c8f32edd88a5566ae904620d846526674f7))
* **plugins:** protocol-2 project contracts, host calls and release catalogue ([1b11a82](https://github.com/antelm-dev/shadergrove/commit/1b11a82338c002d570297243cc9cf5603d030d2c))
* **plugins:** seed the default packs once per plugin profile ([e33bb43](https://github.com/antelm-dev/shadergrove/commit/e33bb43c4d3eaf1660bc485807d00f465ccd242c))
* **plugins:** Shadertoy Import and Wallpaper Engine Export as installable official plugins ([16f334d](https://github.com/antelm-dev/shadergrove/commit/16f334d20c21caee524593c3f1574024f21b1148))
* **plugins:** Shadertoy Import package and shadertoy-api/v1 provider ([691907d](https://github.com/antelm-dev/shadergrove/commit/691907d4d59053c7976b1983d1382780a222790d))
* **plugins:** Wallpaper Engine Export package and wallpaper-web/v1 runtime ([cf4c0a4](https://github.com/antelm-dev/shadergrove/commit/cf4c0a4c446c9d5fba40875a362c059f79421aa2))
* **releases:** serve desktop downloads and changelogs from website ([6e2599c](https://github.com/antelm-dev/shadergrove/commit/6e2599c0006b0c0262fa7abfd46ef4ccb97b0392))
* **themes:** wear the official Light/Dark pack, with a System mode ([99d6800](https://github.com/antelm-dev/shadergrove/commit/99d6800a14a36763aabf4c5ac1c81f144aa0b518))
* **website:** configure studio link and soften hero backdrop ([b465c6e](https://github.com/antelm-dev/shadergrove/commit/b465c6e13a3339cda1c03eaac59b16371dec7c13))


### Bug Fixes

* **ci:** restore deployment checks with explicit shader fixtures ([80025ce](https://github.com/antelm-dev/shadergrove/commit/80025ce5d465d926e2ec8887fcaba2bc1c1659dd))
* **ci:** restore per-application image security scopes ([870de58](https://github.com/antelm-dev/shadergrove/commit/870de581786d2317a3012c2c7691c0c7e8117bd5))
* **deps:** patch Swagger runtime YAML parser vulnerability ([19eb5f2](https://github.com/antelm-dev/shadergrove/commit/19eb5f2a49554f98310bb9b3b9af8b89eb2693a6))
* **desktop:** let output and satellite windows read the theme and language packs ([86a3cf7](https://github.com/antelm-dev/shadergrove/commit/86a3cf751eca3438daff8d1c6085ee6c0e2662b3))
* **docker:** remove unused npm and apply Alpine security updates ([c8a7a54](https://github.com/antelm-dev/shadergrove/commit/c8a7a54809a252ae746670f6446f3f023fc3c4e2))
* **plugins:** abort a project delivery as soon as the open shader changes ([b21a81e](https://github.com/antelm-dev/shadergrove/commit/b21a81e8b330b0c1b86482cadcf26676a391aa66))
* **plugins:** address review of the project plugin workflow ([1da72ac](https://github.com/antelm-dev/shadergrove/commit/1da72ac820209451a62828fed16940a4a0f55724))
* **plugins:** keep concurrent installs and removals of defaults during seeding ([5893a7b](https://github.com/antelm-dev/shadergrove/commit/5893a7bb719cc9265f73f59b971342b33713e65d))
* **plugins:** keep every window's packs, theme and language in step ([939e711](https://github.com/antelm-dev/shadergrove/commit/939e7116bd3233937c49837df6d386a01b10b1ed))
* **plugins:** revalidate kept plugin commands and follow Plugins deep links ([ae33e78](https://github.com/antelm-dev/shadergrove/commit/ae33e7893153fd839836ead6bf5569142c2c7cc2))
* **plugins:** scroll to a deep-linked package only once ([31e9d90](https://github.com/antelm-dev/shadergrove/commit/31e9d901075ef30b6b873c6c5be12006d4047148))
* **plugins:** seed with an atomic insert-if-absent, and only undo its own write ([abfc3f6](https://github.com/antelm-dev/shadergrove/commit/abfc3f66e23a7971a2dea4283290193419f890b9))
* **plugins:** switch a package only while it is still installed ([4a46ee3](https://github.com/antelm-dev/shadergrove/commit/4a46ee37c9ed23918ec43c6f067c0716567bffdd))
* **plugins:** switch only the install a window lists ([ed53fc0](https://github.com/antelm-dev/shadergrove/commit/ed53fc08850bc9f580c411b67db96bc5a8bd46b1))
* **plugins:** undo a seed write that a concurrent removal overtook ([3fbddca](https://github.com/antelm-dev/shadergrove/commit/3fbddcad1914c7bd600227cb0339a14c87a225af))
* **plugins:** undo a seed write with an atomic compare-and-delete ([0df7371](https://github.com/antelm-dev/shadergrove/commit/0df7371b50bc01cc2241d569916394af7d278adf))
* **prefs,plugins:** stop windows answering each other's saves; no SSR channel ([cf73010](https://github.com/antelm-dev/shadergrove/commit/cf73010856554b5aeb50b4c5037ccdbff6cca09e))
* **staging:** send branch metadata to Dokploy webhook ([8e4aec4](https://github.com/antelm-dev/shadergrove/commit/8e4aec4723ac7b04e722656e2ab23b266cb1a2b5))
* **studio:** align toolbar icons and preserve minimized editor layout ([6129a9f](https://github.com/antelm-dev/shadergrove/commit/6129a9f5a0561dd2cbdbb4d3c6b5e0c0ac58043c))
* **studio:** retire default example shaders and clear saved template drafts ([3fc256b](https://github.com/antelm-dev/shadergrove/commit/3fc256b31fc836b3f95b941f68bcae1477e5f999))
* **studio:** update favicon and topbar logo ([f087773](https://github.com/antelm-dev/shadergrove/commit/f087773051b75dc3e72bb42cb1a73de8d290b6a3))

## [1.5.0](https://github.com/antelm-dev/shadergrove/compare/v1.4.0...v1.5.0) (2026-10-02)


### Features

* **backend:** publication snapshots and moderation storage ([9271018](https://github.com/antelm-dev/shadergrove/commit/9271018248b8bfcfbc38761cc7224974da325018))
* custom post-processing effects with per-instance ids ([65fa6c6](https://github.com/antelm-dev/shadergrove/commit/65fa6c646e186d77e40705ad05cbd3366f7da19c))
* local plugin package contract and bounded plugin host ([fdf752f](https://github.com/antelm-dev/shadergrove/commit/fdf752f0e9f475298d6ad0274348acacf8ce27bf))
* plugin themes (phase 1) ([a4406f5](https://github.com/antelm-dev/shadergrove/commit/a4406f5ff62420956e011f89484221b4afec8cc1))
* Plugins / Installed and the ISF filter package ([b218615](https://github.com/antelm-dev/shadergrove/commit/b218615634a923294a7cabf842c23e125543251e))
* **plugins:** effect candidates, app version and desktop plugin storage ([f047d72](https://github.com/antelm-dev/shadergrove/commit/f047d724e341a867dea5dc34657d315c75840f37))
* **plugins:** ISF FX filter package — import and export one-pass ISF as custom effects ([407b2ec](https://github.com/antelm-dev/shadergrove/commit/407b2ec0b09427f88f6d3d00aa1505e0c043585d))
* public Explore and minimal moderation (phase 1) ([2095ab0](https://github.com/antelm-dev/shadergrove/commit/2095ab0f117e5d96ebbcedcf3c16b599d203c502))
* **server:** public Explore and moderation API behind PUBLIC_EXPLORE_ENABLED ([72ab040](https://github.com/antelm-dev/shadergrove/commit/72ab04074564a511410b0f8aac13388efa002119))
* **shared:** declarative theme contributions and theme references ([e5b4ac2](https://github.com/antelm-dev/shadergrove/commit/e5b4ac28c0b98282696bad0634232eb6c97b44ee))
* **shared:** effect instance ids and embedded custom effects ([78d9ffb](https://github.com/antelm-dev/shadergrove/commit/78d9ffb2ff8de15384223e194bc39b61e7d1d850))
* **shared:** local plugin package contract ([d90fb15](https://github.com/antelm-dev/shadergrove/commit/d90fb155d0124b5f8ce4202da991c3765050eabf))
* **studio:** install, choose and keep plugin themes ([5945377](https://github.com/antelm-dev/shadergrove/commit/5945377dbfd633ba65dabc6d0d0b0af88dc208f9))
* **web:** bounded plugin host with transferable buffers ([b80ded7](https://github.com/antelm-dev/shadergrove/commit/b80ded797529f4d964f7ba3ad05f15fee25ce392))
* **web:** edit custom effects and duplicate instances in the rack ([fea10a4](https://github.com/antelm-dev/shadergrove/commit/fea10a4dd44ec42354f224274c5569a690d35a43))
* **web:** Explore pages, copy-to-library and the publish dialog ([75aa08f](https://github.com/antelm-dev/shadergrove/commit/75aa08f9be5df28a9e20f8f4d758ce1f3aa74feb))
* **web:** moderation page for publications, reports and restrictions ([f61e443](https://github.com/antelm-dev/shadergrove/commit/f61e443db5432fdac6d2525919f9fc64c8b18ccb))
* **web:** Plugins / Installed — install, enable, use and remove local plugins ([d1d4284](https://github.com/antelm-dev/shadergrove/commit/d1d4284fd1ac3ad3440a7da6d811ed2bfe7245d3))
* **web:** register /admin/publications ([b648698](https://github.com/antelm-dev/shadergrove/commit/b648698fffe3f19ab668f65bbb175ab3709652db))
* **web:** render custom post-processing effects per instance ([6bec582](https://github.com/antelm-dev/shadergrove/commit/6bec5827cc3b5a36b0e58fd094898d71afdd0f6f))
* **web:** route Explore over the editor and gate it on server capabilities ([d036ac7](https://github.com/antelm-dev/shadergrove/commit/d036ac762ef111346828f2c528ccada976a46023))
* **website:** port the sampled-grove mock to a Next.js app ([dfc6d7b](https://github.com/antelm-dev/shadergrove/commit/dfc6d7bc9e96c215a8047990c93ad01e15ac6127))


### Bug Fixes

* **backend:** no restore under a restriction, and one read for a publication's detail ([0889110](https://github.com/antelm-dev/shadergrove/commit/0889110d5b14f237f0836f8c56b56de63333af53))
* **editor:** colour the lines on screen without waiting for idle time ([a94b49c](https://github.com/antelm-dev/shadergrove/commit/a94b49c16fb2ebcffd563f9ce4d3ceb1713707d8))
* **editor:** colour the lines on screen without waiting for idle time ([e79b4fb](https://github.com/antelm-dev/shadergrove/commit/e79b4fba8821ee7a037a83a50f534cf4f72cea2f))
* effect errors follow the shader, the chain stops at its limit, oversize code stays out of the draft (codex round 2) ([c778d73](https://github.com/antelm-dev/shadergrove/commit/c778d73f635d29f6e4e6d60ac6a3879be8a4d995))
* **mcp:** bump bridge protocol to 3 for effect instance ids and custom effects ([feda525](https://github.com/antelm-dev/shadergrove/commit/feda5251fd523601005d36da82841d310d2a1046))
* **mcp:** bump the bridge protocol to 3 for effect instance ids and custom effects ([8094cc6](https://github.com/antelm-dev/shadergrove/commit/8094cc6bb64e773cc7479e17cd03ade5ca496e96))
* **plugins:** Codex round 1 — damaged records, stale imports, sized ISF passes; format ([112b85d](https://github.com/antelm-dev/shadergrove/commit/112b85dd6e6266e415081f1f37d0f3adf0048c8e))
* **plugins:** Codex round 10 — reserve GLSL ES 3.00 and three.js prefix identifiers ([982a4cc](https://github.com/antelm-dev/shadergrove/commit/982a4cc8af5433df3646bd93af280ad47d3619fa))
* **plugins:** Codex round 11 — no plugin action while one runs; document sampler2D on native exports ([8ea0279](https://github.com/antelm-dev/shadergrove/commit/8ea027906f4a0e958b5d0f586bcafac0959865a9))
* **plugins:** Codex round 12 — unique select option names, portable generator entry check ([28a61cf](https://github.com/antelm-dev/shadergrove/commit/28a61cf8bec857602f4ed745c2531f845e2e8d23))
* **plugins:** Codex round 2 — ISF export of native effects, inputs shadowed by declarations ([22f029c](https://github.com/antelm-dev/shadergrove/commit/22f029c53ca36d07583c5fab0a8166a121daf701))
* **plugins:** Codex round 3 — ISF float ranges, reserved names on export ([c27dcf6](https://github.com/antelm-dev/shadergrove/commit/c27dcf6972027109e4fcab1c54c590f2c9729c2e))
* **plugins:** Codex round 4 — reserve u_ names in the ISF plugin ([6841d9b](https://github.com/antelm-dev/shadergrove/commit/6841d9b73088bb170ee2349c78e306e4a133fe9c))
* **plugins:** Codex round 5 — every ISF input via a global, integer selects, review bound to its profile ([23ecc5d](https://github.com/antelm-dev/shadergrove/commit/23ecc5db2e2fec38a453eb814cebb09a50a75623))
* **plugins:** Codex round 6 — PASSINDEX for one-pass ISF filters ([5607665](https://github.com/antelm-dev/shadergrove/commit/56076650c3708ba79458059112f91354ff6a8f71))
* **plugins:** Codex round 7 — IMG_NORM_THIS_PIXEL, committed IndexedDB writes, bounded desktop reads, review read race ([8d287f6](https://github.com/antelm-dev/shadergrove/commit/8d287f6d36005ca22afe2bf9971a306aebb10244))
* **plugins:** Codex round 8 — swizzle names, non-string IndexedDB keys ([1144a73](https://github.com/antelm-dev/shadergrove/commit/1144a73bd5808acd302af1dc32e1aebcc462c641))
* **plugins:** Codex round 9 — GLSL keywords as names, comment terminators in the ISF header ([dd927f7](https://github.com/antelm-dev/shadergrove/commit/dd927f7c87eb31ca2938ed4bb485e8fc766627b0))
* scope built effect programs to their shader; never close away unapplied code (codex round 3) ([7df82db](https://github.com/antelm-dev/shadergrove/commit/7df82db593771698c688a2a98fddcbff3474808c))
* **studio:** avoid routing feedback loop in selection effect ([71da66f](https://github.com/antelm-dev/shadergrove/commit/71da66f567e8ceaf11ece07816199ca9c96de915))
* **web:** bound plugin result walk, empty events and exporter input (codex round 1) ([9d00e8b](https://github.com/antelm-dev/shadergrove/commit/9d00e8bf9b79d3db25b0fc70eb314ee7d54f83a8))
* **web:** charge sparse arrays for their length (codex round 4) ([16c9f2a](https://github.com/antelm-dev/shadergrove/commit/16c9f2ae3fc87ed47d2b3dacca52f1e90593da3d))
* **web:** charge views for their backing buffer and BigInts for their size (codex round 3) ([98c2265](https://github.com/antelm-dev/shadergrove/commit/98c226545fe762eced306ceedb7ef5a9983af4cd))
* **web:** effect code reaches the draft on every keystroke; the renderer debounces compiling ([7ebd1ad](https://github.com/antelm-dev/shadergrove/commit/7ebd1adbe5bc10ec2a4b37b5c6f0884b43e70c46))
* **web:** escape the plugin's own "$" keys on the wire (codex round 5) ([bf4c76e](https://github.com/antelm-dev/shadergrove/commit/bf4c76e35fc2aa8facf087c4e9dbbe7dd9a02356))
* **web:** keep a rejected custom edit off the last valid pass's uniforms (codex round 1) ([893de8f](https://github.com/antelm-dev/shadergrove/commit/893de8fadc3229c444aeea143ab8bd022abaeb49))
* **web:** keep effect names readable in the rack and the editor unclipped ([87b315b](https://github.com/antelm-dev/shadergrove/commit/87b315b98aff21fbbd402e33194ea26da5c0b364))
* **web:** keep plugin code out of the initial bundle ([23cfd89](https://github.com/antelm-dev/shadergrove/commit/23cfd895e4a372fa7542e621bab0f4552fc566b4))
* **web:** keep the moderation inspector with the list it was opened from ([9d5a7a4](https://github.com/antelm-dev/shadergrove/commit/9d5a7a4be739ac43f28e172a698925797c3d9038))
* **web:** load no plugin profile until the session is known ([2c2381c](https://github.com/antelm-dev/shadergrove/commit/2c2381c82fe0c8d1311ce7bdf8f0f8954c4b4187))
* **web:** measure plugin messages by walking, not JSON (codex round 2) ([8e88013](https://github.com/antelm-dev/shadergrove/commit/8e88013abe7d6cf4bc917426642f55e3d5ea5bc5))
* **web:** revert restores the effect values the editor opened with (codex round 5) ([45a7f7b](https://github.com/antelm-dev/shadergrove/commit/45a7f7b7f3686cfc9e3ea838cbd6d041d0dbd139))
* **web:** the effect editor never closes over edits it has not applied (codex round 4) ([282e098](https://github.com/antelm-dev/shadergrove/commit/282e098fb3d3797ef2a297c60567b00f8ec02486))


### Performance Improvements

* **preview:** stop redrawing a paused preview that has not changed ([404fa74](https://github.com/antelm-dev/shadergrove/commit/404fa7409aa6799dea3a38aaa7ab8362a70f295e))
* **preview:** stop redrawing a paused preview that has not changed ([a68af86](https://github.com/antelm-dev/shadergrove/commit/a68af86a1ccd273ea32c3fd555f00e3e5e68aa97))

## [1.4.0](https://github.com/antelm-dev/shadergrove/compare/v1.3.1...v1.4.0) (2026-09-30)


### Features

* **web:** a leaf-green accent of the app's own ([653b989](https://github.com/antelm-dev/shadergrove/commit/653b989e63fae75a11e305fedfd9e529a1e191e1))
* **web:** command palette on Ctrl+K ([ef8b2c7](https://github.com/antelm-dev/shadergrove/commit/ef8b2c72687d571b7d98318b1f7068c072d28de8))
* **web:** compact dialogs and an export settings sheet ([a49cc08](https://github.com/antelm-dev/shadergrove/commit/a49cc0820236c260705b89f6196c9fd684792fbf))
* **web:** neutral studio theme, compact density and opaque overlays ([c5bea40](https://github.com/antelm-dev/shadergrove/commit/c5bea40c27653a940abc0c6cd58546dc81342f32))
* **web:** opaque workspace, glass windows and an instrument-style inspector ([31f55d1](https://github.com/antelm-dev/shadergrove/commit/31f55d155e5f6803104cc8ef2ae9e78979823c33))
* **web:** self-host Inter and Material Symbols ([118af89](https://github.com/antelm-dev/shadergrove/commit/118af897900a2e41977be7b17b6e8b77d39572cd))
* **web:** shader browser with real previews, a grid view and a compact search ([4d16a36](https://github.com/antelm-dev/shadergrove/commit/4d16a36bb3d9b15e26f8db29fdf1a4fc20e7bb41))
* **web:** studio visual refresh milestone 2 ([12a17fc](https://github.com/antelm-dev/shadergrove/commit/12a17fc6acb72273d87e1864d376f20055a9f276))
* **web:** toolbar transport, centred document title and zen mode ([b4b43e9](https://github.com/antelm-dev/shadergrove/commit/b4b43e971148379b4ff0a4a3fe880db3d5b09a7b))


### Bug Fixes

* **web:** count active effects on the post-processing tab badge ([da8cc65](https://github.com/antelm-dev/shadergrove/commit/da8cc65709508cd6fe22d6668888911c16031d77))
* **web:** keep touch targets on the new inspector tabs, headings and transport ([582a7c5](https://github.com/antelm-dev/shadergrove/commit/582a7c514520c395c0bc25c51a3f1a1aed32484c))
* **web:** keys typed after Ctrl+K go to the palette, not the workspace ([8a78601](https://github.com/antelm-dev/shadergrove/commit/8a786011ceb183ece18a2c0314b0b2f303be0a05))
* **web:** never open the command palette over another dialog ([a04e69d](https://github.com/antelm-dev/shadergrove/commit/a04e69dcfc7717083707005c03b6ed69c2354e8c))
* **web:** zen mode fills the window with a detached preview and frees the top strip ([868c7ce](https://github.com/antelm-dev/shadergrove/commit/868c7ce3136212ba65ecca532902dbf7e9cc8b29))

## [1.3.1](https://github.com/antelm-dev/shader-studio/compare/v1.3.0...v1.3.1) (2026-09-27)


### Bug Fixes

* **desktop:** stop web auth client from blanking desktop startup ([c4ba8e4](https://github.com/antelm-dev/shader-studio/commit/c4ba8e48b019fae4f80a7e57d2bb3416aa1c4d30))

## [1.3.0](https://github.com/antelm-dev/shader-studio/compare/v1.2.0...v1.3.0) (2026-09-27)


### Features

* add account authentication and per-user shader libraries ([efc0df7](https://github.com/antelm-dev/shader-studio/commit/efc0df79f94830da9b680d27b5ea0a51b35fbabc))
* **api:** integrate @nestjs/swagger for API documentation and enhance logging ([544366c](https://github.com/antelm-dev/shader-studio/commit/544366c27a4bc78fe5d920c5a79aa6734dec8c66))
* **backend,server:** treat bundled examples as read-only templates ([14353cf](https://github.com/antelm-dev/shader-studio/commit/14353cfcd756e602ab990a95efff93df9488ddc9))
* **backend:** add summary revision and replace-from-payload under expectedRevision ([101b1a7](https://github.com/antelm-dev/shader-studio/commit/101b1a73f3ec56d10d048fb17ed7348b8a515a1a))
* **backend:** conditional delete on the thumbnail too ([f69ec0f](https://github.com/antelm-dev/shader-studio/commit/f69ec0ff68f00c70c89c8fb7049562a8128bf5f0))
* **backend:** delete a shader only at an expected revision ([1832106](https://github.com/antelm-dev/shader-studio/commit/1832106ad972fff85d46c6b1dbf6a792b6fdba8f))
* **backend:** delete a shader only at an expected revision (desktop sync M2-01) ([2fa2ec5](https://github.com/antelm-dev/shader-studio/commit/2fa2ec58f416d9ed974f639882825ba8e7845a12))
* **backend:** scope every shader operation to an owning user ([c20a7ce](https://github.com/antelm-dev/shader-studio/commit/c20a7cec98e85d67477e9bca7de84c98fbc0389e))
* desktop push sync with status icons and keep-both conflicts (desktop sync 04) ([a700b9e](https://github.com/antelm-dev/shader-studio/commit/a700b9edd0f0c0c63e99e0262fcdec0fac2e34d4))
* desktop sign-in through the system browser (desktop sync 03) ([db745dc](https://github.com/antelm-dev/shader-studio/commit/db745dc77f9eac007ff9922c4f93f875571e9ef6))
* **desktop:** delete linked shaders here or everywhere (desktop sync M2-03) ([23e9e18](https://github.com/antelm-dev/shader-studio/commit/23e9e18efa47d2c00ec056d597713b415c84e0ca))
* **desktop:** delete linked shaders here or everywhere through a tombstone queue ([833f34e](https://github.com/antelm-dev/shader-studio/commit/833f34ecfcc995095242d4faad221b4767f47f0f))
* **desktop:** expose sync over IPC and trigger it on local writes ([66f2b41](https://github.com/antelm-dev/shader-studio/commit/66f2b41c84359fc41aa408a5bd8fa4eb7731079d))
* **desktop:** pull account changes in every sync run ([d14c705](https://github.com/antelm-dev/shader-studio/commit/d14c705e90406210029b9686a2a80d017895717d))
* **desktop:** pull account changes in every sync run (desktop sync M2-02) ([4d8ef95](https://github.com/antelm-dev/shader-studio/commit/4d8ef950c8f1589b2dc78ed19ef86c700e25564a))
* **desktop:** push sync engine with keep-both conflict resolution ([e2daf46](https://github.com/antelm-dev/shader-studio/commit/e2daf463f75e469d1e80c874e392ed28a40e9e8b))
* **desktop:** sign in to the account through the system browser ([90f9c23](https://github.com/antelm-dev/shader-studio/commit/90f9c230c85e6c7b8874ee2f1d19a468e0425ed3))
* **desktop:** sync when the window gains focus ([5abfd93](https://github.com/antelm-dev/shader-studio/commit/5abfd93cf0dfe8738a18537b9cdb9134a927d99b))
* **nx-cloud:** setup nx cloud workspace ([8d8b90c](https://github.com/antelm-dev/shader-studio/commit/8d8b90c2fde55ed50b31ac99ef2424a6bd67c013))
* PKCE desktop sign-in handoff with bearer sessions (desktop sync 02) ([d8d473c](https://github.com/antelm-dev/shader-studio/commit/d8d473c21504b0d92f77c3809f6309ee9699dc9b))
* **server:** add PKCE desktop sign-in handoff with bearer sessions ([fa1bbc7](https://github.com/antelm-dev/shader-studio/commit/fa1bbc701a2d30f35fda6731d957fea9140708b3))
* **server:** authenticate with Better Auth and enforce it per request ([9038b06](https://github.com/antelm-dev/shader-studio/commit/9038b061517bff75286a526be44ace0a61143547))
* **server:** expose PUT /shaders/:id/bundle ([fc2ee4d](https://github.com/antelm-dev/shader-studio/commit/fc2ee4d1969044d7dcb8f5a528ab424286e63296))
* **server:** harden the session, log the audit trail, document the deploy ([3b9c7da](https://github.com/antelm-dev/shader-studio/commit/3b9c7dab556940e73012e7e6fbed0789daf87081))
* summary revision and replace-with-revision endpoint (desktop sync 01) ([f9f51d2](https://github.com/antelm-dev/shader-studio/commit/f9f51d2663615f72d1005cfef7dba7e80fae8c99))
* **vscode:** update extensions and settings for improved development experience ([81729f7](https://github.com/antelm-dev/shader-studio/commit/81729f7869da4209bb83f4908cda26ce6c30ed2a))
* **web:** add account button and auth preview dialog ([fbf8eda](https://github.com/antelm-dev/shader-studio/commit/fbf8eda3045da9bc321ffc814e7503a5849d83b4))
* **web:** add the /desktop/connect sign-in page ([097334d](https://github.com/antelm-dev/shader-studio/commit/097334d269f4337eff3e956d55ad6e783ba1da77))
* **web:** desktop account menu ([4c4bdec](https://github.com/antelm-dev/shader-studio/commit/4c4bdec282e515fdad62dec89de341452f2032e6))
* **web:** link the desktop app's latest GitHub release from the web menu ([cef8c19](https://github.com/antelm-dev/shader-studio/commit/cef8c19f1108a0360884f45113691c4d2aba0a49))
* **web:** offer Delete from this computer or Delete everywhere for linked shaders ([7e1da88](https://github.com/antelm-dev/shader-studio/commit/7e1da884edee56bec1c5969ca7815b4110aed7cf))
* **web:** open About from the web menu, link the changelog ([15af624](https://github.com/antelm-dev/shader-studio/commit/15af6240945e7c31a99f289028efd39bc6131458))
* **web:** prototype a sandboxed plugin host ([6bd6aaa](https://github.com/antelm-dev/shader-studio/commit/6bd6aaab0c04bd38a649958dd8e8ffbb226c08a0))
* **web:** prototype a sandboxed plugin host ([f2764ab](https://github.com/antelm-dev/shader-studio/commit/f2764ab5134fa8de2ba418362357f796b421961f))
* **web:** show sync status, upload actions and sync progress ([a05a93a](https://github.com/antelm-dev/shader-studio/commit/a05a93a4c14087cd83a2d5ad82dccdf9951e3965))
* **web:** show the release version in About on the web ([fc6fec6](https://github.com/antelm-dev/shader-studio/commit/fc6fec69d63876e05acbab9b44737fd0d708a647))
* **web:** sign in, recover and manage an account from the editor ([766fd3c](https://github.com/antelm-dev/shader-studio/commit/766fd3c48888075f69aad84800d2dc694bc08fc6))


### Bug Fixes

* **auth:** show active sessions without reauthentication ([66bdcbd](https://github.com/antelm-dev/shader-studio/commit/66bdcbd37186873d9b4112cb08471118e319d8d0))
* **backend:** guard the pushed thumbnail with an explicit concurrency token ([a6055ce](https://github.com/antelm-dev/shader-studio/commit/a6055ce0f3a199e50453e55b65775cd5d4d9db56))
* **backend:** keep a newer thumbnail and return the committed record on replace ([26bcd6f](https://github.com/antelm-dev/shader-studio/commit/26bcd6f60f3f5c1aa4de7958e49b41bf8d063235))
* **backend:** never reuse a thumbnail stamp after a clear ([aa0957b](https://github.com/antelm-dev/shader-studio/commit/aa0957b48682846966bc26a7f46be0a1dfd37838))
* **backend:** one Postgres lock order, shader row before its children ([84b83a4](https://github.com/antelm-dev/shader-studio/commit/84b83a488d1c7f8a7d56a724ea265d21f68da71a))
* **backend:** serialize the Postgres conditional delete with thumbnail writes ([2bace46](https://github.com/antelm-dev/shader-studio/commit/2bace4693a438e5f2fa2e3f737892a02b38c697d))
* **deploy:** forward every documented auth variable through Compose ([e2e5d5f](https://github.com/antelm-dev/shader-studio/commit/e2e5d5f49dfb4a6c046ba9355d49dc30bf48fee7))
* **desktop-sync:** bind linked deletes to the confirmed account and revision ([f740ff2](https://github.com/antelm-dev/shader-studio/commit/f740ff2221bc5c321663d22e5de064495c578271))
* **desktop-sync:** one intent record per linked delete, thumbnail-safe tombstones ([9eca0e6](https://github.com/antelm-dev/shader-studio/commit/9eca0e64ef7b3ce2918744b71f4d974103dd297a))
* **desktop-sync:** re-check the account right before a delete commits ([78e2f17](https://github.com/antelm-dev/shader-studio/commit/78e2f17747c9639a6c9948be39b149730f069655))
* **desktop:** acknowledge only what a pull reconciled ([0754d7d](https://github.com/antelm-dev/shader-studio/commit/0754d7dadc16bbd0cc9311408a97a8a5cf364d5e))
* **desktop:** bind each sync run to its account and mirror a missing thumbnail ([3de972e](https://github.com/antelm-dev/shader-studio/commit/3de972e4b56e996ba7b775fb6b33c04edb4d3662))
* **desktop:** keep sign-out final and join concurrent sign-ins ([0f06947](https://github.com/antelm-dev/shader-studio/commit/0f069473a546e6aa49fe80d72ef565bb0508ce06))
* **desktop:** keep the result of a sync request sent before an account switch ([42e5b64](https://github.com/antelm-dev/shader-studio/commit/42e5b64b15bfc4287848c8dd21915f4a30ec4aa1))
* **desktop:** pull thumbnails with a conditional library write ([144ff60](https://github.com/antelm-dev/shader-studio/commit/144ff6098bd30779a5bcadb1d055834ad73847fd))
* prepare release runtime and update documentation ([489afa6](https://github.com/antelm-dev/shader-studio/commit/489afa656db3cff95c49612ef6e76378ccb0fd4e))
* **server:** enforce the session idle window and absolute lifetime ([9e01d29](https://github.com/antelm-dev/shader-studio/commit/9e01d296796ea7936c10cffca2e611e4bb9e96d1))
* **server:** keep the session refresh inside the idle window, gate revocation on a fresh sign-in ([561f2bd](https://github.com/antelm-dev/shader-studio/commit/561f2bdc82abed299cbb7cf3d6d369b564f96c19))
* **server:** require the account password to issue a desktop handoff code ([46cb601](https://github.com/antelm-dev/shader-studio/commit/46cb601aeaf370a270dbb040aad7da89b704c5f4))
* **server:** retire the browser's previous session when it signs in again ([89fd6f4](https://github.com/antelm-dev/shader-studio/commit/89fd6f408a796ed5f16816817df0cd3174f1b50a))
* **server:** seed examples as system templates on both engines ([e6e10ed](https://github.com/antelm-dev/shader-studio/commit/e6e10edcad3190f5f721c68f914474ad7c551d3d))
* **web:** ask for the password when session management needs a fresh sign-in ([15bcb10](https://github.com/antelm-dev/shader-studio/commit/15bcb101a097ac0a390c7e11929dbb1c748fb34d))
* **web:** confirm the password on /desktop/connect and retry a failed session ([36d2894](https://github.com/antelm-dev/shader-studio/commit/36d28944bbc01c6679fd51fbf1cf13fc15f55019))
* **web:** keep /desktop/connect out of the route normalization ([ffbc5e8](https://github.com/antelm-dev/shader-studio/commit/ffbc5e8be373ee880b3a72da83cae4d7dcae10df))
* **web:** keep the workspace in sync with the signed-in account ([f754f81](https://github.com/antelm-dev/shader-studio/commit/f754f8109cbed9b1797073dd9dc5f72f52b0836c))
* **web:** let the browser fetch the library when SSR could not ([7ce0ec5](https://github.com/antelm-dev/shader-studio/commit/7ce0ec5e49d6cdeab9902ddd8fffc6dfed61ce33))
* **web:** map the post-processing inspector tab to its index ([53a2ed9](https://github.com/antelm-dev/shader-studio/commit/53a2ed9de7a2a9e4b3b637f56db25f3584f5fb1c))
* **web:** place sync actions with the desktop account ([0b1f8e4](https://github.com/antelm-dev/shader-studio/commit/0b1f8e40d402b7dbbe7415f8d0ae70f483b7e2a7))
* **web:** reload the open shader after keep both, and format app.html ([c7c33f9](https://github.com/antelm-dev/shader-studio/commit/c7c33f95900b2d9af17308a7344070e29446a8da))
* **web:** surface failed sign-out and session revocation ([7f70330](https://github.com/antelm-dev/shader-studio/commit/7f70330a6c2bbddd6d65a084eb8fc2c285b785c7))
* **web:** terminate the plugin Worker explicitly ([85b2e8c](https://github.com/antelm-dev/shader-studio/commit/85b2e8c1954cc0e779e56e11a3d203f36b892e84))

## [1.2.0](https://github.com/antelm-dev/shader-studio/compare/v1.1.0...v1.2.0) (2026-07-30)


### Features

* Bloom + Vignette Effects Rack (round-1 fix) ([eaa1e9e](https://github.com/antelm-dev/shader-studio/commit/eaa1e9e38f60c8483e68820741211bfd94052e9b))
* post-processing chain foundation and Bloom migration ([00a73db](https://github.com/antelm-dev/shader-studio/commit/00a73db368b1e393ec8a65de02eda91efe90b2bf))
* **shared:** add Vignette to the post-processing chain model ([7067ff5](https://github.com/antelm-dev/shader-studio/commit/7067ff5d7725f10b079554163e42d58e9d76c1bd))
* **shared:** replace Bloom-only render contract with a post-processing chain ([c55618d](https://github.com/antelm-dev/shader-studio/commit/c55618db4f3bb49b442b208f2299638ac9733a17))
* **web:** rebuild PostProcessing composer ownership on the effect chain ([eb92c45](https://github.com/antelm-dev/shader-studio/commit/eb92c457dd50428cadee5b80c4b469244a0049c2))
* **web:** render the chain by its own order, add a Vignette pass ([d244ece](https://github.com/antelm-dev/shader-studio/commit/d244ecef72965a3287159aeea49cfd61f84eb15e))
* **web:** ship the Effects Rack, generalize preset/wallpaper wording ([dda9fc2](https://github.com/antelm-dev/shader-studio/commit/dda9fc207d904afb3eca8b42166639f96122ea84))


### Bug Fixes

* **web,docs:** resolve round-1 review blockers on the Effects Rack ([8e51a66](https://github.com/antelm-dev/shader-studio/commit/8e51a66c74c2662533b9a4fe2fb3dcfdd926ab17))

## [1.1.0](https://github.com/antelm-dev/shader-studio/compare/v1.0.0...v1.1.0) (2026-07-30)


### Features

* **inspector:** add contained floating inspector surface ([c798cec](https://github.com/antelm-dev/shader-studio/commit/c798cec8dd5d526916064e4b0271f2acd31dc0b6))
* **inspector:** contained floating inspector surface ([7b9f623](https://github.com/antelm-dev/shader-studio/commit/7b9f62301e6dda3e82434a9ef164c7f04f422b55))
* **panel:** integrate profiler into bottom panel and update inspector references ([20d0f24](https://github.com/antelm-dev/shader-studio/commit/20d0f241f91d60cb926490417045cd7546567cd9))
* **rendering:** add dormant performance profiler telemetry ([a345b68](https://github.com/antelm-dev/shader-studio/commit/a345b688cf533429aa536c6d303abe74de731cf8))
* **surfaces:** enable inspector float capability (phase 1) ([d135a07](https://github.com/antelm-dev/shader-studio/commit/d135a07f79ac32ff7ebbceab3896f3621e8b4efe))
* **surfaces:** register the inspector in SurfaceLayoutService ([be3f403](https://github.com/antelm-dev/shader-studio/commit/be3f40368382fc4f74f97a5a522c57bca6d02aef))
* **web:** add performance profiler ([2ff9598](https://github.com/antelm-dev/shader-studio/commit/2ff95981411655dc7c4c83e32d6cd28623b3ec91))
* **web:** add profiler inspector tab and downscale advisory ([a75de09](https://github.com/antelm-dev/shader-studio/commit/a75de092ed0487275986b3b5c01d8400de0ac6a1))


### Bug Fixes

* **ci:** repair smoke selector, formatting, and MCP tarball timeout ([e9ef803](https://github.com/antelm-dev/shader-studio/commit/e9ef803a5224f3b206dbb8ccaa8be8002b8cca2b))
* **renderer:** overflow in problems and output panels ([9b5069d](https://github.com/antelm-dev/shader-studio/commit/9b5069d77032db706a73b7cddd5d52e1347560dd))
* **rendering:** cancel stale composer loads with a generation token ([6dbf7a6](https://github.com/antelm-dev/shader-studio/commit/6dbf7a6fb21f850f7ab51461a289f46074204cd9))
* **rendering:** harden profiler query semantics and lifecycle ([57eff67](https://github.com/antelm-dev/shader-studio/commit/57eff670a2d33bdcf8fe661664d61a90536cdd6f))
* **rendering:** keep compile IDs and memory estimates coherent ([40682ce](https://github.com/antelm-dev/shader-studio/commit/40682ce0675b0d1a3ff748d67fec364a8c5813aa))
* **rendering:** read current bloom settings in continuation, not captured argument ([453adb4](https://github.com/antelm-dev/shader-studio/commit/453adb47f456d7f26c2955dc22f0225b32badc44))
* **rendering:** reset pending queries and sync profiling idempotently ([319c54c](https://github.com/antelm-dev/shader-studio/commit/319c54c017d90bb288b2d26248ef22c8f00f95f8))
* **rendering:** reset profiler for live workload changes ([ab521f9](https://github.com/antelm-dev/shader-studio/commit/ab521f90c66004fd5a471a00ce70274fc5d956c5))
* **rendering:** reset profiler samples after context restore ([07241c1](https://github.com/antelm-dev/shader-studio/commit/07241c1024f1dcc0d5dd9de60ed32fd281698d90))
* **web:** clear stale profiler UI and cover lifecycle paths ([e0b0af6](https://github.com/antelm-dev/shader-studio/commit/e0b0af610290bee872003f0d66b0951759b688fc))
* **web:** contain profiler table overflow ([4b114ee](https://github.com/antelm-dev/shader-studio/commit/4b114ee5ab3bb67ec2b306a43614fe050ab25e76))
* **web:** tighten profiler advisory and accessibility ([8f4306f](https://github.com/antelm-dev/shader-studio/commit/8f4306f94d1ee13e36e56a8ffe8f4ca1edfa6bee))

## 1.0.0 (2026-07-28)

### Features

- **actions:** add explorer command adapters for ShaderStore flows ([28f0b27](https://github.com/antelm-dev/shader-studio/commit/28f0b27d3477a891338fd8acba76da139c5b1e43))
- add desktop support and enhance UI interactions ([3d71d61](https://github.com/antelm-dev/shader-studio/commit/3d71d61efe1300a5e362520d28d8ff5b7395ece8))
- add Drizzle ORM to backend dependencies, and enhance PostgreSQL repository with Drizzle integration ([290c484](https://github.com/antelm-dev/shader-studio/commit/290c48426751ded6e2ac9d829ca11159c593fa28))
- add internationalization support and enhance application configuration ([bd467c0](https://github.com/antelm-dev/shader-studio/commit/bd467c02992adfe9a1f7309c8b204e1175a7a31a))
- add IPC bridge generation step to CI and improve smoke script error handling ([d53d4d7](https://github.com/antelm-dev/shader-studio/commit/d53d4d71537693d9f87ae759ac97652b290f9c6e))
- add output window functionality and enhance UI with document status indicators ([f7df0bc](https://github.com/antelm-dev/shader-studio/commit/f7df0bc819a807d933ef651bc2a7bb181a2e5de5))
- add thumbnail management for shaders ([c7ed582](https://github.com/antelm-dev/shader-studio/commit/c7ed58208a230729511710ee23afe9caa6514dac))
- copy the fragment as standalone GLSL, uniforms included ([f7e8340](https://github.com/antelm-dev/shader-studio/commit/f7e8340348be4dc45185f3685201c37d0bbc562d))
- **database:** integrate PostgreSQL support and migrate legacy shader library to new SQL structure ([62f2a96](https://github.com/antelm-dev/shader-studio/commit/62f2a96289242f4909d4ba2d7186da4d82780489))
- **desktop:** add DevTools toggle and allowlisted support-link IPC ([1408ea4](https://github.com/antelm-dev/shader-studio/commit/1408ea4556aed1e2b640ab2a2d64386637dbf4ba))
- **desktop:** add secure Electron surface window manager ([75adebb](https://github.com/antelm-dev/shader-studio/commit/75adebbbe447a0363bd3e068776ec90a656bc4a6))
- **desktop:** wire typed surface IPC and live-preview-output adapter ([8c2ed8f](https://github.com/antelm-dev/shader-studio/commit/8c2ed8f6dad8d0e52e9f3f1046a594965a9757e8))
- **editor:** embed the project explorer in the panel ([42763b2](https://github.com/antelm-dev/shader-studio/commit/42763b2e0889874456a1a3b5548918e063745073))
- enhance desktop functionality with fullscreen toggle and import from Shadertoy feature ([95b7b6c](https://github.com/antelm-dev/shader-studio/commit/95b7b6c1568332367b8befed7878af26acc345ed))
- enhance document status management ([f407124](https://github.com/antelm-dev/shader-studio/commit/f4071245d14a2f1795911f53e6b25c8286ec2132))
- enhance MCP bridge and protocol with structured error handling and new command schemas ([bec5e78](https://github.com/antelm-dev/shader-studio/commit/bec5e78d2a6b5970de9fdb6963b88ad1f6b0bec6))
- enhance project structure and shader management ([5860876](https://github.com/antelm-dev/shader-studio/commit/58608760300716bc3530aee4dff65c557590d9f1))
- enhance typecheck and CI workflows with additional checks and Playwright integration ([c416ff4](https://github.com/antelm-dev/shader-studio/commit/c416ff412e7820956fffeceb048912b8df4285d1))
- expand shared module with new components and update import paths ([ad453f0](https://github.com/antelm-dev/shader-studio/commit/ad453f055da05454020f42145303b6a1062b794c))
- **export:** add Wallpaper Engine HTML export functionality ([a69ad02](https://github.com/antelm-dev/shader-studio/commit/a69ad02e7e2a782aeaa1eedf0af5d5f4d8d80420))
- **file-explorer:** add standalone explorer panel component ([bc3edc7](https://github.com/antelm-dev/shader-studio/commit/bc3edc750694618df7e8ce958fbb60b241144c50))
- **file-explorer:** add tree helpers for panel rendering ([0188ef8](https://github.com/antelm-dev/shader-studio/commit/0188ef8f54964d2cabab438637e87774c94a5a8d))
- format GLSL, and offer snippets for what the engine provides ([4bce846](https://github.com/antelm-dev/shader-studio/commit/4bce846af7e25eae9ced56297d5feb263bbe343a))
- **i18n:** add explorer.* strings for file explorer panel ([565ce3d](https://github.com/antelm-dev/shader-studio/commit/565ce3dd9041a5e33b1b03213dc4c06d227b9b66))
- implement capture plan and normalization logic ([35fdb37](https://github.com/antelm-dev/shader-studio/commit/35fdb37388d17651214cfe54fb44678fe1e3663c))
- implement desktop platform integration with API and shader management features ([62043af](https://github.com/antelm-dev/shader-studio/commit/62043af480ad1ca29f2e943266790db55be3a3b7))
- implement dynamic resizing for shader browser and inspector panels ([d70cfb7](https://github.com/antelm-dev/shader-studio/commit/d70cfb73735cbd480b4af6eb481265152d4ebbc9))
- implement texture channel management for shaders ([ed72306](https://github.com/antelm-dev/shader-studio/commit/ed72306c03a46a179b580ddb12207dbdf8079d9b))
- initial commit — Shader Studio ([d48a81a](https://github.com/antelm-dev/shader-studio/commit/d48a81a54af3c0151c2a4cc3171abd061c755a1f))
- integrate Angular localization support and update configuration ([c466d24](https://github.com/antelm-dev/shader-studio/commit/c466d240cdc6a51d2881e98722249ce4745c2f6a))
- integrate electron-updater for automatic updates ([b97d380](https://github.com/antelm-dev/shader-studio/commit/b97d380307483354c584681d8080f34fae95fe80))
- let a preset capture the render settings ([f6a9f1a](https://github.com/antelm-dev/shader-studio/commit/f6a9f1aef3339f76be3efb25cd0d40d0f66ae001))
- **panel:** implement bottom panel for Problems and Output ([d034c12](https://github.com/antelm-dev/shader-studio/commit/d034c12c18962862f4215d7bf345f548b56c2282))
- **prefs:** persist editor-local file explorer layout ([6db754c](https://github.com/antelm-dev/shader-studio/commit/6db754c83756e0881e7db0049a30cbd1f6d90aba))
- **release:** add release management configuration and workflows ([21a8628](https://github.com/antelm-dev/shader-studio/commit/21a8628e389507d3b905699332e2ea9eab8b2265))
- restructure shared module with updated import paths and remove deprecated capture plan ([8562c01](https://github.com/antelm-dev/shader-studio/commit/8562c01e0c13f44c8134518516cb4b3234d0ee70))
- revamp README with enhanced project description, highlights, and quick start guide ([b4c33a3](https://github.com/antelm-dev/shader-studio/commit/b4c33a3dbab1daa596aad47d86c46cd6a03e33d7))
- **server:** integrate NestJS for API routing and update dependencies ([9c43404](https://github.com/antelm-dev/shader-studio/commit/9c43404573869e4c2b362714497eeb3c8574f7c2))
- **session:** add in-process, IPC, and BroadcastChannel seams ([db63c2d](https://github.com/antelm-dev/shader-studio/commit/db63c2d01999be7e09b834c4851b0ced816f9e34))
- **session:** add transport-neutral session broker ([ddda963](https://github.com/antelm-dev/shader-studio/commit/ddda96325f25feedd5531dc4469f2944aeaf310d))
- **session:** add workspace session protocol types and validation ([6ebdf32](https://github.com/antelm-dev/shader-studio/commit/6ebdf321fa82f827871bcdd763d03ef5e5c3a852))
- **shader:** implement Shadertoy import functionality with API support ([a896ffb](https://github.com/antelm-dev/shader-studio/commit/a896ffbf5760a2c554c661f078f2ab74d33ff5fd))
- **shared:** add pure shader-scoped editor group state ([f05d610](https://github.com/antelm-dev/shader-studio/commit/f05d6108c24b8f2e973d6b076631445d88f8e1a2))
- **shared:** bridge editor groups to session ownership ([72aff62](https://github.com/antelm-dev/shader-studio/commit/72aff625c36e7521240c77e5b6fd74b062b3143d))
- **surfaces:** add contained registry, controller, and geometry runtime ([e302092](https://github.com/antelm-dev/shader-studio/commit/e30209270124ebba4aab66220dd918af4735d160))
- **surfaces:** add pure types, capabilities, placement, and transitions ([135c71b](https://github.com/antelm-dev/shader-studio/commit/135c71b78d0730aff136f40b38f86c5910638c10))
- **surfaces:** add sanitizers, legacy migration, and package exports ([bb10447](https://github.com/antelm-dev/shader-studio/commit/bb10447fce9bfa3ee8eee502fbcbb1459dcb205f))
- **surfaces:** add title-bar, resize, and workspace control seams ([46e5208](https://github.com/antelm-dev/shader-studio/commit/46e5208613e0d752f4053e1f124ebf077829b68e))
- **ui:** add quick action buttons for inspector and image capture in the toolbar ([7598b3b](https://github.com/antelm-dev/shader-studio/commit/7598b3bfe24c0f5218e506923d951052032b5a73))
- update server configuration to include i18n support and adjust API base URL ([855e42d](https://github.com/antelm-dev/shader-studio/commit/855e42dbb52b1e11b93b60163d699b1a49873b5e))
- update shader export functionality and remove unused assets ([cce37f2](https://github.com/antelm-dev/shader-studio/commit/cce37f28ba7dc946b0e8c08acd82845e44b73368))
- **web:** add EditorGroups service and session adapter ([d2c3883](https://github.com/antelm-dev/shader-studio/commit/d2c388342017f9d916980b5191ad90750ac16675))
- **web:** add file explorer contract types and node ids ([58da3be](https://github.com/antelm-dev/shader-studio/commit/58da3be0afa9a18204ea290f4a1583546712b816))
- **web:** add Help shortcut catalog and localized labels ([dbd48bb](https://github.com/antelm-dev/shader-studio/commit/dbd48bb4b969142af91caa4b4664712080d2529a))
- **web:** add KeyboardShortcutsDialog ([30d5d68](https://github.com/antelm-dev/shader-studio/commit/30d5d6876629316fa33ca1a0dc3a005400cd602f))
- **web:** add session-scoped open-document tab state ([8c7b9de](https://github.com/antelm-dev/shader-studio/commit/8c7b9de5c048de9e9f7e8ee28e41a9514cc60890))
- **web:** expose DevTools and support-link actions on DesktopPlatform ([2eeb4f8](https://github.com/antelm-dev/shader-studio/commit/2eeb4f83142078480ce4eab7620caff5ceb28e87))
- **web:** make editor tab strip open-document only ([93f7de0](https://github.com/antelm-dev/shader-studio/commit/93f7de0e131b7bd1a41081603b023b3fa12cc17a))
- **web:** migrate editor shell to contained surface runtime ([8607a49](https://github.com/antelm-dev/shader-studio/commit/8607a49416b4f47bc93e869c79d371bafcd30576))
- **web:** migrate preview shell to contained surface runtime ([9e568b0](https://github.com/antelm-dev/shader-studio/commit/9e568b002ba2e72003f6593c14b302e600ec8363))
- **web:** persist versioned surfacesLayout with legacy dual-read ([0b672d4](https://github.com/antelm-dev/shader-studio/commit/0b672d42996e73a9553bde13c1a8a56d0bebf5b7))
- **web:** refine desktop version dialog as About view ([febeaf6](https://github.com/antelm-dev/shader-studio/commit/febeaf6dace1c2049061df991210f3666089c8ad))
- **web:** rename "renderer" app to "web" ([97e23c4](https://github.com/antelm-dev/shader-studio/commit/97e23c4b71846a1f90d4abd67d3dc172d13a4f33))
- **web:** update project structure and configurations to reflect renaming from "renderer" to "web", including adjustments in scripts, build paths, and documentation ([c977200](https://github.com/antelm-dev/shader-studio/commit/c977200f3cbc42d2ecb7cdeaf2cef6d2df4e714e))
- **web:** wire editor tabs to group move commands ([001dde5](https://github.com/antelm-dev/shader-studio/commit/001dde5dc7375caa79648f15b9772593b8d98c84))
- **web:** wire Help menu, DevTools, and Ctrl+Shift+I ([c84a788](https://github.com/antelm-dev/shader-studio/commit/c84a7886fbed677896ef51eaf0c090d81f20798b))

### Bug Fixes

- **ci:** resolve Playwright from workspace package ([c809f7f](https://github.com/antelm-dev/shader-studio/commit/c809f7f5257d69a3f5fe73fad74a7ba250f1cedd))
- **desktop:** make native surface open await successful loadURL ([3b7d8ba](https://github.com/antelm-dev/shader-studio/commit/3b7d8bae6c930a61960fc91cf838eb8480b6ee24))
- **desktop:** use generator API for IPC bridge codegen ([49c401a](https://github.com/antelm-dev/shader-studio/commit/49c401a98b7483e7500a659ea16b0ca61fef2c6e))
- **editor:** restore file explorer compile compatibility ([04102a7](https://github.com/antelm-dev/shader-studio/commit/04102a7271b9abf38e23f8625df12f3d343e98c0))
- **file-explorer:** align editor integration seams ([27cbd73](https://github.com/antelm-dev/shader-studio/commit/27cbd738237a066d7465633e5cc6f4a7082adaed))
- **file-explorer:** carry binding label params through projection ([286ba87](https://github.com/antelm-dev/shader-studio/commit/286ba8778b54129986dfdc3922703c9e25dc761c))
- **file-explorer:** resolve pipeline binding labels in the panel ([8ea4c15](https://github.com/antelm-dev/shader-studio/commit/8ea4c1574b62641a40387a206504e81e8035965d))
- **file-explorer:** stabilize focus and interaction QA ([77be28d](https://github.com/antelm-dev/shader-studio/commit/77be28d1883b3524f1e249e8f6ce9ca5d20f669e))
- **session:** use index access for params in broker tests ([e07d4f0](https://github.com/antelm-dev/shader-studio/commit/e07d4f0d68803592b2a326f141fd594f9a4a1325))
- **surfaces:** default live-preview-output to native placement ([1b150f6](https://github.com/antelm-dev/shader-studio/commit/1b150f6aef297097d0b1e5f678f8b4ae764f5d9f))
- **test:** remove superseded preference imports ([e5af105](https://github.com/antelm-dev/shader-studio/commit/e5af105513f397981dce45079cbc382e9fb26844))
- **test:** seed native surface layout in titlebar prefs ([00701cb](https://github.com/antelm-dev/shader-studio/commit/00701cbbab90b908f09eeb86bf175063efc55fe9))
- update typecheck script to include IPC generation step ([4e2a8b2](https://github.com/antelm-dev/shader-studio/commit/4e2a8b213b948179203e53cdc922814a9902ce33))
- **web:** hide shortcut kbd tokens from assistive tech ([39b3c9a](https://github.com/antelm-dev/shader-studio/commit/39b3c9ad337f7a91bb7e8471121bef9f3f228c72))
- **web:** ignore key-repeat for DevTools toggle ([77bd90f](https://github.com/antelm-dev/shader-studio/commit/77bd90f0c30613b3004f578d098c0af2f0c22047))
- **web:** keep explorer header controls reachable at narrow widths ([7ba8e12](https://github.com/antelm-dev/shader-studio/commit/7ba8e12060054ef685b9e2b8032cba3fd84f9ab4))
- **web:** open explorer Enable menu from keyboard ([8219f0d](https://github.com/antelm-dev/shader-studio/commit/8219f0d8fa475ee164426964b1582b7162c02805))
- **web:** stop marking render-disabled buffers as aria-disabled ([abc6f17](https://github.com/antelm-dev/shader-studio/commit/abc6f17a29449653e9f341431e64948dc96a466b))
- **workspace:** run IPC stability check without Nx cache ([d799030](https://github.com/antelm-dev/shader-studio/commit/d799030d7b5332864bab65c4e4209bb81876d152))
