# Progettazione Security-First

Triggerfish si basa su un unico presupposto: **il LLM ha zero autorità**. Richiede
azioni; il livello delle policy decide. Ogni decisione di sicurezza è presa da
codice deterministico che l'AI non può aggirare, sovrascrivere o influenzare.

Questa pagina spiega perché Triggerfish adotta questo approccio, come si differenzia
dalle piattaforme AI agent tradizionali e dove trovare i dettagli su ogni componente
del modello di sicurezza.

## Perché la Sicurezza Deve Essere Sotto il LLM

I modelli linguistici di grandi dimensioni possono subire prompt injection. Un input
elaborato con cura -- proveniente da un messaggio esterno malevolo, un documento
compromesso o una risposta di tool manipolata -- può indurre un LLM a ignorare le
proprie istruzioni e compiere azioni che gli era stato detto di non compiere. Non si
tratta di un rischio teorico. È un problema ben documentato e irrisolto nel settore
dell'AI.

Se il vostro modello di sicurezza dipende dal fatto che il LLM segua le regole, una
singola injection riuscita può aggirare tutte le protezioni costruite.

Triggerfish risolve questo problema spostando tutta l'applicazione della sicurezza a
un livello di codice che si trova **sotto** il LLM. L'AI non vede mai le decisioni
di sicurezza. Non valuta mai se un'azione debba essere consentita. Semplicemente
richiede azioni, e il livello di applicazione delle policy -- eseguito come codice
puro e deterministico -- decide se tali azioni procedono.

<img src="/diagrams/enforcement-layers.svg" alt="Livelli di applicazione: il LLM ha zero autorità, il livello delle policy prende tutte le decisioni in modo deterministico, solo le azioni consentite raggiungono l'esecuzione" style="max-width: 100%;" />

::: warning SICUREZZA Il livello LLM non ha alcun meccanismo per sovrascrivere,
saltare o influenzare il livello di applicazione delle policy. Non esiste alcuna
logica di "analisi dell'output del LLM per comandi di bypass". La separazione è
architetturale, non comportamentale. :::

## L'Invariante Fondamentale

Ogni decisione di progettazione in Triggerfish discende da un'invariante:

> **Lo stesso input produce sempre la stessa decisione di sicurezza. Nessuna
> casualità, nessuna chiamata al LLM, nessuna discrezionalità.**

Ciò significa che il comportamento di sicurezza è:

- **Verificabile** -- è possibile riprodurre qualsiasi decisione e ottenere lo stesso risultato
- **Testabile** -- il codice deterministico può essere coperto da test automatizzati
- **Ispezionabile** -- il motore delle policy è open source (licenza Apache 2.0) e
  chiunque può esaminarlo

## Principi di Sicurezza

| Principio               | Significato                                                                                                                                             | Pagina di Dettaglio                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Classificazione dei Dati** | Tutti i dati portano un livello di sensibilità (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). La classificazione è assegnata dal codice quando i dati entrano nel sistema. | [Architettura: Classificazione](/it-IT/architecture/classification) |
| **No Write-Down**       | I dati possono fluire solo verso canali e destinatari con un livello di classificazione uguale o superiore. I dati CONFIDENTIAL non possono raggiungere un canale PUBLIC. Senza eccezioni. | [Regola No Write-Down](/it-IT/security/no-write-down)                        |
| **Taint di Sessione**   | Quando una sessione accede a dati con un certo livello di classificazione, l'intera sessione viene contaminata (tainted) a quel livello. Il taint può solo aumentare, mai diminuire. | [Architettura: Taint](/it-IT/architecture/taint-and-sessions)      |
| **Hook Deterministici** | Otto hook di applicazione vengono eseguiti nei punti critici di ogni flusso dati. Ogni hook è sincrono, registrato nei log e non falsificabile. | [Architettura: Motore Policy](/it-IT/architecture/policy-engine)   |
| **Identità nel Codice** | L'identità dell'utente è determinata dal codice all'avvio della sessione, non dal LLM che interpreta il contenuto del messaggio. | [Identità e Autenticazione](/it-IT/security/identity)                                |
| **Delega tra Agent**    | Le chiamate agent-to-agent sono governate da certificati crittografici, limiti massimi di classificazione e limiti di profondità. | [Delega tra Agent](/it-IT/security/agent-delegation)                       |
| **Isolamento dei Secret** | Le credenziali sono archiviate nei portachiavi del sistema operativo o in vault, mai nei file di configurazione. I plugin non possono accedere alle credenziali di sistema. | [Gestione dei Secret](/it-IT/security/secrets)                              |
| **Audit Completo**      | Ogni decisione di policy è registrata con contesto completo: timestamp, tipo di hook, ID sessione, input, risultato e regole valutate. | [Audit e Conformità](/it-IT/security/audit-logging)                        |

## Agent AI Tradizionali vs. Triggerfish

La maggior parte delle piattaforme AI agent si affida al LLM per applicare la
sicurezza. Il system prompt dice "non condividere dati sensibili" e si confida che
l'agent rispetti questa regola. Questo approccio presenta debolezze fondamentali.

| Aspetto                        | Agent AI Tradizionale                  | Triggerfish                                                     |
| ------------------------------ | ------------------------------------- | --------------------------------------------------------------- |
| **Applicazione della sicurezza** | Istruzioni nel system prompt al LLM | Codice deterministico sotto il LLM                                |
| **Difesa da prompt injection** | Sperare che il LLM resista            | Il LLM non ha alcuna autorità in partenza                       |
| **Controllo del flusso dati**  | Il LLM decide cosa è sicuro condividere | Etichette di classificazione + regola no-write-down nel codice |
| **Verifica dell'identità**     | Il LLM interpreta "Sono l'amministratore" | Il codice verifica l'identità crittografica del canale        |
| **Traccia di audit**           | Log delle conversazioni del LLM        | Log strutturati delle decisioni di policy con contesto completo |
| **Accesso alle credenziali**   | Account di servizio di sistema per tutti gli utenti | Credenziali utente delegate; permessi del sistema sorgente ereditati |
| **Testabilità**                | Imprecisa -- dipende dalla formulazione del prompt | Deterministica -- stesso input, stessa decisione, ogni volta |
| **Aperta alla verifica**       | Solitamente proprietaria               | Licenza Apache 2.0, completamente verificabile                  |

::: tip Triggerfish non afferma che i LLM siano inaffidabili. Afferma che i LLM
sono il livello sbagliato per l'applicazione della sicurezza. Un LLM ben configurato
seguirà le proprie istruzioni la maggior parte delle volte. Ma "la maggior parte
delle volte" non è una garanzia di sicurezza. Triggerfish fornisce una garanzia: il
livello delle policy è codice, e il codice fa ciò che gli viene detto, ogni volta. :::

## Difesa in Profondità

Triggerfish implementa tredici livelli di difesa. Nessun singolo livello è
sufficiente da solo; insieme, formano un confine di sicurezza:

1. **Autenticazione del canale** -- identità verificata dal codice all'avvio della sessione
2. **Accesso ai dati con consapevolezza dei permessi** -- permessi del sistema sorgente, non credenziali di sistema
3. **Tracciamento del taint di sessione** -- automatico, obbligatorio, solo in escalazione
4. **Lineage dei dati** -- catena di provenienza completa per ogni elemento dati
5. **Hook di applicazione delle policy** -- deterministici, non aggirabili, registrati nei log
6. **MCP Gateway** -- accesso sicuro a tool esterni con permessi per singolo tool
7. **[Sandbox per plugin](../integrations/plugins)**
8. **Isolamento dei secret** -- portachiavi del SO o vault, mai file di configurazione
9. **Sandbox per tool filesystem** -- confinamento del percorso, classificazione del percorso, permessi I/O del SO basati sul taint
10. **Identità dell'agent** -- catene di delega crittografiche
11. **Registrazione di audit** -- tutte le decisioni registrate, senza eccezioni
12. **Prevenzione SSRF** -- denylist di IP + controlli di risoluzione DNS su tutti gli HTTP in uscita
13. **Gating della classificazione della memoria** -- scritture forzate al livello di taint della sessione, letture filtrate da `canFlowTo`

## Passi Successivi

| Pagina                                                | Descrizione                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Guida alla Classificazione](/it-IT/guide/classification-guide) | Guida pratica per scegliere il livello giusto per canali, server MCP e integrazioni |
| [Regola No Write-Down](/it-IT/security/no-write-down)               | La regola fondamentale sul flusso dei dati e come viene applicata                   |
| [Identità e Autenticazione](/it-IT/security/identity)                       | Autenticazione del canale e verifica dell'identità del proprietario                  |
| [Delega tra Agent](/it-IT/security/agent-delegation)              | Identità agent-to-agent, certificati e catene di delega                            |
| [Gestione dei Secret](/it-IT/security/secrets)                     | Come Triggerfish gestisce le credenziali tra i diversi livelli                        |
| [Audit e Conformità](/it-IT/security/audit-logging)               | Struttura della traccia di audit, tracciamento e esportazioni per la conformità      |
