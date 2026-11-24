---
title: Centro di Fiducia
description: Controlli di sicurezza, postura di conformità e trasparenza architetturale per Triggerfish.
---

# Centro di Fiducia

Triggerfish applica la sicurezza in codice deterministico sotto il livello del
LLM -- non in prompt che il modello potrebbe ignorare. Ogni decisione di policy
è presa da codice che non può essere influenzato da prompt injection, ingegneria
sociale o comportamento anomalo del modello. Consultare la pagina completa
[Progettazione Security-First](/it-IT/security/) per la spiegazione tecnica
approfondita.

## Controlli di Sicurezza

Questi controlli sono attivi nella versione corrente. Ciascuno è applicato nel
codice, testato nella CI e verificabile nel repository open source.

| Controllo                              | Stato                            | Descrizione                                                                                                                                                     |
| -------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Applicazione delle Policy Sotto il LLM | <StatusBadge status="active" />  | Otto hook deterministici intercettano ogni azione prima e dopo l'elaborazione del LLM. Il modello non può aggirare, modificare o influenzare le decisioni di sicurezza. |
| Sistema di Classificazione dei Dati    | <StatusBadge status="active" />  | Gerarchia a quattro livelli (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) con applicazione obbligatoria del no write-down.                                        |
| Tracciamento del Taint di Sessione     | <StatusBadge status="active" />  | Ogni sessione traccia la classificazione più alta dei dati acceduti. Il taint può solo aumentare, mai diminuire.                                                 |
| Registrazione di Audit Immutabile      | <StatusBadge status="active" />  | Tutte le decisioni di policy registrate con contesto completo. La registrazione di audit non può essere disabilitata da nessun componente del sistema.            |
| Isolamento dei Secret                  | <StatusBadge status="active" />  | Le credenziali sono archiviate nel portachiavi del SO o nel vault. Mai nei file di configurazione, nello storage, nei log o nel contesto del LLM.                |
| Sandboxing dei Plugin                  | <StatusBadge status="active" />  | [Plugin](../integrations/plugins) |
| Scansione delle Dipendenze             | <StatusBadge status="active" />  | Scansione automatica delle vulnerabilità tramite GitHub Dependabot. PR aperte automaticamente per CVE upstream.                                                  |
| Codebase Open Source                   | <StatusBadge status="active" />  | L'intera architettura di sicurezza è con licenza Apache 2.0 e pubblicamente verificabile.                                                                       |
| Distribuzione On-Premises              | <StatusBadge status="active" />  | Viene eseguito interamente sulla propria infrastruttura. Nessuna dipendenza cloud, nessuna telemetria, nessuna elaborazione dati esterna.                        |
| Crittografia                           | <StatusBadge status="active" />  | TLS per tutti i dati in transito. Crittografia a livello di SO per i dati a riposo. Integrazione con vault enterprise disponibile.                               |
| Programma di Divulgazione Responsabile | <StatusBadge status="active" />  | Processo documentato di segnalazione delle vulnerabilità con tempi di risposta definiti. Vedere la [policy di divulgazione](/it-IT/security/responsible-disclosure). |
| Immagine Container Rafforzata          | <StatusBadge status="planned" /> | Immagini Docker su base Google Distroless con CVE quasi a zero. Scansione automatica Trivy nella CI.                                                             |

## Difesa in Profondità — 13 Livelli Indipendenti

Nessun singolo livello è sufficiente da solo. Se un livello viene compromesso,
i livelli rimanenti continuano a proteggere il sistema.

| Livello | Nome                                | Applicazione                                         |
| ------- | ----------------------------------- | ---------------------------------------------------- |
| 01      | Autenticazione del Canale           | Identità verificata dal codice all'avvio della sessione |
| 02      | Accesso ai Dati Consapevole dei Permessi | Permessi del sistema sorgente, non credenziali di sistema |
| 03      | Tracciamento del Taint di Sessione  | Automatico, obbligatorio, solo in escalazione        |
| 04      | Lineage dei Dati                    | Catena di provenienza completa per ogni elemento dati |
| 05      | Hook di Applicazione delle Policy   | Deterministici, non aggirabili, registrati            |
| 06      | MCP Gateway                         | Permessi per singolo tool, classificazione del server |
| 07      | Sandbox dei Plugin                  | [Plugin](../integrations/plugins) |
| 08      | Isolamento dei Secret               | Portachiavi del SO o vault, sotto il livello del LLM |
| 09      | Sandbox per Tool Filesystem         | Confinamento del percorso, classificazione del percorso, I/O basato sul taint |
| 10      | Identità e Delega degli Agent       | Catene di delega crittografiche                      |
| 11      | Registrazione di Audit              | Non può essere disabilitata                          |
| 12      | Prevenzione SSRF                    | Denylist di IP + controlli di risoluzione DNS        |
| 13      | Gating della Classificazione della Memoria | Scrittura al proprio livello, lettura solo verso il basso |

Consultare la documentazione completa dell'architettura
[Difesa in Profondità](/it-IT/architecture/defense-in-depth).

## Perché l'Applicazione Sotto il LLM È Importante

::: info La maggior parte delle piattaforme AI agent applica la sicurezza
attraverso system prompt -- istruzioni al LLM che dicono "non condividere dati
sensibili." Gli attacchi di prompt injection possono sovrascrivere queste
istruzioni.

Triggerfish adotta un approccio diverso: il LLM ha **zero autorità** sulle
decisioni di sicurezza. Tutta l'applicazione avviene in codice deterministico
sotto il livello del LLM. Non esiste alcun percorso dall'output del LLM alla
configurazione di sicurezza. :::

## Roadmap di Conformità

Triggerfish è in fase di pre-certificazione. La nostra postura di sicurezza è
architetturale e verificabile nel codice sorgente oggi. Le certificazioni
formali sono nella roadmap.

| Certificazione               | Stato                            | Note                                                                    |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Criteri dei servizi fiduciari di Sicurezza + Riservatezza               |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Efficacia sostenuta dei controlli nel periodo di osservazione           |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Accordo di associazione commerciale per clienti sanitari                |
| ISO 27001                    | <StatusBadge status="planned" /> | Sistema di gestione della sicurezza delle informazioni                  |
| Penetration Test di Terzi    | <StatusBadge status="planned" /> | Valutazione di sicurezza indipendente                                   |
| Conformità GDPR              | <StatusBadge status="planned" /> | Architettura self-hosted con conservazione e cancellazione configurabili |

## Una Nota sulla Fiducia

::: tip Il nucleo di sicurezza è open source con licenza Apache 2.0. È possibile
leggere ogni riga del codice di applicazione delle policy, eseguire la suite di
test e verificare le affermazioni in autonomia. Le certificazioni sono nella
roadmap. :::

## Verificare il Codice Sorgente

L'intero codebase di Triggerfish è disponibile su
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) --
con licenza Apache 2.0.

## Segnalazione di Vulnerabilità

Se si scopre una vulnerabilità di sicurezza, si prega di segnalarla attraverso
la nostra [Policy di Divulgazione Responsabile](/it-IT/security/responsible-disclosure).
Non aprire issue pubbliche su GitHub per le vulnerabilità di sicurezza.
