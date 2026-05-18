---
title: "Hoe u AI veilig implementeert in uw organisatie: een praktisch
  raamwerk om het goed te doen"
date: 2026-03-24
description: Leren hoe u AI veilig in uw organisatie implementeert, betekent
  snelheid in balans brengen met governance. Hier is een praktisch raamwerk om
  AI in te zetten zonder uw organisatie bloot te stellen aan risico's.
author: triggerfish
tags:
  - AI agent
draft: false
---



Hoe u AI veilig in uw organisatie implementeert, komt neer op drie fundamentele praktijken: tools beoordelen tegen uw specifieke risicoprofiel voordat u ze uitrolt, duidelijke governance vaststellen over hoe AI omgaat met de gegevens van uw organisatie, en mensen verantwoordelijk houden voor beslissingen die door AI worden ondersteund. Organisaties die deze volgorde consequent volgen, weten de meeste AI-gerelateerde incidenten die het nieuws halen te voorkomen.

De druk om AI snel te adopteren is reëel en gegrond. Concurrenten bewegen, productiviteitswinsten zijn gedocumenteerd en de tools die vandaag beschikbaar zijn, zijn werkelijk capabel op een manier die enkele jaren geleden onwaarschijnlijk had geleken. Maar de organisaties die het snelst zijn gegaan zonder een governancefundament, zijn ook degenen die meldingen van datalekken, toezichthoudersonderzoeken en reputatieschade veroorzaken die de productiviteitswinst die zij nastreefden weer uitwist. Snelheid is belangrijk. De volgorde ook. De uitrol overhaasten zonder risicobeoordeling maakt de AI-implementatie in geen enkele zinvolle zin sneller. Het maakt haar sneller tot het eerste incident en trager naar duurzame, vertrouwde adoptie op schaal. Deze gids beschrijft de praktische stappen om AI in uw organisatie te krijgen op een manier die de voordelen oplevert zonder de risico's op te bouwen die ongestuurde uitrol creëert.



![AI agent](/blog/images/leadership.jpg)

## **Waarom veilige AI-implementatie een bedrijfsstrategie is, niet alleen een compliance-oefening**

### **De kosten van bewegen zonder plan**

Organisaties die veilige AI-implementatie puur zien als een compliance-verplichting, neigen ertoe governance-raamwerken te bouwen die auditors tevredenstellen, maar die het gedrag niet werkelijk veranderen. De organisaties die het goed aanpakken, behandelen veilige implementatie als een bedrijfsstrategie, omdat de keerzijde van het fout doen niet alleen een boete van de toezichthouder is. Het is verlies van klantvertrouwen, operationele verstoring, juridische aansprakelijkheid en de cumulatieve kosten van het verhelpen van problemen die met goede planning waren voorkomen.

Het patroon van AI-gerelateerde incidenten in verschillende sectoren laat een consistent stel oorzaken zien. Gevoelige gegevens verwerkt via tools waarmee de organisatie geen contract had. Door AI gegenereerde uitvoer waarop werd gehandeld zonder verificatie en die op een cruciaal moment onjuist bleek. Geautomatiseerde beslissingen genomen zonder menselijke beoordeling in contexten waar vooringenomenheid, fouten of regelgevende vereisten dat juist eisten. Leveranciersrelaties aangegaan zonder te begrijpen wat de leverancier deed met de gegevens die hij ontving.

Geen van deze zijn exotische faalmodi. Allemaal zijn ze voorspelbaar, gedocumenteerd en te voorkomen met planning die geen significante technische expertise vereist. De drempel voor veilige AI-implementatie is geen complexiteit. Het is de organisatorische gewoonte om governance te behandelen als iets dat u toevoegt na de uitrol, in plaats van als het fundament waarop u bouwt vóór de uitrol.

### **Hoe het risicolandschap er werkelijk uitziet**

Inzicht in de vier hoofdcategorieën van AI-risico helpt organisaties hun risicomanagementinspanningen evenredig te verdelen, in plaats van te proberen overal even sterke verdedigingen op te bouwen.

Operationeel risico omvat de manieren waarop AI-systemen kunnen falen, onjuiste uitvoer kunnen produceren, zich onvoorspelbaar kunnen gedragen of onbeschikbaar kunnen worden op manieren die bedrijfsprocessen verstoren. Dit is de categorie waar de meeste teams intuïtief het eerst aan denken, omdat ze het dichtst staat bij vertrouwde zorgen over softwarestabiliteit.

Gegevensrisico omvat wat er gebeurt met informatie die door AI-systemen stroomt. Onbevoegde toegang, onbedoelde bewaring, problemen met grensoverschrijdende overdracht en het gebruik van organisatiegegevens om leveranciersmodellen te trainen, vallen allemaal in deze categorie. Voor de meeste bedrijven is gegevensrisico waar de exposures met de grootste impact daadwerkelijk liggen.

Compliance-risico omvat de regelgevende en juridische verplichtingen die AI-uitrol activeert. De verwerkingseisen van de GDPR, HIPAA-waarborgen voor gezondheidsgegevens, sectorspecifieke regelgeving en de opkomende eisen van de EU AI Act creëren allemaal compliance-verplichtingen die zich aan AI-uitrol hechten, ongeacht of de organisatie ze expliciet heeft erkend.

Reputatierisico omvat de manieren waarop AI-falen zichtbaar wordt voor klanten, partners, toezichthouders en het publiek. Een AI-systeem dat discriminerende uitvoer produceert, valse claims doet of klantgegevens ongepast behandelt, creëert reputatieschade die vaak hoger uitvalt dan de directe operationele of financiële kosten van het onderliggende incident.


<table>
  <thead>
    <tr>
      <th>AI-risicocategorie</th>
      <th>Primaire blootstelling</th>
      <th>Belangrijkste beheersmaatregel</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Operationeel</td>
      <td>Systeemstoringen, onnauwkeurige uitvoer, uitval</td>
      <td>Verificatie van uitvoer, terugvalprocessen, betrouwbaarheidstesten</td>
    </tr>
    <tr>
      <td>Gegevens</td>
      <td>Onbevoegde toegang, onbedoelde bewaring, gebruik van gegevens door leveranciers</td>
      <td>Gegevensclassificatie, lijsten met goedgekeurde tools, contracten met leveranciers</td>
    </tr>
    <tr>
      <td>Compliance</td>
      <td>Schending van regelgeving, juridische aansprakelijkheid, auditbevindingen</td>
      <td>Juridische beoordeling, gedocumenteerde controls, doorlopende monitoring</td>
    </tr>
    <tr>
      <td>Reputatie</td>
      <td>Publieke incidenten, erosie van klantvertrouwen, media-aandacht</td>
      <td>Governancedocumentatie, planning van incidentrespons</td>
    </tr>
  </tbody>
</table>



Het beoordelen hoe[ AI-beveiligings](https://trigger.fish/security/)raamwerken zich verhouden tot elk van deze risicocategorieën, helpt organisaties verdedigingen op te bouwen die het werkelijke risicolandschap aanpakken in plaats van alleen het meest zichtbare.

## **Het stap-voor-stap raamwerk voor veilige AI-implementatie**

### **Stap één: breng uw use cases in kaart voordat u tools kiest**

De meest gemaakte implementatiefout is het selecteren van een AI-tool en pas daarna uitzoeken hoe u die gaat gebruiken. De juiste volgorde is: een specifiek bedrijfsprobleem identificeren, begrijpen welke gegevens de oplossing zal aanraken, het risicoprofiel van die use case beoordelen, en pas daarna tools beoordelen ten opzichte van die vereisten.

Een oefening om use cases in kaart te brengen hoeft niet uitgebreid te zijn. Documenteer voor elke voorgestelde AI-toepassing wat de AI zal doen, welke gegevens zij zal verwerken, wie ermee zal interacteren, welke beslissingen zij zal ondersteunen of nemen, en wat er misgaat als zij faalt of onjuiste uitvoer produceert. Die beschrijving met vijf elementen levert genoeg op om risico te beoordelen, governance-eisen te definiëren en te evalueren of kandidaat-tools daadwerkelijk passen.

Use cases die hoge belangen, gevoelige gegevens, gereguleerde informatie of klantgerichte uitvoer betreffen, vereisen een strenger toetsingsproces dan interne productiviteitstoepassingen zonder externe gegevensblootstelling. Alle AI-use cases met dezelfde diepgang behandelen, verspilt governance-capaciteit. Ze allemaal met dezelfde permissiviteit behandelen, creëert gaten waarin de gevaarlijkste toepassingen het minste toezicht krijgen.

### **Stap twee: beoordeel en keur tools goed via een consistent proces**

Ad-hocadoptie van tools is de bron van het grootste deel van het organisatorische AI-risico. Een medewerker vindt een nuttige tool, begint hem te gebruiken, en de organisatie ontdekt dat hij ingebed is in werkprocessen lang nadat iemand hem redelijkerwijs nog zonder verstoring kan verwijderen. Een consistent proces voor het beoordelen en goedkeuren van tools doorbreekt dat patroon voordat het zich nestelt.

Een praktisch raamwerk voor het beoordelen van tools omvat juridische en contractuele vereisten, beveiligings- en compliance-certificeringen, praktijken voor gegevensverwerking en operationele betrouwbaarheid.


<table>
  <thead>
    <tr>
      <th>Beoordelingsdimensie</th>
      <th>Wat te beoordelen</th>
      <th>Minimumstandaard</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Juridisch en contractueel</td>
      <td>Verwerkersovereenkomsten, servicevoorwaarden, beschikbaarheid van een BAA waar vereist</td>
      <td>Ondertekende DPA voordat enige organisatiegegevens worden verwerkt</td>
    </tr>
    <tr>
      <td>Beveiligingscertificering</td>
      <td>SOC 2 Type 2, ISO 27001 of een gelijkwaardige onafhankelijke audit</td>
      <td>Recent Type 2-rapport dat de relevante systemen in scope dekt</td>
    </tr>
    <tr>
      <td>Gegevensverwerking</td>
      <td>Bewaartermijnen, gebruik van trainingsgegevens, openbaarmaking van subverwerkers</td>
      <td>Geen gebruik van trainingsgegevens zonder opt-out, duidelijke bewaarlimieten</td>
    </tr>
    <tr>
      <td>Compliance-dekking</td>
      <td>Adequaatheid onder de GDPR, HIPAA-dekking, sectorspecifieke vereisten</td>
      <td>Certificeringen die overeenkomen met de gegevenscategorieën die de tool verwerkt</td>
    </tr>
    <tr>
      <td>Operationele betrouwbaarheid</td>
      <td>Uptimeverplichtingen, incidentgeschiedenis, beschikbaarheid van support</td>
      <td>Gedocumenteerde SLA met een betekenisvolle uptimeverplichting</td>
    </tr>
    <tr>
      <td>Stabiliteit van de leverancier</td>
      <td>Financiering, marktpositie, indicatoren voor bedrijfscontinuïteit</td>
      <td>Voldoende organisatorische stabiliteit voor een productieafhankelijkheid</td>
    </tr>
  </tbody>
</table>



De[ AI-functies](https://trigger.fish/features/) in enterprise-tier tools van gevestigde leveranciers komen doorgaans met meer documentatie op deze dimensies dan opkomende tools, wat een van de redenen is dat enterprise-tiers hun prijspremie rechtvaardigen voor use cases met gevoelige gegevens.



![AI agent](/blog/images/security.jpg)

### **Stap drie: stel datagovernance vast vóór de uitrol**

Begrijpen hoe u AI veilig in uw organisatie implementeert, vereist dat u accepteert dat de beslissingen over datagovernance die u neemt voordat een tool live gaat, het risicoprofiel bepalen van alles wat daarna volgt. Datagovernance voor AI komt neer op drie praktische beslissingen.

Welke gegevenscategorieën mogen via deze tool worden verwerkt? Deze beslissing moet expliciet worden genomen tijdens het beoordelingsproces van de tool en worden vastgelegd op een manier die toegankelijk is voor de medewerkers die het systeem gaan gebruiken. Dubbelzinnigheid hier is niet neutraal. Wanneer medewerkers onzeker zijn of een specifiek type gegevens is toegestaan, bepalen de organisatiecultuur en de risicotolerantie van het individu de uitkomst, in plaats van een doelbewuste beleidsbeslissing.

Welke controls voorkomen dat de verkeerde gegevens de tool bereiken? Beleidsregels alleen zijn geen voldoende controls, omdat mensen fouten maken en omdat de weg van de minste weerstand in een druk werkproces vaak goede intenties omzeilt. Technische controls die beperken welke systemen verbinding mogen maken met AI-tools, welke gegevensvelden beschikbaar zijn voor verwerking, en welke uitvoer mag worden geëxporteerd uit AI-ondersteunde werkprocessen, creëren wrijving op de juiste momenten.

Wie is verantwoordelijk wanneer er iets misgaat? Elke AI-uitrol heeft een benoemde eigenaar nodig die verantwoordelijk is voor het monitoren van de werking, het reageren op incidenten en het actualiseren van de governance naarmate de omstandigheden veranderen. AI-systemen zonder benoemde eigenaars neigen weg te drijven richting verkeerde configuratie, scope creep en onopgemerkte storingen.

Beoordelen hoe beslissingen over[ AI-architectuur](https://trigger.fish/architecture/) de controle over de gegevensstroom beïnvloeden, helpt organisaties technische governance te bouwen die de beleidsbeslissingen van hun compliance- en juridische teams ondersteunt in plaats van ondermijnt.

### **Stap vier: bouw menselijk toezicht in elke werkstroom met hoge belangen**

Geautomatiseerde efficiëntie is een van de belangrijkste bedrijfsmotieven voor AI. Het is ook een van de belangrijkste bronnen van AI-risico, wanneer automatisering het menselijke oordeel verwijdert uit beslissingen die dat juist nodig hebben. Menselijk toezicht inbouwen in AI-werkprocessen met hoge belangen is geen concessie aan voorzichtigheid ten koste van efficiëntie. Het is de ontwerpbeslissing die de organisatie juridisch verdedigbaar, ethisch verantwoord en praktisch beschermd houdt tegen de fouten die AI-systemen met een zekere regelmaat betrouwbaar produceren.

De praktische toets of een werkstroom menselijk toezicht vereist, is eenvoudig. Als de AI een fout maakt in deze werkstroom en geen mens vangt die op voordat zij effect heeft, hoe ernstig is dan het gevolg? Onhandige gevolgen die eenvoudig te herstellen zijn, vereisen mogelijk geen menselijke controlepunten. Substantiële financiële, juridische, regelgevende of welzijnsgerelateerde gevolgen vrijwel altijd wel.

De 30%-regel voor AI biedt hier een nuttige vuistregel. AI zou ongeveer 30% van een werkstroom moeten afhandelen, specifiek de delen die het meest profiteren van automatisering, terwijl het menselijke oordeel de overige 70% dekt die context, verantwoording en het soort situationele redenering vereist dat AI-systemen niet betrouwbaar kunnen leveren. Werkprocessen rond deze balans ontwerpen, creëert de toezichtsarchitectuur die organisaties beschermt tegen de faalmodi van hun AI-tools.

## **Verantwoord AI-gebruik als doorlopende praktijk**

### **Wat verantwoord zakelijk AI-gebruik werkelijk vereist**

Verantwoord AI-gebruik in een zakelijke context is geen toestand die u bereikt en passief in stand houdt. Het is een doorlopende reeks praktijken die meeontwikkelt met uw AI-uitrol, met veranderende regelgevingseisen en met veranderende mogelijkheden en gedragingen van uw AI-tools via updates en beslissingen van leveranciers.

Het monitoren van de uitvoer van AI-systemen op kwaliteit, vooringenomenheid en juistheid is een operationele discipline die verantwoorde uitrol vanaf het begin vereist. AI-systemen kunnen in gedrag verschuiven in de loop van de tijd, vooral wanneer leveranciers onderliggende modellen bijwerken. Een AI-tool die twaalf maanden geleden uw beoordeling doorstond, kan zich vandaag anders gedragen op manieren die het risicoprofiel beïnvloeden.

Het plannen van incidentrespons voor AI-specifieke storingen is iets dat heel weinig organisaties hebben geformaliseerd, ondanks de toenemende aanwezigheid van AI in productiewerkprocessen. Wat gebeurt er als een AI-tool een schadelijke uitvoer produceert die een klant bereikt? Wat gebeurt er als een beveiligingsincident bij een leverancier gegevens blootlegt die uw organisatie via zijn platform heeft verwerkt? Gedocumenteerde reacties op deze scenario's hebben voordat ze zich voordoen, is aanzienlijk minder stressvol dan ze tijdens een incident improviseren.

Personeelstraining die AI-beoordelingsvermogen opbouwt en niet alleen AI-bewustzijn, is een volgehouden investering die zich met de tijd uitbetaalt. Medewerkers die begrijpen waarom bepaalde toepassingen van AI risico creëren, nemen betere beslissingen in nieuwe situaties die geen enkel beleidsdocument expliciet heeft afgedekt. Dat oordeelsvermogen is waardevoller dan uit het hoofd geleerde regels in een omgeving waarin AI-mogelijkheden en zakelijke toepassingen sneller veranderen dan governance-documenten kunnen worden bijgewerkt.

Een uitgebreide[ AI-gids](https://trigger.fish/guide/) over het opbouwen van een doorlopende AI-governancepraktijk helpt organisaties om van een veilige eerste uitrol naar de volgehouden operationele discipline te gaan die verantwoord gebruik intact houdt naarmate hun AI-voetafdruk groeit.



![AI agent](/blog/images/diverse-team.jpg)

## **Goed om te weten**

Enkele belangrijke punten over hoe u AI veilig in uw organisatie implementeert die pas naar boven komen nadat organisaties al met de uitrol zijn begonnen:

Pilotprogramma's onthullen risico's die beoordelingen missen. Een beperkte uitrol uitvoeren met een gedefinieerde gebruikersgroep en expliciete monitoring voordat u volledig uitrolt, brengt operationele en gegevensverwerkingskwesties aan het licht die leverancierdocumentatie en beveiligingsaudits niet altijd voorspellen. Reserveer tijd voor een echte pilotfase in plaats van een kleine initiële uitrol als volledige lancering met een kleinere doelgroep te behandelen.

Updates van leveranciers kunnen uw risicoprofiel zonder kennisgeving veranderen. AI-leveranciers werken hun modellen, hun infrastructuur en hun servicevoorwaarden bij volgens hun eigen schema. Een leveranciersbeoordeling bij aanschaf is noodzakelijk, maar niet voldoende. Bouw leveranciersmonitoring in in uw doorlopende governancekalender om wijzigingen op te merken die van invloed zijn op uw compliance- of beveiligingspositie.

Het gedrag van medewerkers is de variabele die governance-raamwerken het vaakst onderschatten. Technische controls en beleidsdocumenten sturen gedrag in de marges. De organisatiecultuur, het voorbeeldgedrag van leidinggevenden en de praktische bruikbaarheid van goedgekeurde tools bepalen wat medewerkers werkelijk doen. Als de goedgekeurde route aanzienlijk omslachtiger is dan het niet-goedgekeurde alternatief, kiest een aanzienlijk deel van het personeel voor gemak boven compliance.

AI-implementatieprojecten neigen ertoe hun scope buiten de oorspronkelijke grenzen uit te breiden. Een klantenservice-AI die begint als hulpmiddel voor antwoordsuggesties, evolueert vaak tot zelfstandig contactafhandelaar. Een tool voor documentanalyse die door één team is aangenomen, wordt overgenomen door aangrenzende teams met andere verplichtingen rond gegevensverwerking. Scope-beheer is een governancefunctie die actief moet zijn, niet passief.

Integraties met derden vermenigvuldigen uw risico-oppervlak. Elke integratie tussen uw AI-tool en een ander organisatiesysteem, uw CRM, uw platform voor documentbeheer, uw communicatietools, creëert een gegevensstroom die zijn eigen governancebeoordeling nodig heeft. Integratierisico wordt vaak onderschat ten opzichte van het risico van het basishulpmiddel zelf.

De kosten van goede AI-governance zijn voorspelbaar en beheersbaar. De kosten van AI-incidenten zijn dat geen van beide. Organisaties die het investeren in governance afwijzen omdat het de initiële uitrol vertraagt, geven doorgaans meer uit in totaal wanneer herstel, regelgevende reactie en reputatieherstel worden meegeteld.

## **AI veilig implementeren in uw organisatie is een concurrentievoordeel**

De organisaties die AI het meest succesvol implementeren, zijn niet degenen die het snelst zijn gegaan ongeacht het risico. Het zijn degenen die vroeg governance-infrastructuur hebben opgebouwd, waardoor zij AI met vertrouwen konden uitrollen in steeds belangrijkere contexten naarmate hun raamwerken volwassen werden. Elke nieuwe AI-uitrol werd gemakkelijker omdat het beoordelingsproces, de contractuele sjablonen, de regels voor datagovernance en de training van medewerkers al op hun plaats waren.

Dat cumulatieve effect van vroege governance-investering is een van de duidelijkste argumenten om veilige implementatie als strategische prioriteit te behandelen in plaats van als compliance-kostenpost. De bedrijven die uitvogelen hoe zij AI veilig in hun organisatie kunnen implementeren en die capaciteit verankeren in hun organisatie-DNA, eindigen met een duurzaam voordeel ten opzichte van concurrenten die voortdurend bezig zijn de risico's in te halen die hun snelheid heeft gecreëerd.

De tools zijn beschikbaar. De raamwerken zijn gedocumenteerd. De verwachtingen van toezichthouders worden steeds duidelijker. De resterende variabele is of uw organisatie verantwoorde AI-adoptie behandelt als fundamenteel voor haar AI-strategie of als een obstakel daarvoor.

## **Veelgestelde vragen**

### **Hoe kan ik AI implementeren in mijn organisatie?**

**AI implementeren in uw organisatie begint met het identificeren van specifieke use cases waarin AI een gedocumenteerd bedrijfsprobleem oplost, tools beoordelen ten opzichte van die vereisten in plaats van tools aanschaffen en achteraf bedenken waarvoor u ze gebruikt, en datagovernance en toezichtprocessen vaststellen vóór de uitrol, niet erna.** Beginnen met een beperkte pilot in een context met lager risico bouwt het organisatorische vermogen en de governance-spierkracht op waarmee latere uitrollen sneller en veiliger verlopen.

### **Hoe implementeert u AI veilig?**

**AI veilig implementeren vereist tools beoordelen tegen een consistent raamwerk dat beveiligingscertificeringen, praktijken voor gegevensverwerking en juridische overeenkomsten dekt vóór de uitrol, organisatiegegevens classificeren zodat medewerkers weten wat via welke tools mag worden verwerkt, en menselijke beoordelingsmomenten inbouwen in werkprocessen waar AI-fouten significante gevolgen zouden hebben.** Veiligheid is een ontwerpkenmerk van het uitrolproces, geen functie die u achteraf kunt toevoegen.

### **Hoe kan AI verantwoord worden ingezet in een organisatie?**

**Verantwoord AI-gebruik in een organisatie betekent menselijke verantwoording behouden voor beslissingen die AI ondersteunt, transparant zijn naar klanten en stakeholders over wanneer AI betrokken is bij processen die hen raken, actief AI-uitvoer monitoren op kwaliteit en vooringenomenheid, en governancepraktijken bijwerken naarmate tools en regelgeving evolueren.** Verantwoordelijkheid is een doorlopende operationele praktijk in plaats van een toestand die bij uitrol wordt bereikt en passief wordt onderhouden.

### **Hoe gebruiken bedrijven AI veilig?**

**Bedrijven die AI veilig gebruiken, investeren in drie consistente praktijken: grondige leveranciersbeoordeling vóór adoptie, duidelijk databeleid dat aangeeft welke organisatiegegevens via welke AI-systemen mogen stromen, en structuren voor menselijk toezicht die zwaarwegende beslissingen verantwoordelijk houden aan mensen in plaats van volledig te delegeren aan geautomatiseerde systemen.** Zij behandelen governance ook als een levende praktijk die meegroeit met hun AI-uitrol in plaats van als een eenmalige compliance-oefening.

### **Wat zijn de 4 soorten AI-risico?**

**De vier hoofdsoorten AI-risico zijn operationeel risico, dat systeemstoringen en onnauwkeurige uitvoer omvat, gegevensrisico, dat onbevoegde toegang en onbedoeld gebruik van gegevens door leveranciers omvat, compliance-risico, dat door AI-uitrol veroorzaakte schendingen van regelgeving omvat, en reputatierisico, dat de gevolgen omvat voor het vertrouwen van publiek en klanten bij AI-incidenten.** Begrijpen welke risicocategorie het meest van belang is voor een specifieke AI-use case, helpt organisaties hun governance-inspanningen evenredig te verdelen in plaats van uniforme strengheid toe te passen op elke uitrol, ongeacht het werkelijke risicoprofiel.
