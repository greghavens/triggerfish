---
title: AI-agenter exfiltrerar dina privata data. Vem stoppar dem?
date: 2026-03-10
description: De flesta AI-agentplattformar tillämpar säkerhet genom att berätta för
  modellen vad den inte får göra. Modellen kan övertalas att ändra sig. Här ser det
  alternativa tillvägagångssättet ut.
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

AI-agenter är användbara för att de kan vidta åtgärder. Det är hela poängen. Du ger en agent tillgång till dina verktyg och den kan göra saker: skicka ett meddelande, uppdatera en post, söka i en fil, köra en fråga, pusha ett commit. Demonstrationerna imponerar. De faktiska driftsättningarna ser annorlunda ut om man tittar noga på säkerhetsmodellen under dem.

Frågan som ingen ställer tillräckligt högt just nu är enkel. När en AI-agent har skrivbehörighet till din databas, din e-post, din kalender, din Salesforce-instans, dina GitHub-repositorier — vad hindrar den från att göra något den inte borde? Det ärliga svaret är i de flesta fall en mening i systempromoten.

Det är läget vi befinner oss i.

## Problemet med att be modellen uppföra sig

När du driftsätter en AI-agent idag är standardsäkerhetspraxisen att skriva instruktioner i systempromoten. Berätta för modellen vad den inte får göra. Berätta vilka verktyg som är förbjudna. Säg att den ska fråga innan den vidtar destruktiva åtgärder. En del plattformar låter dig konfigurera dessa instruktioner via ett gränssnitt istället för att skriva dem manuellt, men den underliggande mekanismen är densamma. Du ger modellen en regelbok och litar på att den följer den.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

Det här tillvägagångssättet har en grundläggande brist. Språkmodeller kör inte regler. De förutsäger tokens. Skillnaden spelar roll eftersom en tillräckligt välformulerad prompt kan påverka vad modellen förutsäger — och därmed vad den gör. Det kallas prompt injection. Det är inte ett fel i någon specifik modell. Det är en egenskap hos hur alla dessa system fungerar. Om en angripare kan få sin text in i modellens kontext konkurrerar deras instruktioner med dina. Modellen har ingen mekanism för att avgöra vilka instruktioner som kom från den betrodda systempromoten och vilka som kom från ett illasinnat dokument den ombads sammanfatta. Den ser bara tokens.

OpenClaw-projektet, som har vuxit till nästan 300 000 GitHub-stjärnor och förmodligen är den mest utbredda öppen källkod-agenten just nu, har detta problem tydligt exponerat. Ciscos säkerhetsteam demonstrerade dataexfiltrering via en tredjeparts-skill. Projektets egna underhållare sa offentligt att programvaran är "alldeles för farlig" för icke-tekniska användare. Det är inte en marginalfråga. Det är det erkända tillståndet för den mest populära agentplattformen som finns.

Och OpenClaw är inte unikt i det avseendet. Samma arkitektur, med mindre variationer, återfinns i de flesta agentplattformar på marknaden. De skiljer sig i hur sofistikerade deras systempromptar är. De skiljer sig i hur många skyddsregler de inkluderar. Vad de har gemensamt är att alla dessa instruktioner lever inuti det de ska skydda.

## Vad "utanför modellen" faktiskt betyder

Det arkitektoniska alternativet är att flytta ut tillämpningen ur modellens kontext helt och hållet. Istället för att berätta för modellen vad den inte får göra och hoppas att den lyder, lägger du en grind mellan modellen och varje åtgärd den kan vidta. Modellen producerar en begäran. Grinden utvärderar den begäran mot en uppsättning regler och bestämmer om den ska köras. Modellens uppfattning om huruvida åtgärden borde tillåtas är inte en del av den utvärderingen.

Det låter självklart när man säger det högt. Det är så alla andra säkerhetskänsliga programvarusystem fungerar. Du säkrar inte en bank genom att berätta för kassören "snälla ge inte pengar till folk som inte har konton." Du inför tekniska kontroller som gör otillåtna uttag omöjliga oavsett vad kassören blir tillsagd. Kassörens beteende kan påverkas av social manipulation. Kontrollerna påverkas inte, för de för inget samtal.

I Triggerfish fungerar tillämpningslagret via en uppsättning hooks som körs före och efter varje meningsfull operation. Innan ett verktygsanrop körs kontrollerar hooken om det anropet är tillåtet givet det aktuella sessionstillståndet. Innan utdata når en kanal kontrollerar hooken om datan som flödar ut är klassificerad på en nivå som är lämplig för den kanalen. Innan externa data går in i kontexten klassificerar hooken dem och uppdaterar sessionens taint-nivå. Dessa kontroller sker i kod. De läser inte konversationen. De kan inte övertygas om något.

## Session-taint och varför det spelar roll

Dataklassificering är ett välförstått koncept inom säkerhet. De flesta plattformar som påstår sig hantera det tilldelar en klassificering till en resurs och kontrollerar om den begärande parten har behörighet att komma åt den. Det är användbart så långt det räcker. Vad det missar är vad som händer efter åtkomst.

När en AI-agent öppnar ett konfidentiellt dokument finns den konfidentiella datan nu i sin kontext. Den kan påverka agentens utdata och resonemang under resten av sessionen. Även om agenten går vidare till en annan uppgift finns den konfidentiella kontexten kvar. Om agenten sedan vidtar en åtgärd på en kanal med lägre klassificering — skriver till en publik Slack-kanal, skickar ett e-postmeddelande till en extern adress, postar till en webhook — kan den ta med sig den konfidentiella datan. Det är dataintrång, och åtkomstkontroller på den ursprungliga resursen gjorde ingenting för att förhindra det.

![](/blog/images/robot-entry.jpg)

Taint-spårning är mekanismen som täpper till detta gap. I Triggerfish har varje session en taint-nivå som börjar på PUBLIC. I det ögonblick agenten berör data på en högre klassificeringsnivå taintas sessionen till den nivån. Taint går bara uppåt. Det går aldrig nedåt inom en session. Så om du öppnar ett CONFIDENTIAL-dokument och sedan försöker skicka ett meddelande till en PUBLIC-kanal utlöses nedskrivningskontrollen mot den taintade sessionsnivån. Åtgärden blockeras inte på grund av något modellen sade, utan för att systemet vet vilken data som är i spel.

Modellen känner inte till den här mekanismen. Den kan inte referera till den, resonera om den eller försöka manipulera den. Taint-nivån är ett faktum om sessionen som lever i tillämpningslagret, inte i kontexten.

## Tredjeparts-verktyg är en attackyta

En av funktionerna som gör moderna AI-agenter genuint användbara är deras utbyggbarhet. Du kan lägga till verktyg. Du kan installera plugins. Du kan ansluta agenten till externa tjänster via Model Context Protocol. Varje integration du lägger till utvidgar vad agenten kan göra. Varje integration du lägger till utvidgar också attackytan.

Hotmodellen här är inte hypotetisk. Om en agent kan installera tredjeparts-skills, och dessa skills distribueras av okända parter, och agentens säkerhetsmodell enbart förlitar sig på att modellen respekterar instruktioner i sin kontext, kan en illasinnad skill exfiltrera data bara genom att bli installerad. Skillet är innanför förtroendegränsen. Modellen har inget sätt att skilja en legitim skill från en illasinnad om båda finns i kontexten.

I Triggerfish hanterar MCP Gateway alla externa verktygsanslutningar. Varje MCP-server måste klassificeras innan den kan anropas. UNTRUSTED-servrar blockeras som standard. När ett verktyg från en extern server returnerar data passerar det svaret genom POST_TOOL_RESPONSE-hooken, som klassificerar svaret och uppdaterar sessionens taint. Aktivera ett TypeScript-insticksprogram i användarkonfigurationen med `enabled: true`. Import och körning sker normalt i Deno-workers med begränsade behörigheter. De kan läsa insticksprogrammets katalog och bara ansluta till värdar och portar i `declaredEndpoints`. Filskrivning, processmiljön, underprocesser, FFI och skyddad systeminformation är spärrade. `trust: trusted` tillåter import i Triggerfish-processen. Exekveraren körs där om manifestet också anger `trusted`. [Fullständig guide till insticksprogram](/sv-SE/integrations/plugins).

Poängen med allt detta är att systemets säkerhetsegenskaper inte beror på att plugins är pålitliga. De beror på sandlådan och tillämpningslagret, som inte påverkas av vad plugins innehåller.

## Granskningsproblemet

Om något går fel med en AI-agentdriftsättning idag — hur skulle du veta? De flesta plattformar loggar konversationen. En del loggar verktygsanrop. Väldigt få loggar de säkerhetsbeslut som fattas under en session på ett sätt som gör att du kan rekonstruera exakt vilken data som flödade vart, på vilken klassificeringsnivå, och om någon policy överträddes.

Det spelar större roll än vad det kan verka, för frågan om huruvida en AI-agent är säker handlar inte bara om att förhindra attacker i realtid. Det handlar om att kunna demonstrera, i efterhand, att agenten agerade inom definierade gränser. För varje organisation som hanterar känsliga data är den granskningsloggen inte valfri. Det är hur du bevisar efterlevnad, hanterar incidenter och bygger förtroende hos de personer vars data du hanterar.

![](/blog/images/glass.jpg)

Triggerfish upprätthåller fullständig datahärstamning för varje operation. Varje databit som går in i systemet bär proveniensmetadata: varifrån den kom, vilken klassificering den tilldelades, vilka transformationer den passerade igenom, vilken session den var bunden till. Du kan spåra vilken utdata som helst tillbaka genom kedjan av operationer som producerade den. Du kan fråga vilka källor som bidrog till ett givet svar. Du kan exportera den fullständiga förvaringsledjan för en regulatorisk granskning. Det här är inte ett loggningssystem i traditionell mening. Det är ett provenisenssystem som upprätthålls som ett förstaklasses-intresse genom hela dataflödet.

## Den egentliga frågan

AI-agentkategorin växer snabbt. Plattformarna blir mer kapabla. Användningsfallen blir mer konsekvensrika. Folk driftsätter agenter med skrivbehörighet till produktionsdatabaser, kundposter, finanssystem och interna kommunikationsplattformar. Antagandet som ligger till grund för de flesta av dessa driftsättningar är att en välskriven systempromot är tillräcklig säkerhet.

Det är det inte. En systempromot är text. Text kan åsidosättas av annan text. Om din agents säkerhetsmodell bygger på att modellen följer dina instruktioner förlitar du dig på beteendesmässig efterlevnad från ett system vars beteende är probabilistiskt och kan påverkas av indata du inte kontrollerar.

Frågan som är värd att ställa om varje agentplattform du överväger är var tillämpningen faktiskt sker. Om svaret är i modellens instruktioner är det en väsentlig risk som skalar med känsligheten hos datan din agent kan beröra och sofistikeringen hos de som kanske försöker manipulera den. Om svaret är i ett lager som körs oberoende av modellen och inte kan nås av någon prompt är det en annan situation.

Datan i dina system är verklig. Frågan om vem som hindrar agenten från att exfiltrera den förtjänar ett verkligt svar.
