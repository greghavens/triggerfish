---
title: "Keselamatan AI Zero Trust: Mengapa Pertahanan Perimeter Tradisional Gagal untuk AI dan Apa yang Perlu Dibina Sebagai Gantinya"
date: 2026-04-04
description: Keselamatan AI zero trust menggunakan pengesahan berterusan dan akses keistimewaan paling minimum kepada sistem AI, menganggap setiap model, pengguna dan aliran data sebagai tidak dipercayai secara lalai.
author: triggerfish
tags:
  - AI agent
draft: false
---
Keselamatan AI zero trust ialah penggunaan prinsip zero trust kepada sistem kecerdasan buatan, yang memerlukan setiap pengguna, model, sumber data dan titik integrasi disahkan secara berterusan dan diberikan hanya akses minimum yang diperlukan untuk menjalankan fungsinya, tanpa kepercayaan tersirat yang diperluas berdasarkan lokasi rangkaian atau pengesahan terdahulu. Ia menganggap sistem AI sebagai sasaran bernilai tinggi yang memerlukan kawalan akses ketat yang sama seperti mana-mana infrastruktur istimewa yang lain.

Model perimeter keselamatan tradisional menganggap bahawa ancaman datang dari luar rangkaian dan bahawa sistem di dalamnya boleh dipercayai. Andaian itu sudah pun tertekan sebelum kemunculan AI. Pengerahan AI memecahkannya sepenuhnya. Sistem AI yang disambungkan ke pangkalan data dalaman, e-mel, repositori dokumen dan API luaran beroperasi merentasi sempadan kepercayaan yang tidak boleh ditakrifkan oleh model perimeter, apatah lagi dipertahankan. Ia menerima input dari mana-mana, mengambil kandungan daripada pelbagai sumber, dan mengambil tindakan merentasi sistem bersambung dalam urutan yang tiada model kawalan akses tradisional direka untuk mengawal. Permukaan serangan bukanlah perimeter yang ditakrifkan. Ia ialah keseluruhan set sambungan yang boleh dilalui oleh sistem AI, julat penuh kandungan yang akan diprosesnya, dan skop penuh tindakan yang dibenarkan untuk diambilnya. Keselamatan AI zero trust menangani realiti itu dengan menggantikan andaian perimeter dengan pengesahan berterusan merentasi setiap interaksi, setiap akses data dan setiap tindakan yang dilakukan oleh sistem AI. Panduan ini menerangkan bagaimana prinsip zero trust digunakan khusus kepada pengerahan AI, seperti apa tujuh tonggak dalam konteks AI, dan apa yang perlu dibina oleh organisasi untuk menjadikan model ini berfungsi dalam amalan.



![AI agent](/blog/images/architectural.jpg)

## **Mengapa Keselamatan Perimeter Gagal Khusus untuk Sistem AI**

### **Masalah AI Bersambung**

Aplikasi perusahaan konvensional mempunyai set pengguna yang ditakrifkan, set fungsi yang ditakrifkan, dan set corak akses data yang agak boleh diramal. Pasukan keselamatan boleh membina kawalan akses di sekitar takrifan tersebut, memantau penyelewengan, dan menganggap anomali sebagai isyarat potensi pencerobohan. Kebolehramalan tingkah laku itulah yang menjadikan keselamatan perimeter boleh berfungsi walaupun tidak sempurna.

Sistem AI, terutamanya sistem AI agentik dan yang disambungkan ke saluran perolehan, tidak mempunyai tingkah laku yang boleh diramal dalam erti kata yang sama. Respons mereka berbeza-beza dengan input. Data yang mereka akses bergantung pada apa yang dihasilkan oleh pertanyaan semasa runtime dan bukan pada senarai akses yang ditakrifkan sebelumnya. Tindakan yang mereka ambil melalui alat bersambung bergantung pada tugas yang diberikan kepada mereka dan bukan set fungsi tetap. Keselamatan perimeter yang dibina di sekitar takrifan statik tentang apa yang dilakukan oleh sistem tidak dapat mengikuti realiti dinamik apa yang sebenarnya diakses dan dilaksanakannya.

Serangan prompt injection mengeksploitasi jurang ini secara langsung. Penyerang yang boleh memperkenalkan arahan berniat jahat ke dalam mana-mana kandungan yang diambil atau diterima oleh sistem AI berpotensi mengalihkan tingkah laku sistem secara sepenuhnya, menyebabkannya mengakses data, melaksanakan tindakan, atau mendedahkan maklumat dengan cara yang memintas setiap kawalan perimeter yang mengawal tingkah laku sistem biasa. Serangan tidak melintasi sempadan rangkaian. Ia melintasi sempadan kepercayaan dalam pemprosesan sistem itu sendiri, dalam saluran yang tidak berada dalam kedudukan untuk dipantau oleh pertahanan perimeter.

Keselamatan AI zero trust menangani perkara ini dengan mengalihkan pengesahan daripada perimeter rangkaian kepada setiap interaksi individu. Daripada bertanya sama ada pengguna atau sistem berada dalam rangkaian yang dipercayai, ia bertanya sama ada permintaan khusus ini, daripada identiti khusus ini, untuk sumber khusus ini, pada masa khusus ini, dibenarkan. Soalan itu ditanya secara berterusan, bukan sekali sahaja pada pengesahan.

### **Bagaimana AI Memperkuat Akibat Pelanggaran Kepercayaan**

Sebab mengapa keselamatan AI zero trust lebih penting daripada zero trust untuk aplikasi konvensional bukanlah kerana sistem AI secara semula jadi kurang selamat. Ia kerana akibat pelanggaran kepercayaan dalam sistem AI bersambung diperkuatkan oleh ketersambungan dan autonomi sistem dengan cara yang pelanggaran setara dalam sistem konvensional tidak.

Akaun pengguna yang dikompromi dalam aplikasi konvensional mewujudkan akses kepada apa sahaja yang boleh diakses oleh pengguna tersebut. Agen AI yang dikompromi atau dimanipulasi dengan akses alat yang luas berpotensi melintasi pelbagai sistem bersambung, mengeksfiltrasi data daripada beberapa sumber, dan mengambil tindakan merentasi pelbagai platform dalam satu urutan automatik yang memerlukan usaha penyerang yang meluas untuk meniru secara manual. Automasi yang menjadikan agen AI berharga dalam tugas yang sah juga menjadikannya cekap dalam tugas yang tidak sah apabila tingkah laku mereka dimanipulasi atau aksesnya dieksploitasi.

Keselamatan AI zero trust mengurangkan radius letupan pelanggaran kepercayaan dengan memastikan bahawa walaupun sistem AI yang berjaya dimanipulasi hanya boleh mengakses dan menjejaskan sumber khusus yang telah diberikan kebenaran kepadanya dalam konteks semasa, dan bukannya mewarisi akses luas yang diberikan pada pengesahan dan tidak pernah dikaji semula.

Mengkaji bagaimana keputusan seni bina[ AI security](https://trigger.fish/security/) berkenaan skop akses dan pengesahan berterusan memberi kesan kepada radius letupan praktikal pencerobohan sistem AI membantu organisasi membina pengerahan di mana akibat kegagalan keselamatan adalah terhad dan bukannya tidak terbatas.



![AI agent](/blog/images/enterprise-security.jpg)

## **Tujuh Tonggak Zero Trust Digunakan kepada Sistem AI**

Keselamatan zero trust disusun di sekitar tujuh tonggak yang bersama-sama mentakrifkan seni bina pengesahan dan kawalan yang lengkap. Setiap tonggak mengambil ciri dan keperluan khusus apabila digunakan kepada sistem AI dan bukannya aplikasi konvensional.

### **Tonggak Pertama: Pengesahan Identiti**

Dalam zero trust konvensional, pengesahan identiti merangkumi pengguna manusia dan akaun perkhidmatan. Dalam keselamatan AI zero trust, permukaan identiti berkembang untuk merangkumi model AI itu sendiri sebagai identiti yang perlu disahkan, agen yang bertindak bagi pihak pengguna yang perlu dibezakan daripada pengguna tersebut untuk tujuan kawalan akses, dan akaun perkhidmatan yang digunakan oleh sistem AI untuk mengakses sumber bersambung yang perlu diuruskan dengan ketat yang sama seperti akaun istimewa manusia.

Pengesahan berterusan dan bukannya pengesahan berasaskan sesi adalah piawai zero trust untuk pengguna manusia yang mengakses sistem AI. Pengesahan berbilang faktor, analisis tingkah laku yang memantau corak penggunaan anomali, dan dasar akses sedar konteks yang menyesuaikan keperluan pengesahan berdasarkan sensitiviti apa yang diminta, semuanya digunakan dalam pengerahan sistem AI.

Untuk agen AI yang beroperasi secara autonomi, cabaran identiti adalah mengekalkan prinsip bahawa akses agen adalah berskop kepada tugas khusus yang dilakukannya dan bukannya mewarisi akses penuh pengguna manusia yang memulakannya. Agen yang melaksanakan tugas penyelidikan bagi pihak pengguna harus mempunyai akses penyelidikan, bukan jejak akses lengkap pengguna. Penskopan itu memerlukan seni bina identiti yang jelas dan bukannya pewarisan lalai yang dilaksanakan oleh banyak rangka kerja agen.

### **Tonggak Kedua: Keselamatan Peranti**

Keselamatan peranti dalam konteks AI zero trust merangkumi kedua-dua titik akhir dari mana pengguna mengakses sistem AI dan infrastruktur tempat model AI berjalan. Untuk peranti pengguna, kawalan zero trust standard digunakan, pengesahan kesihatan peranti sebelum akses diberikan, liputan pengesanan dan tindak balas titik akhir, dan dasar akses yang berbeza-beza berdasarkan status pengurusan peranti.

Lapisan infrastruktur memerlukan perhatian khusus kerana perkakasan inferens AI mewakili sasaran bernilai tinggi yang keselamatan titik akhir tradisional tidak direka untuk. Pelayan GPU yang menjalankan model besar mengandungi kedua-dua berat model, yang mewakili harta intelek penting, dan data yang sedang diproses melalui inferens, yang mungkin termasuk maklumat organisasi sensitif. Keselamatan fizikal dan logik infrastruktur inferens AI patut diberikan pengurusan akses istimewa, pemantauan integriti dan pengelogan akses yang sama seperti aset infrastruktur bernilai tinggi yang lain.

### **Tonggak Ketiga: Segmentasi Rangkaian**

Seni bina rangkaian zero trust menggantikan rangkaian rata yang dipercayai dengan zon tersegmen mikro di mana trafik antara segmen memerlukan kebenaran yang jelas dan bukannya mengalir dengan bebas dalam perimeter. Untuk sistem AI, segmentasi rangkaian menentukan komponen mana seni bina AI boleh berkomunikasi dengan yang mana dan sumber luaran mana sistem AI boleh capai.

Pelayan inferens AI harus tersegmen rangkaian daripada sumber yang tidak perlu diaksesnya. Model yang melayani pertanyaan perkhidmatan pelanggan tidak memerlukan akses rangkaian kepada sistem kewangan. Alat AI penyelidikan tidak memerlukan akses kepada pangkalan data HR. Seni bina rangkaian harus menguatkuasakan pemisahan ini dan bukannya bergantung pada tingkah laku sistem AI untuk menghormatinya secara sukarela, kerana prompt injection dan teknik manipulasi lain berpotensi mengatasi sekatan tingkah laku manakala segmentasi rangkaian menguatkuasakannya secara fizikal.

Akses rangkaian luaran untuk sistem AI, termasuk akses kepada carian web, API luaran dan perkhidmatan awan, harus dibenarkan secara jelas melalui allowlists dan bukannya dibenarkan secara lalai dengan pengecualian disekat. Lalai untuk ketersambungan luaran sistem AI dalam seni bina zero trust adalah tiada akses, dengan destinasi tertentu yang dibenarkan ditambah berdasarkan keperluan operasi yang didokumenkan.

### **Tonggak Keempat: Keselamatan Aplikasi**

Keselamatan aplikasi dalam konteks AI zero trust merangkumi keselamatan lapisan aplikasi AI itu sendiri, termasuk infrastruktur prompting, saluran perolehan, integrasi alat, dan logik pengendalian output yang bersama-sama menentukan bagaimana sistem AI memproses permintaan dan menghasilkan respons.

Pengesahan dan sanitasi input pada lapisan aplikasi mewakili prinsip zero trust mengesahkan kandungan, bukan hanya identiti, yang digunakan pada sistem AI. Setiap input yang sampai kepada model, sama ada daripada pengguna, dokumen yang diambil, output alat, atau mesej sistem, harus dianggap berpotensi sebagai musuh dan diproses melalui penapisan yang sesuai dan bukannya dipercayai secara tersirat.

Pengesahan output menggunakan prinsip yang sama secara terbalik. Setiap output yang dihasilkan oleh sistem AI sebelum ia sampai kepada pengguna, sistem bersambung atau proses hiliran harus diperiksa terhadap kriteria yang ditakrifkan yang mengesan kandungan berbahaya, kebocoran data sensitif, dan anomali tingkah laku yang mencadangkan model telah dimanipulasi.

Memahami bagaimana keputusan[ AI architecture](https://trigger.fish/architecture/) pada lapisan aplikasi mempengaruhi pelaksanaan praktikal kawalan input dan output zero trust membantu organisasi membina sistem AI di mana keselamatan tertanam dalam saluran pemprosesan dan bukannya ditambah pada perimeter.



![AI agent](/blog/images/layered-security.jpg)

### **Tonggak Kelima: Keselamatan Data**

Keselamatan data di bawah AI zero trust memerlukan menganggap setiap akses data oleh sistem AI sebagai memerlukan kebenaran yang jelas dan bukannya mewarisi kebenaran yang luas. Tonggak ini adalah di mana pengerahan AI paling langsung memerlukan kawalan zero trust yang dibina khusus kerana seni bina keselamatan data sedia ada tidak direka untuk corak akses data dinamik dan dipacu pertanyaan yang dicipta oleh sistem perolehan AI.

Pengelasan data yang dihormati oleh sistem AI dalam tingkah laku perolehan dan pemprosesan mereka memerlukan integrasi antara infrastruktur tadbir urus data dan lapisan kawalan akses AI. Apabila tahap kebenaran pengguna menentukan dokumen mana yang boleh diakses secara langsung dalam sistem pengurusan dokumen, sistem AI yang mengambil dokumen bagi pihak pengguna itu harus menghormati sempadan kebenaran yang sama, mengembalikan hanya dokumen yang pengguna dibenarkan untuk lihat dan bukannya segala-galanya dalam pangkalan pengetahuan yang berkaitan dengan pertanyaan mereka.

Pengecilan data, prinsip data zero trust teras, memerlukan sistem AI mengakses dan memproses hanya data khusus yang diperlukan untuk tugas semasa. Pembantu AI yang diminta untuk merangka respons e-mel tidak memerlukan akses kepada sejarah pelanggan penuh. Alat AI yang merumuskan dokumen khusus tidak memerlukan akses kepada folder sekeliling. Melaksanakan pengecilan data dalam sistem AI memerlukan kawalan akses yang beroperasi pada tahap data granular dan bukannya pada tahap sistem atau pangkalan data.

Mengkaji bagaimana[ AI features](https://trigger.fish/features/) dalam platform AI perusahaan melaksanakan kawalan akses data dan kebenaran perolehan membantu organisasi menilai sama ada seni bina keselamatan data vendor menyokong prinsip zero trust atau memerlukan kawalan tambahan untuk mencapai kesan yang sama.

### **Tonggak Keenam: Keterlihatan dan Analitik**

Keselamatan zero trust didasarkan pada keupayaan untuk mengesan anomali yang menunjukkan pelanggaran kepercayaan, yang memerlukan keterlihatan menyeluruh ke dalam segala-galanya yang dilakukan oleh sistem AI. Tanpa liputan pengelogan dan pemantauan merentasi setiap interaksi sistem AI, pengesahan zero trust tidak menghasilkan isyarat apabila pelanggaran berlaku kerana bukti yang diperlukan untuk mengesannya tidak wujud.

Untuk sistem AI, keperluan keterlihatan melangkaui pengelogan aplikasi konvensional. Setiap pertanyaan yang dihantar kepada model, setiap dokumen yang diambil melalui saluran RAG, setiap panggilan alat yang dilaksanakan oleh agen, setiap output yang dihasilkan oleh sistem, dan setiap keputusan kawalan akses yang dibuat pada setiap titik pemeriksaan pengesahan perlu ditangkap dalam log yang boleh dipantau dan disiasat oleh pasukan operasi keselamatan.

Analisis tingkah laku yang digunakan pada log aktiviti sistem AI mencipta keupayaan pengesanan anomali yang menjadikan keterlihatan zero trust dapat dilaksanakan. Model garis dasar tingkah laku sistem AI biasa, termasuk corak pertanyaan tipikal, jumlah perolehan biasa dan kekerapan penggunaan alat standard, membolehkan pengesanan penyelewengan yang mungkin menunjukkan prompt injection, percubaan eksfiltrasi data atau corak akses tidak dibenarkan yang akan menjadi tidak kelihatan tanpa titik rujukan tingkah laku.

### **Tonggak Ketujuh: Automasi dan Orkestrasi**

Zero trust pada skala perusahaan tidak boleh dikendalikan secara manual. Keputusan pengesahan, tindak balas anomali dan kemas kini dasar akses yang memerlukan pengesahan berterusan berlaku pada kekerapan dan merentasi kerumitan sistem yang operasi manusia tidak dapat tandingi. Automasi dan orkestrasi, tonggak zero trust terakhir, merangkumi sistem yang menjadikan zero trust beroperasi pada skala dan bukannya teori dalam dokumen seni bina.

Untuk sistem AI khususnya, tindak balas automatik kepada anomali yang dikesan, termasuk pengehadan kadar yang dicetuskan oleh corak pertanyaan luar biasa, sekatan akses yang dicetuskan oleh anomali tingkah laku, dan peningkatan amaran yang dicetuskan oleh tandatangan potensi prompt injection, memberikan kelajuan tindak balas yang menjadikan pengesanan zero trust bermakna. Pengesanan tanpa tindak balas automatik mencipta sistem yang mengenal pasti ancaman lebih cepat daripada manusia boleh bertindak ke atasnya.


<table>
  <thead>
    <tr>
      <th>Tonggak Zero Trust</th>
      <th>Aplikasi Konvensional</th>
      <th>Sambungan Khusus Sistem AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Identiti</td>
      <td>Pengesahan akaun pengguna dan perkhidmatan</td>
      <td>Tambah identiti agen AI, kelayakan tugas berskop</td>
    </tr>
    <tr>
      <td>Peranti</td>
      <td>Kesihatan titik akhir dan status pengurusan</td>
      <td>Tambah integriti infrastruktur inferens AI</td>
    </tr>
    <tr>
      <td>Rangkaian</td>
      <td>Segmentasi mikro antara zon</td>
      <td>Tambah allowlists khusus AI untuk akses luaran</td>
    </tr>
    <tr>
      <td>Aplikasi</td>
      <td>Pengesahan input dan pemantauan output</td>
      <td>Tambah pengesanan prompt injection, penapisan output</td>
    </tr>
    <tr>
      <td>Data</td>
      <td>Kawalan akses berasaskan pengelasan</td>
      <td>Tambah kebenaran perolehan, pengecilan data dalam pertanyaan</td>
    </tr>
    <tr>
      <td>Keterlihatan</td>
      <td>Log aplikasi dan akses</td>
      <td>Tambah log pertanyaan model, perolehan, panggilan alat, dan output</td>
    </tr>
    <tr>
      <td>Automasi</td>
      <td>Penguatkuasaan dasar dan tindak balas anomali</td>
      <td>Tambah analisis tingkah laku dan tindak balas khusus AI</td>
    </tr>
  </tbody>
</table>



## **Membina Keselamatan AI Zero Trust dalam Amalan**

### **Bermula dengan Audit Akses**

Titik permulaan praktikal untuk keselamatan AI zero trust ialah audit jujur tentang apa yang setiap sistem AI dalam pengerahan organisasi boleh akses sekarang berbanding apa yang sebenarnya perlu diaksesnya untuk fungsi yang ditakrifkan. Jurang antara dua inventori itu mentakrifkan kerja pemulihan keistimewaan paling minimum yang membawa pengerahan lebih dekat kepada prinsip zero trust.

Kebanyakan sistem AI, terutamanya yang telah berkembang melalui kerja integrasi berulang, telah mengumpul kebenaran akses yang mencerminkan sejarah apa yang disambungkan dan bukannya penilaian disengajakan apa yang diperlukan. Alat AI penyelidikan yang telah disepadukan dengan e-mel untuk mengambil dokumen rujukan, kemudian disambungkan ke sistem pengurusan dokumen untuk konteks yang lebih luas, kemudian dikaitkan dengan CRM untuk rujukan pelanggan, kini mungkin mempunyai akses merentasi tiga sistem yang masing-masing mengandungi data sensitif jauh melebihi apa yang diperlukan oleh mana-mana tugas penyelidikan khusus.

Audit akses menghasilkan peta keupayaan, setiap sistem yang boleh diakses oleh alat AI, setiap tindakan yang boleh diambilnya, dan setiap kategori data yang boleh diambilnya, bersama-sama dengan peta keperluan operasi, setiap sistem yang sebenarnya diperlukan untuk fungsi yang ditakrifkan, setiap tindakan yang sah memerlukan fungsi tersebut, dan setiap kategori data yang sebenarnya diperlukan oleh fungsi. Pemulihan adalah menutup jurang antara kedua-duanya melalui pengurangan skop akses, segmentasi rangkaian, dan pengerahan corak akses tepat pada masanya untuk keupayaan yang diperlukan oleh sistem sekali-sekala dan bukannya secara berterusan.

### **Melaksanakan Pengesahan Berterusan Tanpa Menjejaskan Prestasi**

Kebimbangan biasa tentang menggunakan prinsip zero trust pada sistem AI adalah bahawa pengesahan berterusan akan memperkenalkan kependaman yang menjejaskan pengalaman pengguna alat AI yang perlu bertindak balas dengan cepat. Kebimbangan ini adalah nyata tetapi boleh diuruskan melalui pilihan seni bina yang menempatkan pengesahan pada titik yang betul dan bukannya menambahkannya secara seragam kepada setiap interaksi.

Pengesahan peringkat sesi untuk akses pengguna yang disahkan mengendalikan majoriti overhed pengesahan identiti manusia dengan satu peristiwa pengesahan dan bukannya setiap pertanyaan. Keputusan kebenaran yang dicache untuk corak akses data yang berulang dengan kerap mengurangkan overhed pengesahan untuk operasi perolehan tanpa meninggalkan keperluan pengesahan. Pengesahan tidak segerak untuk operasi sensitiviti rendah yang boleh bertolak ansur dengan resolusi kebenaran yang sedikit tertangguh mengekalkan jejak audit zero trust tanpa kependaman segerak pada setiap interaksi.

Titik pengesahan yang benar-benar memerlukan tingkah laku menyekat segerak sebelum diteruskan adalah yang mengawal akses data sensitiviti tinggi, tindakan dengan akibat ketara atau tidak dapat dipulihkan, dan anomali tingkah laku yang mencetuskan pemeriksaan teliti yang meningkat. Untuk operasi rutin dalam garis dasar tingkah laku yang ditetapkan, pengesahan boleh dikendalikan dengan cekap tanpa kependaman yang kelihatan oleh pengguna melalui caching yang direka dengan baik dan seni bina tidak segerak.

[AI guide](https://trigger.fish/guide/) menyeluruh tentang melaksanakan seni bina keselamatan AI zero trust yang mengimbangi ketelitian pengesahan dengan prestasi operasi membantu organisasi mengelakkan pilihan palsu antara keselamatan dan kebolehgunaan yang dicipta oleh pelaksanaan yang direka dengan buruk.

**IMAGE SUGGESTION: A developer or security architect at a dual-monitor workstation reviewing access control configuration settings for an AI system deployment, organized technical environment, code or configuration visible on one screen and a system diagram on the other, no readable text visible on either screen.**

## **Perkara yang Perlu Diketahui**

Beberapa realiti penting tentang keselamatan AI zero trust yang dihadapi oleh organisasi ketika mereka beralih daripada prinsip seni bina kepada pelaksanaan operasi:

Zero trust adalah proses berterusan, bukan keadaan pengerahan. Organisasi tidak mencapai zero trust dan mengekalkannya secara pasif. Mereka terus bergerak ke arah zero trust melalui pengurangan skop akses yang berterusan, perluasan liputan pemantauan, dan penambahbaikan seni bina pengesahan. Matlamat adalah berarah dan berterusan dan bukannya keadaan penyiapan yang ditakrifkan.

Integrasi AI warisan adalah sasaran pemulihan zero trust yang paling sukar. Sistem AI yang disepadukan dengan infrastruktur sedia ada sebelum prinsip zero trust digunakan pada pengerahan sering mempunyai corak akses yang secara teknikal sukar untuk diskop tanpa memecahkan fungsi. Memulihkan integrasi ini memerlukan pemahaman kedua-dua keperluan zero trust dan kebergantungan operasi, yang sering bermakna bekerja melalui integrasi satu demi satu dan bukannya menggunakan perubahan dasar yang seragam.

Prinsip 30% digunakan untuk automasi pengesahan zero trust. Kawalan pengesahan automatik harus mengendalikan kira-kira 30% daripada operasi keselamatan, khususnya keputusan akses berasaskan dasar berfrekuensi tinggi dan pemantauan tingkah laku yang dilaksanakan oleh automasi secara konsisten pada skala. Profesional keselamatan dan pemilik tadbir urus mengendalikan 70% selebihnya yang melibatkan penilaian risiko, reka bentuk dasar, penyiasatan anomali, dan keputusan keselamatan intensif penghakiman yang memerlukan akauntabiliti manusia dan bukannya pelaksanaan algoritma.

Zero trust tidak menghapuskan keperluan untuk keselamatan perimeter. Ia berlapis dengan kawalan perimeter dan bukannya menggantikannya. Organisasi yang beralih kepada keselamatan AI zero trust mengekalkan kawalan perimeter rangkaian sambil menambahkan lapisan pengesahan identiti, data dan tingkah laku yang disediakan oleh zero trust. Perimeter menjadi satu lapisan di antara banyak lapisan dan bukannya pertahanan utama.

Kesan pengalaman pengguna pelaksanaan zero trust menentukan kejayaan penerimaan. Seni bina keselamatan yang menjadikan alat AI jauh lebih menyusahkan untuk digunakan memandu pekerja ke arah alternatif AI bayangan yang beroperasi di luar mana-mana kawalan zero trust. Mereka bentuk aliran pengesahan yang sekurang-kurangnya mengganggu untuk penggunaan yang sah sambil mengekalkan kawalan ketat untuk operasi anomali atau berisiko tinggi adalah keperluan kualiti pelaksanaan, bukan peningkatan pilihan.

Sokongan zero trust vendor berbeza dengan ketara merentasi platform AI perusahaan. Beberapa alat AI perusahaan direka dengan titik integrasi zero trust termasuk persekutuan identiti, kawalan akses granular, API pengelogan komprehensif, dan sokongan pemantauan tingkah laku. Yang lain memerlukan infrastruktur tambahan yang ketara untuk mencapai liputan zero trust yang setara. Menilai sokongan zero trust vendor sebagai sebahagian daripada pemilihan alat AI mengurangkan beban pelaksanaan berbanding dengan memasang semula kawalan zero trust ke atas alat yang tidak direka untuknya.

Akauntabiliti bersama antara pasukan keselamatan dan operasi AI adalah penting untuk program keselamatan AI zero trust yang berfungsi dalam amalan. Pasukan keselamatan membawa kepakaran zero trust. Pasukan operasi AI membawa pemahaman tentang tingkah laku sistem AI, kebergantungan integrasi, dan keperluan operasi yang menentukan di mana kawalan pengesahan adalah praktikal dan di mana ia memerlukan penyelesaian seni bina. Program yang direka oleh pasukan keselamatan tanpa input operasi AI cenderung untuk mencipta seni bina keselamatan teori yang gagal dalam pengerahan.

## **Zero Trust sebagai Asas yang Tepat untuk Pengerahan AI yang Yakin**

Keselamatan AI zero trust bukanlah seni bina keselamatan yang paling mudah untuk sistem AI. Ia memerlukan reka bentuk akses yang lebih disengajakan, lebih banyak pelaburan dalam infrastruktur pengesahan, dan lebih banyak disiplin operasi berbanding keselamatan perimeter atau model kepercayaan tersirat. Organisasi yang membuat pelaburan itu secara konsisten mendapati bahawa ia membolehkan dan bukannya mengekang ambisi AI mereka kerana ia mencipta asas keselamatan yang membolehkan sistem AI disambungkan dengan lebih luas, dipercayai dengan lebih mendalam, dan dikerahkan dalam konteks berisiko tinggi berbanding sistem yang beroperasi tanpa ketelitian pengesahan yang setara.

Sistem AI yang akhirnya akan membawa nilai organisasi paling banyak adalah yang dipercayai dengan data paling sensitif, disambungkan ke sistem paling berkesan, dan dibenarkan untuk mengambil tindakan paling berimpak. Keselamatan AI zero trust adalah seni bina yang menjadikan kepercayaan itu boleh dipertahankan dan bukannya bercita-cita, menyediakan pengesahan berterusan, keterlihatan tingkah laku, dan skop akses yang membolehkan organisasi memperluas kepercayaan yang bermakna kepada sistem AI dan bukannya menerima pendedahan sebagai kos keupayaan.

## **Soalan Lazim**

### **Apakah Zero Trust dalam AI?**

**Zero trust dalam AI ialah penggunaan prinsip pengesahan berterusan dan akses keistimewaan paling minimum kepada sistem kecerdasan buatan, yang memerlukan setiap pengguna, model, agen, akses data dan interaksi alat disahkan terhadap kebenaran semasa dan bukannya bergantung pada kepercayaan tersirat yang diberikan pada pengesahan awal atau berdasarkan lokasi rangkaian.** Ia menganggap sistem AI sebagai sasaran bernilai tinggi dengan tingkah laku dinamik dan bersambung yang memerlukan seni bina pengesahan yang direka khusus untuk bagaimana sistem AI sebenarnya beroperasi dan bukannya model keselamatan aplikasi konvensional yang tidak mengambil kira permukaan serangan khusus AI.

### **Apakah keselamatan zero trust?**

**Keselamatan zero trust ialah model keselamatan yang dibina atas prinsip bahawa tiada pengguna, peranti atau sistem harus dipercayai secara tersirat berdasarkan lokasi rangkaiannya, sebaliknya memerlukan setiap permintaan akses disahkan secara berterusan terhadap identiti, kesihatan peranti dan dasar kebenaran kontekstual sebelum akses diberikan.** Ia menggantikan model perimeter tradisional yang mempercayai segala-galanya di dalam sempadan rangkaian dengan model yang menganggap setiap interaksi sebagai berpotensi tidak dipercayai dan memerlukan pengesahan pada setiap titik akses tanpa mengira dari mana permintaan itu berasal.

### **Apakah contoh model keselamatan zero trust?**

**Contoh praktikal model keselamatan zero trust dalam pengerahan AI adalah pembantu AI perusahaan di mana setiap pengguna mengesahkan dengan pengesahan berbilang faktor sebelum mengakses sistem, saluran perolehan AI menguatkuasakan kebenaran dokumen pengguna yang meminta supaya ia hanya boleh memaparkan kandungan yang mereka dibenarkan melihat, semua panggilan alat yang dibuat oleh agen AI memerlukan kebenaran eksplisit setiap tindakan dan bukannya mewarisi kebenaran akaun perkhidmatan yang luas, dan setiap pertanyaan, perolehan dan tindakan dilog untuk pemantauan tingkah laku yang menandakan anomali untuk semakan keselamatan.** Contoh ini menggambarkan zero trust digunakan merentasi dimensi identiti, data dan tindakan sistem AI dan bukannya hanya di perimeter rangkaian.

### **Bagaimanakah Zero Trust meningkatkan keselamatan?**

**Zero trust meningkatkan keselamatan dengan mengurangkan radius letupan serangan yang berjaya melalui skop akses keistimewaan paling minimum yang menghadkan apa yang boleh diakses oleh identiti yang dikompromi atau sistem AI yang dimanipulasi, dengan membolehkan pengesanan anomali yang lebih cepat melalui pengelogan komprehensif semua peristiwa akses terhadap garis dasar tingkah laku, dan dengan menghapuskan andaian kepercayaan tersirat yang dieksploitasi oleh penyerang melalui pergerakan sisi setelah mereka berada di dalam perimeter rangkaian.** Untuk sistem AI khususnya, zero trust meningkatkan keselamatan dengan menggunakan pengesahan berterusan kepada tingkah laku dinamik dan bersambung agen AI yang pertahanan perimeter tidak dapat kawal kerana ia tidak mempunyai sempadan yang ditakrifkan untuk dilindungi.

### **Apakah 7 tonggak Zero Trust?**

**Tujuh tonggak zero trust ialah pengesahan identiti yang memerlukan pengesahan berterusan pengguna dan sistem, keselamatan peranti yang memastikan kesihatan titik akhir sebelum akses diberikan, segmentasi rangkaian menggantikan rangkaian rata yang dipercayai dengan zon tersegmen mikro yang memerlukan kebenaran eksplisit antaranya, keselamatan aplikasi yang menggunakan pengesahan input dan pemantauan output pada lapisan aplikasi, keselamatan data yang menguatkuasakan kawalan akses berasaskan pengelasan dan pengecilan data, keterlihatan dan analitik yang menyediakan pengelogan komprehensif dan pengesanan anomali tingkah laku, dan automasi dan orkestrasi yang membolehkan penguatkuasaan dasar dan tindak balas anomali pada skala dan kelajuan yang diperlukan oleh pengesahan berterusan.** Digunakan untuk sistem AI, setiap tonggak mengambil sambungan khusus yang menangani ciri-ciri unik tingkah laku, ketersambungan, dan permukaan serangan AI yang tidak direka untuk dikawal oleh keselamatan aplikasi konvensional.
