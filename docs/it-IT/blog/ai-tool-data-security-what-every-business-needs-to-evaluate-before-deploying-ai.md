---
title: "Sicurezza dei dati negli strumenti di AI: cosa ogni azienda deve
  valutare prima di adottare l'AI"
date: 2026-03-31
description: La sicurezza dei dati negli strumenti di AI determina se i dati
  aziendali rimangono protetti o diventano una passività. Ecco cosa valutare
  prima di affidare informazioni sensibili a qualsiasi AI.
author: triggerfish
tags:
  - AI agent
draft: false
---
La sicurezza dei dati negli strumenti di AI si riferisce alla combinazione di controlli tecnici, tutele contrattuali e prassi operative che determinano la sicurezza con cui i dati di un'organizzazione vengono gestiti quando attraversano i sistemi di intelligenza artificiale. Copre tutto, dal modo in cui i dati vengono cifrati in transito al fatto che un fornitore utilizzi i Vostri input per addestrare i modelli futuri.

I guadagni in produttività offerti dagli strumenti di AI sono reali e ampiamente documentati in tutti i settori. Lo sono anche gli incidenti di sicurezza dei dati che hanno fatto seguito a implementazioni in cui le organizzazioni hanno valutato gli strumenti di AI principalmente in base alle capacità, trattando la sicurezza come una considerazione secondaria. Dipendenti che incollano informazioni riservate dei clienti in interfacce AI pubbliche. Dati dei clienti elaborati sull'infrastruttura del fornitore senza un accordo firmato di trattamento dei dati. Logiche aziendali proprietarie inviate ad assistenti di programmazione AI i cui termini di servizio consentono di conservare quel codice per migliorare il modello. Nessuno di questi scenari richiede un attacco sofisticato. Richiedono solo che un'organizzazione si sia mossa velocemente nell'adozione dell'AI senza porsi le domande giuste su dove vanno i suoi dati e cosa accade loro una volta arrivati. Questa guida spiega cosa richiede realmente la sicurezza dei dati negli strumenti di AI, come valutarla nei vari strumenti che la Vostra organizzazione sta considerando e come si presentano nella pratica le decisioni di sicurezza più decisive.



![AI agent](/blog/images/it-security.jpg)

## **Perché gli strumenti di AI creano sfide per la sicurezza dei dati che i controlli IT standard non rilevano**

### **Il nuovo problema del flusso di dati**

Ogni organizzazione che implementa uno strumento di AI crea un nuovo flusso di dati che la sua infrastruttura di sicurezza esistente non è stata progettata per monitorare o controllare. Quando un dipendente invia un documento a uno strumento di AI per la sintesi, un record di un cliente a un assistente AI per l'analisi, o codice sorgente a uno strumento di programmazione AI per la revisione, quei dati viaggiano verso un'infrastruttura che l'organizzazione non possiede, vengono elaborati su server che l'organizzazione non può ispezionare e potenzialmente persistono in log o set di dati di addestramento sui quali l'organizzazione non ha alcuna visibilità.

Gli strumenti tradizionali di Data Loss Prevention sono stati costruiti per monitorare i dati che si muovono attraverso canali noti: email, trasferimenti di file, dispositivi USB, applicazioni di archiviazione cloud. Gli strumenti di AI rappresentano una categoria di uscita di dati che i sistemi DLP spesso non classificano correttamente, perché il traffico sembra un legittimo utilizzo di un'applicazione web piuttosto che un'esfiltrazione di dati. Il percorso tecnico è una richiesta HTTPS standard verso un servizio web. La conseguenza sulla sicurezza è che dati potenzialmente sensibili dell'organizzazione lasciano il perimetro di rete senza nessuno dei controlli che regolano altre forme di condivisione dei dati.

Questo non è un rischio ipotetico. Organizzazioni nei settori dei servizi finanziari, sanitario, legale e tecnologico hanno documentato incidenti in cui i dipendenti hanno utilizzato strumenti di AI per elaborare dati che non avrebbero mai dovuto lasciare l'ambiente controllato dell'organizzazione, con conseguenze che vanno dalle violazioni della conformità all'esposizione di informazioni competitive fino al danneggiamento dei rapporti con i clienti quando il trattamento dei dati è venuto alla luce.

### **Dove le ipotesi di sicurezza standard non reggono**

La sicurezza dei dati negli strumenti di AI richiede di rivedere diverse ipotesi che reggono ragionevolmente per il software convenzionale ma falliscono quando applicate ai sistemi di AI.

L'ipotesi che i dati inviati a un fornitore per l'elaborazione siano regolati principalmente dal contratto si complica nei sistemi di AI, perché gli stessi dati possono essere utilizzati per scopi che vanno oltre il servizio immediato, in particolare per l'addestramento e il miglioramento del modello, in modi consentiti da termini di servizio che gli utenti accettano senza leggere. Il contratto regola il servizio. I termini di servizio possono consentire usi dei dati che il contratto non vieta esplicitamente.

L'ipotesi che la cancellazione dei dati da un sistema rimuova le informazioni in esso contenute non vale del tutto per i sistemi di AI, in cui i dati possono aver influenzato i pesi del modello durante l'addestramento. I dati che sono stati codificati in un modello attraverso il processo di addestramento non possono essere semplicemente cancellati rimuovendo i record originali. Per le organizzazioni con obblighi normativi sulla cancellazione dei dati e sul diritto all'oblio, ciò crea una complessità di conformità che le prassi convenzionali di gestione dei dati non affrontano.

L'ipotesi che le certificazioni di sicurezza detenute da un fornitore si applichino in modo uniforme a tutti i suoi prodotti richiede verifica anziché inferenza per i fornitori di AI, perché i prodotti AI enterprise sono spesso costruiti su un'infrastruttura certificata separatamente rispetto ai prodotti consumer offerti dalla stessa azienda. La certificazione SOC 2 di un fornitore che copre la sua infrastruttura cloud non si estende automaticamente a un prodotto assistente AI in esecuzione su quell'infrastruttura, a meno che l'ambito dell'audit non lo includa esplicitamente.

Esaminare come i framework di valutazione della [sicurezza AI](https://trigger.fish/security/) affrontano queste considerazioni di sicurezza dei dati specifiche dell'AI aiuta le organizzazioni a costruire processi di valutazione che catturino le vulnerabilità che le revisioni di sicurezza IT convenzionali non rilevano.



![AI agent](/blog/images/split-illustration.jpg)

## **Le dimensioni fondamentali della sicurezza dei dati negli strumenti di AI**

### **Dati in transito e a riposo**

Lo strato fondamentale della sicurezza dei dati negli strumenti di AI riguarda il modo in cui i dati sono protetti mentre si spostano tra i Vostri sistemi e l'infrastruttura dello strumento di AI, e il modo in cui sono protetti quando sono memorizzati su quell'infrastruttura. Sono i controlli che la maggior parte dei professionisti della sicurezza valuta per primi, perché si mappano su concetti di sicurezza familiari e sono relativamente semplici da valutare.

I dati in transito devono essere cifrati utilizzando gli standard TLS correnti su ogni connessione tra i Vostri sistemi e l'infrastruttura del fornitore. Ciò include non solo la connessione principale dell'interfaccia utente ma qualsiasi connessione API, callback di webhook e integrazioni con altri sistemi a cui lo strumento AI si collega. I fornitori che non possono confermare gli standard di cifratura applicati a ogni connessione nel loro flusso di dati hanno lacune nella loro documentazione di sicurezza che giustificano un'indagine più approfondita.

La cifratura dei dati a riposo copre il modo in cui i dati sono protetti quando sono memorizzati sull'infrastruttura del fornitore, inclusi i log di inferenza, le cronologie delle conversazioni, i documenti memorizzati nella cache e qualsiasi altra memorizzazione persistente che lo strumento di AI mantenga. La cifratura a riposo utilizzando AES-256 o equivalente è un'aspettativa di base per qualsiasi strumento di AI enterprise, e le prassi di gestione delle chiavi attorno a quella cifratura, in particolare chi controlla le chiavi e a quali condizioni vi si possa accedere, sono altrettanto importanti quanto lo standard di cifratura stesso.

Per le organizzazioni con i più alti requisiti di sicurezza dei dati, le chiavi di cifratura gestite dal cliente, in cui la Vostra organizzazione controlla le chiavi utilizzate per cifrare i Vostri dati sull'infrastruttura del fornitore, forniscono un significativo strato di controllo aggiuntivo che la cifratura standard gestita dal fornitore non offre. Diversi fornitori di strumenti di AI enterprise offrono questa capacità nei loro livelli di servizio più elevati.

### **Conservazione dei dati e uso per l'addestramento**

Dopo la cifratura, le due domande di sicurezza dei dati più decisive per la maggior parte delle implementazioni di strumenti di AI sono per quanto tempo il fornitore conserva i dati elaborati attraverso il suo sistema e se quei dati vengono utilizzati per addestrare o migliorare i suoi modelli.

Le prassi di conservazione variano significativamente tra fornitori e livelli. Alcuni strumenti di AI di livello consumer conservano le cronologie delle conversazioni a tempo indeterminato per impostazione predefinita. Alcuni livelli enterprise conservano i log di inferenza per periodi definiti per scopi di debug e qualità. Alcuni fornitori offrono configurazioni a conservazione zero, in cui nessun dato viene memorizzato oltre la richiesta di inferenza immediata. Il profilo di conservazione corretto dipende dalla sensibilità dei Vostri dati e dai requisiti normativi, ma qualsiasi conservazione crea una finestra di esposizione che deve essere compresa e contrattualmente definita prima dell'implementazione.

L'uso dei dati per l'addestramento è la questione che incide più direttamente sulle organizzazioni che elaborano informazioni proprietarie o sensibili tramite strumenti di AI. I fornitori i cui termini di servizio consentono di utilizzare i contenuti inviati per migliorare i loro modelli stanno di fatto chiedendo ai loro clienti di contribuire con informazioni proprietarie a una risorsa condivisa che potrebbe in definitiva avvantaggiare i concorrenti che utilizzano la stessa piattaforma. Gli accordi enterprise con i principali fornitori di AI vietano quasi universalmente l'uso dei dati per l'addestramento come clausola standard, ma le organizzazioni devono confermarlo esplicitamente anziché darlo per scontato.


<table>
  <thead>
    <tr>
      <th>Dimensione di sicurezza dei dati</th>
      <th>Cosa confermare</th>
      <th>Perché è importante</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Cifratura in transito</td>
      <td>Versione TLS e copertura su tutte le connessioni</td>
      <td>Previene l'intercettazione durante la trasmissione</td>
    </tr>
    <tr>
      <td>Cifratura a riposo</td>
      <td>Standard di cifratura e approccio alla gestione delle chiavi</td>
      <td>Protegge i dati memorizzati da violazioni dell'infrastruttura</td>
    </tr>
    <tr>
      <td>Periodo di conservazione</td>
      <td>Durata specifica della conservazione per categoria di dati</td>
      <td>Definisce la finestra di esposizione oltre ogni interazione</td>
    </tr>
    <tr>
      <td>Uso dei dati per l'addestramento</td>
      <td>Divieto esplicito senza eccezioni in opt-in</td>
      <td>Impedisce che dati proprietari addestrino modelli condivisi</td>
    </tr>
    <tr>
      <td>Controlli di accesso ai log</td>
      <td>Chi presso il fornitore può accedere ai log di inferenza e a quali condizioni</td>
      <td>Limita l'accesso interno ai Vostri dati organizzativi</td>
    </tr>
    <tr>
      <td>Cancellazione dei dati</td>
      <td>Processo e tempistica della cancellazione su richiesta o alla fine del contratto</td>
      <td>Consente la conformità agli obblighi di cancellazione</td>
    </tr>
    <tr>
      <td>Divulgazione dei subincaricati</td>
      <td>Elenco completo dei terzi con accesso ai Vostri dati</td>
      <td>Fa emergere l'esposizione indiretta dei dati attraverso i fornitori del fornitore</td>
    </tr>
  </tbody>
</table>



### **Controlli di accesso e autenticazione**

La sicurezza dell'implementazione di uno strumento di AI all'interno della Vostra organizzazione dipende tanto da come l'accesso viene gestito internamente quanto dai controlli di sicurezza esterni del fornitore. Uno strumento di AI con una forte sicurezza del fornitore ma senza integrazione con la Vostra infrastruttura di gestione delle identità crea una lacuna nel governo degli accessi che espone gli stessi dati organizzativi attraverso un canale che aggira i controlli che regolano ogni altro sistema.

Le implementazioni enterprise di strumenti di AI dovrebbero integrarsi con l'infrastruttura di single sign-on della Vostra organizzazione, in modo che l'accesso sia regolato dagli stessi processi di provisioning e deprovisioning degli altri sistemi organizzativi. Quando un dipendente lascia l'organizzazione o cambia ruolo, il suo accesso allo strumento di AI dovrebbe essere rimosso o modificato attraverso lo stesso flusso di lavoro che gestisce gli altri suoi accessi ai sistemi, non attraverso un processo manuale separato destinato a rimanere indietro.

I controlli di accesso basati sui ruoli all'interno dello strumento di AI dovrebbero limitare ciò che diverse categorie di utenti possono inviare al sistema, da quali fonti di dati lo strumento può recuperare informazioni e quali output lo strumento può produrre o esportare. Il principio del minimo privilegio si applica all'accesso agli strumenti di AI tanto direttamente quanto a qualsiasi altro sistema organizzativo, e le organizzazioni che configurano gli strumenti di AI con un accesso uniformemente ampio per tutti gli utenti accettano un rischio di esposizione dei dati che i controlli di accesso mirati eviterebbero.

Comprendere come le decisioni sull'[architettura AI](https://trigger.fish/architecture/) relative all'integrazione delle identità e ai controlli di accesso influenzino la postura di sicurezza pratica delle implementazioni degli strumenti di AI aiuta le organizzazioni a configurare i propri sistemi per il loro effettivo profilo di rischio anziché accettare configurazioni predefinite progettate per l'uso generale.

**IMAGE SUGGESTION: A clean diagram showing an AI tool deployment within a corporate network boundary with visible access control layers including authentication, role permissions, and data classification filters between users and the AI system, professional security architecture diagram style, no text overlays.**

## **Come l'AI viene utilizzata per migliorare la sicurezza dei dati**

Il rapporto tra AI e sicurezza dei dati va in entrambe le direzioni, e vale la pena affrontare i modi in cui l'AI sta attivamente rafforzando i programmi di sicurezza invece di limitarsi a creare nuove sfide per essi.

I sistemi di rilevamento delle minacce alimentati dal machine learning analizzano i modelli comportamentali nel traffico di rete, nell'attività degli utenti e nei log di sistema per identificare anomalie che il rilevamento basato su regole non rileva. Un sistema di monitoraggio della sicurezza alimentato dall'AI impara come appare il normale per il Vostro ambiente specifico e mette in evidenza le deviazioni che meritano un'indagine, riducendo sia i tassi di falsi positivi che fanno perdere tempo agli analisti, sia i tassi di falsi negativi che consentono a minacce reali di passare inosservate.

Gli strumenti di classificazione dei dati che utilizzano l'elaborazione del linguaggio naturale identificano automaticamente i contenuti sensibili in documenti, email e comunicazioni con una scala e una coerenza che la classificazione manuale non può eguagliare. Quando l'AI può classificare automaticamente un documento come contenente informazioni sanitarie personali, dati finanziari o contenuti legalmente privilegiati nel momento in cui entra in un sistema, quella classificazione può attivare controlli di gestione appropriati senza richiedere una revisione manuale di ogni documento.

Le piattaforme di operazioni di sicurezza che utilizzano l'AI assistono gli analisti con i flussi di lavoro investigativi, correlando eventi su più fonti di dati, mettendo in evidenza il contesto storico rilevante e dando priorità alla coda degli avvisi in base alla gravità valutata. Gli analisti che prima passavano la maggior parte del loro tempo sul triage degli avvisi ne dedicano una parte maggiore alle indagini complesse che richiedono realmente il giudizio umano, mentre l'AI gestisce il lavoro di riconoscimento dei pattern che supporta tale triage.

Queste applicazioni dell'AI alla sicurezza dimostrano che il rapporto tra le due non è antagonista. Gli strumenti di AI creano sfide per la sicurezza dei dati che richiedono una gestione attenta. Le capacità dell'AI forniscono anche miglioramenti della sicurezza che sarebbero impraticabili senza di esse. Le organizzazioni che gestiscono questo in modo più efficace trattano entrambe le dimensioni come reali e le affrontano simultaneamente invece di concentrarsi esclusivamente sui rischi ignorando le applicazioni difensive.

Esaminare come le [funzionalità AI](https://trigger.fish/features/) nelle piattaforme di sicurezza enterprise implementano capacità di rilevamento e risposta alimentate dall'AI aiuta le organizzazioni a valutare se gli investimenti in sicurezza AI stanno migliorando la loro postura difensiva in modi che integrano il loro programma di governance degli strumenti di AI.

## **Costruire un programma di sicurezza dei dati per gli strumenti di AI**

### **Il problema dell'inventario che bisogna risolvere per primo**

Le organizzazioni non possono mettere in sicurezza i flussi di dati degli strumenti di AI che non hanno mappato. Il punto di partenza per qualsiasi programma di sicurezza dei dati per gli strumenti di AI è un inventario completo degli strumenti di AI attualmente in uso in tutta l'organizzazione, inclusi quelli adottati da singoli team o dipendenti senza il coinvolgimento dell'IT centrale.

Questo inventario fa costantemente emergere più strumenti di quanti i team IT centrali si aspettino, perché le capacità di AI sono state incorporate in applicazioni di produttività ampiamente utilizzate, piattaforme di comunicazione e software aziendali in modi che gli utenti potrebbero non riconoscere come uso distinto di uno strumento di AI. L'assistente di scrittura AI integrato in un word processor, la funzione di risposta intelligente in un client email, la sintesi automatizzata in un sistema di gestione documentale e l'analisi predittiva in un CRM rappresentano tutti l'elaborazione AI di dati organizzativi che appartengono alla valutazione di sicurezza anche se nessuno di essi sembra un'adozione autonoma di uno strumento di AI.

Una volta che l'inventario esiste, ogni strumento deve essere valutato rispetto alle dimensioni di sicurezza dei dati discusse sopra e approvato per specifiche categorie di dati, approvato con restrizioni o vietato in attesa di revisione della sicurezza. L'obiettivo non è eliminare l'uso degli strumenti di AI ma assicurarsi che ogni strumento di AI utilizzato dalla Vostra organizzazione sia stato valutato rispetto ai Vostri requisiti di sicurezza dei dati anziché essere adottato unicamente sulla base delle capacità.

### **Tutele contrattuali che devono essere in vigore**

I controlli tecnici di sicurezza proteggono i dati sull'infrastruttura del fornitore. Le tutele contrattuali definiscono gli obblighi legali che regolano il modo in cui quei dati vengono gestiti e quali rimedi ha la Vostra organizzazione quando tali obblighi non vengono rispettati. Entrambi sono necessari e nessuno dei due sostituisce l'altro.

Gli accordi di trattamento dei dati che coprono gli specifici strumenti di AI da implementare devono essere in vigore prima che qualsiasi dato organizzativo fluisca attraverso quegli strumenti. Per le organizzazioni che gestiscono dati personali dell'UE, si tratta di un requisito di legge ai sensi del GDPR. Per le organizzazioni sanitarie che gestiscono informazioni sanitarie protette, è richiesto un Business Associate Agreement dalla HIPAA. Per le organizzazioni di servizi finanziari, possono applicarsi accordi di trattamento dei dati specifici per il settore. Al di là dei requisiti normativi, gli accordi di trattamento dei dati con i fornitori di AI definiscono i limiti di conservazione dei dati, i divieti sui dati di addestramento, gli obblighi di notifica delle violazioni e le procedure di cancellazione dei dati che proteggono gli interessi organizzativi indipendentemente dal mandato normativo.


<table>
  <thead>
    <tr>
      <th>Tutela contrattuale</th>
      <th>Cosa copre</th>
      <th>Organizzazioni che ne hanno bisogno</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Accordo di trattamento dei dati</td>
      <td>Conformità al GDPR per il trattamento dei dati personali UE</td>
      <td>Qualsiasi organizzazione che gestisce dati personali UE</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Conformità HIPAA per le informazioni sanitarie protette</td>
      <td>Organizzazioni sanitarie e loro fornitori</td>
    </tr>
    <tr>
      <td>Divieto sui dati di addestramento</td>
      <td>Divieto contrattuale esplicito sull'uso dei dati per addestrare modelli</td>
      <td>Tutte le organizzazioni che trattano dati proprietari o sensibili</td>
    </tr>
    <tr>
      <td>Impegno alla notifica delle violazioni</td>
      <td>Obbligo del fornitore di notificare entro una tempistica definita</td>
      <td>Tutte le organizzazioni, tipicamente 72 ore sotto GDPR</td>
    </tr>
    <tr>
      <td>Accordo di cancellazione dei dati</td>
      <td>Impegno del fornitore di cancellare i dati su richiesta o alla fine del contratto</td>
      <td>Organizzazioni con obblighi di cancellazione dei dati</td>
    </tr>
    <tr>
      <td>Gestione dei subincaricati</td>
      <td>Impegno del fornitore a mantenere la sicurezza con i propri fornitori</td>
      <td>Organizzazioni con requisiti di catena di custodia</td>
    </tr>
  </tbody>
</table>



Una [guida AI](https://trigger.fish/guide/) completa sulla strutturazione degli accordi con i fornitori di AI per la sicurezza dei dati aiuta le organizzazioni a costruire framework contrattuali che proteggano i loro interessi lungo l'intero ciclo di vita di un rapporto con uno strumento di AI, non solo al momento dell'implementazione iniziale.

### **Il problema dello Shadow AI e come affrontarlo**

Lo Shadow AI, ovvero l'uso di strumenti di AI da parte dei dipendenti al di fuori delle implementazioni approvate e gestite centralmente, è la fonte più significativa di rischio non gestito sulla sicurezza dei dati nella maggior parte delle organizzazioni che hanno adottato ampiamente l'AI. La stessa dinamica che ha creato il rischio dello Shadow IT nell'era dell'adozione del cloud si sta riproponendo con gli strumenti di AI, spesso più velocemente e con implicazioni più significative per la sicurezza dei dati, perché i dati inviati agli strumenti di AI includono spesso esattamente quelle informazioni organizzative che i programmi di sicurezza sono progettati per proteggere.

La risposta più efficace allo Shadow AI combina tre elementi. La visibilità tramite il monitoraggio del traffico di rete e dell'utilizzo delle applicazioni legate all'AI fornisce ai team di sicurezza la consapevolezza necessaria per identificare l'utilizzo non autorizzato degli strumenti prima che crei un'esposizione significativa. Un programma di strumenti approvati chiaro e accessibile riduce l'incentivo all'adozione in ombra garantendo che i dipendenti che necessitano di capacità di AI abbiano opzioni approvate che soddisfino le loro esigenze reali. E un meccanismo di segnalazione non punitivo per i dipendenti che hanno già utilizzato strumenti non approvati incoraggia l'autodivulgazione che aiuta le organizzazioni a identificare e contenere l'esposizione esistente anziché scoprirla attraverso incidenti.

Le organizzazioni che rispondono allo Shadow AI principalmente attraverso il divieto anziché la fornitura scoprono che il bisogno sottostante di capacità di AI non scompare, ma si sposta su dispositivi e account personali dove la visibilità e il controllo organizzativi sono ancora più limitati.

## **Cose da sapere**

Diverse realtà importanti sulla sicurezza dei dati degli strumenti di AI che le organizzazioni regolarmente scoprono più tardi di quanto avrebbero voluto:

Le versioni consumer ed enterprise dello stesso strumento di AI hanno proprietà di sicurezza fondamentalmente diverse. Il livello gratuito o personale di uno strumento di AI e il suo equivalente enterprise dello stesso fornitore spesso differiscono drasticamente nelle prassi di conservazione dei dati, nell'uso dei dati per l'addestramento, negli standard di cifratura e nelle tutele contrattuali disponibili. La valutazione del livello enterprise non è facoltativa per i dati aziendali, anche quando il livello consumer è disponibile e funzionale.

Le certificazioni di sicurezza devono essere verificate per attualità e ambito. Un report SOC 2 vecchio di diciotto mesi o che copre l'infrastruttura ma non lo strato del prodotto AI Vi dice meno di quanto sembri. Confermate sempre il periodo del report, il confine dell'ambito dell'audit e i prodotti specifici coperti prima di affidarVi a una certificazione come prova della postura di sicurezza attuale.

La regola del 30% si applica utilmente alla governance della sicurezza dei dati. Bisognerebbe fidarsi degli strumenti di AI per gestire approssimativamente il 30% dei flussi di lavoro di elaborazione dei dati in modo autonomo, in particolare quelli che coinvolgono categorie di dati a minore sensibilità con controlli di sicurezza ben consolidati, mentre il 70% che coinvolge categorie di dati più sensibili o regolamentate richiede una supervisione umana aggiuntiva, criteri di selezione degli strumenti più rigorosi o approcci di elaborazione alternativi che forniscano garanzie di sicurezza più solide.

Le connessioni API e di integrazione moltiplicano la Vostra superficie di esposizione dei dati. Quando uno strumento di AI è integrato con i Vostri sistemi di email, calendario, archiviazione documentale o CRM, ottiene accesso all'intero ambiente di dati di quei sistemi, non solo ai dati specifici che Voi gli inviate attivamente. La valutazione di sicurezza di uno strumento di AI che sarà profondamente integrato deve coprire l'accesso integrato ai dati in modo completo.

La pianificazione della risposta agli incidenti per eventi di sicurezza dei dati AI richiede una preparazione specifica. I tipi di prove rilevanti per un incidente di sicurezza dei dati AI, inclusi i log di inferenza, i registri di accesso API e i log degli eventi dell'infrastruttura del fornitore, sono diversi dai log di rete e di sistema attorno ai quali sono costruiti i manuali di risposta agli incidenti convenzionali. Inserire procedure specifiche per l'AI di raccolta di prove e di coordinamento con il fornitore nel Vostro piano di risposta agli incidenti prima che si verifichi un incidente migliora drasticamente la Vostra capacità di risposta quando ne avete bisogno.

I trasferimenti internazionali di dati attivati dall'infrastruttura AI richiedono meccanismi legali specifici in molte giurisdizioni. Uno strumento di AI la cui infrastruttura di inferenza opera al di fuori della Vostra giurisdizione regolatoria può attivare requisiti di trasferimento transfrontaliero dei dati che devono essere soddisfatti tramite Standard Contractual Clauses, decisioni di adeguatezza o meccanismi equivalenti prima che i dati regolamentati possano essere legalmente elaborati attraverso di esso.

## **Trattare la sicurezza dei dati negli strumenti di AI come una base competitiva**

Le organizzazioni che costruiscono solidi programmi di sicurezza dei dati per gli strumenti di AI scoprono che l'investimento paga dividendi che vanno oltre la riduzione del rischio. I clienti enterprise richiedono sempre più prove di un trattamento responsabile dei dati AI come condizione per fare affari. I regolatori che esaminano i programmi di governance AI valutano la sicurezza dei dati come componente fondamentale. E la disciplina organizzativa che produce una rigorosa valutazione della sicurezza degli strumenti di AI tende anche a produrre decisioni complessivamente migliori di selezione degli strumenti di AI, perché una valutazione focalizzata sulla sicurezza fa emergere la qualità del rapporto con il fornitore, la disponibilità di tutele contrattuali e la maturità operativa che predicono buone partnership con i fornitori oltre alla sola dimensione della sicurezza.

La sicurezza dei dati negli strumenti di AI non è l'ostacolo all'adozione produttiva dell'AI che le organizzazioni talvolta la trattano come tale. È la base che rende possibile un'adozione fiduciosa e scalabile dell'AI. Le aziende che riconoscono questa distinzione e integrano la valutazione della sicurezza nel loro processo di adozione degli strumenti di AI fin dall'inizio evitano gli incidenti, l'esposizione alla conformità e i costi di rimedio che rendono l'attenzione tardiva alla sicurezza molto più costosa della governance proattiva.

## **Domande frequenti**

### **Quale AI è la migliore per la sicurezza dei dati?**

**Gli strumenti di AI con le più forti posture di sicurezza dei dati per uso aziendale sono le implementazioni di livello enterprise di fornitori con certificazioni SOC 2 Type 2 attuali, accordi di trattamento dei dati disponibili, divieti espliciti sui dati di addestramento e chiari limiti di conservazione dei dati, con Microsoft Azure AI, AWS Bedrock e Google Cloud AI che soddisfano costantemente questi criteri per le organizzazioni con requisiti di conformità significativi.** Per le organizzazioni che richiedono la più forte garanzia possibile di sicurezza dei dati, i modelli open source ospitati internamente su infrastruttura privata eliminano completamente il rischio del trattamento dei dati lato fornitore garantendo che i dati non lascino mai l'infrastruttura dell'organizzazione stessa.

### **Come viene utilizzata l'AI nella sicurezza dei dati?**

**L'AI viene utilizzata nella sicurezza dei dati per alimentare sistemi di rilevamento delle minacce che identificano modelli di comportamento anomali nell'attività di rete e degli utenti, automatizzare la classificazione dei dati per attivare controlli di gestione appropriati al punto di creazione del contenuto, assistere gli analisti di sicurezza nel triage degli avvisi e nei flussi di lavoro investigativi, monitorare le comunicazioni e le transazioni per violazioni delle policy e rilevare potenziali tentativi di esfiltrazione di dati che i sistemi basati su regole non rilevano.** Queste applicazioni difensive dell'AI alla sicurezza rappresentano un miglioramento significativo della postura di sicurezza organizzativa quando vengono implementate insieme ai controlli di governance che gestiscono i rischi di sicurezza dei dati che gli strumenti di AI stessi introducono.

### **Cos'è la regola del 30% per l'AI?**

**La regola del 30% per l'AI è il principio secondo cui i sistemi di AI dovrebbero gestire approssimativamente il 30% di un flusso di lavoro in modo autonomo, in particolare le porzioni ad alta frequenza e ben definite in cui l'automazione offre chiari benefici di efficienza, mentre il giudizio e la responsabilità umani coprono il restante 70% che coinvolge decisioni con conseguenze significative, gestione di dati sensibili e output che comportano responsabilità organizzativa.** Applicato specificamente alla sicurezza dei dati degli strumenti di AI, questo principio aiuta le organizzazioni a identificare quali flussi di lavoro di elaborazione dei dati sono appropriati per l'automazione tramite strumenti di AI e quali richiedono la supervisione aggiuntiva, la selezione di strumenti più rigorosa o gli approcci di elaborazione alternativi che i dati a maggiore sensibilità richiedono.

### **Cosa sono gli strumenti di sicurezza AI?**

**Gli strumenti di sicurezza AI sono prodotti software che utilizzano tecniche di intelligenza artificiale e machine learning per migliorare le capacità di rilevamento, prevenzione e risposta del programma di sicurezza di un'organizzazione, comprese piattaforme di rilevamento delle minacce alimentate dall'AI, sistemi di analisi comportamentale, scanner automatizzati di vulnerabilità, sistemi intelligenti di gestione delle informazioni e degli eventi di sicurezza e piattaforme di risposta agli incidenti assistite dall'AI.** Sono distinti dalla questione della messa in sicurezza degli strumenti di AI, che riguarda le prassi di sicurezza dei dati per i sistemi di AI implementati nei flussi di lavoro aziendali, sebbene entrambe le dimensioni siano rilevanti per le organizzazioni con un'adozione matura dell'AI.

### **Quali sono i 5 tipi di strumenti AI?**

**Le cinque categorie principali di strumenti di AI in contesti aziendali sono gli strumenti di AI generativa che producono testo, codice, immagini e altri contenuti, gli strumenti di AI analitica che identificano pattern e intuizioni nei dati, gli strumenti di AI per l'automazione che eseguono flussi di lavoro definiti senza una direzione umana continua, gli strumenti di AI conversazionale che interagiscono con gli utenti attraverso interfacce in linguaggio naturale e gli strumenti di AI predittiva che prevedono i risultati in base a pattern storici.** Ogni categoria crea considerazioni di sicurezza dei dati distinte in base alla natura dei dati che elabora, all'infrastruttura su cui gira e agli output che produce, motivo per cui la valutazione della sicurezza dei dati degli strumenti di AI deve affrontare il profilo di rischio specifico di ciascuna categoria anziché trattare tutti gli strumenti di AI come se presentassero considerazioni di sicurezza equivalenti.
