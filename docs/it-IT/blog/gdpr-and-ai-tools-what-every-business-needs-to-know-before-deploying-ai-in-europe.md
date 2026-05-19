---
title: "GDPR e strumenti di AI: cosa ogni azienda deve sapere prima di implementare
  l'AI in Europa"
date: 2026-03-03
description: GDPR e strumenti di AI si incontrano sui temi del trattamento dei dati,
  del consenso e delle decisioni automatizzate. Ecco cosa le aziende devono comprendere
  per restare conformi quando implementano l'AI in Europa.
author: triggerfish
tags:
  - AI agent
draft: false
---



GDPR e strumenti di AI si incontrano in un punto critico per qualsiasi organizzazione che tratti dati personali di residenti europei utilizzando sistemi di intelligenza artificiale. Il regolamento si applica integralmente alle implementazioni di AI: ciò significa che ogni strumento che raccoglie, tratta o agisce su dati personali deve soddisfare i requisiti del GDPR in materia di base giuridica, trasparenza e minimizzazione dei dati, pena il rischio di gravi azioni esecutive.

Numerose organizzazioni hanno adottato rapidamente l'AI senza fermarsi a chiedersi se i loro nuovi strumenti siano effettivamente legittimi secondo la normativa europea sulla protezione dei dati. La risposta non è sempre confortevole. L'AI introduce attività di trattamento dei dati che il GDPR non era stato originariamente scritto per affrontare, ma che rientrano comunque nel suo quadro esistente. Profilazione automatizzata, trattamento su larga scala di dati personali, trasferimenti transfrontalieri di dati innescati dall'infrastruttura cloud per l'AI e sistemi decisionali opachi rientrano tutti pienamente nell'ambito normativo del GDPR. Comprendere con precisione dove ricadono gli obblighi e come costruire implementazioni di AI che li soddisfino non è più facoltativo per le aziende che operano o vendono nei mercati europei. Questa guida illustra cosa richiede effettivamente la conformità e dove la maggior parte dei team tende a sbagliare.



![Ai agent](/blog/images/flag.jpg)

## **Perché il GDPR si applica agli strumenti di AI in modo più ampio di quanto la maggior parte dei team immagini**

### **Ogni interazione con l'AI che coinvolge dati personali è un evento di trattamento**

Il GDPR definisce il trattamento dei dati in modo ampio. Qualsiasi operazione effettuata su dati personali, compresi raccolta, conservazione, recupero, utilizzo, divulgazione e cancellazione, rientra nell'ambito del regolamento. Quando uno strumento di AI riceve un nome, un indirizzo email, un modello comportamentale, una registrazione vocale o qualsiasi altra informazione relativa a una persona identificabile, sta trattando dati personali secondo la definizione del GDPR dal momento in cui tali dati entrano nel sistema.

Ciò coglie molte organizzazioni di sorpresa, perché il modello mentale intuitivo della conformità al GDPR ruota attorno a database e archiviazione. Se conserva i dati dei clienti, rispetta le regole sull'archiviazione. Ma il trattamento da parte dell'AI è trattamento, indipendentemente dal fatto che qualcosa venga conservato in modo permanente. Uno strumento di AI che analizza la trascrizione di un servizio clienti per classificarne il sentiment e poi scarta immediatamente la trascrizione ha comunque trattato dati personali. La base giuridica per farlo, e gli obblighi di trasparenza che ne derivano, si applicano a quella interazione.

L'implicazione pratica è che la sua valutazione di conformità al GDPR non può fermarsi ai database e ai sistemi CRM. Ogni strumento di AI utilizzato dalla sua organizzazione deve essere valutato per stabilire quali dati personali tratta, su quale base giuridica e a quali condizioni.

### **Il problema della base giuridica con gli strumenti di AI**

Il GDPR richiede che ogni attività di trattamento che coinvolga dati personali abbia una base giuridica valida. Le sei basi disponibili sono consenso, esecuzione di un contratto, obbligo legale, interessi vitali, compito di interesse pubblico e legittimo interesse. Per la maggior parte delle implementazioni commerciali di AI, le opzioni rilevanti sono consenso, esecuzione di un contratto e legittimo interesse.

La difficoltà con gli strumenti di AI è che le attività di trattamento che svolgono sono spesso difficili da descrivere in modo sufficientemente specifico da soddisfare i requisiti di trasparenza del GDPR per il consenso o per il bilanciamento del legittimo interesse. Dire agli utenti che i loro dati saranno trattati da sistemi di AI per il miglioramento del servizio non è sufficientemente specifico. Spiegare esattamente quali dati confluiscono in quale sistema di AI, per quale finalità, con quale periodo di conservazione, con quali responsabili del trattamento sono condivisi e per influenzare quali decisioni sono utilizzati: questo è ciò che il regolamento effettivamente richiede.

Le organizzazioni che non hanno mappato in dettaglio i propri flussi di dati di AI non possono soddisfare questo requisito perché, in realtà, non sanno cosa stanno divulgando. Il lavoro di conformità e il lavoro di trasparenza sono lo stesso lavoro.


<table>
  <thead>
    <tr>
      <th>Base giuridica</th>
      <th>Quando si applica all'AI</th>
      <th>Requisito chiave</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Consenso</td>
      <td>Trattamento di AI non necessario al servizio, chiaramente facoltativo</td>
      <td>Liberamente prestato, specifico, informato, inequivocabile</td>
    </tr>
    <tr>
      <td>Esecuzione del contratto</td>
      <td>AI direttamente necessaria per erogare un servizio contrattualizzato</td>
      <td>Trattamento limitato a quanto richiesto dal contratto</td>
    </tr>
    <tr>
      <td>Legittimo interesse</td>
      <td>Esiste un beneficio aziendale e non prevale sui diritti individuali</td>
      <td>Valutazione del legittimo interesse documentata</td>
    </tr>
    <tr>
      <td>Obbligo legale</td>
      <td>AI utilizzata per adempiere a un requisito di legge</td>
      <td>L'obbligo legale specifico deve esistere ed essere documentato</td>
    </tr>
    <tr>
      <td>Compito di interesse pubblico</td>
      <td>Autorità pubbliche e organizzazioni con mandato pubblico</td>
      <td>Deve essere fondato sul diritto dell'Unione o di uno Stato membro</td>
    </tr>
  </tbody>
</table>



Allineare per tempo, durante l'implementazione, la documentazione di [AI security](https://trigger.fish/security/) con la base giuridica evita la situazione in cui un sistema di AI tecnicamente sicuro funziona su fondamenta giuridicamente fragili.



![AI agent](/blog/images/legal-compliance.jpg)

## **Cosa significano le modifiche al GDPR specificamente per l'AI**

### **L'interpretazione normativa in evoluzione**

Il GDPR è stato finalizzato nel 2016 ed è entrato in vigore nel 2018, precedendo di diversi anni l'attuale generazione di Large Language Models. Il testo del regolamento non menziona AI generativa, Foundation Models o pipeline di inferenza. Ciò che contiene è un quadro basato su principi sufficientemente ampio da catturare queste tecnologie, e le autorità di protezione dei dati di tutti gli Stati membri dell'UE hanno costantemente emesso linee guida che chiariscono come tali principi si applichino.

L'azione di enforcement dell'autorità italiana per la protezione dei dati nei confronti di ChatGPT nel 2023 è stata il segnale più chiaro che i regolatori erano pronti ad agire sulle problematiche del GDPR specifiche per l'AI. L'azione si è concentrata sull'assenza in OpenAI di una chiara base giuridica per il trattamento dei dati degli utenti italiani, sull'assenza di meccanismi di verifica dell'età e su una trasparenza insufficiente in merito a come i dati personali venissero utilizzati nell'addestramento dei modelli. Lo strumento è stato temporaneamente sospeso in Italia e ripristinato solo dopo che OpenAI ha apportato specifiche modifiche di conformità.

Da allora, altre autorità nazionali di protezione dei dati nell'UE hanno emesso linee guida che affrontano i dati di addestramento dell'AI, il processo decisionale automatizzato e le condizioni in cui gli output generati dall'AI costituiscono trattamento di dati personali relativi alle persone i cui dati sono stati utilizzati per addestrare il modello.

La direzione di marcia è chiara. L'enforcement del GDPR si sta spostando sempre più nel territorio specifico dell'AI, e le organizzazioni che hanno trattato la conformità dell'AI come un problema futuro stanno scoprendo che è diventato un problema presente.

### **Come l'EU AI Act si sovrappone al GDPR**

L'EU AI Act, entrato in vigore nel 2024, aggiunge un livello normativo parallelo che opera accanto al GDPR senza sostituirlo. Mentre il GDPR disciplina cosa accade ai dati personali, l'AI Act disciplina le caratteristiche e il comportamento dei sistemi di AI stessi, in particolare di quelli classificati come ad alto rischio.

Per le aziende che implementano strumenti di AI che interagiscono con dati personali, entrambi i quadri normativi si applicano simultaneamente. Un sistema di AI utilizzato nello screening dei candidati, nella valutazione del merito creditizio o nel triage sanitario è soggetto ai requisiti dell'AI Act in materia di trasparenza, supervisione umana e accuratezza, ed è al tempo stesso soggetto ai requisiti del GDPR per ogni singolo dato personale che tratta.

Comprendere in che modo le decisioni relative all'[AI architecture](https://trigger.fish/architecture/) influiscono sulla conformità in entrambi i quadri aiuta le organizzazioni a progettare sistemi che soddisfino l'intero quadro normativo, anziché ottimizzare per una norma a scapito dell'altra.

## **Articolo 22 e processo decisionale automatizzato**

### **Cosa proibisce effettivamente l'articolo 22**

L'articolo 22 del GDPR riconosce alle persone il diritto di non essere sottoposte a decisioni basate unicamente su un trattamento automatizzato, compresa la profilazione, che producano effetti giuridici o significativamente analoghi su di loro. È una delle disposizioni del regolamento più direttamente rilevanti per l'AI e una delle più frequentemente fraintese.

Il divieto non riguarda l'uso dell'AI nei processi decisionali. Riguarda specificamente le decisioni assunte unicamente da sistemi automatizzati in cui nessun essere umano riesamina in modo significativo l'esito prima che incida sull'interessato. Un'AI di credit scoring che genera una raccomandazione che un funzionario umano del credito esamina e poi conferma o sovrascrive non fa scattare l'articolo 22. Un sistema che approva o respinge automaticamente le richieste di finanziamento sulla base dell'output algoritmico senza alcun intervento umano nel ciclo decisionale, sì.

Per gli strumenti di AI utilizzati in HR, segmentazione della clientela, rilevamento delle frodi e contesti analoghi, l'analisi ai sensi dell'articolo 22 è essenziale. Se il suo strumento di AI prende decisioni che influiscono sull'accesso delle persone a servizi, opportunità di lavoro o prodotti finanziari, e nessun essere umano riesamina effettivamente tali decisioni prima che diventino effettive, ha un problema di conformità all'articolo 22.

Le tre eccezioni all'articolo 22 sono la necessità contrattuale, il consenso esplicito e l'autorizzazione di legge. Ciascuna richiede condizioni aggiuntive specifiche, compresi il diritto al riesame umano, il diritto di contestare la decisione e il diritto di ottenere una spiegazione della logica utilizzata.


<table>
  <thead>
    <tr>
      <th>Tipo di decisione automatizzata</th>
      <th>Articolo 22 attivato?</th>
      <th>Percorso di conformità</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Raccomandazione dell'AI riesaminata da un essere umano prima dell'azione</td>
      <td>No</td>
      <td>Si applicano i normali obblighi di trattamento del GDPR</td>
    </tr>
    <tr>
      <td>Approvazione o rifiuto completamente automatizzati con effetto giuridico</td>
      <td>Sì</td>
      <td>Necessario basarsi su un'eccezione con diritto al riesame umano</td>
    </tr>
    <tr>
      <td>Profilazione automatizzata utilizzata per segmentare liste di marketing</td>
      <td>Dipende dalla significatività</td>
      <td>Valutare se gli effetti sono giuridicamente significativi</td>
    </tr>
    <tr>
      <td>Punteggio di contenuto generato dall'AI che influenza una decisione di assunzione</td>
      <td>Sì</td>
      <td>Eccezione contrattuale o di consenso più riesame umano</td>
    </tr>
    <tr>
      <td>Segnalazione di frode che richiede un'indagine umana prima dell'azione sull'account</td>
      <td>No</td>
      <td>Il riesame umano interrompe la catena puramente automatizzata</td>
    </tr>
  </tbody>
</table>



Esaminare le [AI features](https://trigger.fish/features/) negli strumenti che sta valutando di implementare aiuta a individuare quali integrano punti di controllo umani significativi e quali instradano le decisioni in modo automatico senza riesame umano.



![AI agent](/blog/images/a-person.jpg)

## **Articolo 37 e l'obbligo di Data Protection Officer**

### **Quando le implementazioni di AI richiedono un DPO**

L'articolo 37 del GDPR impone a determinate organizzazioni di designare un Data Protection Officer. L'obbligo si applica alle autorità pubbliche e agli organismi pubblici, alle organizzazioni le cui attività principali richiedono il monitoraggio sistematico su larga scala delle persone, e alle organizzazioni le cui attività principali consistono nel trattamento su larga scala di categorie particolari di dati o dati relativi a condanne penali.

Gli strumenti di AI fanno frequentemente scattare questa valutazione. Un'azienda di vendita al dettaglio che implementa l'AI per analisi comportamentali su milioni di interazioni con i clienti svolge un monitoraggio sistematico su larga scala. Un'organizzazione sanitaria che utilizza l'AI per trattare cartelle cliniche su larga scala tratta categorie particolari di dati su larga scala. Entrambi gli scenari indicano un obbligo di designare un DPO.

Anche dove la nomina di un DPO non è strettamente obbligatoria, la funzione che svolge — supervisione delle attività di trattamento, interlocuzione con le autorità di controllo e consulenza indipendente in materia di conformità — è praticamente essenziale per le organizzazioni che gestiscono sistemi di AI che toccano volumi significativi di dati personali. Molte aziende che non sono tecnicamente tenute a nominare un DPO lo fanno comunque, perché il valore operativo lo giustifica.

Il DPO deve essere coinvolto nelle implementazioni di AI prima che vadano in produzione, e non consultato a posteriori quando emergono i problemi. Coinvolgere il DPO nella valutazione dello strumento, nella Data Protection Impact Assessment e nella revisione del contratto con il fornitore crea il percorso di supervisione documentato che le autorità si aspettano di vedere.

### **Data Protection Impact Assessment per l'AI**

L'articolo 35 del GDPR richiede una Data Protection Impact Assessment prima di implementare qualsiasi trattamento che possa comportare un rischio elevato per le persone. I sistemi di AI che prevedono profilazione su larga scala, monitoraggio sistematico o processo decisionale automatizzato con effetti significativi fanno quasi sempre scattare questo requisito.

Una corretta DPIA per uno strumento di AI copre quali dati personali il sistema tratta e perché, la necessità e la proporzionalità del trattamento, i rischi per le persone e le relative misure di mitigazione, nonché le misure adottate per dimostrare la conformità. Non è un documento "una tantum". Quando lo strumento di AI cambia, quando cambiano i dati in input o quando il contesto aziendale cambia in modo sostanziale, la DPIA deve essere rivista.

Una pratica [AI guide](https://trigger.fish/guide/) sulla metodologia DPIA per i sistemi di AI aiuta i team di conformità a strutturare valutazioni che soddisfino le aspettative delle autorità di controllo, anziché produrre documentazione che sembra accurata ma trascura l'analisi sostanziale dei rischi che i regolatori cercano.

## **Cose da sapere**

Alcuni punti importanti su GDPR e strumenti di AI che tendono a emergere solo dopo che si sono già verificati i problemi:

L'addestramento di modelli di AI su dati personali richiede una propria valutazione della base giuridica. Se sta facendo fine-tuning di un modello su dati di clienti, dipendenti o qualsiasi altro dato personale detenuto dalla sua organizzazione, tale attività di addestramento è una finalità di trattamento distinta che necessita di una propria base giuridica, separata dalla finalità di raccolta originaria.

I diritti dell'interessato si applicano ai dati trattati dall'AI. Le persone mantengono il diritto di accedere, rettificare, cancellare e portare con sé i propri dati personali anche quando sono stati trattati da un sistema di AI. Se il suo strumento di AI non è in grado di supportare operativamente questi diritti, si tratta di una lacuna di conformità, indipendentemente da quanto siano efficaci gli altri controlli di sicurezza dello strumento.

I responsabili e i sub-responsabili del trattamento devono essere documentati. Ogni fornitore di AI che tratta dati personali per suo conto deve essere indicato nel suo Registro delle attività di trattamento. I loro sub-responsabili del trattamento — fornitori di infrastrutture, società di hosting e altri fornitori sui quali si appoggiano — devono essere comunicati nei Data Processing Agreement stipulati con loro.

La pseudonimizzazione riduce il rischio ma non elimina gli obblighi del GDPR. I dati che sono stati pseudonimizzati, ossia quelli i cui identificativi sono stati sostituiti con codici, sono comunque dati personali ai sensi del GDPR se è ragionevolmente possibile la re-identificazione. Gli strumenti di AI che trattano dati pseudonimizzati stanno comunque trattando dati personali.

I trasferimenti transfrontalieri innescati dall'infrastruttura di AI richiedono meccanismi di trasferimento. Se il suo fornitore di AI tratta dati su infrastrutture al di fuori dell'UE o dello SEE, le serve un meccanismo di trasferimento valido, come le Standard Contractual Clauses o una Transfer Impact Assessment. Molti servizi di AI in cloud instradano il trattamento attraverso data center statunitensi o asiatici per impostazione predefinita.

Per i dati trattati dall'AI vanno definiti periodi di conservazione. Il GDPR impone che i dati personali non siano conservati più a lungo del necessario. I sistemi di AI che conservano log di conversazione, dati di input o dati di output a tempo indeterminato senza una pianificazione di conservazione documentata non sono conformi, indipendentemente dalle altre misure di salvaguardia.

## **Costruire una pratica di AI conforme al GDPR**

Le organizzazioni che gestiscono con successo GDPR e strumenti di AI condividono un approccio comune. Valutano la conformità prima dell'implementazione anziché dopo, mantengono una documentazione viva dei propri flussi di dati di AI e trattano la conformità al GDPR come una disciplina operativa continua, non come un progetto con una data di completamento.

Il contesto normativo intorno all'AI in Europa si sta inasprendo, non allentando. La combinazione di un enforcement del GDPR sempre più focalizzato sull'AI e dell'EU AI Act, che aggiunge un quadro parallelo, fa sì che le organizzazioni con fondamenta deboli di governance dell'AI accumulino esposizione di conformità con ogni nuovo strumento che implementano.

Costruire quella base non è così complesso come sembra. Mappi i suoi flussi di dati. Stabilisca basi giuridiche. Documenti il suo trattamento. Valuti le sue implementazioni ad alto rischio. Sistemi i contratti con i fornitori. Si tratta di pratiche di conformità consolidate, applicate a una nuova categoria di tecnologia. Le organizzazioni che le affrontano in modo sistematico scoprono che conformità e adozione efficace dell'AI non sono in contrasto. Fatte bene, si rafforzano a vicenda.

## **Domande frequenti**

### **Gli strumenti di AI sono soggetti al GDPR?**

**Sì, gli strumenti di AI sono pienamente soggetti al GDPR ogni volta che trattano dati personali relativi a persone nell'UE, indipendentemente da dove abbia sede l'azienda di AI o dove si trovino i suoi server.** Il regolamento si applica in base alla localizzazione degli interessati, non del fornitore di tecnologia: ciò significa che qualsiasi strumento di AI utilizzato su dati di clienti o dipendenti europei deve essere conforme.

### **Cos'è la regola del 30% per l'AI?**

**La regola del 30% per l'AI è una linea guida pratica secondo cui l'automazione tramite AI dovrebbe coprire circa il 30% di un flusso di lavoro, mentre il giudizio e la supervisione umani gestiscono il restante 70%.** Nel contesto del GDPR, questa impostazione è particolarmente utile per la conformità all'articolo 22, perché aiuta le organizzazioni a progettare implementazioni di AI in cui gli esseri umani restano effettivamente coinvolti nelle decisioni invece di limitarsi a ratificare output automatizzati.

### **Quali sono le modifiche al GDPR per l'AI?**

**Il GDPR in sé non è stato formalmente modificato per l'AI, ma le autorità di protezione dei dati di tutta l'UE hanno emesso linee guida sempre più specifiche che applicano i principi esistenti del GDPR ai sistemi di AI, in particolare in materia di basi giuridiche per i dati di addestramento, processo decisionale automatizzato e requisiti di trasparenza per gli output generati dall'AI.** L'EU AI Act, che opera accanto al GDPR e non in sua sostituzione, aggiunge ulteriori obblighi per i sistemi di AI ad alto rischio che trattano dati personali.

### **Cos'è l'articolo 22 del GDPR e l'AI?**

**L'articolo 22 del GDPR riconosce alle persone il diritto di non essere sottoposte a decisioni basate unicamente su trattamento automatizzato che producono effetti giuridici o significativamente analoghi, e ciò si applica direttamente ai sistemi di AI che assumono decisioni rilevanti sulle persone senza un riesame umano significativo.** Le organizzazioni che utilizzano l'AI per credit scoring, screening dei candidati o accesso ai servizi devono garantire o che un essere umano riesamini realmente gli output dell'AI prima che le decisioni diventino effettive, o che si applichi una delle tre eccezioni di legge con tutte le ulteriori salvaguardie richieste.

### **Cos'è l'articolo 37 del GDPR?**

**L'articolo 37 del GDPR stabilisce l'obbligo per determinate organizzazioni di designare un Data Protection Officer, un ruolo che diventa praticamente essenziale per qualsiasi azienda che gestisca sistemi di AI che trattano grandi volumi di dati personali o che effettuano un monitoraggio comportamentale sistematico.** Le organizzazioni le cui attività principali di AI prevedono profilazione su larga scala, trattamento di categorie particolari di dati o monitoraggio sistematico delle persone faranno probabilmente scattare l'obbligo di nomina del DPO previsto da questo articolo.
