---
title: "Penilaian Keselamatan Vendor AI: Cara Menilai Alat AI Sebelum
  Mempercayakan Data Anda Kepadanya"
date: 2026-04-05
description: Penilaian keselamatan vendor AI mengesahkan bahawa alat AI memenuhi
  standard perlindungan data, pematuhan dan keselamatan anda sebelum
  diaplikasikan. Inilah cara melakukannya dengan betul.
author: triggerfish
tags:
  - AI agent
draft: false
---
Penilaian keselamatan vendor AI ialah proses penilaian berstruktur yang menentukan sama ada alat atau platform kecerdasan buatan memenuhi keperluan keselamatan, pematuhan dan perlindungan data sesebuah organisasi sebelum vendor tersebut diberikan akses kepada data organisasi atau diintegrasikan ke dalam aliran kerja perniagaan. Ia menggantikan andaian dengan bukti pada titik dalam proses perolehan di mana akibat membuat kesilapan masih boleh diuruskan.

Kebanyakan organisasi mempunyai proses penilaian keselamatan vendor yang berfungsi dengan munasabah baik untuk perisian konvensional. Vendor melengkapkan soal selidik. Bahagian undang-undang menyemak kontrak. IT memeriksa pensijilan. Alat tersebut diaplikasikan. Bagi vendor AI, proses tersebut terlepas perkara yang cukup penting. Soalan-soalan yang mendedahkan risiko paling ketara dalam hubungan vendor AI bukanlah soalan-soalan yang terdapat dalam soal selidik vendor IT yang biasa. Ia adalah soalan tentang penggunaan data latihan model, tentang bidang kuasa infrastruktur inferens, tentang apa yang berlaku kepada data apabila perbualan tamat, dan sama ada pensijilan keselamatan yang vendor kemukakan benar-benar meliputi produk khusus yang sedang diaplikasikan atau bahagian lain daripada infrastruktur mereka. Organisasi yang menemui jurang ini selepas menandatangani kontrak dan selepas data sensitif telah mengalir melalui sistem yang tidak dinilai dengan betul adalah mereka yang menjalankan penilaian tersebut dengan lebih teliti pada kali kedua. Panduan ini menerangkan cara menjalankan penilaian keselamatan vendor AI yang menangkap perkara yang penting, bukti apa yang perlu dituntut dan bukan diterima atas dakwaan, dan cara membina proses penilaian sebagai keupayaan organisasi yang boleh diulang.



![AI agent](/blog/images/procurement.jpg)

## **Mengapa Penilaian Vendor Standard Tidak Mencukupi untuk AI**

### **Jurang yang Soal Selidik Generik Terlepas**

Soal selidik keselamatan vendor IT standard telah dibangunkan untuk persekitaran perisian yang kebimbangan keselamatan utamanya adalah keselamatan penyimpanan data, kawalan akses dan perlindungan rangkaian. Kebimbangan tersebut juga terpakai kepada vendor AI. Tetapi sistem AI memperkenalkan satu set kebimbangan tambahan yang soal selidik generik tidak direka untuk mendedahkan dan yang vendor tidak akan memberitahu secara sukarela jika tidak ditanya secara khusus.

Penggunaan data latihan model adalah jurang yang pertama. Sama ada vendor menggunakan data yang dihantar melalui produk mereka untuk melatih atau memperbaiki model AI mereka adalah salah satu soalan pengendalian data yang paling penting bagi organisasi yang memproses maklumat proprietari atau sensitif melalui alat AI. Ia juga merupakan soalan yang tidak disertakan dalam soal selidik vendor standard kerana ia tidak mempunyai padanan dalam perolehan perisian konvensional. Vendor pangkalan data tidak melatih produk mereka pada data anda. Vendor AI mungkin berbuat demikian, dan sama ada mereka berbuat demikian atau tidak selalunya tersembunyi dalam bahasa terma perkhidmatan dan bukannya didedahkan secara menonjol.

Lokasi infrastruktur inferens adalah jurang kedua. Di mana model AI memproses data anda secara fizikal menentukan rangka kerja undang-undang yang mana berkenaan dengan pemprosesan tersebut, sama ada mekanisme pemindahan data merentas sempadan diperlukan, dan proses undang-undang bidang kuasa yang mana boleh memaksa pendedahan data tersebut. Penilaian vendor standard bertanya di mana data disimpan. Penilaian AI perlu bertanya secara berasingan di mana data diproses semasa inferens, yang mungkin merupakan infrastruktur berbeza di lokasi yang berbeza.

Sempadan skop pensijilan keselamatan adalah jurang ketiga. Vendor boleh mengemukakan laporan SOC 2 Type 2 yang meliputi infrastruktur awan mereka manakala produk AI khusus yang sedang dinilai berjalan pada infrastruktur berbeza yang bukan dalam skop audit. Tanpa mengesahkan bahawa pensijilan yang dikemukakan meliputi produk khusus dan infrastruktur yang berkaitan dengan aplikasi anda, semakan pensijilan boleh memberikan keyakinan palsu tentang aplikasi yang tidak pernah diperiksa.

Memahami bagaimana keperluan penilaian [AI security](https://trigger.fish/security/) berbeza daripada penilaian keselamatan vendor konvensional membantu organisasi membina proses penilaian yang menangani landskap risiko AI sebenar dan bukannya landskap risiko perisian konvensional yang menjadi tujuan asal proses tersebut direka.



![AI agent](/blog/images/security-reviewing.jpg)

## **Membina Rangka Kerja Penilaian Keselamatan Vendor AI**

### **Lima Domain yang Setiap Penilaian Mesti Liputi**

Penilaian keselamatan vendor AI yang berkesan mengatur penilaiannya merentasi lima domain yang bersama-sama memberikan gambaran lengkap tentang postur keselamatan vendor bagi aplikasi khusus yang sedang dipertimbangkan. Setiap domain menangani dimensi risiko yang berbeza yang tidak diliputi oleh domain lain, itulah sebabnya penilaian yang menumpukan pada satu atau dua domain sambil meninggalkan yang lain secara konsisten terlepas risiko material.

**Keselamatan teknikal** meliputi kawalan infrastruktur yang melindungi data yang diproses oleh sistem AI vendor. Ini adalah domain yang paling bertindih dengan penilaian keselamatan vendor konvensional dan meliputi piawaian penyulitan, seni bina keselamatan rangkaian, amalan pengurusan kelemahan, keupayaan pengesanan dan tindak balas insiden, serta keselamatan fizikal infrastruktur yang menjalankan beban kerja AI.

**Tadbir urus data** meliputi apa yang dilakukan vendor dengan data organisasi sepanjang kitaran hayatnya dalam sistem mereka. Domain ini termasuk dasar penggunaan data latihan, amalan pengekalan log inferens, keupayaan dan jadual masa pemadaman data, hubungan subpemproses dan akses data mereka, mekanisme pemindahan data merentas sempadan, serta perlindungan kontrak yang mengawal semua perkara di atas.

**Pematuhan dan pensijilan** meliputi pengesahan bebas terhadap dakwaan keselamatan vendor dan rangka kerja kawal selia yang produk mereka boleh menyokong. Domain ini termasuk semakan dokumen pensijilan khusus dan bukannya menerima kenyataan vendor, mengesahkan skop dan kesemasaan pensijilan, menilai ketersediaan perjanjian data yang diperlukan, dan mengesahkan sokongan untuk keperluan pematuhan khusus sektor yang terpakai kepada organisasi anda.

**Keselamatan khusus AI** meliputi risiko yang unik kepada sistem AI yang tidak mempunyai padanan dalam penilaian vendor perisian konvensional. Domain ini termasuk kerentanan kepada prompt injection dan kawalan mitigasi, ujian keteguhan adversarial, perlindungan terhadap pengekstrakan model, kadar halusinasi dan pendekatan mitigasi untuk kes guna khusus yang sedang diaplikasikan, serta pendekatan vendor terhadap kemas kini model dan pengurusan perubahan tingkah laku.

**Keselamatan operasi** meliputi amalan keselamatan vendor sebagai organisasi dan bukannya kawalan teknikal produk khusus mereka. Domain ini termasuk struktur dan kepakaran pasukan keselamatan, amalan pendedahan keselamatan dan pengurusan kelemahan, proses pemberitahuan pelanggaran dan rekod insiden bersejarah, serta keselamatan rantaian bekalan vendor sendiri untuk komponen dan perkhidmatan yang produk AI mereka bergantung.


<table>
  <thead>
    <tr>
      <th>Domain Penilaian</th>
      <th>Soalan Utama</th>
      <th>Bukti yang Diperlukan</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Keselamatan Teknikal</td>
      <td>Piawaian penyulitan, seni bina rangkaian, pengurusan kelemahan</td>
      <td>Laporan SOC 2 Type 2, ringkasan ujian penembusan</td>
    </tr>
    <tr>
      <td>Tadbir Urus Data</td>
      <td>Penggunaan data latihan, tempoh pengekalan, keupayaan pemadaman, subpemproses</td>
      <td>Terma kontrak, perjanjian pemprosesan data, senarai subpemproses</td>
    </tr>
    <tr>
      <td>Pematuhan dan Pensijilan</td>
      <td>Skop dan kesemasaan pensijilan, ketersediaan perjanjian data, sokongan kawal selia</td>
      <td>Dokumen pensijilan semasa, DPA atau BAA yang ditandatangani</td>
    </tr>
    <tr>
      <td>Keselamatan Khusus AI</td>
      <td>Kawalan prompt injection, keteguhan adversarial, amalan kemas kini model</td>
      <td>Dokumentasi teknikal, keputusan ujian keselamatan</td>
    </tr>
    <tr>
      <td>Keselamatan Operasi</td>
      <td>Pasukan keselamatan, amalan pendedahan, sejarah insiden, rantaian bekalan</td>
      <td>Pendedahan keselamatan, sejarah pemberitahuan insiden</td>
    </tr>
  </tbody>
</table>



### **Piawaian Bukti yang Memisahkan Penilaian daripada Penerimaan**

Disiplin yang paling penting dalam penilaian keselamatan vendor AI ialah menuntut bukti dan bukannya menerima dakwaan. Dakwaan keselamatan vendor yang dibuat dalam perbualan jualan, bahan pemasaran dan bahkan soal selidik yang dilengkapkan vendor bukanlah kenyataan fakta yang disahkan secara bebas. Ia adalah perwakilan yang ketepatannya bergantung pada penilaian vendor sendiri terhadap postur keselamatan mereka dan insentif komersial mereka untuk mempersembahkannya secara menguntungkan.

Penilaian berasaskan bukti memerlukan setiap dakwaan keselamatan penting disokong oleh dokumentasi yang telah disahkan oleh pihak bebas atau yang boleh disahkan secara langsung oleh organisasi. Vendor yang mendakwa pematuhan SOC 2 harus mengemukakan laporan SOC 2 sebenar, bukan ringkasan atau lencana. Laporan harus dibaca, bukan sekadar diterima, dengan perhatian kepada sempadan skop, tempoh audit, kawalan khusus yang diuji, dan sebarang pengecualian atau penyimpangan yang dicatatkan. Vendor yang mendakwa produk mereka tidak menggunakan data pelanggan untuk latihan model harus mempunyai larangan tersebut didokumenkan dalam terma kontrak yang akan mengawal hubungan tersebut, bukan sekadar dinyatakan dalam perbualan jualan.

Disiplin pengesahan meluas kepada pensijilan itu sendiri. Juruaudit SOC 2 berbeza dalam kualiti dan ketelitian. Laporan audit daripada firma yang diiktiraf dengan kepakaran sektor teknologi yang terbukti memberikan bukti yang lebih kuat berbanding daripada firma yang tidak dikenali dengan sejarah audit teknologi yang terhad. Tempoh laporan adalah penting kerana laporan yang meliputi tempoh audit yang sangat pendek mungkin mencerminkan audit kali pertama yang direka untuk memperoleh pensijilan dengan pantas dan bukannya program keselamatan yang matang dan mampan.

Menyemak bagaimana dokumentasi [AI architecture](https://trigger.fish/architecture/) daripada vendor menerangkan kawalan keselamatan mereka membantu penilai menilai sama ada seni bina teknikal yang dikemukakan adalah koheren dan boleh dipertahankan atau sama ada ia menerangkan keselamatan pada tahap abstraksi yang menyembunyikan jurang yang bermakna.

## **Soalan Khusus AI yang Paling Penting**

### **Apa yang Perlu Ditanya tentang Penggunaan Data Latihan**

Soalan penggunaan data latihan memerlukan ketepatan yang lebih daripada jawapan ya-atau-tidak kerana amalan yang menimbulkan risiko yang bermakna adalah lebih khusus daripada apa yang ditangkap soalan umum. Vendor yang menjawab bahawa mereka tidak menggunakan data pelanggan untuk latihan mungkin bermaksud sesuatu yang lebih sempit daripada yang disiratkan oleh soalan tersebut.

Tanya sama ada kandungan perbualan, termasuk prompt dan respons, digunakan untuk latihan model atau fine-tuning dalam apa-apa keadaan, termasuk dengan persetujuan pelanggan yang diperoleh melalui terma perkhidmatan. Tanya sama ada versi data pelanggan yang teragregat atau dinyahnamakan menyumbang kepada peningkatan model. Tanya sama ada larangan terpakai kepada semua peringkat produk atau hanya kepada peringkat enterprise yang sedang dinilai. Tanya sama ada larangan adalah mutlak atau sama ada ia boleh diketepikan oleh perjanjian pelanggan. Dan tanya bagaimana larangan dikuatkuasakan secara teknikal, bukan sekadar secara kontrak, kerana larangan kontrak yang tidak dikuatkuasakan secara teknikal bergantung sepenuhnya pada pematuhan operasi vendor dan bukannya jaminan seni bina.

Jawapan kepada soalan susulan khusus ini sering mendedahkan bahawa amalan penggunaan data latihan adalah lebih bernuansa daripada yang dicadangkan kenyataan vendor awal, dan bahawa perlindungan yang tersedia pada peringkat enterprise yang sedang dinilai organisasi mungkin berbeza daripada terma produk standard dalam cara yang penting bagi kes guna khusus yang sedang dinilai.

### **Apa yang Perlu Ditanya tentang Infrastruktur Inferens dan Pemastautinan Data**

Soalan infrastruktur untuk sistem AI memerlukan bertanya secara berasingan di mana pemberat model disimpan, di mana inferens berlaku secara komputasi, di mana data input diproses, di mana data output dan log disimpan, dan di mana setiap perkara ini berlaku dalam konteks peringkat produk khusus yang sedang diaplikasikan dan bukannya infrastruktur vendor secara umum.

Bagi organisasi yang mempunyai obligasi pemastautinan data, soalan lokasi inferens selalunya lebih segera penting daripada soalan lokasi penyimpanan kerana rangka kerja kawal selia yang mendorong keperluan pemastautinan dalam kebanyakan bidang kuasa menganggap bidang kuasa pemprosesan setara dengan bidang kuasa penyimpanan. Vendor yang infrastruktur penyimpanannya terletak di bidang kuasa yang diperlukan tetapi pemprosesan inferensnya berlaku di tempat lain tidak memenuhi keperluan pemastautinan walaupun kawalan penyimpanan adalah sepenuhnya patuh.

Minta vendor menyediakan gambar rajah aliran data yang menjejak data organisasi daripada penyerahan melalui inferens, output, log sehingga pemadaman, dengan lokasi fizikal setiap peringkat ditunjukkan dengan jelas. Jika vendor tidak boleh menghasilkan dokumentasi ini, jurang dalam pemahaman mereka sendiri terhadap aliran data mereka itu sendiri adalah penemuan keselamatan yang bermakna.



![AI agent](/blog/images/security-team-review.jpg)

### **Apa yang Perlu Ditanya tentang Kemas Kini Model dan Perubahan Tingkah Laku**

Vendor AI mengemas kini model dasar mereka mengikut jadual yang tidak selalu disampaikan kepada pelanggan terlebih dahulu. Kemas kini model boleh mengubah tingkah laku sistem AI dalam cara yang menjejaskan postur keselamatannya, pematuhannya terhadap keperluan penggunaan boleh terima pelanggan, atau kualiti outputnya bagi kes guna khusus yang pelanggan telah aplikasikannya.

Tanya bagaimana vendor memaklumkan pelanggan tentang kemas kini model yang menjejaskan tingkah laku yang berkaitan dengan keselamatan atau pematuhan. Tanya sama ada pelanggan enterprise mempunyai pilihan untuk kekal pada versi model tertentu dan bukannya menerima kemas kini automatik. Tanya bagaimana vendor menguji kemas kini model untuk regresi keselamatan sebelum mengaplikasikannya kepada persekitaran pelanggan. Dan tanya apakah rekursa pelanggan jika kemas kini model mengubah tingkah laku dalam cara yang menjejaskan pematuhan atau keselamatan dalam aplikasi pelanggan.

Jawapan mendedahkan tahap kawalan yang akan dimiliki organisasi ke atas komponen teras sistem AI yang diaplikasikannya dan falsafah vendor tentang penyertaan pelanggan dalam kitaran hayat model. Organisasi yang sistem AInya diaplikasikan digunakan dalam konteks yang dikawal selia atau sokongan keputusan berkepentingan tinggi mempunyai kepentingan yang lebih kuat dalam kestabilan model dan pemberitahuan kemas kini berbanding mereka yang menggunakan AI untuk aplikasi produktiviti berkepentingan rendah.

## **Perlindungan Kontrak yang Mesti Ditetapkan oleh Penilaian**

### **Perjanjian yang Perlu Dimeterai Sebelum Data Mengalir**

Fasa kontrak penilaian keselamatan vendor AI menterjemahkan penemuan teknikal dan tadbir urus kepada perlindungan yang boleh dikuatkuasakan secara undang-undang. Kawalan teknikal melindungi data pada infrastruktur vendor. Perlindungan kontrak menetapkan obligasi undang-undang yang mengawal cara infrastruktur tersebut dikendalikan dan apakah remedi yang dimiliki organisasi apabila obligasi tidak dipenuhi.

Perjanjian pemprosesan data yang meliputi produk AI khusus yang sedang diaplikasikan adalah keperluan kontrak asas bagi mana-mana vendor yang memproses data peribadi tertakluk kepada GDPR, CCPA atau rangka kerja yang setara. DPA perlu menangani secara eksplisit larangan data latihan, had pengekalan mengikut kategori, obligasi pengurusan subpemproses, jadual masa pemadaman data, dan keperluan pemberitahuan pelanggaran. Templat DPA vendor yang digubal untuk perkhidmatan awan umum mungkin tidak menangani secukupnya pertimbangan khusus AI yang penilaian telah kenal pasti sebagai berkaitan.

Bagi organisasi penjagaan kesihatan, Business Associate Agreement adalah prasyarat undang-undang sebelum sebarang data yang boleh membentuk maklumat kesihatan terlindung mengalir melalui sistem AI vendor. BAA perlu meliputi produk khusus yang sedang diaplikasikan, bukan sekadar infrastruktur vendor secara umum, dan perlu mengesahkan bahawa amalan pengendalian data produk AI adalah konsisten dengan keperluan perlindungan teknikal HIPAA.

Memahami bagaimana [AI features](https://trigger.fish/features/) dalam platform AI enterprise distrukturkan berhubung dengan perlindungan kontrak yang sedang dirundingkan membantu organisasi mengenal pasti di mana tingkah laku produk dan terma kontrak adalah konsisten dan di mana realiti teknikal produk memerlukan kekhususan kontrak tambahan untuk mencapai perlindungan yang diperlukan organisasi.


<table>
  <thead>
    <tr>
      <th>Perjanjian yang Diperlukan</th>
      <th>Bila Terpakai</th>
      <th>Terma Kritikal untuk AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Perjanjian Pemprosesan Data</td>
      <td>Sebarang pemprosesan data peribadi di bawah GDPR atau setara</td>
      <td>Larangan data latihan, had pengekalan, senarai subpemproses</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Sebarang pemprosesan PHI di bawah HIPAA</td>
      <td>Liputan khusus produk, pengesahan perlindungan teknikal</td>
    </tr>
    <tr>
      <td>Master Services Agreement</td>
      <td>Semua hubungan vendor komersial</td>
      <td>Peruntukan liabiliti, remedi pelanggaran, pemulangan data pada penamatan</td>
    </tr>
    <tr>
      <td>Lampiran Keselamatan</td>
      <td>Konteks pemprosesan data berkepekaan tinggi</td>
      <td>Obligasi keselamatan khusus melampaui terma standard</td>
    </tr>
    <tr>
      <td>Dokumentasi Risiko Model</td>
      <td>AI dalam aktiviti kewangan yang dikawal selia</td>
      <td>Dokumentasi model, hak pengesahan, pemberitahuan kemas kini</td>
    </tr>
    <tr>
      <td>Perjanjian Tanpa Pendedahan</td>
      <td>Proses penilaian itu sendiri dan penemuan sensitif</td>
      <td>Skop yang meliputi metodologi penilaian dan keperluan organisasi</td>
    </tr>
  </tbody>
</table>



### **Berunding Melangkaui Terma Standard**

Kebanyakan perjanjian vendor AI enterprise bermula dengan terma standard yang digubal untuk memihak kepada vendor. Proses penilaian harus mengenal pasti terma khusus yang memerlukan modifikasi berdasarkan penemuan keselamatan dan keperluan pematuhan organisasi, dan bukannya berunding terhadap terma standard secara keseluruhan tanpa pengutamaan.

Terma dengan keutamaan tertinggi untuk perundingan adalah yang paling langsung menjejaskan risiko keselamatan dan pematuhan yang dikenal pasti penilaian. Klausa penggunaan data latihan yang membenarkan penggunaan yang organisasi perlukan dilarang. Had liabiliti yang tidak mencukupi untuk kategori data yang sedang diproses. Jadual masa pemberitahuan pelanggaran yang tidak memenuhi keperluan kawal selia. Hak kelulusan subpemproses yang memberikan vendor lebih banyak fleksibiliti untuk menukar infrastruktur mereka daripada yang boleh diterima oleh keperluan pematuhan organisasi.

Organisasi dengan leverage perolehan yang ketara, sama ada melalui saiz perjanjian, nilai jenama, atau kedudukan pasaran, sering mencapai penambahbaikan yang bermakna kepada terma vendor AI standard pada titik-titik ini dengan tepat kerana vendor menghargai hubungan tersebut secukupnya untuk menerima keperluan yang melangkaui templat standard mereka. Organisasi dengan leverage terhad kadangkala boleh mencapai hasil yang sama dengan merangka keperluan dalam terma keperluan kawal selia dan bukannya pilihan, kerana vendor mempunyai kepentingan komersial dalam menyokong aplikasi yang patuh yang melangkaui mana-mana hubungan pelanggan individu.

[AI guide](https://trigger.fish/guide/) yang teliti tentang penstrukturan perjanjian vendor AI untuk keselamatan dan pematuhan membantu organisasi membina rangka kerja perundingan yang mengutamakan terma yang paling menjejaskan pendedahan risiko sebenar mereka dan bukannya cuba berunding setiap klausa dengan intensiti yang sama.

## **Membina Penilaian ke dalam Proses yang Boleh Diulang**

### **Aliran Kerja Penilaian yang Boleh Diskalakan**

Organisasi yang menjalankan penilaian keselamatan vendor AI sebagai projek sekali sahaja untuk setiap perolehan AI yang ketara membina pengetahuan institusi yang tidak dipindahkan dengan cekap kepada penilaian yang seterusnya. Organisasi yang membina penilaian sebagai proses yang boleh diulang dengan metodologi yang didokumenkan, templat bukti standard, dan kriteria keputusan yang ditakrifkan membangunkan keupayaan yang menjadikan setiap penilaian lebih pantas dan lebih konsisten daripada yang sebelumnya.

Proses penilaian keselamatan vendor AI yang boleh diulang termasuk soal selidik standard yang dibangunkan khusus untuk vendor AI yang meliputi lima domain penilaian, senarai permintaan dokumen yang menentukan bukti tepat yang diperlukan untuk setiap dakwaan keselamatan utama, rangka kerja pemarkahan atau keputusan yang menterjemahkan penemuan penilaian kepada cadangan aplikasi, proses semakan yang melibatkan pihak berkepentingan yang betul merentasi fungsi keselamatan, undang-undang, pematuhan, dan perniagaan, serta piawaian dokumentasi yang menghasilkan rekod yang berguna untuk tadbir urus dalaman dan peperiksaan kawal selia luaran.

Soal selidik dan senarai permintaan dokumen harus disemak dan dikemas kini sekurang-kurangnya tahunan untuk memasukkan pertimbangan keselamatan khusus AI yang baharu yang telah muncul daripada landskap vendor, persekitaran kawal selia, dan pengalaman aplikasi organisasi sendiri. Alat penilaian yang komprehensif dua belas bulan lalu mungkin mempunyai jurang yang bermakna hari ini apabila landskap ancaman keselamatan AI dan jangkaan kawal selia mengenainya terus berkembang.

### **Penilaian Berterusan Melangkaui Perolehan Awal**

Penilaian keselamatan vendor AI yang dijalankan pada masa perolehan memberikan penilaian satu masa terhadap postur keselamatan vendor. Ia tidak memberikan jaminan berterusan bahawa postur tersebut kekal mencukupi apabila produk vendor berkembang, infrastruktur mereka berubah, pemilikan atau situasi kewangan mereka berubah, atau kerentanan keselamatan baharu muncul dalam timbunan teknologi mereka.

Penilaian berterusan untuk vendor AI yang ketara harus termasuk semakan tahunan pensijilan yang dikemas kini dan dokumentasi keselamatan, semakan sebarang pendedahan insiden keselamatan atau pemberitahuan pelanggaran daripada vendor, penilaian perubahan material kepada terma perkhidmatan vendor atau dasar privasi yang menjejaskan amalan pengendalian data yang dinilai penilaian awal, dan semakan sebarang perubahan ketara kepada produk AI, infrastruktur, atau pemilikan vendor yang mungkin menjejaskan andaian keselamatan yang mendasari penilaian awal.

Organisasi yang menganggap penilaian keselamatan vendor AI sebagai titik semakan perolehan dan bukannya amalan pengurusan hubungan berterusan mengumpulkan penyimpangan beransur-ansur antara andaian keselamatan terdokumen mereka dan postur keselamatan vendor sebenar yang menjadikan penemuan insiden begitu mahal berbanding pemantauan proaktif.

## **Perkara untuk Diketahui**

Beberapa realiti penting tentang penilaian keselamatan vendor AI yang organisasi secara konsisten temui apabila program mereka matang:

Skop penilaian perlu sepadan dengan skop aplikasi dengan tepat. Penilaian keselamatan yang meliputi API enterprise vendor tidak memberikan jaminan tentang produk pengguna vendor. Penilaian yang meliputi produk penjanaan teks vendor tidak meliputi produk penjanaan imej mereka walaupun kedua-duanya membawa nama jenama yang sama. Takrifkan produk khusus, peringkat, dan konfigurasi aplikasi yang sedang dinilai dan sahkan bahawa setiap pensijilan dan perlindungan kontrak yang disemak meliputi skop khusus tersebut.

Perbualan dengan pelanggan rujukan menambah semakan dokumen dalam cara yang tidak dapat direplikasi oleh dokumentasi. Berbual dengan organisasi yang serupa saiz, industri, dan profil kawal selia yang telah mengaplikasikan produk AI vendor yang sama memberikan pandangan kualitatif tentang responsif vendor, amalan pengendalian data sebenar berbanding yang terdokumen, dan pengalaman praktikal mengendalikan hubungan vendor yang tidak ditangkap oleh sebarang semakan dokumen.

Kestabilan kewangan vendor adalah dimensi penilaian keselamatan yang sah. Vendor AI yang menghentikan operasi mencipta cabaran kemudahalihan data, pemadaman, dan jejak audit yang boleh menjadi masalah pematuhan. Menilai kesihatan kewangan vendor, landasan pembiayaan, dan kedudukan pasaran adalah sesuai untuk vendor AI yang sedang dipertimbangkan untuk aplikasi pengeluaran yang ketara, terutamanya yang mana data yang diekstrak atau dilatih mencipta kebergantungan berterusan.

Prinsip 30% terpakai kepada peruntukan usaha penilaian. Lebih kurang 30% usaha penilaian harus pergi kepada domain keselamatan teknikal yang proses penilaian paling biasa terlebih melabur berbanding dengan sumbangan risiko sebenarnya. 70% yang baki harus meliputi tadbir urus data, perlindungan kontrak, risiko khusus AI, dan dimensi keselamatan operasi yang mendedahkan pembeza paling bermakna antara vendor yang pensijilan mereka kelihatan serupa di permukaan.

Penemuan penilaian perlu disampaikan kepada pihak berkepentingan perniagaan dalam terma risiko dan bukannya bahasa teknikal. Penemuan bahawa skop audit SOC 2 vendor mengecualikan infrastruktur inferens AI adalah tepat secara teknikal tetapi tidak boleh dilaksanakan untuk pembuat keputusan perniagaan tanpa terjemahan kepada terma risiko perniagaan. Penemuan bahawa vendor tidak mengesahkan secara bebas keselamatan sistem yang akan memproses data anda yang paling sensitif adalah penemuan yang sama dalam bahasa yang menghasilkan keputusan.

Pencetus penilaian semula perlu ditakrifkan terlebih dahulu. Peristiwa khusus yang harus mendorong penilaian keselamatan vendor AI baharu atau separa, termasuk insiden vendor yang ketara, perubahan terma perkhidmatan material, pemerolehan vendor atau perubahan pemilikan, dan perubahan seni bina produk yang ketara, harus ditakrifkan dalam proses penilaian dan bukannya ditentukan ad hoc apabila peristiwa tersebut berlaku.

## **Penilaian Keselamatan Vendor AI sebagai Alat Pemilihan Kompetitif**

Organisasi yang menjalankan penilaian keselamatan vendor AI yang teliti secara konsisten mendapati bahawa proses tersebut melakukan lebih daripada sekadar mengenal pasti vendor yang tidak boleh diterima. Ia mendedahkan pembezaan bermakna antara vendor yang pensijilan dan pemasaran kelihatan serupa tetapi yang amalan keselamatan sebenarnya berbeza dengan ketara apabila diperiksa pada tahap bukti dan bukannya dakwaan.

Pembezaan tersebut berguna secara komersial melangkaui nilai pengurusan risikonya. Vendor yang melabur dalam infrastruktur keselamatan tulen, mengekalkan pensijilan semasa dan komprehensif, mengendalikan amalan pengendalian data telus, dan menyokong perlindungan kontrak yang diperlukan oleh organisasi yang dikawal selia telah menjadikan keselamatan sebagai aset kompetitif dan bukannya kos pematuhan. Mengenal pasti vendor tersebut melalui penilaian yang rigor dan membina hubungan yang berkekalan dengan mereka menghasilkan hasil perolehan yang meningkat nilainya apabila landskap alat AI terus berkembang dan keperluan keselamatan terus mengetatkan.

Penilaian keselamatan vendor AI adalah di mana komitmen kepada penerimaan AI yang bertanggungjawab bertemu realiti operasi memilih siapa yang akan dipercayai dengan data yang paling penting. Organisasi yang melakukan kerja itu dengan teliti, konsisten, dan dengan piawaian bukti yang sewajarnya membina hubungan vendor yang menyokong cita-cita AI mereka dan bukannya mencipta liabiliti tidak ditemui yang ditinggalkan oleh penilaian yang tidak mencukupi tidak dapat dielakkan.

## **Soalan Lazim**

### **Bagaimana untuk menilai vendor AI?**

**Menilai vendor AI memerlukan penilaian berstruktur merentasi lima domain: kawalan keselamatan teknikal yang disahkan melalui dokumen pensijilan semasa, amalan tadbir urus data yang meliputi penggunaan data latihan dan pengekalan yang disahkan melalui terma kontrak, skop dan kesemasaan pensijilan pematuhan yang disahkan melalui laporan sebenar dan bukannya kenyataan vendor, pertimbangan keselamatan khusus AI termasuk kawalan prompt injection dan amalan kemas kini model, serta keselamatan operasi yang meliputi amalan keselamatan organisasi vendor dan sejarah insiden.** Penilaian menghasilkan keputusan aplikasi berdasarkan bukti dan bukannya dakwaan vendor, dengan perlindungan kontrak ditetapkan sebelum sebarang data organisasi mengalir melalui sistem vendor.

### **Apakah penilaian keselamatan menggunakan AI?**

**Penilaian keselamatan menggunakan AI merujuk kepada penggunaan alat kecerdasan buatan untuk meningkatkan kecekapan dan liputan proses penilaian keselamatan, termasuk menggunakan AI untuk menganalisis dokumentasi vendor untuk klausa yang berkaitan dengan keselamatan, mengautomasikan analisis respons soal selidik merentasi beberapa serahan vendor, memantau pendedahan keselamatan vendor dan pemberitahuan insiden secara berterusan, dan mengenal pasti corak dalam data postur keselamatan vendor yang akan terlepas oleh proses semakan manual.** Ia berbeza daripada penilaian keselamatan vendor AI, yang menilai keselamatan alat AI itu sendiri, walaupun organisasi dengan program keselamatan yang matang semakin menggunakan AI untuk meningkatkan kedua-dua proses penilaian vendor AI mereka dan keupayaan penilaian keselamatan yang lebih luas.

### **Apakah penilaian keselamatan vendor?**

**Penilaian keselamatan vendor adalah penilaian berstruktur kawalan keselamatan, amalan pengendalian data, pensijilan pematuhan, dan perlindungan kontrak penyedia teknologi pihak ketiga sebelum vendor tersebut diberikan akses kepada data organisasi atau diintegrasikan ke dalam sistem perniagaan.** Bagi vendor AI khususnya, penilaian melangkaui penilaian keselamatan vendor konvensional untuk menangani risiko khusus AI berkenaan penggunaan data latihan, bidang kuasa infrastruktur inferens, amalan kemas kini model, dan permukaan serangan khusus AI yang soal selidik vendor IT standard tidak direka untuk mendedahkan.

### **Apakah langkah-langkah yang boleh diambil untuk memastikan pembekal AI selamat?**

**Lima langkah paling penting untuk memastikan pembekal AI selamat adalah menuntut dokumen pensijilan SOC 2 Type 2 semasa atau setara yang meliputi produk dan infrastruktur khusus yang sedang diaplikasikan, memperoleh perjanjian pemprosesan data yang ditandatangani dengan larangan data latihan yang eksplisit dan had pengekalan yang ditakrifkan sebelum sebarang data organisasi diproses, mengesahkan bahawa infrastruktur inferens terletak di bidang kuasa yang memenuhi keperluan pemastautinan data yang berkenaan, mengesahkan melalui terma kontrak dan dokumentasi teknikal bahawa kawalan keselamatan vendor menangani risiko khusus AI termasuk prompt injection dan pengekstrakan model, serta menubuhkan proses pemantauan vendor berterusan yang menyemak pembaharuan pensijilan, pendedahan insiden, dan perubahan material kepada terma perkhidmatan dalam kitaran tahunan yang ditakrifkan.** Bersama-sama langkah-langkah ini mencipta hubungan keselamatan dengan pembekal AI yang berdasarkan bukti yang disahkan dan obligasi yang boleh dikuatkuasakan dan bukannya dakwaan yang tidak disahkan dan niat baik yang diandaikan.

### **Apakah 5 langkah keselamatan?**

**Lima langkah keselamatan asas yang terpakai merentasi hubungan vendor AI adalah penyulitan data dalam transit dan ketika rehat menggunakan piawaian semasa dengan amalan pengurusan kunci yang didokumenkan, kawalan akses yang mengehadkan siapa di organisasi vendor yang boleh mengakses data organisasi dan dalam keadaan apa, log komprehensif semua peristiwa akses dan pemprosesan data dengan tempoh pengekalan yang menyokong penyiasatan insiden, amalan pengurusan kelemahan termasuk ujian keselamatan berkala dan jadual masa pemulihan yang ditakrifkan untuk kelemahan yang dikenal pasti, serta proses pemberitahuan pelanggaran yang mengikat vendor kepada pendedahan tepat pada masanya dengan jadual masa khusus yang memenuhi obligasi pemberitahuan kawal selia organisasi.** Lima langkah ini mewakili garis dasar keselamatan teknikal yang harus disahkan melalui bukti bagi setiap vendor AI yang dinilai untuk tanggungjawab pemprosesan data yang ketara, dengan dimensi penilaian khusus AI berlapis di atas asas keselamatan konvensional ini.
