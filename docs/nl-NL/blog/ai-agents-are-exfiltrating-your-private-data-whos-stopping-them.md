---
title: AI-agenten Exfiltreren Uw Privégegevens. Wie Stopt Hen?
date: 2026-03-10
description: De meeste AI-agentplatforms handhaven beveiliging door het model te
  vertellen wat het niet mag doen. Het model kan worden overgehaald. Dit is hoe
  het alternatief eruitziet.
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

AI-agenten zijn nuttig omdat ze actie kunnen ondernemen. Dat is het hele punt. U geeft een agent toegang tot uw tools, en het kan dingen doen: een bericht sturen, een record bijwerken, een bestand zoeken, een query uitvoeren, een commit pushen. De demo's zijn indrukwekkend. De daadwerkelijke implementaties, als u goed kijkt naar het beveiligingsmodel eronder, zijn een ander verhaal.

De vraag die niemand op dit moment hard genoeg stelt, is eenvoudig. Wanneer een AI-agent schrijftoegang heeft tot uw database, uw e-mail, uw agenda, uw Salesforce-instantie, uw GitHub-repositories — wat weerhoudt het ervan iets te doen wat het niet mag? Het eerlijke antwoord is in de meeste gevallen een zin in de systeemprompt.

Dat is de situatie waarin we ons bevinden.

## Het probleem met het model vertellen zich te gedragen

Wanneer u vandaag een AI-agent implementeert, is de standaard beveiligingspraktijk het schrijven van instructies in de systeemprompt. Vertel het model wat het niet mag doen. Vertel het welke tools verboden zijn. Vertel het te vragen voordat het destructieve acties uitvoert. Sommige platforms laten u deze instructies configureren via een UI in plaats van ze handmatig te schrijven, maar het onderliggende mechanisme is hetzelfde. U geeft het model een regelboek en vertrouwt erop dat het dat volgt.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

Deze aanpak heeft een fundamentele fout. Taalmodellen voeren geen regels uit. Ze voorspellen tokens. Het onderscheid is van belang omdat een voldoende goed ontworpen prompt kan verschuiven wat het model voorspelt, en daarmee wat het doet. Dit is prompt-injectie. Het is geen bug in een bepaald model. Het is een eigenschap van hoe al deze systemen werken. Als een aanvaller zijn tekst in de context van het model kan krijgen, concurreren hun instructies met die van u. Het model heeft geen mechanisme om onderscheid te maken tussen welke instructies afkomstig zijn van de vertrouwde systeemprompt en welke van een kwaadaardig document dat het werd gevraagd samen te vatten.

Het OpenClaw-project, dat is gegroeid tot bijna 300.000 GitHub-sterren en waarschijnlijk de meest wijd ingezette open-source persoonlijke agent is op dit moment, heeft dit probleem in volle zicht. Het beveiligingsteam van Cisco toonde gegevensexfiltratie via een externe skill. De eigen onderhouder van het project zei publiekelijk dat de software "veel te gevaarlijk" is voor niet-technische gebruikers. Dit is geen randgeval. Het is de erkende staat van het meest populaire agentplatform dat bestaat.

## Wat "buiten het model" werkelijk betekent

Het architecturale alternatief is handhaving volledig uit de context van het model te verplaatsen. In plaats van het model te vertellen wat het niet mag doen en te hopen dat het luistert, plaatst u een poort tussen het model en elke actie die het kan ondernemen. Het model produceert een verzoek. De poort evalueert dat verzoek aan de hand van een set regels en beslist of het wordt uitgevoerd. De mening van het model over of de actie moet worden toegestaan, maakt geen deel uit van die evaluatie.

Dit klinkt voor de hand liggend wanneer u het hardop zegt. Het is hoe elk ander beveiligingsgevoelig softwaresysteem werkt. U beveiligt een bank niet door de kassier te vertellen "geef alstublieft geen geld aan mensen zonder rekeningen." U plaatst technische controles die ongeautoriseerde opnames onmogelijk maken, ongeacht wat de kassier wordt verteld.

In Triggerfish werkt de handhavingslaag via een set hooks die worden uitgevoerd voor en na elke betekenisvolle bewerking. Voordat een toolaanroep wordt uitgevoerd, controleert de hook of die aanroep is toegestaan gezien de huidige sessiestatus. Voordat uitvoer een kanaal bereikt, controleert de hook of de uitstromende gegevens geclassificeerd zijn op een niveau dat geschikt is voor dat kanaal. Deze controles zijn in code. Ze lezen het gesprek niet. Ze kunnen nergens van overtuigd worden.

## Sessie-taint en waarom het van belang is

Gegevensclassificatie is een goed begrepen concept in beveiliging. Wanneer een AI-agent een vertrouwelijk document raadpleegt, zijn die vertrouwelijke gegevens nu in zijn context. Ze kunnen de uitvoer en redenering van de agent voor de rest van de sessie beïnvloeden. Als de agent dan actie onderneemt op een lager geclassificeerd kanaal — schrijven naar een openbaar Slack-kanaal, een e-mail sturen naar een extern adres, posten naar een webhook — kan het die vertrouwelijke gegevens meenemen. Dit is gegevenslekken, en toegangscontroles op de oorspronkelijke resource deden niets om het te voorkomen.

![](/blog/images/robot-entry.jpg)

Taint-tracking is het mechanisme dat deze kloof sluit. In Triggerfish heeft elke sessie een taint-niveau dat begint op PUBLIC. Op het moment dat de agent gegevens aanraakt op een hoger classificatieniveau, wordt de sessie op dat niveau besmet. Taint gaat alleen omhoog. Het gaat nooit omlaag binnen een sessie. Dus als u een CONFIDENTIAL-document raadpleegt en dan een bericht probeert te sturen naar een PUBLIC-kanaal, wordt de write-down-controle uitgevoerd op het besmette sessieniveau. De actie wordt geblokkeerd — niet vanwege iets wat het model zei, maar omdat het systeem weet welke gegevens in het spel zijn.

Het model heeft geen kennis van dit mechanisme. Het kan er niet naar verwijzen, er niet over redeneren of proberen het te manipuleren. Het taint-niveau is een feit over de sessie dat leeft in de handhavingslaag, niet in de context.

## Tools van derden zijn een aanvalsoppervlak

In Triggerfish verwerkt de MCP Gateway alle externe toolverbindingen. Elke MCP-server moet worden geclassificeerd voordat deze kan worden aangeroepen. UNTRUSTED-servers worden standaard geblokkeerd. Wanneer een tool van een externe server gegevens retourneert, gaat dat antwoord via de POST_TOOL_RESPONSE-hook, die het antwoord classificeert en de sessie-taint dienovereenkomstig bijwerkt. Schakel een TypeScript-plug-in in via `enabled: true` in de gebruikersconfiguratie. Import en uitvoering vinden standaard plaats in Deno-workers met beperkte rechten. Ze kunnen de plug-inmap lezen en alleen verbinding maken met hosts en poorten in `declaredEndpoints`. Schrijftoegang, de procesomgeving, subprocessen, FFI en afgeschermde systeeminformatie zijn geblokkeerd. `trust: trusted` staat import in het Triggerfish-proces toe. De executor draait daar als het manifest ook `trusted` opgeeft. [Volledige plug-ingids](/nl-NL/integrations/plugins).

Het punt van dit alles is dat de beveiligingseigenschappen van het systeem niet afhangen van het feit dat de plugins betrouwbaar zijn. Ze zijn afhankelijk van de sandbox en de handhavingslaag, die niet worden beïnvloed door wat de plugins bevatten.

## Het auditprobleem

Als er iets misgaat met een AI-agentimplementatie vandaag, hoe zou u het weten? De meeste platforms loggen het gesprek. Sommige loggen toolaanroepen. Zeer weinig loggen de beveiligingsbeslissingen die tijdens een sessie zijn gemaakt op een manier die u in staat stelt precies te reconstrueren welke gegevens waarheen stroomden, op welk classificatieniveau, en of enig beleid werd geschonden.

![](/blog/images/glass.jpg)

Triggerfish onderhoudt volledige gegevenslineage bij elke bewerking. Elk stuk gegevens dat het systeem binnenkomt draagt provenancemetadata: waar het vandaan kwam, welke classificatie eraan was toegewezen, welke transformaties het heeft doorlopen, aan welke sessie het was gebonden. U kunt elke uitvoer terugtraceren door de keten van bewerkingen die het produceerde. U kunt vragen welke bronnen bijdroegen aan een gegeven antwoord. U kunt de volledige bewakingsketen exporteren voor een regelgevingscontrole.

## De werkelijke vraag

De AI-agentcategorie groeit snel. De platforms worden capabeler. De gebruiksscenario's worden consequenter. Mensen implementeren agenten met schrijftoegang tot productiedatabases, klantgegevens, financiële systemen en interne communicatieplatforms. De aanname die de meeste van deze implementaties ten grondslag ligt, is dat een goed geschreven systeemprompt voldoende beveiliging is.

Dat is het niet. Een systeemprompt is tekst. Tekst kan worden overschreven door andere tekst. Als het beveiligingsmodel van uw agent is dat het model uw instructies zal volgen, vertrouwt u op gedragsconfirmiteit van een systeem waarvan het gedrag probabilistisch is en kan worden beïnvloed door invoeren die u niet controleert.

De vraag die elk agentplatform dat u overweegt waard is te stellen, is waar de handhaving werkelijk leeft. Als het antwoord in de instructies van het model is, is dat een betekenisvol risico dat schaalt met de gevoeligheid van de gegevens die uw agent kan aanraken en de verfijning van de mensen die het misschien proberen te manipuleren. Als het antwoord in een laag is die onafhankelijk van het model draait en door geen enkele prompt kan worden bereikt, is dat een andere situatie.

De gegevens in uw systemen zijn echt. De vraag wie de agent stopt van het exfiltreren ervan, verdient een echt antwoord.
