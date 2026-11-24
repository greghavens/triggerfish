---
title: Trust Center
description: Sicherheitskontrollen, Compliance-Status und architektonische Transparenz fuer Triggerfish.
---

# Trust Center

Triggerfish setzt Sicherheit in deterministischem Code unterhalb der LLM-Schicht durch — nicht in Prompts, die das Modell moeglicherweise ignoriert. Jede Policy-Entscheidung wird durch Code getroffen, der nicht durch Prompt-Injection, Social Engineering oder Modell-Fehlverhalten beeinflusst werden kann. Siehe die vollstaendige Seite [Sicherheit als Grundprinzip](/de-DE/security/) fuer die ausfuehrliche technische Erklaerung.

## Sicherheitskontrollen

Diese Kontrollen sind im aktuellen Release aktiv. Jede wird im Code durchgesetzt, in CI getestet und ist im Open-Source-Repository auditierbar.

| Kontrolle                        | Status                           | Beschreibung                                                                                                                                            |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM-Policy-Durchsetzung     | <StatusBadge status="active" />  | Acht deterministische Hooks fangen jede Aktion vor und nach der LLM-Verarbeitung ab. Das Modell kann Sicherheitsentscheidungen nicht umgehen, aendern oder beeinflussen. |
| Datenklassifizierungssystem      | <StatusBadge status="active" />  | Vierstufige Hierarchie (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) mit verpflichtender No-Write-Down-Durchsetzung.                                     |
| Session-Taint-Tracking           | <StatusBadge status="active" />  | Jede Session verfolgt die hoechste Klassifizierung der abgerufenen Daten. Taint eskaliert nur, sinkt nie.                                               |
| Unveraenderliches Audit-Logging  | <StatusBadge status="active" />  | Alle Policy-Entscheidungen mit vollstaendigem Kontext protokolliert. Audit-Logging kann von keiner Systemkomponente deaktiviert werden.                  |
| Secrets-Isolation                | <StatusBadge status="active" />  | Anmeldedaten im Betriebssystem-Schluesselbund oder Vault gespeichert. Nie in Konfigurationsdateien, Speicherung, Logs oder LLM-Kontext.                |
| Plugin-Sandboxing                | <StatusBadge status="active" />  | [Plugins](../integrations/plugins) |
| Abhaengigkeits-Scanning          | <StatusBadge status="active" />  | Automatisiertes Schwachstellen-Scanning ueber GitHub Dependabot. PRs werden automatisch fuer Upstream-CVEs geoeffnet.                                  |
| Open-Source-Codebasis            | <StatusBadge status="active" />  | Die gesamte Sicherheitsarchitektur ist Apache 2.0 lizenziert und oeffentlich auditierbar.                                                              |
| On-Premises-Bereitstellung       | <StatusBadge status="active" />  | Laeuft vollstaendig auf Ihrer Infrastruktur. Keine Cloud-Abhaengigkeit, keine Telemetrie, keine externe Datenverarbeitung.                             |
| Verschluesselung                 | <StatusBadge status="active" />  | TLS fuer alle Daten waehrend der Uebertragung. Betriebssystem-Verschluesselung im Ruhezustand. Enterprise-Vault-Integration verfuegbar.                |
| Programm zur verantwortungsvollen Offenlegung | <StatusBadge status="active" />  | Dokumentierter Schwachstellen-Meldeprozess mit definierten Reaktionszeitraeumen. Siehe [Offenlegungsrichtlinie](/de-DE/security/responsible-disclosure). |
| Gehaertetes Container-Image      | <StatusBadge status="planned" /> | Docker-Images auf Google Distroless-Basis mit nahezu null CVEs. Automatisiertes Trivy-Scanning in CI.                                                  |

## Gestaffelte Verteidigung — 13 unabhaengige Schichten

Keine einzelne Schicht ist allein ausreichend. Wenn eine Schicht kompromittiert wird, schuetzen die verbleibenden Schichten weiterhin das System.

| Schicht | Name                           | Durchsetzung                                          |
| ------- | ------------------------------ | ----------------------------------------------------- |
| 01      | Kanalauthentifizierung         | Code-verifizierte Identitaet bei Sitzungserstellung   |
| 02      | Berechtigungsbewusster Datenzugriff | Quellsystem-Berechtigungen, nicht Systemanmeldedaten |
| 03      | Session-Taint-Tracking         | Automatisch, verpflichtend, nur Eskalation            |
| 04      | Daten-Lineage                  | Vollstaendige Herkunftskette fuer jedes Datenelement  |
| 05      | Policy-Durchsetzungs-Hooks     | Deterministisch, nicht umgehbar, protokolliert         |
| 06      | MCP Gateway                    | Pro-Tool-Berechtigungen, Server-Klassifizierung       |
| 07      | Plugin-Sandbox                 | [Plugins](../integrations/plugins) |
| 08      | Secrets-Isolation              | Betriebssystem-Schluesselbund oder Vault, unter LLM-Schicht |
| 09      | Dateisystem-Tool-Sandbox       | Pfad-Gefaengnis, Pfad-Klassifizierung, Taint-beschraenkte I/O |
| 10      | Agenten-Identitaet & Delegation| Kryptographische Delegationsketten                    |
| 11      | Audit-Logging                  | Kann nicht deaktiviert werden                         |
| 12      | SSRF-Praevention               | IP-Sperrliste + DNS-Aufloesungspruefungen             |
| 13      | Memory-Klassifizierungs-Gating | Schreiben auf eigener Stufe, Lesen nur abwaerts       |

Lesen Sie die vollstaendige Dokumentation zur [gestaffelten Verteidigung](/de-DE/architecture/defense-in-depth).

## Warum Sub-LLM-Durchsetzung wichtig ist

::: info Die meisten KI-Agenten-Plattformen setzen Sicherheit durch System-Prompts durch — Anweisungen an das LLM, die besagen "teile keine sensiblen Daten." Prompt-Injection-Angriffe koennen diese Anweisungen ueberschreiben.

Triggerfish verfolgt einen anderen Ansatz: Das LLM hat **keinerlei Autoritaet** ueber Sicherheitsentscheidungen. Alle Durchsetzung geschieht in deterministischem Code unterhalb der LLM-Schicht. Es gibt keinen Pfad von der LLM-Ausgabe zur Sicherheitskonfiguration. :::

## Compliance-Roadmap

Triggerfish befindet sich vor der Zertifizierung. Unsere Sicherheitsposition ist architektonisch und heute im Quellcode verifizierbar. Formale Zertifizierungen stehen auf der Roadmap.

| Zertifizierung               | Status                           | Hinweise                                                              |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| SOC 2 Typ I                  | <StatusBadge status="planned" /> | Sicherheits- und Vertraulichkeits-Trust-Services-Kriterien            |
| SOC 2 Typ II                 | <StatusBadge status="planned" /> | Nachhaltige Kontrolleffektivitaet ueber Beobachtungszeitraum          |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Business Associate Agreement fuer Gesundheitswesen-Kunden             |
| ISO 27001                    | <StatusBadge status="planned" /> | Informationssicherheits-Managementsystem                              |
| Penetrationstest Dritter     | <StatusBadge status="planned" /> | Unabhaengige Sicherheitsbewertung                                     |
| DSGVO-Compliance             | <StatusBadge status="planned" /> | Self-hosted-Architektur mit konfigurierbarer Aufbewahrung und Loeschung |

## Ein Hinweis zum Vertrauen

::: tip Der Sicherheitskern ist Open Source unter Apache 2.0. Sie koennen jede Zeile des Policy-Durchsetzungscodes lesen, die Testsuite ausfuehren und Behauptungen selbst verifizieren. Zertifizierungen stehen auf der Roadmap. :::

## Quellcode auditieren

Die vollstaendige Triggerfish-Codebasis ist verfuegbar unter [github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) — Apache 2.0 lizenziert.

## Schwachstellen melden

Wenn Sie eine Sicherheitsschwachstelle entdecken, melden Sie sie bitte ueber unsere [Richtlinie zur verantwortungsvollen Offenlegung](/de-DE/security/responsible-disclosure). Oeffnen Sie keine oeffentlichen GitHub-Issues fuer Sicherheitsschwachstellen.
