# Costruire Integrazioni

Triggerfish è progettato per essere esteso. Che si voglia connettere una nuova
fonte dati, automatizzare un flusso di lavoro, dare all'agent nuove competenze
o reagire a eventi esterni, esiste un percorso di integrazione ben definito --
e ogni percorso rispetta lo stesso modello di sicurezza.

## Percorsi di Integrazione

Triggerfish offre cinque modi distinti per estendere la piattaforma. Ciascuno
serve uno scopo diverso, ma tutti condividono le stesse garanzie di sicurezza:
applicazione della classificazione, tracciamento del taint, hook di policy e
registrazione di audit completa.

| Percorso                                                   | Scopo                                            | Ideale Per                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [MCP Gateway](./mcp-gateway)                               | Connettere server di tool esterni                | Comunicazione agent-to-tool standardizzata tramite il Model Context Protocol          |
| [SDK dei Plugin](./plugins)                                 | Eseguire codice personalizzato in sandbox        | Operazioni CRUD su sistemi esterni, trasformazioni dati complesse, flussi di lavoro   |
| [Ambiente di Esecuzione](./exec-environment)                | L'agent scrive ed esegue il proprio codice       | Costruire integrazioni, prototipazione, test e iterazione in un ciclo di feedback     |
| [Skill](./skills)                                           | Dare all'agent nuove capacità tramite istruzioni | Comportamenti riutilizzabili, marketplace comunitario, auto-creazione dell'agent       |
| [Automazione del Browser](./browser)                        | Controllare un'istanza browser via CDP           | Ricerca web, compilazione form, scraping, flussi di lavoro web automatizzati          |
| [Webhook](./webhooks)                                       | Ricevere eventi in ingresso da servizi esterni   | Reazioni in tempo reale a email, allerte, eventi CI/CD, modifiche al calendario       |
| [GitHub](./github)                                          | Integrazione completa del flusso di lavoro GitHub | Cicli di review PR, triage delle issue, gestione branch via webhook + exec + skill   |
| [Google Workspace](./google-workspace)                      | Connettere Gmail, Calendar, Tasks, Drive, Sheets | Integrazione OAuth2 preconfigurata con 14 tool per Google Workspace                   |
| [Obsidian](./obsidian)                                      | Leggere, scrivere e cercare note nei vault Obsidian | Accesso alle note con gating di classificazione, mappature cartelle, wikilink, note giornaliere |

## Modello di Sicurezza

Ogni integrazione -- indipendentemente dal percorso -- opera sotto gli stessi
vincoli di sicurezza.

### Tutto Inizia come UNTRUSTED

I nuovi server MCP, plugin, canali e fonti webhook hanno tutti lo stato
predefinito `UNTRUSTED`. Non possono scambiare dati con l'agent finché non
vengono esplicitamente classificati dal proprietario (livello personale) o
dall'amministratore (livello enterprise).

```
UNTRUSTED  -->  CLASSIFIED  (dopo la revisione, assegnato un livello di classificazione)
UNTRUSTED  -->  BLOCKED     (esplicitamente proibito)
```

### La Classificazione Fluisce Attraverso

Quando un'integrazione restituisce dati, quei dati portano un livello di
classificazione. L'accesso a dati classificati fa aumentare il taint della
sessione per corrispondere. Una volta contaminata, la sessione non può inviare
output a una destinazione con classificazione inferiore. Questa è la
[Regola No Write-Down](/it-IT/security/no-write-down) -- è fissa e non può
essere sovrascritta.

### Gli Hook di Policy Applicano le Regole a Ogni Confine

Tutte le azioni delle integrazioni passano attraverso hook di policy
deterministici:

| Hook                    | Quando Si Attiva                                                             |
| ----------------------- | ---------------------------------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Dati esterni entrano nel contesto dell'agent (webhook, risposte dei plugin)  |
| `PRE_TOOL_CALL`         | L'agent richiede una chiamata a un tool (MCP, exec, browser)                 |
| `POST_TOOL_RESPONSE`    | Il tool restituisce dati (classifica la risposta, aggiorna il taint)         |
| `PRE_OUTPUT`            | La risposta lascia il sistema (controllo finale di classificazione)          |

Questi hook sono funzioni pure -- nessuna chiamata al LLM, nessuna casualità,
nessun bypass. Lo stesso input produce sempre la stessa decisione.

### Traccia di Audit

Ogni azione delle integrazioni viene registrata: cosa è stato chiamato, chi lo
ha chiamato, quale è stata la decisione di policy e come è cambiato il taint
della sessione. Questa traccia di audit è immutabile e disponibile per la
revisione di conformità.

::: warning SICUREZZA Il LLM non può aggirare, modificare o influenzare le
decisioni degli hook di policy. Gli hook vengono eseguiti nel codice sotto il
livello del LLM. L'AI richiede azioni -- il livello delle policy decide. :::

## Scegliere il Percorso Giusto

Utilizzare questa guida decisionale per scegliere il percorso di integrazione
adatto al proprio caso d'uso:

- **Si vuole connettere un server di tool standard** -- Utilizzare il
  [MCP Gateway](./mcp-gateway). Se un tool parla MCP, questo è il percorso.
- **Si ha bisogno di eseguire codice personalizzato su un'API esterna** --
  Utilizzare l'[SDK dei Plugin](./plugins).
- **Si vuole che l'agent costruisca e iteri sul codice** -- Utilizzare
  l'[Ambiente di Esecuzione](./exec-environment). L'agent ottiene uno spazio
  di lavoro con un ciclo completo di scrittura/esecuzione/correzione.
- **Si vuole insegnare all'agent un nuovo comportamento** -- Utilizzare le
  [Skill](./skills). Scrivere un `SKILL.md` con le istruzioni, o lasciare che
  l'agent ne crei uno.
- **Si ha bisogno di automatizzare interazioni web** -- Utilizzare
  l'[Automazione del Browser](./browser). Chromium controllato via CDP con
  applicazione delle policy sui domini.
- **Si ha bisogno di reagire a eventi esterni in tempo reale** -- Utilizzare i
  [Webhook](./webhooks). Eventi in ingresso verificati, classificati e
  instradati all'agent.

::: tip Questi percorsi non si escludono a vicenda. Una skill potrebbe utilizzare
internamente l'automazione del browser. Un plugin potrebbe essere attivato da un
webhook. Un'integrazione creata dall'agent nell'ambiente di esecuzione può essere
salvata come skill. Si compongono in modo naturale. :::
