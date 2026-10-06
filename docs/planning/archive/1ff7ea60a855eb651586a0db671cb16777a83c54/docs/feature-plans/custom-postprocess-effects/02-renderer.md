# Worker 02 — Rendu et compilation candidate

Lis le `README.md` du plan fourni par le coordinateur et le contrat final du worker 01. Mission : exécuter les effets personnalisés dans la chaîne existante en conservant l'image valide lors des éditions et des erreurs.

**Lancement.** Livraison `integration-only`, politique `integration-tip`. Attends que 01 soit relu et intégré. Le coordinateur donne le SHA exact `<launch_sha_02>` du tip `codex/integrate-custom-postprocess-effects` qui contient 01. Crée `codex/custom-postprocess-02` dans un worktree sibling `shader-studio-custom-postprocess-02` depuis ce SHA, avec statut propre. Ne suis pas un nom de branche mobile.

**Propriété principale.** `apps/web/src/app/rendering/engine/post-processing.ts`, un petit module de passe/probe custom à côté, `apps/web/src/app/rendering/shader-engine.ts`, `apps/web/src/app/rendering/shader-canvas.ts` et leurs specs ciblées. Si une extraction minimale depuis `pass-compiler.ts` est nécessaire, coordonne-la et conserve le comportement des passes Image/Buffer.

**Travail requis.**

1. Construire la passe GLSL v1 avec vertex plein écran fourni par l'application. L'utilisateur écrit `vec4 effect(vec4 color, vec2 uv)` ; le code généré fournit `tDiffuse`, `vUv`, `u_resolution`, `u_time`, `u_<key>` et appelle cette fonction après avoir échantillonné l'entrée. Convertir les quatre types `ShaderControl` comme le moteur existant, avec valeurs locales à l'instance. Ne pas exécuter une version incompatible.
2. Indexer les passes par `instanceId`. Tester que valeurs seules modifient les uniforms sans recompilation ; changement du code/contrôles d'une instance sonde uniquement sa candidate ; réordonnancement/activation change la chaîne sans réutiliser la mauvaise passe. Préserver le rendu direct et le chargement paresseux si rien n'est actif.
3. Prober le programme candidat hors écran avant de remplacer la passe en service, selon le principe 1×1 de `PassCompiler`. Une erreur garde le dernier programme valide pendant l'édition, avec `CompileDiagnostic` attribué à l'instance et aux lignes utilisateur. Au chargement sans ancien programme valide, ignorer la passe avec erreur visible. Relier le retour de diagnostics à `ShaderCanvas`/store sans écraser les diagnostics Image/Buffer ni publier une réponse asynchrone périmée.
4. Gérer resize, temps, disposal et perte/restauration de contexte. Une chaîne fautive ne doit pas être persistée comme désactivée automatiquement ; prévoir un chemin de récupération de session si le contexte se perd. Une compilation acceptée ne prouve pas qu'un code GLSL arbitraire est léger : garder les limites prévues au contrat.

**Hors scope.** Aucun éditeur, stockage d'effet autonome, Explore, Worker JS, effet multipasse ou export Wallpaper supplémentaire. L'avertissement Wallpaper existant continue à s'appliquer.

**Vérification.** `pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/rendering/engine/post-processing.spec.ts` ; ajoute les specs `pass-compiler`/`shader-engine` touchées et vérifie que l'option `--include` sélectionne bien ces fichiers. Puis `pnpm --filter @shadergrove/web typecheck`. Couvre AC-RENDER et AC-BOUNDARY avec tests de deux instances, échec de compilation, ordre, resize et contexte perdu. Relis le diff complet, fais 1–3 commits et rapporte base/HEAD, commits, chemins, résultats et risques. Aucun push ni PR.
