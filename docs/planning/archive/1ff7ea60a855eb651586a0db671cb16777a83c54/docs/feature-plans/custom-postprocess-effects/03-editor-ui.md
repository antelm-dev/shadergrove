# Worker 03 — Édition et contrôles d'instance

Lis le `README.md` du plan fourni par le coordinateur et le contrat final du worker 01. Mission : permettre à l'utilisateur de créer et régler des effets personnalisés dans son shader, avec source GLSL et erreurs lisibles.

**Lancement.** Livraison `integration-only`, politique `integration-tip`. Attends que 01 soit relu et intégré. Le coordinateur fournit le SHA exact `<launch_sha_03>` du même tip que 02. Crée `codex/custom-postprocess-03` dans le worktree sibling `shader-studio-custom-postprocess-03` depuis ce SHA, statut initial propre. Ne prends pas le tip ultérieur de 02.

**Propriété principale.** `apps/web/src/app/ui/inspector/post-processing-panel.ts`, un composant d'édition d'effet à côté, le composant de rendu de contrôles extrait de `gui-panel.ts` si utile, leurs specs et les clés i18n nécessaires. Ne modifie pas `post-processing.ts` ou `shader-engine.ts`, propriété de 02. Si la remontée de diagnostics manque, signale le raccord au coordinateur plutôt que de chevaucher 02.

**Travail requis.**

1. Ajouter au rack « créer effet », dupliquer un effet existant (nouvel `instanceId`), éditer code/nom/contrôles, régler les valeurs, activer, supprimer et déplacer par ID. Les doublons Bloom/Vignette doivent rester manipulables. Préserver les commandes clavier et libellés accessibles du rack. Ne pas appeler ces objets des plugins.
2. Utiliser `CodeEditor`/Monaco existant dans une surface assez large pour du GLSL ; conserver modèle/undo par `instanceId`. Montrer la signature v1 et le rôle des uniforms fournis par l'application. Les changements passent par `ShaderStore.setRender` et le cycle brouillon/save existant ; aucune persistance distincte.
3. Réutiliser `ShaderControl` pour les contrôles d'instance. Le `GuiPanel` actuel lit `ShaderStore.controls()/params()` du shader : extraire juste le rendu nécessaire ou créer un adaptateur ciblé pour `controls`/`values` locaux, sans lier les clés de deux instances. Les valeurs affichées suivent presets, reset et changement de shader. Afficher le diagnostic de compilation avec l'ID/nom de l'effet et la ligne source ; expliquer une version non prise en charge ou une passe sautée au rechargement.
4. Respecter la limite du jalon : l'export/import transporte le shader entier. Aucun écran « Mes effets », fichier d'effet autonome, route Explore ou appel réseau desktop. L'édition doit rester compatible SSR (Monaco chargé uniquement côté navigateur).

**Vérification.** Étendre `post-processing-panel.spec.ts` pour création, duplication, valeurs locales, ordre, erreur et navigation clavier ; `pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/ui/inspector/post-processing-panel.spec.ts` (vérifie que `--include` sélectionne ce fichier), `pnpm --filter @shadergrove/web typecheck`, `pnpm check:i18n`. Couvre AC-EDITOR et AC-ID ; indique les scénarios de rendu dépendant de 02 que le coordinateur doit vérifier après intégration. Relis le diff complet, fais 1–3 commits et rapporte base/HEAD, commits, chemins, résultats et risques. Aucun push ni PR.
