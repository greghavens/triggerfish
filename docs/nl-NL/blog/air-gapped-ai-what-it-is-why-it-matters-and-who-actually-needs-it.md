---
title: "  Air gapped AI: wat het is, waarom het ertoe doet en wie het echt nodig heeft"
date: 2026-03-06
description: Air gapped AI draait op geïsoleerde systemen zonder
  internetverbinding en biedt organisaties maximale gegevensbeveiliging en
  volledige controle over gevoelige AI-workloads.
author: triggerfish
tags:
  - AI agent
draft: false
---


Air gapped AI verwijst naar systemen voor kunstmatige intelligentie die worden uitgerold op hardware die fysiek en logisch geïsoleerd is van het internet en van elk extern netwerk. Het is het hoogste niveau van gegevensbeveiliging dat beschikbaar is voor AI-implementatie en wordt gebruikt wanneer de gevolgen van een inbreuk simpelweg te groot zijn om enige externe connectiviteit te accepteren.

De meeste bedrijven die private AI-implementatie verkennen, denken aan on-premise opstellingen of private cloudconfiguraties. Dat zijn solide opties voor de meeste use cases. Maar er is een categorie organisaties waarvoor zelfs een strak beveiligde private server met VPN-toegang niet volstaat. Overheidsinstanties die met gerubriceerde inlichtingen omgaan, defensieleveranciers die gegevens van wapensystemen verwerken, beheerders van kritieke infrastructuur en onderzoeksinstellingen die aan gevoelige ontdekkingen werken, opereren allemaal in omgevingen waar netwerkisolatie geen voorkeur is, maar een vereiste. Deze gids legt uit hoe air gapped AI er in de praktijk uitziet, hoe het wordt uitgerold, wat het operationeel kost en of uw organisatie het werkelijk nodig heeft of dat alleen maar denkt.



![AI agent](/blog/images/secured-server.jpg)

## **Wat air gapped daadwerkelijk betekent**

De term komt van de fysieke luchtkloof tussen een geïsoleerd systeem en elk aangesloten netwerk. Er loopt geen ethernetkabel naar het internet. Er is geen WiFi-adapter ingeschakeld. Er is geen Bluetooth. Gegevens komen er alleen in en uit via fysieke media, dat wil zeggen USB-sticks, optische schijven of air gapped bestandsoverdrachtwerkstations die zelf geen externe connectiviteit hebben.

Dit verschilt fundamenteel van een firewall, een VPN of zelfs een private clouduitrol. Bij die alle reizen gegevens nog steeds over netwerken, ook al zijn die netwerken versleuteld en toegangsgecontroleerd. Een air gapped systeem verstuurt helemaal geen gegevens over enig netwerk. De isolatie is fysiek, niet alleen logisch.

In de context van AI betekent dit dat het model, de inferentie-engine, de trainingsgegevens en alle door het systeem gegenereerde uitvoer leven op hardware die na uitrol nooit het openbare internet heeft aangeraakt. Updates van het model vereisen overdrachten via fysieke media. Nieuwe trainingsgegevens worden op dezelfde manier verplaatst. Uitvoer wordt beoordeeld en geëxtraheerd via gecontroleerde fysieke processen.

Het klinkt extreem omdat het voor de meeste organisaties extreem is. Maar voor de omgevingen waarop het van toepassing is, is het de enige architectuur die het werkelijke dreigingsmodel waaronder zij opereren bevredigt.

## **Wie heeft air gapped AI nodig en waarom**



![AI agent](/blog/images/analyst.jpg)

### **Toepassingen in defensie en inlichtingen**

Militaire en inlichtingendiensten waren de oorspronkelijke architecten van air gap-protocollen, lang voordat AI in beeld kwam. Gerubriceerde systemen werken al tientallen jaren in volledige netwerkisolatie omdat de gevolgen van een inbreuk in die omgevingen worden gemeten in levens en in uitkomsten voor de nationale veiligheid, niet in kosten voor het melden van datalekken.

AI in die omgevingen brengen verandert niets aan de isolatievereiste. Het voegt capaciteit toe aan infrastructuur die toch al fysieke scheiding vereist. Diensten die AI gebruiken voor signaalinlichtingenanalyse, herkenning van dreigingspatronen of logistieke optimalisatie hebben modellen nodig die volledig binnen gerubriceerde netwerken draaien die nooit met de buitenwereld verbonden zijn geweest.

### **Beheerders van kritieke infrastructuur**

Elektriciteitsnetten, waterzuiveringsinstallaties, kerncentrales en financiële clearingsystemen vallen in een categorie waar verstoring leidt tot cascade-effecten in de maatschappij. De industriële besturingssystemen die deze omgevingen beheren, hebben in toenemende mate AI geïntegreerd voor anomaliedetectie en voorspellend onderhoud. Het draaien van die AI-componenten op air gapped netwerken zorgt ervoor dat een gecompromitteerd extern systeem de operationele technologie die de fysieke infrastructuur beheert, niet kan bereiken.

### **Zorg- en juridische omgevingen met extreme privacyvereisten**

Niet elke air gap-toepassing draait om staatsgeheimen. Ziekenhuizen die zeer gevoelige onderzoeksgegevens verwerken, forensische laboratoria die met bewijsmateriaal werken en advocatenkantoren die zaken beheren waarvan zelfs het bestaan vertrouwelijk is, vereisen soms volledige netwerkisolatie voor specifieke AI-workloads. Het dreigingsmodel hier draait minder om statelijke actoren en meer om ijzersterke bescherming van het beroepsgeheim en regelgevende naleving met nultolerantie voor onbedoelde openbaarmaking.

Begrijpen hoe de architectuur van[ AI security](https://trigger.fish/security/) voor deze omgevingen wordt ontworpen, helpt organisaties te beoordelen of hun werkelijke dreigingsmodel echte air gapping vereist of dat een goed beveiligde private uitrol zou volstaan.

## **Hoe air gapped AI-uitrollen in de praktijk werken**

### **Modellen in een geïsoleerde omgeving krijgen**

Het proces van het opzetten van een air gapped AI-systeem begint voordat er ook maar enige hardware in een rack wordt gemonteerd. Modelgewichten, dat zijn de grote bestanden die definiëren hoe de AI zich gedraagt, moeten worden gedownload, geverifieerd en via goedgekeurde fysieke mediakanalen worden overgebracht naar de geïsoleerde omgeving.

In een typische beveiligde uitrol betekent dit het model downloaden op een gescheiden, gecontroleerde stagingmachine, integriteitscontrole uitvoeren om te bevestigen dat er niet met de bestanden is geknoeid, ze overdragen naar gesaneerde fysieke media en die media fysiek naar de geïsoleerde omgeving brengen, waar ze op de air gapped hardware worden geladen.

Eventuele updates van het model verlopen via hetzelfde proces. Er bestaat geen automatisch updatemechanisme. Elke wijziging is bewust, gedocumenteerd en fysiek uitgevoerd.


<table>
  <thead>
    <tr>
      <th>Overdrachtsfase</th>
      <th>Proces</th>
      <th>Beveiligingscontrole</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Modeldownload</td>
      <td>Opgehaald op met internet verbonden stagingmachine</td>
      <td>Hashverificatie tegen bekende checksums</td>
    </tr>
    <tr>
      <td>Mediavoorbereiding</td>
      <td>Geschreven naar gesaneerd fysiek overdrachtsapparaat</td>
      <td>Eenmaal beschrijfbaar medium of gesaneerde schijven</td>
    </tr>
    <tr>
      <td>Fysieke overdracht</td>
      <td>Naar de beveiligde perimeter gedragen</td>
      <td>Documentatie van bewijsketen</td>
    </tr>
    <tr>
      <td>Installatie</td>
      <td>Geladen op air gapped hardware</td>
      <td>Integriteitscontrole herhaald aan de veilige zijde</td>
    </tr>
    <tr>
      <td>Uitvoer-extractie</td>
      <td>Resultaten naar buiten verplaatst via omgekeerd proces</td>
      <td>Inhoudsbeoordeling vóór extractie</td>
    </tr>
  </tbody>
</table>



### **Inferentie uitvoeren op geïsoleerde hardware**

Zodra het model is geïnstalleerd, lijkt de dagelijkse werking vanuit het gezichtspunt van de gebruiker op elke andere on-premise AI-uitrol. Analisten of applicaties dienen verzoeken in, het model verwerkt ze en er komen antwoorden terug. Het verschil zit volledig in wat er onder de oppervlakte gebeurt. Er gaat geen telemetrie naar buiten. Er zijn geen API-aanroepen naar externe diensten. Het systeem is zelfvoorzienend.

Dit creëert een aantal operationele beperkingen die de moeite waard zijn om te begrijpen. Retrieval-augmented generation, waarmee AI-systemen verse informatie kunnen ophalen uit aangesloten databases, vereist dat die databases ook binnen de air gapped omgeving leven. Realtime-informatie is slechts zo actueel als de laatste fysieke gegevensoverdracht naar het systeem. Voor de meeste air gap-toepassingen is dat een acceptabele afweging gezien de beveiligingsvoordelen.

Beslissingen over[ AI architecture](https://trigger.fish/architecture/) die vroeg in een air gapped uitrol worden genomen, zijn later moeilijk te wijzigen, wat het aanzienlijk belangrijker maakt om het initiële ontwerp meteen goed te krijgen dan bij een standaard cloud- of on-premise opstelling.



![Ai agent](/blog/images/usb.jpg)

### **Hardwareoverwegingen**

Air gapped AI-systemen kunnen niet rekenen op cloudgebaseerde hardwareschaling. Welke rekenkracht u in het begin inricht, is wat u heeft. Dat maakt accurate capaciteitsplanning kritiek.


<table>
  <thead>
    <tr>
      <th>Type organisatie</th>
      <th>Typische modelgrootte</th>
      <th>Hardwarebenadering</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Klein beveiligd team, beperkte queries</td>
      <td>7B tot 13B parameters</td>
      <td>Enkele high-end werkstation met GPU</td>
    </tr>
    <tr>
      <td>Middelgrote beveiligde afdeling</td>
      <td>13B tot 34B parameters</td>
      <td>Toegewijde server met meerdere GPU's</td>
    </tr>
    <tr>
      <td>Schaal van agentschap of onderneming</td>
      <td>34B tot 70B parameters</td>
      <td>Multi-node GPU-cluster, on-site</td>
    </tr>
    <tr>
      <td>Onderzoek met multimodale behoeften</td>
      <td>Gespecialiseerde grote modellen</td>
      <td>Op maat gemaakte hardwareaanschaf vereist</td>
    </tr>
  </tbody>
</table>



Redundantieplanning telt hier zwaarder dan in verbonden omgevingen. Wanneer hardware uitvalt in een cloudopstelling, verschuift de capaciteit automatisch. In een air gapped omgeving betekent hardwarestoring verminderde capaciteit totdat een fysieke vervanging is verkregen, gesaneerd en geïnstalleerd. Redundantie inbouwen in de initiële hardware-specificatie is in productieomgevingen niet optioneel.

## **De operationele realiteit van het draaien van air gapped AI**

### **Hoe het dagelijks reilen en zeilen er werkelijk uitziet**

Organisaties die air gapped systemen draaien, ontwikkelen gedisciplineerde operationele ritmes rond de beperkingen. Modelupdates vinden plaats op een geplande cyclus in plaats van op aanvraag. Gegevensimporten volgen gedocumenteerde procedures met meerdere goedkeuringen. Uitvoer-extracties worden beoordeeld voordat iets de beveiligde perimeter verlaat.

Deze weloverwogenheid is in bepaalde contexten eigenlijk een voordeel. Elke wijziging in de AI-omgeving wordt bijgehouden, gedocumenteerd en is controleerbaar. In gereguleerde sectoren heeft dat auditspoor reële waarde. In gerubriceerde omgevingen is het verplicht.

De uitdaging is dat het ook zaken vertraagt vergeleken met wat teams die gewend zijn aan AI-tools in de cloud zouden kunnen verwachten. Prompt-iteratie die op een cloudplatform seconden duurt, kan in een air gapped omgeving dagen duren als daarvoor nieuwe gegevens moeten worden geïmporteerd of een modelupdate door het fysieke overdrachtsproces moet worden geduwd.

Een nuttig referentiepunt is de aanpak die wordt behandeld in[ AI guide](https://trigger.fish/guide/)-bronnen over gefaseerde uitrol, die hier rechtstreeks van toepassing is. Beginnen met een nauwe, goed gedefinieerde use case alvorens de scope van het air gapped systeem te verbreden, voorkomt dat scope creep operationele problemen veroorzaakt voordat het team de procedurele spierkracht heeft opgebouwd om de omgeving te beheren.

### **Personeels- en expertisevereisten**

Het draaien van een air gapped AI-systeem vereist mensen die zowel de AI-stack als de beveiligingsprotocollen die de geïsoleerde omgeving regeren, begrijpen. Die combinatie is werkelijk zeldzaam en vergt een aanzienlijke beloning. De gespecialiseerde functies die betrokken zijn bij het beheer van gerubriceerde of air gapped AI-omgevingen behoren tot de best betaalde posities in de technologiesector, wat de schaarste weerspiegelt van mensen die de benodigde clearances bezitten naast praktische AI-engineeringvaardigheden.

Organisaties die deze systemen voor het eerst opzetten, onderschatten doorgaans de complexiteit van de personeelsbezetting. Plan toegewijd personeel in dat eigenaar is van de levenscyclus van het modelbeheer, niet alleen IT-generalisten die dit als secundaire verantwoordelijkheid afhandelen.

## **Air gapped vs. andere benaderingen van private uitrol**

De beslissing tussen een volledige air gap en een goed beveiligde private uitrol is niet altijd vanzelfsprekend. Hier is een praktische manier om er over te denken.

Als uw belangrijkste zorg gegevensprivacy en naleving is, voldoet een correct geconfigureerde on-premise uitrol met sterke toegangscontroles en geen blootstelling aan het openbare internet doorgaans aan de eis zonder de operationele overhead van echte air gapping.

Als uw zorg dreigingsactoren met geavanceerde capaciteiten betreft, waaronder aanvallen op nationaal niveau, dreigingen van binnenuit of elk scenario waarin zelfs versleuteld netwerkverkeer een onaanvaardbaar risico vormt, dan adresseert air gapping het dreigingsmodel dat andere benaderingen niet kunnen.

De eerlijke inschatting voor de meeste bedrijven is dat echte air gapping meer is dan ze nodig hebben. De bedrijven die het werkelijk nodig hebben, weten meestal dat ze het nodig hebben voordat ze beginnen met het onderzoeken van opties. Regelgevende, contractuele of missiegerelateerde vereisten nemen de beslissing meestal voor hen.

## **Zaken om te weten**

Enkele details die in vroege gesprekken over air gapped AI-uitrollen vaak over het hoofd worden gezien:

Fysieke beveiliging telt evenveel als digitale beveiliging. Een air gapped systeem is slechts zo veilig als de ruimte waarin het staat. Fysieke toegangscontroles, bewaking en screening van personeel zijn even belangrijk als welke technische beveiligingsmaatregel dan ook.

De insider-dreiging is het belangrijkste resterende risico. Zodra u netwerkgebaseerde aanvalsvectoren elimineert, is de realistische resterende dreiging iemand met fysieke toegang tot het systeem. Personeelsscreening en toegangslogging worden de eerstelijns beveiligingscontroles.

Updates testen voordat u ze uitrolt is enorm belangrijk. In een verbonden omgeving kan een slechte modelupdate snel worden teruggedraaid. In een air gapped omgeving betekent terugdraaien nog een fysieke overdrachtscyclus. Stagingomgevingen die de air gapped opstelling weerspiegelen, helpen problemen op te sporen voordat ze de productie bereiken.

Energie- en koelinfrastructuur vereist planning. Air gapped systemen die grote GPU-workloads draaien, genereren aanzienlijke warmte en trekken veel vermogen. Bij de planning van de faciliteiten moet hiermee vroegtijdig rekening worden gehouden.

De documentatievereisten zijn uitgebreid. Elke procedure waarbij de air gapped omgeving betrokken is, moet grondig worden gedocumenteerd, niet alleen voor naleving maar omdat procedurele consistentie voorkomt dat zich beveiligingsincidenten voordoen in fysieke overdrachtsworkflows.

Open source-modellen genieten in deze omgevingen sterk de voorkeur. Propriëtaire modellen die licentievalidatie-aanroepen of rapportage van gebruikstelemetrie vereisen, zijn fundamenteel onverenigbaar met echte netwerkisolatie. Het ecosysteem van open source-modellen vormt de praktische basis voor vrijwel elke air gapped AI-uitrol.

## **Wanneer air gapped AI elke greintje van de overhead waard is**

De operationele complexiteit en de kostentoeslag van air gapped AI zijn reëel. Het vraagt meer van uw team, meer van uw faciliteiten en meer van uw planningsprocessen dan welke andere uitrolbenadering ook. Voor organisaties waar het dreigingsmodel dit rechtvaardigt, is die overhead niet alleen acceptabel, het is de hele bedoeling.

De isolatie zelf is het product. Al het andere wat het systeem doet, queries beantwoorden, documenten analyseren, anomalieën detecteren, beslissingen ondersteunen, gebeurt binnen een perimeter die geen enkele externe actor kan bereiken. Voor de organisaties die die garantie nodig hebben, levert geen enkele andere architectuur die.

## **Veelgestelde vragen**

### **Wat is een air gap in AI?**

**Een air gap in AI verwijst naar volledige fysieke en netwerkisolatie van het AI-systeem, wat betekent geen internetverbinding, geen toegang tot externe netwerken en geen draadloze interfaces van welke aard dan ook.** Gegevens verplaatsen zich alleen naar binnen en naar buiten via gecontroleerde overdrachten van fysieke media, waardoor het de meest veilige uitrolarchitectuur is die beschikbaar is voor gevoelige AI-workloads.

### **Wat betekent "air gapped"?**

**Air gapped betekent dat een systeem fysiek geïsoleerd is van alle externe netwerken, met een letterlijke luchtkloof tussen het systeem en elke aangesloten infrastructuur.** De term is ontstaan in militaire en overheidscomputers en is uitgebreid om elke uitrol te beschrijven waarin netwerkisolatie wordt gebruikt als de primaire beveiligingscontrole.

### **Wat is de AI-baan van $900.000?**

**De AI-baan van $900.000 verwijst doorgaans naar zeer gespecialiseerde AI-veiligheidsonderzoekers of hoofd-AI-wetenschappers bij toonaangevende technologiebedrijven wier totale beloningspakketten dat bereik hebben bereikt vanwege aandelen en bonussen.** Functies die AI-engineeringexpertise combineren met veiligheidsclearances voor gerubriceerde omgevingen vragen ook uitzonderlijke beloning, wat de schaarste weerspiegelt van gekwalificeerde kandidaten die aan beide eisen voldoen.

### **Wat is de 30%-regel in AI?**

**De 30%-regel in AI is een richtlijn die suggereert dat AI ongeveer 30% van een gegeven workflow zou moeten automatiseren, waarbij de overige 70% wordt overgelaten aan menselijk oordeel en contextueel redeneren.** Het helpt organisaties realistische automatiseringsdoelen te identificeren zonder processen te overengineeren die nog steeds afhangen van menselijke besluitvorming.

### **Welke banen zullen in 2030 niet meer bestaan?**

**Functies die zich richten op repetitieve gegevensinvoer, basale documentverwerking, routinematige afhandeling van klantvragen en handmatige rapportgeneratie zullen naar algemene verwachting tegen 2030 aanzienlijk afnemen naarmate AI-systemen deze functies overnemen.** Toch voorspellen de meeste analisten dat transformatie van banen, in plaats van algehele eliminatie, het dominante patroon zal zijn, met nieuwe functies die ontstaan rond AI-management, toezicht en uitrol.
