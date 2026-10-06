# 01 — Contrat déclaratif et références de thèmes

Lire le README coordinateur fourni avec ce prompt. Mission : rendre un package de palettes JSON strictement validable et ses références persistables, en préservant les plugins et préférences existants. Aucun nouveau parcours utilisateur dans cette tâche.

## Base et isolation

Livraison `integration-only`, base `integration-tip`. Prérequis : source plugin/studio commise, intégration créée et SHA exact enregistré par le coordinateur. Placeholder obligatoire : `<launch-base-01-sha>`, jamais un nom de branche mouvant. Ne pas repartir de `master` ni du checkout utilisateur sale.

```text
git worktree add <absolute-sibling-path>/shader-studio-plugin-themes-01 -b codex/plugin-themes-01 <launch-base-01-sha>
cd <absolute-sibling-path>/shader-studio-plugin-themes-01
git status --short --branch
```

Exiger un état initial propre ; lire les instructions applicables. Accéder au README/prompt depuis le planning SHA fourni si absents de cette base.

## Propriété et contrats

Frontière primaire : `libs/shared/src/plugin/package.ts`, nouveau `libs/shared/src/plugin/themes.ts`, `libs/shared/src/prefs/editor.ts`, avec leurs tests. Exporter le contrat via le sous-chemin `@shadergrove/shared/plugin` existant, sans dépendance Angular/Monaco. Les adaptations minimales de compilation des consommateurs studio sont autorisées et doivent être listées dans le handoff ; 02 possède ensuite leur comportement applicatif.

Implémenter exactement les contrats 1–4 du README : contribution `theme`, schéma 1, rôles UI obligatoires/facultatifs fermés, palette editor existante bornée à `vs`/`vs-dark`, couleurs `#RRGGBB`, identité `plugin:<packageId>/<contributionId>`. Version de package, schéma et protocole restent distincts. Refuser champs inconnus, identifiants/base/scheme incohérents, couleurs CSS/URL, tailles excessives et contributions dupliquées.

Corriger l'exigence JS pour viser exclusivement importer/exporter. Un package themes/effects seulement déclaratif ne peut contenir de code ; un package mixte reste valide avec le code requis par ses contributions JS. Aucun assouplissement des contrôles GLSL ou des quotas actuels.

Conserver les identifiants intégrés et `auto`, en distinguant explicitement les palettes intégrées des références plugin. Sanitiser les nouvelles références sans exiger un catalogue installé ni convertir silencieusement un ID valide pendant le chargement. Livrer le validateur partagé du nouveau `appThemeId` avec défaut `builtin` ; 02 branche ce champ dans `Preferences`. Garder toutes les autres préférences inchangées. Les consommateurs préexistants peuvent provisoirement résoudre une référence externe vers leur fallback intégré, car cette branche n'est pas déployable seule.

## Vérification et remise

Prouver **AC-SCHEMA** et **AC-REFS** : thèmes seuls sans code ; package mixte ; anciens packages ; référence syntaxiquement valide, trop longue ou malformée ; bases opposées au scheme ; types/champs invalides. Créer les tests `src/plugin/themes.spec.ts` et `src/prefs/editor-theme-reference.spec.ts` du contrat de review.

Exécuter les trois commandes de checks 01 du README. Pour Angular, le coordinateur fournit/génère le bridge IPC avec `pnpm gen:ipc` si nécessaire. Revoir le diff complet, notamment les exports et les endroits supposant seulement trois kinds ou un ID Monaco intégré. Aucune modification sandbox, storage, renderer, catalogue distant ni sélection UI.

Faire 1–3 commits logiques. Rapporter SHA exact de base/HEAD, commits, fichiers, résultats, contrats exportés et adaptations transitoires à remplacer par 02. Ne pousser ni ouvrir de PR. La vague 2 attend cette tâche acceptée et intégrée, pas seulement son achèvement.
