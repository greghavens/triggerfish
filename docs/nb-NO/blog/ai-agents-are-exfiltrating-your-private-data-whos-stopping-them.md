---
title: AI-agenter eksfiltrerer de private dataene dine. Hvem stopper dem?
date: 2026-03-10
description: De fleste AI-agentplattformer håndhever sikkerhet ved å fortelle
  modellen hva den ikke skal gjøre. Modellen kan overtales til det. Her er
  hvordan alternativet ser ut.
author: Greg Havens
tags:
  - ai
  - ai agents
  - security
  - open source
  - self-hosted
  - prompt injection
  - data exfiltration
  - agent security
  - openclaw
  - triggerfish
draft: false
---
![](/blog/images/gemini_generated_image_i7ytlui7ytlui7yt.jpg)

AI-agenter er nyttige fordi de kan ta handling. Det er hele poenget. Du gir en agent tilgang til verktøyene dine, og den kan gjøre ting: sende en melding, oppdatere en post, søke i en fil, kjøre en spørring, pushe en commit. Demoene er imponerende. De faktiske distribusjonene, hvis du ser nøye på sikkerhetsmodellen under dem, er en annen historie.

Spørsmålet ingen stiller høyt nok akkurat nå er enkelt. Når en AI-agent har skrivetilgang til databasen din, e-posten din, kalenderen din, Salesforce-instansen din, GitHub-repositoriene dine, hva er det som stopper den fra å gjøre noe den ikke burde? Det ærlige svaret, i de fleste tilfeller, er en setning i systemprompten.

Det er situasjonen vi er i.

## Problemet med å be modellen oppføre seg

Når du distribuerer en AI-agent i dag, er standard sikkerhetspraksis å skrive instruksjoner inn i systemprompten. Fortell modellen hva den ikke har lov til å gjøre. Fortell den hvilke verktøy som er utenfor grensene. Fortell den å spørre før den tar destruktive handlinger. Noen plattformer lar deg konfigurere disse instruksjonene gjennom et brukergrensesnitt i stedet for å skrive dem manuelt, men den underliggende mekanismen er den samme. Du gir modellen en regelbok og stoler på at den følger med.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

Denne tilnærmingen har en fundamental feil. Språkmodeller utfører ikke regler. De forutsier tokens. Distinksjonen betyr noe fordi en tilstrekkelig godt laget prompt kan endre hva modellen forutsier, og derfor hva den gjør. Dette er prompt injection. Det er ikke en feil i noen bestemt modell. Det er en egenskap ved hvordan alle disse systemene fungerer. Hvis en angriper kan få teksten sin inn i modellens kontekst, konkurrerer instruksjonene deres med dine i det samme kontekstvinduet. Modellen har ingen mekanisme for å identifisere hvilke instruksjoner som kom fra den pålitelige systemprompten og hvilke som kom fra et ondsinnet dokument den ble bedt om å oppsummere. Den ser bare tokens.

OpenClaw-prosjektet, som har vokst til nesten 300 000 GitHub-stjerner og sannsynligvis er den mest utbredte open source-personlige agenten akkurat nå, har dette problemet fullt synlig. Ciscos sikkerhetsteam demonstrerte dataeksfiltrering gjennom en tredjeparts ferdihet. Prosjektets egen vedlikeholder sa offentlig at programvaren er «altfor farlig» for ikke-tekniske brukere. Dette er ikke en marginalkonsern. Det er den erkjente tilstanden til den mest populære agentplattformen som eksisterer.

Og OpenClaw er ikke spesiell i denne forbindelse. Den samme arkitekturen, med mindre variasjoner, dukker opp på tvers av de fleste agentplattformene på markedet. De varierer i hvor sofistikerte systemprompter de har. De varierer i hvor mange sperringsinstruksjoner de inkluderer. Det de har til felles er at alle disse instruksjonene lever inne i det de skal vokte.

## Hva «utenfor modellen» faktisk betyr

Det arkitektoniske alternativet er å flytte håndhevelsen fullstendig ut av modellens kontekst. I stedet for å fortelle modellen hva den ikke har lov til å gjøre og håpe at den hører etter, setter du en port mellom modellen og enhver handling den kan ta. Modellen produserer en forespørsel. Porten evaluerer den forespørselen mot et sett med regler og bestemmer om den kjøres. Modellens mening om hvorvidt handlingen skal tillates er ikke en del av den evalueringen.

Dette høres åpenbart ut når du sier det høyt. Det er slik alle andre sikkerhetssensitive programvaresystemer fungerer. Du sikrer ikke en bank ved å fortelle kassereren «vennligst ikke gi penger til folk som ikke har kontoer.» Du setter tekniske kontroller på plass som gjør uautoriserte uttak umulige uavhengig av hva kassereren blir fortalt. Kassererens atferd kan påvirkes av et sosialt angrep. Kontrollene er det ikke, fordi de ikke har en samtale.

I Triggerfish fungerer håndhevelselslaget gjennom et sett med hooks som kjøres før og etter enhver meningsfull operasjon. Før et verktøykall kjøres, sjekker hooken om det kallet er tillatt gitt gjeldende sesjonstilstand. Før utdata når en kanal, sjekker hooken om dataene som flyter ut er klassifisert på et nivå som er passende for den kanalen. Før eksterne data kommer inn i konteksten, klassifiserer hooken dem og oppdaterer sesjonens Taint-nivå deretter. Disse sjekkene er i kode. De leser ikke samtalen. De kan ikke overbevises om noe.

## Sesjons-Taint og hvorfor det betyr noe

Dataklassifisering er et veletablert konsept innen sikkerhet. De fleste plattformer som hevder å håndtere det, tildeler en klassifisering til en ressurs og sjekker om den forespørrende enheten har tillatelse til å få tilgang til den. Det er nyttig så langt det rekker. Det det mangler er hva som skjer etter tilgang.

Når en AI-agent får tilgang til et konfidensielt dokument, er de konfidensielle dataene nå i konteksten. De kan påvirke agentens utdata og resonnement for resten av sesjonen. Selv om agenten går videre til en annen oppgave, er den konfidensielle konteksten fortsatt der. Hvis agenten deretter tar en handling på en lavere klassifisert kanal — skriver til en offentlig Slack-kanal, sender en e-post til en ekstern adresse, poster til en webhook — kan den bære de konfidensielle dataene med seg. Dette er datalekkasje, og tilgangskontrollene på den opprinnelige ressursen gjorde ingenting for å forhindre det.

![](/blog/images/robot-entry.jpg)

Taint-sporing er mekanismen som lukker dette gapet. I Triggerfish har hver sesjon et Taint-nivå som starter på PUBLIC. I det øyeblikket agenten berører data på et høyere klassifiseringsnivå, taintes sesjonen til det nivået. Taint går bare opp. Den går aldri ned innenfor en sesjon. Så hvis du får tilgang til et CONFIDENTIAL-dokument og deretter prøver å sende en melding til en PUBLIC-kanal, utløses write-down-sjekken mot det taintede sesjonsnivået. Handlingen blokkeres ikke fordi modellen sa noe, men fordi systemet vet hvilke data som er involvert.

Modellen har ingen kunnskap om denne mekanismen. Den kan ikke referere til den, resonnere om den eller forsøke å manipulere den. Taint-nivået er et faktum om sesjonen som lever i håndhevelseselslaget, ikke i konteksten.

## Tredjepartsverktøy er en angrepsflate

En av funksjonene som gjør moderne AI-agenter genuint nyttige er utvidelsesmulighetene deres. Du kan legge til verktøy. Du kan installere plugins. Du kan koble agenten til eksterne tjenester gjennom Model Context Protocol. Hver integrasjon du legger til utvider hva agenten kan gjøre. Hver integrasjon du legger til utvider også angrepsflaten.

Trusselmodellen her er ikke hypotetisk. Hvis en agent kan installere tredjeparts ferdigheter, og disse ferdighetene distribueres av ukjente parter, og agentens sikkerhetsmodell er avhengig helt av at modellen respekterer instruksjoner i konteksten, kan en ondsinnet ferdighet eksfiltrere data bare ved å bli installert. Ferdigheten er innenfor tillitsgrensen. Modellen har ingen måte å skille mellom en legitim ferdighet og en ondsinnet en hvis begge er til stede i konteksten.

I Triggerfish håndterer MCP Gateway alle eksterne verktøytilkoblinger. Hver MCP-server må klassifiseres før den kan påkalles. UNTRUSTED-servere er blokkert som standard. Når et verktøy fra en ekstern server returnerer data, går svaret gjennom POST_TOOL_RESPONSE-hooken, som klassifiserer svaret og oppdaterer sesjons-Taint deretter. Aktiver et TypeScript-tillegg i brukerkonfigurasjonen med `enabled: true`. Import og kjøring skjer som standard i Deno-arbeidere med begrensede tillatelser. De kan lese tilleggets katalog og bare koble til verter og porter i `declaredEndpoints`. Filskriving, prosessmiljø, underprosesser, FFI og beskyttet systeminformasjon er sperret. `trust: trusted` tillater import i Triggerfish-prosessen. Utføreren kjører der hvis manifestet også angir `trusted`. [Fullstendig veiledning for programtillegg](/nb-NO/integrations/plugins).

Poenget med alt dette er at systemets sikkerhetsegenskaper ikke er avhengige av at pluginsene er pålitelige. De er avhengige av sandkassen og håndhevelseselslaget, som ikke påvirkes av hva pluginsene inneholder.

## Revisjonsproblemet

Hvis noe går galt med en AI-agentdistribusjon i dag, hvordan ville du vite det? De fleste plattformer logger samtalen. Noen logger verktøykall. Svært få logger sikkerhetsbeslutningene som tas under en sesjon på en måte som lar deg rekonstruere nøyaktig hvilke data som fløt hvor, på hvilket klassifiseringsnivå, og om noen policy ble brutt.

Dette betyr mer enn det kanskje virker, fordi spørsmålet om en AI-agent er sikker ikke bare handler om å forhindre angrep i sanntid. Det handler om å kunne demonstrere, i ettertid, at agenten opptrådde innenfor definerte grenser. For enhver organisasjon som håndterer sensitive data, er den revisjonsloggen ikke valgfri. Det er slik du beviser overholdelse, reagerer på hendelser og bygger tillit hos menneskene hvis data du håndterer.

![](/blog/images/glass.jpg)

Triggerfish opprettholder full datanedarvning på enhver operasjon. Hvert stykke data som kommer inn i systemet bærer provenans-metadata: hvor det kom fra, hvilken klassifisering det ble tildelt, hvilke transformasjoner det passerte gjennom, hvilken sesjon det var bundet til. Du kan spore enhver utdata tilbake gjennom kjeden av operasjoner som produserte den. Du kan spørre hvilke kilder som bidro til et gitt svar. Du kan eksportere hele forvaringskjeden for en regulatorisk gjennomgang. Dette er ikke et loggingssystem i tradisjonell forstand. Det er et provenans-system som vedlikeholdes som et primært anliggende gjennom hele dataflyten.

## Det faktiske spørsmålet

AI-agent-kategorien vokser raskt. Plattformene blir mer kapable. Brukstilfellene blir mer konsekvensfulle. Folk distribuerer agenter med skrivetilgang til produksjonsdatabaser, kunderegistre, finansielle systemer og interne kommunikasjonsplattformer. Forutsetningen som ligger til grunn for de fleste av disse distribusjonene er at en godt skrevet systemprompt er tilstrekkelig sikkerhet.

Det er den ikke. En systemprompt er tekst. Tekst kan overstyres av annen tekst. Hvis agentens sikkerhetsmodell er at modellen vil følge instruksjonene dine, er du avhengig av atferdssamsvars fra et system hvis atferd er probabilistisk og kan påvirkes av inndata du ikke kontrollerer.

Spørsmålet som er verdt å stille til alle agentplattformer du vurderer er hvor håndhevelsen faktisk lever. Hvis svaret er i modellens instruksjoner, er det en meningsfull risiko som skalerer med sensitiviteten til dataene agenten kan berøre og sofistikeringen til menneskene som kanskje prøver å manipulere den. Hvis svaret er i et lag som kjøres uavhengig av modellen og ikke kan nås av noen prompt, er det en annen situasjon.

Dataene i systemene dine er ekte. Spørsmålet om hvem som stopper agenten fra å eksfiltrere dem fortjener et ekte svar.
