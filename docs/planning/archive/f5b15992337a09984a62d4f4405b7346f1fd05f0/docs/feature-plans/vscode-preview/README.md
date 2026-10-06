# Shadergrove dans VS Code — phase 1

Plan uniquement, établi le 2026-10-02. Objectif : prouver un workflow utilisable
avec édition GLSL native, preview WebGL et diagnostics. Ce jalon est plus petit
que le MVP complet discuté : un seul fragment, un contrôle numérique, aucun
backend. Aucun code, worktree de worker, publication ni PR n'est autorisé par
ce document.

## Base et transmission

- Source : `4fe02d47e068aed7e7f43da5498101e68e66af50`, checkout initial `develop`.
- Remote : `origin`, `https://github.com/antelm-dev/shadergrove.git`.
- Branche par défaut : `master` (`origin/HEAD`, `nx.json`). Après fetch,
  `origin/master` et `origin/develop` pointent tous deux sur la source ci-dessus.
- Plan : `codex/plan-vscode-preview`, dossier `docs/feature-plans/vscode-preview`.
- Intégration future : `codex/integrate-vscode-preview`.
- Le checkout initial possède des ajouts indexés dans trois documents de roadmap
  et `libs/desktop-api/src/ipc-bridge.ts`. Ils sont exclus du plan et de sa base.

Le coordinateur fournit ce README et le prompt au worker, ou un ref de plan
lisible avec leurs chemins exacts. Les documents ne seront pas automatiquement
présents dans une branche lancée depuis la source. Résoudre un SHA complet au
lancement de chaque worker et le consigner avec son état initial propre.

## Architecture vérifiée et périmètre

`apps/studio/src/app/rendering/shader-engine.ts` porte le moteur et conserve
le dernier programme valide. Ses dépendances transitives sont principalement
dans `rendering/engine`, `pass-targets.ts`, `performance-profiler.ts` et
`engine-output-sink.ts`. `gl-context.ts` importe encore les signals Angular.
`shader-canvas.ts`, `gl-context-registry.ts` et `renderer-handle.ts` restent des
adaptateurs du Studio ; ils ne doivent pas entrer dans le runtime partagé.

`libs/shared/src/project` fournit les projets, la composition des passes et la
correspondance des lignes ; `libs/shared/src/glsl/diagnostics.ts` et
`libs/shared/src/diagnostics/types.ts` fournissent les diagnostics. Les modèles
de contrôles existants associent la clé `gain` à l'uniform `u_gain`. Le bundle
existant est `shader-studio/v4` ; son format ne change pas.

Créer un package privé `@shadergrove/rendering` dans `libs/rendering`, consommé
par le Studio et la webview. Créer `apps/vscode`, package workspace
`@shadergrove/vscode`, avec manifest VS Code distinct du nom npm si nécessaire.
Le host gère documents, fichiers et Problems. La webview embarque le runtime,
un canvas et un slider ; aucun Angular, Monaco, Electron, Nest ou serveur HTTP.
Utiliser des ressources empaquetées, `asWebviewUri`, une CSP restrictive et des
messages validés. Sources de référence :
[webviews](https://code.visualstudio.com/api/extension-guides/webview),
[diagnostics](https://code.visualstudio.com/api/language-extensions/programmatic-language-features),
[workspace trust](https://code.visualstudio.com/api/extension-guides/workspace-trust).

Le seul environnement annoncé et vérifié dans cette phase est VS Code desktop
stable sur Windows, dans un workspace local approuvé. Signaler clairement un
workspace distant/virtuel non supporté et respecter Restricted Mode. Ne pas
promettre macOS, Linux, Codespaces ou `vscode.dev` sans validation dédiée.

## Contrats de la phase

Le fichier `shadergrove.preview.json` est un manifeste expérimental local,
distinct des bundles et de `ShaderProject`, non annoncé comme format public
stable. Un exemple minimal :

```json
{
  "previewVersion": 1,
  "fragment": "image.frag",
  "control": {
    "type": "number",
    "key": "gain",
    "label": "Gain",
    "default": 1,
    "min": 0,
    "max": 2,
    "step": 0.01
  },
  "value": 1
}
```

Le fragment est du GLSL compatible avec le moteur actuel. Employer ses valeurs
par défaut pour le vertex, le rendu et les canaux vides. Réutiliser le modèle
`NumberControl`, sa validation et la génération existante des uniforms ; ne pas
injecter deux fois `u_gain`. Le shader fourni démontre une variation visible.
Un seul contrôle `number` et une seule passe Image sont supportés ; refuser les
versions, champs de fonctionnalités et types non supportés avec un message
précis. Aucun include, buffer, texture, effet ou vertex personnalisé dans ce
manifeste. Le chemin est relatif au dossier du manifeste, contenu dans ce
dossier ; pas d'URL, chemin absolu ou sortie par `..`.

Les `TextDocument` ouverts font autorité sur les fichiers disque : utiliser leur
contenu non sauvegardé, y compris pour le manifeste. Les modifications du slider
passent par `WorkspaceEdit` et le cycle natif undo/redo/save. Aucun autosave
silencieux. Si le manifeste est invalide ou a changé entre lecture et écriture,
ne pas écraser le texte ; recharger/valider avant une nouvelle modification.

Les messages host/webview portent une session et une révision monotone. Debouncer
la compilation, pas l'enregistrement du brouillon ; rejeter les réponses et
actions périmées. Les diagnostics remontent sur les URI et lignes originales,
avec conversion 1-based vers 0-based. Le host garde un snapshot du dernier état
compilable accepté pour réhydrater la preview si le brouillon courant est invalide.
Ce snapshot est un état de session, jamais une écriture sur les sources.

Une seule preview active, attachée explicitement au manifeste sélectionné.
Changer d'onglet GLSL ne change pas implicitement le projet. À la fermeture,
annuler timers, écouteurs et messages et libérer le GPU. Une preview cachée
n'entretient pas de boucle de rendu continue ; réouverture et perte/restauration
de contexte rechargent le dernier état accepté puis le brouillon courant.

## Tâches, vagues et livraison

| ID  | Résultat et ownership primaire                                                 | Dépendance                       | Livraison                                                | Base              |
| --- | ------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------- | ----------------- |
| 01  | Runtime partagé, raccord Studio et regressions du moteur                       | Aucune                           | `default-branch-pr` vers `master`                        | `latest-default`  |
| 02  | Extension expérimentale installable, documents/slider/Problems et cycle de vie | 01 accepté et intégré localement | `integration-only` vers `codex/integrate-vscode-preview` | `integration-tip` |

Vague 1 : lancer 01 depuis le SHA fraîchement résolu d'`origin/master`. Vérifier
que les points d'intégration décrits existent encore ; arrêter pour replanifier
si la base a changé substantiellement. Cette extraction est livrable seule :
aucun comportement public supplémentaire ni dépendance runtime non fusionnée,
package privé, rollback par revert de ses commits.

Après revue locale et succès des checks 01, créer l'intégration depuis son SHA
de lancement puis incorporer ses commits acceptés. Vague 2 : lancer 02 depuis
le SHA exact de cette intégration. Ce n'est pas une fusion sur `master` ; 02
dépend du runtime accepté localement et reste une extension expérimentale. Ne
pas démarrer 02 depuis la branche de plan. Aucun worker parallèle n'est nécessaire.

Branches/worktrees futurs, à créer seulement lors de l'exécution :

- 01 : `codex/vscode-preview-01`,
  `E:/Adel/Documents/Orgs/shader-studio-vscode-preview-01`.
- 02 : `codex/vscode-preview-02`,
  `E:/Adel/Documents/Orgs/shader-studio-vscode-preview-02`.
- Intégration : `E:/Adel/Documents/Orgs/shader-studio-vscode-preview-integration`.

Le coordinateur possède les conflits de manifests workspace et du lockfile,
sans réécrire le travail d'un worker. 01 possède les dépendances Studio/runtime ;
02 ajoute uniquement ses propres dépendances et scripts. Aucun changement d'API,
de storage, de sync ou de contrat IPC. Une éventuelle PR finale vise `master`
après revue de l'ensemble et accord explicite. Phrase d'autorisation distincte :
« Revois les tâches terminées et ouvre les PR éligibles ». Cela n'autorise ni
leur fusion, ni la publication sur Marketplace. Ne supprimer les worktrees
d'exécution qu'après conservation vérifiée des commits et décision de revue.

## Acceptation et vérification

- **AC-RUNTIME** : Studio et webview utilisent le même moteur sans Angular dans
  le graphe du runtime ; ownership, compilation candidate et nettoyage préservés.
- **AC-PREVIEW** : le VSIX local démarre sans Studio installé ni serveur ; le
  fragment fourni produit réellement des pixels et ses modifications non
  sauvegardées apparaissent dans la preview.
- **AC-CONTROL** : le slider modifie `u_gain`, le manifeste devient dirty,
  undo/redo et Ctrl+S gardent le rendu et le texte cohérents.
- **AC-DIAG** : une erreur GLSL pointe vers la bonne ligne du fragment dans
  Problems ; dernier rendu valide conservé, correction acceptée, ancien résultat
  asynchrone incapable de remplacer les diagnostics courants.
- **AC-LIFECYCLE** : fermeture/réouverture, masquage, changement de projet et
  perte/restauration du contexte ne gardent aucune ancienne boucle/écouteur et
  réhydratent le bon projet, même avec un brouillon invalide.
- **AC-BOUNDARY** : manifeste invalide/version inconnue/source manquante/chemin
  hors dossier/workspace non supporté donnent une erreur utile sans écriture
  destructive ; Restricted Mode n'active pas la preview.
- **AC-REGRESSION** : Studio conserve ses previews simple et multipasse, les
  effets, les contextes indépendants et les exports après extraction.

Checks actuels réutilisables : `pnpm --filter @shadergrove/shared test`,
`pnpm --filter @shadergrove/studio typecheck:web`,
`pnpm --filter @shadergrove/studio test:web`, `pnpm build`,
`pnpm build:desktop`, `pnpm e2e`, `pnpm ci`. Les tests renderer existants incluent
`multi-context.spec.ts`, `multipass.spec.ts`, `paused-redraw.spec.ts`,
`offline-capture.spec.ts`, `frame-render.spec.ts`, `performance-profiler.spec.ts`
et `engine/*.spec.ts`. Conserver leurs assertions et leur couverture.

Nouveaux scripts contractuels à implémenter, pas des commandes déjà existantes :
`pnpm --filter @shadergrove/rendering typecheck`, `... test`,
`pnpm --filter @shadergrove/vscode typecheck`, `... test`, `... build`,
`... test:host`, `... package:vsix`. Les packages doivent être découverts par Nx
et leurs `typecheck`/`test`/`build` pertinents couverts par le CI existant. Une
suite browser des pixels ne remplace pas `test:host` dans un vrai VS Code.

Gate d'intégration du coordinateur : `pnpm ci`, `pnpm build:desktop`, `pnpm e2e`,
les scripts nouveaux et une installation du VSIX produit dans un profil VS Code
Windows propre. Contrôler le contenu du VSIX : bundles host/webview autonomes,
pas d'import source workspace, pas de secret, backend ou dépendance native.
Le CI renderer n'est pas une preuve d'exécution sur GPU réel. Consigner le SHA,
la version VS Code, les commandes, résultats, captures et surfaces non testées.

Scénarios E2E critiques :

1. Hors ligne, installer le VSIX, ouvrir l'exemple et modifier le fragment sans
   sauvegarde ; observer une image et sa variation réelle, pas seulement un ACK.
2. Introduire une erreur à une ligne connue : Problems localise l'erreur et la
   dernière image reste ; corriger puis effectuer plusieurs edits rapides pour
   vérifier le rejet d'un résultat périmé.
3. Slider puis undo/redo et Ctrl+S pendant le debounce ; rouvrir le projet et
   retrouver la valeur sauvegardée. Éditer simultanément le manifeste et vérifier
   qu'un ancien message du slider n'écrase pas ce texte.
4. Masquer/rouvrir la preview, fermer/rouvrir pendant une compilation, simuler
   `WEBGL_lose_context` si disponible puis restaurer ; vérifier récupération et
   absence de ressources actives après fermeture. Documenter toute impossibilité
   de simulation et ne pas déclarer cette partie validée.
5. Manifeste invalide, source manquante et tentative de chemin hors dossier ;
   Restricted Mode et workspace distant : vérifier refus et sources intactes.
6. Dans Studio web puis desktop installé, vérifier simple/multipasse, contrôle,
   effet, capture PNG et perte de contexte quand disponible. Les checks automatisés
   existants complètent ces vérifications, sans remplacer leur preuve.

Les workers livrent chacun 1 à 3 commits logiques, leur SHA de base, la liste des
fichiers, les critères vérifiés et les risques. Relire le diff complet. Une
surface non testable reste explicitement non vérifiée ; les gates obligatoires
manquants empêchent d'annoncer le jalon prêt.

## Backlog différé — aucun prompt exécutable

Format projet public stable, import/export de bundles, multipasse/Common/includes,
textures, vertex personnalisé, contrôles booléens/couleurs/choix, presets, effets,
capture PNG depuis l'extension, vidéo, bibliothèque SQLite, comptes/sync/Explore,
packages/plugins, MCP/Copilot dédié, language server GLSL complet, Marketplace,
Remote/WSL/Codespaces, extension web et validation multiplateforme. Pas de
refonte du Studio, des surfaces ou des IPC pendant cette phase.

## Handoff de revue

```yaml
review_contract:
  milestone: vscode-preview-phase-1
  planning_ref: codex/plan-vscode-preview
  source_base: '4fe02d47e068aed7e7f43da5498101e68e66af50'
  default_branch: master
  integration_branch: codex/integrate-vscode-preview
  tasks:
    - id: '01'
      branch: codex/vscode-preview-01
      depends_on: []
      acceptance: [AC-RUNTIME, AC-REGRESSION]
      checks:
        - 'pnpm --filter @shadergrove/rendering typecheck'
        - 'pnpm --filter @shadergrove/rendering test'
        - 'pnpm --filter @shadergrove/studio typecheck:web'
        - 'pnpm --filter @shadergrove/studio test:web'
        - 'pnpm build'
        - 'pnpm build:desktop'
      delivery: default-branch-pr
      base_policy: latest-default
    - id: '02'
      branch: codex/vscode-preview-02
      depends_on: ['01']
      acceptance: [AC-PREVIEW, AC-CONTROL, AC-DIAG, AC-LIFECYCLE, AC-BOUNDARY]
      checks:
        - 'pnpm --filter @shadergrove/vscode typecheck'
        - 'pnpm --filter @shadergrove/vscode test'
        - 'pnpm --filter @shadergrove/vscode build'
        - 'pnpm --filter @shadergrove/vscode test:host'
        - 'pnpm --filter @shadergrove/vscode package:vsix'
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - 'pnpm ci'
    - 'pnpm build:desktop'
    - 'pnpm e2e'
    - 'pnpm --filter @shadergrove/vscode test:host'
    - 'pnpm --filter @shadergrove/vscode package:vsix'
    - 'Install generated VSIX in a clean Windows VS Code profile and run documented E2E'
  e2e_scenarios:
    - 'Offline VSIX installation and unsaved native GLSL edits change real pixels'
    - 'Compile failure preserves last image, maps Problems and rejects stale results'
    - 'Slider WorkspaceEdit, concurrent edits, undo/redo and immediate save'
    - 'Hidden/closed preview and WebGL context loss recover without leaked resources'
    - 'Invalid manifest, path escape, Restricted Mode and remote workspace refusal'
    - 'Studio web and installed desktop rendering regression checks'
  deferred:
    - 'Stable project format and bundle interoperability'
    - 'Multipass, includes, textures, presets and effects in the extension'
    - 'Accounts, sync, Explore, plugins and dedicated AI tools'
    - 'Marketplace, remote/web extension and cross-platform validation'
```
