---
title: "Sicurezza AI Zero Trust: perché le difese perimetrali tradizionali
  falliscono con l'AI e cosa costruire invece"
date: 2026-04-04
description: La sicurezza AI Zero Trust applica verifica continua e accesso con
  privilegi minimi ai sistemi di intelligenza artificiale, trattando ogni
  modello, utente e flusso di dati come non affidabile per impostazione
  predefinita.
author: triggerfish
tags:
  - AI agent
draft: false
---
La sicurezza AI Zero Trust è l'applicazione dei principi Zero Trust ai sistemi di intelligenza artificiale, che richiede che ogni utente, modello, sorgente di dati e punto di integrazione sia verificato continuamente e gli sia concesso solo l'accesso minimo necessario per svolgere la propria funzione, senza alcuna fiducia implicita estesa sulla base della posizione di rete o di un'autenticazione precedente. Tratta i sistemi AI come obiettivi di alto valore che richiedono gli stessi rigorosi controlli di accesso di qualsiasi altra infrastruttura privilegiata.

Il modello tradizionale del perimetro di sicurezza presupponeva che le minacce provenissero dall'esterno della rete e che ci si potesse fidare dei sistemi al suo interno. Quel presupposto era già sotto pressione prima dell'arrivo dell'AI. Le implementazioni di AI lo demoliscono completamente. Un sistema AI connesso a database interni, e-mail, repository documentali e API esterne opera attraverso un confine di fiducia che un modello perimetrale non può definire, figuriamoci difendere. Accetta input da ovunque, recupera contenuti da molteplici fonti e intraprende azioni su sistemi connessi in sequenze che nessun modello tradizionale di controllo degli accessi è stato progettato per governare. La superficie di attacco non è un perimetro definito. È l'insieme completo di connessioni che un sistema AI può attraversare, la gamma completa di contenuti che elaborerà e l'intera portata delle azioni che è autorizzato a intraprendere. La sicurezza AI Zero Trust affronta questa realtà sostituendo il presupposto del perimetro con una verifica continua per ogni interazione, ogni accesso ai dati e ogni azione che il sistema AI esegue. Questa guida spiega come i principi Zero Trust si applichino specificamente alle implementazioni AI, come appaiono i sette pilastri in un contesto AI e cosa devono costruire le organizzazioni per far funzionare il modello nella pratica.



![AI agent](/blog/images/architectural.jpg)

## **Perché la sicurezza perimetrale fallisce specificamente per i sistemi AI**

### **Il problema dell'AI connessa**

Un'applicazione aziendale convenzionale ha un insieme definito di utenti, un insieme definito di funzioni e un insieme relativamente prevedibile di modelli di accesso ai dati. I team di sicurezza possono costruire controlli di accesso intorno a queste definizioni, monitorare le deviazioni e trattare le anomalie come segnali di potenziale compromissione. La prevedibilità del comportamento è ciò che rende praticabile la sicurezza perimetrale anche quando è imperfetta.

I sistemi AI, in particolare i sistemi AI agentici e quelli connessi a pipeline di retrieval, non hanno un comportamento prevedibile nello stesso senso. Le loro risposte variano in base agli input. I dati a cui accedono dipendono da ciò che le query generano in fase di esecuzione piuttosto che da un elenco di accessi predefinito. Le azioni che intraprendono tramite strumenti connessi dipendono dai compiti che vengono loro assegnati piuttosto che da un insieme fisso di funzioni. La sicurezza perimetrale costruita intorno a una definizione statica di ciò che il sistema fa non può tenere il passo con la realtà dinamica di ciò a cui effettivamente accede ed esegue.

Gli attacchi di prompt injection sfruttano direttamente questa lacuna. Un attaccante in grado di introdurre istruzioni dannose in qualsiasi contenuto che un sistema AI recupera o riceve può potenzialmente reindirizzare interamente il comportamento del sistema, facendogli accedere a dati, eseguire azioni o far emergere informazioni in modi che bypassano ogni controllo perimetrale che governa il comportamento normale del sistema. L'attacco non attraversa un confine di rete. Attraversa un confine di fiducia all'interno dell'elaborazione stessa del sistema, in un canale che le difese perimetrali non sono posizionate per monitorare.

La sicurezza AI Zero Trust affronta questo problema spostando la verifica dal perimetro di rete a ogni singola interazione. Invece di chiedere se un utente o un sistema si trova all'interno della rete fidata, chiede se questa specifica richiesta, da questa specifica identità, per questa specifica risorsa, in questo specifico momento, è autorizzata. Questa domanda viene posta continuamente, non una sola volta durante l'autenticazione.

### **Come l'AI amplifica le conseguenze delle violazioni di fiducia**

La ragione per cui la sicurezza AI Zero Trust conta più dello Zero Trust per le applicazioni convenzionali non è che i sistemi AI siano intrinsecamente meno sicuri. È che le conseguenze di una violazione della fiducia in un sistema AI connesso sono amplificate dalla connettività e dall'autonomia del sistema in modi in cui violazioni equivalenti in sistemi convenzionali non lo sono.

Un account utente compromesso in un'applicazione convenzionale crea accesso a tutto ciò a cui quell'utente può accedere. Un agente AI compromesso o manipolato con ampio accesso agli strumenti può potenzialmente attraversare più sistemi connessi, esfiltrare dati da diverse fonti e intraprendere azioni su molteplici piattaforme in un'unica sequenza automatizzata che richiederebbe un ampio sforzo da parte dell'attaccante per essere replicata manualmente. L'automazione che rende preziosi gli agenti AI per i compiti legittimi li rende anche efficienti per quelli illegittimi quando il loro comportamento viene manipolato o il loro accesso viene sfruttato.

La sicurezza AI Zero Trust riduce il raggio di impatto delle violazioni di fiducia garantendo che anche un sistema AI manipolato con successo possa accedere e influenzare solo le risorse specifiche per le quali gli è stato concesso il permesso nel contesto attuale, invece di ereditare un accesso ampio che è stato concesso al momento dell'autenticazione e mai più rivisto.

Esaminare come le decisioni architetturali di[ sicurezza AI](https://trigger.fish/security/) riguardanti la limitazione dell'accesso e la verifica continua influenzano il raggio di impatto pratico di una compromissione del sistema AI aiuta le organizzazioni a costruire implementazioni in cui le conseguenze dei fallimenti di sicurezza sono limitate piuttosto che illimitate.



![AI agent](/blog/images/enterprise-security.jpg)

## **I sette pilastri dello Zero Trust applicati ai sistemi AI**

La sicurezza Zero Trust è organizzata attorno a sette pilastri che insieme definiscono l'architettura completa di verifica e controllo. Ogni pilastro assume caratteristiche e requisiti specifici quando viene applicato ai sistemi AI piuttosto che alle applicazioni convenzionali.

### **Pilastro uno: verifica dell'identità**

Nello Zero Trust convenzionale, la verifica dell'identità copre utenti umani e account di servizio. Nella sicurezza AI Zero Trust, la superficie dell'identità si espande fino a includere il modello AI stesso come identità che deve essere verificata, gli agenti che agiscono per conto degli utenti che devono essere distinti da tali utenti ai fini del controllo degli accessi, e gli account di servizio che i sistemi AI utilizzano per accedere alle risorse connesse che devono essere gestiti con lo stesso rigore degli account umani privilegiati.

L'autenticazione continua piuttosto che l'autenticazione basata sulla sessione è lo standard Zero Trust per gli utenti umani che accedono ai sistemi AI. L'autenticazione a più fattori, l'analisi comportamentale che monitora schemi di utilizzo anomali e le politiche di accesso consapevoli del contesto che adattano i requisiti di verifica in base alla sensibilità di ciò che viene richiesto si applicano tutte nelle implementazioni dei sistemi AI.

Per gli agenti AI che operano autonomamente, la sfida dell'identità è mantenere il principio che l'accesso dell'agente è limitato al compito specifico che sta svolgendo piuttosto che ereditare l'accesso completo dell'utente umano che lo ha avviato. Un agente che esegue un compito di ricerca per conto di un utente dovrebbe avere accesso di ricerca, non l'intera impronta di accesso dell'utente. Questa limitazione richiede un'architettura di identità esplicita piuttosto che l'ereditarietà predefinita che molti framework di agenti implementano.

### **Pilastro due: sicurezza dei dispositivi**

La sicurezza dei dispositivi in un contesto AI Zero Trust copre sia gli endpoint da cui gli utenti accedono ai sistemi AI sia l'infrastruttura su cui girano i modelli AI. Per i dispositivi utente si applicano i controlli Zero Trust standard: verifica dello stato del dispositivo prima della concessione dell'accesso, copertura di rilevamento e risposta sugli endpoint e politiche di accesso che variano in base allo stato di gestione del dispositivo.

Il livello dell'infrastruttura richiede un'attenzione specifica perché l'hardware di inferenza AI rappresenta un obiettivo di alto valore per cui la sicurezza tradizionale degli endpoint non è stata progettata. I server GPU che eseguono modelli di grandi dimensioni contengono sia i pesi del modello, che rappresentano una significativa proprietà intellettuale, sia i dati elaborati attraverso l'inferenza, che possono includere informazioni organizzative sensibili. La sicurezza fisica e logica dell'infrastruttura di inferenza AI merita la stessa gestione degli accessi privilegiati, il monitoraggio dell'integrità e la registrazione degli accessi di altre risorse infrastrutturali di alto valore.

### **Pilastro tre: segmentazione della rete**

L'architettura di rete Zero Trust sostituisce la rete piatta e fidata con zone microsegmentate in cui il traffico tra i segmenti richiede un'autorizzazione esplicita invece di fluire liberamente all'interno del perimetro. Per i sistemi AI, la segmentazione della rete determina quali componenti dell'architettura AI possono comunicare con quali altri e quali risorse esterne il sistema AI può raggiungere.

I server di inferenza AI dovrebbero essere segmentati dalla rete dalle risorse a cui non hanno bisogno di accedere. Un modello che serve query del servizio clienti non ha bisogno di accesso di rete ai sistemi finanziari. Uno strumento di ricerca AI non ha bisogno di accesso ai database delle risorse umane. L'architettura di rete dovrebbe imporre queste separazioni invece di fare affidamento sul comportamento del sistema AI per rispettarle volontariamente, perché la prompt injection e altre tecniche di manipolazione possono potenzialmente sovrascrivere le restrizioni comportamentali mentre la segmentazione di rete le impone fisicamente.

L'accesso alla rete esterna per i sistemi AI, inclusi l'accesso alla ricerca web, alle API esterne e ai servizi cloud, dovrebbe essere esplicitamente consentito tramite allowlist piuttosto che consentito per impostazione predefinita con eccezioni bloccate. L'impostazione predefinita per la connettività esterna del sistema AI in un'architettura Zero Trust è nessun accesso, con specifiche destinazioni consentite aggiunte sulla base di requisiti operativi documentati.

### **Pilastro quattro: sicurezza delle applicazioni**

La sicurezza delle applicazioni nel contesto AI Zero Trust copre la sicurezza del livello applicativo AI stesso, inclusa l'infrastruttura di prompting, le pipeline di retrieval, le integrazioni degli strumenti e la logica di gestione dell'output che insieme definiscono come il sistema AI elabora le richieste e produce risposte.

La validazione e la sanificazione dell'input al livello applicativo rappresentano il principio Zero Trust di verifica del contenuto, non solo dell'identità, applicato ai sistemi AI. Ogni input che raggiunge il modello, che provenga da utenti, documenti recuperati, output di strumenti o messaggi di sistema, dovrebbe essere trattato come potenzialmente avversario ed elaborato attraverso un filtraggio appropriato piuttosto che ricevere fiducia implicita.

La validazione dell'output applica lo stesso principio al contrario. Ogni output che il sistema AI produce, prima di raggiungere gli utenti, i sistemi connessi o i processi a valle, dovrebbe essere ispezionato rispetto a criteri definiti che rilevano contenuti dannosi, fughe di dati sensibili e anomalie comportamentali che suggeriscono che il modello sia stato manipolato.

Comprendere come le decisioni di[ architettura AI](https://trigger.fish/architecture/) a livello applicativo influenzino l'implementazione pratica dei controlli Zero Trust di input e output aiuta le organizzazioni a costruire sistemi AI in cui la sicurezza è incorporata nella pipeline di elaborazione piuttosto che applicata al perimetro.



![AI agent](/blog/images/layered-security.jpg)

### **Pilastro cinque: sicurezza dei dati**

La sicurezza dei dati nell'ambito dell'AI Zero Trust richiede di trattare ogni accesso ai dati da parte di un sistema AI come bisognoso di autorizzazione esplicita invece che ereditare ampi permessi. Questo pilastro è dove le implementazioni AI richiedono più direttamente controlli Zero Trust appositamente progettati perché le architetture di sicurezza dei dati esistenti non sono state progettate per i modelli di accesso ai dati dinamici e basati su query che i sistemi di retrieval AI creano.

La classificazione dei dati che i sistemi AI rispettano nel loro comportamento di retrieval ed elaborazione richiede l'integrazione tra l'infrastruttura di governance dei dati e il livello di controllo degli accessi AI. Quando il livello di autorizzazione di un utente determina a quali documenti può accedere direttamente in un sistema di gestione documentale, il sistema AI che recupera documenti per conto di tale utente dovrebbe rispettare lo stesso confine di autorizzazione, restituendo solo i documenti che l'utente è autorizzato a vedere piuttosto che tutto ciò che nella base di conoscenza è pertinente alla sua query.

La minimizzazione dei dati, un principio fondamentale dello Zero Trust per i dati, richiede che i sistemi AI accedano ed elaborino solo i dati specifici necessari per il compito corrente. Un assistente AI a cui viene chiesto di redigere una risposta e-mail non ha bisogno di accedere alla cronologia completa del cliente. Uno strumento AI che riassume un documento specifico non ha bisogno di accedere alla cartella circostante. L'implementazione della minimizzazione dei dati nei sistemi AI richiede controlli di accesso che operino a livello di dato granulare piuttosto che a livello di sistema o database.

Esaminare come le[ funzionalità AI](https://trigger.fish/features/) nelle piattaforme AI aziendali implementano i controlli di accesso ai dati e l'autorizzazione di retrieval aiuta le organizzazioni a valutare se l'architettura di sicurezza dei dati di un fornitore supporti i principi Zero Trust o richieda controlli supplementari per ottenere lo stesso effetto.

### **Pilastro sei: visibilità e analisi**

La sicurezza Zero Trust si basa sulla capacità di rilevare anomalie che indicano violazioni della fiducia, il che richiede una visibilità completa su tutto ciò che il sistema AI fa. Senza una copertura di registrazione e monitoraggio per ogni interazione del sistema AI, la verifica Zero Trust non produce alcun segnale quando si verificano violazioni perché le prove necessarie per rilevarle non esistono.

Per i sistemi AI, i requisiti di visibilità vanno oltre la registrazione convenzionale delle applicazioni. Ogni query inviata al modello, ogni documento recuperato tramite pipeline RAG, ogni chiamata di strumento eseguita da un agente, ogni output prodotto dal sistema e ogni decisione di controllo degli accessi presa a ciascun checkpoint di verifica devono essere catturati in log che i team operativi di sicurezza possono monitorare e investigare.

L'analisi comportamentale applicata ai log di attività del sistema AI crea la capacità di rilevamento delle anomalie che rende la visibilità Zero Trust azionabile. I modelli di base del comportamento normale del sistema AI, inclusi i modelli tipici di query, i volumi di retrieval abituali e le frequenze standard di utilizzo degli strumenti, consentono il rilevamento di deviazioni che possono indicare prompt injection, tentativi di esfiltrazione dei dati o modelli di accesso non autorizzati che sarebbero invisibili senza punti di riferimento comportamentali.

### **Pilastro sette: automazione e orchestrazione**

Lo Zero Trust su scala aziendale non può essere operato manualmente. Le decisioni di verifica, le risposte alle anomalie e gli aggiornamenti delle politiche di accesso che la verifica continua richiede avvengono con una frequenza e attraverso una complessità di sistema che l'operatività umana non può eguagliare. L'automazione e l'orchestrazione, il pilastro finale dello Zero Trust, copre i sistemi che rendono lo Zero Trust operativo su scala piuttosto che teorico nei documenti di architettura.

Per i sistemi AI in particolare, la risposta automatizzata alle anomalie rilevate, inclusa la limitazione della frequenza attivata da schemi di query insoliti, la restrizione dell'accesso attivata da anomalie comportamentali e l'escalation degli avvisi attivata da potenziali firme di prompt injection, fornisce la velocità di risposta che rende significativo il rilevamento Zero Trust. Il rilevamento senza risposta automatizzata crea un sistema che identifica le minacce più velocemente di quanto gli umani possano agire su di esse.


<table>
  <thead>
    <tr>
      <th>Pilastro Zero Trust</th>
      <th>Applicazione convenzionale</th>
      <th>Estensione specifica per sistemi AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Identità</td>
      <td>Verifica di utenti e account di servizio</td>
      <td>In più identità di agente AI, credenziali con ambito limitato al compito</td>
    </tr>
    <tr>
      <td>Dispositivo</td>
      <td>Stato dell'endpoint e gestione</td>
      <td>In più integrità dell'infrastruttura di inferenza AI</td>
    </tr>
    <tr>
      <td>Rete</td>
      <td>Microsegmentazione tra zone</td>
      <td>In più allowlist specifiche per AI per l'accesso esterno</td>
    </tr>
    <tr>
      <td>Applicazione</td>
      <td>Validazione dell'input e monitoraggio dell'output</td>
      <td>In più rilevamento di prompt injection, filtraggio dell'output</td>
    </tr>
    <tr>
      <td>Dati</td>
      <td>Controllo degli accessi basato sulla classificazione</td>
      <td>In più autorizzazione di retrieval, minimizzazione dei dati nelle query</td>
    </tr>
    <tr>
      <td>Visibilità</td>
      <td>Log di applicazione e accesso</td>
      <td>In più log di query del modello, retrieval, chiamate di strumenti e output</td>
    </tr>
    <tr>
      <td>Automazione</td>
      <td>Applicazione delle politiche e risposta alle anomalie</td>
      <td>In più analisi comportamentale e risposta specifiche per l'AI</td>
    </tr>
  </tbody>
</table>



## **Costruire la sicurezza AI Zero Trust nella pratica**

### **Iniziare con un audit degli accessi**

Il punto di partenza pratico per la sicurezza AI Zero Trust è un audit onesto di ciò a cui ogni sistema AI nell'implementazione dell'organizzazione può attualmente accedere rispetto a ciò a cui ha effettivamente bisogno di accedere per la sua funzione definita. Il divario tra questi due inventari definisce il lavoro di rimedio dei privilegi minimi che avvicina l'implementazione ai principi Zero Trust.

La maggior parte dei sistemi AI, in particolare quelli che si sono evoluti attraverso un lavoro di integrazione iterativo, ha accumulato permessi di accesso che riflettono la storia di ciò che è stato collegato piuttosto che una valutazione deliberata di ciò che è necessario. Uno strumento AI di ricerca che è stato integrato con l'e-mail per recuperare i documenti citati, poi connesso al sistema di gestione documentale per un contesto più ampio, quindi collegato al CRM per il riferimento ai clienti, può ora avere accesso a tre sistemi che contengono ciascuno dati sensibili ben oltre ciò che qualsiasi specifico compito di ricerca richiede.

L'audit degli accessi produce una mappa delle capacità: ogni sistema a cui uno strumento AI può accedere, ogni azione che può intraprendere e ogni categoria di dati che può recuperare, accanto a una mappa dei requisiti operativi: ogni sistema di cui ha effettivamente bisogno per la sua funzione definita, ogni azione che tale funzione richiede legittimamente e ogni categoria di dati di cui la funzione ha veramente bisogno. La rimedio consiste nel colmare il divario tra i due attraverso la riduzione dell'ambito di accesso, la segmentazione della rete e l'implementazione di modelli di accesso just-in-time per le capacità di cui il sistema ha bisogno occasionalmente piuttosto che continuativamente.

### **Implementare la verifica continua senza degradare le prestazioni**

Una preoccupazione comune nell'applicazione dei principi Zero Trust ai sistemi AI è che la verifica continua introdurrà una latenza che degrada l'esperienza utente degli strumenti AI che devono rispondere rapidamente. Questa preoccupazione è reale ma gestibile attraverso scelte architetturali che collocano la verifica nei punti giusti piuttosto che aggiungerla uniformemente a ogni interazione.

La verifica a livello di sessione per l'accesso utente autenticato gestisce la maggior parte del sovraccarico di verifica dell'identità umana con un singolo evento di autenticazione piuttosto che per ogni query. Le decisioni di autorizzazione memorizzate nella cache per i modelli di accesso ai dati che ricorrono frequentemente riducono il sovraccarico di verifica per le operazioni di retrieval senza abbandonare il requisito di verifica. La verifica asincrona per operazioni di sensibilità inferiore che possono tollerare una risoluzione di autorizzazione leggermente ritardata preserva la traccia di audit Zero Trust senza latenza sincrona ad ogni interazione.

I punti di verifica che richiedono veramente un comportamento di blocco sincrono prima di procedere sono quelli che governano l'accesso a dati ad alta sensibilità, azioni con conseguenze significative o irreversibili e anomalie comportamentali che attivano un controllo elevato. Per le operazioni di routine all'interno dei baseline comportamentali consolidati, la verifica può essere gestita in modo efficiente senza latenza visibile all'utente attraverso architetture di caching e asincrone ben progettate.

Una[ guida AI](https://trigger.fish/guide/) completa sull'implementazione di architetture di sicurezza AI Zero Trust che bilanciano il rigore della verifica con le prestazioni operative aiuta le organizzazioni a evitare la falsa scelta tra sicurezza e usabilità che le implementazioni mal progettate creano.

**IMAGE SUGGESTION: A developer or security architect at a dual-monitor workstation reviewing access control configuration settings for an AI system deployment, organized technical environment, code or configuration visible on one screen and a system diagram on the other, no readable text visible on either screen.**

## **Cose da sapere**

Diverse realtà importanti sulla sicurezza AI Zero Trust che le organizzazioni incontrano nel passaggio dai principi architetturali all'implementazione operativa:

Lo Zero Trust è un processo continuo, non uno stato di implementazione. Le organizzazioni non raggiungono lo Zero Trust per poi mantenerlo passivamente. Si muovono continuamente verso lo Zero Trust attraverso una continua riduzione dell'ambito di accesso, un'espansione della copertura di monitoraggio e un miglioramento dell'architettura di verifica. L'obiettivo è direzionale e continuo piuttosto che uno stato di completamento definito.

Le integrazioni AI legacy sono l'obiettivo di rimedio Zero Trust più difficile. I sistemi AI che sono stati integrati con l'infrastruttura esistente prima che i principi Zero Trust venissero applicati all'implementazione spesso hanno schemi di accesso tecnicamente difficili da limitare senza rompere la funzionalità. Il rimedio di queste integrazioni richiede di comprendere sia il requisito Zero Trust sia la dipendenza operativa, il che spesso significa lavorare sulle integrazioni una per una piuttosto che applicare un cambiamento di politica uniforme.

Il principio del 30% si applica all'automazione della verifica Zero Trust. I controlli di verifica automatizzati dovrebbero gestire circa il 30% delle operazioni di sicurezza, specificamente le decisioni di accesso basate su politiche ad alta frequenza e il monitoraggio comportamentale che l'automazione esegue costantemente su scala. I professionisti della sicurezza e i proprietari della governance gestiscono il restante 70% che coinvolge la valutazione del rischio, la progettazione delle politiche, l'indagine sulle anomalie e le decisioni di sicurezza ad alta intensità di giudizio che richiedono responsabilità umana piuttosto che esecuzione algoritmica.

Lo Zero Trust non elimina la necessità della sicurezza perimetrale. Si stratifica con i controlli perimetrali piuttosto che sostituirli. Le organizzazioni che passano alla sicurezza AI Zero Trust mantengono i controlli del perimetro di rete aggiungendo al contempo i livelli di verifica dell'identità, dei dati e del comportamento che lo Zero Trust fornisce. Il perimetro diventa un livello tra molti piuttosto che la difesa primaria.

Gli impatti sull'esperienza utente dell'implementazione Zero Trust determinano il successo dell'adozione. Le architetture di sicurezza che rendono gli strumenti AI significativamente più macchinosi da utilizzare spingono i dipendenti verso alternative AI ombra che operano al di fuori di qualsiasi controllo Zero Trust. Progettare flussi di verifica minimamente intrusivi per l'utilizzo legittimo mantenendo controlli rigorosi per operazioni anomale o ad alto rischio è un requisito di qualità dell'implementazione, non un miglioramento opzionale.

Il supporto Zero Trust dei fornitori varia significativamente tra le piattaforme AI aziendali. Alcuni strumenti AI aziendali sono progettati con punti di integrazione Zero Trust inclusi federazione delle identità, controlli di accesso granulari, API di logging complete e supporto per il monitoraggio comportamentale. Altri richiedono un'infrastruttura supplementare significativa per ottenere una copertura Zero Trust equivalente. Valutare il supporto Zero Trust del fornitore come parte della selezione degli strumenti AI riduce l'onere dell'implementazione rispetto al retrofitting di controlli Zero Trust su strumenti che non sono stati progettati per essi.

La responsabilità congiunta tra i team di sicurezza e di operazioni AI è essenziale per programmi di sicurezza AI Zero Trust che funzionino nella pratica. I team di sicurezza apportano l'esperienza Zero Trust. I team di operazioni AI apportano la comprensione del comportamento del sistema AI, delle dipendenze di integrazione e dei requisiti operativi che determinano dove i controlli di verifica sono pratici e dove richiedono soluzioni architetturali alternative. I programmi progettati dai team di sicurezza senza il contributo delle operazioni AI tendono a creare architetture di sicurezza teoriche che falliscono nell'implementazione.

## **Lo Zero Trust come fondamento giusto per un'implementazione AI sicura**

La sicurezza AI Zero Trust non è l'architettura di sicurezza più conveniente per i sistemi AI. Richiede una progettazione degli accessi più deliberata, più investimenti nell'infrastruttura di verifica e più disciplina operativa rispetto alla sicurezza perimetrale o ai modelli di fiducia implicita. Le organizzazioni che fanno tale investimento trovano costantemente che esso abilita piuttosto che limitare le loro ambizioni AI, perché crea il fondamento di sicurezza che permette ai sistemi AI di essere connessi più ampiamente, di essere oggetto di una fiducia più profonda e di essere implementati in contesti a più alto rischio rispetto ai sistemi che operano senza un rigore di verifica equivalente.

I sistemi AI che alla fine porteranno il maggior valore organizzativo sono quelli a cui vengono affidati i dati più sensibili, connessi ai sistemi più importanti e autorizzati a intraprendere le azioni più incisive. La sicurezza AI Zero Trust è l'architettura che rende tale fiducia difendibile piuttosto che ambizionale, fornendo la verifica continua, la visibilità comportamentale e la limitazione dell'accesso che consentono alle organizzazioni di estendere una fiducia significativa ai sistemi AI invece di accettare l'esposizione come il prezzo della capacità.

## **Domande frequenti**

### **Cos'è lo Zero Trust nell'AI?**

**Lo Zero Trust nell'AI è l'applicazione dei principi di verifica continua e accesso con privilegi minimi ai sistemi di intelligenza artificiale, che richiede che ogni utente, modello, agente, accesso ai dati e interazione con strumenti sia verificato rispetto all'autorizzazione corrente piuttosto che fare affidamento sulla fiducia implicita concessa all'autenticazione iniziale o basata sulla posizione di rete.** Tratta i sistemi AI come obiettivi di alto valore con comportamento dinamico e connesso che richiede un'architettura di verifica progettata specificamente per come i sistemi AI operano effettivamente piuttosto che i modelli convenzionali di sicurezza delle applicazioni che non tengono conto delle superfici di attacco specifiche dell'AI.

### **Cos'è la sicurezza Zero Trust?**

**La sicurezza Zero Trust è un modello di sicurezza basato sul principio che nessun utente, dispositivo o sistema dovrebbe essere implicitamente affidabile in base alla sua posizione di rete, richiedendo invece che ogni richiesta di accesso sia continuamente verificata rispetto a politiche di identità, salute del dispositivo e autorizzazione contestuale prima che l'accesso venga concesso.** Sostituisce il modello tradizionale del perimetro che si fidava di tutto all'interno del confine di rete con un modello che tratta ogni interazione come potenzialmente non affidabile e richiede la verifica ad ogni punto di accesso indipendentemente da dove abbia origine la richiesta.

### **Qual è un esempio di modello di sicurezza Zero Trust?**

**Un esempio pratico di un modello di sicurezza Zero Trust in un'implementazione AI è un assistente AI aziendale in cui ogni utente si autentica con autenticazione a più fattori prima di accedere al sistema, la pipeline di retrieval dell'AI applica i permessi documentali dell'utente richiedente in modo da poter mostrare solo i contenuti che è autorizzato a vedere, tutte le chiamate di strumenti che l'agente AI effettua richiedono un'autorizzazione esplicita per ciascuna azione invece di ereditare ampi permessi di account di servizio, e ogni query, retrieval e azione viene registrata per il monitoraggio comportamentale che segnala anomalie per la revisione di sicurezza.** Questo esempio illustra lo Zero Trust applicato attraverso le dimensioni di identità, dati e azione di un sistema AI piuttosto che solo al perimetro di rete.

### **In che modo lo Zero Trust migliora la sicurezza?**

**Lo Zero Trust migliora la sicurezza riducendo il raggio di impatto degli attacchi riusciti attraverso la limitazione dell'accesso con privilegi minimi che limita ciò a cui un'identità compromessa o un sistema AI manipolato può accedere, abilitando un rilevamento più rapido delle anomalie attraverso una registrazione completa di tutti gli eventi di accesso rispetto ai baseline comportamentali, ed eliminando le ipotesi di fiducia implicita che gli attaccanti sfruttano attraverso il movimento laterale una volta che sono all'interno di un perimetro di rete.** Per i sistemi AI in particolare, lo Zero Trust migliora la sicurezza applicando la verifica continua al comportamento dinamico e connesso degli agenti AI che le difese perimetrali non possono governare perché non hanno un confine definito da proteggere.

### **Quali sono i 7 pilastri dello Zero Trust?**

**I sette pilastri dello Zero Trust sono la verifica dell'identità che richiede l'autenticazione continua di utenti e sistemi, la sicurezza del dispositivo che garantisce la salute dell'endpoint prima che venga concesso l'accesso, la segmentazione della rete che sostituisce la rete piatta e fidata con zone microsegmentate che richiedono autorizzazione esplicita tra di esse, la sicurezza delle applicazioni che applica la validazione dell'input e il monitoraggio dell'output a livello applicativo, la sicurezza dei dati che impone controlli di accesso basati sulla classificazione e minimizzazione dei dati, la visibilità e l'analisi che forniscono registrazione completa e rilevamento delle anomalie comportamentali, e l'automazione e l'orchestrazione che consentono l'applicazione delle politiche e la risposta alle anomalie alla scala e alla velocità che la verifica continua richiede.** Applicato ai sistemi AI, ogni pilastro assume estensioni specifiche che affrontano le caratteristiche uniche del comportamento AI, della connettività e della superficie di attacco che la sicurezza delle applicazioni convenzionali non è stata progettata per governare.
