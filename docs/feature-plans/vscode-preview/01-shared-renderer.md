# Worker 01 — runtime partagé sans Angular

Lire le README coordinateur fourni avec ce prompt. Mission : rendre le moteur
WebGL consommable par Studio et une webview sans copier son implémentation ni
modifier le comportement des projets existants.

## Lancement et isolation

- Livraison : `default-branch-pr`, destination prévue `master`.
- Base : `latest-default`, SHA exact `<BASE_01_SHA>` résolu et fourni par le
  coordinateur depuis `origin/master` après fetch. Pas la branche de plan.
- Prérequis : aucun worker ; points d'intégration du README présents à cette base.
- Branche : `codex/vscode-preview-01`.
- Worktree : `E:/Adel/Documents/Orgs/shader-studio-vscode-preview-01`.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-vscode-preview-01 -b codex/vscode-preview-01 <BASE_01_SHA>
```

Exiger un état initial propre et suivre les instructions du dépôt. Ne toucher
ni aux autres worktrees ni aux ajouts indexés du checkout de l'utilisateur.

## Ownership : la frontière du runtime

Ownership primaire : `libs/rendering/`, package `@shadergrove/rendering`. Déplacer
uniquement la fermeture transitive nécessaire à `ShaderEngine` : moteur,
`GlContext`, targets, profiler, output sink et modules de `rendering/engine`.
Les déplacements mécaniques constituent une seule frontière étroite, même si
elle contient plus de cinq fichiers. Raccords autorisés : imports/adaptateurs et
tests du Studio qui consomment cette frontière, `apps/studio/package.json` et
`pnpm-lock.yaml`. Pas de modifications dans `apps/vscode`.

Conserver dans Studio canvas Angular, registry, renderer handle, capture et UI.
Les tests déplacés gardent leurs assertions ; les adaptateurs gardent leurs tests
à leur emplacement si possible. Des re-exports minces peuvent protéger les
imports existants, sans créer une deuxième implémentation ni deux identités de
classe pour `instanceof GlContext`.

## Travail et contrat

1. Remplacer la dépendance Angular de `GlContext.status` par un accès/événements
   neutres. Conserver `onLost`, `onRestored`, `onDispose` et leur désabonnement.
   Examiner tous les consommateurs avant de changer le type ; garder la lecture
   `status()` si elle évite des changements inutiles. Si un consommateur Angular
   a besoin de réactivité, l'adapter côté Studio avec nettoyage à destruction.
2. Exposer le moteur, son contexte et les types réellement nécessaires via un
   package privé browser-compatible, sans import de l'application. Maintenir
   le chargement différé de Three.js et les defaults/models de `libs/shared`.
3. Préserver les contrats `create`, `setShader`/`setPasses`, paramètres, resize,
   pause, screenshot et dispose ; compilation candidate, diagnostics, ownership
   GPU, perte/restauration et dispose idempotent restent fonctionnels.
4. Déclarer les dépendances du package et le raccorder au workspace/Nx existant.
   Créer ses scripts `typecheck` et `test`. Le bundle futur doit pouvoir importer
   le runtime sans Angular, Node, Electron ou backend. Ne pas publier sur npm.

Hors scope : nouveaux comportements, refactor du compilateur, nouveaux formats,
langage GLSL, extension, backend, contrats IPC, refonte UI ou migrations storage.

## Vérification et livraison

Satisfaire **AC-RUNTIME** et **AC-REGRESSION**. Exécuter les checks 01 du YAML,
incluant tests renderer existants de compilation, multipasse, effects, contextes,
pause/capture et disposal. Vérifier le graphe/bundle du package sans Angular et
les builds web/desktop ; ne pas confondre tests fake GL et GPU réel. Ajouter une
preuve ciblée du nouveau contrat de statut si nécessaire, sans tests miroir.

Livrable indépendant et rollback par revert ; aucune feature flag requise car
le comportement utilisateur est conservé. Le coordinateur possède la validation
globale et le desktop installé. Relire le diff complet, faire 1 à 3 commits
logiques, rapporter base et commits, fichiers, commandes/résultats, couverture
des critères et risques. Aucun push, PR ou merge sans autorisation distincte.
