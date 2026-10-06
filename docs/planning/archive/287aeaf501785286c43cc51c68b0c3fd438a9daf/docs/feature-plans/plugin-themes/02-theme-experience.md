# 02 — Installer, choisir et conserver un thème plugin

Lire le README coordinateur et le handoff 01 fournis. Mission : livrer le parcours local de thèmes, de l'installation d'une collection à son application UI/Monaco, avec persistance et fallback.

## Base et isolation

Livraison `integration-only`, base `integration-tip`. Lancement seulement après 01 accepté et intégré. Le coordinateur fournit `<launch-base-02-sha>` exact contenant ses commits et le contrat shared final.

```text
git worktree add <absolute-sibling-path>/shader-studio-plugin-themes-02 -b codex/plugin-themes-02 <launch-base-02-sha>
cd <absolute-sibling-path>/shader-studio-plugin-themes-02
git status --short --branch
```

Exiger un état propre et lire les instructions applicables. README/prompt doivent être fournis directement ou via le planning SHA.

## Propriété et parcours

Frontière unique : consommation des thèmes studio. Créer `apps/studio/src/app/themes/` pour catalogue/résolution/application et tests. Raccorder `prefs/preferences.ts`, `editor/{editor-themes,monaco-loader,code-editor}.ts`, `styles.scss` et les initialisations `app.config.ts`/`app.config.desktop.ts`. UI : `plugins/plugins-page.ts`, `ui/editor/theme-panel.ts`, les menus `ui/layout/app-titlebar.ts` et `ui/preview/preview-shell.ts` avec leur commande de thème. Tests associés, clés i18n et catalogue `libs/backend/src/i18n-catalog.ts` autorisés. Le contrat shared appartient à 01 ; toute correction nécessaire passe par le coordinateur.

Suivre les contrats 4–7 du README. Lister uniquement les thèmes de packages actifs/compatibles/valides du profil courant. Stocker `appThemeId` sans dépendance plugin dans Preferences, préserver `colorScheme`, et confier l'application des couleurs à un propriétaire unique. Mapping fermé vers les tokens Material, nettoyage complet des valeurs précédentes, fallback intégré pendant chargement ou indisponibilité. Ne pas supposer une résolution synchrone auth/IndexedDB. Aucun Worker de plugin pour un thème.

Monaco : enregistrer avant sélectionner, gérer chargement tardif, mise à jour même ID et tous les éditeurs existants ; `auto` suit la palette app. Les choix explicites, preview/cancel/apply et leurs valeurs persistées restent cohérents. Retirer ou remplacer un package sélectionné doit rétablir UI et editor, y compris sur un shader clair et dans un overlay.

Dans Plugins, afficher correctement le kind Theme avec ses variantes/crédits ; activer un package ne sélectionne rien. Les deux menus donnent accès à un même choix visuel accessible au clavier, incluant intégré clair/sombre/système et variantes installées. Le panneau editor reçoit le catalogue dynamique. Éviter duplication des listes ou gestionnaires et tout badge AAA sans preuve.

Créer `tools/workspace/fixtures/plugins/themes/grove-amber.sgplugin.json` : deux palettes originales, sans JS, métadonnées cohérentes. Créer `apps/studio-e2e/src/plugin-themes.spec.ts` avec les fixtures Playwright existantes : vrai import fichier, activation, sélection, assertions de couleurs calculées Material/Monaco, reload, update/retrait et fallback. Tester les packages historiques, le profil et les overrides facultatifs manquants.

## Vérification et remise

Prouver **AC-PREFS**, **AC-APPLY**, **AC-LIFECYCLE**, **AC-UX**, **AC-E2E**. Exécuter les checks 02 du README, ajouter les tests ciblés des consommateurs nécessaires et transmettre les preuves de revue visuelle. Le coordinateur possède `pnpm run ci`, build et E2E agrégés, puis installation/lancement desktop et reprise hors ligne ; fournir le scénario reproductible, signaler toute preuve desktop manquante.

Hors scope : catalogue public, packs populaires tiers, fontes/CSS/layout arbitraires, synchronisation fenêtres natives, zéro flash initial et refactors hors thèmes. Aucun shader, document ou rendu GPU modifié.

Faire 1–3 commits logiques, relire le diff complet ; rapporter base/HEAD, commits, checks, preuves et risques. Ne pousser ni ouvrir de PR.
