# Worker 02 — extension expérimentale utilisable

Lire le README coordinateur fourni avec ce prompt. Mission : livrer un VSIX local
avec fragment natif, preview, slider et Problems selon les contrats phase 1.

## Lancement et isolation

- Livraison : `integration-only`, destination `codex/integrate-vscode-preview`.
- Base : `integration-tip`, SHA exact `<BASE_02_SHA>` fourni après acceptation
  locale de 01, passage de ses checks et incorporation dans l'intégration.
- Ne pas supposer qu'une PR 01 est fusionnée sur `master`.
- Branche : `codex/vscode-preview-02`.
- Worktree : `E:/Adel/Documents/Orgs/shader-studio-vscode-preview-02`.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-vscode-preview-02 -b codex/vscode-preview-02 <BASE_02_SHA>
```

Exiger un état initial propre. Utiliser le package de 01, sans le modifier ni
copier le moteur. Remonter un problème du runtime au coordinateur/worker 01.

## Ownership : un package d'extension

Frontière primaire : `apps/vscode/`. Cinq points principaux : `package.json`,
`src/extension.ts`, `src/preview-project.ts`, `src/protocol.ts`,
`src/webview/main.ts`. Ajouter sous ce package uniquement le build, HTML/CSS,
configs, exemple, README et tests nécessaires. Les seuls raccords hors package
sont ses dépendances dans `pnpm-lock.yaml` et, si indispensables, les scripts
d'agrégation ; le coordinateur possède les conflits workspace. Pas de changements
API, Studio, modèles de bundles ou surfaces existantes.

## Travail et contrats

1. Commande « Shadergrove: Open Preview » depuis le manifeste sélectionné.
   Fournir un exemple auto-suffisant. Une preview active, Windows local approuvé,
   refus explicite du distant/virtuel et Restricted Mode. Valider le manifeste
   expérimental du README, la source relative et les limites du contrôle ; lire
   avec les API VS Code et privilégier les documents ouverts non sauvegardés.
2. Webview empaquetée avec moteur partagé, canvas et slider. Initialiser une
   passe Image, vertex/render par défaut, canaux vides. Aucun serveur, Angular
   ou Monaco. `asWebviewUri`, scripts locaux et CSP restrictive ; ne pas injecter
   les sources GLSL dans du HTML exécutable. Valider les messages aux deux bouts.
3. Édits texte et manifestes : snapshot immédiat, compilation debouncée, session
   et révision pour ignorer résultats/actions périmés. Slider via `WorkspaceEdit`,
   sans écraser un manifeste modifié/invalide ; undo/redo/save natifs. Aucun
   autosave. `DiagnosticCollection` sur les URI/lignes originales, conversion
   des diagnostics du moteur, nettoyage des anciens diagnostics de session.
4. Garder le dernier programme valide et son snapshot dans le host. Au retour
   d'une webview détruite/cachée, reconstruire l'état accepté avant le brouillon
   invalide éventuel. Masquage suspend la boucle continue ; fermeture annule
   écouteurs/timers/messages et libère le GPU. Traiter perte/restauration de
   contexte et erreur d'initialisation WebGL avec un état compréhensible.
5. Scripts `typecheck`, `test`, `build`, `test:host`, `package:vsix`, découverts
   par le workspace/Nx. Bundler séparément host et webview : VSIX autonome,
   `vscode` externe uniquement côté host, pas d'import workspace source à
   l'installation. Documenter installation/test local et environnement supporté.

Hors scope : backlog différé du README, notamment formats publics, multipasse,
includes, textures, export PNG et publication Marketplace.

## Vérification et livraison

Satisfaire **AC-PREVIEW**, **AC-CONTROL**, **AC-DIAG**, **AC-LIFECYCLE**,
**AC-BOUNDARY**. Exécuter les checks 02 du YAML. Tests ciblés sur brouillons,
undo/save, concurrence, erreurs de chemins, mapping et lifecycle ; `test:host`
utilise un vrai Extension Development Host et teste le code réellement bundlé.
Prouver que le canvas produit/change des pixels, pas seulement des messages.
L'installation du VSIX et les scénarios E2E Windows du README sont le gate du
coordinateur ; fournir des étapes reproductibles et toute preuve disponible.

Ne pas publier. L'extension expérimentale ne nécessite pas de flag du Studio.
Relire le diff complet, livrer 1 à 3 commits logiques, rapporter base et commits,
commandes/résultats, critères, captures disponibles et validations impossibles.
Un test jsdom ou un build ne prouve pas la compatibilité GPU/VS Code.
