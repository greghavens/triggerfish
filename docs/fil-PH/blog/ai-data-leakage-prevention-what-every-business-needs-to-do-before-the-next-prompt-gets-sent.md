---
title: "Pag-iwas sa Pagtagas ng Data sa AI: Ano ang Kailangang Gawin ng Bawat
  Negosyo Bago Maipadala ang Susunod na Prompt"
date: 2026-04-03
description: Ang pag-iwas sa pagtagas ng data sa AI ay nagpoprotekta sa
  sensitibong impormasyon ng negosyo mula sa pagkakalantad sa mga tool ng AI.
  Narito ang mga sanhi nito, kung saan ito nangyayari, at paano ito mapipigilan.
author: triggerfish
tags:
  - AI agent
draft: false
---
Ang pag-iwas sa pagtagas ng data sa AI ay tumutukoy sa mga patakaran, teknikal na kontrol, at mga gawi ng organisasyon na pumipigil sa sensitibong impormasyon ng negosyo na malantad, mapanatili, o magamit nang mali kapag ang mga empleyado at mga sistema ay nakikipag-ugnayan sa mga tool ng artificial intelligence. Tinutugunan nito ang isang kategorya ng pagkawala ng data na hindi idinisenyo upang mahuli ng mga tradisyonal na tool sa pag-iwas.

Ang problema ay nakakalitong simple sa mga mekaniko nito at nakakalitong laganap sa pangyayari nito. Idinikit ng isang empleyado ang isang kontrata ng kliyente sa isang AI tool upang makakuha ng buod. Ipinapakain ng isang developer ang proprietary source code sa isang coding assistant upang ayusin ang isang bug. Nagsusumite ang isang miyembro ng pinansyal na koponan ng isang draft na ulat sa kita sa isang AI writing tool para sa pagpapakinis. Sa bawat kaso, nakakamit ng empleyado ang isang bagay na kapaki-pakinabang. Sa bawat kaso, ang sensitibong data ng organisasyon ay naglakbay sa imprastraktura na hindi kontrolado ng organisasyon, sa ilalim ng mga tuntunin ng serbisyo na hindi kailanman binasa ng empleyado, na may mga gawi sa pagpapanatili at paggamit na maaaring magsama ng pagsasanay ng modelo sa nilalamang iyon. Walang firewall ang nag-flag dito. Walang DLP alert ang pumutok. Walang audit log ang nakakuha nito sa anyo na maaaring kumilos ang mga compliance team. Iyan ang problema ng pagtagas ng data sa AI, at nagaganap ito sa mga organisasyon ng bawat sukat at industriya sa isang sukat na hindi pa naabutan ng karamihan sa mga programa sa seguridad. Ipinapaliwanag ng gabay na ito kung ano ang nagtutulak sa pagtagas ng data sa AI, kung saan ito lumilikha ng pinakaseryosong pagkakalantad, at kung ano ang kailangang ilagay ng mga organisasyon upang maiwasan ito.



![AI agent](/blog/images/submitting.jpg)

## **Pag-unawa Kung Bakit Lumilikha ang mga AI Tool ng Kanilang Sariling Kategorya ng Pagtagas ng Data**

### **Ang Tsanel na Nililibot ang mga Umiiral na Kontrol**

Ang mga tradisyonal na tool sa pag-iwas sa pagkawala ng data ay gumagana sa pamamagitan ng pagsubaybay sa mga kilalang tsanel ng data at paglalapat ng mga panuntunan upang matukoy ang sensitibong nilalaman na gumagalaw sa pamamagitan ng mga ito. Ang mga email attachment ay sinusuri. Ang mga paglilipat ng file sa cloud storage ay sinusuri. Ang mga pagsulat sa USB device ay nire-log. Ang mga kontrol na ito ay sumasalamin sa isang modelo ng paggalaw ng data na tumpak bago naging isang karaniwang bahagi ng lugar ng trabaho ang mga AI tool.

Ang mga AI tool ay kumakatawan sa isang tsanel ng data na hindi naaayos o sinusubaybayan nang tama ng karamihan sa mga umiiral na DLP architecture. Mula sa pananaw ng network traffic, ang isang empleyado na nagsusumite ng isang kumpidensyal na dokumento sa isang AI tool ay magkapareho sa isang empleyado na gumagamit ng anumang ibang web application. Ang HTTPS request sa mga server ng AI tool ay hindi matukoy sa network layer mula sa isang request sa isang productivity application, isang research database, o isang news site. Nakikita ng DLP tool ang pinahihintulutang web traffic. Walang nakikita ang security team. Ang sensitibong data ay umalis na sa gusali.

Ang gap na ito sa arkitektura ang dahilan kung bakit ang pag-iwas sa pagtagas ng data sa AI ay nangangailangan ng nakatuong pansin sa halip na ipagpalagay na sinasaklaw ito ng mga umiiral na kontrol. Ang threat model ay iba, ang tsanel ng data ay iba, at ang mga kontrol na kinakailangan upang tugunan ito ay naiiba sa mga humahawak ng mga karaniwang sitwasyon ng pagkawala ng data.

### **Ano ang Nangyayari sa Data Pagkatapos Pumasok sa isang AI Tool**

Ang mga partikular na panganib sa pagtagas ng data ay nakadepende sa kung ano ang ginagawa ng mga AI vendor sa data na isinumite sa kanilang mga sistema, na malaki ang nagkakaiba sa mga vendor, produkto, at antas. Ang pag-unawa sa hanay ng mga gawi ay tumutulong sa mga organisasyon na i-calibrate ang kanilang mga pagsisikap sa pag-iwas sa paligid ng aktwal na panganib sa halip na isang pangkalahatang alalahanin.

Ang paggamit ng pagsasanay ng modelo ang pinaka-direktang nagiging pangmatagalang problema sa pagtagas ng isang pangyayari ng pagkakalantad ng data. Kapag pinahihintulutan ng mga tuntunin ng serbisyo ng isang vendor ang paggamit ng isinumiteng nilalaman upang mapabuti ang kanilang modelo, hindi lamang lumilipas ang data sa kanilang mga sistema nang pansamantala. Maaari nitong impluwensiyahan ang mga magiging output ng modelo sa mga paraang maaaring maglabas ng mga piraso ng impormasyong iyon sa mga tugon sa ibang mga gumagamit. Ipinagbabawal ito ng mga enterprise agreement sa mga pangunahing vendor bilang isang standard na termino, ngunit karaniwang pinahihintulutan ito ng mga consumer at libreng antas, at ang mga empleyado na gumagamit ng personal na account para sa mga gawain sa trabaho ay karaniwang nagpapatakbo sa ilalim ng mga consumer term.

Ang pagpapanatili ng inference log ay lumilikha ng isang nakahangganang oras na bintana ng pagkakalantad sa halip na isang pangmatagalang panganib sa pagsasanay. Karamihan sa mga AI vendor ay nagpapanatili ng mga log ng mga query at tugon para sa mga tinukoy na panahon para sa mga layunin ng debugging, quality assurance, at legal compliance. Sa panahon ng pagpapanatili na iyon, ang sensitibong data na isinumite sa mga query na iyon ay umiiral sa imprastraktura ng vendor at posibleng maa-access ng mga staff ng vendor, napapailalim sa sariling mga kontrol sa seguridad ng vendor, at posibleng tumutugon sa legal na proseso na nakadirekta sa vendor.

Ang cross-border na paglilipat ng data ay nangyayari kapag ang imprastraktura ng AI inference ay matatagpuan sa ibang hurisdiksyon kaysa sa organisasyong nagsusumite ng data. Para sa mga organisasyon na may mga obligasyon sa paninirahan ng data, lumilikha ito ng pagkakalantad sa compliance na hiwalay sa anumang kabiguan sa seguridad. Maaaring teknikal na ligtas ang data sa imprastraktura ng vendor habang sabay na nilalabag ang mga regulatoryo na kinakailangan tungkol sa kung saan ito maaaring iproseso.

Ang pag-unawa kung paano tinutugunan ng mga balangkas ng [AI security](https://trigger.fish/security/) ang bawat isa sa mga partikular na kategorya ng panganib sa paghawak ng data na ito ay tumutulong sa mga organisasyon na bumuo ng mga programang pang-iwas na nakatuon sa aktwal na mga panganib na nilikha ng kanilang AI tool landscape sa halip na pangkalahatang mga alalahanin sa pagkawala ng data.



![AI agent](/blog/images/concerned.jpg)

## **Kung Saan Lumilikha ang Pagtagas ng Data sa AI ng Pinakaseryosong Pagkakalantad**

### **Mga Kategorya ng Regulated at Confidential Data sa Pinakamataas na Panganib**

Hindi lahat ng data ng organisasyon ay may pantay na panganib sa pagtagas. Ang mga kategorya ng data na lumilikha ng pinakaseryosong pagkakalantad kapag pumasok sila sa mga hindi awtorisadong AI system ay nagbabahagi ng isang karaniwang katangian: ang paghawak sa kanila ay pinamamahalaan ng mga obligasyong legal, mga pangakong kontraktwal, o pagiging sensitibo sa kompetisyon na ginagawang magastos ang hindi awtorisadong paglalantad sa mga paraang lampas sa agarang pagkawala ng impormasyon.

Ang personal na data na sakop ng GDPR, HIPAA, o katumbas na mga balangkas ay lumilikha ng regulatory na pagkakalantad kapag iniproseso sa pamamagitan ng mga AI tool nang walang legal na batayan, kasunduan ng vendor, at teknikal na pananggalang na kinakailangan ng mga balangkas na iyon. Ang isang empleyado na nagsusumite ng isang spreadsheet ng personal na impormasyon ng customer sa isang consumer AI tool para sa paglilinis ng data ay posibleng nakalikha ng isang reportable na paglabag sa data sa ilalim ng GDPR, isang paglabag sa Business Associate Agreement sa ilalim ng HIPAA, at isang incident ng compliance sa ilalim ng anumang bilang ng mga regulasyong tukoy sa sektor, lahat sa loob ng oras na kailangan upang idikit ang nilalaman sa isang chat window.

Ang legal na pribilehiyong nilalaman na isinumite sa mga AI tool ay lumilikha ng mga alalahanin sa pribilehiyong abogado-kliyente na hindi pa lubusang napag-isipan ng mga legal team sa karamihan ng mga organisasyon. Kung ang pagproseso ng AI tool ay bumubuo ng isang paglalantad na nag-waive sa pribilehiyo ay isang umuusbong na legal na tanong sa karamihan ng mga hurisdiksyon, at ang pinakaligtas na posisyon ng organisasyon ay ang pagpigil sa pribilehiyong nilalaman na maabot ang mga AI tool na ang paghawak ay hindi partikular na idinisenyo at kontraktwal para sa mga kinakailangan ng legal na sektor.

Ang proprietary na teknikal na impormasyon kabilang ang source code, mga specification ng produkto, algorithm, at data ng pananaliksik ay kumakatawan sa intelligence ng kompetisyon na malaki ang pinupuhunan ng mga organisasyon upang protektahan. Ang mga AI coding assistant at mga tool sa pagsusuri ng dokumento ay kabilang sa pinakamadalas na ginagamit na mga AI tool sa mga organisasyon ng teknolohiya at pananaliksik, at sila rin ang mga tool na pinakamadalas na ginagamit sa eksaktong mga kategorya ng data na pinakananais ng mga organisasyon na panatilihin mula sa pag-abot sa mga panlabas na sistema.


<table>
  <thead>
    <tr>
      <th>Kategorya ng Data</th>
      <th>Pangunahing Panganib Mula sa Pagtagas ng AI</th>
      <th>Regulatory o Legal na Kahihinatnan</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Personal na Data ng Customer</td>
      <td>Hindi awtorisadong pagproseso ng third party</td>
      <td>Abiso ng paglabag sa GDPR, paglabag sa HIPAA, mga parusang tukoy sa sektor</td>
    </tr>
    <tr>
      <td>Personal na Data ng Empleyado</td>
      <td>Paglalantad ng HR data sa pamamagitan ng AI HR tools</td>
      <td>Mga paglabag sa batas sa pagtatrabaho at proteksyon ng data</td>
    </tr>
    <tr>
      <td>Legal na Pribilehiyong Nilalaman</td>
      <td>Posibleng waiver ng pribilehiyo sa pamamagitan ng paglalantad</td>
      <td>Pagkawala ng legal na proteksyon para sa mga sensitibong usapin</td>
    </tr>
    <tr>
      <td>Proprietary Source Code</td>
      <td>Paglalantad ng intelligence ng kompetisyon</td>
      <td>Pagkawala ng IP, paglabag sa kontrata sa mga kliyente</td>
    </tr>
    <tr>
      <td>Impormasyon ng Pinansyal na Draft</td>
      <td>Materyal na hindi pampublikong impormasyon bago ang paglalantad</td>
      <td>Pagkakalantad sa batas ng mga seguridad, panganib ng selective disclosure</td>
    </tr>
    <tr>
      <td>Kumpidensyal na Impormasyon ng Kliyente</td>
      <td>Paglabag sa propesyonal na mga obligasyon sa pagiging kumpidensyal</td>
      <td>Pinsala sa relasyon ng kliyente, propesyonal na pananagutan</td>
    </tr>
    <tr>
      <td>Mga Lihim ng Kalakal</td>
      <td>Intelligence ng kompetisyon sa pamamagitan ng pagsasanay ng modelo</td>
      <td>Pagkawala ng proteksyon ng lihim ng kalakal kung pampublikong nailalantad</td>
    </tr>
  </tbody>
</table>



### **Ang Dimensyon ng Shadow AI**

Ang pinakamahirap na hamon sa pag-iwas sa pagtagas ng data sa AI ay hindi ang mga tool na inaprubahan at na-deploy ng mga organisasyon sa ilalim ng mga balangkas ng pamamahala. Ito ang mga tool na ginagamit ng mga empleyado nang walang kaalaman o pangangasiwa ng organisasyon. Ang Shadow AI, ang paggamit ng mga AI tool sa labas ng anumang inaprubahang programa, ay bumubuo sa karamihan ng mga incident ng pagtagas ng data sa AI sa karamihan ng mga organisasyon dahil ito ay ganap na nagpapatakbo sa labas ng mga kontrol na itinatag ng isang AI governance program.

Ang paggamit ng Shadow AI ay hindi pangunahing isang kabiguan sa compliance ng mga masasamang aktor. Ito ay isang produktibong tugon ng mga empleyado na natuklasan na tumutulong ang mga AI tool sa kanilang trabaho at na pumili ng kung ano ang naa-access sa halip na maghintay para sa mga proseso ng pag-apruba ng organisasyon na maaaring walang malinaw na timeline. Mahalaga ang pag-unawa sa motibasyong iyon para sa pagdidisenyo ng mga diskarte sa pag-iwas na talagang nagbabawas ng pagtagas sa halip na itulak ang paggamit pa mas malalim sa lupa.

Ang pinaka-epektibong pag-iwas sa Shadow AI ay pinagsasama ang visibility sa kung anong mga AI tool ang ginagamit sa buong organisasyon, isang malinaw at naa-access na inaprubahang programa ng tool na tumutugon sa aktwal na pangangailangan ng mga empleyado, at isang non-punitive na tsanel sa pagsisiwalat para sa mga empleyado na gumamit na ng mga tool sa labas ng inaprubahang programa. Ang mga organisasyon na pangunahing tumutugon sa Shadow AI sa pamamagitan ng pagbabawal ay nakakakita na ang pinagbabatayan na pangangailangan sa produktibidad ay patuloy na natutugunan sa pamamagitan ng paunti-unti na mas hindi nakikitang mga paraan, na lumilikha ng mas malaking pagkakalantad sa pagtagas sa halip na mas kaunti.

Ang pagsusuri kung paano nakakaapekto ang mga desisyon sa [AI architecture](https://trigger.fish/architecture/) tungkol sa inaprubahang AI tool deployment sa pagiging kaakit-akit ng mga shadow alternatives ay tumutulong sa mga organisasyon na idisenyo ang kanilang inaprubahang programa upang maging landas ng pinakakaunting paglaban sa halip na landas ng pinakamaraming alitan sa compliance.

## **Ang mga Teknikal at Organisasyonal na Kontrol na Talagang Gumagana**

### **Mga Teknikal na Kontrol para sa Pag-iwas sa Pagtagas ng Data sa AI**

Ang mga teknikal na kontrol para sa pag-iwas sa pagtagas ng data sa AI ay nagpapatakbo sa ilang mga layer, na ang bawat isa ay tumutugon sa iba't ibang aspeto ng kung paano umaabot ang sensitibong data sa mga AI system. Ang mga epektibong programa ay nagse-stack ng mga kontrol na ito sa halip na umasa sa anumang nag-iisang diskarte.

Maaaring paghigpitan ng mga kontrol sa antas ng network ang pag-access sa mga hindi inaprubahang serbisyo ng AI mula sa mga network at device ng organisasyon sa pamamagitan ng pagharang o pagsubaybay sa trapiko sa mga domain ng AI tool na hindi nasa inaprubahang listahan. Ang diskarteng ito ay mas epektibo sa mga pinamamahalaang network ng korporasyon kaysa sa mga remote work environment kung saan maaaring gumamit ang mga empleyado ng mga personal na network at device, at nangangailangan ito ng patuloy na pagpapanatili habang lumilitaw ang mga bagong AI tool at nagbabago ang mga umiiral na tool sa kanilang imprastraktura ng domain.

Ang endpoint data loss prevention na na-configure upang makilala ang mga pattern ng pag-upload ng AI tool at maglapat ng content inspection sa data na isinumite sa pamamagitan ng mga AI interface ay nagpapalawak ng saklaw ng DLP sa AI channel na napapalampas ng mga legacy DLP architecture. Ito ay nangangailangan ng mga DLP tool na partikular na na-configure para sa mga pattern ng trapiko ng AI tool sa halip na ang mga karaniwang exfiltration channel lamang.

Ang mga browser extension at agent-based na kontrol na nagpapatupad ng mga patakaran sa klasipikasyon ng data sa punto ng pagsusumite, na pumipigil sa nilalamang inuri sa itaas ng isang tinukoy na threshold ng sensitivity na maisumite sa mga AI tool sa labas ng inaprubahang programa, ay kumakatawan sa isang mas naka-target na diskarte kaysa sa pagharang sa antas ng network. Maaaring i-configure ang mga kontrol na ito upang magbabala sa mga gumagamit na lumalapit sa hangganan ng patakaran sa halip na magharang lamang pagkatapos itong tawirin, na lumilikha ng isang behavioral reinforcement mechanism kasama ang teknikal na kontrol.

Ang mga produkto ng enterprise AI gateway ay lumitaw bilang isang nakatuong kategorya ng kontrol na nagruruta ng lahat ng AI traffic ng organisasyon sa pamamagitan ng isang sentralisadong layer ng inspeksyon at pagpapatupad ng patakaran. Ang mga produktong ito ay nagbibigay ng visibility sa paggamit ng AI tool sa buong organisasyon, naglalapat ng data classification at content inspection sa lahat ng AI submission, nagpapatupad ng mga patakaran ng inaprubahang tool, at bumubuo ng mga audit log sa mga format na maaaring pakitunguhin ng mga compliance at security team.


<table>
  <thead>
    <tr>
      <th>Uri ng Kontrol</th>
      <th>Ano ang Tinutugunan Nito</th>
      <th>Limitasyon</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Pagharang sa Network</td>
      <td>Pumipigil sa pag-access sa mga hindi inaprubahang AI tool sa corporate network</td>
      <td>Hindi epektibo sa mga personal na network at hindi pinamamahalaang device</td>
    </tr>
    <tr>
      <td>Endpoint DLP para sa AI</td>
      <td>Sinusuri ang nilalamang isinumite sa pamamagitan ng mga AI interface</td>
      <td>Nangangailangan ng AI-specific configuration na lampas sa standard DLP</td>
    </tr>
    <tr>
      <td>Mga Kontrol sa Browser Extension</td>
      <td>Pagpapatupad ng patakaran sa punto ng pagsusumite ng AI</td>
      <td>Limitado ang saklaw sa mga pinamamahalaang environment ng browser</td>
    </tr>
    <tr>
      <td>Enterprise AI Gateway</td>
      <td>Sentralisadong visibility, inspeksyon, at pagpapatupad ng patakaran</td>
      <td>Nangangailangan ng pagruruta ng lahat ng AI traffic sa pamamagitan ng gateway infrastructure</td>
    </tr>
    <tr>
      <td>Mga Label ng Data Classification</td>
      <td>Gumagabay sa mga desisyon ng empleyado tungkol sa pagiging angkop ng AI tool</td>
      <td>Umaasa sa pagsunod ng empleyado sa halip na teknikal na pagpapatupad</td>
    </tr>
    <tr>
      <td>Zero Trust Access Controls</td>
      <td>Naglilimita ng access sa AI tool sa mga awtorisadong gumagamit sa mga tinukoy na konteksto</td>
      <td>Hindi tinutugunan ang nilalaman ng mga awtorisadong pagsusumite</td>
    </tr>
  </tbody>
</table>



### **Mga Kontrol ng Organisasyon na Kumukumpleto sa Teknikal na Pag-iwas**

Binabawasan ng mga teknikal na kontrol ang pagtagas sa pamamagitan ng awtomatikong pagpapatupad. Binabawasan ng mga kontrol ng organisasyon ang pagtagas sa pamamagitan ng paghuhusga at pag-uugali ng empleyado na tumutukoy kung ang mga teknikal na kontrol ay nililibot, nilalampasan, o tunay na isinasama sa kung paano ginagawa ang trabaho.

Ang isang malinaw na patakaran sa klasipikasyon ng data na nagmamapa ng mga antas ng sensitivity sa pinahihintulutang mga AI processing environment ay nagbibigay sa mga empleyado ng isang patakaran sa pagpapasya na maaari nilang ilapat nang pare-pareho nang hindi kumukunsulta sa mga dokumento ng patakaran para sa bawat gawain. Kapag alam ng isang empleyado na ang data na inuri bilang kumpidensyal ay maaari lamang iproseso sa pamamagitan ng on-premise AI tools o enterprise-tier cloud tools na may mga lagdaang data agreement, mayroon silang isang naaaksyong gabay sa halip na isang malabong tagubilin na maging maingat.

Ang pagsasanay na gumagamit ng konkreto, role-specific na mga sitwasyon sa halip na pangkalahatang nilalaman ng pag-iwas sa proteksyon ng data ay nagdudulot ng pagbabago sa pag-uugali na hindi ginagawa ng abstract na pagsasanay. Ang isang engineer na maaaring ilarawan kung ano ang nangyayari sa source code na isinumite sa isang popular na coding assistant sa ilalim ng default na mga tuntunin ng serbisyo nito ay may praktikal na kaalaman na nagbabago sa kanilang pag-uugali. Ang isang engineer na dumalo sa isang pagsasanay sa mga prinsipyo ng proteksyon ng data ay may kamalayan na maaari o hindi mai-translate sa ibang pag-uugali kapag ang isang deadline ay lumilikha ng presyon na gamitin ang pinakamabilis na available na tool.

Ang mga proseso sa pagsisiwalat ng incident na nagtuturing sa mga unang pagsisiwalat ng nakaraang paggamit ng shadow AI bilang mga pagkakataong matuto sa halip na mga paglabag sa compliance ay lumilikha ng psychological safety na naghihikayat sa mga empleyado na mailatag ang umiiral na pagkakalantad sa halip na itago ito. Ang organisasyonal na halaga ng hindi alam na pagtagas ay mas mataas kaysa sa halaga ng kilalang pagtagas na maaaring masuri at matugunan.

Ang pag-unawa sa kung paano ipinapaalam ng mga [AI feature](https://trigger.fish/features/) sa mga inaprubahang enterprise AI tool ang kanilang mga gawi sa paghawak ng data sa mga gumagamit ay tumutulong sa mga organisasyon na bumuo ng pagsasanay na nag-uugnay sa mga kinakailangan sa patakaran sa partikular na mga pag-uugali ng tool na nakakaharap ng mga empleyado sa pagsasanay sa halip na ituring ang koneksyon sa pagitan ng patakaran at tool bilang isang bagay na dapat malaman ng mga empleyado nang nakapag-iisa.



![AI agent](/blog/images/session.jpg)

## **Pagbuo ng isang Programang Pang-iwas sa Pagtagas ng Data sa AI**

### **Ang Pundasyon ng Imbentaryo at Pagsusuri**

Ang mga programa sa pag-iwas sa pagtagas ng data sa AI na gumagana ay nagsisimula sa isang tumpak na larawan ng kung anong mga AI tool ang ginagamit sa buong organisasyon, hindi lamang kung anong mga tool ang opisyal na inaprubahan. Tinutukoy ng gap sa pagitan ng dalawang imbentaryong iyon ang agarang saklaw ng programa sa pag-iwas.

Ang pagbuo ng aktwal na imbentaryo ng AI tool ay nangangailangan ng pagsasama ng maraming mga mapagkukunan ng data dahil walang nag-iisang mapagkukunan ang kumukuha ng buong larawan. Ang mga imbentaryo ng software na pinamamahalaan ng IT ay kumukuha ng mga opisyal na binili na mga tool. Ang pagsusuri ng network traffic ay naglalantad ng mga domain na inaabot ng AI tool traffic sa buong organisasyon. Ang mga survey ng empleyado at mga panayam sa departamento ay naglalantad ng mga tool na ginagamit ng mga empleyado na hindi kailanman nakikita ng IT procurement. Ang mga imbentaryo ng browser extension at endpoint ay kumikilala sa mga AI tool na naka-install sa antas ng indibidwal na device. Ang kumpletong imbentaryo ay ang pagsasama ng lahat ng mga mapagkukunang ito, at halos palaging mas malaki at mas iba-iba kaysa sa inaasahan ng anumang organisasyon bago gawin ang ehersisyo.

Sa sandaling umiiral ang imbentaryo, ang bawat tool ay nangangailangan ng pagsusuri laban sa mga kinakailangan sa seguridad ng data na sumasaklaw sa mga gawi sa paghawak ng data ng vendor, katayuan ng sertipikasyon, availability ng kontraktwal na proteksyon, at ang mga kategorya ng data na talagang ginagamit ng mga empleyado dito. Ang output ng pagsusuri ay isang risk-tiered na klasipikasyon ng bawat AI tool sa imbentaryo, mula sa inaprubahan para sa lahat ng kategorya ng data hanggang sa inaprubahan na may mga paghihigpit hanggang sa ipinagbabawal na naghihintay ng pagsusuri hanggang sa ganap na ipinagbabawal.

### **Mga Proteksyon ng Vendor at Kontraktwal**

Ang mga programang pang-iwas na umaasa lamang sa mga behavioral at teknikal na kontrol nang walang katumbas na kontraktwal na proteksyon ay lumilikha ng isang istrukturang pamamahala na hindi kumpleto sa pundasyon nito. Binabawasan ng mga teknikal na kontrol ang posibilidad ng pagtagas sa pamamagitan ng mga hindi awtorisadong tool. Tinutukoy ng mga kontraktwal na proteksyon kung anong mga proteksyon ang nalalapat kapag ginagamit ang mga awtorisadong tool at kung anong rekurso ang mayroon ang organisasyon kapag hindi pinararangalan ang mga proteksyong iyon.

Ang bawat AI vendor na ang mga tool ay nagpoproseso ng data ng organisasyon sa itaas ng pinakamababang antas ng sensitivity ay nangangailangan ng isang nilagdaang kasunduan sa pagproseso ng data na tahasang nagbabawal sa paggamit ng data ng pagsasanay, tinutukoy ang mga limitasyon sa pagpapanatili, nangangako ng abiso ng paglabag sa loob ng mga kinakailangang timeframe, at nagdodokumento sa mga kontrol sa seguridad na inilapat sa data ng organisasyon. Para sa mga organisasyon ng pangangalaga sa kalusugan, ang isang Business Associate Agreement na sumasaklaw sa partikular na produkto ng AI ay isang legal na kinakailangan sa halip na isang kontraktwal na kagustuhan.

Ang programang kontraktwal na proteksyon ay nangangailangan ng pagpapanatili tulad ng mga teknikal na kontrol. Ina-update ng mga vendor ang kanilang mga tuntunin sa serbisyo. Ang mga produktong sakop sa ilalim ng isang kasunduan ay maaaring ihiwalay mula dito sa pamamagitan ng isang pagbabago sa portfolio ng produkto. Ang mga panahon ng sertipikasyon ay nag-e-expire. Ang pagbuo ng isang taunang pagsusuri ng kasunduan ng vendor sa programa ay pumipigil sa sitwasyon kung saan ang data ng organisasyon ay iniproseso sa ilalim ng mga kasunduan na hindi na sumasalamin sa aktwal na mga gawi ng vendor.

Ang isang komprehensibong [AI guide](https://trigger.fish/guide/) sa pagbuo ng mga programa sa pag-iwas sa pagtagas ng data sa AI mula sa imbentaryo at pagsusuri hanggang sa teknikal na mga kontrol at pamamahala ng vendor ay tumutulong sa mga organisasyon na bumuo ng mga programa na tumutugon sa buong hamon sa pag-iwas sa halip na ang pinakanakikitang bahagi nito.

## **Mga Bagay na Dapat Malaman**

Ilang mahahalagang katotohanan tungkol sa pag-iwas sa pagtagas ng data sa AI na patuloy na nakakaharap ng mga organisasyon habang binubuo nila ang kanilang mga programa:

Ang mga produktong consumer tier mula sa mga enterprise AI vendor ay may iba't ibang mga gawi sa paghawak ng data kaysa sa kanilang mga produktong enterprise, kung minsan ay dramatically. Ang parehong pinagbabatayan na kakayahan ng AI na ina-access sa pamamagitan ng isang personal na account at sa pamamagitan ng isang enterprise account ay maaaring magkaroon ng ganap na magkakaibang mga patakaran sa data ng pagsasanay, mga gawi sa pagpapanatili, at availability ng kontraktwal na proteksyon. Ang mga empleyado na nag-a-access ng mga enterprise AI tool sa pamamagitan ng mga personal na account dahil ang mga account ng organisasyon ay nangangailangan ng pag-apruba o nagkakahalaga ng pera ay gumagamit ng mga proteksyon sa antas ng consumer sa data ng trabaho nang hindi nakikilala ang pagkakaiba.

Ang 30% na panuntunan para sa AI ay nalalapat nang kapaki-pakinabang sa disenyo ng programa sa pag-iwas sa pagtagas ng data. Ang mga awtomatikong teknikal na kontrol ay dapat humawak ng halos 30% ng gawain sa pag-iwas, partikular na ang mga high-frequency, mga gawain sa pagpapatupad ng patakaran na hawak ng automation nang pare-pareho sa scale. Ang paghuhusga ng tao at pamamahala ng organisasyon ay sumasaklaw sa natitirang 70% na kinasasangkutan ng pagtatasa ng panganib, pagsusuri ng vendor, pagtugon sa incident, at ang pagsasanay at pagbuo ng kultura na tumutukoy kung ang mga teknikal na kontrol ay isinasama sa kung paano talaga ginagawa ang trabaho o itinuturing bilang mga sagabal upang maiwasan.

Ang paggamit ng AI tool na batay sa browser ay ang pinakamahirap na kategorya na kontrolin sa pamamagitan ng pagharang sa antas ng network lamang. Ang mga empleyado na nagtatrabaho nang malayuan sa mga personal na network, gumagamit ng mga personal na device para sa mga gawain sa trabaho, o ina-access ang mga AI tool sa pamamagitan ng mga browser interface na kahawig ng pangkalahatang paggamit ng web ay nagpapakita ng isang hamon sa kontrol na mas mahusay na natutugunan ng mga endpoint-based na diskarte kaysa sa mga batay sa network.

Ang mga generative AI tool na naka-embed sa mga malawakang ginagamit na productivity software ay lumilikha ng pagkakalantad sa pagtagas na hindi mukhang paggamit ng AI tool sa karamihan ng mga empleyado. Kapag ang isang word processor ay gumagamit ng AI upang magmungkahi ng mga text completion, ang isang spreadsheet ay gumagamit ng AI upang mai-interpret ang pagpasok ng data, o ang isang email client ay gumagamit ng AI upang mag-draft ng mga tugon, ang empleyado ay gumagamit ng AI nang wala ang sinumang sadyang pagpapasya na maaaring magtulak sa kanila na isaalang-alang ang klasipikasyon ng data. Ang mga programa ng pamamahala na tumutugon lamang sa mga standalone na AI tool ay may mga blind spot dito.

Ang babala ni Stephen Hawking tungkol sa AI ay nakatuon sa existential risk mula sa mga superintelligent na sistema sa halip na sa pagtagas ng data partikular, ngunit ang kanyang mas malawak na pag-iingat tungkol sa paglipat ng mas mabilis sa kakayahan ng AI kaysa sa pamamahala ng AI ay direktang naisalin sa problema sa pagtagas ng data. Ang mga organisasyon na nag-deploy ng mga AI tool nang mas mabilis kaysa sa makakaayos ng kanilang mga balangkas sa proteksyon ng data ay lumilikha ng eksaktong hindi pinamamahalaang pagkakalantad na itinuturo ng pangkalahatang pag-aalala ni Hawking tungkol sa hindi sapat na pamamahala ng AI. Ang praktikal na aral para sa pag-iwas sa pagtagas ng data ay ang imprastraktura ng pamamahala ay kailangang umunlad nang mauna sa scale ng deployment sa halip na umabot dito.

Ang kalidad ng audit trail ay tumutukoy kung gaano kahusay ang pagtugon ng mga organisasyon sa mga incident ng pagtagas kapag nangyayari sila. Kapaki-pakinabang ang pag-alam na ang isang empleyado ay nagsumite ng sensitibong data sa isang hindi awtorisadong AI tool. Ang pag-alam kung ano ang partikular na data na isinumite, kailan, ano ang tugon ng AI tool, at ano ang ginawa ng empleyado sa tugon na iyon ay ang nagpapahintulot ng epektibong pagtugon sa incident. Ang imprastraktura ng pag-log para sa pag-iwas sa pagtagas ng data sa AI ay kailangang itayo para sa utility sa imbestigasyon ng incident, hindi lamang para sa kasiyahan ng compliance checkbox.

Ang mga internasyonal na empleyado at opisina ay nagdaragdag ng pagiging kumplikado ng paninirahan ng data sa pag-iwas sa pagtagas. Ang isang AI tool na inaprubahan para sa paggamit sa hindi personal na business data sa isang hurisdiksyon ay maaaring mag-trigger ng mga paglabag sa paninirahan ng data kapag ginamit sa parehong mga kategorya ng data sa ibang hurisdiksyon. Ang mga multinational organization ay nangangailangan ng mga programa sa pag-iwas sa pagtagas ng data na may pananagutan sa pagkakaiba-iba ng hurisdiksyon sa halip na maglapat ng pare-parehong mga global policy nang walang sensitibidad sa heograpiya.

## **Pagpigil sa Pagtagas ng Data sa AI bilang Patuloy na Disiplina**

Ang pag-iwas sa pagtagas ng data sa AI ay hindi isang proyekto na may petsa ng pagkumpleto. Ito ay isang patuloy na operational disiplina na kailangang umunlad sa bilis ng AI tool landscape, ang regulatoryo na kapaligiran, at ang organisasyonal na bakas ng AI na pinamamahalaan nito. Ang mga tool na walang umiral labing-dalawang buwan na ang nakalipas ay mga standard na bahagi ng mga workflow ng maraming empleyado ngayon. Ang mga regulasyon na aspiratibo isang taon na ang nakalipas ay maaaring ipatupad na mga kinakailangan ngayon. Ang mga kakayahan ng AI na limitado sa mga standalone tool ay naka-embed sa operational infrastructure sa mga paraan na nag-blur sa hangganan sa pagitan ng paggamit ng AI tool at regular na paggamit ng system.

Ang mga organisasyon na nagtatayo ng pag-iwas sa pagtagas ng data sa AI bilang isang napapanatili na operational na programa, na may imprastraktura ng visibility, mga proseso ng pamamahala, at mga pundasyon ng kultura na ginagawang self-reinforcing sa halip na enforcement-dependent, ay nagtatayo ng proteksyon na nag-compound sa paglipas ng panahon. Ang bawat inaprubahang tool na idinagdag sa programa ay nagbabawas sa pagiging kaakit-akit ng mga shadow alternatives. Ang bawat training cycle ay nagpapabuti sa paghuhusga ng empleyado tungkol sa klasipikasyon ng data at pagpili ng tool. Ang bawat pagsusuri ng kasunduan ng vendor ay nakakahuli ng drift sa pagitan ng mga dokumentado at aktwal na mga proteksyon bago ito lumikha ng hindi natukoy na pagkakalantad.

Ang data na dumadaloy sa mga AI tool ng iyong organisasyon ay ilan sa pinaka-sensitibong impormasyon na nililikha ng iyong negosyo, na iniproseso sa mga konteksto kung saan ang mga karaniwang kontrol na namamahala sa paghawak ng data ay hindi pa gaanong mature. Ang pagbuo ng programang pang-iwas na nagprotekta nito nang naaangkop ay hindi isang ehersisyo sa compliance. Ito ay isang foundational na investment sa seguridad sa AI-enabled na negosyo na nagiging organisasyon mo na.

## **Mga Madalas Itanong**

### **Ano ang data leakage sa AI?**

**Ang data leakage sa AI ay tumutukoy sa pagkakalantad ng sensitibong organisasyonal na impormasyon sa pamamagitan ng paggamit ng AI tool, na nagaganap kapag ang mga empleyado ay nagsusumite ng kumpidensyal na data sa mga AI system na ang mga gawi sa paghawak ng data ng vendor, mga patakaran sa pagpapanatili, o paggamit ng data ng pagsasanay ay lumilikha ng hindi awtorisadong paglalantad na lampas sa nilayong layunin ng pagproseso.** Naiiba ito sa karaniwang pagtagas ng data dahil nangyayari ito sa pamamagitan ng isang tsanel na madalas na hindi sinusubaybayan ng mga umiiral na DLP tool, sa pamamagitan ng mga aksyon ng empleyado na tunay na produktibo sa halip na pabaya o malisyoso, at na may mga kahihinatnan na maaaring magsama hindi lamang ng agarang pagkakalantad kundi pati na rin ng patuloy na pag-encode ng sensitibong impormasyon sa imprastraktura ng modelo ng vendor.

### **Ano ang 30% rule para sa AI?**

**Ang 30% rule para sa AI ay ang prinsipyo na ang mga AI system at mga awtomatikong kontrol ay dapat humawak ng halos 30% ng isang workflow o function ng programa, partikular na ang mga high-frequency, well-defined, at consistently executable na mga gawain kung saan ang automation ay nagbibigay ng malinaw na mga benepisyo sa kahusayan at pagiging maaasahan, habang ang paghuhusga ng tao at pamamahala ay sumasaklaw sa natitirang 70% na kinasasangkutan ng contextual na pagtatasa, mga desisyon sa panganib, at ang pananagutan na kailangang maipasa sa mga tao sa halip na mga awtomatikong sistema.** Sa pag-iwas sa pagtagas ng data sa AI partikular, ibig sabihin nito na ang mga awtomatikong teknikal na kontrol ay humahawak ng karaniwang pagpapatupad ng patakaran habang ang pamamahala ng tao ay nagmamay-ari ng pagtatasa ng panganib, pagsusuri ng vendor, pagtugon sa incident, at ang mga dimensyon ng kultura at pagsasanay na tumutukoy kung ang mga teknikal na kontrol ay isinasama sa aktwal na pag-uugali.

### **Ano ang babala ni Stephen Hawking tungkol sa AI?**

**Ang pangunahing babala ni Stephen Hawking tungkol sa AI ay nababahala sa potensyal na existential risk mula sa artificial general intelligence na nakahihigit sa cognitive capabilities ng tao at pumupursue ng mga layunin na hindi naaayon sa kapakanan ng tao, na nagpapahayag ng pag-aalala na ang sangkatauhan ay gumagalaw nang masyadong mabilis sa pagbuo ng kakayahan ng AI nang walang sapat na atensyon sa kaligtasan at pamamahala.** Habang ang kanyang pag-aalala ay nakadirekta sa long-term existential risk sa halip na sa near-term na seguridad ng data ng negosyo, ang pinagbabatayan na prinsipyo ng pamamahala ay direktang naisalin sa praktikal na deployment ng AI: ang mga organisasyon na nag-advance sa kakayahan ng AI nang mas mabilis kaysa sa makakaayos ng kanilang mga balangkas sa pamamahala ay lumilikha ng hindi pinamamahalaang panganib na nagreresulta mula sa kakayahan nang walang pananagutan.

### **Paano gamitin ang AI nang hindi nag-le-leak ng data?**

**Ang paggamit ng AI nang hindi nag-le-leak ng data ay nangangailangan ng apat na mga gawi na inilalapat nang pare-pareho: pagsusumite lamang ng data na nasuri laban sa mga inaprubahang kategorya ng data ng AI tool bago ang bawat paggamit, umaasa lamang sa mga enterprise-tier AI tool na may mga lagdaang data processing agreement na nagbabawal sa paggamit ng data ng pagsasanay, pag-unawa sa partikular na mga gawi sa paghawak ng data ng bawat AI tool na ginamit para sa mga gawain sa trabaho kasama ang mga naka-embed sa productivity software, at pagsunod sa mga patakaran sa klasipikasyon ng data ng organisasyon na tumutukoy kung anong mga antas ng sensitivity ang pinahihintulutan sa anong mga AI tool.** Para sa pinakamataas na mga kategorya ng sensitivity ng data, ang nag-iisang ganap na leak-proof na diskarte ay ang paggamit ng mga AI tool na na-deploy sa pribadong imprastraktura kung saan hindi kailanman umaalis ang data sa sariling network perimeter ng organisasyon.

### **Ano ang hindi mo dapat sabihin sa ChatGPT?**

**Sa pamamagitan ng standard consumer interface ng ChatGPT, hindi dapat magsumite ang mga empleyado ng personal na impormasyon ng customer, mga rekord ng empleyado, legal na pribilehiyong mga komunikasyon, proprietary source code o algorithm, mga draft na financial disclosure o materyal na hindi pampublikong impormasyon, mga lihim ng kalakal, kumpidensyal na impormasyon ng kliyente, o anumang ibang data na ang hindi awtorisadong paglalantad ay lilikha ng mga kahihinatnang legal, regulatoryo, kompetitibo, o kontraktwal para sa organisasyon.** Ang consumer version ng ChatGPT ay nagpapatakbo sa ilalim ng mga tuntunin ng serbisyo na hindi kasama ang mga data processing agreement, mga pagbabawal sa data ng pagsasanay, at mga kontraktwal na proteksyon na ginagawang angkop ang mga enterprise-tier AI tool para sa data ng negosyo, na nangangahulugang ang nilalamang isinumite sa pamamagitan ng mga personal na account ay maaaring panatilihin at potensyal na ginagamit sa mga paraan na hindi makokontrol o matuklasan ng mga organisasyon.
