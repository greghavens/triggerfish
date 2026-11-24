---
title: Ejen AI Sedang Menyeludup Data Peribadi Anda. Siapa yang Menghalang Mereka?
date: 2026-03-10
description: Kebanyakan platform ejen AI menguatkuasakan keselamatan dengan
  memberitahu model apa yang tidak boleh dilakukan. Model boleh dipujuk
  sebaliknya. Inilah rupa alternatifnya.
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

Ejen AI berguna kerana mereka boleh mengambil tindakan. Itulah tujuan utamanya. Anda memberi ejen akses ke alat anda, dan ia boleh melakukan perkara: menghantar mesej, mengemas kini rekod, mencari fail, menjalankan pertanyaan, menolak komit. Demo-demonya mengesankan. Penyebaran sebenar, jika anda melihat dengan teliti model keselamatan di bawahnya, adalah cerita yang berbeza.

Soalan yang tidak ada seorang pun bertanya dengan cukup kuat sekarang adalah mudah. Apabila ejen AI mempunyai akses tulis ke pangkalan data, e-mel, kalendar, instans Salesforce, repositori GitHub anda, apa yang menghalangnya daripada melakukan sesuatu yang seharusnya tidak? Jawapan jujur, dalam kebanyakan kes, adalah satu ayat dalam system prompt.

Itulah situasi yang kita hadapi.

## Masalah dengan memberitahu model untuk berkelakuan baik

Apabila anda menyebarkan ejen AI hari ini, amalan keselamatan standard adalah menulis arahan ke dalam system prompt. Beritahu model apa yang tidak dibenarkan dilakukannya. Beritahunya alat mana yang tidak boleh digunakan. Beritahunya untuk bertanya sebelum mengambil tindakan yang merosakkan. Sesetengah platform membolehkan anda mengkonfigurasi arahan ini melalui UI daripada menulisnya secara manual, tetapi mekanisme asas adalah sama. Anda memberikan model buku peraturan dan mempercayai ia akan mengikutinya.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

Pendekatan ini mempunyai kelemahan yang asas. Model bahasa tidak melaksanakan peraturan. Mereka meramal token. Perbezaan itu penting kerana prompt yang dibuat dengan cukup baik boleh mengubah apa yang diramalkan oleh model, dan oleh itu apa yang dilakukannya. Ini adalah suntikan prompt. Ia bukan pepijat dalam mana-mana model tertentu. Ia adalah sifat cara semua sistem ini berfungsi. Jika penyerang boleh mendapatkan teks mereka ke dalam konteks model, arahan mereka bersaing dengan arahan anda. Model tidak mempunyai mekanisme untuk mengenal pasti arahan mana yang datang dari system prompt yang dipercayai dan mana yang datang dari dokumen berniat jahat yang diminta untuk diringkaskannya. Ia hanya melihat token.

Projek OpenClaw, yang telah berkembang menjadi hampir 300,000 bintang GitHub dan mungkin ejen sumber terbuka peribadi yang paling banyak digunakan sekarang, mempunyai masalah ini dalam pandangan penuh. Pasukan keselamatan Cisco mendemonstrasikan penyeludupan data melalui kemahiran pihak ketiga. Penyelenggara projek itu sendiri berkata secara terbuka bahawa perisian itu "terlalu berbahaya" untuk pengguna bukan teknikal. Ini bukan kebimbangan pinggiran. Ia adalah keadaan yang diakui bagi platform ejen paling popular yang wujud.

Dan OpenClaw tidak istimewa dalam hal ini. Seni bina yang sama, dengan variasi kecil, muncul merentasi kebanyakan platform ejen di pasaran. Mereka berbeza dalam betapa canggih system prompt mereka. Mereka berbeza dalam berapa banyak arahan perlindungan yang mereka sertakan. Apa yang mereka ada persamaan adalah bahawa semua arahan tersebut tinggal di dalam perkara yang seharusnya dijaga.

## Apa yang "di luar model" sebenarnya bermaksud

Alternatif seni bina adalah untuk memindahkan penguatkuasaan dari konteks model sepenuhnya. Daripada memberitahu model apa yang tidak dibenarkan dilakukannya dan berharap ia mendengar, anda meletakkan pintu gerbang antara model dan setiap tindakan yang boleh diambilnya. Model menghasilkan permintaan. Pintu gerbang menilai permintaan tersebut terhadap satu set peraturan dan memutuskan sama ada ia dilaksanakan. Pendapat model tentang sama ada tindakan harus dibenarkan bukan sebahagian daripada penilaian tersebut.

Ini kedengaran jelas apabila anda mengatakannya dengan lantang. Beginilah semua sistem perisian sensitif keselamatan lain berfungsi. Anda tidak menjamin bank dengan memberitahu juruwang "sila jangan beri wang kepada orang yang tidak mempunyai akaun." Anda meletakkan kawalan teknikal yang menjadikan pengeluaran tanpa kebenaran mustahil tanpa mengira apa yang diberitahu kepada juruwang. Tingkah laku juruwang mungkin dipengaruhi oleh serangan kejuruteraan sosial. Kawalan tidak begitu, kerana ia tidak mempunyai perbualan.

Dalam Triggerfish, lapisan penguatkuasaan berfungsi melalui satu set hook yang berjalan sebelum dan selepas setiap operasi yang bermakna. Sebelum panggilan alat dilaksanakan, hook memeriksa sama ada panggilan tersebut dibenarkan dengan keadaan sesi semasa. Sebelum output mencapai saluran, hook memeriksa sama ada data yang mengalir keluar dikelaskan pada tahap yang sesuai untuk saluran tersebut. Sebelum data luaran memasuki konteks, hook mengkelaskannya dan mengemas kini tahap taint sesi mengikutnya. Semakan ini ada dalam kod. Mereka tidak membaca perbualan. Mereka tidak boleh dipujuk dengan apa-apa pun.

## Taint sesi dan mengapa ia penting

Pengkelasan data adalah konsep yang difahami dengan baik dalam keselamatan. Kebanyakan platform yang mendakwa mengendalikannya memberikan pengkelasan kepada sumber dan memeriksa sama ada entiti yang meminta mempunyai kebenaran untuk mengaksesnya. Itu berguna setakat yang ia boleh pergi. Apa yang ia terlepas ialah apa yang berlaku selepas akses.

Apabila ejen AI mengakses dokumen sulit, data sulit itu kini ada dalam konteksnya. Ia boleh mempengaruhi output dan pemikiran ejen untuk selebihnya sesi tersebut. Walaupun jika ejen beralih ke tugas yang berbeza, konteks sulit itu masih ada. Jika ejen kemudiannya mengambil tindakan pada saluran yang lebih rendah diklasifikasikan — menulis ke saluran Slack awam, menghantar e-mel ke alamat luaran, menghantar ke webhook — ia boleh membawa data sulit tersebut bersama. Ini adalah kebocoran data, dan kawalan akses pada sumber asal tidak melakukan apa-apa untuk mencegahnya.

![](/blog/images/robot-entry.jpg)

Penjejakan taint adalah mekanisme yang menutup jurang ini. Dalam Triggerfish, setiap sesi mempunyai tahap taint yang bermula pada PUBLIC. Pada saat ejen menyentuh data pada tahap pengkelasan yang lebih tinggi, sesi dicemarkan ke tahap tersebut. Taint hanya naik. Ia tidak pernah turun dalam sesi. Jadi jika anda mengakses dokumen CONFIDENTIAL dan kemudian cuba menghantar mesej ke saluran PUBLIC, semakan write-down diaktifkan terhadap tahap sesi yang dicemarkan. Tindakan disekat bukan kerana apa-apa yang dikatakan model, tetapi kerana sistem mengetahui data apa yang sedang dimainkan.

Model tidak mengetahui tentang mekanisme ini. Ia tidak boleh merujuknya, berfikir tentangnya, atau cuba memanipulasinya. Tahap taint adalah fakta tentang sesi yang tinggal dalam lapisan penguatkuasaan, bukan dalam konteks.

## Alat pihak ketiga adalah permukaan serangan

Salah satu ciri yang menjadikan ejen AI moden benar-benar berguna ialah kebolehpanjangan mereka. Anda boleh menambah alat. Anda boleh memasang plugin. Anda boleh menghubungkan ejen ke perkhidmatan luaran melalui Model Context Protocol. Setiap integrasi yang anda tambah mengembangkan apa yang boleh dilakukan oleh ejen. Setiap integrasi yang anda tambah juga mengembangkan permukaan serangan.

Model ancaman di sini bukan hipotetikal. Jika ejen boleh memasang kemahiran pihak ketiga, dan kemahiran tersebut diedarkan oleh pihak yang tidak diketahui, dan model keselamatan ejen bergantung sepenuhnya pada model yang menghormati arahan dalam konteksnya, maka kemahiran berniat jahat boleh menyeludup data hanya dengan mendapatkan dirinya dipasang. Kemahiran itu berada di dalam sempadan kepercayaan. Model tidak mempunyai cara untuk membezakan antara kemahiran yang sah dan kemahiran berniat jahat jika kedua-duanya ada dalam konteks.

Dalam Triggerfish, Gateway MCP mengendalikan semua sambungan alat luaran. Setiap pelayan MCP mesti dikelaskan sebelum ia boleh diinvok. Pelayan UNTRUSTED disekat secara lalai. Apabila alat dari pelayan luaran mengembalikan data, respons itu melalui hook POST_TOOL_RESPONSE, yang mengkelaskan respons dan mengemas kini taint sesi mengikutnya. Dayakan pemalam TypeScript dalam konfigurasi pengguna dengan `enabled: true`. Secara lalai, import dan pelaksanaan berlaku dalam Deno Worker dengan kebenaran terhad. Worker boleh membaca direktori pemalam dan hanya menyambung kepada hos dan port dalam `declaredEndpoints`. Penulisan fail, pembacaan persekitaran proses, subproses, FFI dan maklumat sistem terhad disekat. `trust: trusted` membenarkan import dalam proses Triggerfish. Pelaksana berjalan dalam proses itu jika manifes turut menyatakan `trusted`. [Panduan pemalam lengkap](/ms-MY/integrations/plugins).

Tujuan semua ini adalah bahawa sifat keselamatan sistem tidak bergantung pada kepercayaan plugin. Mereka bergantung pada sandbox dan lapisan penguatkuasaan, yang tidak dipengaruhi oleh apa yang terkandung dalam plugin.

## Masalah audit

Jika sesuatu yang salah berlaku dengan penyebaran ejen AI hari ini, bagaimana anda tahu? Kebanyakan platform merekodkan perbualan. Sesetengah merekodkan panggilan alat. Sangat sedikit yang merekodkan keputusan keselamatan yang dibuat semasa sesi dengan cara yang membolehkan anda membina semula dengan tepat data apa yang mengalir ke mana, pada tahap pengkelasan apa, dan sama ada ada dasar yang dilanggar.

Ini lebih penting daripada yang mungkin kelihatan, kerana soalan sama ada ejen AI selamat bukan sahaja tentang mencegah serangan dalam masa nyata. Ia tentang dapat menunjukkan, selepas itu, bahawa ejen berkelakuan dalam batasan yang ditentukan. Untuk mana-mana organisasi yang mengendalikan data sensitif, jejak audit itu bukan pilihan. Ia adalah cara anda membuktikan pematuhan, bertindak balas kepada insiden, dan membina kepercayaan dengan orang yang datanya anda kendalikan.

![](/blog/images/glass.jpg)

Triggerfish mengekalkan keturunan data penuh pada setiap operasi. Setiap keping data yang memasuki sistem membawa metadata provenance: dari mana ia datang, pengkelasan apa yang diberikan padanya, transformasi apa yang dilaluinya, sesi apa ia diikat. Anda boleh menjejak mana-mana output kembali melalui rantaian operasi yang menghasilkannya. Anda boleh bertanya sumber mana yang menyumbang kepada respons yang diberikan. Anda boleh mengeksport rantaian penjagaan lengkap untuk semakan kawal selia. Ini bukan sistem pengelogan dalam erti kata tradisional. Ia adalah sistem provenance yang dikekalkan sebagai kebimbangan kelas pertama sepanjang keseluruhan aliran data.

## Soalan sebenar

Kategori ejen AI berkembang pesat. Platform semakin berkemampuan. Kes penggunaan semakin penting. Orang menyebarkan ejen dengan akses tulis ke pangkalan data pengeluaran, rekod pelanggan, sistem kewangan, dan platform komunikasi dalaman. Andaian yang mendasari kebanyakan penyebaran ini adalah bahawa system prompt yang ditulis dengan baik adalah keselamatan yang mencukupi.

Tidak. System prompt adalah teks. Teks boleh diatasi oleh teks lain. Jika model keselamatan ejen anda ialah model akan mengikuti arahan anda, anda bergantung pada pematuhan tingkah laku daripada sistem yang tingkah lakunya adalah probabilistik dan boleh dipengaruhi oleh input yang tidak anda kawal.

Soalan yang patut ditanya kepada setiap platform ejen yang anda pertimbangkan ialah di mana penguatkuasaan sebenarnya berada. Jika jawapannya ada dalam arahan model, itu adalah risiko yang bermakna yang berkembang dengan kepekaan data yang boleh disentuh oleh ejen anda dan kecanggihan orang yang mungkin cuba memanipulasinya. Jika jawapannya ada dalam lapisan yang berjalan secara bebas daripada model dan tidak boleh dicapai oleh mana-mana prompt, itu adalah situasi yang berbeza.

Data dalam sistem anda adalah nyata. Soalan siapa yang menghalang ejen daripada menyeludupnya layak mendapat jawapan yang nyata.
