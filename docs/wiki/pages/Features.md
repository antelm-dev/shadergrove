# Features

Use this page to find a workflow and check where it is available.

**Version scope:** core features below are present in v1.5.0 and the development code checked on 6 October 2026. **Development** identifies the newer official plugin catalogue workflow. Server configuration can limit account and public features.

## Create and experiment

| Feature             | What you can do                                                                                | Web | Windows Desktop |
| ------------------- | ---------------------------------------------------------------------------------------------- | --- | --------------- |
| Live GLSL editor    | Edit source with snippets and compiler diagnostics while the last valid preview keeps running. | Yes | Yes             |
| Multipass projects  | Compose an Image pass, shared Common code, up to four Buffer passes, and include files.        | Yes | Yes             |
| Generated controls  | Turn a JSON schema into sliders, checkboxes, color pickers, and selects bound to uniforms.     | Yes | Yes             |
| Texture inputs      | Assign image assets and configure channel sampling.                                            | Yes | Yes             |
| Pointer interaction | Read mouse position, velocity, and click-ripple data from a shader.                            | Yes | Yes             |
| Presets             | Name and restore parameter values, optionally including render settings.                       | Yes | Yes             |
| Effects rack        | Add, order, toggle, duplicate, and tune post-processing effects; author custom GLSL effects.   | Yes | Yes             |
| Render controls     | Pause time, change render scale, and inspect rendering performance.                            | Yes | Yes             |

**Start with:** [First shader](First-shader) and [Workspace](Workspace).

Built-in post effects include Bloom and Vignette. Custom effects process the output of the Image pass; the rack does not apply to intermediate Buffer passes. The resulting appearance depends on the effect order.

## Keep and present your work

| Feature                | What you can do                                                              | Web             | Windows Desktop   |
| ---------------------- | ---------------------------------------------------------------------------- | --------------- | ----------------- |
| Personal library       | Save, rename, duplicate, and organize your shaders.                          | Account library | Local library     |
| Portable JSON          | Import or export a shader or a collection, including its project and assets. | Yes             | Yes               |
| PNG capture            | Save the current rendered frame.                                             | Yes             | Yes               |
| Animation capture      | Export WebM video or a PNG frame sequence with capture settings.             | Yes             | Yes               |
| Zen mode and panels    | Hide interface elements and adjust your workspace layout.                    | Yes             | Yes               |
| Separate output window | Show a clean live render on a second monitor or projector.                   | —               | Yes               |
| Offline editing        | Open and edit the local library without signing in.                          | —               | Yes               |
| Account uploads        | Upload local shaders to a configured account server.                         | —               | Configured builds |

Desktop uploads do not provide a complete two-way mirror of the Web library. Use JSON export/import when you need to move a project between installations.

## Discover and share

| Feature                                          | Web                                                                      | Windows Desktop                 |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------- |
| Private account library                          | Yes; editing requires a verified email.                                  | Local library remains separate. |
| Public Explore and public shader pages           | Available when the server enables public Explore.                        | Use the Web app.                |
| Publish, update, and unpublish a shader snapshot | Available on an enabled server, subject to account and moderation rules. | Use the Web app.                |
| Copy a public shader into your library           | Requires a verified account on that server.                              | Transfer a project using JSON.  |

Public publishing is an explicit action. Saving a private draft does not automatically update its published snapshot. Follow the publication actions to update what visitors see. [Publication behavior and server configuration](https://github.com/antelm-dev/shadergrove/blob/master/docs/public-explore-api.md).

## Extend and automate

| Feature                              | v1.5.0                                               | Development                                                     |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| Shadertoy import                     | Built-in import command.                             | Install and enable the official importer plugin.                |
| Wallpaper Engine export              | Built-in standalone HTML export.                     | Install and enable the official exporter plugin.                |
| Local plugin packages                | Install a compatible package from a file.            | Local packages plus the bundled official catalogue.             |
| Official theme and language packages | The newer default-package catalogue is not included. | Default Light/Dark themes and English/French language packages. |
| MCP                                  | Requires explicit setup and an enabled local bridge. | Requires explicit setup and an enabled local bridge.            |

Read [Plugins and integrations](Plugins-and-integrations) for the user workflows and compatibility limits.

## Current boundaries

- The library uses saved thumbnails; it does not render every shader at once.
- Shadertoy inputs such as video, webcam, microphone, sound, and cubemaps do not become equivalent Shadergrove inputs.
- Wallpaper Engine export does not reproduce the effects rack.
- The official catalogue is bundled with the app; a hosted marketplace and automatic plugin updates are not provided.
- Windows installers are published; this guide does not promise macOS or Linux packages.

[Releases](https://github.com/antelm-dev/shadergrove/releases) lists downloadable builds. Planned work belongs in [Issues](https://github.com/antelm-dev/shadergrove/issues), separately from this feature catalogue.
