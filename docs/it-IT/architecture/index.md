# Panoramica dell'Architettura

Triggerfish è una piattaforma di agenti IA sicura e multicanale con un unico
invariante fondamentale:

::: warning SICUREZZA **La sicurezza è deterministica e sub-LLM.** Ogni
decisione di sicurezza è presa da puro codice che l'LLM non può aggirare,
sovrascrivere o influenzare. L'LLM ha zero autorità -- richiede azioni; il
livello di policy decide. :::

Questa pagina fornisce il quadro generale di come funziona Triggerfish. Ogni
componente principale rimanda a una pagina di approfondimento dedicata.

## Architettura del Sistema

<img src="/diagrams/system-architecture.svg" alt="Architettura del sistema: i canali fluiscono attraverso il Channel Router verso il Gateway, che coordina Session Manager, Policy Engine e Agent Loop" style="max-width: 100%;" />

### Flusso dei Dati

Ogni messaggio segue questo percorso attraverso il sistema:

<img src="/diagrams/data-flow-9-steps.svg" alt="Flusso dei dati: pipeline a 9 passaggi dal messaggio in entrata attraverso gli Hook di policy fino alla consegna in uscita" style="max-width: 100%;" />

In ogni punto di applicazione, la decisione è deterministica -- lo stesso input
produce sempre lo stesso risultato. Non ci sono chiamate LLM all'interno degli
Hook, nessuna casualità e nessun modo per l'LLM di influenzare il risultato.

## Componenti Principali

### Sistema di Classificazione

I dati fluiscono attraverso quattro livelli ordinati:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. La regola fondamentale è **no
write-down**: i dati possono fluire solo verso una classificazione uguale o
superiore. Una sessione `CONFIDENTIAL` non può inviare dati a un canale
`PUBLIC`. Nessuna eccezione. Nessun override LLM.

[Scopra di più sul Sistema di Classificazione.](./classification)

### Motore di Policy e Hook

Otto Hook di applicazione deterministici intercettano ogni azione nei punti
critici del flusso dei dati. Gli Hook sono funzioni pure: sincroni, registrati e
infalsificabili. Il motore di policy supporta regole fisse (mai configurabili),
regole regolabili dall'amministratore e escape hatch dichiarativi in YAML per
l'enterprise.

[Scopra di più sul Motore di Policy.](./policy-engine)

### Sessioni e Taint

Ogni conversazione è una sessione con tracciamento indipendente del taint.
Quando una sessione accede a dati classificati, il suo taint si escala a quel
livello e non può mai diminuire all'interno della sessione. Un reset completo
cancella il taint E la cronologia della conversazione. Ogni elemento di dati
porta metadati di provenienza attraverso un sistema di tracciamento della
lineage.

[Scopra di più su Sessioni e Taint.](./taint-and-sessions)

### Gateway

Il Gateway è il piano di controllo centrale -- un servizio locale a lunga
esecuzione che gestisce sessioni, canali, strumenti, eventi e processi agente
attraverso un endpoint WebSocket JSON-RPC. Coordina il servizio di
notifiche, lo scheduler cron, l'ingestione dei webhook e il routing dei canali.

[Scopra di più sul Gateway.](./gateway)

### Storage

Tutti i dati con stato fluiscono attraverso un'astrazione unificata
`StorageProvider`. Chiavi con namespace (`sessions:`, `taint:`, `lineage:`,
`audit:`) mantengono le responsabilità separate consentendo al contempo lo
scambio dei backend senza toccare la logica di business. Il default è SQLite WAL
in `~/.triggerfish/data/triggerfish.db`.

[Scopra di più sullo Storage.](./storage)

### Difesa in Profondità

La sicurezza è stratificata attraverso 13 meccanismi indipendenti, dall'autenticazione
del canale e l'accesso ai dati con consapevolezza dei permessi, attraverso il
taint di sessione, gli Hook di policy, il sandboxing dei plugin, il sandboxing
degli strumenti filesystem e l'audit logging. Nessun singolo livello è sufficiente
da solo; insieme formano una difesa che degrada in modo controllato anche se un
livello viene compromesso.

[Scopra di più sulla Difesa in Profondità.](./defense-in-depth)

## Principi di Progettazione

| Principio                          | Cosa significa                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Applicazione deterministica**    | Gli Hook di policy usano funzioni pure. Nessuna chiamata LLM, nessuna casualità. Lo stesso input produce sempre la stessa decisione. |
| **Propagazione del taint**         | Tutti i dati portano metadati di classificazione. Il taint di sessione può solo escalare, mai diminuire.                          |
| **No write-down**                  | I dati non possono fluire verso un livello di classificazione inferiore. Mai.                                                     |
| **Audit di tutto**                 | Tutte le decisioni di policy registrate con contesto completo: timestamp, tipo di hook, ID sessione, input, risultato, regole valutate. |
| **Hook infalsificabili**           | L'LLM non può aggirare, modificare o influenzare le decisioni degli Hook di policy. Gli Hook vengono eseguiti nel codice sotto il livello LLM. |
| **Isolamento delle sessioni**      | Ogni sessione traccia il taint in modo indipendente. Le sessioni in background partono con taint PUBLIC fresco. I workspace degli agenti sono completamente isolati. |
| **Astrazione dello storage**       | Nessun modulo crea il proprio storage. Tutta la persistenza fluisce attraverso `StorageProvider`.                                 |

## Stack Tecnologico

| Componente             | Tecnologia                                                                |
| ---------------------- | ------------------------------------------------------------------------- |
| Runtime                | Deno 2.x (TypeScript strict mode)                                         |
| Testing                | Runner di test integrato in Deno                                          |
| Canali                 | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Automazione browser    | puppeteer-core (CDP)                                                      |
| Voce                   | Whisper (STT locale), ElevenLabs/OpenAI (TTS)                             |
| Storage                | SQLite WAL (default), backend enterprise (Postgres, S3)                   |
| Secret                 | Portachiavi OS (personale), integrazione vault (enterprise)               |

::: info Triggerfish non richiede strumenti di build esterni, Docker, o
dipendenze cloud. Viene eseguito localmente, elabora i dati localmente e dà
all'utente piena sovranità sui propri dati. :::
