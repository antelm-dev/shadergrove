# Plugins locaux ISF — premier jalon exécutable

## But et périmètre

Installer localement un package de développeur dans Shadergrove, voir ses contributions dans l'onglet **Plugins / Installed**, importer un filtre ISF FX à une passe comme effet `custom` réglable, puis exporter cet effet en ISF. Un package déclaratif `effect` simple doit aussi pouvoir être installé et ajouté à la chaîne sans JS. Le parcours fonctionne sur web et dans l'application desktop installée, hors ligne après installation. Aucun catalogue public n'est ouvert par ce jalon.

Le jalon dépend du **jalon 1 d'effets personnalisés** planifié sur `plans/custom-postprocess-effects` à `1ff7ea6` : `instanceId`, définition `custom` embarquée, contrôles, validation, édition et bundle. Ce plan n'est pas exécuté au 2026-10-01. Son SHA source est ancien : le coordinateur doit le revalider sur `develop` actuel et faire intégrer le résultat avant la vague 2 ci-dessous. Ne pas modifier ce plan ni lancer ses workers par simple lecture du présent document.

Le cadrage général `docs/plugin-adapters-plan.md` est non suivi dans le checkout principal au départ et appartient à l'utilisateur : le préserver. Ce jalon retient une seule frontière JS (`importer`/`exporter`) et une frontière GLSL (`effect`). `textureGenerator`, `analyzer`, audio/MIDI et les exports HTML/JS communautaires restent hors périmètre.

## Source et contrats

- Dépôt `E:/Adel/Documents/Orgs/shader-studio`, source `develop` à `d64762a962395f7dd53e203f52a0f89b65314595`. Remote `origin` : `https://github.com/antelm-dev/shadergrove.git`. `origin/HEAD` = `master` (`615702f` au cadrage), 20 commits derrière `develop`. Cible d'intégration : `develop`, branche prévue `codex/integrate-local-isf-plugins`.
- Branche du plan : `codex/plan-local-isf-plugins`. Fournir aux workers ce README et leur prompt directement, ou la ref de plan et les chemins exacts ; leurs branches de code basées sur `develop` ne contiennent pas automatiquement ces fichiers. Résoudre et consigner le **SHA exact** de chaque base au lancement.
- Package local v1 : un fichier UTF-8 `.sgplugin.json` borné, contenant `manifest` et les octets de code/GLSL sous forme de chaînes, sans ZIP, URL, asset externe ou script de lifecycle. Le manifeste a `id`, `version`, `protocolVersion`, `appVersionRange`, éditeur, licence et `contributions[]` identifiées. Seuls `effect`, `importer`, `exporter` sont activables. Rejeter unknown kind/version, doublons, chemins, MIME/paramètres invalides et limites dépassées avant activation. `protocolVersion` et compatibilité app sont indépendants. Signature publique différée ; chargement local non signé avec activation explicite.
- Un `effect` est GLSL + contrôles déclarés : l'hôte produit le pass et copie la définition dans le shader, avec provenance facultative `packageId@version`. Une désinstallation ne modifie pas ce shader. Un transformer est JS dans le Worker opaque ; l'hôte seul choisit fichier, formulaire, sauvegarde et mutation du projet. Le manifeste déclare MIME, bornes et paramètres simples. L'ISF importé est une **candidate** revalidée et compilée par l'hôte, jamais une mutation directe du Worker.
- Contrat minimal des opérations : `importer` reçoit les octets du fichier sélectionné et les valeurs du formulaire, renvoie une candidate d'effet sérialisable ; `exporter` reçoit la seule définition/instance d'effet choisie et renvoie octets, MIME et nom suggéré. L'hôte décide de l'extension, du fichier de destination et de la mutation finale. Le Worker ne reçoit pas le projet entier dans ce jalon.
- Bornes de départ : package total 1 Mio, manifeste 64 Kio, JS/package 512 Kio, GLSL/effect 64 Kio, 16 contrôles/effect, 8 Mio/fichier, 24 Mio d'entrée/appel, 16 Mio de sortie, 64 Kio/événement, 1 Mio d'événements/appel, un Worker actif, 10 s/appel. Ces tailles s'entendent en octets UTF-8 ou binaires selon le champ. Les buffers passent en `Transferable` sur le port hôte–Worker ; le cadre opaque ne fait que transférer le port au démarrage. Les quotas ne bornent pas la mémoire native ni le temps GPU.
- ISF v1 : filtre FX à une passe avec `inputImage`, `float`/`bool`/`long`/`color` convertibles aux contrôles existants, et seulement les variables/macros démontrées par trois fixtures indépendantes (couleur simple, UV décalés, contrôles). Le sélecteur accepte l'extension `.fs` même si le navigateur ne donne aucun MIME, puis valide le contenu ; l'extension/MIME seuls ne suffisent pas. Refuser générateurs, transitions, autres images, audio, point2D, événement, multipasse et buffers persistants avec un motif. Le Worker transforme le format ; l'hôte valide la définition `custom`. La sortie `.fs` est du GLSL, donc du code pour son destinataire, jamais exécuté automatiquement hors de l'hôte. Références : [ISF JSON](https://docs.isf.video/ref_json), [fonctions ISF](https://docs.isf.video/ref_functions.html).

## Tâches et vagues

| ID  | Résultat principal                                 | Dépendance                   | Branche / worktree sibling suggéré                    | Livraison          | Base                                   |
| --- | -------------------------------------------------- | ---------------------------- | ----------------------------------------------------- | ------------------ | -------------------------------------- |
| 01  | Contrat de package, runner borné et preuve desktop | Aucune                       | `codex/plugin-isf-01` / `shader-studio-plugin-isf-01` | `integration-only` | `integration-tip` initial = SHA source |
| 02  | Installation durable et onglet Installed           | 01 accepté + effets intégrés | `codex/plugin-isf-02` / `shader-studio-plugin-isf-02` | `integration-only` | `integration-tip` figé                 |
| 03  | Package ISF et raccord à l'effet `custom`          | 01 accepté + effets intégrés | `codex/plugin-isf-03` / `shader-studio-plugin-isf-03` | `integration-only` | même `integration-tip` figé            |

02 traverse plusieurs fichiers web/desktop parce que stockage et parcours Installed doivent fonctionner ensemble ; ce même résultat reste sous un seul propriétaire. La base `develop` contient des changements absents du défaut `master`, et ces tâches exposent ensemble un contrat incomplet : aucune n'est classée `default-branch-pr`.

**Vague 1 :** créer la branche d'intégration au SHA source et lancer 01 depuis ce SHA. Relire/valider 01 puis intégrer ses commits. **Entre les vagues :** attendre que le jalon d'effets soit accepté et intégré sur `develop`, intégrer ce nouveau `develop` à la branche plugin, résoudre les conflits et enregistrer le SHA résultant. **Vague 2 :** lancer 02 et 03 depuis ce même SHA exact, dans deux worktrees isolés. 02 possède stockage/navigation/UI ; 03 possède convertisseur/fixture ISF et raccord `custom`. Le coordinateur raccorde les commandes génériques de 02 aux contributions de 03 et vérifie tout le parcours. Aucun incrément n'est déployable seul : ils restent `integration-only`. Une promotion vers `master` est distincte ; aucun push, PR ou merge distant n'est autorisé par ce plan.

## Acceptation et contrôle

- **AC-PACKAGE** : package local strictement validé avant exécution, `effect` sans JS, schéma d'entrée générant les formulaires, incompatibilité et rejet explicites ; package inconnu ou défectueux inactif.
- **AC-RUNNER** : Worker isolé, timeout/terminaison, quotas en octets, transfert sans copie des `ArrayBuffer`, erreur/annulation sans mutation ; sonde hostile concluante dans le **desktop installé** sous `shader-studio://bundle/` (origine opaque, réseau et IPC interdits, blob Worker opérationnel). Le `pluginSandboxProbe` actuel n'existe qu'en mode développement : utiliser une fixture installée ou une instrumentation de test absente du build livré, sans prétendre que le smoke navigateur prouve ce cas.
- **AC-INSTALLED** : installation explicite, reprise hors ligne après redémarrage, activation/retrait dans Plugins / Installed ; IndexedDB web partitionné par profil/compte, fichiers gérés sous `userData` desktop sans chemin fourni au Worker. Retirer un package ne casse pas un shader qui en avait copié un effet.
- **AC-ISF** : trois fichiers FX indépendants se convertissent avec contrôles et rendu ; export/réimport préserve le comportement et les valeurs dans le sous-ensemble déclaré ; ISF non pris en charge et code invalide produisent un diagnostic et laissent le projet intact.

Worker : contrôles ciblés et diff complet, 1–3 commits logiques, rapport base/HEAD, chemins, résultats et risques. Coordinateur : `pnpm run ci`, `pnpm build:desktop`, smoke navigateur, installation et lancement réels du paquet desktop, puis E2E : (1) install/restart/offline web et desktop ; (2) effet déclaratif ajouté deux fois, package retiré, shader inchangé ; (3) import ISF, réglage, sauvegarde/rechargement, export/réimport ; (4) package hostile, fichier trop grand, kind/version incompatibles et sortie malformée sans E/S ni mutation. CI vert et build desktop seuls ne prouvent pas le démarrage packagé.

## Travail indépendant et suite (pas de prompts exécutables ici)

Le correctif Wallpaper `project.json` peut être planifié/exécuté dès maintenant, indépendamment de ce jalon ; le vérifier dans Wallpaper Engine installé.

1. Étendre le parcours local avec un export Three.js à une passe et un runtime fixe possédé par l'hôte ; aucun JS/HTML provenant d'un plugin communautaire dans l'artefact exécutable.
2. Bibliothèque et publication immuable d'effets dans Explore, crédits/licences ; puis Discover, recherche, vérification de signature éditeur et association de clé au registre, revue qualité/abus, CGU et licences avant catalogue public.
3. Migrer Wallpaper puis Shadertoy en contributions après parité, avec runtime/réseau/clé détenus par l'hôte. Ajouter `textureGenerator` et `analyzer` avec contrats propres ; traiter audio/MIDI après conception d'un flux temps réel et de ses permissions.

```yaml
review_contract:
  milestone: local-isf-plugins-phase-1
  planning_ref: codex/plan-local-isf-plugins
  source_base: d64762a962395f7dd53e203f52a0f89b65314595
  default_branch: master
  integration_target: develop
  integration_branch: codex/integrate-local-isf-plugins
  prerequisite: custom-postprocess-effects-phase-1 accepted on develop before wave 2
  tasks:
    - id: '01'
      branch: codex/plugin-isf-01
      depends_on: []
      acceptance: [AC-PACKAGE, AC-RUNNER]
      checks:
        [
          'pnpm --filter @shadergrove/shared test -- src/plugin/package.spec.ts',
          'pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/plugins/plugin-host.spec.ts',
          'pnpm --filter @shadergrove/workspace-tools typecheck',
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '02'
      branch: codex/plugin-isf-02
      depends_on: ['01']
      acceptance: [AC-INSTALLED, AC-PACKAGE]
      checks:
        [
          'pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/plugins/plugin-installations.spec.ts',
          'pnpm --filter @shadergrove/desktop exec vitest run main/src/ipc/plugins.ipc.spec.ts',
          'pnpm check:i18n',
        ]
      delivery: integration-only
      base_policy: integration-tip
    - id: '03'
      branch: codex/plugin-isf-03
      depends_on: ['01']
      acceptance: [AC-ISF, AC-PACKAGE]
      checks:
        [
          'pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/plugins/isf-plugin.spec.ts',
          'pnpm --filter @shadergrove/web typecheck',
        ]
      delivery: integration-only
      base_policy: integration-tip
  integration_checks:
    [
      'pnpm run ci',
      'pnpm build:desktop',
      'browser sandbox smoke',
      'installed desktop sandbox and offline plugin E2E',
      'web ISF round-trip E2E',
    ]
  e2e_scenarios:
    - 'install local ISF package, import one-pass FX with controls, save/reload and export/reimport'
    - 'install declarative effect, add twice, remove package and retain both shader instances'
    - 'installed desktop denies network and IPC to hostile plugin and terminates Worker'
    - 'oversized, incompatible or malformed package and result never mutate shader or destination'
  deferred:
    [
      'Wallpaper project.json fix',
      'Three.js export',
      'effect publication and public catalog',
      'first-party adapter migration',
      'texture generator, analyzer, audio and MIDI',
    ]
```
