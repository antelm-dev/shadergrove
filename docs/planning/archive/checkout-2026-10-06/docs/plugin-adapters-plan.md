# Plugins communautaires et effets personnalisés

État : plan, 2026-10-01. Le plan du premier jalon d'effets est commité sur
`codex/plan-custom-postprocess-effects` (`1ff7ea6`) et n'est pas exécuté.
`PluginSandbox` est aujourd'hui une sonde web, pas un gestionnaire de plugins.
Ce document relie les deux chantiers sans faire dépendre l'édition d'effets
personnels d'un catalogue ou d'un Worker.

## Contrats à exposer

Un package a `id`, `version`, `protocolVersion`, `appVersionRange`, éditeur et
licence. Il peut déclarer plusieurs contributions identifiées, chacune avec
un `kind`, un schéma et des limites propres. L'hôte valide le manifeste avant
d'accéder au code ou au GLSL ; il refuse un kind/version qu'il ne sait pas
exécuter. Le champ est extensible, mais aucune méthode « plugin générique »
n'obtient le projet entier ou les E/S de l'application.

| Contribution            | Exécution                        | Première capacité                                                      |
| ----------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `effect`                | GLSL dans le renderer de l'hôte  | Passe plein écran, image précédente et paramètres déclarés ; aucun JS  |
| `importer` / `exporter` | JS dans un Worker opaque         | Entrées et résultats typés, fichiers et formulaires fournis par l'hôte |
| `textureGenerator`      | GLSL dans le renderer            | Plus tard : sortie texture et durée de vie distinctes d'un effet       |
| `analyzer`              | JS dans le Worker, lecture seule | Plus tard : projet/AST éventuel en entrée et annotations en sortie     |
| Entrée temps réel       | Flux fourni par l'hôte           | Plus tard : audio/MIDI et association déclarative aux uniforms         |

Seuls `effect`, `importer` et `exporter` sont activables en v1. Décrire
`textureGenerator` et `analyzer` maintenant, puis les ajouter à l'énumération
exécutable avec leur vrai contrat. Une valeur reconnue mais non implémentée
ferait croire aux éditeurs qu'ils peuvent déjà publier cette contribution.

Un effet personnel, une publication d'effet dans Explore et un package de
plugin sont des objets distincts. La publication peut référencer le même
artefact immuable qu'un package installable, après résolution des crédits et
licences ; les effets personnels restent utilisables hors ligne. L'onglet
**Plugins** sert à installer des capacités, Explore à découvrir des œuvres.

## Jalons et dépendances

| Jalon                     | Dépend de            | Preuve de sortie                                                                     |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| **W — Wallpaper**         | Aucun                | `project.json` et contrôles utilisables dans Wallpaper Engine installé               |
| **E — Effets personnels** | Aucun                | Effet `custom` à une passe, instances multiples, édition et aller-retour des données |
| **P — Hôte de packages**  | Aucun                | Manifeste, installation locale, runner JS et preuve du sandbox desktop installé      |
| **I — ISF**               | E + P                | Package import/export : ISF FX à une passe vers effet réglable puis retour ISF       |
| **T — Three.js**          | P                    | Export Image à une passe via runtime fixe appartenant à Shadergrove                  |
| **U — Installés**         | P + un package utile | Onglet Plugins : activation, retrait, versions et mises à jour locales               |
| **S — Effets partagés**   | E + P                | Bibliothèque d'effets, publication immuable et crédits dans Explore                  |
| **C — Catalogue**         | I + T + U + S        | Découverte, détail et installation vérifiée de packages publics                      |
| **M — Intégrés**          | P + I                | Wallpaper puis Shadertoy migrés comme contributions, avec parité web/desktop         |

**W** est un correctif indépendant. `wallpaper-export.ts` émet un HTML avec
`wallpaperPropertyListener`, sans définitions de contrôles dans `project.json`.
Générer `index.html` et `project.json` avec les mêmes clés/défauts, en dossier
sur desktop et ZIP sur web. Vérifier nombre, booléen, couleur, choix, textures
et multipasse dans une vraie installation. Confirmer les règles d'import du
`project.json` avant de figer l'archive. Sources :
[import web](https://docs.wallpaperengine.io/en/web/first/gettingstarted.html),
[propriétés utilisateur](https://docs.wallpaperengine.io/en/web/customization/properties.html).

**E** exécute le plan existant : `instanceId`, effet `custom`, source GLSL,
contrôles et valeurs copiés dans chaque shader. Sauvegardes, presets, bundles
et anciens documents doivent garder identité, code et ordre. Une provenance
facultative (`packageId`, version, crédit) peut s'ajouter lors de P/I ; elle ne
remplace pas la copie. Une référence `pluginId@version` seule casserait un
shader après désinstallation ou hors ligne. Ce jalon ne modifie pas le Worker.

**P** établit le format des packages, le schéma de la contribution `effect`
et le premier chargement local par un développeur. Son raccord au renderer
attend E et se vérifie en I : l'hôte recevra GLSL et contrôles, produira le
`ShaderPass`, les uniforms et l'UI, puis copiera la définition dans une
instance. Une passe, aucun feedback ni texture auxiliaire pour cette version.
Bornes initiales : 64 Kio de GLSL, 16 contrôles, 16 effets dans la chaîne ;
valider ces valeurs par mesure web/desktop avant publication.

Pour `importer`/`exporter`, le manifeste déclare MIME, taille et paramètres
simples ; l'hôte construit sélecteur et formulaire, valide les octets et les
valeurs et transfère les `ArrayBuffer` à travers les deux `MessagePort`.
`PluginSandbox` doit d'abord passer dans l'application desktop **installée**
(`shader-studio://bundle/`) : origine opaque, réseau et IPC bloqués, démarrage
du Worker blob, timeout et terminaison réelle. Tester avec un package local
de développeur : installation, appel, résultat rejeté et désinstallation.
P peut avancer pendant E ; aucun adaptateur existant n'a besoin d'être déplacé.

**I** est le premier test vertical du Worker et du modèle GPU. Installer
d'abord un effet déclaratif local, puis un package ISF exposant `importer` et
`exporter`. Accepter les **ISF FX** à une passe
avec `inputImage` et entrées convertibles vers nombre, booléen, couleur et
choix. La conversion traduit ce sous-ensemble vers le contrat interne
`vec4 effect(vec4 color, vec2 uv)` ; l'hôte revalide puis compile la candidate.
L'export écrit un ISF valide pour ce même sous-ensemble. Le format ISF (JSON
et GLSL) inspire le package d'effet, mais n'est pas son ABI : ISF a ses
propres conventions, entrées et macros. Refuser avec motif les générateurs,
transitions, autres images, audio, entrées non convertibles, multipasse et
buffers persistants. Avant de figer cette conversion, faire une preuve sur
trois fichiers ISF indépendants : simple couleur, échantillonnage à UV décalés
et contrôles. Définir dans les fixtures les variables/fonctions ISF acceptées ;
ne pas promettre la conversion de GLSL arbitraire. Tester l'aller-retour des
contrôles ; un import raté ne modifie pas le projet.

**T** prend le projet Image à une passe, ses uniforms et textures prises en
charge. La sortie Three.js contient du JavaScript qui s'exécutera chez son
destinataire : Shadergrove fournit le runtime/template fixe. Le plugin renvoie
seulement les données validées ; l'hôte les insère avec une sérialisation sûre.
La même règle vaut pour OBS, les pages autonomes et Wallpaper. Signaler les
fonctionnalités non exportées, dont les projets multipasses ; comparer le
rendu dans un navigateur de destination.

**U** ouvre l'onglet Plugins avec Installed dès qu'un package local fonctionne.
Intégrer Updates à cette vue. **S** réalise ce que le jalon E diffère :
définition d'effet réutilisable, version publiée figée, crédits/licence et
import dans un autre shader. Une publication de shader embarque la version
exacte de ses effets. **C** ajoute Discover, recherche, détail, installation
explicite et politique de versions. Un effet publié et son package installable
peuvent partager un artefact immuable, avec deux parcours de découverte.
Parcourir les métadonnées ne lance aucun code. Publication publique : CGU
éditeurs, licences, gestion des signalements/retraits et capacité de revue
avant ouverture des dépôts.

**M** termine la migration demandée. Wallpaper devient une contribution qui
fournit des données au runtime HTML fixe de l'hôte ; sa conversion pure peut
passer dans le Worker. Shadertoy sépare récupération réseau et conversion :
seule la conversion va au Worker, sans la clé API. Pour chacun, conserver le
chemin existant jusqu'à parité des sorties web et desktop, puis retirer le
doublon. Le stockage actuel de la clé Shadertoy reste un ticket distinct.

## Frontières de sécurité et d'exploitation

- **GPU :** sans JS, le GLSL n'a ni DOM ni réseau, mais travaille sur le GPU.
  Compilation et essai sur 1 × 1 ne prouvent pas sa rapidité ni la stabilité
  du contexte. Limiter source, contrôles, passes, résolution d'aperçu et
  ressources ; prévoir désactivation et démarrage sans effets tiers après
  échec. Aucun timeout du Worker ne peut arrêter de manière fiable le GPU.
- **Artefacts :** un exporter isolé peut produire du code dangereux pour son
  destinataire. Les sorties exécutables HTML/JS n'assemblent que des templates
  de l'hôte et des données validées. Même un fichier GLSL texte est du code à
  traiter comme tel lors de son futur chargement ; un avertissement seul ne
  constitue pas la barrière de sécurité.
- **Worker :** limites initiales par appel : 512 Kio de JS/package, 8 Mio par
  fichier, 24 Mio d'entrées, 16 Mio de sortie, 64 Kio par événement, 1 Mio
  d'événements, un Worker actif et 10 s avant terminaison. Rejeter avant
  transfert et avant écriture ; ces quotas ne sont pas une limite de mémoire
  native. L'export Wallpaper intégré peut garder son plafond desktop de
  256 Mio, avec essai de quatre textures de 4 Mio.
- **Installation et intégrité :** IndexedDB pour octets/état web, séparés par
  profil ou compte ; fichiers gérés par l'app sur desktop et accès hors ligne.
  Packages locaux de développeur explicitement activés, éventuellement non
  signés. Le catalogue vérifie hash, signature Ed25519 de l'éditeur et
  association éditeur/clé signée par une clé de registre intégrée à l'app.
  Un hash fourni par le serveur du package ne protège pas d'un serveur
  compromis. `protocolVersion`, `appVersionRange` et version du package sont
  trois champs distincts.
- **Revue :** sandbox, validation de l'hôte et modèle de sortie protègent les
  frontières JS et artefacts ; les limites et la récupération réduisent le
  risque GPU sans garantir son absence. Les mainteneurs examinent qualité, droits
  et abus. À l'entrée en catalogue, automatiser schéma, taille, licence,
  compatibilité, types déclarés, signaux d'analyse statique et tests du
  runner. Définir les CGU, règles de licences et retraits avant soumission
  publique.

## Acceptation de l'ensemble

1. Un effet personnel puis un effet installé fonctionnent deux fois avec des
   paramètres différents ; sauvegarde, export/import et désinstallation du
   package ne changent pas les shaders existants. GLSL invalide garde le
   dernier rendu valide pendant l'édition et un diagnostic au rechargement.
   Une version d'effet publiée dans Explore garde code, licence et crédits
   après modification ou retrait de sa définition personnelle.
2. ISF importe et exporte un FX à une passe avec contrôles ; les fonctions
   non prises en charge sont refusées clairement. Three.js reproduit le rendu
   du cas à une passe avec son runtime fixe.
3. Le sandbox résiste aux sondes hostiles sur web et desktop installé ; les
   quotas, buffers transférés et erreurs d'un package tiers sont vérifiés.
   Un résultat invalide ne modifie aucun shader ni fichier.
4. L'onglet Plugins installe, désactive, met à jour et retire un package ; le
   catalogue vérifie la signature et n'exécute rien en navigation. Wallpaper
   et Shadertoy gardent leur comportement après migration.

Références : [ISF JSON et passes](https://docs.isf.video/ref_json),
[Three.js ShaderPass](https://threejs.org/docs/pages/ShaderPass.html),
[perte de contexte WebGL](https://wikis.khronos.org/webgl/HandlingContextLost).
