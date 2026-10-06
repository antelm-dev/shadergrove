# Worker 01 — Contrat et migration des instances

Lis le `README.md` du plan fourni par le coordinateur. Mission : livrer le contrat sérialisé du jalon 1, avec migration déterministe et aller-retour de données, sans UI ni exécution GPU.

**Lancement.** Livraison `integration-only`. Base `integration-tip` : au premier lancement, le coordinateur crée `codex/integrate-custom-postprocess-effects` au SHA source `1dbead177a2ba4c2d9f790dfb81f666f85132bfd` et te donne son SHA exact `<launch_sha_01>`. Crée la branche `codex/custom-postprocess-01` dans un worktree sibling isolé `shader-studio-custom-postprocess-01` depuis ce SHA. Vérifie un statut initial propre et les instructions du dépôt. Ne pars pas du nom mouvant `develop`.

**Propriété principale.** `libs/shared/src/model/render.ts`, `libs/shared/src/validate/controls.ts`, `libs/shared/src/model/records.ts`, `libs/shared/src/validate/bundle.ts` et leurs specs voisines. `limits.ts`/`payload.ts` et une spec backend ciblée peuvent être touchés si nécessaires pour garantir les limites et la persistance ; signale tout autre besoin au coordinateur.

**Travail requis.**

1. Ajouter `instanceId` à tous les effets et `custom` avec définition embarquée `{ apiVersion: 1, name, source, controls }`, valeurs par instance et activation. Réutiliser `ShaderControl`/`ShaderParams`, `validateControls` et `sanitizeParams`, sans nouveau format de paramètre. Fixer explicitement la taille maximale de source et le nombre de contrôles custom, plus la borne globale de la chaîne.
2. Migrer les Bloom/Vignette historiques sans identifiant vers des identifiants stables à chaque lecture et conserver les identifiants des données nouvelles. Autoriser plusieurs instances d'un type et rejeter ou normaliser les IDs dupliqués de manière déterministe. Adapter les helpers de chaîne pour agir sur une instance précise ; éviter une API ambiguë pour les doublons.
3. Définir le comportement des `apiVersion` futurs et des définitions malformées sans perte silencieuse du code à l'import/sauvegarde. Les effets incompatibles restent représentables, avec un état non exécutable que l'UI pourra expliquer ; empêcher l'exécution d'un code hors limites. Documenter le choix exact dans les commentaires/types et les tests, car les deux autres workers en dépendent.
4. Faire évoluer le bundle vers v4 si nécessaire, accepter v1–v3 et vérifier les snapshots de presets `render`. Tester `validateRender` et un aller-retour `ShaderLibrary` avec code, contrôles, valeurs et ordre ; vérifier qu'aucune migration SQL n'est requise pour `renderJson`.

**Contrat à remettre.** Donne au coordinateur la forme TypeScript finale et les noms des helpers. La chaîne ne référence ni définition distante, ni entité de bibliothèque. Aucun effet personnalisé n'est exécutable seul sur cette branche ; ne la propose pas comme PR autonome.

**Vérification.** `pnpm --filter @shadergrove/shared test -- src/model/render.spec.ts src/validate/validate.spec.ts`, `pnpm --filter @shadergrove/shared typecheck` et `pnpm --filter @shadergrove/backend test -- src/storage/shader-storage.spec.ts` (ajuste les chemins si une nouvelle spec ciblée est créée). Couvre AC-ID, AC-DATA et les limites d'AC-BOUNDARY. Relis le diff complet, fais 1–3 commits logiques, puis rapporte base/HEAD, commits, chemins, résultats et risques. Aucun push ni PR.
