# FAQ and troubleshooting

## My shader does not compile

Open the editor diagnostics and fix the first reported error. Check missing semicolons, type mismatches, uniform names, and the selected pass.

A control keyed `speed` supplies `u_speed`, not `speed`. The type must match its Config entry. An invalid Config document can also block saving.

Shadergrove keeps the last valid preview running after a compile failure. That image can still be the previous version of your shader.

## The preview is black

Start with the [First shader](First-shader) example. If it renders, compare your shader's output and inputs:

- Check that Image writes an opaque, nonzero color.
- Check texture assignments and pass-channel wiring.
- Bypass post-processing to inspect the shader's own output.
- Check whether a preset or control has set a parameter to zero.

If even the tutorial does not render, check the browser's WebGL and hardware-acceleration support, then include your browser and GPU details in a bug report.

## The shader is slow

Reduce render scale first, then compare with the effects chain bypassed. Check the performance panel and look for expensive loops, high buffer resolutions, many passes, or repeated texture sampling.

The library shows saved thumbnails; the active preview is the shader being rendered. In Desktop, close a separate output window when you do not need it.

## My save is blocked or failed

On Web, check that you are signed in and your email is verified. Check Config and compile diagnostics, then the save-status message.

If the server cannot be reached, keep the app open and retry when it is available. Do not treat a live preview as proof that the latest version was saved. Copy important edited source before closing if saving remains unavailable.

## Where are my shaders stored?

**Desktop:** in your local application-data library. You can edit it offline without an account.

**Web:** in the private library of the account on the server you are using. Another server or another account has its own library.

Desktop account uploads are optional and depend on the build's server configuration. They do not download the complete Web library into Desktop.

## How do I move or back up a shader?

Save it and use **Export shader…** for one project or the collection export for your library. Keep the resulting JSON file somewhere separate from the installation.

Use the import action on the destination. The default rename mode preserves an existing shader and imports another copy; overwrite mode replaces the matching ID. Choose overwrite only when that is your intended result.

JSON export preserves editable project data. A screenshot only preserves an image. Server administrators should also follow the [database backup guide](https://github.com/antelm-dev/shadergrove/blob/master/README.md#data--backups).

## Why is a plugin action missing?

For development builds with the official catalogue, check that its package is installed **and enabled**. Export actions also require an open shader.

If you use v1.5.0, follow the built-in import/export instructions in [Plugins and integrations](Plugins-and-integrations); the newer official catalogue is not included in that version.

For a local package, check its app-version and protocol compatibility.

## Why can I not see Explore?

Explore is a Web feature that the server must enable. It is hidden when unavailable, and it is not part of the Desktop workspace.

On an enabled server, public pages can be browsed without an account. Copying into your library and publishing use account permissions. Your private shader becomes public only after an explicit publication action.

Saving a private edit does not update the published snapshot; use the publication's update action when you want visitors to see the change.

## Why does my Wallpaper Engine export look different?

The exporter includes supported passes, values, and textures, but does not reproduce the post-processing chain. Compare with that chain bypassed inside Shadergrove.

See [Plugins and integrations](Plugins-and-integrations) for the two export formats and property setup. The development exporter has not been manually verified for control-property preservation inside Wallpaper Engine.

## Why do I still see “Shader Studio” in a path?

Shadergrove was previously called Shader Studio. Existing application-data paths, bundle format tags, protocol names, and some integration variables keep their original names for compatibility. This is expected; do not rename your data directory to match the app title.

## Report a reproducible problem

[Open an issue](https://github.com/antelm-dev/shadergrove/issues/new) with:

- App version, Web or Desktop, operating system, and browser/GPU if rendering is involved.
- The steps to reproduce and what you expected.
- The error text and a screenshot.
- A small exported project that reproduces it, if you can share it.

Remove private work and credentials before attaching a project or logs.
