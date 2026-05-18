---
title: "  Air gapped AI: hva det er, hvorfor det betyr noe og hvem som faktisk trenger det"
date: 2026-03-06
description: Air gapped AI kjører på isolerte systemer uten internettforbindelse,
  og gir organisasjoner maksimal datasikkerhet og full kontroll over sensitive
  AI-arbeidslaster.
author: triggerfish
tags:
  - AI agent
draft: false
---


Air gapped AI viser til kunstige intelligenssystemer som er distribuert på maskinvare som er fysisk og logisk isolert fra internett og fra ethvert eksternt nettverk. Det er det høyeste nivået av datasikkerhet som er tilgjengelig for AI-distribusjon, og brukes når innsatsen ved et brudd er for høy til å akseptere noen form for ekstern tilkobling.

De fleste virksomheter som utforsker privat AI-distribusjon, tenker på on-premise-oppsett eller private skykonfigurasjoner. Det er solide alternativer for de fleste bruksområder. Men det finnes en kategori organisasjoner der selv en tett sikret privat server med VPN-tilgang ikke er tilstrekkelig. Statlige etater som håndterer gradert etterretning, forsvarsleverandører som behandler data fra våpensystemer, operatører av kritisk infrastruktur og forskningsinstitusjoner som arbeider med sensitive oppdagelser, opererer alle i miljøer der nettverksisolasjon ikke er en preferanse, men et krav. Denne guiden forklarer hvordan air gapped AI ser ut i praksis, hvordan det distribueres, hva det koster operasjonelt, og om organisasjonen din faktisk trenger det eller bare tror den trenger det.



![AI agent](/blog/images/secured-server.jpg)

## **Hva air gapped faktisk betyr**

Begrepet kommer fra det fysiske luftgapet mellom et isolert system og ethvert tilkoblet nettverk. Det er ingen ethernet-kabel som går til internett. Det er ingen WiFi-adapter aktivert. Det er ingen Bluetooth. Data kommer inn og ut kun gjennom fysiske medier, det vil si USB-stasjoner, optiske plater eller air gapped-filoverføringsstasjoner som selv ikke har ekstern tilkobling.

Dette er grunnleggende forskjellig fra en brannmur, en VPN eller til og med en privat skydistribusjon. Alle disse innebærer fortsatt at data beveger seg over nettverk, selv om disse nettverkene er kryptert og tilgangskontrollert. Et air gapped-system overfører ingen data over noe nettverk i det hele tatt. Isolasjonen er fysisk, ikke bare logisk.

I AI-sammenheng betyr dette at modellen, inferensmotoren, treningsdataene og alle resultater som systemet genererer, lever på maskinvare som aldri har vært i kontakt med det offentlige internett etter distribusjon. Oppdateringer av modellen krever fysiske medieoverføringer. Nye treningsdata flyttes på samme måte. Resultater gjennomgås og hentes ut gjennom kontrollerte fysiske prosesser.

Det høres ekstremt ut fordi det for de fleste organisasjoner er det. Men for miljøene der det gjelder, er det den eneste arkitekturen som tilfredsstiller den faktiske trusselmodellen de opererer under.

## **Hvem trenger air gapped AI og hvorfor**



![AI agent](/blog/images/analyst.jpg)

### **Forsvars- og etterretningsanvendelser**

Militære og etterretningsetater var de opprinnelige arkitektene bak air gap-protokoller, lenge før AI kom inn i bildet. Graderte systemer har operert i full nettverksisolasjon i flere tiår fordi konsekvensene av et brudd i disse miljøene måles i liv og utfall for nasjonal sikkerhet, ikke i kostnader for varsling om datalekkasje.

Å bringe AI inn i disse miljøene endrer ikke isolasjonskravet. Det legger til kapasitet til infrastruktur som allerede krever fysisk separasjon. Etater som bruker AI til signaletterretningsanalyse, gjenkjenning av trusselmønstre eller logistikkoptimalisering, trenger modeller som kjører i sin helhet innenfor graderte nettverk som aldri har vært koblet til omverdenen.

### **Operatører av kritisk infrastruktur**

Strømnett, vannrenseanlegg, atomkraftverk og finansielle clearingsystemer faller inn under en kategori der forstyrrelse har kaskaderende samfunnsmessige effekter. De industrielle styringssystemene som administrerer disse miljøene, har i økende grad inkorporert AI for anomalideteksjon og prediktivt vedlikehold. Å kjøre disse AI-komponentene på air gapped-nettverk sikrer at et kompromittert eksternt system ikke kan nå den operative teknologien som administrerer den fysiske infrastrukturen.

### **Helse- og juridiske miljøer med ekstreme personvernkrav**

Ikke alle air gap-bruksområder involverer statshemmeligheter. Sykehus som behandler svært sensitive forskningsdata, rettsmedisinske laboratorier som håndterer bevis, og advokatfirmaer som forvalter saker der selv eksistensen av saken er konfidensiell, krever noen ganger full nettverksisolasjon for spesifikke AI-arbeidslaster. Trusselmodellen her dreier seg mindre om aktører på nasjonsnivå og mer om jernhard beskyttelse av taushetsplikt og regulatorisk etterlevelse med nulltoleranse for utilsiktet avsløring.

Å forstå hvordan[ AI security](https://trigger.fish/security/)-arkitektur utformes for disse miljøene, hjelper organisasjoner med å vurdere om deres faktiske trusselmodell krever ekte air gapping eller om en godt sikret privat distribusjon ville være tilstrekkelig.

## **Hvordan air gapped AI-distribusjoner fungerer i praksis**

### **Få modeller inn i et isolert miljø**

Prosessen med å sette opp et air gapped AI-system starter før noe maskinvare i det hele tatt er rackmontert. Modellvekter, som er de store filene som definerer hvordan AI-en oppfører seg, må lastes ned, verifiseres og overføres til det isolerte miljøet gjennom godkjente fysiske mediekanaler.

I en typisk sikker distribusjon betyr dette å laste ned modellen på en separat, kontrollert staging-maskin, kjøre integritetsverifisering for å bekrefte at filene ikke har blitt manipulert, overføre dem til renset fysisk medium, og fysisk frakte det mediet inn i det isolerte miljøet der det lastes inn på den air gappede maskinvaren.

Eventuelle oppdateringer av modellen går gjennom den samme prosessen. Det finnes ingen mekanisme for automatisk oppdatering. Hver endring er bevisst, dokumentert og fysisk utført.


<table>
  <thead>
    <tr>
      <th>Overføringsfase</th>
      <th>Prosess</th>
      <th>Sikkerhetskontroll</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Modellnedlasting</td>
      <td>Hentet på internett-tilkoblet staging-maskin</td>
      <td>Hash-verifisering mot kjente sjekksummer</td>
    </tr>
    <tr>
      <td>Mediepreparering</td>
      <td>Skrevet til renset fysisk overføringsenhet</td>
      <td>Engangsskrivbart medium eller rensede stasjoner</td>
    </tr>
    <tr>
      <td>Fysisk overføring</td>
      <td>Fraktet inn i det sikre perimeteret</td>
      <td>Dokumentasjon av besittelseskjede</td>
    </tr>
    <tr>
      <td>Installasjon</td>
      <td>Lastet på air gapped-maskinvare</td>
      <td>Integritetskontroll gjentatt på sikker side</td>
    </tr>
    <tr>
      <td>Uttak av resultater</td>
      <td>Resultater flyttet ut gjennom motsatt prosess</td>
      <td>Innholdsgjennomgang før uttak</td>
    </tr>
  </tbody>
</table>



### **Kjøre inferens på isolert maskinvare**

Når modellen er installert, ser den daglige driften ut omtrent som enhver annen on-premise AI-distribusjon fra brukerens perspektiv. Analytikere eller applikasjoner sender spørringer, modellen behandler dem, og svar kommer tilbake. Forskjellen ligger fullt og helt i det som skjer under overflaten. Det går ingen telemetri ut. Det er ingen API-kall til eksterne tjenester. Systemet er selvstendig.

Dette skaper noen operasjonelle begrensninger som det er verdt å forstå. Retrieval-augmented generation, som lar AI-systemer hente inn ferskt innhold fra tilkoblede databaser, krever at disse databasene også lever innenfor det air gappede miljøet. Sanntidsinformasjon er bare så aktuell som den siste fysiske dataoverføringen inn i systemet. For de fleste air gap-bruksområder er det en akseptabel avveining gitt sikkerhetsfordelene.

Beslutningene om[ AI architecture](https://trigger.fish/architecture/) som tas tidlig i en air gapped-distribusjon, er vanskelige å endre senere, noe som gjør det betydelig viktigere å treffe det innledende designet riktig enn i et standard sky- eller on-premise-oppsett.



![Ai agent](/blog/images/usb.jpg)

### **Maskinvarehensyn**

Air gapped AI-systemer kan ikke stole på skybasert maskinvareskalering. Den datakraften du klargjør i begynnelsen, er det du har. Det gjør nøyaktig kapasitetsplanlegging kritisk.


<table>
  <thead>
    <tr>
      <th>Organisasjonstype</th>
      <th>Typisk modellstørrelse</th>
      <th>Maskinvaretilnærming</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Liten sikker arbeidsgruppe, begrensede spørringer</td>
      <td>7B til 13B parametere</td>
      <td>Én avansert arbeidsstasjon med GPU</td>
    </tr>
    <tr>
      <td>Sikker avdeling av middels størrelse</td>
      <td>13B til 34B parametere</td>
      <td>Dedikert server med flere GPU-er</td>
    </tr>
    <tr>
      <td>Etats- eller virksomhetsskala</td>
      <td>34B til 70B parametere</td>
      <td>Multi-node GPU-klynge, on-site</td>
    </tr>
    <tr>
      <td>Forskning med multimodale behov</td>
      <td>Spesialiserte store modeller</td>
      <td>Skreddersydd maskinvareanskaffelse påkrevd</td>
    </tr>
  </tbody>
</table>



Redundansplanlegging betyr mer her enn i tilkoblede miljøer. Når maskinvare svikter i et skyoppsett, flytter kapasitet seg automatisk. I et air gapped-miljø betyr en maskinvarefeil redusert kapasitet inntil en fysisk erstatning er anskaffet, renset og installert. Å bygge redundans inn i den opprinnelige maskinvarespesifikasjonen er ikke valgfritt i produksjonsmiljøer.

## **Den operasjonelle virkeligheten ved å kjøre air gapped AI**

### **Hvordan hverdagen faktisk ser ut**

Organisasjoner som kjører air gapped-systemer, utvikler disiplinerte operasjonelle rytmer rundt begrensningene. Modelloppdateringer skjer i en planlagt syklus i stedet for på forespørsel. Dataimporter følger dokumenterte prosedyrer med flere godkjenninger. Resultatuttak gjennomgås før noe forlater det sikre perimeteret.

Denne planmessigheten er faktisk en fordel i visse sammenhenger. Hver endring i AI-miljøet spores, dokumenteres og kan revideres. I regulerte bransjer har det revisjonssporet reell verdi. I graderte miljøer er det obligatorisk.

Utfordringen er at det også bremser ting sammenlignet med det team som er vant til AI-verktøy i skyen, kan forvente. Prompt-iterasjon som tar sekunder på en skyplattform, kan ta dager i et air gapped-miljø dersom det krever import av nye data eller å skyve en modelloppdatering gjennom den fysiske overføringsprosessen.

Et nyttig referansepunkt er tilnærmingen som dekkes i[ AI guide](https://trigger.fish/guide/)-ressurser om fasevis distribusjon, som gjelder direkte her. Å starte med et snevert, veldefinert bruksområde før omfanget av det air gappede systemet utvides, hindrer at scope creep skaper operasjonelle problemer før teamet har utviklet den prosedyremessige muskulaturen for å håndtere miljøet.

### **Krav til bemanning og kompetanse**

Å drifte et air gapped AI-system krever folk som forstår både AI-stacken og sikkerhetsprotokollene som styrer det isolerte miljøet. Den kombinasjonen er genuint sjelden og krever betydelig kompensasjon. De spesialiserte rollene som er involvert i å administrere graderte eller air gappede AI-miljøer, hører til blant de bedre betalte stillingene i teknologisektoren, noe som gjenspeiler knappheten på folk som har nødvendige klareringer sammen med praktiske ferdigheter innen AI-ingeniørarbeid.

Organisasjoner som setter opp disse systemene for første gang, undervurderer typisk bemanningens kompleksitet. Planlegg for dedikert personell som eier livssyklusen for modellforvaltning, ikke bare IT-generalister som håndterer det som et sekundært ansvar.

## **Air gapped vs. andre tilnærminger til privat distribusjon**

Beslutningen mellom et fullt air gap og en godt sikret privat distribusjon er ikke alltid åpenbar. Her er en praktisk måte å tenke gjennom det på.

Hvis hovedbekymringen din er personvern og etterlevelse, vil en korrekt konfigurert on-premise-distribusjon med sterke tilgangskontroller og ingen eksponering mot det offentlige internett typisk tilfredsstille kravet uten det operasjonelle overheadet ved ekte air gapping.

Hvis bekymringen din involverer trusselaktører med sofistikerte evner, inkludert angrep på nasjonsnivå, innsidetrusler eller ethvert scenario der selv kryptert nettverkstrafikk representerer en uakseptabel risiko, så håndterer air gapping den trusselmodellen som andre tilnærminger ikke kan.

Den ærlige vurderingen for de fleste virksomheter er at ekte air gapping er mer enn de trenger. Selskapene som faktisk trenger det, har en tendens til å vite at de trenger det før de begynner å undersøke alternativer. Regulatoriske, kontraktsmessige eller misjonskontekstuelle krav tar vanligvis avgjørelsen for dem.

## **Ting å vite**

Noen detaljer som har en tendens til å bli oversett i tidlige samtaler om air gapped AI-distribusjoner:

Fysisk sikkerhet betyr like mye som digital sikkerhet. Et air gapped-system er bare så sikkert som rommet det står i. Fysiske tilgangskontroller, overvåkning og personellvetting er like viktige som ethvert teknisk sikkerhetstiltak.

Innsidetrusselen er den primære gjenværende risikoen. Når du fjerner nettverksbaserte angrepsvektorer, er den realistiske gjenværende trusselen noen med fysisk tilgang til systemet. Personellscreening og tilgangslogging blir frontlinjens sikkerhetskontroller.

Å teste oppdateringer før distribusjon betyr enormt mye. I et tilkoblet miljø kan en dårlig modelloppdatering rulles tilbake raskt. I et air gapped-miljø betyr tilbakerulling enda en fysisk overføringssyklus. Staging-miljøer som speiler det air gappede oppsettet, hjelper med å fange opp problemer før de når produksjon.

Energi- og kjøleinfrastruktur trenger planlegging. Air gapped-systemer som kjører store GPU-arbeidslaster, genererer betydelig varme og trekker mye effekt. Bygningsplanleggingen må ta høyde for dette tidlig.

Dokumentasjonskravene er omfattende. Hver prosedyre som involverer det air gappede miljøet, må dokumenteres grundig, ikke bare for etterlevelse, men fordi prosedyremessig konsistens er det som forhindrer sikkerhetshendelser i fysiske overføringsarbeidsflyter.

Åpen kildekode-modeller foretrekkes sterkt i disse miljøene. Proprietære modeller som krever lisensvalideringsanrop eller rapportering av brukstelemetri er grunnleggende uforenlige med ekte nettverksisolasjon. Økosystemet for åpne modeller er det praktiske fundamentet for nesten enhver air gapped AI-distribusjon.

## **Når air gapped AI er verdt hver eneste bit av overheadet**

Den operasjonelle kompleksiteten og kostnadspremien ved air gapped AI er reell. Det krever mer av teamet ditt, mer av lokalene dine og mer av planleggingsprosessene dine enn enhver annen distribusjonstilnærming. For organisasjoner der trusselmodellen rettferdiggjør det, er det overheadet ikke bare akseptabelt, det er selve poenget.

Isolasjonen i seg selv er produktet. Alt annet systemet gjør, svarer på spørringer, analyserer dokumenter, oppdager anomalier, støtter beslutninger, skjer innenfor et perimeter ingen ekstern aktør kan nå. For organisasjonene som trenger den garantien, leverer ingen annen arkitektur den.

## **Ofte stilte spørsmål**

### **Hva er et air gap i AI?**

**Et air gap i AI viser til fullstendig fysisk og nettverksmessig isolasjon av AI-systemet, det vil si ingen internettforbindelse, ingen ekstern nettverkstilgang og ingen trådløse grensesnitt av noe slag.** Data beveger seg inn og ut bare gjennom kontrollerte fysiske medieoverføringer, noe som gjør det til den sikreste distribusjonsarkitekturen tilgjengelig for sensitive AI-arbeidslaster.

### **Hva betyr «air gapped»?**

**Air gapped betyr at et system er fysisk isolert fra alle eksterne nettverk, med et bokstavelig luftgap mellom det og enhver tilkoblet infrastruktur.** Begrepet oppsto i militær- og myndighetsdatabehandling og har utvidet seg til å beskrive enhver distribusjon der nettverksisolasjon brukes som den primære sikkerhetskontrollen.

### **Hva er $900 000-AI-jobben?**

**$900 000-AI-jobben viser typisk til svært spesialiserte AI-sikkerhetsforskere eller hovedforskere innen AI hos de største teknologiselskapene hvis totale kompensasjonspakker har nådd det området på grunn av aksjer og bonuser.** Roller som kombinerer AI-ingeniørkompetanse med sikkerhetsklareringer for graderte miljøer, krever også eksepsjonell kompensasjon som gjenspeiler knappheten på kvalifiserte kandidater som oppfyller begge kravene.

### **Hva er 30 %-regelen i AI?**

**30 %-regelen i AI er en retningslinje som antyder at AI bør automatisere omtrent 30 % av en gitt arbeidsflyt, og overlate de resterende 70 % til menneskelig dømmekraft og kontekstuell resonnering.** Den hjelper organisasjoner med å identifisere realistiske automatiseringsmål uten å overdesigne prosesser som fortsatt avhenger av menneskelig beslutningstaking.

### **Hvilke jobber vil ikke lenger eksistere i 2030?**

**Roller sentrert rundt repeterende dataregistrering, grunnleggende dokumentbehandling, rutinemessig håndtering av kundehenvendelser og manuell rapportgenerering forventes i stor grad å avta betydelig innen 2030 etter hvert som AI-systemer absorberer disse funksjonene.** Imidlertid spår de fleste analytikere at omforming av yrker snarere enn fullstendig avvikling vil være det dominerende mønsteret, med nye roller som vokser frem rundt AI-forvaltning, tilsyn og distribusjon.
