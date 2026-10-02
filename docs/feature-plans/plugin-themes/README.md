# Thèmes distribués par plugins — phase 1

Plan uniquement, 2026-10-02. Objectif : installer un package local de thèmes, sélectionner une variante pour l'interface et Monaco, retrouver ce choix au redémarrage et revenir proprement au thème intégré quand le package est indisponible.

## Références et état de départ

- Branche de plan : `plans/plugin-themes` ; lire ce README et le prompt concerné depuis le commit vérifié de cette branche. Le coordinateur les fournit directement au worker, ou lui donne ce SHA et les chemins lisibles par `git show <planning-sha>:docs/feature-plans/plugin-themes/<fichier>`. Ils ne seront pas nécessairement présents dans sa branche source.
- Source : `develop`, `2fff989e13da062fd5f2a895be9d07e97acfe067`. Remote `origin` : `https://github.com/antelm-dev/shadergrove.git`. Défaut annoncé par la référence locale `origin/HEAD` : `master` (`615702f` au relevé) ; cible de cette intégration : `develop`. Ne pas confondre les deux. Les références distantes n'ont pas été rafraîchies pendant la planification.
- Intégration prévue : `codex/integrate-plugin-themes`. Avant exécution, rafraîchir `origin/develop`, choisir et enregistrer un SHA exact descendant de la source, puis y créer l'intégration. Vérifier que le chantier plugin et la consolidation `apps/studio` sont toujours présents. Ne jamais importer des modifications non commitées du checkout utilisateur.
- État utilisateur initial : `?? docs/plugin-adapters-plan.md`, `?? libs/desktop-api/`. Ces éléments restent hors du plan. Aucun `AGENTS.md` applicable trouvé dans le dépôt ou ses parents lors du relevé ; relire les instructions au lancement.

L'hôte local existe dans `apps/studio/src/app/plugins/` : `.sgplugin.json`, installation désactivée par défaut, validation à chaque chargement, IndexedDB par profil web et stockage desktop sous `userData`. `libs/shared/src/plugin/package.ts` accepte seulement `effect`, `importer`, `exporter` ; sa condition `kind !== 'effect'` exige actuellement du JS. `editor/editor-themes.ts` contient six palettes intégrées ; `editor/monaco-loader.ts` les enregistre à son chargement. `prefs/preferences.ts` mémorise clair/sombre/système ; les menus correspondants sont dans `ui/layout/app-titlebar.ts` et `ui/preview/preview-shell.ts`. `ui/editor/theme-panel.ts` utilise un catalogue fixe. L'ancien chemin `apps/web` n'est plus le périmètre de source.

## Jalon et contrats communs

Un package démonstrateur original, **Grove Amber**, contient une variante claire et une sombre. Il prouve le parcours sans attendre un catalogue public ni une collection de palettes tierces. Le thème Shadergrove actuel et les six choix Monaco intégrés restent utilisables sans aucun plugin. Aucune dépendance `next-themes`, aucune nouvelle permission, aucun changement du renderer ou du format des shaders.

1. **Contribution déclarative.** Ajouter `ThemeContribution` à l'union existante : `kind: 'theme'`, `id`, `name`, `schemaVersion: 1`, `scheme: 'light' | 'dark'`, `ui`, `editor`. Un package peut déclarer plusieurs variantes. `ui` est une liste fermée de rôles de couleurs ; `editor` reprend les champs de palette existants, avec une base `vs` ou `vs-dark` cohérente avec `scheme`. Pas de CSS, de sélecteurs, d'URL, de fontes, de scripts ni de noms de variables fournis par le package. Couleurs opaques au format `#RRGGBB` uniquement, clés inconnues refusées ; quotas package/manifeste et contributions existants conservés. Des thèmes ordinaires ne reçoivent pas automatiquement le badge AAA.
2. **Rôles UI.** Noyau obligatoire : `background`, `on-background`, `surface`, `on-surface`, `on-surface-variant`, `surface-container-lowest`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`, `outline`, `outline-variant`, `primary`, `on-primary`, `primary-container`, `on-primary-container`. Liste facultative fermée : `surface-dim`, `surface-bright`, `surface-variant`, `secondary`, `on-secondary`, `secondary-container`, `on-secondary-container`, `tertiary`, `on-tertiary`, `tertiary-container`, `on-tertiary-container`, `inverse-surface`, `inverse-on-surface`, `inverse-primary`, `error`, `on-error`, `error-container`, `on-error-container`. Les rôles facultatifs absents héritent du thème intégré pour le schéma résolu ; un changement efface les anciennes valeurs avant d'appliquer les nouvelles. L'hôte est seul à mapper les rôles vers `--mat-sys-*`. Les tokens existants de verre et lil-gui continuent à en dériver.
3. **Compatibilité.** Garder les anciens packages du protocole 1 valides et les kinds inconnus rejetés. Ce nouveau kind n'ajoute pas d'ABI Worker : conserver `protocolVersion: 1`, versionner son schéma séparément, et déclarer la version réellement compatible de l'app dans les exemples. Un hôte ancien refusera le kind explicitement. Exiger `code` seulement s'il existe un importer/exporter ; interdire `code` pour un package seulement déclaratif. Packages mixtes acceptés sans changer leurs appels JS/GLSL.
4. **Identité et préférences.** Référence stable `plugin:<packageId>/<contributionId>` construite et parsée strictement depuis les motifs d'identifiants existants, sans version dans l'identité. Nouveau `appThemeId`, valeur intégrée `builtin`; `colorScheme` existant garde clair/sombre/système pour `builtin`. Une variante plugin impose son `scheme` sans écraser ce choix mémorisé. Étendre la référence `editorAppearance.theme` aux identités plugin en conservant tous les anciens IDs et `auto`. Une chaîne syntaxiquement valide peut survivre au chargement asynchrone ; sa présence dans le catalogue est vérifiée à la résolution, jamais tenue pour acquise. Références absentes ou données malformées : fallback déterministe. Aucun effacement des autres préférences.
5. **Catalogue et application.** Un service root de thèmes fusionne les intégrés et les contributions des seuls packages actifs, valides, compatibles du profil courant. Il possède résolution, application UI et synchronisation Monaco ; `Preferences` reste un stockage/suivi du système sans dépendance vers les plugins. `auto` Monaco suit la palette de l'app, y compris plugin ; une sélection explicite de l'éditeur est conservée. Respecter le preview/cancel/apply actuel de `EditorSettings`, et le caractère global du thème Monaco. Enregistrer une palette avant tout `setTheme`, couvrir Monaco chargé avant/après le catalogue et mettre à jour les couleurs si le contenu change sous une même identité.
6. **Cycle de vie.** Installer/activer un package ne sélectionne aucun thème. Désactivation, retrait, remplacement (qui désactive le package), corruption, incompatibilité et changement de profil retirent ses palettes du catalogue applicable et rétablissent toutes les couleurs intégrées ; ne pas laisser une valeur inline provenant du thème précédent. Pendant la résolution auth/plugin, montrer le thème intégré, sans palette du compte précédent. Une référence mémorisée redevient applicable uniquement si elle existe dans le catalogue courant. Aucun Worker de plugin ne démarre pour lister ou appliquer des thèmes.
7. **Démarrage.** SSR : thème intégré déterministe, aucun accès navigateur sur le serveur, aucune attente auth/plugin qui bloque le bootstrap. Après résolution du profil, appliquer la variante validée. Phase 1 admet une transition initiale intégré → plugin ; suppression du flash avant première peinture et bootstrap synchronisé des fenêtres natives sont différés. Initialiser le service dans les configurations web et desktop, pas uniquement à l'ouverture du panneau Plugins.

## Tâches, livraison et vagues

| ID  | Résultat                                                                    | Dépendance                   | Branche / worktree sibling                                  | Livraison          | Base                                 |
| --- | --------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------ | ------------------------------------ |
| 01  | Schéma de thème, validation et références persistables                      | Source plugin/studio commise | `codex/plugin-themes-01` / `shader-studio-plugin-themes-01` | `integration-only` | `integration-tip` exact au lancement |
| 02  | Parcours local utilisable : catalogue, UI/Monaco, sélection, fixture et E2E | 01 accepté et intégré        | `codex/plugin-themes-02` / `shader-studio-plugin-themes-02` | `integration-only` | nouveau `integration-tip` exact      |

**Vague 1 :** lancer 01 depuis le SHA d'intégration enregistré. Vérifier les contrats, les rejets et les régressions des packages existants, puis intégrer ses commits. **Vague 2 :** lancer 02 depuis le SHA contenant 01 accepté ; relire et valider le parcours complet. Deux workers, chacun 1–3 commits. 02 traverse plusieurs fichiers car catalogue, consommateurs Material/Monaco et cycle de vie forment une même fonctionnalité ; ne pas ajouter d'agent de tests ou de refactor indépendant.

Aucune tâche n'est `default-branch-pr` : 01 expose un contrat sans parcours consommateur complet, et la source `develop` contient le chantier plugin absent de `master`. Destination finale prévue : intégration vers `develop`, promotion vers `master` séparée. Aucun push, PR ou merge distant autorisé par ce plan. L'invocation suivante pourra explicitement autoriser : « Exécute ce plan, puis review et ouvre les PR éligibles vers develop » ; la fusion nécessite son autorisation propre.

Les frontières primaires sont partagées/validation pour 01 et consommation des thèmes studio pour 02. 01 peut faire les adaptations minimales de compilation dans les consommateurs existants ; il les documente pour 02, sans nouveau sélecteur ni gestionnaire de thème. Le coordinateur possède les conflits avec les autres chantiers et la validation agrégée. Les workers relisent leur diff complet et rapportent SHA de base/HEAD, commits, fichiers, commandes/résultats, limites et critères prouvés. Ne supprimer aucun worktree worker/review avant remise et autorisation de nettoyage.

## Acceptation et contrôles

- **AC-SCHEMA** : package de deux thèmes sans code accepté ; champs/couleurs/base/kind/version invalides refusés ; quotas maintenus ; packages mixtes et tous les anciens packages restent valides. Aucun script/URL/CSS injecté par les palettes.
- **AC-REFS** : anciens IDs editor conservés, références plugin strictement bornées et sanitisation indépendante du catalogue asynchrone ; valeurs malformées rejetées sans perte des autres champs.
- **AC-PREFS** : anciens choix migrent sans perte, IDs plugin bien bornés et persistés, `builtin` respecte clair/sombre/système, variante plugin impose son schéma ; références manquantes et chargement tardif ont un fallback stable.
- **AC-APPLY** : choisir une variante harmonise panels, overlays CDK, lil-gui et Monaco, sans modifier contenu/code/rendu du shader ; `auto` suit l'app, choix editor explicite et annulation de preview fonctionnent. Installation/activation sans sélection ne change rien. Palette mise à jour sous le même ID réenregistrée ; ordre de chargement Monaco/catalogue indifférent.
- **AC-LIFECYCLE** : reload et redémarrage hors ligne retrouvent un thème actif ; retrait/désactivation/remplacement/incompatibilité et changement de compte n'appliquent aucune palette indisponible ni anciens overrides. Zéro démarrage de Worker de plugin pour les thèmes. Les effets/importers/exporters existants restent utilisables.
- **AC-UX** : thèmes installés et intégrés visibles avec aperçu et état sélectionné, accessibles au clavier depuis les deux menus de thème ; choix de l'éditeur disponible dans le panneau existant. Packages identifiés avec éditeur/version/crédits, libellés FR/EN et aucune promesse AAA non démontrée.
- **AC-E2E** : Playwright passe par le vrai import `.sgplugin.json`, activation, sélection app/éditeur, reload et retrait ; assertions sur des couleurs calculées UI et Monaco, pas seulement une préférence ou un attribut. Inclure mise à jour même ID, thème incomplet après un thème complet, profil changé et ancien package ISF. Revue visuelle sur shader clair et sombre. Le desktop empaqueté doit être installé/lancé et reprendre le thème hors ligne ; build seul insuffisant.

01 : tests Vitest shared ciblés, typecheck shared et studio pour ses adaptations. 02 : tests ciblés du catalogue/lifecycle, préférences, installations et consommateurs ; E2E réel. Nouveau test proposé `apps/studio-e2e/src/plugin-themes.spec.ts`, en réutilisant `src/fixtures.ts` et le serveur temporaire existant. Fixture proposée `tools/workspace/fixtures/plugins/themes/grove-amber.sgplugin.json`, originale et sans JS. Les chemins de nouveaux tests sont des livrables à créer.

Coordinateur : `pnpm gen:ipc` si nécessaire avant les checks Angular, puis `pnpm run ci`, `pnpm build:desktop`, `pnpm e2e`, installation/lancement desktop et scénario hors ligne. Réutiliser les checks de compatibilité ISF et d'installations ; ne pas réécrire le sandbox. Rapporter les preuves desktop et les éventuels E2E manuels restant ouverts, sans qualifier un test non exécuté de réussi. Avant validation finale, inspecter toute écriture directe de `colorScheme` et tout `setTheme` pour éviter deux propriétaires concurrents.

## Suite différée — aucun prompt exécutable

Catalogue public, signatures/mises à jour automatiques, import direct de thèmes VS Code, collections Monokai/Dracula/Solarized/VS Code/Catppuccin avec provenance et licences vérifiées, thèmes de contraste certifiés, édition de palettes, variantes app suivant automatiquement le système au sein d'une famille, CSS/fontes/layout personnalisés, zéro flash avant première peinture, synchronisation avec fenêtres natives et préférences générales par compte. Ne pas inventer de variantes claires pour des palettes qui n'en ont pas.

```yaml
review_contract:
  milestone: plugin-themes-phase-1
  planning_ref: plans/plugin-themes
  source_base: 2fff989e13da062fd5f2a895be9d07e97acfe067
  default_branch: master
  integration_target: develop
  integration_branch: codex/integrate-plugin-themes
  tasks:
    - id: '01'
      branch: codex/plugin-themes-01
      depends_on: []
      acceptance: [AC-SCHEMA, AC-REFS]
      checks:
        - 'pnpm --filter @shadergrove/shared exec vitest run src/plugin/package.spec.ts src/plugin/themes.spec.ts src/prefs/editor-theme-reference.spec.ts'
        - 'pnpm --filter @shadergrove/shared typecheck'
        - 'pnpm --filter @shadergrove/studio typecheck:web'
      delivery: integration-only
      base_policy: integration-tip
    - id: '02'
      branch: codex/plugin-themes-02
      depends_on: ['01']
      acceptance: [AC-PREFS, AC-APPLY, AC-LIFECYCLE, AC-UX, AC-E2E]
      checks:
        - 'pnpm --filter @shadergrove/studio exec ng test --watch=false --include=src/app/themes/**/*.spec.ts --include=src/app/prefs/preferences.spec.ts --include=src/app/plugins/plugin-installations.spec.ts --include=src/app/plugins/isf-plugin.spec.ts'
        - 'pnpm --filter @shadergrove/studio typecheck:web'
        - 'pnpm check:i18n'
        - 'pnpm --filter @shadergrove/studio-e2e e2e src/plugin-themes.spec.ts'
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    - 'pnpm run ci'
    - 'pnpm build:desktop'
    - 'pnpm e2e'
  e2e_scenarios:
    - 'Local package -> activate -> select theme -> inspect Material and Monaco colours -> reload -> remove'
    - 'Two variants, builtins and explicit editor choices; preview cancel restores selection'
    - 'Same-ID update, partial palette, inactive/incompatible package and account switch restore builtins'
    - 'Installed desktop restart offline; plugin theme starts no plugin Worker; existing ISF still works'
  deferred:
    - public-theme-catalogue
    - popular-third-party-theme-packs
    - theme-authoring-and-vscode-import
    - automatic-family-light-dark-pairs
    - pre-paint-flash-elimination
    - native-window-theme-synchronisation
```
