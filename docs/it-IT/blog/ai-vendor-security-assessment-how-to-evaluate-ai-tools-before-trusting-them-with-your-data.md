---
title: "Valutazione della sicurezza dei fornitori AI: come valutare gli
  strumenti AI prima di affidare loro i Vostri dati"
date: 2026-04-05
description: Una valutazione della sicurezza dei fornitori AI verifica che gli
  strumenti AI soddisfino i Vostri standard di protezione dei dati, conformità e
  sicurezza prima della distribuzione. Ecco come eseguirla correttamente.
author: triggerfish
tags:
  - AI agent
draft: false
---
Una valutazione della sicurezza dei fornitori AI è un processo di valutazione strutturato che determina se uno strumento o una piattaforma di intelligenza artificiale soddisfa i requisiti di sicurezza, conformità e protezione dei dati di un'organizzazione prima che a tale fornitore venga concesso l'accesso ai dati organizzativi o sia integrato nei flussi di lavoro aziendali. Essa sostituisce le supposizioni con prove nel punto del processo di approvvigionamento in cui le conseguenze di un errore sono ancora gestibili.

La maggior parte delle organizzazioni dispone di processi di valutazione della sicurezza dei fornitori che funzionano ragionevolmente bene per il software convenzionale. Il fornitore compila un questionario. L'ufficio legale esamina il contratto. L'IT verifica le certificazioni. Lo strumento viene distribuito. Per i fornitori AI, tale processo trascura abbastanza da contare. Le domande che rivelano i rischi più significativi nelle relazioni con i fornitori AI non sono quelle presenti nei questionari standard per i fornitori IT. Sono domande sull'uso dei dati di addestramento dei modelli, sulla giurisdizione dell'infrastruttura di inferenza, su cosa accade ai dati quando una conversazione termina e sul fatto che la certificazione di sicurezza presentata dal fornitore copra il prodotto specifico in fase di distribuzione o un'altra parte della sua infrastruttura interamente diversa. Le organizzazioni che scoprono queste lacune dopo aver firmato i contratti e dopo che i dati sensibili sono già fluiti attraverso sistemi non adeguatamente valutati sono quelle che eseguono tale valutazione più accuratamente la seconda volta. Questa guida illustra come condurre una valutazione della sicurezza dei fornitori AI che colga ciò che conta, quali prove richiedere anziché accettare per affermazione, e come integrare il processo di valutazione in una capacità organizzativa ripetibile.



![AI agent](/blog/images/procurement.jpg)

## **Perché le valutazioni standard dei fornitori sono insufficienti per l'AI**

### **Le lacune che i questionari generici trascurano**

I questionari standard di sicurezza per fornitori IT sono stati sviluppati per un ambiente software in cui le principali preoccupazioni di sicurezza erano la sicurezza dello storage dei dati, i controlli di accesso e la protezione della rete. Tali preoccupazioni si applicano anche ai fornitori AI. Tuttavia, i sistemi AI introducono una serie di preoccupazioni aggiuntive che i questionari generici non sono stati progettati per far emergere e che i fornitori non rivelano spontaneamente se non specificamente interrogati.

L'uso dei dati di addestramento del modello è la prima lacuna. Se un fornitore utilizzi i dati inviati attraverso il suo prodotto per addestrare o migliorare i propri modelli AI è una delle questioni più rilevanti in materia di trattamento dei dati per le organizzazioni che elaborano informazioni proprietarie o sensibili attraverso strumenti AI. È anche una domanda che i questionari standard per fornitori non includono perché non ha equivalenti nell'approvvigionamento di software convenzionale. Un fornitore di database non addestra il proprio prodotto sui Vostri dati. Un fornitore AI potrebbe farlo, e se lo faccia o meno è spesso sepolto nel linguaggio dei termini di servizio invece di essere dichiarato in modo evidente.

La posizione dell'infrastruttura di inferenza è la seconda lacuna. Il luogo in cui un modello AI elabora fisicamente i Vostri dati determina quali quadri giuridici si applicano a tale elaborazione, se sono richiesti meccanismi di trasferimento transfrontaliero dei dati e quale processo legale di giurisdizione può imporre la divulgazione di tali dati. Le valutazioni standard dei fornitori chiedono dove i dati siano archiviati. Le valutazioni AI devono chiedere separatamente dove i dati vengano elaborati durante l'inferenza, che potrebbe essere un'infrastruttura diversa in una posizione diversa.

Il limite di portata delle certificazioni di sicurezza è la terza lacuna. Un fornitore può presentare un rapporto SOC 2 Type 2 che copre la sua infrastruttura cloud, mentre lo specifico prodotto AI valutato gira su un'infrastruttura diversa che non rientra nell'ambito dell'audit. Senza verificare che le certificazioni presentate coprano il prodotto e l'infrastruttura specifici rilevanti per la Vostra distribuzione, una revisione delle certificazioni può fornire una falsa fiducia su una distribuzione che non è mai stata esaminata.

Comprendere come i requisiti di valutazione della [AI security](https://trigger.fish/security/) differiscano dalla valutazione convenzionale della sicurezza dei fornitori aiuta le organizzazioni a costruire processi di valutazione che affrontino il panorama effettivo dei rischi AI invece del panorama convenzionale dei rischi software per cui tali processi erano originariamente progettati.



![AI agent](/blog/images/security-reviewing.jpg)

## **Costruire il quadro di valutazione della sicurezza dei fornitori AI**

### **I cinque domini che ogni valutazione deve coprire**

Una valutazione efficace della sicurezza dei fornitori AI organizza la sua valutazione su cinque domini che insieme forniscono un quadro completo della postura di sicurezza del fornitore per la specifica distribuzione in esame. Ogni dominio affronta una dimensione distinta del rischio che gli altri non coprono, motivo per cui le valutazioni che si concentrano su uno o due domini saltando il resto trascurano costantemente rischi materiali.

**Sicurezza tecnica** copre i controlli infrastrutturali che proteggono i dati elaborati dai sistemi AI del fornitore. Questo è il dominio che maggiormente si sovrappone alla valutazione convenzionale della sicurezza dei fornitori e copre gli standard di crittografia, l'architettura della sicurezza di rete, le pratiche di gestione delle vulnerabilità, le capacità di rilevamento e risposta agli incidenti e la sicurezza fisica dell'infrastruttura che esegue i carichi di lavoro AI.

**Governance dei dati** copre ciò che il fornitore fa con i dati organizzativi durante tutto il loro ciclo di vita nei suoi sistemi. Questo dominio include le politiche di utilizzo dei dati di addestramento, le pratiche di conservazione dei log di inferenza, le capacità e le tempistiche di cancellazione dei dati, le relazioni con i sub-responsabili e il loro accesso ai dati, i meccanismi di trasferimento transfrontaliero dei dati e le tutele contrattuali che disciplinano tutto quanto sopra.

**Conformità e certificazione** copre la verifica indipendente delle affermazioni di sicurezza del fornitore e i quadri normativi che il suo prodotto può supportare. Questo dominio include la revisione di documenti di certificazione specifici anziché l'accettazione delle dichiarazioni del fornitore, la verifica della portata e dell'attualità della certificazione, la valutazione della disponibilità degli accordi di trattamento dei dati richiesti e la conferma del supporto per i requisiti di conformità settoriali applicabili alla Vostra organizzazione.

**Sicurezza specifica dell'AI** copre i rischi unici dei sistemi AI che non hanno equivalenti nelle valutazioni convenzionali dei fornitori di software. Questo dominio include la suscettibilità alla prompt injection e i controlli di mitigazione, i test di robustezza avversaria, le protezioni contro l'estrazione del modello, i tassi di allucinazione e gli approcci di mitigazione per lo specifico caso d'uso in fase di distribuzione e l'approccio del fornitore agli aggiornamenti del modello e alla gestione del cambiamento comportamentale.

**Sicurezza operativa** copre le pratiche di sicurezza del fornitore come organizzazione anziché i controlli tecnici del suo prodotto specifico. Questo dominio include la struttura e l'esperienza del team di sicurezza, le pratiche di divulgazione della sicurezza e gestione delle vulnerabilità, i processi di notifica delle violazioni e il record storico degli incidenti e la sicurezza della propria supply chain del fornitore per i componenti e i servizi da cui dipende il suo prodotto AI.


<table>
  <thead>
    <tr>
      <th>Dominio di valutazione</th>
      <th>Domande principali</th>
      <th>Prove richieste</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Sicurezza tecnica</td>
      <td>Standard di crittografia, architettura di rete, gestione delle vulnerabilità</td>
      <td>Rapporto SOC 2 Type 2, riepiloghi dei penetration test</td>
    </tr>
    <tr>
      <td>Governance dei dati</td>
      <td>Uso dei dati di addestramento, periodi di conservazione, capacità di cancellazione, sub-responsabili</td>
      <td>Termini contrattuali, accordo sul trattamento dei dati, elenco dei sub-responsabili</td>
    </tr>
    <tr>
      <td>Conformità e certificazione</td>
      <td>Portata e attualità della certificazione, disponibilità degli accordi sui dati, supporto normativo</td>
      <td>Documenti di certificazione attuali, DPA o BAA firmato</td>
    </tr>
    <tr>
      <td>Sicurezza specifica dell'AI</td>
      <td>Controlli contro la prompt injection, robustezza avversaria, pratiche di aggiornamento del modello</td>
      <td>Documentazione tecnica, risultati dei test di sicurezza</td>
    </tr>
    <tr>
      <td>Sicurezza operativa</td>
      <td>Team di sicurezza, pratiche di divulgazione, cronologia degli incidenti, supply chain</td>
      <td>Divulgazioni di sicurezza, cronologia delle notifiche di incidenti</td>
    </tr>
  </tbody>
</table>



### **Lo standard probatorio che distingue la valutazione dall'accettazione**

La disciplina più importante nella valutazione della sicurezza dei fornitori AI è richiedere prove anziché accettare affermazioni. Le affermazioni di sicurezza del fornitore fatte in conversazioni di vendita, materiali di marketing e persino questionari compilati dal fornitore non sono dichiarazioni di fatto verificate in modo indipendente. Sono rappresentazioni la cui accuratezza dipende dalla valutazione del fornitore stesso della propria postura di sicurezza e dal suo incentivo commerciale a presentarla in modo favorevole.

La valutazione basata su prove richiede che ogni affermazione significativa in materia di sicurezza sia supportata da documentazione che una parte indipendente ha verificato o che l'organizzazione può verificare direttamente. Un fornitore che afferma la conformità SOC 2 dovrebbe produrre il rapporto SOC 2 effettivo, non un riepilogo o un badge. Il rapporto dovrebbe essere letto, non solo ricevuto, prestando attenzione al limite di portata, al periodo di audit, ai controlli specifici testati e a eventuali eccezioni o deviazioni rilevate. Un fornitore che afferma che il suo prodotto non utilizza dati dei clienti per l'addestramento del modello dovrebbe avere tale divieto documentato nei termini contrattuali che disciplineranno la relazione, non semplicemente dichiarato in una conversazione di vendita.

La disciplina di verifica si estende alle certificazioni stesse. I revisori SOC 2 variano in qualità e rigore. Un rapporto di audit di un'azienda riconosciuta con comprovata esperienza nel settore tecnologico fornisce prove più solide rispetto a uno di un'azienda sconosciuta con una storia limitata di audit tecnologici. Il periodo di rapporto è importante perché un rapporto che copre un periodo di audit molto breve può riflettere un primo audit progettato per ottenere rapidamente la certificazione anziché un programma di sicurezza maturo e sostenuto.

Esaminare come la documentazione dell'[AI architecture](https://trigger.fish/architecture/) dei fornitori descriva i loro controlli di sicurezza aiuta i valutatori a determinare se l'architettura tecnica presentata sia coerente e difendibile o se descriva la sicurezza a un livello di astrazione che nasconde lacune significative.

## **Le domande specifiche per l'AI che contano di più**

### **Cosa chiedere sull'uso dei dati di addestramento**

La questione dell'uso dei dati di addestramento richiede maggiore precisione di una risposta sì-o-no perché le pratiche che creano un rischio significativo sono più specifiche di quanto colga la domanda generale. Un fornitore che risponde di non utilizzare i dati dei clienti per l'addestramento potrebbe intendere qualcosa di più ristretto di quanto la domanda implichi.

Chiedete se i contenuti delle conversazioni, inclusi sia i prompt che le risposte, vengano utilizzati per l'addestramento o il fine-tuning del modello in qualsiasi circostanza, incluso il consenso del cliente ottenuto tramite termini di servizio. Chiedete se versioni aggregate o anonimizzate dei dati dei clienti contribuiscano al miglioramento del modello. Chiedete se il divieto si applichi a tutti i livelli di prodotto o solo al livello enterprise in fase di valutazione. Chiedete se il divieto sia assoluto o se possa essere revocato per accordo del cliente. E chiedete come il divieto venga applicato tecnicamente, non solo contrattualmente, poiché un divieto contrattuale non applicato tecnicamente dipende interamente dalla conformità operativa del fornitore anziché da garanzie architetturali.

Le risposte a queste domande specifiche di approfondimento spesso rivelano che le pratiche di utilizzo dei dati di addestramento sono più sfumate di quanto suggeriscano le dichiarazioni iniziali del fornitore, e che le protezioni disponibili al livello enterprise che l'organizzazione sta valutando possono differire dai termini standard del prodotto in modi rilevanti per lo specifico caso d'uso in fase di valutazione.

### **Cosa chiedere sull'infrastruttura di inferenza e sulla residenza dei dati**

La questione dell'infrastruttura per i sistemi AI richiede di chiedere separatamente dove vengano archiviati i pesi del modello, dove avvenga computazionalmente l'inferenza, dove vengano elaborati i dati di input, dove vengano archiviati i dati di output e i log e dove ciascuno di questi avvenga nel contesto dello specifico livello di prodotto in fase di distribuzione anziché dell'infrastruttura del fornitore in generale.

Per le organizzazioni con obblighi di residenza dei dati, la questione della posizione dell'inferenza è spesso più immediatamente rilevante della questione della posizione dello storage, perché i quadri normativi che impongono requisiti di residenza nella maggior parte delle giurisdizioni trattano la giurisdizione di elaborazione in modo equivalente alla giurisdizione di archiviazione. Un fornitore la cui infrastruttura di storage è situata nella giurisdizione richiesta ma la cui elaborazione di inferenza avviene altrove non ha soddisfatto il requisito di residenza anche se i controlli sullo storage sono pienamente conformi.

Chiedete al fornitore di fornire un diagramma di flusso dei dati che tracci i dati organizzativi dall'invio attraverso l'inferenza, l'output, la registrazione fino alla cancellazione, con la posizione fisica di ciascuna fase chiaramente indicata. Se il fornitore non può produrre questa documentazione, la lacuna nella sua stessa comprensione dei propri flussi di dati è essa stessa una constatazione di sicurezza significativa.



![AI agent](/blog/images/security-team-review.jpg)

### **Cosa chiedere sugli aggiornamenti del modello e sul cambiamento comportamentale**

I fornitori AI aggiornano i loro modelli sottostanti secondo calendari non sempre comunicati ai clienti in anticipo. Un aggiornamento del modello può modificare il comportamento di un sistema AI in modi che influenzano la sua postura di sicurezza, la sua conformità ai requisiti di utilizzo accettabile del cliente o la sua qualità di output per lo specifico caso d'uso per cui il cliente l'ha distribuito.

Chiedete come il fornitore notifichi ai clienti gli aggiornamenti del modello che influenzano il comportamento rilevante per la sicurezza o la conformità. Chiedete se i clienti enterprise abbiano l'opzione di rimanere su una specifica versione del modello anziché ricevere aggiornamenti automatici. Chiedete come il fornitore testi gli aggiornamenti del modello per regressioni di sicurezza prima di distribuirli negli ambienti dei clienti. E chiedete quale sia il rimedio del cliente se un aggiornamento del modello modifica il comportamento in modi che influenzano la conformità o la sicurezza nella distribuzione del cliente.

Le risposte rivelano il grado di controllo che l'organizzazione avrà su una componente fondamentale del suo sistema AI distribuito e la filosofia del fornitore in merito alla partecipazione del cliente al ciclo di vita del modello. Le organizzazioni i cui sistemi AI distribuiti sono utilizzati in contesti regolamentati o nel supporto decisionale ad alta criticità hanno interessi più forti nella stabilità del modello e nella notifica degli aggiornamenti rispetto a quelle che utilizzano l'AI per applicazioni di produttività a minore criticità.

## **Tutele contrattuali che la valutazione deve stabilire**

### **Gli accordi che devono essere in vigore prima che i dati fluiscano**

La fase contrattuale di una valutazione della sicurezza dei fornitori AI traduce le constatazioni tecniche e di governance in tutele legalmente applicabili. I controlli tecnici proteggono i dati sull'infrastruttura del fornitore. Le tutele contrattuali definiscono gli obblighi legali che disciplinano il modo in cui tale infrastruttura viene operata e quali rimedi l'organizzazione ha quando gli obblighi non sono rispettati.

Un accordo sul trattamento dei dati che copra lo specifico prodotto AI in fase di distribuzione è il requisito contrattuale fondamentale per qualsiasi fornitore che tratti dati personali soggetti al GDPR, al CCPA o a quadri equivalenti. Il DPA deve affrontare esplicitamente il divieto di utilizzo dei dati di addestramento, i limiti di conservazione dei dati per categoria, gli obblighi di gestione dei sub-responsabili, le tempistiche di cancellazione dei dati e i requisiti di notifica delle violazioni. Un modello di DPA del fornitore redatto per servizi cloud generici potrebbe non affrontare adeguatamente le considerazioni specifiche dell'AI che la valutazione ha identificato come rilevanti.

Per le organizzazioni sanitarie, un Business Associate Agreement è un prerequisito legale prima che qualsiasi dato che possa costituire informazioni sanitarie protette fluisca attraverso il sistema AI del fornitore. Il BAA deve coprire lo specifico prodotto in fase di distribuzione, non solo l'infrastruttura del fornitore in generale, e deve confermare che le pratiche di trattamento dei dati del prodotto AI siano coerenti con i requisiti di salvaguardia tecnica HIPAA.

Comprendere come gli [AI features](https://trigger.fish/features/) nelle piattaforme AI enterprise siano strutturati rispetto alle tutele contrattuali in fase di negoziazione aiuta le organizzazioni a identificare dove il comportamento del prodotto e i termini contrattuali siano coerenti e dove la realtà tecnica del prodotto richieda una specificità contrattuale aggiuntiva per raggiungere la protezione richiesta dall'organizzazione.


<table>
  <thead>
    <tr>
      <th>Accordo richiesto</th>
      <th>Quando si applica</th>
      <th>Termini critici per l'AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Accordo sul trattamento dei dati</td>
      <td>Qualsiasi trattamento di dati personali ai sensi del GDPR o equivalente</td>
      <td>Divieto di utilizzo dei dati di addestramento, limiti di conservazione, elenco dei sub-responsabili</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Qualsiasi trattamento di PHI ai sensi dell'HIPAA</td>
      <td>Copertura specifica del prodotto, conferma delle salvaguardie tecniche</td>
    </tr>
    <tr>
      <td>Master Services Agreement</td>
      <td>Tutte le relazioni commerciali con i fornitori</td>
      <td>Ripartizione della responsabilità, rimedi per le violazioni, restituzione dei dati alla cessazione</td>
    </tr>
    <tr>
      <td>Addendum di sicurezza</td>
      <td>Contesti di trattamento dei dati ad alta sensibilità</td>
      <td>Obblighi di sicurezza specifici oltre i termini standard</td>
    </tr>
    <tr>
      <td>Documentazione sul rischio del modello</td>
      <td>AI in attività finanziarie regolamentate</td>
      <td>Documentazione del modello, diritti di convalida, notifica degli aggiornamenti</td>
    </tr>
    <tr>
      <td>Accordo di riservatezza</td>
      <td>Processo di valutazione stesso e constatazioni sensibili</td>
      <td>Portata che copre la metodologia di valutazione e i requisiti organizzativi</td>
    </tr>
  </tbody>
</table>



### **Negoziare oltre i termini standard**

La maggior parte degli accordi con fornitori AI enterprise inizia con termini standard redatti a favore del fornitore. Il processo di valutazione dovrebbe identificare i termini specifici che richiedono modifica in base alle constatazioni di sicurezza e ai requisiti di conformità dell'organizzazione, anziché negoziare contro i termini standard nella loro interezza senza prioritizzazione.

I termini con la più alta priorità di negoziazione sono quelli che influenzano più direttamente i rischi di sicurezza e conformità identificati dalla valutazione. Clausole di utilizzo dei dati di addestramento che consentono un uso che l'organizzazione necessita di proibire. Limitazioni di responsabilità insufficienti per le categorie di dati trattati. Tempistiche di notifica delle violazioni che non soddisfano i requisiti normativi. Diritti di approvazione dei sub-responsabili che concedono al fornitore maggiore flessibilità per modificare la propria infrastruttura di quanto i requisiti di conformità dell'organizzazione possano accomodare.

Le organizzazioni con una significativa leva di approvvigionamento, sia per dimensioni dell'accordo, valore del marchio o posizione di mercato, ottengono spesso miglioramenti significativi ai termini standard dei fornitori AI esattamente su questi punti perché i fornitori apprezzano sufficientemente la relazione da accomodare requisiti che vanno oltre il loro modello standard. Le organizzazioni con leva limitata possono talvolta raggiungere lo stesso risultato inquadrando i requisiti in termini di necessità normativa anziché di preferenza, poiché i fornitori hanno interessi commerciali nel supportare distribuzioni conformi che si estendono oltre qualsiasi singola relazione con il cliente.

Un'approfondita [AI guide](https://trigger.fish/guide/) sulla strutturazione di accordi con fornitori AI per sicurezza e conformità aiuta le organizzazioni a costruire quadri di negoziazione che prioritizzino i termini che influenzano maggiormente la loro effettiva esposizione al rischio, anziché tentare di negoziare ogni clausola con uguale intensità.

## **Integrare la valutazione in un processo ripetibile**

### **Il flusso di lavoro di valutazione che scala**

Le organizzazioni che conducono valutazioni della sicurezza dei fornitori AI come progetti una tantum per ogni approvvigionamento AI significativo costruiscono conoscenza istituzionale che non si trasferisce in modo efficiente alle valutazioni successive. Le organizzazioni che costruiscono la valutazione come processo ripetibile con metodologia documentata, modelli probatori standard e criteri decisionali definiti sviluppano una capacità che rende ogni valutazione più rapida e coerente della precedente.

Un processo ripetibile di valutazione della sicurezza dei fornitori AI include un questionario standardizzato sviluppato specificamente per i fornitori AI che copre i cinque domini di valutazione, un elenco di richieste di documenti che specifica le prove esatte richieste per ogni rivendicazione di sicurezza importante, un quadro di valutazione o decisionale che traduce le constatazioni di valutazione in raccomandazioni di distribuzione, un processo di revisione che coinvolge i giusti stakeholder attraverso le funzioni di sicurezza, legale, conformità e business, e uno standard di documentazione che produce registrazioni utili sia per la governance interna che per l'esame regolamentare esterno.

Il questionario e l'elenco di richieste di documenti dovrebbero essere rivisti e aggiornati almeno annualmente per incorporare nuove considerazioni di sicurezza specifiche dell'AI emerse dal panorama dei fornitori, dall'ambiente normativo e dall'esperienza di distribuzione dell'organizzazione stessa. Lo strumento di valutazione che era completo dodici mesi fa potrebbe avere lacune significative oggi mentre il panorama delle minacce alla sicurezza AI e le aspettative normative al riguardo continuano a svilupparsi.

### **Valutazione continua oltre l'approvvigionamento iniziale**

Una valutazione della sicurezza dei fornitori AI condotta al momento dell'approvvigionamento fornisce una valutazione puntuale della postura di sicurezza del fornitore. Non fornisce alcuna garanzia continua che la postura rimanga adeguata mentre il prodotto del fornitore evolve, la sua infrastruttura cambia, la sua proprietà o situazione finanziaria si sposta o emergono nuove vulnerabilità di sicurezza nel suo stack tecnologico.

La valutazione continua per fornitori AI significativi dovrebbe includere la revisione annuale di certificazioni aggiornate e documentazione di sicurezza, la revisione di eventuali divulgazioni di incidenti di sicurezza o notifiche di violazione del fornitore, la valutazione di modifiche sostanziali ai termini di servizio o alle politiche sulla privacy del fornitore che influenzano le pratiche di trattamento dei dati valutate nella valutazione iniziale, e la revisione di eventuali modifiche significative al prodotto AI del fornitore, all'infrastruttura o alla proprietà che potrebbero influenzare le ipotesi di sicurezza sottostanti alla valutazione iniziale.

Le organizzazioni che trattano la valutazione della sicurezza dei fornitori AI come un punto di controllo di approvvigionamento anziché una pratica continua di gestione delle relazioni accumulano la graduale deriva tra le loro ipotesi di sicurezza documentate e l'effettiva postura di sicurezza del fornitore che rende la scoperta degli incidenti così costosa rispetto al monitoraggio proattivo.

## **Cose da sapere**

Diverse realtà importanti sulla valutazione della sicurezza dei fornitori AI che le organizzazioni incontrano costantemente man mano che i loro programmi maturano:

La portata della valutazione deve corrispondere esattamente alla portata della distribuzione. Una valutazione di sicurezza che copre l'API enterprise di un fornitore non fornisce garanzie sul prodotto consumer del fornitore. Una valutazione che copre il prodotto di generazione di testo di un fornitore non copre il suo prodotto di generazione di immagini anche se entrambi portano lo stesso marchio. Definite il prodotto specifico, il livello e la configurazione di distribuzione in fase di valutazione e confermate che ogni certificazione e tutela contrattuale esaminata copra tale specifica portata.

Le conversazioni con clienti di riferimento integrano la revisione dei documenti in modi che la documentazione non può replicare. Parlare con organizzazioni di dimensioni, settore e profilo normativo simili che hanno distribuito lo stesso prodotto AI del fornitore fornisce intuizioni qualitative sulla reattività del fornitore, sulle pratiche effettive di trattamento dei dati rispetto a quelle documentate e sull'esperienza pratica di operare la relazione con il fornitore che nessuna revisione di documenti può catturare.

La stabilità finanziaria del fornitore è una legittima dimensione di valutazione della sicurezza. Un fornitore AI che cessa le operazioni crea sfide di portabilità dei dati, cancellazione e tracciabilità di audit che possono diventare problemi di conformità. Valutare la salute finanziaria, l'orizzonte di finanziamento e la posizione di mercato del fornitore è appropriato per i fornitori AI in considerazione per distribuzioni di produzione significative, in particolare quelle in cui i dati estratti o addestrati creano dipendenze continue.

Il principio del 30% si applica all'allocazione dello sforzo di valutazione. Circa il 30% dello sforzo di valutazione dovrebbe andare al dominio della sicurezza tecnica in cui i processi di valutazione comunemente sovrainvestono rispetto al suo effettivo contributo al rischio. Il restante 70% dovrebbe coprire la governance dei dati, le tutele contrattuali, i rischi specifici dell'AI e le dimensioni della sicurezza operativa che rivelano i differenziatori più significativi tra fornitori le cui certificazioni appaiono simili in superficie.

Le constatazioni della valutazione devono essere comunicate agli stakeholder aziendali in termini di rischio anziché in linguaggio tecnico. Una constatazione che l'ambito dell'audit SOC 2 di un fornitore esclude l'infrastruttura di inferenza AI è tecnicamente accurata ma non azionabile per i decisori aziendali senza traduzione in termini di rischio aziendale. La constatazione che il fornitore non ha verificato in modo indipendente la sicurezza dei sistemi che elaboreranno i Vostri dati più sensibili è la stessa constatazione in un linguaggio che produce decisioni.

I trigger di rivalutazione devono essere definiti in anticipo. Eventi specifici che dovrebbero attivare una valutazione fresca o parziale della sicurezza del fornitore AI, inclusi incidenti significativi del fornitore, modifiche sostanziali ai termini di servizio, acquisizioni o cambiamenti di proprietà del fornitore e modifiche significative all'architettura del prodotto, dovrebbero essere definiti nel processo di valutazione anziché determinati ad hoc quando tali eventi si verificano.

## **La valutazione della sicurezza dei fornitori AI come strumento di selezione competitiva**

Le organizzazioni che conducono valutazioni approfondite della sicurezza dei fornitori AI scoprono costantemente che il processo fa più che identificare fornitori inaccettabili. Esso rivela differenziazioni significative tra fornitori le cui certificazioni e marketing appaiono simili ma le cui pratiche di sicurezza effettive differiscono significativamente quando esaminate al livello delle prove anziché delle affermazioni.

Tale differenziazione è commercialmente utile oltre il suo valore di gestione del rischio. I fornitori che investono in un'autentica infrastruttura di sicurezza, mantengono certificazioni attuali e complete, operano pratiche trasparenti di trattamento dei dati e supportano le tutele contrattuali richieste dalle organizzazioni regolamentate hanno reso la sicurezza un asset competitivo anziché un costo di conformità. Identificare tali fornitori attraverso una valutazione rigorosa e costruire relazioni durature con essi produce risultati di approvvigionamento il cui valore si compone mentre il panorama degli strumenti AI continua a evolvere e i requisiti di sicurezza continuano a inasprirsi.

La valutazione della sicurezza dei fornitori AI è il punto in cui l'impegno per un'adozione responsabile dell'AI incontra la realtà operativa di scegliere a chi affidare i dati che contano di più. Le organizzazioni che fanno questo lavoro a fondo, in modo coerente e con gli standard probatori che merita costruiscono relazioni con i fornitori che supportano le loro ambizioni AI anziché creare le passività non scoperte che una valutazione inadeguata inevitabilmente lascia dietro di sé.

## **Domande frequenti**

### **Come valutare i fornitori AI?**

**Valutare i fornitori AI richiede una valutazione strutturata attraverso cinque domini: controlli di sicurezza tecnica verificati attraverso documenti di certificazione attuali, pratiche di governance dei dati che coprono l'uso dei dati di addestramento e la conservazione verificate attraverso termini contrattuali, portata e attualità della certificazione di conformità verificate attraverso rapporti effettivi anziché dichiarazioni del fornitore, considerazioni di sicurezza specifiche dell'AI inclusi i controlli contro la prompt injection e le pratiche di aggiornamento del modello, e sicurezza operativa che copre le pratiche di sicurezza organizzativa del fornitore e la cronologia degli incidenti.** La valutazione produce decisioni di distribuzione basate su prove anziché su affermazioni del fornitore, con tutele contrattuali stabilite prima che qualsiasi dato organizzativo fluisca attraverso il sistema del fornitore.

### **Cos'è la valutazione di sicurezza che utilizza l'AI?**

**Una valutazione di sicurezza che utilizza l'AI si riferisce all'applicazione di strumenti di intelligenza artificiale per migliorare l'efficienza e la copertura dei processi di valutazione della sicurezza, incluso l'uso dell'AI per analizzare la documentazione del fornitore alla ricerca di clausole rilevanti per la sicurezza, automatizzare l'analisi delle risposte ai questionari attraverso più invii del fornitore, monitorare continuamente le divulgazioni di sicurezza e le notifiche di incidenti del fornitore e identificare modelli nei dati sulla postura di sicurezza del fornitore che i processi di revisione manuali mancherebbero.** È distinta dalla valutazione della sicurezza dei fornitori AI, che valuta la sicurezza degli strumenti AI stessi, sebbene le organizzazioni con programmi di sicurezza maturi utilizzino sempre più l'AI per migliorare sia i loro processi di valutazione dei fornitori AI sia le loro più ampie capacità di valutazione della sicurezza.

### **Cos'è una valutazione della sicurezza del fornitore?**

**Una valutazione della sicurezza del fornitore è una valutazione strutturata dei controlli di sicurezza, delle pratiche di trattamento dei dati, delle certificazioni di conformità e delle tutele contrattuali di un fornitore di tecnologia di terze parti prima che a tale fornitore venga concesso l'accesso ai dati organizzativi o sia integrato nei sistemi aziendali.** Per i fornitori AI in particolare, la valutazione si estende oltre la valutazione convenzionale della sicurezza del fornitore per affrontare i rischi specifici dell'AI dell'uso dei dati di addestramento, della giurisdizione dell'infrastruttura di inferenza, delle pratiche di aggiornamento del modello e delle superfici di attacco specifiche dell'AI che i questionari standard per fornitori IT non erano progettati per far emergere.

### **Quali misure possono essere messe in atto per garantire che un fornitore AI sia sicuro?**

**Le cinque misure più importanti per garantire che un fornitore AI sia sicuro sono: richiedere documenti di certificazione SOC 2 Type 2 attuali o equivalenti che coprano lo specifico prodotto e infrastruttura in fase di distribuzione, ottenere accordi sul trattamento dei dati firmati con espliciti divieti sui dati di addestramento e limiti di conservazione definiti prima che qualsiasi dato organizzativo sia elaborato, verificare che l'infrastruttura di inferenza sia situata in giurisdizioni che soddisfano i requisiti applicabili di residenza dei dati, confermare attraverso termini contrattuali e documentazione tecnica che i controlli di sicurezza del fornitore affrontino i rischi specifici dell'AI inclusi prompt injection ed estrazione del modello, e stabilire un processo di monitoraggio continuo del fornitore che riesamini i rinnovi delle certificazioni, le divulgazioni di incidenti e le modifiche sostanziali ai termini di servizio in un ciclo annuale definito.** Insieme queste misure creano una relazione di sicurezza con il fornitore AI basata su prove verificate e obblighi applicabili anziché su affermazioni non verificate e presunta buona fede.

### **Quali sono le 5 misure di sicurezza?**

**Le cinque misure di sicurezza fondamentali che si applicano attraverso le relazioni con i fornitori AI sono: crittografia dei dati in transito e a riposo utilizzando standard attuali con pratiche documentate di gestione delle chiavi, controlli di accesso che limitano chi nell'organizzazione del fornitore può accedere ai dati organizzativi e in quali condizioni, registrazione completa di tutti gli eventi di accesso ed elaborazione dei dati con periodi di conservazione che supportano l'indagine sugli incidenti, pratiche di gestione delle vulnerabilità inclusi test di sicurezza regolari e tempistiche di rimedio definite per le vulnerabilità identificate, e processi di notifica delle violazioni che impegnano il fornitore a una divulgazione tempestiva con tempistiche specifiche che soddisfino gli obblighi di notifica normativa dell'organizzazione.** Queste cinque misure rappresentano la base di sicurezza tecnica che dovrebbe essere verificata attraverso prove per ogni fornitore AI valutato per responsabilità significative di trattamento dei dati, con le dimensioni di valutazione specifiche dell'AI sovrapposte a questa base di sicurezza convenzionale.
