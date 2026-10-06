# Third-party notices

Shadergrove is licensed under Apache-2.0. The following third-party runtime
dependencies remain under their own licenses. This list describes direct runtime
dependencies used by the web and desktop applications; transitive dependencies
retain the notices and license texts shipped in their respective packages.

| Software                                                    | Version | License    |
| ----------------------------------------------------------- | ------: | ---------- |
| Angular framework packages and Angular CDK/Material         |  22.0.x | MIT        |
| Electron                                                    | 40.10.6 | MIT        |
| electron-updater                                            |   6.8.9 | MIT        |
| Express                                                     |   5.2.1 | MIT        |
| Inter font (`@fontsource-variable/inter`)                   |   5.3.0 | OFL-1.1    |
| JetBrains Mono font (`@fontsource-variable/jetbrains-mono`) |   5.3.0 | OFL-1.1    |
| lil-gui                                                     |  0.21.0 | MIT        |
| Material Symbols font (`material-symbols`)                  |  0.47.5 | Apache-2.0 |
| Mediabunny                                                  |  1.50.8 | MPL-2.0    |
| Monaco Editor                                               |  0.55.1 | MIT        |
| RxJS                                                        |   7.8.2 | Apache-2.0 |
| three.js                                                    | 0.185.1 | MIT        |
| tslib                                                       |   2.8.1 | 0BSD       |
| Zod                                                         |   4.4.3 | MIT        |
| electron-ipc-module                                         |   0.1.0 | MIT        |
| electron-run                                                |   0.1.0 | MIT        |

The complete dependency versions are recorded in `pnpm-lock.yaml`. License texts
and copyright notices are available in each dependency's distributed package.
Binary distributors must preserve those notices and comply with the applicable
terms, including the file-level source availability requirements of MPL-2.0 for
Mediabunny-covered files.

## GLSL analysis WebAssembly (`libs/glsl-analysis`)

The private `@shadergrove/glsl-analysis` package is not yet imported by any
application. Its build output (`glsl-analysis.wasm` and the Worker bundle) contains
the components below; any host that ships it must ship `dist/licenses/` with it.

| Software                                                     | Version / pin                                               | License                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| glslang (frontend sources listed in `third_party/glslang`)   | 16.6.0, commit `8ba5ca7cae66a5306a50b6d1db50875c50a5c77a`   | BSD-3-Clause (3Dlabs, LunarG, Google, ARM, NVIDIA, ANGLE and other copyright holders; see `third_party/glslang/LICENSE.txt`) |
| glslang generated parser (`glslang_tab.cpp`, from GNU Bison) | same                                                        | GPL-3.0-or-later with the Bison exception 2.2 (output may be distributed under the terms of the rest of glslang)             |
| Emscripten runtime and JavaScript glue                       | 6.0.11 (release `f6264d4a4dd9ba24a9f0a5702835a44d1463de13`) | MIT or NCSA (dual, see `dist/licenses/emscripten-LICENSE.txt`)                                                               |
| LLVM libc++ and libc++abi                                    | bundled with Emscripten 6.0.11                              | Apache-2.0 WITH LLVM-exception                                                                                               |
| LLVM compiler-rt builtins                                    | bundled with Emscripten 6.0.11                              | Apache-2.0 WITH LLVM-exception                                                                                               |
| musl libc                                                    | bundled with Emscripten 6.0.11                              | MIT                                                                                                                          |

Build-time only, not distributed: the Emscripten/LLVM/Binaryen toolchain itself, esbuild
(MIT), Playwright (Apache-2.0), Vitest (MIT) and TypeScript (Apache-2.0).
glsl_analyzer (GPL-3.0) was reviewed for the backend decision only; none of it is copied,
built or distributed. No glslang source is modified (`patches: []`).

Shadergrove does not claim copyright in third-party software, trademarks, or
other materials. No Creative Commons NonCommercial shader is distributed in the
`examples/shaders` collection.
