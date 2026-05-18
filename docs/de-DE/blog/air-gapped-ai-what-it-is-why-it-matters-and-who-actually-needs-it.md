---
title: "  Air-Gapped-KI: Was sie ist, warum sie wichtig ist und wer sie tatsächlich braucht"
date: 2026-03-06
description: Air-Gapped-KI läuft auf isolierten Systemen ohne Internetverbindung
  und bietet Organisationen maximale Datensicherheit und vollständige Kontrolle
  über sensible KI-Workloads.
author: triggerfish
tags:
  - AI agent
draft: false
---


Air-Gapped-KI bezeichnet KI-Systeme, die auf Hardware bereitgestellt werden, die physisch und logisch vom Internet und von jedem externen Netzwerk isoliert ist. Es ist die höchste Stufe der Datensicherheit, die für KI-Bereitstellungen verfügbar ist, und wird verwendet, wenn die Folgen einer Sicherheitsverletzung schlicht zu schwerwiegend sind, um irgendeine externe Konnektivität zu akzeptieren.

Die meisten Unternehmen, die private KI-Bereitstellungen erkunden, denken an On-Premise-Aufbauten oder Private-Cloud-Konfigurationen. Das sind solide Optionen für die meisten Anwendungsfälle. Aber es gibt eine Kategorie von Organisationen, für die selbst ein streng gesicherter privater Server mit VPN-Zugriff nicht ausreicht. Regierungsbehörden, die mit klassifizierten Informationen umgehen, Verteidigungsauftragnehmer, die Daten von Waffensystemen verarbeiten, Betreiber kritischer Infrastrukturen und Forschungseinrichtungen, die an sensiblen Entdeckungen arbeiten, operieren alle in Umgebungen, in denen Netzwerkisolation keine Vorliebe, sondern eine Anforderung ist. Dieser Leitfaden erklärt, wie Air-Gapped-KI in der Praxis aussieht, wie sie bereitgestellt wird, was sie betrieblich kostet und ob Ihre Organisation sie tatsächlich braucht oder nur denkt, sie zu brauchen.



![AI agent](/blog/images/secured-server.jpg)

## **Was „Air-Gapped" wirklich bedeutet**

Der Begriff stammt von der physischen Luftlücke zwischen einem isolierten System und jedem verbundenen Netzwerk. Es gibt kein Ethernet-Kabel, das zum Internet führt. Es ist kein WLAN-Adapter aktiviert. Es gibt kein Bluetooth. Daten gelangen nur über physische Medien hinein und heraus, also USB-Laufwerke, optische Datenträger oder Air-Gapped-Datenübertragungs-Workstations, die selbst keine externe Konnektivität haben.

Das unterscheidet sich grundlegend von einer Firewall, einem VPN oder sogar einer Private-Cloud-Bereitstellung. Bei all diesen reisen die Daten immer noch über Netzwerke, auch wenn diese Netzwerke verschlüsselt und zugriffskontrolliert sind. Ein Air-Gapped-System übermittelt überhaupt keine Daten über irgendein Netzwerk. Die Isolation ist physisch, nicht nur logisch.

Im Kontext der KI bedeutet dies, dass das Modell, die Inferenz-Engine, die Trainingsdaten und alle vom System erzeugten Ausgaben auf Hardware leben, die nach der Bereitstellung niemals das öffentliche Internet berührt hat. Aktualisierungen des Modells erfordern physische Medienübertragungen. Neue Trainingsdaten werden auf die gleiche Weise bewegt. Ausgaben werden durch kontrollierte physische Prozesse überprüft und extrahiert.

Es klingt extrem, weil es für die meisten Organisationen extrem ist. Aber für die Umgebungen, in denen es zutrifft, ist es die einzige Architektur, die das tatsächliche Bedrohungsmodell erfüllt, unter dem sie operieren.

## **Wer braucht Air-Gapped-KI und warum**



![AI agent](/blog/images/analyst.jpg)

### **Verteidigungs- und Nachrichtendienstanwendungen**

Militär- und Nachrichtendienste waren die ursprünglichen Architekten der Air-Gap-Protokolle, lange bevor KI ins Bild kam. Klassifizierte Systeme operieren seit Jahrzehnten in vollständiger Netzwerkisolation, weil die Folgen einer Sicherheitsverletzung in diesen Umgebungen in Menschenleben und nationalen Sicherheitsergebnissen gemessen werden, nicht in Kosten für die Benachrichtigung über Datenpannen.

KI in diese Umgebungen zu bringen, ändert nicht die Anforderung der Isolation. Es fügt einer Infrastruktur Fähigkeiten hinzu, die bereits physische Trennung verlangt. Behörden, die KI für die Analyse von Signalaufklärung, die Erkennung von Bedrohungsmustern oder die Logistikoptimierung verwenden, benötigen Modelle, die vollständig innerhalb klassifizierter Netzwerke laufen, die niemals mit der Außenwelt verbunden waren.

### **Betreiber kritischer Infrastrukturen**

Stromnetze, Wasseraufbereitungsanlagen, Kernkraftwerke und Finanzclearingsysteme fallen in eine Kategorie, in der Störungen kaskadenartige gesellschaftliche Auswirkungen haben. Die industriellen Steuerungssysteme, die diese Umgebungen verwalten, haben zunehmend KI für Anomalieerkennung und vorausschauende Wartung integriert. Diese KI-Komponenten in Air-Gapped-Netzwerken zu betreiben, stellt sicher, dass ein kompromittiertes externes System die Betriebstechnologie, die die physische Infrastruktur verwaltet, nicht erreichen kann.

### **Gesundheits- und Rechtsumgebungen mit extremen Datenschutzanforderungen**

Nicht jeder Air-Gap-Anwendungsfall betrifft Staatsgeheimnisse. Krankenhäuser, die hochsensible Forschungsdaten verarbeiten, forensische Labore, die mit Beweisen umgehen, und Anwaltskanzleien, die Angelegenheiten verwalten, bei denen sogar die Existenz des Falls vertraulich ist, benötigen manchmal eine vollständige Netzwerkisolation für bestimmte KI-Workloads. Das Bedrohungsmodell hier bezieht sich weniger auf nationalstaatliche Akteure und mehr auf einen wasserdichten Schutz des Anwaltsgeheimnisses und auf regulatorische Compliance mit Nulltoleranz für versehentliche Offenlegungen.

Zu verstehen, wie die[ AI security](https://trigger.fish/security/)-Architektur für diese Umgebungen entworfen wird, hilft Organisationen zu beurteilen, ob ihr tatsächliches Bedrohungsmodell echtes Air Gapping erfordert oder ob eine gut gesicherte private Bereitstellung ausreichen würde.

## **Wie Air-Gapped-KI-Bereitstellungen in der Praxis funktionieren**

### **Modelle in eine isolierte Umgebung bringen**

Der Prozess des Aufbaus eines Air-Gapped-KI-Systems beginnt, bevor überhaupt Hardware in Racks eingebaut wird. Modellgewichte, das sind die großen Dateien, die das Verhalten der KI definieren, müssen heruntergeladen, verifiziert und über genehmigte physische Medienkanäle in die isolierte Umgebung übertragen werden.

In einer typischen sicheren Bereitstellung bedeutet das, das Modell auf einer separaten, kontrollierten Staging-Maschine herunterzuladen, eine Integritätsprüfung durchzuführen, um zu bestätigen, dass die Dateien nicht manipuliert wurden, sie auf bereinigte physische Medien zu übertragen und diese Medien physisch in die isolierte Umgebung zu tragen, wo sie auf die Air-Gapped-Hardware geladen werden.

Alle Aktualisierungen des Modells durchlaufen denselben Prozess. Es gibt keinen automatischen Aktualisierungsmechanismus. Jede Änderung ist bewusst, dokumentiert und physisch ausgeführt.


<table>
  <thead>
    <tr>
      <th>Übertragungsphase</th>
      <th>Prozess</th>
      <th>Sicherheitskontrolle</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Modell-Download</td>
      <td>Auf mit dem Internet verbundener Staging-Maschine abgerufen</td>
      <td>Hash-Verifikation gegen bekannte Prüfsummen</td>
    </tr>
    <tr>
      <td>Medienvorbereitung</td>
      <td>Auf bereinigtes physisches Übertragungsgerät geschrieben</td>
      <td>Einmal-beschreibbare Medien oder bereinigte Laufwerke</td>
    </tr>
    <tr>
      <td>Physische Übertragung</td>
      <td>In den sicheren Perimeter getragen</td>
      <td>Dokumentation der Beweismittelkette</td>
    </tr>
    <tr>
      <td>Installation</td>
      <td>Auf Air-Gapped-Hardware geladen</td>
      <td>Integritätsprüfung auf der sicheren Seite wiederholt</td>
    </tr>
    <tr>
      <td>Extraktion der Ausgaben</td>
      <td>Ergebnisse durch umgekehrten Prozess herausbewegt</td>
      <td>Inhaltsprüfung vor der Extraktion</td>
    </tr>
  </tbody>
</table>



### **Inferenz auf isolierter Hardware ausführen**

Sobald das Modell installiert ist, sieht der tägliche Betrieb aus Sicht der Anwender:innen ähnlich aus wie jede andere On-Premise-KI-Bereitstellung. Analyst:innen oder Anwendungen reichen Abfragen ein, das Modell verarbeitet sie, und Antworten kommen zurück. Der Unterschied liegt vollständig in dem, was unter der Oberfläche geschieht. Es geht keine Telemetrie hinaus. Es gibt keine API-Aufrufe an externe Dienste. Das System ist eigenständig.

Dies schafft einige betriebliche Einschränkungen, die es wert sind, verstanden zu werden. Retrieval-augmented Generation, die es KI-Systemen ermöglicht, frische Informationen aus verbundenen Datenbanken einzuspielen, erfordert, dass diese Datenbanken ebenfalls innerhalb der Air-Gapped-Umgebung leben. Echtzeitinformationen sind nur so aktuell wie die letzte physische Datenübertragung in das System. Für die meisten Air-Gap-Anwendungsfälle ist dies angesichts der Sicherheitsvorteile ein akzeptabler Kompromiss.

Die Entscheidungen zur[ AI architecture](https://trigger.fish/architecture/), die früh in einer Air-Gapped-Bereitstellung getroffen werden, lassen sich später schwer ändern, was es erheblich wichtiger macht, das Anfangsdesign richtig zu treffen, als bei einem Standard-Cloud- oder On-Premise-Aufbau.



![Ai agent](/blog/images/usb.jpg)

### **Hardware-Überlegungen**

Air-Gapped-KI-Systeme können sich nicht auf cloudbasierte Hardware-Skalierung verlassen. Welche Rechenleistung Sie zu Beginn bereitstellen, ist das, was Sie haben. Das macht eine genaue Kapazitätsplanung kritisch.


<table>
  <thead>
    <tr>
      <th>Organisationstyp</th>
      <th>Typische Modellgröße</th>
      <th>Hardware-Ansatz</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Kleines sicheres Team, begrenzte Abfragen</td>
      <td>7B bis 13B Parameter</td>
      <td>Einzelne High-End-Workstation mit GPU</td>
    </tr>
    <tr>
      <td>Mittelgroße sichere Abteilung</td>
      <td>13B bis 34B Parameter</td>
      <td>Dedizierter Server mit mehreren GPUs</td>
    </tr>
    <tr>
      <td>Behörden- oder Unternehmensskala</td>
      <td>34B bis 70B Parameter</td>
      <td>Multi-Node-GPU-Cluster, vor Ort</td>
    </tr>
    <tr>
      <td>Forschung mit multimodalen Anforderungen</td>
      <td>Spezialisierte große Modelle</td>
      <td>Maßgeschneiderte Hardware-Beschaffung erforderlich</td>
    </tr>
  </tbody>
</table>



Redundanzplanung ist hier wichtiger als in verbundenen Umgebungen. Wenn Hardware in einem Cloud-Setup ausfällt, verschiebt sich die Kapazität automatisch. In einer Air-Gapped-Umgebung bedeutet ein Hardwarefehler reduzierte Kapazität, bis ein physischer Ersatz beschafft, bereinigt und installiert ist. Redundanz in die anfängliche Hardware-Spezifikation einzubauen, ist in Produktionsumgebungen nicht optional.

## **Die betriebliche Realität des Betriebs von Air-Gapped-KI**

### **Wie der tägliche Betrieb tatsächlich aussieht**

Organisationen, die Air-Gapped-Systeme betreiben, entwickeln disziplinierte Betriebsrhythmen rund um die Einschränkungen. Modellaktualisierungen erfolgen in einem geplanten Zyklus statt nach Bedarf. Datenimporte folgen dokumentierten Verfahren mit mehreren Freigaben. Ausgabe-Extraktionen werden überprüft, bevor irgendetwas den sicheren Perimeter verlässt.

Diese Bedächtigkeit ist in bestimmten Kontexten tatsächlich ein Feature. Jede Änderung an der KI-Umgebung wird verfolgt, dokumentiert und ist auditierbar. In regulierten Branchen hat diese Audit-Spur einen realen Wert. In klassifizierten Umgebungen ist sie obligatorisch.

Die Herausforderung ist, dass es Dinge auch im Vergleich zu dem verlangsamt, was Teams, die an Cloud-KI-Tools gewöhnt sind, erwarten könnten. Prompt-Iteration, die auf einer Cloud-Plattform Sekunden dauert, kann in einer Air-Gapped-Umgebung Tage dauern, wenn dafür neue Daten importiert oder eine Modellaktualisierung durch den physischen Übertragungsprozess geschoben werden muss.

Ein nützlicher Bezugspunkt ist der Ansatz, der in den[ AI guide](https://trigger.fish/guide/)-Ressourcen zur phasenweisen Bereitstellung behandelt wird und hier direkt zutrifft. Mit einem engen, gut definierten Anwendungsfall zu beginnen, bevor der Umfang des Air-Gapped-Systems erweitert wird, verhindert, dass Scope Creep betriebliche Probleme schafft, bevor das Team die prozedurale Routine zur Verwaltung der Umgebung entwickelt hat.

### **Personal- und Expertiseanforderungen**

Der Betrieb eines Air-Gapped-KI-Systems erfordert Menschen, die sowohl den KI-Stack als auch die Sicherheitsprotokolle verstehen, die die isolierte Umgebung regeln. Diese Kombination ist tatsächlich selten und gebietet eine erhebliche Vergütung. Die spezialisierten Rollen in der Verwaltung klassifizierter oder Air-Gapped-KI-Umgebungen gehören zu den am besten bezahlten Positionen im Technologiesektor und spiegeln die Knappheit von Personen wider, die die notwendigen Sicherheitsfreigaben gemeinsam mit praktischen KI-Engineering-Fähigkeiten besitzen.

Organisationen, die diese Systeme zum ersten Mal aufbauen, unterschätzen typischerweise die Personalkomplexität. Planen Sie dediziertes Personal ein, das den Lebenszyklus des Modellmanagements besitzt, nicht nur IT-Generalist:innen, die es als sekundäre Verantwortung handhaben.

## **Air-Gapped vs. andere Ansätze privater Bereitstellung**

Die Entscheidung zwischen einem vollständigen Air Gap und einer gut gesicherten privaten Bereitstellung ist nicht immer offensichtlich. Hier ist eine praktische Art, darüber nachzudenken.

Wenn Ihr Hauptanliegen Datenschutz und Compliance ist, erfüllt eine ordnungsgemäß konfigurierte On-Premise-Bereitstellung mit starken Zugriffskontrollen und ohne Exposition gegenüber dem öffentlichen Internet die Anforderung typischerweise ohne den betrieblichen Mehraufwand des echten Air Gapping.

Wenn Ihr Anliegen Bedrohungsakteure mit ausgeklügelten Fähigkeiten umfasst, einschließlich Angriffen auf Nationalstaatsniveau, Insider-Bedrohungen oder jedes Szenario, in dem selbst verschlüsselter Netzwerkverkehr ein inakzeptables Risiko darstellt, dann adressiert Air Gapping das Bedrohungsmodell, das andere Ansätze nicht können.

Die ehrliche Einschätzung für die meisten Unternehmen ist, dass echtes Air Gapping mehr ist, als sie brauchen. Die Unternehmen, die es tatsächlich brauchen, tendieren dazu, zu wissen, dass sie es brauchen, bevor sie mit der Recherche von Optionen beginnen. Die regulatorischen, vertraglichen oder missionskontextuellen Anforderungen treffen die Entscheidung normalerweise für sie.

## **Dinge, die man wissen sollte**

Einige Details, die in frühen Gesprächen über Air-Gapped-KI-Bereitstellungen oft übersehen werden:

Physische Sicherheit ist ebenso wichtig wie digitale Sicherheit. Ein Air-Gapped-System ist nur so sicher wie der Raum, in dem es steht. Physische Zugangskontrollen, Überwachung und Personalüberprüfung sind genauso wichtig wie jede technische Sicherheitsmaßnahme.

Insider-Bedrohungen sind das primäre verbleibende Risiko. Sobald Sie netzwerkbasierte Angriffsvektoren eliminieren, ist die realistische verbleibende Bedrohung jemand mit physischem Zugang zum System. Personalüberprüfung und Zugangsprotokollierung werden zu den vordersten Sicherheitskontrollen.

Aktualisierungen vor der Bereitstellung zu testen, ist enorm wichtig. In einer verbundenen Umgebung kann ein schlechtes Modell-Update schnell zurückgerollt werden. In einer Air-Gapped-Umgebung bedeutet das Zurückrollen einen weiteren physischen Übertragungszyklus. Staging-Umgebungen, die das Air-Gapped-Setup spiegeln, helfen, Probleme zu erkennen, bevor sie die Produktion erreichen.

Energie- und Kühlinfrastruktur erfordern Planung. Air-Gapped-Systeme, die große GPU-Workloads betreiben, erzeugen erhebliche Wärme und ziehen erhebliche Leistung. Die Anlagenplanung muss dies frühzeitig berücksichtigen.

Die Dokumentationsanforderungen sind umfangreich. Jedes Verfahren, das die Air-Gapped-Umgebung betrifft, muss gründlich dokumentiert werden, nicht nur aus Compliance-Gründen, sondern weil prozedurale Konsistenz das ist, was Sicherheitsvorfälle in physischen Übertragungs-Workflows verhindert.

Open-Source-Modelle werden in diesen Umgebungen stark bevorzugt. Proprietäre Modelle, die Lizenzvalidierungsaufrufe oder Nutzungstelemetrieberichte erfordern, sind grundsätzlich mit echter Netzwerkisolation unvereinbar. Das Open-Source-Modellökosystem ist die praktische Grundlage für fast jede Air-Gapped-KI-Bereitstellung.

## **Wann Air-Gapped-KI jedes bisschen des Mehraufwands wert ist**

Die betriebliche Komplexität und der Kostenaufschlag von Air-Gapped-KI sind real. Sie verlangt mehr von Ihrem Team, mehr von Ihren Einrichtungen und mehr von Ihren Planungsprozessen als jeder andere Bereitstellungsansatz. Für Organisationen, bei denen das Bedrohungsmodell dies rechtfertigt, ist dieser Mehraufwand nicht nur akzeptabel, sondern der eigentliche Sinn.

Die Isolation selbst ist das Produkt. Alles andere, was das System tut, Abfragen beantworten, Dokumente analysieren, Anomalien erkennen, Entscheidungen unterstützen, geschieht innerhalb eines Perimeters, den kein externer Akteur erreichen kann. Für Organisationen, die diese Garantie brauchen, liefert keine andere Architektur sie.

## **Häufig gestellte Fragen**

### **Was ist ein Air Gap in der KI?**

**Ein Air Gap in der KI bezeichnet die vollständige physische und Netzwerkisolation des KI-Systems, das heißt keine Internetverbindung, kein externer Netzwerkzugang und keinerlei drahtlose Schnittstellen.** Daten bewegen sich nur durch kontrollierte physische Medienübertragungen hinein und heraus, was es zur sichersten verfügbaren Bereitstellungsarchitektur für sensible KI-Workloads macht.

### **Was bedeutet „air-gapped"?**

**Air-gapped bedeutet, dass ein System physisch von allen externen Netzwerken isoliert ist, mit einer buchstäblichen Luftlücke zwischen ihm und jeder verbundenen Infrastruktur.** Der Begriff stammt aus der militärischen und behördlichen Informatik und hat sich erweitert, um jede Bereitstellung zu beschreiben, bei der Netzwerkisolation als primäre Sicherheitskontrolle verwendet wird.

### **Was ist der 900.000-Dollar-KI-Job?**

**Der 900.000-Dollar-KI-Job bezieht sich typischerweise auf hochspezialisierte KI-Sicherheitsforscher:innen oder leitende KI-Wissenschaftler:innen bei Spitzentechnologieunternehmen, deren Gesamtvergütungspakete aufgrund von Aktien und Boni diesen Bereich erreicht haben.** Rollen, die KI-Engineering-Expertise mit Sicherheitsfreigaben für klassifizierte Umgebungen kombinieren, gebieten ebenfalls außergewöhnliche Vergütungen und spiegeln die Knappheit qualifizierter Kandidat:innen wider, die beide Anforderungen erfüllen.

### **Was ist die 30-%-Regel in der KI?**

**Die 30-%-Regel in der KI ist eine Richtlinie, die nahelegt, dass KI ungefähr 30 % eines bestimmten Workflows automatisieren sollte, wobei die verbleibenden 70 % dem menschlichen Urteil und der Kontextlogik überlassen werden.** Sie hilft Organisationen, realistische Automatisierungsziele zu identifizieren, ohne Prozesse zu überdimensionieren, die immer noch von menschlicher Entscheidungsfindung abhängen.

### **Welche Berufe wird es 2030 nicht mehr geben?**

**Es wird weithin erwartet, dass Rollen, die sich auf repetitive Dateneingabe, einfache Dokumentenverarbeitung, routinemäßige Bearbeitung von Kundenanfragen und manuelle Berichtserstellung konzentrieren, bis 2030 erheblich zurückgehen, da KI-Systeme diese Funktionen absorbieren.** Die meisten Analyst:innen prognostizieren jedoch, dass Berufstransformation statt vollständiger Eliminierung das vorherrschende Muster sein wird, wobei neue Rollen rund um KI-Management, Aufsicht und Bereitstellung entstehen.
