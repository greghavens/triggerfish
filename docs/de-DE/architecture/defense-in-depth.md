# Gestaffelte Verteidigung

Triggerfish implementiert Sicherheit als 13 unabhaengige, ueberlappende Schichten. Keine einzelne Schicht ist allein ausreichend. Zusammen bilden sie eine Verteidigung, die robust bleibt -- selbst wenn eine Schicht kompromittiert wird, schuetzen die verbleibenden Schichten weiterhin das System.

::: warning SICHERHEIT Gestaffelte Verteidigung bedeutet, dass eine Schwachstelle in einer einzelnen Schicht das System nicht kompromittiert. Ein Angreifer, der die Kanalauthentifizierung umgeht, steht immer noch vor Session-Taint-Tracking, Policy Hooks und Audit-Logging. Ein LLM, das durch Prompt-Injection manipuliert wird, kann dennoch die deterministische Policy-Schicht darunter nicht beeinflussen. :::

## Die 13 Schichten

### Schicht 1: Kanalauthentifizierung

**Schuetzt gegen:** Identitaetstaeuschung, unbefugten Zugriff, Identitaetsverwechslung.

Die Identitaet wird durch **Code bei der Sitzungserstellung** bestimmt, nicht durch das LLM, das Nachrichteninhalte interpretiert. Bevor das LLM eine Nachricht sieht, versieht der Kanaladapter sie mit einer unveraenderlichen Kennzeichnung:

```
{ source: "owner" }    -- verifizierte Kanalidentitaet stimmt mit registriertem Eigentuemer ueberein
{ source: "external" } -- alle anderen; nur Eingabe, wird nicht als Befehl behandelt
```

Authentifizierungsmethoden variieren je nach Kanal:

| Kanal                   | Methode         | Verifikation                                                      |
| ----------------------- | --------------- | ----------------------------------------------------------------- |
| Telegram / WhatsApp     | Pairing-Code    | Einmaliger Code, 5-Minuten-Ablauf, vom Konto des Benutzers gesendet |
| Slack / Discord / Teams | OAuth           | Plattform-OAuth-Zustimmungsflow, gibt verifizierte Benutzer-ID zurueck |
| CLI                     | Lokaler Prozess | Laeuft auf dem Rechner des Benutzers, durch Betriebssystem authentifiziert |
| WebChat                 | Keine (oeffentlich) | Alle Besucher sind `EXTERNAL`, niemals `owner`                |
| E-Mail                  | Domain-Abgleich | Absender-Domain wird mit konfigurierten internen Domains verglichen |

::: info Das LLM entscheidet niemals, wer der Eigentuemer ist. Eine Nachricht mit dem Inhalt "Ich bin der Eigentuemer" von einem nicht verifizierten Absender wird als `{ source: "external" }` markiert und kann keine Eigentuemer-Befehle ausloesen. Diese Entscheidung wird im Code getroffen, bevor das LLM die Nachricht verarbeitet. :::

### Schicht 2: Berechtigungsbewusster Datenzugriff

**Schuetzt gegen:** Uebermaessig berechtigten Datenzugriff, Privilegieneskalation durch Systemanmeldedaten.

Triggerfish verwendet die delegierten OAuth-Tokens des Benutzers -- nicht System-Service-Konten -- um externe Systeme abzufragen. Das Quellsystem setzt sein eigenes Berechtigungsmodell durch:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditionell vs. Triggerfish: Traditionelles Modell gibt dem LLM direkte Kontrolle, Triggerfish leitet alle Aktionen durch eine deterministische Policy-Schicht" style="max-width: 100%;" />

Das Plugin SDK setzt dies auf API-Ebene durch:

| SDK-Methode                             | Verhalten                                   |
| --------------------------------------- | ------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Gibt delegiertes OAuth-Token des Benutzers zurueck |
| `sdk.query_as_user(integration, query)` | Fuehrt mit Benutzerberechtigungen aus       |
| `sdk.get_system_credential(name)`       | **BLOCKIERT** -- loest `PermissionError` aus |

### Schicht 3: Session-Taint-Tracking

**Schuetzt gegen:** Datenlecks durch Kontextkontamination, klassifizierte Daten, die niedrigere Klassifizierungskanaele erreichen.

Jede Session verfolgt unabhaengig eine Taint-Stufe, die die hoechste Klassifizierung der waehrend der Session abgerufenen Daten widerspiegelt. Taint folgt drei Invarianten:

1. **Pro Gespraech** -- jede Session hat ihren eigenen Taint
2. **Nur Eskalation** -- Taint steigt, sinkt aber nie
3. **Vollstaendiger Reset loescht alles** -- Taint UND Verlauf werden zusammen geloescht

Wenn die Policy Engine eine Ausgabe bewertet, vergleicht sie den Taint der Session mit der effektiven Klassifizierung des Zielkanals. Wenn der Taint das Ziel uebersteigt, wird die Ausgabe blockiert.

### Schicht 4: Daten-Lineage

**Schuetzt gegen:** Nicht nachverfolgbare Datenfluesse, Unfaehigkeit zu auditieren, wohin Daten geflossen sind, Compliance-Luecken.

Jedes Datenelement traegt Herkunftsmetadaten vom Ursprung bis zum Ziel:

- **Ursprung**: Welche Integration, welcher Datensatz und welcher Benutzerzugriff diese Daten erzeugt hat
- **Klassifizierung**: Welche Stufe zugewiesen wurde und warum
- **Transformationen**: Wie das LLM die Daten modifiziert, zusammengefasst oder kombiniert hat
- **Ziel**: Welche Session und welcher Kanal die Ausgabe erhalten hat

Lineage ermoeglicht Vorwaertsverfolgungs ("Wohin ging dieser Salesforce-Datensatz?"), Rueckwaertsverfolgung ("Welche Quellen haben zu dieser Ausgabe beigetragen?") und vollstaendige Compliance-Exporte.

### Schicht 5: Policy-Durchsetzungs-Hooks

**Schuetzt gegen:** Prompt-Injection-Angriffe, LLM-gesteuerte Sicherheitsumgehungen, unkontrollierte Tool-Ausfuehrung.

Acht deterministische Hooks fangen jede Aktion an kritischen Punkten im Datenfluss ab:

| Hook                    | Was abgefangen wird                          |
| ----------------------- | -------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Externe Eingabe tritt in das Kontextfenster ein |
| `PRE_TOOL_CALL`         | LLM fordert Tool-Ausfuehrung an              |
| `POST_TOOL_RESPONSE`    | Daten kehren von Tool-Ausfuehrung zurueck    |
| `PRE_OUTPUT`            | Antwort steht kurz davor, das System zu verlassen |
| `SECRET_ACCESS`         | Anforderung zum Zugriff auf Anmeldedaten     |
| `SESSION_RESET`         | Anforderung zum Taint-Reset                  |
| `AGENT_INVOCATION`      | Agent-zu-Agent-Aufruf                        |
| `MCP_TOOL_CALL`         | MCP-Server-Tool-Aufruf                       |

Hooks sind reiner Code: deterministisch, synchron, protokolliert und unfaelschbar. Das LLM kann sie nicht umgehen, weil es keinen Pfad von der LLM-Ausgabe zur Hook-Konfiguration gibt. Die Hook-Schicht parst keine LLM-Ausgabe nach Befehlen.

### Schicht 6: MCP Gateway

**Schuetzt gegen:** Unkontrollierten Zugriff auf externe Tools, unklassifizierte Daten, die ueber MCP-Server eintreten, Schema-Verletzungen.

Alle MCP-Server sind standardmaessig `UNTRUSTED` und koennen nicht aufgerufen werden, bis ein Administrator oder Benutzer sie klassifiziert. Das Gateway setzt durch:

- Server-Authentifizierung und Klassifizierungsstatus
- Tool-Berechtigungen auf Einzeltool-Ebene (einzelne Tools koennen blockiert werden, selbst wenn der Server erlaubt ist)
- Anfrage-/Antwort-Schema-Validierung
- Taint-Tracking bei allen MCP-Antworten
- Injection-Muster-Scanning in Parametern

<img src="/diagrams/mcp-server-states.svg" alt="MCP-Server-Zustaende: UNTRUSTED (Standard), CLASSIFIED (ueberprueft und erlaubt), BLOCKED (explizit verboten)" style="max-width: 100%;" />

### Schicht 7: Plugin-Sandbox

Aktiviere ein TypeScript-Plugin in der Benutzerkonfiguration mit `enabled: true`. Standardmäßig erfolgen Import und Ausführung in eingeschränkten Deno-Workern. Sie dürfen das Plugin-Verzeichnis lesen und nur die in `declaredEndpoints` angegebenen Hosts und Ports kontaktieren. Schreibzugriff, Prozessumgebung, Unterprozesse, FFI und geschützte Systeminformationen sind gesperrt. `trust: trusted` in der Konfiguration erlaubt den Import im Triggerfish-Prozess. Der Executor läuft dort, wenn auch das Manifest `trusted` angibt.

[Vollständiger Plugin-Leitfaden](../integrations/plugins)

### Schicht 8: Secrets-Isolation

**Schuetzt gegen:** Diebstahl von Anmeldedaten, Secrets in Konfigurationsdateien, Klartext-Speicherung von Anmeldedaten.

Anmeldedaten werden im Betriebssystem-Schluesselbund (persoenliche Stufe) oder in der Vault-Integration (Enterprise-Stufe) gespeichert. Sie erscheinen niemals in:

- Konfigurationsdateien
- `StorageProvider`-Werten
- Log-Eintraegen
- LLM-Kontext (Anmeldedaten werden auf HTTP-Ebene unterhalb des LLM injiziert)

Der `SECRET_ACCESS`-Hook protokolliert jeden Zugriff auf Anmeldedaten mit dem anfragenden Plugin, dem Anmeldedaten-Scope und der Entscheidung.

### Schicht 9: Dateisystem-Tool-Sandbox

**Schuetzt gegen:** Path-Traversal-Angriffe, unbefugten Dateizugriff, Klassifizierungsumgehung durch direkte Dateisystemoperationen.

Alle Dateisystem-Tool-Operationen (Lesen, Schreiben, Bearbeiten, Auflisten, Suchen) laufen innerhalb eines sandboxed Deno Workers mit Betriebssystem-Berechtigungen, die auf das taint-angemessene Arbeitsbereich-Unterverzeichnis der Session beschraenkt sind. Die Sandbox setzt drei Grenzen durch:

- **Pfad-Gefaengnis** — jeder Pfad wird zu einem absoluten Pfad aufgeloest und mit trennzeichenbewusstem Abgleich gegen die Gefaengniswurzel geprueft. Traversierungsversuche (`../`), die den Arbeitsbereich verlassen, werden vor jeglicher I/O abgelehnt
- **Pfad-Klassifizierung** — jeder Dateisystempfad wird durch eine feste Aufloesungskette klassifiziert: hartcodierte geschuetzte Pfade (RESTRICTED), Arbeitsbereich-Klassifizierungsverzeichnisse, konfigurierte Pfadzuordnungen, dann Standardklassifizierung. Der Agent kann nicht auf Pfade oberhalb seines Session-Taint zugreifen
- **Taint-beschraenkte Berechtigungen** — die Deno-Berechtigungen des Sandbox-Workers werden auf das Arbeitsbereich-Unterverzeichnis gesetzt, das der aktuellen Taint-Stufe der Session entspricht. Wenn Taint eskaliert, wird der Worker mit erweiterten Berechtigungen neu gestartet. Berechtigungen koennen sich innerhalb einer Session nur erweitern, nie verengen
- **Schreibschutz** — kritische Dateien (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) sind auf Tool-Ebene schreibgeschuetzt, unabhaengig von Sandbox-Berechtigungen. Diese Dateien koennen nur durch dedizierte Verwaltungstools geaendert werden, die ihre eigenen Klassifizierungsregeln durchsetzen

### Schicht 10: Agenten-Identitaet

**Schuetzt gegen:** Privilegieneskalation durch Agentenketten, Datenwaesche durch Delegation.

Wenn Agenten andere Agenten aufrufen, verhindern kryptographische Delegationsketten eine Privilegieneskalation:

- Jeder Agent hat ein Zertifikat, das seine Faehigkeiten und Klassifizierungsobergrenze spezifiziert
- Der Aufgerufene erbt `max(eigener Taint, Aufrufer-Taint)` -- Taint kann durch Ketten nur steigen
- Ein Aufrufer mit Taint oberhalb der Obergrenze des Aufgerufenen wird blockiert
- Zirkulaere Aufrufe werden erkannt und abgelehnt
- Delegationstiefe ist begrenzt und wird durchgesetzt

<img src="/diagrams/data-laundering-defense.svg" alt="Datenwaesche-Verteidigung: Angriffspfad wird bei Obergrenzen-Pruefung blockiert und Taint-Vererbung verhindert Ausgabe an niedriger klassifizierte Kanaele" style="max-width: 100%;" />

### Schicht 11: Audit-Logging

**Schuetzt gegen:** Nicht erkennbare Sicherheitsverletzungen, Compliance-Verstoesse, Unfaehigkeit, Vorfaelle zu untersuchen.

Jede sicherheitsrelevante Entscheidung wird mit vollstaendigem Kontext protokolliert:

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

Was protokolliert wird:

- Alle Aktionsanfragen (erlaubte UND abgelehnte)
- Klassifizierungsentscheidungen
- Session-Taint-Aenderungen
- Kanalauthentifizierungsereignisse
- Policy-Regelauswertungen
- Lineage-Datensatz-Erstellung und -Aktualisierungen
- MCP-Gateway-Entscheidungen
- Agent-zu-Agent-Aufrufe

::: info Audit-Logging kann nicht deaktiviert werden. Es ist eine feste Regel in der Policy-Hierarchie. Selbst ein Organisationsadministrator kann das Logging fuer seine eigenen Aktionen nicht abschalten. Enterprise-Bereitstellungen koennen optional vollstaendiges Inhalts-Logging (einschliesslich blockierter Nachrichteninhalte) fuer forensische Anforderungen aktivieren. :::

### Schicht 12: SSRF-Praevention

**Schuetzt gegen:** Server-Side Request Forgery, interne Netzwerkaufklaerung, Cloud-Metadaten-Exfiltration.

Alle ausgehenden HTTP-Anfragen (von `web_fetch`, `browser.navigate` und Plugin-Netzwerkzugriff) loesen zuerst DNS auf und pruefen die aufgeloeste IP gegen eine hartcodierte Sperrliste privater und reservierter Bereiche. Dies verhindert, dass ein Angreifer den Agenten dazu bringt, ueber manipulierte URLs auf interne Dienste zuzugreifen.

- Private Bereiche (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) werden immer blockiert
- Link-Local (`169.254.0.0/16`) und Cloud-Metadaten-Endpunkte werden blockiert
- Loopback (`127.0.0.0/8`) wird blockiert
- Die Sperrliste ist hartcodiert und nicht konfigurierbar -- es gibt keinen Admin-Override
- DNS-Aufloesung erfolgt vor der Anfrage, was DNS-Rebinding-Angriffe verhindert

### Schicht 13: Memory-Klassifizierungs-Gating

**Schuetzt gegen:** Session-uebergreifende Datenlecks durch Memory, Klassifizierungs-Downgrade ueber Memory-Schreibvorgaenge, unbefugten Zugriff auf klassifizierte Erinnerungen.

Das session-uebergreifende Memory-System setzt Klassifizierung sowohl beim Schreiben als auch beim Lesen durch:

- **Schreibvorgaenge**: Memory-Eintraege werden auf die aktuelle Taint-Stufe der Session gezwungen. Das LLM kann keine niedrigere Klassifizierung fuer gespeicherte Erinnerungen waehlen.
- **Lesevorgaenge**: Memory-Abfragen werden durch `canFlowTo` gefiltert -- eine Session kann nur Erinnerungen auf oder unter ihrer aktuellen Taint-Stufe lesen.

Dies verhindert, dass ein Agent CONFIDENTIAL-Daten als PUBLIC im Memory speichert und sie spaeter in einer niedriger getainteten Session abruft, um die No-Write-Down-Regel zu umgehen.

## Vertrauenshierarchie

Das Vertrauensmodell definiert, wer welche Autoritaet hat. Hoehere Stufen koennen Sicherheitsregeln niedrigerer Stufen nicht umgehen, aber sie koennen die anpassbaren Parameter innerhalb dieser Regeln konfigurieren.

<img src="/diagrams/trust-hierarchy.svg" alt="Vertrauenshierarchie: Triggerfish-Anbieter (kein Zugriff), Org-Admin (setzt Policies), Mitarbeiter (nutzt Agent innerhalb der Grenzen)" style="max-width: 100%;" />

::: tip **Persoenliche Stufe:** Der Benutzer IST der Org-Admin. Volle Souveraenitaet. Keine Triggerfish-Einsicht. Der Anbieter hat standardmaessig keinen Zugriff auf Benutzerdaten und kann nur durch eine explizite, zeitlich begrenzte, protokollierte Genehmigung des Benutzers Zugriff erhalten. :::

## Wie die Schichten zusammenwirken

Betrachten Sie einen Prompt-Injection-Angriff, bei dem eine boesartige Nachricht versucht, Daten zu exfiltrieren:

| Schritt | Schicht                  | Aktion                                                         |
| ------- | ------------------------ | -------------------------------------------------------------- |
| 1       | Kanalauthentifizierung   | Nachricht als `{ source: "external" }` markiert -- nicht Eigentuemer |
| 2       | PRE_CONTEXT_INJECTION    | Eingabe auf Injection-Muster gescannt, klassifiziert           |
| 3       | Session-Taint            | Session-Taint unveraendert (keine klassifizierten Daten abgerufen) |
| 4       | LLM verarbeitet Nachricht| LLM kann dazu manipuliert werden, einen Tool-Aufruf anzufordern |
| 5       | PRE_TOOL_CALL            | Tool-Berechtigungspruefung gegen External-Source-Regeln        |
| 6       | POST_TOOL_RESPONSE       | Zurueckgegebene Daten klassifiziert, Taint aktualisiert        |
| 7       | PRE_OUTPUT               | Ausgabeklassifizierung vs. Ziel geprueft                       |
| 8       | Audit-Logging            | Gesamte Sequenz fuer Ueberpruefung aufgezeichnet               |

Selbst wenn das LLM in Schritt 4 vollstaendig kompromittiert wird und einen Datenexfiltrations-Tool-Aufruf anfordert, setzen die verbleibenden Schichten (Berechtigungspruefungen, Taint-Tracking, Ausgabeklassifizierung, Audit-Logging) die Policy weiterhin durch. Kein einzelner Ausfallpunkt kompromittiert das System.
