# Piattaforma delle Skill

Le skill sono il meccanismo primario di estensibilità di Triggerfish. Una skill
è una cartella contenente un file `SKILL.md` -- istruzioni e metadati che danno
all'agent nuove capacità senza richiedere la scrittura di un plugin o la
costruzione di codice personalizzato.

Le skill sono il modo in cui l'agent impara a fare cose nuove: controllare il
calendario, preparare briefing mattutini, fare triage delle issue GitHub,
redigere riepiloghi settimanali. Possono essere installate da un marketplace,
scritte a mano o create dall'agent stesso.

## Cos'È una Skill?

Una skill è una cartella con un file `SKILL.md` alla sua radice. Il file
contiene frontmatter YAML (metadati) e corpo markdown (istruzioni per l'agent).
File di supporto opzionali -- script, template, configurazioni -- possono
risiedere accanto ad esso.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Codice di supporto opzionale
  template.md        # Template opzionale
```

Il frontmatter di `SKILL.md` dichiara cosa fa la skill, di cosa ha bisogno e
quali vincoli di sicurezza si applicano:

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Istruzioni

Quando attivata (quotidianamente alle 7:00) o invocata dall'utente:

1. Recuperare gli eventi del calendario di oggi da Google Calendar
2. Riassumere le email non lette delle ultime 12 ore
3. Ottenere le previsioni meteo per la posizione dell'utente
4. Compilare un briefing conciso e consegnarlo al canale configurato

Formattare il briefing con sezioni per Calendario, Email e Meteo.
Mantenerlo scannerizzabile -- elenchi puntati, non paragrafi.
```

### Campi del Frontmatter

| Campo                                         | Obbligatorio | Descrizione                                                             |
| --------------------------------------------- | :----------: | ----------------------------------------------------------------------- |
| `name`                                        |      Sì      | Identificatore univoco della skill                                      |
| `description`                                 |      Sì      | Descrizione leggibile di ciò che fa la skill                            |
| `version`                                     |      Sì      | Versione semantica                                                      |
| `category`                                    |      No      | Categoria di raggruppamento (productivity, development, communication, ecc.) |
| `tags`                                        |      No      | Tag ricercabili per la scoperta                                         |
| `triggers`                                    |      No      | Regole di invocazione automatica (schedule cron, pattern di eventi)     |
| `metadata.triggerfish.classification_ceiling` |      No      | Livello massimo di taint raggiungibile dalla skill (predefinito: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         |      No      | Tool di cui la skill necessita (browser, exec, ecc.)                    |
| `metadata.triggerfish.network_domains`        |      No      | Endpoint di rete consentiti per la skill                                |

## Tipi di Skill

Triggerfish supporta tre tipi di skill, con un ordine di priorità chiaro quando
i nomi sono in conflitto.

### Skill Integrate

Distribuite con Triggerfish nella directory `skills/bundled/`. Mantenute dal
progetto. Sempre disponibili.

Triggerfish include dieci skill integrate che rendono l'agent autosufficiente
dal primo giorno:

| Skill                     | Descrizione                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **tdd**                   | Metodologia Test-Driven Development per Deno 2.x. Ciclo red-green-refactor, pattern `Deno.test()`, utilizzo di `@std/assert`, test dei tipi Result, helper per i test.   |
| **mastering-typescript**  | Pattern TypeScript per Deno e Triggerfish. Modalità strict, `Result<T, E>`, tipi branded, funzioni factory, interfacce immutabili, barrel `mod.ts`.                      |
| **skill-builder**         | Come creare nuove skill. Formato SKILL.md, campi del frontmatter, limiti di classificazione, flusso di auto-creazione, scansione di sicurezza.                           |
| **integration-builder**   | Come costruire integrazioni Triggerfish. Tutti e sei i pattern: adattatori di canale, provider LLM, server MCP, provider di storage, tool exec e plugin.                 |
| **git-branch-management** | Flusso di lavoro Git branch per lo sviluppo. Feature branch, commit atomici, creazione PR tramite `gh` CLI, tracciamento PR, ciclo di feedback review via webhook, merge e pulizia. |
| **deep-research**         | Metodologia di ricerca multi-step. Valutazione delle fonti, ricerche parallele, sintesi e formattazione delle citazioni.                                                 |
| **pdf**                   | Elaborazione documenti PDF. Estrazione testo, riassunto ed estrazione dati strutturati da file PDF.                                                                      |
| **triggerfish**           | Auto-conoscenza degli interni di Triggerfish. Architettura, configurazione, risoluzione problemi e pattern di sviluppo.                                                  |
| **triggers**              | Creazione di comportamenti proattivi. Scrittura di file TRIGGER.md efficaci, pattern di monitoraggio e regole di escalazione.                                            |

Queste sono le skill bootstrap -- l'agent le usa per estendere se stesso. La
skill-builder insegna all'agent come creare nuove skill, e la
integration-builder gli insegna come costruire nuovi adattatori e provider.

Consultare [Costruire Skill](/it-IT/integrations/building-skills) per una guida
pratica alla creazione delle proprie.

### Skill Gestite

Installate da **The Reef** (il marketplace comunitario delle skill). Scaricate
e archiviate in `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Skill dello Spazio di Lavoro

Create dall'utente o create dall'agent
nell'[ambiente di esecuzione](./exec-environment). Archiviate nello spazio di
lavoro dell'agent in `~/.triggerfish/workspace/<agent-id>/skills/`.

Le skill dello spazio di lavoro hanno la priorità più alta. Se si crea una
skill con lo stesso nome di una skill integrata o gestita, la propria versione
ha la precedenza.

```
Priorità:  Spazio di Lavoro  >  Gestite  >  Integrate
```

::: tip Questo ordine di priorità significa che è sempre possibile sovrascrivere
una skill integrata o del marketplace con la propria versione. Le proprie
personalizzazioni non vengono mai sovrascritte dagli aggiornamenti. :::

## Scoperta e Caricamento delle Skill

Quando l'agent si avvia o quando le skill cambiano, Triggerfish esegue un
processo di scoperta delle skill:

1. **Scanner** -- Trova tutte le skill installate nelle directory integrate,
   gestite e dello spazio di lavoro
2. **Loader** -- Legge il frontmatter di SKILL.md e valida i metadati
3. **Resolver** -- Risolve i conflitti di nome usando l'ordine di priorità
4. **Registrazione** -- Rende le skill disponibili all'agent con le loro
   capacità e vincoli dichiarati

Le skill con `triggers` nel loro frontmatter vengono automaticamente collegate
allo scheduler. Le skill con `requires_tools` vengono verificate rispetto ai
tool disponibili dell'agent -- se un tool richiesto non è disponibile, la
skill viene segnalata ma non bloccata.

## Auto-Creazione dell'Agent

Un differenziatore chiave: l'agent può scrivere le proprie skill. Quando gli
viene chiesto di fare qualcosa che non sa fare, l'agent può usare
l'[ambiente di esecuzione](./exec-environment) per creare un `SKILL.md` e
codice di supporto, poi pacchettizzarlo come skill dello spazio di lavoro.

### Flusso di Auto-Creazione

```
1. Utente: "Ho bisogno che controlli il mio Notion per nuove attività ogni mattina"
2. Agent:  Crea la skill in ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
           Scrive SKILL.md con metadati e istruzioni
           Scrive codice di supporto (notion-tasks.ts)
           Testa il codice nell'ambiente di esecuzione
3. Agent:  Marca la skill come PENDING_APPROVAL
4. Utente: Riceve notifica: "Nuova skill creata: notion-tasks. Revisionare e approvare?"
5. Utente: Approva la skill
6. Agent:  Collega la skill a un cron job per l'esecuzione quotidiana
```

::: warning SICUREZZA Le skill create dall'agent richiedono sempre l'approvazione
del proprietario prima di diventare attive. L'agent non può auto-approvare le
proprie skill. Questo impedisce all'agent di creare capacità che aggirano il
proprio controllo. :::

### Controlli Enterprise

Nelle distribuzioni enterprise, controlli aggiuntivi si applicano alle skill
auto-create:

- Le skill create dall'agent richiedono sempre l'approvazione del proprietario
  o dell'amministratore
- Le skill non possono dichiarare un limite di classificazione superiore
  all'abilitazione dell'utente
- Le dichiarazioni degli endpoint di rete vengono sottoposte ad audit
- Tutte le skill auto-create vengono registrate per la revisione di conformità

## The Reef <ComingSoon :inline="true" />

The Reef è il marketplace comunitario delle skill di Triggerfish -- un registro
dove è possibile scoprire, installare, pubblicare e condividere skill.

| Funzionalità           | Descrizione                                                  |
| ---------------------- | ------------------------------------------------------------ |
| Ricerca e navigazione  | Trovare skill per categoria, tag o popolarità                |
| Installazione rapida   | `triggerfish skill install <name>`                           |
| Pubblicazione          | Condividere le proprie skill con la comunità                 |
| Scansione di sicurezza | Scansione automatica per pattern malevoli prima della pubblicazione |
| Versionamento          | Le skill sono versionate con gestione degli aggiornamenti    |
| Recensioni e valutazioni | Feedback della comunità sulla qualità delle skill          |

### Comandi CLI

```bash
# Cercare skill
triggerfish skill search "calendar"

# Installare una skill da The Reef
triggerfish skill install google-cal

# Elencare le skill installate
triggerfish skill list

# Aggiornare tutte le skill gestite
triggerfish skill update --all

# Pubblicare una skill su The Reef
triggerfish skill publish

# Rimuovere una skill
triggerfish skill remove google-cal
```

### Sicurezza

Le skill installate da The Reef seguono lo stesso ciclo di vita di qualsiasi
altra integrazione:

1. Scaricate nella directory delle skill gestite
2. Scansionate per pattern malevoli (code injection, accesso di rete non
   autorizzato, ecc.)
3. Entrano nello stato `UNTRUSTED` fino alla classificazione
4. Classificate e attivate dal proprietario o dall'amministratore

::: info The Reef scansiona tutte le skill pubblicate per pattern malevoli noti
prima che vengano elencate. Tuttavia, è comunque consigliabile revisionare le
skill prima di classificarle, specialmente quelle che dichiarano accesso di rete
o richiedono tool potenti come `exec` o `browser`. :::

## Riepilogo della Sicurezza delle Skill

- Le skill dichiarano i propri requisiti di sicurezza in anticipo (limite di
  classificazione, tool, domini di rete)
- L'accesso ai tool è controllato dalle policy -- una skill che
  `requires_tools: [browser]` non funzionerà se l'accesso al browser è bloccato
  dalle policy
- I domini di rete sono applicati -- una skill non può accedere a endpoint che
  non ha dichiarato
- Le skill create dall'agent richiedono l'approvazione esplicita del
  proprietario/amministratore
- Tutte le invocazioni delle skill passano attraverso gli hook di policy e sono
  completamente soggette ad audit
