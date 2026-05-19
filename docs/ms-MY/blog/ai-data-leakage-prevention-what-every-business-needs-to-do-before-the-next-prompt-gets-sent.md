---
title: "Pencegahan Kebocoran Data AI: Apa yang Perlu Dilakukan oleh Setiap Perniagaan Sebelum Prompt Seterusnya Dihantar"
date: 2026-04-03
description: Pencegahan kebocoran data AI melindungi maklumat perniagaan sensitif
  daripada pendedahan melalui alat AI. Inilah penyebabnya, di mana ia berlaku,
  dan cara untuk menghentikannya.
author: triggerfish
tags:
  - AI agent
draft: false
---
Pencegahan kebocoran data AI merujuk kepada dasar, kawalan teknikal, dan amalan organisasi yang menghentikan maklumat perniagaan sensitif daripada didedahkan, disimpan, atau disalahgunakan apabila pekerja dan sistem berinteraksi dengan alat kecerdasan buatan. Ia menangani satu kategori kehilangan data yang tidak direka untuk ditangkap oleh alat pencegahan tradisional.

Masalah ini kelihatan mudah dari segi mekaniknya dan kelihatan meluas dari segi kejadiannya. Seorang pekerja menampal kontrak pelanggan ke dalam alat AI untuk mendapatkan ringkasan. Seorang pembangun memasukkan kod sumber proprietari ke dalam pembantu pengkodan untuk membaiki pepijat. Seorang ahli pasukan kewangan menyerahkan draf laporan pendapatan kepada alat penulisan AI untuk disempurnakan. Dalam setiap kes, pekerja mencapai sesuatu yang berguna. Dalam setiap kes, data organisasi sensitif berpindah ke infrastruktur yang tidak dikawal oleh organisasi, di bawah terma perkhidmatan yang tidak pernah dibaca oleh pekerja, dengan amalan pengekalan dan penggunaan yang mungkin termasuk latihan model atas kandungan tersebut. Tiada firewall yang menandakannya. Tiada amaran DLP yang dipicu. Tiada log audit yang menangkapnya dalam bentuk yang boleh ditindaki oleh pasukan pematuhan. Itulah masalah kebocoran data AI, dan ia sedang berlaku di seluruh organisasi pelbagai saiz dan industri pada skala yang kebanyakan program keselamatan masih belum mengejarnya. Panduan ini menerangkan apa yang memandu kebocoran data AI, di mana ia mencipta pendedahan paling serius, dan apa yang perlu dipasang oleh organisasi untuk mencegahnya.



![AI agent](/blog/images/submitting.jpg)

## **Memahami Mengapa Alat AI Mencipta Kategori Kebocoran Data Tersendiri**

### **Saluran Yang Memintas Kawalan Sedia Ada**

Alat pencegahan kehilangan data tradisional berfungsi dengan memantau saluran data yang diketahui dan menggunakan peraturan untuk mengesan kandungan sensitif yang bergerak melaluinya. Lampiran e-mel diimbas. Pemindahan fail ke storan awan disemak. Penulisan peranti USB dilog. Kawalan ini mencerminkan model pergerakan data yang tepat sebelum alat AI menjadi sebahagian standard tempat kerja.

Alat AI mewakili saluran data yang kebanyakan seni bina DLP sedia ada tidak mengklasifikasikan atau memantau dengan betul. Dari perspektif trafik rangkaian, seorang pekerja yang menyerahkan dokumen sulit kepada alat AI kelihatan serupa dengan pekerja yang menggunakan mana-mana aplikasi web lain. Permintaan HTTPS ke pelayan alat AI tidak dapat dibezakan pada lapisan rangkaian daripada permintaan kepada aplikasi produktiviti, pangkalan data penyelidikan, atau laman berita. Alat DLP melihat trafik web yang dibenarkan. Pasukan keselamatan tidak melihat apa-apa. Data sensitif telah meninggalkan bangunan.

Jurang seni bina inilah sebabnya pencegahan kebocoran data AI memerlukan perhatian khusus dan bukannya andaian bahawa kawalan sedia ada merangkuminya. Model ancaman adalah berbeza, saluran data adalah berbeza, dan kawalan yang diperlukan untuk menanganinya berbeza daripada yang menangani senario kehilangan data konvensional.

### **Apa Yang Berlaku kepada Data Selepas Memasuki Alat AI**

Risiko kebocoran data tertentu bergantung pada apa yang dilakukan oleh penjual AI dengan data yang diserahkan kepada sistem mereka, yang sangat berbeza antara penjual, produk, dan peringkat. Memahami julat amalan membantu organisasi mengkalibrasi usaha pencegahan mereka di sekitar risiko sebenar dan bukannya kebimbangan umum.

Penggunaan latihan model adalah risiko yang paling langsung mengubah peristiwa pendedahan data menjadi masalah kebocoran berterusan. Apabila terma perkhidmatan penjual membenarkan penggunaan kandungan yang diserahkan untuk meningkatkan model mereka, data tidak hanya melalui sistem mereka sementara. Ia berpotensi mempengaruhi output masa depan model dalam cara yang boleh memunculkan serpihan maklumat tersebut dalam respons kepada pengguna lain. Perjanjian perusahaan dengan penjual utama melarang ini sebagai terma standard, tetapi peringkat pengguna dan percuma biasanya membenarkannya, dan pekerja yang menggunakan akaun peribadi untuk tugas kerja biasanya beroperasi di bawah terma pengguna.

Pengekalan log inferens mencipta tetingkap pendedahan terhad masa dan bukannya risiko latihan berterusan. Kebanyakan penjual AI mengekalkan log pertanyaan dan respons untuk tempoh yang ditakrifkan bagi tujuan penyahpepijatan, jaminan kualiti, dan pematuhan undang-undang. Sepanjang tempoh pengekalan tersebut, data sensitif yang diserahkan dalam pertanyaan tersebut wujud di infrastruktur penjual dan berpotensi diakses oleh kakitangan penjual, tertakluk kepada kawalan keselamatan penjual sendiri, dan berpotensi responsif kepada proses undang-undang yang diarahkan kepada penjual.

Pemindahan data merentas sempadan berlaku apabila infrastruktur inferens AI terletak di bidang kuasa yang berbeza daripada organisasi yang menyerahkan data. Bagi organisasi dengan obligasi kediaman data, ini mencipta pendedahan pematuhan bebas daripada sebarang kegagalan keselamatan. Data mungkin selamat secara teknikal di infrastruktur penjual sambil pada masa yang sama melanggar keperluan pengawalseliaan tentang di mana ia boleh diproses.

Memahami bagaimana rangka kerja[ keselamatan AI](https://trigger.fish/security/) menangani setiap kategori risiko pengendalian data khusus ini membantu organisasi membina program pencegahan yang menyasarkan risiko sebenar yang dicipta oleh landskap alat AI mereka dan bukannya kebimbangan kehilangan data generik.



![AI agent](/blog/images/concerned.jpg)

## **Di Mana Kebocoran Data AI Mencipta Pendedahan Paling Serius**

### **Kategori Data Berkawal Selia dan Sulit pada Risiko Tertinggi**

Tidak semua data organisasi membawa risiko kebocoran yang sama. Kategori data yang mencipta pendedahan paling serius apabila ia memasuki sistem AI yang tidak dibenarkan berkongsi ciri biasa: pengendaliannya dikawal oleh obligasi undang-undang, komitmen kontrak, atau kepekaan persaingan yang menjadikan pendedahan tidak dibenarkan mahal dalam cara yang melangkaui kehilangan maklumat segera.

Data peribadi yang tertakluk kepada GDPR, HIPAA, atau rangka kerja setara mencipta pendedahan pengawalseliaan apabila diproses melalui alat AI tanpa asas undang-undang, perjanjian penjual, dan perlindungan teknikal yang diperlukan oleh rangka kerja tersebut. Seorang pekerja tunggal yang menyerahkan hamparan maklumat peribadi pelanggan kepada alat AI pengguna untuk pembersihan data berpotensi telah mencipta pelanggaran data yang boleh dilaporkan di bawah GDPR, pelanggaran Perjanjian Rakan Niaga di bawah HIPAA, dan insiden pematuhan di bawah sebarang bilangan peraturan khusus sektor, semua dalam masa yang diperlukan untuk menampal kandungan ke dalam tetingkap sembang.

Kandungan istimewa secara undang-undang yang diserahkan kepada alat AI mencipta kebimbangan keistimewaan peguam-pelanggan yang pasukan undang-undang di kebanyakan organisasi masih belum sepenuhnya selesaikan. Sama ada pemprosesan alat AI merupakan pendedahan yang melepaskan keistimewaan adalah soalan undang-undang yang berkembang di kebanyakan bidang kuasa, dan sikap organisasi paling selamat adalah menghalang kandungan istimewa daripada mencapai alat AI yang pengendaliannya tidak direka dan dikontrak khusus untuk keperluan sektor undang-undang.

Maklumat teknikal proprietari termasuk kod sumber, spesifikasi produk, algoritma, dan data penyelidikan mewakili kepintaran persaingan yang dilaburkan dengan ketara oleh organisasi untuk melindungi. Pembantu pengkodan AI dan alat analisis dokumen adalah antara alat AI yang paling biasa digunakan dalam organisasi teknologi dan penyelidikan, dan ia juga adalah alat yang paling kerap digunakan dengan tepatnya kategori data yang paling ingin dijauhkan oleh organisasi daripada mencapai sistem luaran.


<table>
  <thead>
    <tr>
      <th>Kategori Data</th>
      <th>Risiko Utama daripada Kebocoran AI</th>
      <th>Akibat Pengawalseliaan atau Undang-undang</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Data Peribadi Pelanggan</td>
      <td>Pemprosesan pihak ketiga tidak dibenarkan</td>
      <td>Notifikasi pelanggaran GDPR, pelanggaran HIPAA, penalti khusus sektor</td>
    </tr>
    <tr>
      <td>Data Peribadi Pekerja</td>
      <td>Pendedahan data HR melalui alat HR AI</td>
      <td>Pelanggaran undang-undang pekerjaan dan perlindungan data</td>
    </tr>
    <tr>
      <td>Kandungan Istimewa Undang-undang</td>
      <td>Pengabaian keistimewaan berpotensi melalui pendedahan</td>
      <td>Kehilangan perlindungan undang-undang untuk perkara sensitif</td>
    </tr>
    <tr>
      <td>Kod Sumber Proprietari</td>
      <td>Pendedahan kepintaran persaingan</td>
      <td>Kehilangan IP, pelanggaran kontrak dengan pelanggan</td>
    </tr>
    <tr>
      <td>Maklumat Draf Kewangan</td>
      <td>Maklumat bahan bukan awam pra-pendedahan</td>
      <td>Pendedahan undang-undang sekuriti, risiko pendedahan terpilih</td>
    </tr>
    <tr>
      <td>Maklumat Sulit Pelanggan</td>
      <td>Pelanggaran obligasi kerahsiaan profesional</td>
      <td>Kerosakan hubungan pelanggan, liabiliti profesional</td>
    </tr>
    <tr>
      <td>Rahsia Perdagangan</td>
      <td>Kepintaran persaingan melalui latihan model</td>
      <td>Kehilangan perlindungan rahsia perdagangan jika didedahkan secara terbuka</td>
    </tr>
  </tbody>
</table>



### **Dimensi AI Bayangan**

Cabaran pencegahan kebocoran data AI yang paling sukar bukanlah alat yang telah diluluskan dan digunakan oleh organisasi di bawah rangka kerja tadbir urus. Ia adalah alat yang digunakan oleh pekerja tanpa pengetahuan atau pengawasan organisasi. AI Bayangan, penggunaan alat AI di luar mana-mana program yang diluluskan, menjana majoriti insiden kebocoran data AI di kebanyakan organisasi kerana ia beroperasi sepenuhnya di luar kawalan yang ditubuhkan oleh program tadbir urus AI.

Penggunaan AI bayangan bukan utamanya kegagalan pematuhan oleh pelaku jahat. Ia adalah respons produktiviti oleh pekerja yang telah menemui bahawa alat AI membantu kerja mereka dan yang telah mengamalkan apa sahaja yang boleh diakses dan bukannya menunggu proses kelulusan organisasi yang mungkin tidak mempunyai garis masa yang jelas. Memahami motivasi tersebut adalah penting untuk mereka bentuk pendekatan pencegahan yang sebenarnya mengurangkan kebocoran dan bukannya memandu penggunaan lebih jauh ke bawah tanah.

Pencegahan AI bayangan yang paling berkesan menggabungkan keterlihatan ke dalam alat AI yang digunakan di seluruh organisasi, program alat yang diluluskan yang jelas dan boleh diakses yang memenuhi keperluan sebenar pekerja, dan saluran pendedahan tanpa hukuman untuk pekerja yang telah menggunakan alat di luar program yang diluluskan. Organisasi yang menjawab AI bayangan terutamanya dengan larangan mendapati bahawa keperluan produktiviti asas terus dipenuhi melalui cara yang semakin kurang dapat dilihat, mencipta pendedahan kebocoran yang lebih besar dan bukannya kurang.

Menyemak bagaimana keputusan[ seni bina AI](https://trigger.fish/architecture/) tentang penggunaan alat AI yang diluluskan mempengaruhi daya tarikan alternatif bayangan membantu organisasi mereka bentuk program yang diluluskan mereka untuk menjadi jalan rintangan paling sedikit dan bukannya jalan geseran pematuhan paling banyak.

## **Kawalan Teknikal dan Organisasi yang Benar-benar Berkesan**

### **Kawalan Teknikal untuk Pencegahan Kebocoran Data AI**

Kawalan teknikal untuk pencegahan kebocoran data AI beroperasi di beberapa lapisan, setiap satu menangani aspek berbeza tentang bagaimana data sensitif mencapai sistem AI. Program berkesan melapisi kawalan ini dan bukannya bergantung pada sebarang pendekatan tunggal.

Kawalan peringkat rangkaian boleh menyekat akses kepada perkhidmatan AI yang tidak diluluskan daripada rangkaian organisasi dan peranti dengan menyekat atau memantau trafik ke domain alat AI yang tidak berada dalam senarai yang diluluskan. Pendekatan ini lebih berkesan pada rangkaian korporat yang diuruskan berbanding persekitaran kerja jauh di mana pekerja mungkin menggunakan rangkaian dan peranti peribadi, dan ia memerlukan penyelenggaraan berterusan apabila alat AI baharu muncul dan alat sedia ada mengubah infrastruktur domain mereka.

Pencegahan kehilangan data titik akhir yang dikonfigurasikan untuk mengenali corak muat naik alat AI dan menggunakan pemeriksaan kandungan kepada data yang diserahkan melalui antara muka AI memanjangkan liputan DLP ke dalam saluran AI yang terlepas oleh seni bina DLP warisan. Ini memerlukan alat DLP yang dikonfigurasikan khusus untuk corak trafik alat AI dan bukannya hanya saluran eksfiltrasi konvensional.

Sambungan pelayar dan kawalan berasaskan ejen yang menguatkuasakan dasar klasifikasi data pada titik penyerahan, menghalang kandungan yang dikelaskan melebihi ambang sensitiviti yang ditakrifkan daripada diserahkan kepada alat AI di luar program yang diluluskan, mewakili pendekatan yang lebih tersasar daripada penyekatan peringkat rangkaian. Kawalan ini boleh dikonfigurasikan untuk memberi amaran kepada pengguna yang menghampiri sempadan dasar dan bukannya hanya menyekat selepas ia dilanggar, mencipta mekanisme penguatan tingkah laku bersama-sama dengan kawalan teknikal.

Produk gerbang AI perusahaan telah muncul sebagai kategori kawalan khusus yang menghala semua trafik AI organisasi melalui lapisan pemeriksaan dan penguatkuasaan dasar berpusat. Produk-produk ini menyediakan keterlihatan ke dalam penggunaan alat AI di seluruh organisasi, menggunakan klasifikasi data dan pemeriksaan kandungan kepada semua penyerahan AI, menguatkuasakan dasar alat yang diluluskan, dan menjana log audit dalam format yang boleh digunakan oleh pasukan pematuhan dan keselamatan.


<table>
  <thead>
    <tr>
      <th>Jenis Kawalan</th>
      <th>Apa Yang Ditangani</th>
      <th>Had</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Penyekatan Rangkaian</td>
      <td>Menghalang akses kepada alat AI tidak diluluskan pada rangkaian korporat</td>
      <td>Tidak berkesan pada rangkaian peribadi dan peranti tidak diurus</td>
    </tr>
    <tr>
      <td>DLP Titik Akhir untuk AI</td>
      <td>Memeriksa kandungan yang diserahkan melalui antara muka AI</td>
      <td>Memerlukan konfigurasi khusus AI melangkaui DLP standard</td>
    </tr>
    <tr>
      <td>Kawalan Sambungan Pelayar</td>
      <td>Penguatkuasaan dasar pada titik penyerahan AI</td>
      <td>Liputan terhad kepada persekitaran pelayar yang diurus</td>
    </tr>
    <tr>
      <td>Gerbang AI Perusahaan</td>
      <td>Keterlihatan berpusat, pemeriksaan, dan penguatkuasaan dasar</td>
      <td>Memerlukan penghalaan semua trafik AI melalui infrastruktur gerbang</td>
    </tr>
    <tr>
      <td>Label Klasifikasi Data</td>
      <td>Membimbing keputusan pekerja tentang kesesuaian alat AI</td>
      <td>Bergantung pada pematuhan pekerja dan bukannya penguatkuasaan teknikal</td>
    </tr>
    <tr>
      <td>Kawalan Akses Zero Trust</td>
      <td>Mengehadkan akses alat AI kepada pengguna yang dibenarkan dalam konteks yang ditakrifkan</td>
      <td>Tidak menangani kandungan penyerahan yang dibenarkan</td>
    </tr>
  </tbody>
</table>



### **Kawalan Organisasi yang Melengkapi Pencegahan Teknikal**

Kawalan teknikal mengurangkan kebocoran melalui penguatkuasaan automatik. Kawalan organisasi mengurangkan kebocoran melalui pertimbangan dan tingkah laku pekerja yang menentukan sama ada kawalan teknikal dipintas, dilangkau, atau benar-benar disepadukan ke dalam cara kerja dilakukan.

Dasar klasifikasi data yang jelas yang memetakan tahap sensitiviti kepada persekitaran pemprosesan AI yang dibenarkan memberi pekerja peraturan keputusan yang boleh mereka gunakan secara konsisten tanpa merujuk dokumen dasar untuk setiap tugas. Apabila pekerja tahu bahawa data yang dikelaskan sebagai sulit hanya boleh diproses melalui alat AI dalam premis atau alat awan peringkat perusahaan dengan perjanjian data yang ditandatangani, mereka mempunyai panduan yang boleh diambil tindakan dan bukannya arahan kabur untuk berhati-hati.

Latihan yang menggunakan senario konkrit dan khusus peranan dan bukannya kandungan kesedaran perlindungan data generik menghasilkan perubahan tingkah laku yang tidak dilakukan oleh latihan abstrak. Seorang jurutera yang boleh menerangkan apa yang berlaku kepada kod sumber yang diserahkan kepada pembantu pengkodan popular di bawah terma perkhidmatan lalainya mempunyai pengetahuan praktikal yang mengubah tingkah laku mereka. Seorang jurutera yang telah menghadiri latihan tentang prinsip perlindungan data mempunyai kesedaran yang mungkin atau mungkin tidak diterjemahkan kepada tingkah laku berbeza apabila tarikh akhir mencipta tekanan untuk menggunakan alat tercepat yang tersedia.

Proses pendedahan insiden yang menganggap pendedahan kali pertama penggunaan AI bayangan masa lalu sebagai peluang pembelajaran dan bukannya pelanggaran pematuhan mencipta keselamatan psikologi yang menggalakkan pekerja untuk memunculkan pendedahan sedia ada dan bukannya menyembunyikannya. Kos organisasi kebocoran yang tidak diketahui adalah lebih tinggi daripada kos kebocoran yang diketahui yang boleh dinilai dan ditangani.

Memahami bagaimana[ ciri AI](https://trigger.fish/features/) dalam alat AI perusahaan yang diluluskan menyampaikan amalan pengendalian data mereka kepada pengguna membantu organisasi membina latihan yang menghubungkan keperluan dasar kepada tingkah laku alat khusus yang dihadapi oleh pekerja dalam amalan dan bukannya menganggap hubungan antara dasar dan alat sebagai sesuatu yang harus dicari oleh pekerja secara bebas.



![AI agent](/blog/images/session.jpg)

## **Membina Program Pencegahan Kebocoran Data AI**

### **Asas Inventori dan Penilaian**

Program pencegahan kebocoran data AI yang berfungsi bermula dengan gambaran tepat tentang alat AI yang digunakan di seluruh organisasi, bukan hanya alat yang telah diluluskan secara rasmi. Jurang antara dua inventori tersebut mentakrifkan skop program pencegahan segera.

Membina inventori alat AI sebenar memerlukan menggabungkan pelbagai sumber data kerana tiada sumber tunggal yang menangkap gambaran penuh. Inventori perisian yang diurus IT menangkap alat yang diperoleh secara rasmi. Analisis trafik rangkaian memunculkan domain yang sedang dicapai oleh trafik alat AI di seluruh organisasi. Tinjauan pekerja dan temu bual jabatan mendedahkan alat yang digunakan oleh pekerja yang tidak pernah dilihat oleh perolehan IT. Inventori sambungan pelayar dan titik akhir mengenal pasti alat AI yang dipasang pada peringkat peranti individu. Inventori lengkap adalah gabungan semua sumber ini, dan ia hampir selalu lebih besar dan lebih bervariasi daripada yang dijangkakan oleh mana-mana organisasi sebelum melakukan latihan tersebut.

Setelah inventori wujud, setiap alat memerlukan penilaian terhadap keperluan keselamatan data yang merangkumi amalan pengendalian data penjual, status pensijilan, ketersediaan perlindungan kontrak, dan kategori data yang sebenarnya digunakan oleh pekerja. Output penilaian adalah klasifikasi peringkat risiko bagi setiap alat AI dalam inventori, daripada diluluskan untuk semua kategori data, diluluskan dengan sekatan, dilarang menunggu semakan, hingga dilarang sepenuhnya.

### **Perlindungan Penjual dan Kontrak**

Program pencegahan yang bergantung hanya pada kawalan tingkah laku dan teknikal tanpa perlindungan kontrak yang sepadan mencipta struktur tadbir urus yang tidak lengkap di asasnya. Kawalan teknikal mengurangkan kemungkinan kebocoran melalui alat yang tidak dibenarkan. Perlindungan kontrak mentakrifkan apa perlindungan yang berlaku apabila alat yang dibenarkan digunakan dan apa rekursa yang dimiliki organisasi apabila perlindungan tersebut tidak dihormati.

Setiap penjual AI yang alatnya memproses data organisasi melebihi peringkat sensitiviti terendah memerlukan perjanjian pemprosesan data yang ditandatangani yang secara eksplisit melarang penggunaan data latihan, mentakrifkan had pengekalan, komited kepada notifikasi pelanggaran dalam tempoh masa yang diperlukan, dan mendokumentasikan kawalan keselamatan yang diaplikasikan kepada data organisasi. Untuk organisasi penjagaan kesihatan, Perjanjian Rakan Niaga yang merangkumi produk AI tertentu adalah prasyarat undang-undang dan bukannya keutamaan kontrak.

Program perlindungan kontrak memerlukan penyelenggaraan sama seperti kawalan teknikal. Penjual mengemas kini terma perkhidmatan mereka. Produk yang dilindungi di bawah satu perjanjian mungkin dipisahkan daripadanya melalui perubahan portfolio produk. Tempoh pensijilan tamat tempoh. Membina kitaran semakan perjanjian penjual tahunan ke dalam program menghalang keadaan di mana data organisasi diproses di bawah perjanjian yang tidak lagi mencerminkan amalan sebenar penjual.

Sebuah[ panduan AI](https://trigger.fish/guide/) yang komprehensif tentang menstrukturkan program pencegahan kebocoran data AI daripada inventori dan penilaian melalui kawalan teknikal dan pengurusan penjual membantu organisasi membina program yang menangani cabaran pencegahan penuh dan bukannya bahagian yang paling kelihatan daripadanya.

## **Perkara Yang Perlu Diketahui**

Beberapa realiti penting tentang pencegahan kebocoran data AI yang sentiasa dihadapi oleh organisasi semasa mereka membina program mereka:

Produk peringkat pengguna daripada penjual AI perusahaan mempunyai amalan pengendalian data yang berbeza daripada produk perusahaan mereka, kadangkala secara dramatik. Keupayaan AI asas yang sama yang diakses melalui akaun peribadi dan melalui akaun perusahaan mungkin mempunyai dasar data latihan, amalan pengekalan, dan ketersediaan perlindungan kontrak yang sama sekali berbeza. Pekerja yang mengakses alat AI perusahaan melalui akaun peribadi kerana akaun organisasi memerlukan kelulusan atau wang menggunakan perlindungan peringkat pengguna pada data kerja tanpa mengenali perbezaannya.

Peraturan 30% untuk AI berguna untuk reka bentuk program pencegahan kebocoran data. Kawalan teknikal automatik harus mengendalikan lebih kurang 30% kerja pencegahan, khusus tugas penguatkuasaan dasar berfrekuensi tinggi yang dikendalikan oleh automasi secara konsisten pada skala. Pertimbangan manusia dan tadbir urus organisasi merangkumi 70% selebihnya yang melibatkan penilaian risiko, penilaian penjual, respons insiden, dan latihan dan pembinaan budaya yang menentukan sama ada kawalan teknikal disepadukan ke dalam cara kerja sebenarnya dilakukan atau dilayan sebagai halangan untuk dielakkan.

Penggunaan alat AI berasaskan pelayar adalah kategori paling sukar untuk dikawal melalui penyekatan peringkat rangkaian sahaja. Pekerja yang bekerja dari jauh di rangkaian peribadi, menggunakan peranti peribadi untuk tugas kerja, atau mengakses alat AI melalui antara muka pelayar yang menyerupai penggunaan web umum mempersembahkan cabaran kawalan yang lebih baik ditangani oleh pendekatan berasaskan titik akhir berbanding berasaskan rangkaian.

Alat AI generatif yang dibenamkan dalam perisian produktiviti yang digunakan secara meluas mencipta pendedahan kebocoran yang tidak kelihatan seperti penggunaan alat AI bagi kebanyakan pekerja. Apabila pemproses kata menggunakan AI untuk mencadangkan penyelesaian teks, hamparan menggunakan AI untuk menafsir entri data, atau klien e-mel menggunakan AI untuk merangka respons, pekerja menggunakan AI tanpa sebarang pembuatan keputusan yang disengajakan yang mungkin menggesa mereka mempertimbangkan klasifikasi data. Program tadbir urus yang menangani hanya alat AI sendiri mempunyai titik buta di sini.

Amaran Stephen Hawking tentang AI tertumpu pada risiko eksistensial daripada sistem superintelijen dan bukannya kebocoran data secara khusus, tetapi kewaspadaan beliau yang lebih luas tentang bergerak lebih cepat dengan keupayaan AI berbanding tadbir urus AI diterjemahkan secara langsung kepada masalah kebocoran data. Organisasi yang menggunakan alat AI lebih cepat daripada kemampuan rangka kerja perlindungan data mereka untuk menyesuaikan diri mencipta tepatnya pendedahan tidak terurus yang ditunjuk oleh kebimbangan umum Hawking tentang tadbir urus AI yang tidak mencukupi. Pelajaran praktikal untuk pencegahan kebocoran data adalah infrastruktur tadbir urus perlu berkembang lebih awal daripada skala penggunaan dan bukannya mengejarnya.

Kualiti jejak audit menentukan sebaik mana organisasi boleh menjawab insiden kebocoran apabila ia berlaku. Mengetahui bahawa seorang pekerja menyerahkan data sensitif kepada alat AI yang tidak dibenarkan adalah berguna. Mengetahui apa data khusus yang diserahkan, bila, apa respons alat AI, dan apa yang dilakukan oleh pekerja dengan respons tersebut adalah apa yang memungkinkan respons insiden yang berkesan. Infrastruktur log untuk pencegahan kebocoran data AI perlu dibina untuk utiliti penyiasatan insiden, bukan hanya kepuasan kotak semak pematuhan.

Pekerja antarabangsa dan pejabat menambah kerumitan kediaman data kepada pencegahan kebocoran. Alat AI yang diluluskan untuk digunakan dengan data perniagaan bukan peribadi dalam satu bidang kuasa mungkin memicu pelanggaran kediaman data apabila digunakan dengan kategori data yang sama dalam bidang kuasa lain. Organisasi multinasional memerlukan program pencegahan kebocoran data yang mengambil kira variasi bidang kuasa dan bukannya menggunakan dasar global seragam tanpa kepekaan geografi.

## **Mencegah Kebocoran Data AI sebagai Disiplin Berterusan**

Pencegahan kebocoran data AI bukanlah projek dengan tarikh penyelesaian. Ia adalah disiplin operasi berterusan yang perlu berkembang seiring dengan landskap alat AI, persekitaran pengawalseliaan, dan jejak AI organisasi yang dikawalnya. Alat yang tidak wujud dua belas bulan lalu kini adalah bahagian standard aliran kerja banyak pekerja. Peraturan yang aspirational setahun lalu adalah keperluan boleh ditegakkan sekarang. Keupayaan AI yang terhad kepada alat sendiri dibenamkan dalam infrastruktur operasi dalam cara yang mengaburkan sempadan antara penggunaan alat AI dan penggunaan sistem biasa.

Organisasi yang membina pencegahan kebocoran data AI sebagai program operasi yang berkekalan, dengan infrastruktur keterlihatan, proses tadbir urus, dan asas budaya yang menjadikannya menguatkan diri dan bukannya bergantung kepada penguatkuasaan, membina perlindungan yang berkompaun seiring waktu. Setiap alat yang diluluskan yang ditambah kepada program mengurangkan daya tarikan alternatif bayangan. Setiap kitaran latihan meningkatkan pertimbangan pekerja tentang klasifikasi data dan pemilihan alat. Setiap semakan perjanjian penjual menangkap pergerakan antara perlindungan yang didokumenkan dan sebenar sebelum ia mencipta pendedahan yang tidak dapat dikesan.

Data yang mengalir melalui alat AI organisasi anda adalah antara maklumat yang paling sensitif yang dijana oleh perniagaan anda, diproses dalam konteks di mana kawalan biasa yang mengawal pengendalian data paling kurang matang. Membina program pencegahan yang melindunginya dengan sewajarnya bukanlah latihan pematuhan. Ia adalah pelaburan keselamatan asas dalam perniagaan dibantu AI yang organisasi anda sudah menjadi.

## **Soalan Lazim**

### **Apakah kebocoran data dalam AI?**

**Kebocoran data dalam AI merujuk kepada pendedahan maklumat organisasi sensitif melalui penggunaan alat AI, berlaku apabila pekerja menyerahkan data sulit kepada sistem AI yang amalan pengendalian data penjual, dasar pengekalan, atau penggunaan data latihan mencipta pendedahan tidak dibenarkan melangkaui tujuan pemprosesan yang dimaksudkan.** Ia berbeza daripada kebocoran data konvensional kerana ia berlaku melalui saluran yang alat DLP sedia ada sering tidak memantau, melalui tindakan pekerja yang sebenarnya produktif dan bukannya cuai atau jahat, dan dengan akibat yang mungkin merangkumi bukan sahaja pendedahan segera tetapi juga pengekodan berterusan maklumat sensitif dalam infrastruktur model penjual.

### **Apakah peraturan 30% untuk AI?**

**Peraturan 30% untuk AI adalah prinsip bahawa sistem AI dan kawalan automatik harus mengendalikan kira-kira 30% daripada aliran kerja atau fungsi program, khususnya tugas berfrekuensi tinggi, tertakrif baik, dan boleh dilaksanakan secara konsisten di mana automasi memberikan kecekapan dan kebolehpercayaan yang jelas, manakala pertimbangan manusia dan tadbir urus merangkumi 70% selebihnya yang melibatkan penilaian kontekstual, keputusan risiko, dan akauntabiliti yang perlu kekal pada manusia dan bukannya sistem automatik.** Dalam pencegahan kebocoran data AI khususnya, ini bermakna kawalan teknikal automatik mengendalikan penguatkuasaan dasar rutin manakala tadbir urus manusia memiliki penilaian risiko, penilaian penjual, respons insiden, dan dimensi budaya dan latihan yang menentukan sama ada kawalan teknikal disepadukan ke dalam tingkah laku sebenar.

### **Apakah amaran Stephen Hawking tentang AI?**

**Amaran utama Stephen Hawking tentang AI berkaitan dengan potensi risiko eksistensial daripada kecerdasan umum buatan yang mengatasi keupayaan kognitif manusia dan mengejar matlamat yang tidak selari dengan kesejahteraan manusia, menyatakan kebimbangan bahawa kemanusiaan bergerak terlalu cepat pada pembangunan keupayaan AI tanpa perhatian yang mencukupi terhadap keselamatan dan tadbir urus.** Walaupun kebimbangan beliau ditujukan kepada risiko eksistensial jangka panjang dan bukannya keselamatan data perniagaan jangka pendek, prinsip tadbir urus asas diterjemahkan secara langsung kepada penggunaan AI praktikal: organisasi yang memajukan keupayaan AI lebih cepat daripada rangka kerja tadbir urus mereka boleh menyesuaikan diri mencipta risiko tidak terurus yang dihasilkan daripada keupayaan tanpa akauntabiliti.

### **Bagaimana untuk menggunakan AI tanpa membocorkan data?**

**Menggunakan AI tanpa membocorkan data memerlukan empat amalan yang diaplikasikan secara konsisten: hanya menyerahkan data yang telah dinilai terhadap kategori data yang diluluskan alat AI sebelum setiap penggunaan, bergantung secara eksklusif pada alat AI peringkat perusahaan dengan perjanjian pemprosesan data yang ditandatangani yang melarang penggunaan data latihan, memahami amalan pengendalian data khusus setiap alat AI yang digunakan untuk tugas kerja termasuk yang dibenamkan dalam perisian produktiviti, dan mengikuti dasar klasifikasi data organisasi yang mentakrifkan tahap sensitiviti mana yang dibenarkan dengan alat AI mana.** Untuk kategori data sensitiviti tertinggi, satu-satunya pendekatan kalis kebocoran sepenuhnya adalah menggunakan alat AI yang digunakan pada infrastruktur peribadi di mana data tidak pernah meninggalkan perimeter rangkaian organisasi sendiri.

### **Apa yang anda tidak patut beritahu ChatGPT?**

**Melalui antara muka pengguna standard ChatGPT, pekerja tidak patut menyerahkan maklumat peribadi pelanggan, rekod pekerja, komunikasi istimewa undang-undang, kod sumber atau algoritma proprietari, draf pendedahan kewangan atau maklumat bahan bukan awam, rahsia perdagangan, maklumat sulit pelanggan, atau sebarang data lain yang pendedahan tidak dibenarkannya akan mencipta akibat undang-undang, pengawalseliaan, persaingan, atau kontrak untuk organisasi.** Versi pengguna ChatGPT beroperasi di bawah terma perkhidmatan yang tidak termasuk perjanjian pemprosesan data, larangan data latihan, dan perlindungan kontrak yang menjadikan alat AI peringkat perusahaan sesuai untuk data perniagaan, yang bermaksud kandungan yang diserahkan melalui akaun peribadi mungkin dikekalkan dan berpotensi digunakan dalam cara yang tidak dapat dikawal atau bahkan ditemui oleh organisasi.
