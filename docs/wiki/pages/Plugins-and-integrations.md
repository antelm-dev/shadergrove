# Plugins and integrations

Import existing shaders, export a wallpaper, or customize the workspace.

**Choose the instructions for your version.** The official catalogue steps below describe the development code checked on 6 October 2026. In v1.5.0, Shadertoy import and Wallpaper Engine export are built-in commands; you do not install these two official packages.

## Install an official plugin — Development

1. Open **Plugins**.
2. Find the package in **Available** and choose **Install**.
3. Review its name, publisher, version, and contributions.
4. Find it under **Installed** and enable it.
5. Use its actions on the package card or through the app menus and command palette.

Shadertoy Import and Wallpaper Engine Export are installed disabled. Their commands become available after you enable them.

The default theme and language packages follow a different first-run behavior: the app installs and enables them once for each profile. You can then disable, remove, or reinstall them yourself.

| Official package        | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| Shadertoy Import        | Import from a URL or ID, or paste one Image pass.  |
| Wallpaper Engine Export | Export the open shader as a web-wallpaper project. |
| Default Themes          | Light and Dark workspace and editor palettes.      |
| English / French        | Interface language dictionaries.                   |

## Import from Shadertoy

**Development:** enable **Shadertoy Import**, then use the import action on its card. You can also find **Import from Shadertoy…** in the app's import menu.

**v1.5.0:** use **Import from Shadertoy…** in the app menu or the New shader dialog.

Choose the input that matches what you have:

- **URL or ID:** enter the Shadertoy shader reference and your own Shadertoy API key.
- **Paste:** paste the source of one Image pass and give the new shader a name.

Review the import warnings, then inspect the resulting project and render. The URL/ID workflow can bring across Image, Common, supported buffers, channel wiring, and image textures. Pasting one Image pass does not reconstruct an entire multipass project.

Sound and cubemap passes, and inputs such as keyboard, video, webcam, music, microphone, volume, and cubemaps, are dropped with warnings. A successful import therefore does not guarantee an identical rendering.

The API key is handled by Shadergrove's host, rather than sent to the plugin. Imported work retains its author's rights and license; check those before republishing or redistributing it.

## Export to Wallpaper Engine — Development

1. Enable **Wallpaper Engine Export** and open the shader you want to export.
2. Use its export action or **Export to Wallpaper Engine…**.
3. Read the compatibility warnings.
4. On Web, download and extract the ZIP. On Desktop, choose the parent folder for the project.
5. In Wallpaper Engine's editor, choose **Create Wallpaper** and select the exported `index.html`.

The project contains a standalone WebGL player and a `project.json` with control properties. The exporter uses the open draft, including unsaved edits; export does not save that draft to your library.

**Limits:** the post-processing chain is not reproduced. Property preservation when importing the generated project into an installed copy of Wallpaper Engine has not been manually verified. If its controls are missing, add the matching properties under **Edit → Change Project settings**, using the keys in `project.json`.

## Export to Wallpaper Engine — v1.5.0

Use **Import & export → Export Wallpaper Engine HTML…**.

The Web app downloads one standalone HTML file. Put it in a dedicated folder as `index.html` before importing it into Wallpaper Engine. The Desktop app creates a dedicated project folder.

The rendered values are included. To expose controls in Wallpaper Engine, add properties in **Edit → Change Project settings**, using the mapping in `window.__SHADER_STUDIO_WALLPAPER__.controls` inside the generated HTML. This older export uses number/select sliders rather than the newer catalogue export's select Combo properties.

The effects rack is not reproduced by this export either.

## Install from a file

Use **Plugins → Install from a file…** and select a compatible `.sgplugin.json` package. Review it, install it, and enable it when you want to use its contributions.

Plugin code runs in an isolated sandbox. A package's identity and compatibility checks do not make it a signed publisher package; install files from a source you trust.

Disable or remove a plugin from its Installed card. Shaders it imported remain in your library, and effects already copied into a shader remain in that shader.

In development builds with the official catalogue, updating a package is explicit and leaves the updated package disabled until you enable it again.

## Use an AI client through MCP

The [MCP setup guide](https://github.com/antelm-dev/shadergrove/blob/master/tools/mcp/README.md) describes how to connect a local Shadergrove tab to clients such as Codex, Claude Code, or Cursor.

This integration requires an enabled bridge and explicit setup. Installing the MCP server alone does not enable the bridge in a production or packaged build.

## Build a plugin

Plugin authors can start with the [official package sources and contracts](https://github.com/antelm-dev/shadergrove/blob/master/plugins/official/README.md). Those contracts describe the development version; check the target app's supported protocol before distributing a package.

If an action is missing, see [FAQ](FAQ).
