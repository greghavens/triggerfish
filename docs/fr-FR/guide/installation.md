# Installation et déploiement

Triggerfish s'installe en une seule commande sur macOS, Linux, Windows et
Docker. Les installateurs binaires téléchargent une version pré-compilée,
vérifient sa somme de contrôle SHA256 et lancent l'assistant de configuration.

## Installation en une commande

::: code-group

```bash [macOS / Linux]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.ps1 | iex
```

```bash [Docker]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

:::

### Ce que fait l'installateur binaire

1. **Détecte votre plateforme** et votre architecture
2. **Télécharge** le dernier binaire pré-compilé depuis GitHub Releases
3. **Vérifie la somme de contrôle SHA256** pour garantir l'intégrité
4. **Installe** le binaire dans `/usr/local/bin` (ou `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Lance l'assistant de configuration** (`triggerfish dive`) pour configurer
   votre agent, votre fournisseur LLM et vos canaux
6. **Démarre le daemon en arrière-plan** pour que votre agent soit toujours
   en fonctionnement

Après la fin de l'installateur, vous disposez d'un agent pleinement
fonctionnel. Aucune étape supplémentaire n'est requise.

### Installer une version spécifique

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Configuration requise

| Prérequis         | Détails                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Système d'exploit.| macOS, Linux ou Windows                                          |
| Espace disque     | Environ 100 Mo pour le binaire compilé                           |
| Réseau            | Requis pour les appels API LLM ; tout le traitement est local    |

::: tip Pas de Docker, pas de conteneurs, pas de comptes cloud nécessaires.
Triggerfish est un binaire unique qui s'exécute sur votre machine. Docker est
disponible comme méthode de déploiement alternative. :::

## Docker

Le déploiement Docker fournit un wrapper CLI `triggerfish` qui vous offre la
même expérience de commande que le binaire natif. Toutes les données résident
dans un volume Docker nommé.

### Démarrage rapide

L'installateur récupère l'image, installe le wrapper CLI et lance l'assistant
de configuration :

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Ou lancez l'installateur depuis un checkout local :

```bash
./deploy/docker/install.sh
```

L'installateur :

1. Détecte votre runtime de conteneur (podman ou docker)
2. Installe le wrapper CLI `triggerfish` dans `~/.local/bin` (ou
   `/usr/local/bin`)
3. Copie le fichier compose dans `~/.triggerfish/docker/`
4. Récupère la dernière image
5. Lance l'assistant de configuration (`triggerfish dive`) dans un conteneur
   ponctuel
6. Démarre le service

### Utilisation quotidienne

Après l'installation, la commande `triggerfish` fonctionne comme le binaire
natif :

```bash
triggerfish chat              # Session de chat interactive
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Diagnostics de santé
triggerfish logs              # Voir les journaux du conteneur
triggerfish status            # Vérifier si le conteneur fonctionne
triggerfish stop              # Arrêter le conteneur
triggerfish start             # Démarrer le conteneur
triggerfish update            # Récupérer la dernière image et redémarrer
triggerfish dive              # Relancer l'assistant de configuration
```

### Fonctionnement du wrapper

Le script wrapper (`deploy/docker/triggerfish`) route les commandes :

| Commande        | Comportement                                                          |
| --------------- | --------------------------------------------------------------------- |
| `start`         | Démarrer le conteneur via compose                                     |
| `stop`          | Arrêter le conteneur via compose                                      |
| `run`           | Exécuter en premier plan (Ctrl+C pour arrêter)                        |
| `status`        | Afficher l'état du conteneur                                          |
| `logs`          | Diffuser les journaux du conteneur                                    |
| `update`        | Récupérer la dernière image, redémarrer                               |
| `dive`          | Conteneur ponctuel si non démarré ; exec + redémarrage si démarré     |
| Tout le reste   | `exec` dans le conteneur en cours d'exécution                         |

Le wrapper auto-détecte `podman` vs `docker`. Remplacez avec
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Le fichier compose se trouve à `~/.triggerfish/docker/docker-compose.yml` après
l'installation. Vous pouvez également l'utiliser directement :

```bash
cd deploy/docker
docker compose up -d
```

### Variables d'environnement

Copiez `.env.example` en `.env` à côté du fichier compose pour définir les clés
API via des variables d'environnement :

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Éditez ~/.triggerfish/docker/.env
```

Les clés API sont généralement stockées via `triggerfish config set-secret`
(persistées dans le volume de données), mais les variables d'environnement
fonctionnent comme alternative.

### Secrets dans Docker

Le trousseau de clés du système d'exploitation n'étant pas disponible dans les
conteneurs, Triggerfish utilise un magasin de secrets sauvegardé dans un fichier
à `/data/secrets.json` dans le volume. Utilisez le wrapper CLI pour gérer les
secrets :

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Persistance des données

Le conteneur stocke toutes les données sous `/data` :

| Chemin                      | Contenu                                    |
| --------------------------- | ------------------------------------------ |
| `/data/triggerfish.yaml`    | Configuration                              |
| `/data/secrets.json`        | Magasin de secrets sauvegardé en fichier    |
| `/data/data/triggerfish.db` | Base de données SQLite (sessions, cron, mémoire) |
| `/data/workspace/`          | Espaces de travail des agents              |
| `/data/skills/`             | Skills installés                           |
| `/data/logs/`               | Fichiers journaux                          |
| `/data/SPINE.md`            | Identité de l'agent                        |

Utilisez un volume nommé (`-v triggerfish-data:/data`) ou un montage bind pour
persister les données entre les redémarrages du conteneur.

### Construire l'image Docker localement

```bash
make docker
# ou
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Épinglage de version (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Installation depuis les sources

Si vous préférez compiler depuis les sources ou souhaitez contribuer :

```bash
# 1. Installer Deno (si vous ne l'avez pas)
curl -fsSL https://deno.land/install.sh | sh

# 2. Cloner le dépôt
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compiler
deno task compile

# 4. Lancer l'assistant de configuration
./triggerfish dive

# 5. (Optionnel) Installer en tant que daemon en arrière-plan
./triggerfish start
```

Alternativement, utilisez les scripts d'installation depuis les sources
archivés :

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info La compilation depuis les sources nécessite Deno 2.x et git. La
commande `deno task compile` produit un binaire autonome sans dépendances
externes. :::

## Compilation binaire multiplateforme

Pour compiler les binaires pour toutes les plateformes depuis n'importe quelle
machine hôte :

```bash
make release
```

Cela produit les 5 binaires plus les sommes de contrôle dans `dist/` :

| Fichier                       | Plateforme                 |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Sommes de contrôle pour tous les binaires |

## Répertoire d'exécution

Après avoir exécuté `triggerfish dive`, votre configuration et vos données se
trouvent dans `~/.triggerfish/` :

```
~/.triggerfish/
├── triggerfish.yaml          # Configuration principale
├── SPINE.md                  # Identité et mission de l'agent (prompt système)
├── TRIGGER.md                # Triggers de comportement proactif
├── workspace/                # Espace de travail de code de l'agent
├── skills/                   # Skills installés
├── data/                     # Base de données SQLite, état des sessions
└── logs/                     # Journaux du daemon et d'exécution
```

Dans Docker, cela correspond à `/data/` à l'intérieur du conteneur.

## Gestion du daemon

L'installateur configure Triggerfish comme un service natif du système
d'exploitation en arrière-plan :

| Plateforme | Gestionnaire de services         |
| ---------- | -------------------------------- |
| macOS      | launchd                          |
| Linux      | systemd                          |
| Windows    | Windows Service / Task Scheduler |

Après l'installation, gérez le daemon avec :

```bash
triggerfish start     # Installer et démarrer le daemon
triggerfish stop      # Arrêter le daemon
triggerfish status    # Vérifier si le daemon fonctionne
triggerfish logs      # Voir les journaux du daemon
```

## Processus de publication

Les publications sont automatisées via GitHub Actions. Pour créer une nouvelle
publication :

```bash
git tag v0.2.0
git push origin v0.2.0
```

Cela déclenche le workflow de publication qui compile les 5 binaires de
plateforme, crée une Release GitHub avec les sommes de contrôle et pousse une
image Docker multi-architecture vers GHCR. Les scripts d'installation
téléchargent automatiquement la dernière version.

## Mise à jour

Pour vérifier et installer les mises à jour :

```bash
triggerfish update
```

## Support des plateformes

| Plateforme  | Binaire | Docker | Script d'installation |
| ----------- | ------- | ------ | --------------------- |
| Linux x64   | oui     | oui    | oui                   |
| Linux arm64 | oui     | oui    | oui                   |
| macOS x64   | oui     | —      | oui                   |
| macOS arm64 | oui     | —      | oui                   |
| Windows x64 | oui     | —      | oui (PowerShell)      |

## Prochaines étapes

Triggerfish étant installé, rendez-vous au guide de
[Démarrage rapide](./quickstart) pour configurer votre agent et commencer à
discuter.
