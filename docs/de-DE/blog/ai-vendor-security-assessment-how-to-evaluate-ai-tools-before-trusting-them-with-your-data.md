---
title: "Sicherheitsbewertung von AI-Anbietern: So evaluieren Sie AI-Tools, bevor
  Sie ihnen Ihre Daten anvertrauen"
date: 2026-04-05
description: Eine Sicherheitsbewertung von AI-Anbietern überprüft vor der
  Bereitstellung, ob AI-Tools Ihren Anforderungen an Datenschutz, Compliance und
  Sicherheit entsprechen. So führen Sie sie korrekt durch.
author: triggerfish
tags:
  - AI agent
draft: false
---
Eine Sicherheitsbewertung von AI-Anbietern ist ein strukturierter Evaluierungsprozess, der ermittelt, ob ein Tool oder eine Plattform für künstliche Intelligenz die Sicherheits-, Compliance- und Datenschutzanforderungen einer Organisation erfüllt, bevor diesem Anbieter Zugriff auf Organisationsdaten gewährt oder er in geschäftliche Workflows integriert wird. Sie ersetzt Annahmen durch Belege an dem Punkt im Beschaffungsprozess, an dem die Folgen einer Fehlentscheidung noch beherrschbar sind.

Die meisten Organisationen verfügen über Prozesse zur Sicherheitsbewertung von Anbietern, die für konventionelle Software einigermaßen gut funktionieren. Der Anbieter füllt einen Fragebogen aus. Die Rechtsabteilung prüft den Vertrag. Die IT prüft die Zertifizierungen. Das Tool wird bereitgestellt. Bei AI-Anbietern übersieht dieser Prozess genug, um relevant zu sein. Die Fragen, die die bedeutendsten Risiken in Beziehungen zu AI-Anbietern aufdecken, sind nicht die Fragen auf den üblichen IT-Anbieterfragebögen. Es sind Fragen zur Verwendung von Trainingsdaten für Modelle, zur Rechtsprechungsebene der Inferenzinfrastruktur, dazu, was mit Daten nach Ende eines Gesprächs geschieht, und dazu, ob die vom Anbieter vorgelegte Sicherheitszertifizierung tatsächlich das eingesetzte Produkt abdeckt oder einen ganz anderen Teil seiner Infrastruktur. Die Organisationen, die diese Lücken erst entdecken, nachdem Verträge unterzeichnet wurden und sensible Daten durch Systeme geflossen sind, die sie nicht ordnungsgemäß evaluiert haben, sind diejenigen, die diese Bewertung beim zweiten Mal sorgfältiger durchführen. Dieser Leitfaden erläutert, wie Sie eine Sicherheitsbewertung von AI-Anbietern durchführen, die das Wesentliche erfasst, welche Belege Sie verlangen sollten, anstatt sie auf Zusicherung hin zu akzeptieren, und wie Sie den Bewertungsprozess zu einer wiederholbaren organisatorischen Fähigkeit ausbauen.



![AI agent](/blog/images/procurement.jpg)

## **Warum Standard-Anbieterbewertungen bei AI zu kurz greifen**

### **Die Lücken, die generische Fragebögen übersehen**

Standardisierte IT-Anbieter-Sicherheitsfragebögen wurden für eine Softwareumgebung entwickelt, in der die primären Sicherheitsbedenken die Sicherheit der Datenspeicherung, Zugriffskontrollen und Netzwerkschutz waren. Diese Bedenken gelten auch für AI-Anbieter. AI-Systeme bringen jedoch eine Reihe zusätzlicher Bedenken mit sich, die generische Fragebögen nicht erfassen sollten und die Anbieter nicht von sich aus offenlegen, sofern nicht ausdrücklich danach gefragt wird.

Die Verwendung von Trainingsdaten ist die erste Lücke. Ob ein Anbieter die über sein Produkt übermittelten Daten verwendet, um seine AI-Modelle zu trainieren oder zu verbessern, ist eine der folgenreichsten Fragen zum Umgang mit Daten für Organisationen, die proprietäre oder sensible Informationen über AI-Tools verarbeiten. Diese Frage ist auch in standardmäßigen Anbieterfragebögen nicht enthalten, da sie in der konventionellen Softwarebeschaffung keine Entsprechung hat. Ein Datenbankanbieter trainiert sein Produkt nicht mit Ihren Daten. Ein AI-Anbieter tut das möglicherweise, und ob er es tut oder nicht, ist oft in der Sprache der Nutzungsbedingungen vergraben, anstatt prominent offengelegt zu werden.

Der Standort der Inferenzinfrastruktur ist die zweite Lücke. Wo ein AI-Modell Ihre Daten physisch verarbeitet, bestimmt, welche rechtlichen Rahmenbedingungen auf diese Verarbeitung anwendbar sind, ob grenzüberschreitende Datenübertragungsmechanismen erforderlich sind und welche Rechtsprechung die Offenlegung dieser Daten erzwingen kann. Standardanbieterbewertungen fragen nach dem Speicherort der Daten. AI-Bewertungen müssen separat danach fragen, wo Daten während der Inferenz verarbeitet werden, was möglicherweise eine andere Infrastruktur an einem anderen Standort ist.

Die Geltungsbereichsgrenze von Sicherheitszertifizierungen ist die dritte Lücke. Ein Anbieter kann einen SOC 2 Type 2-Bericht vorlegen, der seine Cloud-Infrastruktur abdeckt, während das spezifische zu bewertende AI-Produkt auf einer anderen Infrastruktur läuft, die nicht im Prüfungsumfang enthalten ist. Ohne zu überprüfen, dass die vorgelegten Zertifizierungen das spezifische Produkt und die Infrastruktur abdecken, die für Ihre Bereitstellung relevant sind, kann eine Zertifizierungsprüfung ein falsches Vertrauen in eine Bereitstellung vermitteln, die nie geprüft wurde.

Zu verstehen, wie sich die Anforderungen an die [AI security](https://trigger.fish/security/)-Bewertung von der konventionellen Anbieter-Sicherheitsbewertung unterscheiden, hilft Organisationen dabei, Bewertungsprozesse aufzubauen, die die tatsächliche AI-Risikolandschaft adressieren und nicht die konventionelle Softwarerisikolandschaft, für die diese Prozesse ursprünglich konzipiert wurden.



![AI agent](/blog/images/security-reviewing.jpg)

## **Aufbau des Rahmens für die AI-Anbieter-Sicherheitsbewertung**

### **Die fünf Bereiche, die jede Bewertung abdecken muss**

Eine effektive Sicherheitsbewertung von AI-Anbietern strukturiert ihre Evaluierung in fünf Bereichen, die zusammen ein vollständiges Bild der Sicherheitslage des Anbieters für die spezifische in Betracht gezogene Bereitstellung liefern. Jeder Bereich adressiert eine eigene Dimension des Risikos, die die anderen nicht abdecken; deshalb übersehen Bewertungen, die sich auf einen oder zwei Bereiche konzentrieren und die übrigen auslassen, konsequent wesentliche Risiken.

**Technische Sicherheit** umfasst die Infrastrukturkontrollen, die die von den AI-Systemen des Anbieters verarbeiteten Daten schützen. Dies ist der Bereich, der sich am stärksten mit der konventionellen Anbieter-Sicherheitsbewertung überschneidet, und umfasst Verschlüsselungsstandards, die Netzwerksicherheitsarchitektur, Praktiken des Schwachstellenmanagements, Fähigkeiten zur Erkennung und Reaktion auf Vorfälle sowie die physische Sicherheit der Infrastruktur, die die AI-Workloads betreibt.

**Daten-Governance** umfasst, was der Anbieter mit Organisationsdaten während ihres gesamten Lebenszyklus in seinen Systemen tut. Dieser Bereich umfasst Richtlinien zur Nutzung von Trainingsdaten, Praktiken zur Aufbewahrung von Inferenzprotokollen, Fähigkeiten und Zeitpläne zur Datenlöschung, Beziehungen zu Unterauftragsverarbeitern und deren Datenzugriff, Mechanismen zur grenzüberschreitenden Datenübermittlung sowie die vertraglichen Schutzmaßnahmen, die alles Vorstehende regeln.

**Compliance und Zertifizierung** umfasst die unabhängige Überprüfung der Sicherheitsangaben des Anbieters und die regulatorischen Rahmenbedingungen, die sein Produkt unterstützen kann. Dieser Bereich umfasst die Überprüfung spezifischer Zertifizierungsdokumente anstelle der Akzeptanz von Anbieteraussagen, die Überprüfung des Umfangs und der Aktualität der Zertifizierung, die Bewertung der Verfügbarkeit erforderlicher Datenvereinbarungen und die Bestätigung der Unterstützung sektorspezifischer Compliance-Anforderungen, die für Ihre Organisation gelten.

**AI-spezifische Sicherheit** umfasst die für AI-Systeme einzigartigen Risiken, die in konventionellen Software-Anbieterbewertungen kein Äquivalent haben. Dieser Bereich umfasst die Anfälligkeit für Prompt Injection und entsprechende Gegenmaßnahmen, Tests der adversariellen Robustheit, Schutzmaßnahmen vor Modellextraktion, Halluzinationsraten und Gegenmaßnahmen für den konkreten Anwendungsfall, der bereitgestellt wird, sowie den Ansatz des Anbieters zur Verwaltung von Modellaktualisierungen und Verhaltensänderungen.

**Operative Sicherheit** umfasst die Sicherheitspraktiken des Anbieters als Organisation, nicht die technischen Kontrollen seines spezifischen Produkts. Dieser Bereich umfasst die Struktur und Expertise des Sicherheitsteams, Praktiken zur Offenlegung von Sicherheitslücken und zum Schwachstellenmanagement, Prozesse zur Meldung von Sicherheitsverletzungen und die historischen Vorfallsprotokolle sowie die eigene Lieferkettensicherheit des Anbieters für die Komponenten und Dienste, von denen sein AI-Produkt abhängt.


<table>
  <thead>
    <tr>
      <th>Bewertungsbereich</th>
      <th>Hauptfragen</th>
      <th>Erforderliche Belege</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Technische Sicherheit</td>
      <td>Verschlüsselungsstandards, Netzwerkarchitektur, Schwachstellenmanagement</td>
      <td>SOC 2 Type 2-Bericht, Zusammenfassungen von Penetrationstests</td>
    </tr>
    <tr>
      <td>Daten-Governance</td>
      <td>Nutzung von Trainingsdaten, Aufbewahrungsfristen, Löschfähigkeiten, Unterauftragsverarbeiter</td>
      <td>Vertragsbedingungen, Datenverarbeitungsvereinbarung, Liste der Unterauftragsverarbeiter</td>
    </tr>
    <tr>
      <td>Compliance und Zertifizierung</td>
      <td>Umfang und Aktualität der Zertifizierung, Verfügbarkeit von Datenvereinbarungen, regulatorische Unterstützung</td>
      <td>Aktuelle Zertifizierungsdokumente, unterzeichnete DPA oder BAA</td>
    </tr>
    <tr>
      <td>AI-spezifische Sicherheit</td>
      <td>Kontrollen gegen Prompt Injection, adversarielle Robustheit, Praktiken bei Modellaktualisierungen</td>
      <td>Technische Dokumentation, Ergebnisse von Sicherheitstests</td>
    </tr>
    <tr>
      <td>Operative Sicherheit</td>
      <td>Sicherheitsteam, Offenlegungspraktiken, Vorfallshistorie, Lieferkette</td>
      <td>Sicherheitsoffenlegungen, Historie der Vorfallsmeldungen</td>
    </tr>
  </tbody>
</table>



### **Der Beweismaßstab, der Bewertung von Akzeptanz unterscheidet**

Die wichtigste Disziplin bei der Sicherheitsbewertung von AI-Anbietern besteht darin, Belege zu verlangen, anstatt Behauptungen zu akzeptieren. Sicherheitsangaben von Anbietern in Verkaufsgesprächen, Marketingmaterialien und selbst in vom Anbieter ausgefüllten Fragebögen sind keine unabhängig überprüften Tatsachenaussagen. Es sind Darstellungen, deren Richtigkeit von der eigenen Einschätzung des Anbieters zu seiner Sicherheitslage und seinem kommerziellen Anreiz abhängt, diese günstig darzustellen.

Eine evidenzbasierte Bewertung erfordert, dass jede bedeutsame Sicherheitsangabe durch Dokumentation belegt wird, die eine unabhängige Stelle überprüft hat oder die die Organisation direkt überprüfen kann. Ein Anbieter, der SOC 2-Compliance behauptet, sollte den tatsächlichen SOC 2-Bericht vorlegen, keine Zusammenfassung oder ein Abzeichen. Der Bericht sollte gelesen, nicht nur entgegengenommen werden, mit Aufmerksamkeit für die Geltungsbereichsgrenze, den Prüfzeitraum, die spezifisch getesteten Kontrollen sowie etwaige festgestellte Ausnahmen oder Abweichungen. Ein Anbieter, der behauptet, sein Produkt verwende keine Kundendaten für das Modelltraining, sollte dieses Verbot in den vertraglichen Bedingungen dokumentiert haben, die die Beziehung regeln, nicht nur in einem Verkaufsgespräch erklärt.

Die Überprüfungsdisziplin erstreckt sich auch auf die Zertifizierungen selbst. SOC 2-Auditoren unterscheiden sich in Qualität und Strenge. Ein Auditbericht eines anerkannten Unternehmens mit nachgewiesener Expertise im Technologiebereich liefert stärkere Belege als ein Bericht eines unbekannten Unternehmens mit begrenzter Technologie-Audit-Historie. Der Berichtszeitraum ist von Bedeutung, da ein Bericht über einen sehr kurzen Prüfzeitraum eine erstmalige Prüfung widerspiegeln kann, die darauf abzielt, schnell eine Zertifizierung zu erlangen, anstatt ein ausgereiftes, dauerhaftes Sicherheitsprogramm.

Eine Überprüfung, wie die Dokumentation zur [AI architecture](https://trigger.fish/architecture/) von Anbietern ihre Sicherheitskontrollen beschreibt, hilft Prüfern bei der Beurteilung, ob die dargestellte technische Architektur kohärent und verteidigungsfähig ist oder ob sie Sicherheit auf einer Abstraktionsebene beschreibt, die bedeutsame Lücken verbirgt.

## **Die AI-spezifischen Fragen, die am wichtigsten sind**

### **Was zur Verwendung von Trainingsdaten zu fragen ist**

Die Frage zur Verwendung von Trainingsdaten erfordert mehr Präzision als eine Ja-oder-Nein-Antwort, da die Praktiken, die ein bedeutsames Risiko schaffen, spezifischer sind, als die allgemeine Frage erfasst. Ein Anbieter, der antwortet, dass er keine Kundendaten zum Training verwendet, könnte etwas Engeres meinen, als die Frage impliziert.

Fragen Sie, ob Gesprächsinhalte, einschließlich Prompts und Antworten, unter irgendwelchen Umständen für das Modelltraining oder Fine-Tuning verwendet werden, einschließlich mit über die Nutzungsbedingungen erteilter Kundenzustimmung. Fragen Sie, ob aggregierte oder anonymisierte Versionen von Kundendaten zur Modellverbesserung beitragen. Fragen Sie, ob das Verbot für alle Produktstufen gilt oder nur für die zu bewertende Enterprise-Stufe. Fragen Sie, ob das Verbot absolut ist oder durch Kundenzustimmung aufgehoben werden kann. Und fragen Sie, wie das Verbot technisch durchgesetzt wird, nicht nur vertraglich, da ein vertragliches Verbot, das nicht technisch durchgesetzt wird, vollständig auf der operativen Compliance des Anbieters beruht, anstatt auf architektonischen Garantien.

Die Antworten auf diese spezifischen Folgefragen offenbaren oft, dass die Praktiken zur Nutzung von Trainingsdaten nuancierter sind, als ursprüngliche Anbieteraussagen vermuten lassen, und dass sich der auf der zu bewertenden Enterprise-Stufe verfügbare Schutz auf eine Weise von den Standardproduktbedingungen unterscheiden kann, die für den spezifischen zu bewertenden Anwendungsfall wichtig ist.

### **Was zur Inferenzinfrastruktur und zum Datenstandort zu fragen ist**

Die Infrastrukturfrage für AI-Systeme erfordert separate Fragen dazu, wo Modellgewichte gespeichert sind, wo Inferenz rechnerisch stattfindet, wo Eingabedaten verarbeitet werden, wo Ausgabedaten und Protokolle gespeichert werden und wo all dies im Kontext der spezifischen Produktstufe geschieht, die bereitgestellt wird, anstatt im Kontext der Infrastruktur des Anbieters im Allgemeinen.

Für Organisationen mit Datenresidenz-Verpflichtungen ist die Frage nach dem Standort der Inferenz oft unmittelbar folgenreicher als die Frage nach dem Speicherort, da die regulatorischen Rahmenbedingungen, die in den meisten Rechtsordnungen Residenz-Anforderungen vorschreiben, die Verarbeitungsrechtsordnung mit der Speicherrechtsordnung gleichsetzen. Ein Anbieter, dessen Speicherinfrastruktur sich in der erforderlichen Rechtsordnung befindet, dessen Inferenzverarbeitung jedoch anderswo stattfindet, hat die Residenz-Anforderung nicht erfüllt, selbst wenn die Speicherkontrollen vollständig konform sind.

Fordern Sie vom Anbieter ein Datenflussdiagramm an, das Organisationsdaten von der Übermittlung über die Inferenz, die Ausgabe und die Protokollierung bis zur Löschung verfolgt und dabei den physischen Standort jeder Stufe klar angibt. Wenn der Anbieter diese Dokumentation nicht erstellen kann, ist die Lücke in seinem eigenen Verständnis seiner Datenflüsse selbst eine bedeutsame Sicherheitserkenntnis.



![AI agent](/blog/images/security-team-review.jpg)

### **Was zu Modellaktualisierungen und Verhaltensänderungen zu fragen ist**

AI-Anbieter aktualisieren ihre zugrunde liegenden Modelle nach Zeitplänen, die den Kunden nicht immer im Voraus mitgeteilt werden. Eine Modellaktualisierung kann das Verhalten eines AI-Systems auf Weisen ändern, die seine Sicherheitslage, seine Einhaltung der Anforderungen des Kunden an die zulässige Nutzung oder seine Ausgabequalität für den spezifischen Anwendungsfall, für den der Kunde es bereitgestellt hat, beeinflussen.

Fragen Sie, wie der Anbieter Kunden über Modellaktualisierungen informiert, die für Sicherheit oder Compliance relevantes Verhalten betreffen. Fragen Sie, ob Enterprise-Kunden die Option haben, bei einer bestimmten Modellversion zu bleiben, anstatt automatische Updates zu erhalten. Fragen Sie, wie der Anbieter Modellaktualisierungen auf Sicherheitsregressionen testet, bevor er sie in Kundenumgebungen einsetzt. Und fragen Sie, welcher Rechtsweg dem Kunden zur Verfügung steht, falls eine Modellaktualisierung das Verhalten so verändert, dass dies Compliance oder Sicherheit in der Bereitstellung des Kunden beeinträchtigt.

Die Antworten zeigen den Grad der Kontrolle, den die Organisation über eine Kernkomponente ihres bereitgestellten AI-Systems haben wird, sowie die Philosophie des Anbieters zur Kundenbeteiligung am Modelllebenszyklus. Organisationen, deren bereitgestellte AI-Systeme in regulierten Kontexten oder bei der Entscheidungsunterstützung mit hohem Risiko eingesetzt werden, haben ein stärkeres Interesse an Modellstabilität und Update-Benachrichtigung als solche, die AI für Produktivitätsanwendungen mit geringerem Risiko nutzen.

## **Vertragliche Schutzmaßnahmen, die die Bewertung etablieren muss**

### **Die Vereinbarungen, die vor dem Datenfluss vorliegen müssen**

Die Vertragsphase einer AI-Anbieter-Sicherheitsbewertung übersetzt die technischen und Governance-Erkenntnisse in rechtlich durchsetzbare Schutzmaßnahmen. Technische Kontrollen schützen Daten auf der Infrastruktur des Anbieters. Vertragliche Schutzmaßnahmen definieren die rechtlichen Verpflichtungen, die regeln, wie diese Infrastruktur betrieben wird und welche Rechtsmittel der Organisation zustehen, wenn Verpflichtungen nicht eingehalten werden.

Eine Datenverarbeitungsvereinbarung, die das spezifische bereitgestellte AI-Produkt abdeckt, ist die grundlegende vertragliche Anforderung für jeden Anbieter, der personenbezogene Daten verarbeitet, die der DSGVO, CCPA oder gleichwertigen Rahmenwerken unterliegen. Die DPA muss ausdrücklich das Verbot von Trainingsdaten, Aufbewahrungsfristen nach Kategorien, Verpflichtungen zum Management von Unterauftragsverarbeitern, Zeitpläne zur Datenlöschung und Anforderungen zur Meldung von Sicherheitsverletzungen behandeln. Eine DPA-Vorlage eines Anbieters, die für allgemeine Cloud-Dienste entworfen wurde, behandelt möglicherweise nicht angemessen die AI-spezifischen Überlegungen, die die Bewertung als relevant identifiziert hat.

Für Organisationen im Gesundheitswesen ist ein Business Associate Agreement eine rechtliche Voraussetzung, bevor irgendwelche Daten, die geschützte Gesundheitsinformationen darstellen könnten, durch das AI-System des Anbieters fließen. Das BAA muss das spezifische bereitgestellte Produkt abdecken, nicht nur die Infrastruktur des Anbieters allgemein, und muss bestätigen, dass die Datenhandhabungspraktiken des AI-Produkts mit den HIPAA-Anforderungen an technische Schutzvorkehrungen übereinstimmen.

Zu verstehen, wie [AI features](https://trigger.fish/features/) in Enterprise-AI-Plattformen relativ zu den zu verhandelnden vertraglichen Schutzmaßnahmen strukturiert sind, hilft Organisationen, zu erkennen, wo Produktverhalten und Vertragsbedingungen konsistent sind und wo die technische Realität des Produkts zusätzliche vertragliche Spezifität erfordert, um den Schutz zu erreichen, den die Organisation benötigt.


<table>
  <thead>
    <tr>
      <th>Erforderliche Vereinbarung</th>
      <th>Wann sie gilt</th>
      <th>Kritische Bedingungen für AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Datenverarbeitungsvereinbarung</td>
      <td>Jede Verarbeitung personenbezogener Daten unter DSGVO oder gleichwertig</td>
      <td>Verbot von Trainingsdaten, Aufbewahrungsgrenzen, Liste der Unterauftragsverarbeiter</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Jede Verarbeitung von PHI unter HIPAA</td>
      <td>Produktspezifische Abdeckung, Bestätigung technischer Schutzvorkehrungen</td>
    </tr>
    <tr>
      <td>Master Services Agreement</td>
      <td>Alle kommerziellen Anbieterbeziehungen</td>
      <td>Haftungszuweisung, Rechtsmittel bei Verstößen, Datenrückgabe bei Kündigung</td>
    </tr>
    <tr>
      <td>Sicherheitsaddendum</td>
      <td>Kontexte mit hochsensibler Datenverarbeitung</td>
      <td>Spezifische Sicherheitsverpflichtungen jenseits Standardbedingungen</td>
    </tr>
    <tr>
      <td>Modellrisiko-Dokumentation</td>
      <td>AI in regulierten Finanzaktivitäten</td>
      <td>Modelldokumentation, Validierungsrechte, Update-Benachrichtigung</td>
    </tr>
    <tr>
      <td>Geheimhaltungsvereinbarung</td>
      <td>Bewertungsprozess selbst und sensible Erkenntnisse</td>
      <td>Geltungsbereich für Bewertungsmethodik und organisatorische Anforderungen</td>
    </tr>
  </tbody>
</table>



### **Verhandeln über Standardbedingungen hinaus**

Die meisten Enterprise-AI-Anbieterverträge beginnen mit Standardbedingungen, die zugunsten des Anbieters entworfen sind. Der Bewertungsprozess sollte die spezifischen Bedingungen identifizieren, die basierend auf den Sicherheitserkenntnissen und Compliance-Anforderungen der Organisation geändert werden müssen, anstatt gegen die Standardbedingungen in ihrer Gesamtheit ohne Priorisierung zu verhandeln.

Die Bedingungen mit der höchsten Verhandlungspriorität sind diejenigen, die die Sicherheits- und Compliance-Risiken, die die Bewertung identifiziert hat, am unmittelbarsten beeinflussen. Klauseln zur Nutzung von Trainingsdaten, die eine Nutzung erlauben, die die Organisation verboten haben muss. Haftungsbeschränkungen, die für die verarbeiteten Datenkategorien unzureichend sind. Fristen zur Meldung von Sicherheitsverletzungen, die die regulatorischen Anforderungen nicht erfüllen. Genehmigungsrechte für Unterauftragsverarbeiter, die dem Anbieter mehr Flexibilität zur Änderung seiner Infrastruktur einräumen, als die Compliance-Anforderungen der Organisation zulassen können.

Organisationen mit erheblicher Beschaffungsmacht, sei es durch Auftragsvolumen, Markenwert oder Marktposition, erreichen oft bedeutsame Verbesserungen der Standard-AI-Anbieterbedingungen genau in diesen Punkten, weil die Anbieter die Beziehung ausreichend schätzen, um Anforderungen aufzunehmen, die über ihre Standardvorlage hinausgehen. Organisationen mit begrenztem Einfluss können manchmal das gleiche Ergebnis erzielen, indem sie Anforderungen als regulatorische Notwendigkeit anstatt als Präferenz darstellen, da Anbieter kommerzielle Interessen an der Unterstützung konformer Bereitstellungen haben, die über jede einzelne Kundenbeziehung hinausgehen.

Ein gründlicher [AI guide](https://trigger.fish/guide/) zur Strukturierung von AI-Anbieterverträgen für Sicherheit und Compliance hilft Organisationen dabei, Verhandlungsrahmen aufzubauen, die die Bedingungen priorisieren, die ihr tatsächliches Risikoengagement am meisten beeinflussen, anstatt zu versuchen, jede Klausel mit gleicher Intensität zu verhandeln.

## **Bewertung in einen wiederholbaren Prozess einbauen**

### **Der skalierende Bewertungs-Workflow**

Organisationen, die AI-Anbieter-Sicherheitsbewertungen als einmalige Projekte für jede bedeutsame AI-Beschaffung durchführen, bauen institutionelles Wissen auf, das sich nicht effizient auf nachfolgende Bewertungen übertragen lässt. Organisationen, die die Bewertung als wiederholbaren Prozess mit dokumentierter Methodik, standardisierten Belegvorlagen und definierten Entscheidungskriterien aufbauen, entwickeln eine Fähigkeit, die jede Bewertung schneller und konsistenter macht als die vorherige.

Ein wiederholbarer AI-Anbieter-Sicherheitsbewertungsprozess umfasst einen standardisierten Fragebogen, der speziell für AI-Anbieter entwickelt wurde und die fünf Bewertungsbereiche abdeckt, eine Liste mit Dokumentenanforderungen, die die genauen Belege für jede wesentliche Sicherheitsangabe spezifiziert, einen Bewertungs- oder Entscheidungsrahmen, der Bewertungserkenntnisse in Bereitstellungsempfehlungen übersetzt, einen Überprüfungsprozess, der die richtigen Stakeholder aus Sicherheit, Recht, Compliance und Geschäftsfunktionen einbezieht, sowie einen Dokumentationsstandard, der Aufzeichnungen erzeugt, die sowohl für die interne Governance als auch für externe regulatorische Prüfungen nützlich sind.

Der Fragebogen und die Liste der Dokumentenanforderungen sollten mindestens jährlich überprüft und aktualisiert werden, um neue AI-spezifische Sicherheitsüberlegungen aufzunehmen, die aus der Anbieterlandschaft, dem regulatorischen Umfeld und der eigenen Bereitstellungserfahrung der Organisation hervorgegangen sind. Das Bewertungswerkzeug, das vor zwölf Monaten umfassend war, kann heute bedeutsame Lücken aufweisen, da sich die AI-Sicherheitsbedrohungslandschaft und die regulatorischen Erwartungen weiterentwickeln.

### **Laufende Bewertung über die anfängliche Beschaffung hinaus**

Eine zum Zeitpunkt der Beschaffung durchgeführte AI-Anbieter-Sicherheitsbewertung liefert eine momentane Bewertung der Sicherheitslage des Anbieters. Sie bietet keine fortlaufende Sicherheit, dass die Lage angemessen bleibt, wenn sich das Produkt des Anbieters weiterentwickelt, sich seine Infrastruktur ändert, sich seine Eigentumsverhältnisse oder seine finanzielle Lage verschieben oder neue Sicherheitslücken in seinem Technologie-Stack auftreten.

Die laufende Bewertung für bedeutende AI-Anbieter sollte eine jährliche Überprüfung aktualisierter Zertifizierungen und Sicherheitsdokumentationen, eine Überprüfung etwaiger Sicherheitsvorfallsoffenlegungen oder Verletzungsbenachrichtigungen des Anbieters, eine Bewertung wesentlicher Änderungen der Nutzungsbedingungen oder Datenschutzrichtlinien des Anbieters, die die anfangs bewerteten Datenhandhabungspraktiken betreffen, sowie eine Überprüfung etwaiger wesentlicher Änderungen am AI-Produkt, der Infrastruktur oder den Eigentumsverhältnissen des Anbieters umfassen, die die der anfänglichen Bewertung zugrunde liegenden Sicherheitsannahmen betreffen könnten.

Organisationen, die die AI-Anbieter-Sicherheitsbewertung als Beschaffungskontrollpunkt anstatt als fortlaufende Praxis des Beziehungsmanagements behandeln, akkumulieren die allmähliche Drift zwischen ihren dokumentierten Sicherheitsannahmen und der tatsächlichen Sicherheitslage des Anbieters, die die Entdeckung von Vorfällen im Vergleich zur proaktiven Überwachung so kostspielig macht.

## **Was Sie wissen sollten**

Mehrere wichtige Realitäten zur AI-Anbieter-Sicherheitsbewertung, denen Organisationen mit der Reifung ihrer Programme konsequent begegnen:

Der Bewertungsumfang muss genau dem Bereitstellungsumfang entsprechen. Eine Sicherheitsbewertung, die die Enterprise-API eines Anbieters abdeckt, bietet keine Gewähr für das Verbraucherprodukt des Anbieters. Eine Bewertung, die das Textgenerierungsprodukt eines Anbieters abdeckt, deckt sein Bildgenerierungsprodukt nicht ab, selbst wenn beide denselben Markennamen tragen. Definieren Sie das spezifische Produkt, die Stufe und die Bereitstellungskonfiguration, die bewertet werden, und bestätigen Sie, dass jede überprüfte Zertifizierung und vertragliche Schutzmaßnahme diesen spezifischen Geltungsbereich abdeckt.

Referenzkundengespräche ergänzen die Dokumentenprüfung auf Weisen, die Dokumentation nicht replizieren kann. Gespräche mit Organisationen ähnlicher Größe, Branche und regulatorischem Profil, die dasselbe AI-Produkt eines Anbieters bereitgestellt haben, bieten qualitative Einblicke in die Reaktionsfähigkeit des Anbieters, in tatsächliche Datenhandhabungspraktiken im Vergleich zu dokumentierten und in die praktische Erfahrung des Betriebs der Anbieterbeziehung, die keine Dokumentenprüfung erfasst.

Die finanzielle Stabilität des Anbieters ist eine legitime Sicherheitsbewertungsdimension. Ein AI-Anbieter, der den Betrieb einstellt, schafft Herausforderungen bei Datenportabilität, Löschung und Audit-Trail, die zu Compliance-Problemen werden können. Die Bewertung der finanziellen Gesundheit, des Finanzierungshorizonts und der Marktposition des Anbieters ist für AI-Anbieter angemessen, die für bedeutende Produktionsbereitstellungen in Betracht gezogen werden, insbesondere für solche, bei denen extrahierte oder trainierte Daten fortlaufende Abhängigkeiten erzeugen.

Das 30%-Prinzip gilt für die Zuteilung des Bewertungsaufwands. Etwa 30% des Bewertungsaufwands sollten in den Bereich der technischen Sicherheit fließen, in den Bewertungsprozesse am häufigsten relativ zu seinem tatsächlichen Risikobeitrag überinvestieren. Die verbleibenden 70% sollten Daten-Governance, vertragliche Schutzmaßnahmen, AI-spezifische Risiken und die operativen Sicherheitsdimensionen abdecken, die die bedeutendsten Unterscheidungen zwischen Anbietern offenbaren, deren Zertifizierungen oberflächlich ähnlich aussehen.

Bewertungserkenntnisse müssen an Geschäfts-Stakeholder in Risikobegriffen und nicht in technischer Sprache kommuniziert werden. Eine Feststellung, dass der SOC 2-Auditumfang eines Anbieters die AI-Inferenzinfrastruktur ausschließt, ist technisch korrekt, aber für Geschäftsentscheider ohne Übersetzung in Geschäftsrisikobegriffe nicht handlungsfähig. Die Feststellung, dass der Anbieter die Sicherheit der Systeme, die Ihre sensibelsten Daten verarbeiten werden, nicht unabhängig überprüft hat, ist dieselbe Feststellung in einer Sprache, die Entscheidungen hervorbringt.

Trigger für eine Neubewertung müssen im Voraus definiert werden. Spezifische Ereignisse, die eine frische oder teilweise AI-Anbieter-Sicherheitsbewertung auslösen sollten, einschließlich bedeutender Anbietervorfälle, wesentlicher Änderungen der Nutzungsbedingungen, Übernahmen oder Eigentumsänderungen des Anbieters und bedeutender Änderungen der Produktarchitektur, sollten im Bewertungsprozess definiert werden, anstatt ad hoc bestimmt zu werden, wenn diese Ereignisse eintreten.

## **AI-Anbieter-Sicherheitsbewertung als Werkzeug zur wettbewerblichen Auswahl**

Organisationen, die gründliche AI-Anbieter-Sicherheitsbewertungen durchführen, stellen konsequent fest, dass der Prozess mehr leistet als nur die Identifizierung inakzeptabler Anbieter. Er offenbart bedeutsame Differenzierungen zwischen Anbietern, deren Zertifizierungen und Marketing ähnlich erscheinen, deren tatsächliche Sicherheitspraktiken sich aber erheblich unterscheiden, wenn sie auf der Ebene der Belege statt der Behauptungen geprüft werden.

Diese Differenzierung ist über ihren Risikomanagement-Wert hinaus kommerziell nützlich. Anbieter, die in echte Sicherheitsinfrastruktur investieren, aktuelle und umfassende Zertifizierungen aufrechterhalten, transparente Datenhandhabungspraktiken betreiben und die vertraglichen Schutzmaßnahmen unterstützen, die regulierte Organisationen benötigen, haben Sicherheit zu einem Wettbewerbsvorteil und nicht zu einem Compliance-Kostenfaktor gemacht. Die Identifizierung dieser Anbieter durch rigorose Bewertung und der Aufbau dauerhafter Beziehungen mit ihnen erbringt Beschaffungsergebnisse, deren Wert sich vermehrt, während sich die AI-Tool-Landschaft weiterentwickelt und sich die Sicherheitsanforderungen weiter verschärfen.

Die AI-Anbieter-Sicherheitsbewertung ist der Punkt, an dem das Engagement für eine verantwortungsvolle AI-Einführung auf die operative Realität trifft, zu entscheiden, wem die Daten anvertraut werden, die am wichtigsten sind. Organisationen, die diese Arbeit gründlich, konsequent und mit den ihr gebührenden Beweismaßstäben leisten, bauen Anbieterbeziehungen auf, die ihre AI-Ambitionen unterstützen, anstatt die unentdeckten Verbindlichkeiten zu schaffen, die unzureichende Bewertung unweigerlich hinterlässt.

## **Häufig gestellte Fragen**

### **Wie evaluiert man AI-Anbieter?**

**Die Evaluierung von AI-Anbietern erfordert eine strukturierte Bewertung über fünf Bereiche hinweg: technische Sicherheitskontrollen, verifiziert durch aktuelle Zertifizierungsdokumente; Daten-Governance-Praktiken zur Nutzung und Aufbewahrung von Trainingsdaten, verifiziert durch Vertragsbedingungen; Umfang und Aktualität der Compliance-Zertifizierung, verifiziert durch tatsächliche Berichte und nicht durch Anbieteraussagen; AI-spezifische Sicherheitsüberlegungen einschließlich Kontrollen gegen Prompt Injection und Praktiken bei Modellaktualisierungen; und operative Sicherheit, die die organisatorischen Sicherheitspraktiken und die Vorfallshistorie des Anbieters abdeckt.** Die Bewertung führt zu Bereitstellungsentscheidungen, die auf Belegen und nicht auf Anbieterbehauptungen beruhen, wobei vertragliche Schutzmaßnahmen etabliert werden, bevor irgendwelche Organisationsdaten durch das System des Anbieters fließen.

### **Was ist die Sicherheitsbewertung mit AI?**

**Eine Sicherheitsbewertung mit AI bezieht sich auf die Anwendung von Werkzeugen der künstlichen Intelligenz zur Verbesserung der Effizienz und Abdeckung von Sicherheitsbewertungsprozessen, einschließlich der Verwendung von AI zur Analyse von Anbieterdokumentationen auf sicherheitsrelevante Klauseln, zur Automatisierung der Analyse von Fragebogenantworten über mehrere Anbietereinreichungen hinweg, zur kontinuierlichen Überwachung von Sicherheitsoffenlegungen und Vorfallsbenachrichtigungen von Anbietern und zur Identifizierung von Mustern in Daten zur Sicherheitslage von Anbietern, die manuelle Überprüfungsprozesse übersehen würden.** Sie unterscheidet sich von der AI-Anbieter-Sicherheitsbewertung, die die Sicherheit der AI-Tools selbst evaluiert, obwohl Organisationen mit reifen Sicherheitsprogrammen zunehmend AI nutzen, um sowohl ihre AI-Anbieterbewertungsprozesse als auch ihre breiteren Fähigkeiten zur Sicherheitsbewertung zu verbessern.

### **Was ist eine Anbieter-Sicherheitsbewertung?**

**Eine Anbieter-Sicherheitsbewertung ist eine strukturierte Evaluierung der Sicherheitskontrollen, Datenhandhabungspraktiken, Compliance-Zertifizierungen und vertraglichen Schutzmaßnahmen eines Drittanbieters von Technologie, bevor diesem Anbieter Zugriff auf Organisationsdaten gewährt oder er in Geschäftssysteme integriert wird.** Für AI-Anbieter im Besonderen erstreckt sich die Bewertung über die konventionelle Anbieter-Sicherheitsbewertung hinaus, um die AI-spezifischen Risiken der Nutzung von Trainingsdaten, der Rechtsprechung der Inferenzinfrastruktur, der Praktiken bei Modellaktualisierungen und der AI-spezifischen Angriffsflächen zu adressieren, die standardmäßige IT-Anbieterfragebögen nicht erfassen sollten.

### **Welche Maßnahmen können ergriffen werden, um sicherzustellen, dass ein AI-Lieferant sicher ist?**

**Die fünf wichtigsten Maßnahmen, um sicherzustellen, dass ein AI-Lieferant sicher ist, sind: die Anforderung aktueller SOC 2 Type 2 oder gleichwertiger Zertifizierungsdokumente, die das spezifische bereitgestellte Produkt und die Infrastruktur abdecken; die Beschaffung unterzeichneter Datenverarbeitungsvereinbarungen mit ausdrücklichen Verboten zur Nutzung von Trainingsdaten und definierten Aufbewahrungsgrenzen, bevor irgendwelche Organisationsdaten verarbeitet werden; die Überprüfung, dass sich die Inferenzinfrastruktur in Rechtsordnungen befindet, die geltende Datenresidenz-Anforderungen erfüllen; die Bestätigung durch vertragliche Bedingungen und technische Dokumentation, dass die Sicherheitskontrollen des Anbieters AI-spezifische Risiken einschließlich Prompt Injection und Modellextraktion adressieren; und die Etablierung eines fortlaufenden Anbieter-Überwachungsprozesses, der Zertifizierungserneuerungen, Vorfallsoffenlegungen und wesentliche Änderungen der Nutzungsbedingungen in einem definierten jährlichen Zyklus überprüft.** Zusammen schaffen diese Maßnahmen eine Sicherheitsbeziehung zum AI-Lieferanten, die auf verifizierten Belegen und durchsetzbaren Verpflichtungen statt auf unverifizierten Behauptungen und angenommener Treu und Glauben beruht.

### **Welche 5 Sicherheitsmaßnahmen gibt es?**

**Die fünf grundlegenden Sicherheitsmaßnahmen, die in allen AI-Anbieterbeziehungen gelten, sind: die Verschlüsselung von Daten bei der Übertragung und im Ruhezustand unter Verwendung aktueller Standards mit dokumentierten Schlüsselverwaltungspraktiken; Zugriffskontrollen, die einschränken, wer in der Anbieterorganisation unter welchen Bedingungen auf Organisationsdaten zugreifen kann; umfassende Protokollierung aller Datenzugriffs- und Verarbeitungsereignisse mit Aufbewahrungsfristen, die Vorfalluntersuchungen unterstützen; Praktiken des Schwachstellenmanagements, einschließlich regelmäßiger Sicherheitstests und definierter Behebungszeitpläne für identifizierte Schwachstellen; und Prozesse zur Meldung von Sicherheitsverletzungen, die den Anbieter zu zeitnaher Offenlegung mit spezifischen Zeitplänen verpflichten, die die regulatorischen Meldepflichten der Organisation erfüllen.** Diese fünf Maßnahmen stellen die technische Sicherheitsgrundlinie dar, die für jeden AI-Anbieter, der für bedeutende Datenverarbeitungsverantwortlichkeiten bewertet wird, durch Belege verifiziert werden sollte, wobei die AI-spezifischen Bewertungsdimensionen über diese konventionelle Sicherheitsgrundlage gelegt werden.
