# Sicherheit als Grundprinzip

Triggerfish basiert auf einer einzigen Praemisse: **Das LLM hat keinerlei Autoritaet**. Es fordert Aktionen an; die Policy-Schicht entscheidet. Jede Sicherheitsentscheidung wird durch deterministischen Code getroffen, den die KI nicht umgehen, ueberschreiben oder beeinflussen kann.

Diese Seite erklaert, warum Triggerfish diesen Ansatz verfolgt, wie er sich von traditionellen KI-Agenten-Plattformen unterscheidet und wo Sie Details zu jeder Komponente des Sicherheitsmodells finden.

## Warum Sicherheit unterhalb des LLM sein muss

Grosse Sprachmodelle koennen durch Prompt-Injection manipuliert werden. Eine sorgfaeltig gestaltete Eingabe -- sei es aus einer boesartigen externen Nachricht, einem vergifteten Dokument oder einer kompromittierten Tool-Antwort -- kann ein LLM dazu bringen, seine Anweisungen zu ignorieren und Aktionen auszufuehren, die ihm verboten waren. Dies ist kein theoretisches Risiko. Es ist ein gut dokumentiertes, ungeloestes Problem in der KI-Branche.

Wenn Ihr Sicherheitsmodell davon abhaengt, dass das LLM Regeln befolgt, kann eine einzige erfolgreiche Injection jeden Schutzmechanismus umgehen, den Sie aufgebaut haben.

Triggerfish loest dies, indem alle Sicherheitsdurchsetzung in eine Code-Schicht verlagert wird, die **unterhalb** des LLM sitzt. Die KI sieht niemals Sicherheitsentscheidungen. Sie bewertet niemals, ob eine Aktion erlaubt sein sollte. Sie fordert einfach Aktionen an, und die Policy-Durchsetzungsschicht -- die als reiner, deterministischer Code laeuft -- entscheidet, ob diese Aktionen durchgefuehrt werden.

<img src="/diagrams/enforcement-layers.svg" alt="Durchsetzungsschichten: LLM hat keinerlei Autoritaet, Policy-Schicht trifft alle Entscheidungen deterministisch, nur erlaubte Aktionen erreichen die Ausfuehrung" style="max-width: 100%;" />

::: warning SICHERHEIT Die LLM-Schicht hat keinen Mechanismus, die Policy-Durchsetzungsschicht zu ueberschreiben, zu ueberspringen oder zu beeinflussen. Es gibt keine "LLM-Ausgabe nach Umgehungsbefehlen parsen"-Logik. Die Trennung ist architektonisch, nicht verhaltensbasiert. :::

## Die Kerninvariante

Jede Designentscheidung in Triggerfish leitet sich von einer Invariante ab:

> **Gleiche Eingabe erzeugt immer die gleiche Sicherheitsentscheidung. Keine Zufaelligkeit, keine LLM-Aufrufe, kein Ermessensspielraum.**

Das bedeutet, Sicherheitsverhalten ist:

- **Auditierbar** -- Sie koennen jede Entscheidung wiedergeben und erhalten das gleiche Ergebnis
- **Testbar** -- deterministischer Code kann durch automatisierte Tests abgedeckt werden
- **Verifizierbar** -- die Policy Engine ist Open Source (Apache 2.0 lizenziert) und jeder kann sie inspizieren

## Sicherheitsprinzipien

| Prinzip                      | Was es bedeutet                                                                                                                                                | Detailseite                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Datenklassifizierung**     | Alle Daten tragen eine Sensibilitaetsstufe (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Klassifizierung wird durch Code zugewiesen, wenn Daten in das System eintreten. | [Architektur: Klassifizierung](/de-DE/architecture/classification)   |
| **Kein Write-Down**          | Daten koennen nur zu Kanaelen und Empfaengern mit gleicher oder hoeherer Klassifizierungsstufe fliessen. CONFIDENTIAL-Daten koennen keinen PUBLIC-Kanal erreichen. Keine Ausnahmen. | [No-Write-Down-Regel](./no-write-down)                               |
| **Session-Taint**            | Wenn eine Session auf Daten einer Klassifizierungsstufe zugreift, wird die gesamte Session auf diese Stufe getaintet. Taint kann nur eskalieren, nie sinken.    | [Architektur: Taint](/de-DE/architecture/taint-and-sessions)         |
| **Deterministische Hooks**   | Acht Durchsetzungs-Hooks laufen an kritischen Punkten in jedem Datenfluss. Jeder Hook ist synchron, protokolliert und unfaelschbar.                            | [Architektur: Policy Engine](/de-DE/architecture/policy-engine)      |
| **Identitaet im Code**       | Benutzeridentitaet wird durch Code bei der Sitzungserstellung bestimmt, nicht durch das LLM, das Nachrichteninhalte interpretiert.                              | [Identitaet & Authentifizierung](./identity)                         |
| **Agenten-Delegation**       | Agent-zu-Agent-Aufrufe werden durch kryptographische Zertifikate, Klassifizierungsobergrenzen und Tiefenlimits geregelt.                                       | [Agenten-Delegation](./agent-delegation)                             |
| **Secrets-Isolation**        | Anmeldedaten werden in Betriebssystem-Schluesselbunden oder Vaults gespeichert, nie in Konfigurationsdateien. Plugins koennen nicht auf Systemanmeldedaten zugreifen. | [Secrets-Verwaltung](./secrets)                                      |
| **Alles auditieren**         | Jede Policy-Entscheidung wird mit vollstaendigem Kontext protokolliert: Zeitstempel, Hook-Typ, Session-ID, Eingabe, Ergebnis und ausgewertete Regeln.          | [Audit & Compliance](./audit-logging)                                |

## Traditionelle KI-Agenten vs. Triggerfish

Die meisten KI-Agenten-Plattformen verlassen sich darauf, dass das LLM Sicherheit durchsetzt. Der System-Prompt sagt "teile keine sensiblen Daten", und dem Agenten wird vertraut, dass er sich daran haelt. Dieser Ansatz hat fundamentale Schwaechen.

| Aspekt                           | Traditioneller KI-Agent                  | Triggerfish                                                         |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **Sicherheitsdurchsetzung**      | System-Prompt-Anweisungen an das LLM     | Deterministischer Code unterhalb des LLM                            |
| **Prompt-Injection-Verteidigung**| Hoffen, dass das LLM widersteht          | LLM hat von vornherein keine Autoritaet                             |
| **Datenflusskontrolle**          | LLM entscheidet, was sicher zu teilen ist| Klassifizierungskennzeichnungen + No-Write-Down-Regel im Code       |
| **Identitaetsverifizierung**     | LLM interpretiert "Ich bin der Admin"    | Code prueft kryptographische Kanalidentitaet                        |
| **Audit-Trail**                  | LLM-Gespraechsprotokolle                 | Strukturierte Policy-Entscheidungsprotokolle mit vollstaendigem Kontext |
| **Zugriff auf Anmeldedaten**     | System-Service-Konto fuer alle Benutzer  | Delegierte Benutzeranmeldedaten; Quellsystem-Berechtigungen geerbt  |
| **Testbarkeit**                  | Unscharf -- abhaengig von Prompt-Formulierung | Deterministisch -- gleiche Eingabe, gleiche Entscheidung, jedes Mal |
| **Offen zur Verifizierung**      | Meist proprietaer                        | Apache 2.0 lizenziert, vollstaendig auditierbar                     |

::: tip Triggerfish behauptet nicht, dass LLMs unzuverlaessig sind. Es behauptet, dass LLMs die falsche Schicht fuer Sicherheitsdurchsetzung sind. Ein gut angeleitetetes LLM wird seinen Anweisungen die meiste Zeit folgen. Aber "die meiste Zeit" ist keine Sicherheitsgarantie. Triggerfish bietet eine Garantie: Die Policy-Schicht ist Code, und Code tut, was ihm gesagt wird, jedes Mal. :::

## Gestaffelte Verteidigung

Triggerfish implementiert dreizehn Verteidigungsschichten. Keine einzelne Schicht ist allein ausreichend; zusammen bilden sie eine Sicherheitsgrenze:

1. **Kanalauthentifizierung** -- Code-verifizierte Identitaet bei Sitzungserstellung
2. **Berechtigungsbewusster Datenzugriff** -- Quellsystem-Berechtigungen, nicht Systemanmeldedaten
3. **Session-Taint-Tracking** -- automatisch, verpflichtend, nur Eskalation
4. **Daten-Lineage** -- vollstaendige Herkunftskette fuer jedes Datenelement
5. **Policy-Durchsetzungs-Hooks** -- deterministisch, nicht umgehbar, protokolliert
6. **MCP Gateway** -- sicherer externer Tool-Zugriff mit Pro-Tool-Berechtigungen
7. **[Plugin-Sandbox](../integrations/plugins)**
8. **Secrets-Isolation** -- Betriebssystem-Schluesselbund oder Vault, nie Konfigurationsdateien
9. **Dateisystem-Tool-Sandbox** -- Pfad-Gefaengnis, Pfad-Klassifizierung, Taint-beschraenkte Betriebssystem-I/O-Berechtigungen
10. **Agenten-Identitaet** -- kryptographische Delegationsketten
11. **Audit-Logging** -- alle Entscheidungen aufgezeichnet, keine Ausnahmen
12. **SSRF-Praevention** -- IP-Sperrliste + DNS-Aufloesungspruefungen bei allen ausgehenden HTTP-Anfragen
13. **Memory-Klassifizierungs-Gating** -- Schreibvorgaenge auf Session-Taint gezwungen, Lesevorgaenge durch `canFlowTo` gefiltert

## Naechste Schritte

| Seite                                                               | Beschreibung                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Klassifizierungsleitfaden](/de-DE/guide/classification-guide)      | Praktischer Leitfaden zur Wahl der richtigen Stufe fuer Kanaele, MCP-Server und Integrationen  |
| [No-Write-Down-Regel](./no-write-down)                              | Die fundamentale Datenflussregel und wie sie durchgesetzt wird                                  |
| [Identitaet & Authentifizierung](./identity)                        | Kanalauthentifizierung und Eigentuemer-Identitaetsverifizierung                                 |
| [Agenten-Delegation](./agent-delegation)                            | Agent-zu-Agent-Identitaet, Zertifikate und Delegationsketten                                   |
| [Secrets-Verwaltung](./secrets)                                     | Wie Triggerfish Anmeldedaten ueber Stufen hinweg handhabt                                       |
| [Audit & Compliance](./audit-logging)                               | Audit-Trail-Struktur, Verfolgung und Compliance-Exporte                                         |
