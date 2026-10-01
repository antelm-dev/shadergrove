# Effets postprocess personnalisés — jalon 1

## But et limites

Livrer un effet GLSL à une passe, contenu entièrement dans chaque instance du `render` d'un shader : création, édition avec repli sur le dernier programme valide, paramètres, duplication, réorganisation, sauvegarde et aller-retour export/import. Deux instances du même type, y compris deux Vignettes, doivent fonctionner. Le jalon est utilisable sur web et desktop avec le stockage de shaders existant. Il n'ajoute ni bibliothèque « Mes effets », ni entité serveur, ni publication d'effet, ni nouvelle migration SQL.

La bibliothèque privée (définition versionnée et fichier d'effet autonome), Explore, les crédits/licences en cascade, les textures auxiliaires, le feedback et les effets multipasses sont différés. Les presets actuels restent propres à un shader ; l'export actuel transporte le shader entier, pas un effet isolé. Les adaptateurs JavaScript/Workers sont un autre domaine et ne doivent pas être modifiés. Avant le jalon 2, définir les métadonnées de provenance/licence ; pour Explore, partir de la liste actuelle `PUBLICATION_LICENSES`, sans NC/ND, et définir la compatibilité BY-SA avant d'ouvrir la publication.

## Références et lancement

- Dépôt : `E:/Adel/Documents/Orgs/shader-studio`. Checkout initial : `develop`, HEAD `1dbead177a2ba4c2d9f790dfb81f666f85132bfd`, avec `docs/plugin-adapters-plan.md` non suivi et préservé.
- `origin/HEAD` pointe sur `master` (`615702fddc89189ae4e4c85f1ef3a82c5287e171` lors du plan) ; `develop` contient 12 commits supplémentaires. Ce jalon part du HEAD `develop` ci-dessus et vise une branche d'intégration, puis une revue vers `develop`. Une promotion ultérieure vers `master` est distincte.
- Plan : `codex/plan-custom-postprocess-effects`, `docs/feature-plans/custom-postprocess-effects/`. Intégration : `codex/integrate-custom-postprocess-effects`. Aucun `AGENTS.md` applicable trouvé.
- Le coordinateur fournit directement ce README et le prompt à chaque worker, ou leur donne le SHA exact du commit de plan avec ces chemins. Les branches worker basées sur `develop` ne contiennent pas automatiquement le plan. Avant exécution, rafraîchir le remote, comparer avec la base et consigner chaque SHA de lancement. Ne jamais utiliser une branche mobile comme base implicite.

## Contrat partagé proposé

1. Chaque entrée `postProcessing.effects[]` a un `instanceId` stable. Pour les anciennes entrées sans ID, `validateRender` assigne un ID déterministe dérivé du type (les anciennes données ne contiennent au plus qu'une occurrence de chaque type). Les nouvelles instances reçoivent un ID distinct ; l'unicité est validée. Toutes les actions de chaîne ciblent l'ID. Les fonctions de convenance historiques doivent rester cohérentes jusqu'à ce que leurs appels soient migrés.
2. La variante `custom` contient sa définition complète `{ apiVersion: 1, name, source, controls }`, ses `values: ShaderParams` et son état d'instance. Réutiliser `validateControls`, `sanitizeParams`, les types nombre/booléen/couleur/liste et la convention `u_<key>` ; les clés sont locales à la passe. Borner code, contrôles et chaîne. Une version incompatible ou une définition invalide ne doit pas être exécutée ni disparaître silencieusement pendant sauvegarde/import : afficher un état explicite et préserver le contenu quand il est possible de le représenter sans danger. Fixer le comportement exact de validation avant les travaux des vagues 2.
3. L'auteur écrit `vec4 effect(vec4 color, vec2 uv)`. L'application fournit le vertex plein écran, l'échantillon initial de `tDiffuse`, `vUv`, `u_resolution`, `u_time` et les `u_<key>`, puis appelle la fonction. `apiVersion: 1` fige ce contrat ; changer de backend graphique nécessitera une implémentation ou une conversion explicite de cette version. La définition est une copie, jamais une URL ni une référence vivante.
4. Le format de bundle devient `shader-studio/v4` si le contrat sérialisé change ; importer v1–v3 continue à fonctionner. Les presets qui capturent `render`, les sauvegardes serveur et desktop, la récupération des brouillons, l'export et l'import doivent conserver les IDs, le code et les valeurs. Aucune migration SQL n'est attendue car `renderJson` stocke déjà le `render` complet ; cette hypothèse est vérifiée par tests.
5. Le moteur indexe par `instanceId` et distingue valeurs seules (uniforms), code changé (compiler une seule candidate hors écran puis remplacer cette passe), ordre/activation/ajout/suppression (mettre à jour la chaîne sans montrer une passe noire). Réutiliser le principe de la sonde 1×1 de `PassCompiler`, `CompileDiagnostic` et le rapport des erreurs par document. Un échec conserve la dernière passe valide en mémoire ; au rechargement, une passe invalide est ignorée avec diagnostic sans modifier le document. La perte de contexte libère/recrée les ressources ; proposer un démarrage de récupération sans effets personnalisés si une chaîne ne peut plus rendre.

Le `ShaderEngine` et `ShaderCanvas` relient le rendu au store ; `PostProcessingPanel` et `GuiPanel` sont actuellement couplés au type d'effet et aux paramètres du shader. `CodeEditor` est réutilisable avec des documents GLSL et des diagnostics. Le rendu direct reste le chemin à zéro effet actif. L'export Wallpaper actuel avertit déjà que le postprocess n'est pas exporté ; cet avertissement doit continuer à couvrir les effets personnalisés.

## Tâches et vagues

| ID | Résultat principal | Branche / worktree sibling suggéré | Dépendance | Livraison | Base |
| --- | --- | --- | --- | --- | --- |
| 01 | Contrat, migration et aller-retour de données | `codex/custom-postprocess-01` / `shader-studio-custom-postprocess-01` | aucune | `integration-only` | `integration-tip` initial = SHA source |
| 02 | Exécution et compilation candidate des instances | `codex/custom-postprocess-02` / `shader-studio-custom-postprocess-02` | 01 accepté | `integration-only` | `integration-tip` fixé |
| 03 | Édition et contrôles d'instance dans l'UI | `codex/custom-postprocess-03` / `shader-studio-custom-postprocess-03` | 01 accepté | `integration-only` | même `integration-tip` fixé |

Vague 1 : lancer 01 depuis le SHA source ; relire son diff et ses tests, puis intégrer ses commits dans `codex/integrate-custom-postprocess-effects`. Vague 2 : lancer 02 et 03 dans deux worktrees isolés depuis le **même SHA exact** du tip d'intégration après 01. Ils possèdent des fichiers principaux distincts. Le coordinateur réunit leurs branches, résout le raccord diagnostics/UI et contrôle le parcours complet. Aucun des trois incréments n'est déployable seul : chacun expose ou consomme un contrat incomplet tant que le jalon n'est pas intégré.

## Critères d'acceptation

- **AC-ID** : anciens Bloom/Vignette obtiennent le même ID à chaque chargement ; deux instances d'un même type ont des IDs distincts et se règlent, déplacent, désactivent et suppriment séparément.
- **AC-DATA** : code, `apiVersion`, contrôles, valeurs et ordre survivent au save/reload, aux presets, au brouillon et au bundle v4 export/import sur les chemins web et desktop ; v1–v3 restent importables sans changement aléatoire.
- **AC-RENDER** : l'effet reçoit l'image précédente ; seules les uniforms bougent avec un réglage ; seul le code modifié est sondé ; erreur de compilation, changement d'ordre et perte de contexte ne produisent pas de remplacement noir permanent.
- **AC-EDITOR** : un utilisateur peut créer, dupliquer, éditer et régler un effet depuis le shader ; les erreurs indiquent l'instance et la ligne utilisateur ; l'édition conserve la dernière image valide et l'accessibilité clavier des actions.
- **AC-BOUNDARY** : aucun nouveau stockage d'effet ou appel Explore desktop ; limites validées au serveur/import ; le chemin direct sans effet reste paresseux ; l'avertissement Wallpaper reste exact.

## Vérification et revue

Chaque worker exécute les contrôles ciblés de son prompt, relit tout son diff et rapporte base/HEAD, 1–3 commits, chemins, résultats, limites et preuves des AC. Le coordinateur exécute `pnpm run ci`, `pnpm build:desktop`, revoit le diff intégré et effectue les parcours critiques ci-dessous ; il distingue tout contrôle manuel ou environnement indisponible d'un contrôle passé. Pas de push, PR ou fusion distante autorisés par ce plan. La revue peut recevoir séparément l'instruction « Review completed tasks and open eligible PRs » ; ne jamais fusionner automatiquement. Conserver les worktrees encore utilisés et suivre les outils de gestion des worktrees pour leur cycle de vie.

Parcours E2E critiques :

1. Sur web : créer deux instances du même effet avec valeurs différentes, changer leur ordre, sauver, recharger, capturer, exporter en v4, importer dans une bibliothèque de test et retrouver image/IDs/valeurs.
2. Sur desktop : importer le même bundle, modifier un paramètre et sauver localement ; vérifier après redémarrage de l'application packagée si l'environnement le permet.
3. Saisir du GLSL invalide après une version valide : diagnostic à la bonne ligne et image antérieure conservée ; recharger avec source invalide et voir une passe ignorée avec message, puis réparer.
4. Ouvrir un ancien v3 avec Bloom/Vignette, relire et sauver sans modification d'effet, vérifier la stabilité des IDs et l'absence de changement fantôme du brouillon ; activer/désactiver toute la chaîne, vérifier le chemin direct et la récupération après perte de contexte.

```yaml
review_contract:
  milestone: custom-postprocess-effects-phase-1
  planning_ref: codex/plan-custom-postprocess-effects
  source_base: 1dbead177a2ba4c2d9f790dfb81f666f85132bfd
  default_branch: master
  integration_target: develop
  integration_branch: codex/integrate-custom-postprocess-effects
  tasks:
    - id: '01'
      branch: codex/custom-postprocess-01
      depends_on: []
      acceptance: [AC-ID, AC-DATA, AC-BOUNDARY]
      checks: ['pnpm --filter @shadergrove/shared test -- src/model/render.spec.ts src/validate/validate.spec.ts', 'pnpm --filter @shadergrove/shared typecheck', 'pnpm --filter @shadergrove/backend test -- src/storage/shader-storage.spec.ts']
      delivery: integration-only
      base_policy: integration-tip
    - id: '02'
      branch: codex/custom-postprocess-02
      depends_on: ['01']
      acceptance: [AC-RENDER, AC-BOUNDARY]
      checks: ['pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/rendering/engine/post-processing.spec.ts', 'pnpm --filter @shadergrove/web typecheck']
      delivery: integration-only
      base_policy: integration-tip
    - id: '03'
      branch: codex/custom-postprocess-03
      depends_on: ['01']
      acceptance: [AC-EDITOR, AC-ID]
      checks: ['pnpm --filter @shadergrove/web test -- --watch=false --include=src/app/ui/inspector/post-processing-panel.spec.ts', 'pnpm --filter @shadergrove/web typecheck', 'pnpm check:i18n']
      delivery: integration-only
      base_policy: integration-tip
  integration_checks: ['pnpm run ci', 'pnpm build:desktop', 'web save/reload/export/import E2E', 'desktop bundle E2E', 'invalid GLSL and context-loss E2E']
  e2e_scenarios:
    - 'duplicate and reorder custom effect; save reload export import with exact code, ids and values'
    - 'invalid live edit retains last valid pass; reload skips invalid pass with diagnostics'
    - 'legacy v3 import has deterministic IDs and direct render still works'
  deferred: ['private effect library and standalone effect file', 'public Explore effect publication and license credits', 'feedback, multipass effects, auxiliary textures']
```
