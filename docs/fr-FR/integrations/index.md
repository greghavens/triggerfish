# Construire des integrations

Triggerfish est concu pour etre etendu. Que vous souhaitiez connecter une nouvelle
source de donnees, automatiser un flux de travail, donner de nouvelles competences
a votre agent ou reagir a des evenements externes, il existe un parcours
d'integration bien defini -- et chaque parcours respecte le meme modele de
securite.

## Parcours d'integration

Triggerfish propose cinq methodes distinctes pour etendre la plateforme. Chacune
sert un objectif different, mais toutes partagent les memes garanties de
securite : application de la classification, suivi du taint, hooks de politique et
journalisation d'audit complete.

| Parcours                                                    | Objectif                                     | Ideal pour                                                                           |
| ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| [MCP Gateway](./mcp-gateway)                                | Connecter des serveurs d'outils externes     | Communication standardisee agent-outil via le Model Context Protocol                 |
| [Plugin SDK](./plugins)                                     | Executer du code personnalise en sandbox     | Operations CRUD sur des systemes externes, transformations de donnees complexes      |
| [Environnement d'execution](./exec-environment)             | L'agent ecrit et execute son propre code     | Construction d'integrations, prototypage, tests et iteration en boucle de retroaction |
| [Skills](./skills)                                          | Donner de nouvelles capacites via des instructions | Comportements reutilisables, marketplace communautaire, auto-creation par l'agent    |
| [Automatisation du navigateur](./browser)                   | Controler une instance de navigateur via CDP | Recherche web, remplissage de formulaires, scraping, workflows web automatises       |
| [Webhooks](./webhooks)                                      | Recevoir des evenements entrants de services externes | Reactions en temps reel aux emails, alertes, evenements CI/CD, changements de calendrier |
| [GitHub](./github)                                          | Integration complete du workflow GitHub       | Boucles de revue de PR, triage d'issues, gestion de branches via webhooks + exec + skills |
| [Google Workspace](./google-workspace)                      | Connecter Gmail, Calendar, Tasks, Drive, Sheets | Integration OAuth2 fournie avec 14 outils pour Google Workspace                     |
| [Obsidian](./obsidian)                                      | Lire, ecrire et rechercher des notes de coffre Obsidian | Acces aux notes avec controle de classification, mappages de dossiers, wikilinks, notes quotidiennes |

## Modele de securite

Chaque integration -- quel que soit le parcours -- opere sous les memes
contraintes de securite.

### Tout commence comme UNTRUSTED

Les nouveaux serveurs MCP, plugins, canaux et sources de webhook sont tous par
defaut a l'etat `UNTRUSTED`. Ils ne peuvent pas echanger de donnees avec l'agent
tant qu'ils ne sont pas explicitement classifies par le proprietaire (niveau
personnel) ou l'administrateur (niveau entreprise).

```
UNTRUSTED  -->  CLASSIFIED  (apres examen, niveau de classification attribue)
UNTRUSTED  -->  BLOCKED     (explicitement interdit)
```

### La classification se propage

Lorsqu'une integration renvoie des donnees, ces donnees portent un niveau de
classification. L'acces a des donnees classifiees escalade le taint de la session
en consequence. Une fois marque, la session ne peut plus produire de sortie vers
une destination de classification inferieure. C'est la
[regle de non ecriture descendante](/fr-FR/security/no-write-down) -- elle est
fixe et ne peut pas etre contournee.

### Les hooks de politique s'appliquent a chaque frontiere

Toutes les actions d'integration passent par des hooks de politique
deterministes :

| Hook                    | Quand il se declenche                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| `PRE_CONTEXT_INJECTION` | Des donnees externes entrent dans le contexte de l'agent (webhooks, reponses de plugins) |
| `PRE_TOOL_CALL`         | L'agent demande un appel d'outil (MCP, exec, navigateur)                       |
| `POST_TOOL_RESPONSE`    | L'outil renvoie des donnees (classifier la reponse, mettre a jour le taint)    |
| `PRE_OUTPUT`            | La reponse quitte le systeme (verification finale de classification)           |

Ces hooks sont des fonctions pures -- pas d'appels LLM, pas d'aleatoire, pas de
contournement. La meme entree produit toujours la meme decision.

### Piste d'audit

Chaque action d'integration est journalisee : ce qui a ete appele, qui l'a
appele, quelle a ete la decision de politique et comment le taint de session a
change. Cette piste d'audit est immuable et disponible pour l'examen de
conformite.

::: warning SECURITE Le LLM ne peut pas contourner, modifier ou influencer les
decisions des hooks de politique. Les hooks s'executent dans le code en dessous de
la couche LLM. L'IA demande des actions -- la couche de politique decide. :::

## Choisir le bon parcours

Utilisez ce guide de decision pour choisir le parcours d'integration adapte a
votre cas d'usage :

- **Vous souhaitez connecter un serveur d'outils standard** -- Utilisez le
  [MCP Gateway](./mcp-gateway). Si un outil parle MCP, c'est le parcours a suivre.
- **Vous devez executer du code personnalise contre une API externe** -- Utilisez
  [Guide complet des extensions](./plugins).
- **Vous voulez que l'agent construise et itere sur du code** -- Utilisez
  l'[environnement d'execution](./exec-environment). L'agent obtient un espace de
  travail avec une boucle complete ecriture/execution/correction.
- **Vous voulez enseigner un nouveau comportement a l'agent** -- Utilisez les
  [Skills](./skills). Ecrivez un `SKILL.md` avec des instructions, ou laissez
  l'agent creer les siennes.
- **Vous devez automatiser des interactions web** -- Utilisez
  l'[automatisation du navigateur](./browser). Chromium controle par CDP avec
  application des politiques de domaine.
- **Vous devez reagir a des evenements externes en temps reel** -- Utilisez les
  [Webhooks](./webhooks). Les evenements entrants sont verifies, classifies et
  achemines vers l'agent.

::: tip Ces parcours ne sont pas mutuellement exclusifs. Une skill peut utiliser
l'automatisation du navigateur en interne. Un plugin peut etre declenche par un
webhook. Une integration creee par l'agent dans l'environnement d'execution peut
etre persistee comme skill. Ils se composent naturellement. :::
