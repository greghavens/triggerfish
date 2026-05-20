---
title: "Sikkerhetsvurdering av AI-leverandører: hvordan evaluere AI-verktøy før
  du betror dem dataene dine"
date: 2026-04-05
description: En sikkerhetsvurdering av AI-leverandører verifiserer at
  AI-verktøyene oppfyller standardene dine for databeskyttelse, samsvar og
  sikkerhet før de tas i bruk. Slik gjør du det riktig.
author: triggerfish
tags:
  - AI agent
draft: false
---
En sikkerhetsvurdering av AI-leverandører er en strukturert evalueringsprosess som avgjør om et verktøy eller en plattform for kunstig intelligens oppfyller en organisasjons krav til sikkerhet, samsvar og databeskyttelse før leverandøren får tilgang til organisasjonens data eller integreres i forretningsarbeidsflyter. Den erstatter antakelser med dokumentasjon på det punktet i anskaffelsesprosessen der konsekvensene av å ta feil fortsatt er håndterbare.

De fleste organisasjoner har prosesser for sikkerhetsvurdering av leverandører som fungerer rimelig godt for konvensjonell programvare. Leverandøren fyller ut et spørreskjema. Juridisk gjennomgår kontrakten. IT sjekker sertifiseringene. Verktøyet tas i bruk. For AI-leverandører er det imidlertid mye denne prosessen overser som betyr noe. Spørsmålene som avdekker de mest betydelige risikoene i AI-leverandørforhold finnes ikke i standard IT-leverandørspørreskjemaer. Det er spørsmål om bruk av modellens treningsdata, om jurisdiksjonen til inferensinfrastrukturen, om hva som skjer med data når en samtale avsluttes, og om hvorvidt sikkerhetssertifiseringen leverandøren presenterer faktisk dekker det spesifikke produktet som tas i bruk eller en annen del av infrastrukturen deres. Organisasjonene som oppdager disse hullene etter at kontrakter er signert og sensitive data har flytt gjennom systemer de ikke har vurdert riktig, er de som utfører vurderingen mer omhyggelig andre gang. Denne veiledningen forklarer hvordan du gjennomfører en sikkerhetsvurdering av AI-leverandører som fanger opp det som er viktig, hvilken dokumentasjon du bør kreve i stedet for å akseptere på påstand, og hvordan du bygger vurderingsprosessen til en gjentakbar organisatorisk kapasitet.



![AI agent](/blog/images/procurement.jpg)

## **Hvorfor standard leverandørvurderinger kommer til kort for AI**

### **Hullene som generiske spørreskjemaer overser**

Standard sikkerhetsspørreskjemaer for IT-leverandører ble utviklet for et programvaremiljø der de primære sikkerhetsbekymringene var datalagringssikkerhet, tilgangskontroller og nettverksbeskyttelse. Disse bekymringene gjelder også for AI-leverandører. Men AI-systemer introduserer et sett med ytterligere bekymringer som generiske spørreskjemaer ikke ble utformet for å avdekke og som leverandører ikke vil opplyse om hvis de ikke spesifikt blir spurt.

Bruk av modellens treningsdata er det første hullet. Om en leverandør bruker data som sendes inn gjennom produktet deres til å trene eller forbedre AI-modellene sine, er et av de mest avgjørende spørsmålene om datahåndtering for organisasjoner som behandler proprietær eller sensitiv informasjon gjennom AI-verktøy. Det er også et spørsmål som standard leverandørspørreskjemaer ikke inneholder fordi det ikke har noen ekvivalent i konvensjonell programvareanskaffelse. En databaseleverandør trener ikke produktet sitt på dataene dine. En AI-leverandør kan gjøre det, og om de gjør det eller ikke er ofte begravd i bruksvilkårsspråk i stedet for fremtredende avslørt.

Beliggenhet av inferensinfrastruktur er det andre hullet. Hvor en AI-modell fysisk behandler dataene dine, avgjør hvilke juridiske rammeverk som gjelder for den behandlingen, om mekanismer for grenseoverskridende dataoverføring er nødvendige, og hvilken jurisdiksjons rettsprosess som kan tvinge frem utlevering av disse dataene. Standard leverandørvurderinger spør hvor data lagres. AI-vurderinger må separat spørre hvor data behandles under inferens, som kan være annen infrastruktur i en annen beliggenhet.

Omfangsgrensen for sikkerhetssertifiseringer er det tredje hullet. En leverandør kan presentere en SOC 2 Type 2-rapport som dekker skyinfrastrukturen deres, mens det spesifikke AI-produktet som vurderes kjører på en annen infrastruktur som ikke er innenfor revisjonsomfanget. Uten å verifisere at sertifiseringene som presenteres dekker det spesifikke produktet og infrastrukturen som er relevant for din implementering, kan en sertifiseringsgjennomgang gi falsk trygghet om en implementering som aldri ble undersøkt.

Å forstå hvordan vurderingskravene for [AI security](https://trigger.fish/security/) skiller seg fra konvensjonell sikkerhetsevaluering av leverandører, hjelper organisasjoner med å bygge vurderingsprosesser som adresserer det faktiske AI-risikolandskapet i stedet for det konvensjonelle programvarerisikolandskapet disse prosessene opprinnelig ble utformet for.



![AI agent](/blog/images/security-reviewing.jpg)

## **Bygging av rammeverket for sikkerhetsvurdering av AI-leverandører**

### **De fem domenene hver vurdering må dekke**

En effektiv sikkerhetsvurdering av AI-leverandører organiserer evalueringen sin på tvers av fem domener som sammen gir et fullstendig bilde av leverandørens sikkerhetsposisjon for den spesifikke implementeringen som vurderes. Hvert domene tar for seg en distinkt risikodimensjon som de andre ikke dekker, og det er derfor vurderinger som fokuserer på ett eller to domener mens de hopper over resten konsekvent overser materielle risikoer.

**Teknisk sikkerhet** dekker infrastrukturkontrollene som beskytter data som behandles av leverandørens AI-systemer. Dette er domenet som overlapper mest med konvensjonell sikkerhetsvurdering av leverandører og dekker krypteringsstandarder, nettverkssikkerhetsarkitektur, praksis for sårbarhetshåndtering, evne til hendelsesdeteksjon og respons, og den fysiske sikkerheten til infrastrukturen som kjører AI-arbeidsbelastningene.

**Datastyring** dekker hva leverandøren gjør med organisasjonsdata gjennom hele livssyklusen i systemene deres. Dette domenet inkluderer retningslinjer for bruk av treningsdata, praksis for oppbevaring av inferenslogger, evne til og tidslinjer for datasletting, underleverandørforhold og deres datatilgang, mekanismer for grenseoverskridende dataoverføring, og den kontraktsmessige beskyttelsen som styrer alt det ovennevnte.

**Samsvar og sertifisering** dekker den uavhengige verifiseringen av leverandørens sikkerhetspåstander og de regulatoriske rammeverkene produktet deres kan støtte. Dette domenet inkluderer gjennomgang av spesifikke sertifiseringsdokumenter i stedet for å akseptere leverandøruttalelser, verifisering av sertifiseringsomfang og gyldighet, vurdering av tilgjengeligheten av nødvendige dataavtaler, og bekreftelse av støtte for sektorspesifikke samsvarskrav som gjelder for organisasjonen din.

**AI-spesifikk sikkerhet** dekker risikoene som er unike for AI-systemer og som ikke har noen ekvivalent i konvensjonelle leverandørvurderinger av programvare. Dette domenet inkluderer mottakelighet for prompt injection og mottiltak, testing av adversariell robusthet, beskyttelse mot modellekstraksjon, hallusinasjonsrater og avbøtende tilnærminger for det spesifikke bruksområdet som tas i bruk, og leverandørens tilnærming til modelloppdateringer og atferdsendringshåndtering.

**Operasjonell sikkerhet** dekker leverandørens sikkerhetspraksiser som organisasjon i stedet for de tekniske kontrollene til det spesifikke produktet deres. Dette domenet inkluderer struktur og ekspertise i sikkerhetsteamet, praksis for sikkerhetsoffentliggjøring og sårbarhetshåndtering, prosesser for brudd-varsling og historisk hendelsesregistrering, og leverandørens egen forsyningskjedesikkerhet for komponentene og tjenestene AI-produktet deres er avhengig av.


<table>
  <thead>
    <tr>
      <th>Vurderingsdomene</th>
      <th>Hovedspørsmål</th>
      <th>Påkrevd dokumentasjon</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Teknisk sikkerhet</td>
      <td>Krypteringsstandarder, nettverksarkitektur, sårbarhetshåndtering</td>
      <td>SOC 2 Type 2-rapport, sammendrag av penetrasjonstester</td>
    </tr>
    <tr>
      <td>Datastyring</td>
      <td>Bruk av treningsdata, oppbevaringsperioder, sletteevner, underleverandører</td>
      <td>Kontraktsvilkår, databehandleravtale, liste over underleverandører</td>
    </tr>
    <tr>
      <td>Samsvar og sertifisering</td>
      <td>Sertifiseringsomfang og gyldighet, tilgjengelighet av dataavtaler, regulatorisk støtte</td>
      <td>Gjeldende sertifiseringsdokumenter, signert DPA eller BAA</td>
    </tr>
    <tr>
      <td>AI-spesifikk sikkerhet</td>
      <td>Kontroller mot prompt injection, adversariell robusthet, praksis for modelloppdateringer</td>
      <td>Teknisk dokumentasjon, resultater av sikkerhetstesting</td>
    </tr>
    <tr>
      <td>Operasjonell sikkerhet</td>
      <td>Sikkerhetsteam, praksis for offentliggjøring, hendelseshistorikk, forsyningskjede</td>
      <td>Sikkerhetsoffentliggjøringer, historikk over hendelsesvarslinger</td>
    </tr>
  </tbody>
</table>



### **Dokumentasjonsstandarden som skiller vurdering fra aksept**

Den viktigste disiplinen i sikkerhetsvurdering av AI-leverandører er å kreve dokumentasjon i stedet for å akseptere påstander. Leverandørens sikkerhetspåstander i salgssamtaler, markedsføringsmateriell og selv leverandørutfylte spørreskjemaer er ikke uavhengig verifiserte faktauttalelser. De er representasjoner hvis nøyaktighet avhenger av leverandørens egen vurdering av sin sikkerhetsposisjon og deres kommersielle insentiv til å presentere den gunstig.

Dokumentasjonsbasert vurdering krever at hver betydelig sikkerhetspåstand støttes av dokumentasjon som en uavhengig part har verifisert eller som organisasjonen kan verifisere direkte. En leverandør som hevder SOC 2-samsvar bør fremlegge den faktiske SOC 2-rapporten, ikke et sammendrag eller en merkelapp. Rapporten bør leses, ikke bare mottas, med oppmerksomhet på omfangsgrensen, revisjonsperioden, de spesifikke kontrollene som er testet, og eventuelle unntak eller avvik som er notert. En leverandør som hevder at produktet deres ikke bruker kundedata til modelltrening, bør ha det forbudet dokumentert i kontraktsvilkårene som vil styre forholdet, ikke bare uttalt i en salgssamtale.

Verifiseringsdisiplinen strekker seg til sertifiseringene selv. SOC 2-revisorer varierer i kvalitet og strenghet. En revisjonsrapport fra et anerkjent firma med påvist teknologisektorekspertise gir sterkere dokumentasjon enn en fra et ukjent firma med begrenset teknologirevisjonshistorikk. Rapporteringsperioden er viktig fordi en rapport som dekker en svært kort revisjonsperiode kan reflektere en førstegangsrevisjon utformet for å oppnå sertifisering raskt i stedet for et modent, vedvarende sikkerhetsprogram.

Gjennomgang av hvordan dokumentasjon om [AI architecture](https://trigger.fish/architecture/) fra leverandører beskriver sikkerhetskontrollene sine, hjelper vurderere med å evaluere om den tekniske arkitekturen som presenteres er sammenhengende og forsvarbar, eller om den beskriver sikkerhet på et abstraksjonsnivå som skjuler meningsfulle hull.

## **De AI-spesifikke spørsmålene som betyr mest**

### **Hva du skal spørre om bruk av treningsdata**

Spørsmålet om bruk av treningsdata krever mer presisjon enn et ja-eller-nei-svar fordi praksisene som skaper meningsfull risiko er mer spesifikke enn det generelle spørsmålet fanger opp. En leverandør som svarer at de ikke bruker kundedata til trening, kan mene noe snevrere enn spørsmålet impliserer.

Spør om samtaleinnhold, inkludert både prompts og responser, brukes til modelltrening eller fine-tuning under noen omstendigheter, inkludert med kundesamtykke innhentet gjennom bruksvilkår. Spør om aggregerte eller anonymiserte versjoner av kundedata bidrar til modellforbedring. Spør om forbudet gjelder for alle produktnivåer eller bare for enterprise-nivået som vurderes. Spør om forbudet er absolutt eller om det kan frafalles ved kundeavtale. Og spør om hvordan forbudet håndheves teknisk, ikke bare kontraktsmessig, siden et kontraktsmessig forbud som ikke håndheves teknisk er helt avhengig av leverandørens operasjonelle samsvar i stedet for arkitektoniske garantier.

Svarene på disse spesifikke oppfølgingsspørsmålene avslører ofte at praksiser for bruk av treningsdata er mer nyanserte enn innledende leverandøruttalelser antyder, og at beskyttelsene som er tilgjengelige på enterprise-nivået organisasjonen vurderer, kan skille seg fra standard produktvilkår på måter som har betydning for det spesifikke bruksområdet som vurderes.

### **Hva du skal spørre om inferensinfrastruktur og databosted**

Infrastrukturspørsmålet for AI-systemer krever at man spør separat om hvor modellvekter lagres, hvor inferens beregningsmessig skjer, hvor inndata behandles, hvor utdata og logger lagres, og hvor hver av disse forekommer i konteksten av det spesifikke produktnivået som tas i bruk i stedet for leverandørens infrastruktur generelt.

For organisasjoner med databostedforpliktelser er spørsmålet om inferensbeliggenhet ofte mer umiddelbart konsekvensiell enn spørsmålet om lagringsbeliggenhet fordi de regulatoriske rammeverkene som driver bostedskrav i de fleste jurisdiksjoner behandler behandlingsjurisdiksjon ekvivalent med lagringsjurisdiksjon. En leverandør hvis lagringsinfrastruktur er plassert i den nødvendige jurisdiksjonen, men hvis inferensbehandling skjer andre steder, har ikke oppfylt bostedskravet selv om lagringskontrollene er fullt ut i samsvar.

Be leverandøren om å levere et dataflytdiagram som sporer organisasjonsdata fra innsending gjennom inferens, utdata og logging til sletting, med den fysiske beliggenheten til hvert trinn klart angitt. Hvis leverandøren ikke kan produsere denne dokumentasjonen, er hullet i deres egen forståelse av dataflytene deres i seg selv et meningsfullt sikkerhetsfunn.



![AI agent](/blog/images/security-team-review.jpg)

### **Hva du skal spørre om modelloppdateringer og atferdsendringer**

AI-leverandører oppdaterer de underliggende modellene sine etter tidsplaner som ikke alltid kommuniseres til kundene på forhånd. En modelloppdatering kan endre et AI-systems atferd på måter som påvirker sikkerhetsposisjonen, samsvaret med kundens krav om akseptabel bruk, eller utdataenes kvalitet for det spesifikke bruksområdet kunden har tatt det i bruk for.

Spør om hvordan leverandøren varsler kunder om modelloppdateringer som påvirker atferd som er relevant for sikkerhet eller samsvar. Spør om enterprise-kunder har muligheten til å forbli på en spesifikk modellversjon i stedet for å motta automatiske oppdateringer. Spør om hvordan leverandøren tester modelloppdateringer for sikkerhetsregresjoner før de tas i bruk i kundemiljøer. Og spør om hva kundens rettsmiddel er hvis en modelloppdatering endrer atferd på måter som påvirker samsvar eller sikkerhet i kundens implementering.

Svarene avslører graden av kontroll organisasjonen vil ha over en kjernekomponent i det implementerte AI-systemet og leverandørens filosofi om kundedeltakelse i modellens livssyklus. Organisasjoner hvis implementerte AI-systemer brukes i regulerte kontekster eller beslutningsstøtte med høy innsats, har sterkere interesser i modellstabilitet og oppdateringsvarsling enn de som bruker AI for produktivitetsapplikasjoner med lavere innsats.

## **Kontraktsmessig beskyttelse som vurderingen må etablere**

### **Avtalene som må være på plass før data strømmer**

Den kontraktsmessige fasen av en sikkerhetsvurdering av AI-leverandører oversetter de tekniske og styringsmessige funnene til juridisk håndhevbare beskyttelser. Tekniske kontroller beskytter data på leverandørens infrastruktur. Kontraktsmessige beskyttelser definerer de juridiske forpliktelsene som styrer hvordan den infrastrukturen drives og hvilke rettsmidler organisasjonen har når forpliktelser ikke oppfylles.

En databehandleravtale som dekker det spesifikke AI-produktet som tas i bruk er det grunnleggende kontraktsmessige kravet for enhver leverandør som behandler personopplysninger underlagt GDPR, CCPA eller tilsvarende rammeverk. DPA-en må eksplisitt ta opp forbud mot bruk av treningsdata, oppbevaringsgrenser etter kategori, forpliktelser om håndtering av underleverandører, tidslinjer for datasletting, og krav til brudd-varsling. En DPA-mal fra en leverandør som ble utarbeidet for generelle skytjenester, kan ikke nødvendigvis adekvat ta opp de AI-spesifikke hensynene som vurderingen har identifisert som relevante.

For helseorganisasjoner er en Business Associate Agreement en juridisk forutsetning før data som kan utgjøre beskyttet helseinformasjon strømmer gjennom leverandørens AI-system. BAA-en må dekke det spesifikke produktet som tas i bruk, ikke bare leverandørens infrastruktur generelt, og må bekrefte at AI-produktets datahåndteringspraksis er i samsvar med HIPAAs krav til tekniske sikkerhetstiltak.

Å forstå hvordan [AI features](https://trigger.fish/features/) i enterprise AI-plattformer er strukturert i forhold til de kontraktsmessige beskyttelsene som forhandles, hjelper organisasjoner med å identifisere hvor produktatferd og kontraktsvilkår er konsistente og hvor produktets tekniske virkelighet krever ytterligere kontraktsmessig spesifisitet for å oppnå beskyttelsen organisasjonen krever.


<table>
  <thead>
    <tr>
      <th>Påkrevd avtale</th>
      <th>Når den gjelder</th>
      <th>Kritiske vilkår for AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Databehandleravtale</td>
      <td>Enhver behandling av personopplysninger under GDPR eller ekvivalent</td>
      <td>Forbud mot treningsdata, oppbevaringsgrenser, liste over underleverandører</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Enhver behandling av PHI under HIPAA</td>
      <td>Produktspesifikk dekning, bekreftelse av tekniske sikkerhetstiltak</td>
    </tr>
    <tr>
      <td>Master Services Agreement</td>
      <td>Alle kommersielle leverandørforhold</td>
      <td>Ansvarsfordeling, bruddsanksjoner, datatilbakelevering ved opphør</td>
    </tr>
    <tr>
      <td>Sikkerhetstillegg</td>
      <td>Kontekster med svært sensitiv databehandling</td>
      <td>Spesifikke sikkerhetsforpliktelser utover standardvilkår</td>
    </tr>
    <tr>
      <td>Modellrisikodokumentasjon</td>
      <td>AI i regulerte finansaktiviteter</td>
      <td>Modelldokumentasjon, valideringsrettigheter, oppdateringsvarsling</td>
    </tr>
    <tr>
      <td>Taushetserklæring</td>
      <td>Selve vurderingsprosessen og sensitive funn</td>
      <td>Omfang som dekker vurderingsmetodikk og organisatoriske krav</td>
    </tr>
  </tbody>
</table>



### **Forhandling utover standardvilkår**

De fleste enterprise AI-leverandøravtaler starter med standardvilkår utarbeidet til fordel for leverandøren. Vurderingsprosessen bør identifisere de spesifikke vilkårene som krever endring basert på organisasjonens sikkerhetsfunn og samsvarskrav, i stedet for å forhandle mot standardvilkårene i sin helhet uten prioritering.

Vilkårene med høyest prioritet for forhandling er de som mest direkte påvirker sikkerhets- og samsvarsrisikoene vurderingen identifiserte. Klausuler om bruk av treningsdata som tillater bruk som organisasjonen trenger forbudt. Ansvarsbegrensninger som er utilstrekkelige for datakategoriene som behandles. Tidslinjer for brudd-varsling som ikke tilfredsstiller regulatoriske krav. Godkjenningsrettigheter for underleverandører som gir leverandøren mer fleksibilitet til å endre infrastrukturen sin enn organisasjonens samsvarskrav kan akkommodere.

Organisasjoner med betydelig anskaffelseshåndtak, enten gjennom avtalestørrelse, merkeverdi eller markedsposisjon, oppnår ofte meningsfulle forbedringer av standard AI-leverandørvilkår på akkurat disse punktene fordi leverandørene verdsetter forholdet tilstrekkelig til å imøtekomme krav som går utover standardmalen deres. Organisasjoner med begrenset håndtak kan noen ganger oppnå samme resultat ved å formulere krav i form av regulatorisk nødvendighet i stedet for preferanse, siden leverandører har kommersielle interesser i å støtte samsvarende implementeringer som strekker seg utover ethvert individuelt kundeforhold.

En grundig [AI guide](https://trigger.fish/guide/) om strukturering av AI-leverandøravtaler for sikkerhet og samsvar hjelper organisasjoner med å bygge forhandlingsrammer som prioriterer vilkårene som mest påvirker deres faktiske risikoeksponering, i stedet for å forsøke å forhandle hver klausul med samme intensitet.

## **Bygge vurdering inn i en gjentakbar prosess**

### **Vurderingsarbeidsflyten som skalerer**

Organisasjoner som gjennomfører sikkerhetsvurderinger av AI-leverandører som engangsprosjekter for hver betydelig AI-anskaffelse, bygger institusjonell kunnskap som ikke overføres effektivt til påfølgende vurderinger. Organisasjoner som bygger vurdering som en gjentakbar prosess med dokumentert metodikk, standard dokumentasjonsmaler og definerte beslutningskriterier utvikler en kapasitet som gjør hver vurdering raskere og mer konsistent enn den forrige.

En gjentakbar prosess for sikkerhetsvurdering av AI-leverandører inkluderer et standardisert spørreskjema utviklet spesifikt for AI-leverandører som dekker de fem vurderingsdomene, en liste over dokumentforespørsler som spesifiserer den nøyaktige dokumentasjonen som kreves for hver større sikkerhetspåstand, et scoring- eller beslutningsrammeverk som oversetter vurderingsfunn til implementeringsanbefalinger, en gjennomgangsprosess som involverer riktige interessenter på tvers av sikkerhet, juridisk, samsvar og forretningsfunksjoner, og en dokumentasjonsstandard som produserer poster nyttige for både intern styring og ekstern regulatorisk gransking.

Spørreskjemaet og dokumentforespørselslisten bør gjennomgås og oppdateres minst årlig for å innlemme nye AI-spesifikke sikkerhetshensyn som har dukket opp fra leverandørlandskapet, det regulatoriske miljøet, og organisasjonens egen implementeringserfaring. Vurderingsverktøyet som var omfattende for tolv måneder siden, kan ha meningsfulle hull i dag etter hvert som trussellandskapet for AI-sikkerhet og de regulatoriske forventningene rundt det fortsetter å utvikle seg.

### **Pågående vurdering utover innledende anskaffelse**

En sikkerhetsvurdering av AI-leverandører utført på tidspunktet for anskaffelse gir en punktevaluering i tid av leverandørens sikkerhetsposisjon. Den gir ikke pågående trygghet om at posisjonen forblir tilstrekkelig etter hvert som leverandørens produkt utvikler seg, infrastrukturen deres endres, eierskapet eller den økonomiske situasjonen deres skifter, eller nye sikkerhetssårbarheter dukker opp i teknologistakken deres.

Pågående vurdering for betydelige AI-leverandører bør inkludere årlig gjennomgang av oppdaterte sertifiseringer og sikkerhetsdokumentasjon, gjennomgang av eventuelle sikkerhetshendelseopplysninger eller brudd-varslinger fra leverandøren, vurdering av materielle endringer i leverandørens bruksvilkår eller personvernregler som påvirker datahåndteringspraksisene den innledende vurderingen evaluerte, og gjennomgang av eventuelle betydelige endringer i leverandørens AI-produkt, infrastruktur eller eierskap som kan påvirke sikkerhetsantagelsene som ligger til grunn for den innledende vurderingen.

Organisasjoner som behandler sikkerhetsvurdering av AI-leverandører som et anskaffelsessjekkpunkt i stedet for en pågående praksis for relasjonshåndtering, akkumulerer den gradvise driften mellom deres dokumenterte sikkerhetsantagelser og den faktiske leverandørsikkerhetsposisjonen som gjør hendelsesoppdaging så kostbar sammenlignet med proaktiv overvåking.

## **Ting å vite**

Flere viktige realiteter om sikkerhetsvurdering av AI-leverandører som organisasjoner konsekvent møter etter hvert som programmene deres modnes:

Vurderingens omfang må stemme nøyaktig med implementeringens omfang. En sikkerhetsvurdering som dekker en leverandørs enterprise-API gir ikke trygghet om leverandørens forbrukerprodukt. En vurdering som dekker en leverandørs tekstgenereringsprodukt dekker ikke bildegenereringsproduktet deres selv om begge har samme merkenavn. Definer det spesifikke produktet, nivået og implementeringskonfigurasjonen som vurderes og bekreft at hver sertifisering og kontraktsmessig beskyttelse som gjennomgås dekker det spesifikke omfanget.

Samtaler med referansekunder supplerer dokumentgjennomgang på måter dokumentasjon ikke kan replikere. Å snakke med organisasjoner av lignende størrelse, bransje og regulatorisk profil som har tatt i bruk samme leverandørs AI-produkt, gir kvalitativ innsikt i leverandørresponsivitet, faktiske datahåndteringspraksiser versus dokumenterte, og den praktiske erfaringen med å drifte leverandørforholdet som ingen dokumentgjennomgang fanger opp.

Leverandørens finansielle stabilitet er en legitim sikkerhetsvurderingsdimensjon. En AI-leverandør som opphører driften skaper utfordringer med dataportabilitet, sletting og revisjonsspor som kan bli samsvarsproblemer. Å vurdere leverandørens finansielle helse, finansieringsrekkevidde og markedsposisjon er passende for AI-leverandører som vurderes for betydelige produksjonsimplementeringer, spesielt de der ekstrahert eller trent data skaper pågående avhengigheter.

30%-prinsippet gjelder for tildeling av vurderingsinnsats. Omtrent 30% av vurderingsinnsatsen bør gå til det tekniske sikkerhetsdomenet som vurderingsprosesser oftest overinvesterer i i forhold til dets faktiske risikobidrag. De resterende 70% bør dekke datastyring, kontraktsmessige beskyttelser, AI-spesifikke risikoer, og operasjonelle sikkerhetsdimensjoner som avslører de mest meningsfulle differensieringene mellom leverandører hvis sertifiseringer ser like ut på overflaten.

Vurderingsfunn må kommuniseres til forretningsinteressenter i risikobegreper i stedet for teknisk språk. Et funn om at en leverandørs SOC 2-revisjonsomfang ekskluderer AI-inferensinfrastrukturen er teknisk nøyaktig, men ikke handlingsdyktig for forretningsbeslutningstakere uten oversettelse til forretningsrisikobegreper. Funnet om at leverandøren ikke har uavhengig verifisert sikkerheten til systemene som vil behandle dine mest sensitive data er det samme funnet i språk som produserer beslutninger.

Triggere for omvurdering må defineres på forhånd. Spesifikke hendelser som bør utløse en ny eller delvis sikkerhetsvurdering av AI-leverandør, inkludert betydelige leverandørhendelser, materielle endringer i bruksvilkår, leverandøroppkjøp eller eierskapsendringer, og betydelige endringer i produktarkitektur, bør defineres i vurderingsprosessen i stedet for å bestemmes ad hoc når disse hendelsene inntreffer.

## **Sikkerhetsvurdering av AI-leverandører som konkurranseutvalgsverktøy**

Organisasjoner som gjennomfører grundige sikkerhetsvurderinger av AI-leverandører finner konsekvent at prosessen gjør mer enn å identifisere uakseptable leverandører. Den avslører meningsfull differensiering mellom leverandører hvis sertifiseringer og markedsføring fremstår like, men hvis faktiske sikkerhetspraksiser skiller seg betydelig når de undersøkes på dokumentasjonsnivå i stedet for påstandsnivå.

Den differensieringen er kommersielt nyttig utover dens risikohåndteringsverdi. Leverandører som investerer i ekte sikkerhetsinfrastruktur, opprettholder gjeldende og omfattende sertifiseringer, opererer transparente datahåndteringspraksiser, og støtter de kontraktsmessige beskyttelsene regulerte organisasjoner krever, har gjort sikkerhet til en konkurransefordel i stedet for en samsvarskostnad. Å identifisere disse leverandørene gjennom rigorøs vurdering og bygge varige forhold med dem produserer anskaffelsesresultater som vokser i verdi etter hvert som AI-verktøylandskapet fortsetter å utvikle seg og sikkerhetskrav fortsetter å skjerpes.

Sikkerhetsvurderingen av AI-leverandører er der forpliktelsen til ansvarlig AI-adopsjon møter den operasjonelle virkeligheten av å velge hvem som skal betros dataene som betyr mest. Organisasjoner som gjør det arbeidet grundig, konsekvent og med dokumentasjonsstandardene det fortjener, bygger leverandørforhold som støtter deres AI-ambisjoner i stedet for å skape de uoppdagede forpliktelsene som utilstrekkelig vurdering uunngåelig etterlater.

## **Vanlige spørsmål**

### **Hvordan evaluere AI-leverandører?**

**Å evaluere AI-leverandører krever en strukturert vurdering på tvers av fem domener: tekniske sikkerhetskontroller verifisert gjennom gjeldende sertifiseringsdokumenter, datastyringspraksis som dekker bruk av treningsdata og oppbevaring verifisert gjennom kontraktsvilkår, samsvarssertifiseringsomfang og gyldighet verifisert gjennom faktiske rapporter i stedet for leverandøruttalelser, AI-spesifikke sikkerhetshensyn inkludert kontroller mot prompt injection og praksis for modelloppdateringer, og operasjonell sikkerhet som dekker leverandørens organisatoriske sikkerhetspraksiser og hendelseshistorikk.** Vurderingen produserer implementeringsbeslutninger basert på dokumentasjon i stedet for leverandørpåstander, med kontraktsmessige beskyttelser etablert før eventuelle organisasjonsdata strømmer gjennom leverandørens system.

### **Hva er sikkerhetsvurderingen ved bruk av AI?**

**En sikkerhetsvurdering ved bruk av AI refererer til anvendelsen av kunstig intelligens-verktøy for å forbedre effektiviteten og dekningen av sikkerhetsvurderingsprosesser, inkludert bruk av AI til å analysere leverandørdokumentasjon for sikkerhetsrelevante klausuler, automatisere analyse av spørreskjemarespons på tvers av flere leverandørinnsendinger, kontinuerlig overvåke leverandørenes sikkerhetsoffentliggjøringer og hendelsesvarslinger, og identifisere mønstre i data om leverandørens sikkerhetsposisjon som manuelle gjennomgangsprosesser ville gå glipp av.** Det er forskjellig fra sikkerhetsvurderingen av AI-leverandører, som vurderer sikkerheten til selve AI-verktøyene, selv om organisasjoner med modne sikkerhetsprogrammer i økende grad bruker AI for å forbedre både sine vurderingsprosesser av AI-leverandører og sine bredere sikkerhetsvurderingsevner.

### **Hva er en sikkerhetsvurdering av leverandør?**

**En sikkerhetsvurdering av leverandør er en strukturert evaluering av en tredjeparts teknologileverandørs sikkerhetskontroller, datahåndteringspraksis, samsvarssertifiseringer og kontraktsmessige beskyttelser før den leverandøren får tilgang til organisasjonsdata eller integreres i forretningssystemer.** Spesielt for AI-leverandører strekker vurderingen seg utover konvensjonell sikkerhetsevaluering av leverandører for å adressere de AI-spesifikke risikoene ved bruk av treningsdata, jurisdiksjon av inferensinfrastruktur, praksis for modelloppdateringer, og de AI-spesifikke angrepsoverflatene som standard IT-leverandørspørreskjemaer ikke ble utformet for å avdekke.

### **Hvilke tiltak kan settes på plass for å sikre at en AI-leverandør er trygg?**

**De fem viktigste tiltakene for å sikre at en AI-leverandør er trygg er å kreve gjeldende SOC 2 Type 2 eller tilsvarende sertifiseringsdokumenter som dekker det spesifikke produktet og infrastrukturen som tas i bruk, å innhente signerte databehandleravtaler med eksplisitte forbud mot treningsdata og definerte oppbevaringsgrenser før organisasjonsdata behandles, å verifisere at inferensinfrastruktur er plassert i jurisdiksjoner som tilfredsstiller gjeldende databostedskrav, å bekrefte gjennom kontraktsvilkår og teknisk dokumentasjon at leverandørens sikkerhetskontroller adresserer AI-spesifikke risikoer inkludert prompt injection og modellekstraksjon, og å etablere en pågående leverandørovervåkingsprosess som gjennomgår sertifiseringsfornyelser, hendelsesoffentliggjøringer og materielle endringer i bruksvilkår i en definert årlig syklus.** Sammen skaper disse tiltakene et sikkerhetsforhold med AI-leverandøren basert på verifisert dokumentasjon og håndhevbare forpliktelser i stedet for uverifiserte påstander og antatt god tro.

### **Hva er 5 sikkerhetstiltak?**

**De fem grunnleggende sikkerhetstiltakene som gjelder på tvers av AI-leverandørforhold er kryptering av data under overføring og i hvile ved bruk av gjeldende standarder med dokumenterte nøkkelhåndteringspraksiser, tilgangskontroller som begrenser hvem i leverandørorganisasjonen som kan få tilgang til organisasjonsdata og under hvilke betingelser, omfattende logging av alle datatilgangs- og behandlingshendelser med oppbevaringsperioder som støtter hendelsesetterforskning, sårbarhetshåndteringspraksiser inkludert regelmessig sikkerhetstesting og definerte utbedringstidslinjer for identifiserte sårbarheter, og brudd-varslingsprosesser som forplikter leverandøren til rettidig offentliggjøring med spesifikke tidslinjer som tilfredsstiller organisasjonens regulatoriske varslingsforpliktelser.** Disse fem tiltakene representerer den tekniske sikkerhetsbasislinjen som bør verifiseres gjennom dokumentasjon for hver AI-leverandør som vurderes for betydelig databehandlingsansvar, med de AI-spesifikke vurderingsdimensjonene lagdelt på toppen av denne konvensjonelle sikkerhetsfundamentet.
