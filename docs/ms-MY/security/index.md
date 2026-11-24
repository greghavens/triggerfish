# Reka Bentuk Keselamatan-Dahulu

Triggerfish dibina atas satu premis: **LLM mempunyai sifar autoriti**. Ia meminta tindakan; lapisan dasar yang membuat keputusan. Setiap keputusan keselamatan dibuat oleh kod deterministik yang tidak boleh dilangkau, ditolak, atau dipengaruhi oleh AI.

Halaman ini menjelaskan mengapa Triggerfish mengambil pendekatan ini, bagaimana ia berbeza daripada platform ejen AI tradisional, dan di mana untuk mencari perincian tentang setiap komponen model keselamatan.

## Mengapa Keselamatan Mesti Berada di Bawah LLM

Model bahasa besar boleh disuntik arahan. Input yang direka dengan teliti -- sama ada daripada mesej luaran berniat jahat, dokumen yang dicemari, atau respons alat yang terkompromi -- boleh menyebabkan LLM mengabaikan arahan dan mengambil tindakan yang dilarang. Ini bukan risiko teori. Ini adalah masalah yang terdokumentasi dengan baik dan belum diselesaikan dalam industri AI.

Jika model keselamatan anda bergantung pada LLM mengikuti peraturan, satu suntikan yang berjaya boleh memintas setiap perlindungan yang telah anda bina.

Triggerfish menyelesaikan masalah ini dengan memindahkan semua penguatkuasaan keselamatan ke lapisan kod yang berada **di bawah** LLM. AI tidak pernah melihat keputusan keselamatan. Ia tidak pernah menilai sama ada sesuatu tindakan perlu dibenarkan. Ia hanya meminta tindakan, dan lapisan penguatkuasaan dasar -- yang berjalan sebagai kod tulen, deterministik -- memutuskan sama ada tindakan tersebut diteruskan.

<img src="/diagrams/enforcement-layers.svg" alt="Lapisan penguatkuasaan: LLM mempunyai sifar autoriti, lapisan dasar membuat semua keputusan secara deterministik, hanya tindakan yang dibenarkan mencapai pelaksanaan" style="max-width: 100%;" />

::: warning KESELAMATAN Lapisan LLM tidak mempunyai mekanisme untuk mengatasi, melangkau, atau mempengaruhi lapisan penguatkuasaan dasar. Tiada logik "urai output LLM untuk arahan pintasan". Pemisahan adalah seni bina, bukan tingkah laku. :::

## Invarian Teras

Setiap keputusan reka bentuk dalam Triggerfish mengalir dari satu invarian:

> **Input yang sama sentiasa menghasilkan keputusan keselamatan yang sama. Tiada kerawakan, tiada panggilan LLM, tiada budi bicara.**

Ini bermakna tingkah laku keselamatan adalah:

- **Boleh diaudit** -- anda boleh memainkan semula mana-mana keputusan dan mendapat keputusan yang sama
- **Boleh diuji** -- kod deterministik boleh diliputi oleh ujian automatik
- **Boleh disahkan** -- enjin dasar adalah sumber terbuka (berlesen Apache 2.0) dan sesiapa sahaja boleh menyemaknya

## Prinsip Keselamatan

| Prinsip                   | Maksudnya                                                                                                                                                      | Halaman Perincian                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Pengkelasan Data**      | Semua data membawa tahap sensitiviti (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Pengkelasan ditetapkan oleh kod apabila data memasuki sistem.               | [Seni Bina: Pengkelasan](/ms-MY/architecture/classification)         |
| **Tanpa Tulis-Bawah**     | Data hanya boleh mengalir ke saluran dan penerima pada tahap pengkelasan yang sama atau lebih tinggi. Data CONFIDENTIAL tidak boleh mencapai saluran PUBLIC.   | [Peraturan Tanpa Tulis-Bawah](./no-write-down)                       |
| **Taint Sesi**            | Apabila sesi mengakses data pada tahap pengkelasan tertentu, keseluruhan sesi ditaint ke tahap tersebut. Taint hanya boleh meningkat, tidak boleh menurun.     | [Seni Bina: Taint](/ms-MY/architecture/taint-and-sessions)           |
| **Hook Deterministik**    | Lapan hook penguatkuasaan berjalan pada titik kritikal dalam setiap aliran data. Setiap hook adalah sinkronus, dilog, dan tidak boleh dipalsukan.              | [Seni Bina: Enjin Dasar](/ms-MY/architecture/policy-engine)          |
| **Identiti dalam Kod**    | Identiti pengguna ditentukan oleh kod semasa penubuhan sesi, bukan oleh LLM yang mentafsir kandungan mesej.                                                   | [Identiti & Auth](./identity)                                        |
| **Delegasi Ejen**         | Panggilan antara ejen dikawal oleh sijil kriptografi, siling pengkelasan, dan had kedalaman.                                                                  | [Delegasi Ejen](./agent-delegation)                                  |
| **Pengasingan Rahsia**    | Kelayakan disimpan dalam keychain OS atau vault, tidak pernah dalam fail konfigurasi. Plugin tidak boleh mengakses kelayakan sistem.                          | [Pengurusan Rahsia](./secrets)                                       |
| **Audit Semua Perkara**   | Setiap keputusan dasar dilog dengan konteks penuh: cap masa, jenis hook, ID sesi, input, keputusan, dan peraturan yang dinilai.                               | [Audit & Pematuhan](./audit-logging)                                 |

## Ejen AI Tradisional vs. Triggerfish

Kebanyakan platform ejen AI bergantung pada LLM untuk menguatkuasakan keselamatan. Arahan sistem prompt berkata "jangan kongsi data sensitif," dan ejen dipercayai mematuhi. Pendekatan ini mempunyai kelemahan asas.

| Aspek                         | Ejen AI Tradisional                     | Triggerfish                                                          |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| **Penguatkuasaan keselamatan** | Arahan system prompt kepada LLM         | Kod deterministik di bawah LLM                                       |
| **Pertahanan suntikan arahan** | Berharap LLM menolak                    | LLM tidak mempunyai autoriti dari awal                               |
| **Kawalan aliran data**        | LLM memutuskan apa yang selamat dikongsi | Label pengkelasan + peraturan tanpa-tulis-bawah dalam kod            |
| **Pengesahan identiti**        | LLM mentafsir "Saya adalah admin"       | Kod menyemak identiti saluran kriptografi                            |
| **Jejak audit**                | Log perbualan LLM                       | Log keputusan dasar berstruktur dengan konteks penuh                 |
| **Akses kelayakan**            | Akaun perkhidmatan sistem untuk semua pengguna | Kelayakan pengguna yang didelegasikan; kebenaran sistem sumber diwarisi |
| **Kebolehujian**               | Kabur -- bergantung pada susunan arahan | Deterministik -- input yang sama, keputusan yang sama, setiap masa   |
| **Terbuka untuk pengesahan**   | Biasanya proprietari                    | Berlesen Apache 2.0, boleh diaudit sepenuhnya                        |

::: tip Triggerfish tidak mendakwa bahawa LLM tidak boleh dipercayai. Ia mendakwa bahawa LLM adalah lapisan yang salah untuk penguatkuasaan keselamatan. LLM yang diarahan dengan baik akan mengikuti arahan sebahagian besar masa. Tetapi "sebahagian besar masa" bukan jaminan keselamatan. Triggerfish memberikan jaminan: lapisan dasar adalah kod, dan kod melakukan apa yang diarahkan, setiap masa. :::

## Pertahanan Berlapis

Triggerfish melaksanakan tiga belas lapisan pertahanan. Tiada satu lapisan pun yang mencukupi sendiri; bersama-sama, mereka membentuk sempadan keselamatan:

1. **Pengesahan saluran** -- identiti yang disahkan oleh kod semasa penubuhan sesi
2. **Akses data sedar-kebenaran** -- kebenaran sistem sumber, bukan kelayakan sistem
3. **Penjejakan taint sesi** -- automatik, mandatori, peningkatan sahaja
4. **Keturunan data** -- rantaian provenance penuh untuk setiap elemen data
5. **Hook penguatkuasaan dasar** -- deterministik, tidak boleh dipintas, dilog
6. **MCP Gateway** -- akses alat luaran selamat dengan kebenaran per-alat
7. **[Sandbox plugin](../integrations/plugins)**
8. **Pengasingan rahsia** -- keychain OS atau vault, tidak pernah dalam fail konfigurasi
9. **Sandbox alat sistem fail** -- penjara laluan, pengkelasan laluan, kebenaran I/O OS berlingkup-taint
10. **Identiti ejen** -- rantaian delegasi kriptografi
11. **Log audit** -- semua keputusan direkodkan, tiada pengecualian
12. **Pencegahan SSRF** -- senarai tolak IP + semakan resolusi DNS pada semua HTTP keluar
13. **Penggerbangan pengkelasan memori** -- penulisan dipaksa ke taint sesi, bacaan ditapis oleh `canFlowTo`

## Langkah Seterusnya

| Halaman                                                         | Keterangan                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Panduan Pengkelasan](/ms-MY/guide/classification-guide)        | Panduan praktikal memilih tahap yang betul untuk saluran, pelayan MCP, dan integrasi            |
| [Peraturan Tanpa Tulis-Bawah](./no-write-down)                  | Peraturan aliran data asas dan cara ia dikuatkuasakan                                            |
| [Identiti & Auth](./identity)                                   | Pengesahan saluran dan pengesahan identiti pemilik                                               |
| [Delegasi Ejen](./agent-delegation)                             | Identiti antara ejen, sijil, dan rantaian delegasi                                               |
| [Pengurusan Rahsia](./secrets)                                  | Cara Triggerfish mengendalikan kelayakan merentasi peringkat                                     |
| [Audit & Pematuhan](./audit-logging)                            | Struktur jejak audit, penjejakan, dan eksport pematuhan                                          |
