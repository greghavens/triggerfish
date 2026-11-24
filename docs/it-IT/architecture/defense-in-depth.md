# Difesa in Profondità

Triggerfish implementa la sicurezza come 13 livelli indipendenti e sovrapposti.
Nessun singolo livello è sufficiente da solo. Insieme, formano una difesa che
degrada in modo controllato -- anche se un livello viene compromesso, i livelli
rimanenti continuano a proteggere il sistema.

::: warning SICUREZZA Difesa in profondità significa che una vulnerabilità in
qualsiasi singolo livello non compromette il sistema. Un attaccante che aggira
l'autenticazione del canale si trova comunque di fronte al tracciamento del
taint di sessione, agli Hook di policy e all'audit logging. Un LLM che subisce
un prompt injection non può comunque influenzare il livello di policy
deterministico sottostante. :::

## I 13 Livelli

### Livello 1: Autenticazione del Canale

**Protegge contro:** impersonazione, accesso non autorizzato, confusione di identità.

L'identità è determinata dal **codice al momento dell'instaurazione della
sessione**, non dall'LLM che interpreta il contenuto del messaggio. Prima che
l'LLM veda qualsiasi messaggio, l'adattatore del canale lo etichetta con
un'etichetta immutabile:

```
{ source: "owner" }    -- l'identità verificata del canale corrisponde al proprietario registrato
{ source: "external" } -- chiunque altro; solo input, non trattato come comando
```

I metodi di autenticazione variano per canale:

| Canale                  | Metodo            | Verifica                                                               |
| ----------------------- | ----------------- | ---------------------------------------------------------------------- |
| Telegram / WhatsApp     | Codice di accoppiamento | Codice monouso, scadenza 5 minuti, inviato dall'account dell'utente |
| Slack / Discord / Teams | OAuth             | Flusso di consenso OAuth della piattaforma, restituisce ID utente verificato |
| CLI                     | Processo locale   | In esecuzione sulla macchina dell'utente, autenticato dal SO           |
| WebChat                 | Nessuno (pubblico)| Tutti i visitatori sono `EXTERNAL`, mai `owner`                        |
| Email                   | Corrispondenza dominio | Dominio del mittente confrontato con domini interni configurati    |

::: info L'LLM non decide mai chi è il proprietario. Un messaggio che dice
"Sono il proprietario" da un mittente non verificato viene etichettato
`{ source: "external" }` e non può attivare comandi a livello proprietario.
Questa decisione è presa nel codice, prima che l'LLM elabori il messaggio. :::

### Livello 2: Accesso ai Dati Consapevole dei Permessi

**Protegge contro:** accesso ai dati con permessi eccessivi, escalation dei
privilegi attraverso credenziali di sistema.

Triggerfish utilizza i token OAuth delegati dell'utente -- non account di servizio
di sistema -- per interrogare i sistemi esterni. Il sistema sorgente applica il
proprio modello di permessi:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradizionale vs Triggerfish: il modello tradizionale dà all'LLM il controllo diretto, Triggerfish instrada tutte le azioni attraverso un livello di policy deterministico" style="max-width: 100%;" />

Il Plugin SDK lo applica a livello di API:

| Metodo SDK                                      | Comportamento                              |
| ----------------------------------------------- | ------------------------------------------ |
| `sdk.get_user_credential(integration)`          | Restituisce il token OAuth delegato dell'utente |
| `sdk.query_as_user(integration, query)`         | Esegue con i permessi dell'utente          |
| `sdk.get_system_credential(name)`               | **BLOCCATO** -- genera `PermissionError`   |

### Livello 3: Tracciamento del Taint di Sessione

**Protegge contro:** fuga di dati attraverso contaminazione del contesto, dati
classificati che raggiungono canali a classificazione inferiore.

Ogni sessione traccia indipendentemente un livello di taint che riflette la
classificazione più alta dei dati acceduti durante la sessione. Il taint segue
tre invarianti:

1. **Per-conversazione** -- ogni sessione ha il proprio taint
2. **Solo escalation** -- il taint aumenta, non diminuisce mai
3. **Il reset completo cancella tutto** -- taint E cronologia vengono cancellati insieme

Quando il motore di policy valuta un output, confronta il taint della sessione
con la classificazione effettiva del canale di destinazione. Se il taint supera
il target, l'output viene bloccato.

### Livello 4: Lineage dei Dati

**Protegge contro:** flussi di dati non tracciabili, impossibilità di verificare
dove sono andati i dati, lacune di conformità.

Ogni elemento di dati porta metadati di provenienza dall'origine alla
destinazione:

- **Origine**: quale integrazione, record e accesso utente ha prodotto questi dati
- **Classificazione**: quale livello è stato assegnato e perché
- **Trasformazioni**: come l'LLM ha modificato, riassunto o combinato i dati
- **Destinazione**: quale sessione e canale ha ricevuto l'output

La lineage abilita tracce in avanti ("dove è andato questo record Salesforce?"),
tracce all'indietro ("quali fonti hanno contribuito a questo output?") e
esportazioni complete di conformità.

### Livello 5: Hook di Applicazione delle Policy

**Protegge contro:** attacchi di prompt injection, bypass della sicurezza guidati dall'LLM, esecuzione incontrollata degli strumenti.

Otto Hook deterministici intercettano ogni azione nei punti critici del flusso
dei dati:

| Hook                    | Cosa intercetta                                    |
| ----------------------- | -------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Input esterno che entra nella finestra di contesto  |
| `PRE_TOOL_CALL`         | LLM che richiede l'esecuzione di strumenti         |
| `POST_TOOL_RESPONSE`    | Dati che ritornano dall'esecuzione degli strumenti  |
| `PRE_OUTPUT`            | Risposta che sta per lasciare il sistema            |
| `SECRET_ACCESS`         | Richiesta di accesso a credenziali                  |
| `SESSION_RESET`         | Richiesta di reset del taint                        |
| `AGENT_INVOCATION`      | Chiamata da agente a agente                         |
| `MCP_TOOL_CALL`         | Invocazione di strumenti del server MCP             |

Gli Hook sono puro codice: deterministici, sincroni, registrati e infalsificabili.
L'LLM non può aggirarli perché non esiste un percorso dall'output dell'LLM alla
configurazione degli Hook. Il livello degli Hook non analizza l'output dell'LLM
alla ricerca di comandi.

### Livello 6: Gateway MCP

**Protegge contro:** accesso incontrollato a strumenti esterni, dati non
classificati che entrano attraverso server MCP, violazioni di schema.

Tutti i server MCP sono predefiniti come `UNTRUSTED` e non possono essere invocati
finché un amministratore o utente non li classifica. Il Gateway applica:

- Autenticazione del server e stato di classificazione
- Permessi a livello di strumento (singoli strumenti possono essere bloccati anche se il server è consentito)
- Validazione dello schema richiesta/risposta
- Tracciamento del taint su tutte le risposte MCP
- Scansione di pattern di injection nei parametri

<img src="/diagrams/mcp-server-states.svg" alt="Stati dei server MCP: UNTRUSTED (default), CLASSIFIED (esaminato e consentito), BLOCKED (esplicitamente proibito)" style="max-width: 100%;" />

### Livello 7: Sandbox dei Plugin

Abilita il plugin TypeScript nella configurazione utente con `enabled: true`. Per impostazione predefinita, importazione ed esecuzione avvengono in worker Deno con permessi limitati. Possono leggere la directory del plugin e connettersi solo agli host e alle porte in `declaredEndpoints`. Scrittura, ambiente del processo, sottoprocessi, FFI e informazioni di sistema riservate sono bloccati. `trust: trusted` consente l’importazione nel processo Triggerfish. L’esecutore vi gira se anche il manifesto dichiara `trusted`.

[Guida completa ai plugin](../integrations/plugins)

### Livello 8: Isolamento dei Secret

**Protegge contro:** furto di credenziali, secret nei file di configurazione,
archiviazione di credenziali in chiaro.

Le credenziali sono archiviate nel portachiavi del sistema operativo (livello
personale) o nell'integrazione vault (livello enterprise). Non appaiono mai in:

- File di configurazione
- Valori del `StorageProvider`
- Voci di log
- Contesto dell'LLM (le credenziali vengono iniettate a livello HTTP, sotto l'LLM)

L'Hook `SECRET_ACCESS` registra ogni accesso alle credenziali con il plugin
richiedente, l'ambito della credenziale e la decisione.

### Livello 9: Sandbox degli Strumenti Filesystem

**Protegge contro:** attacchi path traversal, accesso non autorizzato ai file,
bypass della classificazione tramite operazioni dirette sul filesystem.

Tutte le operazioni degli strumenti filesystem (lettura, scrittura, modifica,
elenco, ricerca) vengono eseguite all'interno di un Worker Deno sandboxato con
permessi a livello di sistema operativo limitati alla sottodirectory del
workspace appropriata al taint della sessione. La sandbox applica tre confini:

- **Jail del percorso** — ogni percorso viene risolto in un percorso assoluto e
  verificato rispetto alla root del jail con corrispondenza consapevole del
  separatore. I tentativi di traversal (`../`) che escono dal workspace vengono
  rifiutati prima di qualsiasi I/O
- **Classificazione del percorso** — ogni percorso filesystem viene classificato
  attraverso una catena di risoluzione fissa: percorsi protetti hardcoded
  (RESTRICTED), directory di classificazione del workspace, mapping di percorso
  configurati, poi classificazione predefinita. L'agente non può accedere a
  percorsi sopra il taint della sessione
- **Permessi con ambito taint** — i permessi Deno del Worker sandbox sono
  impostati sulla sottodirectory del workspace corrispondente al livello di taint
  corrente della sessione. Quando il taint escala, il Worker viene ricreato con
  permessi espansi. I permessi possono solo ampliarsi, mai restringersi
  all'interno di una sessione
- **Protezione in scrittura** — i file critici (`TRIGGER.md`,
  `triggerfish.yaml`, `SPINE.md`) sono protetti in scrittura a livello di
  strumento indipendentemente dai permessi della sandbox. Questi file possono
  essere modificati solo attraverso strumenti di gestione dedicati che applicano
  le proprie regole di classificazione

### Livello 10: Identità dell'Agente

**Protegge contro:** escalation dei privilegi attraverso catene di agenti,
riciclaggio dei dati tramite delega.

Quando gli agenti invocano altri agenti, catene di delega crittografica
prevengono l'escalation dei privilegi:

- Ogni agente ha un certificato che specifica le sue capacità e il tetto di
  classificazione
- Il chiamato eredita `max(taint_proprio, taint_chiamante)` -- il taint può solo
  aumentare attraverso le catene
- Un chiamante con taint che supera il tetto del chiamato viene bloccato
- Le invocazioni circolari vengono rilevate e rifiutate
- La profondità di delega è limitata e applicata

<img src="/diagrams/data-laundering-defense.svg" alt="Difesa contro il riciclaggio dei dati: il percorso di attacco è bloccato al controllo del tetto e l'ereditarietà del taint impedisce l'output verso canali a classificazione inferiore" style="max-width: 100%;" />

### Livello 11: Audit Logging

**Protegge contro:** violazioni non rilevabili, fallimenti di conformità,
impossibilità di investigare incidenti.

Ogni decisione rilevante per la sicurezza viene registrata con contesto completo:

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "user_id": "user_123",
  "session_id": "sess_456",
  "action": "slack.postMessage",
  "target_channel": "external_webhook",
  "session_taint": "CONFIDENTIAL",
  "target_classification": "PUBLIC",
  "decision": "DENIED",
  "reason": "classification_violation",
  "hook": "PRE_OUTPUT",
  "policy_rules_evaluated": ["rule_001", "rule_002"],
  "lineage_ids": ["lin_789", "lin_790"]
}
```

Cosa viene registrato:

- Tutte le richieste di azione (consentite E negate)
- Decisioni di classificazione
- Cambiamenti del taint di sessione
- Eventi di autenticazione del canale
- Valutazioni delle regole di policy
- Creazione e aggiornamenti dei record di lineage
- Decisioni del Gateway MCP
- Invocazioni da agente a agente

::: info L'audit logging non può essere disabilitato. È una regola fissa nella
gerarchia delle policy. Nemmeno un amministratore dell'organizzazione può
disattivare il logging per le proprie azioni. Le distribuzioni enterprise possono
opzionalmente abilitare il logging completo dei contenuti (incluso il contenuto
dei messaggi bloccati) per requisiti forensi. :::

### Livello 12: Prevenzione SSRF

**Protegge contro:** Server-Side Request Forgery, ricognizione della rete
interna, esfiltrazione dei metadati cloud.

Tutte le richieste HTTP in uscita (da `web_fetch`, `browser.navigate` e accesso
di rete dei plugin) risolvono prima il DNS e verificano l'IP risolto contro una
denylist hardcoded di intervalli privati e riservati. Questo impedisce a un
attaccante di ingannare l'agente affinché acceda a servizi interni tramite URL
costruiti.

- Gli intervalli privati (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) sono
  sempre bloccati
- Link-local (`169.254.0.0/16`) e endpoint dei metadati cloud sono bloccati
- Loopback (`127.0.0.0/8`) è bloccato
- La denylist è hardcoded e non configurabile -- non esiste un override
  amministrativo
- La risoluzione DNS avviene prima della richiesta, prevenendo attacchi di DNS
  rebinding

### Livello 13: Gating della Classificazione della Memoria

**Protegge contro:** fuga di dati cross-sessione attraverso la memoria,
downgrade della classificazione tramite scritture in memoria, accesso non
autorizzato a memorie classificate.

Il sistema di memoria cross-sessione applica la classificazione sia in scrittura
che in lettura:

- **Scritture**: le voci di memoria sono forzate al livello di taint corrente
  della sessione. L'LLM non può scegliere una classificazione inferiore per le
  memorie archiviate.
- **Letture**: le query di memoria sono filtrate da `canFlowTo` -- una sessione
  può leggere solo memorie al suo livello di taint corrente o inferiore.

Questo impedisce a un agente di archiviare dati CONFIDENTIAL come PUBLIC in
memoria e successivamente recuperarli in una sessione con taint inferiore per
aggirare la regola no write-down.

## Gerarchia di Fiducia

Il modello di fiducia definisce chi ha autorità su cosa. I livelli superiori non
possono aggirare le regole di sicurezza dei livelli inferiori, ma possono
configurare i parametri regolabili all'interno di quelle regole.

<img src="/diagrams/trust-hierarchy.svg" alt="Gerarchia di fiducia: fornitore Triggerfish (zero accesso), Amministratore Org (imposta le policy), Dipendente (usa l'agente entro i confini)" style="max-width: 100%;" />

::: tip **Livello personale:** l'utente È l'amministratore dell'organizzazione.
Piena sovranità. Nessuna visibilità per Triggerfish. Il fornitore ha zero accesso
ai dati dell'utente per impostazione predefinita e può ottenere accesso solo
attraverso una concessione esplicita, limitata nel tempo e registrata
dall'utente. :::

## Come i Livelli Lavorano Insieme

Consideri un attacco di prompt injection in cui un messaggio malevolo tenta di
esfiltrare dati:

| Passo | Livello                    | Azione                                                        |
| ----- | -------------------------- | ------------------------------------------------------------- |
| 1     | Autenticazione canale      | Messaggio etichettato `{ source: "external" }` -- non proprietario |
| 2     | PRE_CONTEXT_INJECTION      | Input scansionato per pattern di injection, classificato      |
| 3     | Taint di sessione          | Taint di sessione invariato (nessun dato classificato acceduto) |
| 4     | L'LLM elabora il messaggio | L'LLM potrebbe essere manipolato per richiedere una chiamata strumento |
| 5     | PRE_TOOL_CALL              | Controllo permessi strumento contro regole fonte esterna      |
| 6     | POST_TOOL_RESPONSE         | Dati restituiti classificati, taint aggiornato                |
| 7     | PRE_OUTPUT                 | Classificazione output vs. target verificata                  |
| 8     | Audit logging              | Intera sequenza registrata per revisione                      |

Anche se l'LLM è completamente compromesso al passo 4 e richiede una chiamata
strumento per l'esfiltrazione dei dati, i livelli rimanenti (controlli dei
permessi, tracciamento del taint, classificazione dell'output, audit logging)
continuano ad applicare le policy. Nessun singolo punto di fallimento
compromette il sistema.
