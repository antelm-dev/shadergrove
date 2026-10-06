# 02 — Project Recipes vertical slice

Read the supplied coordinator README. Mission: installable declarative recipe pack, gallery and independent project creation.

Launch: integration-only, integration-tip at **<coordinator-recorded-sha>** after 01 is accepted. Branch `codex/plugin-tools-02`; proposed clean worktree `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-02`. Receive the immutable planning documents separately.

Own `plugins/official/project-recipes/`, `apps/studio/src/app/plugins/tools/recipes.ts`, `recipes-panel.ts`, `recipes.spec.ts` and `apps/studio-e2e/src/plugin-recipes.spec.ts`. Keep shared dispatch/contracts and other tool modules untouched. Supply coordinator-only New/menu/provider/translation/catalogue fragments.

Reuse the frozen projectTemplate shape, existing bundle/project validation, `project-import.ts` adoption concepts, `WorkspaceActions` and `ShaderStore.importBundle`. Preserve built-in blank/new-project behavior.

Author four original, licensed, texture-free starters: a raymarched primitive with simple lighting; procedural Image-pass particles; Buffer A feedback trails plus Image display; procedural UI with pointer interaction. Include controls, defaults, learning notes, difficulty and thumbnail/preview strategy that needs no external package assets or runtime network.

Create a host gallery with package/template identity, description and controls. Preview only bounded curated content through the app renderer. Instantiation assigns fresh project/pass/file/effect identities consistently, preserves all internal references and defaults, and adopts one validated bundle using the existing rename/unsaved-draft flow. Do not replace the open project until the user completes that flow. Generated identities cannot collide on repeated creation.

Define feedback initialization/reset in the recipe so first frames are meaningful. Saved projects contain their own sources/control data; updates or removal of the recipe pack must never modify existing creations. Menu/gallery contents follow active registered contributions. Recheck lifecycle context immediately before import completion.

Out of scope: external textures, arbitrary generator scripts, cloud/community recipes, backend asset library, renderer refactors and source semantics.

Verify AC-RECIPES and AC-LIFECYCLE: compile/render every recipe on representative web/desktop sizes; two feedback instances with remapped references; cancel with unsaved draft; repeated creation/rename; save/reopen and bundle round-trip after removal; malformed/unsupported template rejection. Add focused recipes Angular tests and plugin-recipes E2E, IPC/typechecks as listed in README. Use the throwaway local E2E store, never production.

Deliver 1–3 logical commits and exact head/launch SHA, paths, checks, destination captures and remaining desktop evidence. Intended destination develop through coordinator integration only; no push/PR/merge.
