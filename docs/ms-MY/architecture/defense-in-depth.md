# Pertahanan Berlapis

Triggerfish melaksanakan keselamatan sebagai 13 lapisan bebas yang bertindih. Tiada lapisan tunggal yang mencukupi secara sendiri. Bersama-sama, mereka membentuk pertahanan yang merosot dengan anggun — walaupun satu lapisan dikompromi, lapisan-lapisan yang tinggal terus melindungi sistem.

::: warning KESELAMATAN Pertahanan berlapis bermakna kelemahan dalam mana-mana lapisan tunggal tidak menjejaskan sistem. Penyerang yang memintas pengesahan saluran masih berhadapan dengan penjejakan taint sesi, hook dasar, dan pengelogan audit. LLM yang disuntik prompt masih tidak boleh mempengaruhi lapisan dasar deterministik di bawahnya. :::

## 13 Lapisan

### Lapisan 1: Pengesahan Saluran

**Melindungi daripada:** Penyamaran identiti, akses tanpa kebenaran, kekeliruan identiti.

Identiti ditentukan oleh **kod semasa penetapan sesi**, bukan oleh LLM yang mentafsir kandungan mesej. Sebelum LLM melihat sebarang mesej, penyesuai saluran menandainya dengan label yang tidak boleh diubah:

```
{ source: "owner" }    -- identiti saluran yang disahkan sepadan dengan pemilik berdaftar
{ source: "external" } -- sesiapa yang lain; input sahaja, tidak dianggap sebagai perintah
```

Kaedah pengesahan berbeza mengikut saluran:

| Saluran                  | Kaedah            | Pengesahan                                                   |
| ------------------------ | ----------------- | ------------------------------------------------------------ |
| Telegram / WhatsApp      | Kod padanan       | Kod sekali guna, tamat 5 minit, dihantar dari akaun pengguna |
| Slack / Discord / Teams  | OAuth             | Aliran kebenaran OAuth platform, mengembalikan ID pengguna yang disahkan |
| CLI                      | Proses tempatan   | Berjalan di mesin pengguna, disahkan oleh OS                 |
| WebChat                  | Tiada (awam)      | Semua pelawat adalah `EXTERNAL`, tidak pernah `owner`        |
| E-mel                    | Padanan domain    | Domain penghantar dibandingkan dengan domain dalaman yang dikonfigurasi |

::: info LLM tidak pernah memutuskan siapa yang menjadi pemilik. Mesej yang menyatakan "Saya adalah pemilik" daripada pengirim yang tidak disahkan ditanda sebagai `{ source: "external" }` dan tidak boleh mencetuskan perintah peringkat pemilik. Keputusan ini dibuat dalam kod, sebelum LLM memproses mesej. :::

### Lapisan 2: Akses Data Sedar-Kebenaran

**Melindungi daripada:** Akses data yang terlalu dibenarkan, peningkatan keistimewaan melalui kelayakan sistem.

Triggerfish menggunakan token OAuth yang didelegasikan pengguna — bukan akaun perkhidmatan sistem — untuk menanya sistem luaran. Sistem sumber menguatkuasakan model kebenarannnya sendiri:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradisional vs Triggerfish: model tradisional memberikan LLM kawalan langsung, Triggerfish menghalakan semua tindakan melalui lapisan dasar deterministik" style="max-width: 100%;" />

SDK Plugin menguatkuasakan ini pada peringkat API:

| Kaedah SDK                               | Tingkah Laku                                    |
| ---------------------------------------- | ----------------------------------------------- |
| `sdk.get_user_credential(integration)`   | Mengembalikan token OAuth yang didelegasikan pengguna |
| `sdk.query_as_user(integration, query)`  | Melaksanakan dengan kebenaran pengguna           |
| `sdk.get_system_credential(name)`        | **DISEKAT** — menimbulkan `PermissionError`      |

### Lapisan 3: Penjejakan Taint Sesi

**Melindungi daripada:** Kebocoran data melalui pencemaran konteks, data terklasifikasi mencapai saluran pengkelasan rendah.

Setiap sesi menjejak secara bebas tahap taint yang mencerminkan pengkelasan tertinggi data yang diakses semasa sesi. Taint mengikut tiga invarian:

1. **Per-perbualan** — setiap sesi mempunyai taint sendiri
2. **Eskalasi sahaja** — taint meningkat, tidak pernah berkurang
3. **Reset penuh mengosongkan semua** — taint DAN sejarah dihapuskan bersama

Apabila enjin dasar menilai output, ia membandingkan taint sesi terhadap pengkelasan berkesan saluran sasaran. Jika taint melebihi sasaran, output disekat.

### Lapisan 4: Keturunan Data

**Melindungi daripada:** Aliran data yang tidak boleh dikesan, ketidakupayaan mengaudit ke mana data pergi, jurang pematuhan.

Setiap elemen data membawa metadata provenance dari asal usul ke destinasi:

- **Asal usul**: Integrasi, rekod, dan akses pengguna mana yang menghasilkan data ini
- **Pengkelasan**: Tahap apa yang diberikan dan mengapa
- **Pengubahan**: Cara LLM mengubah suai, meringkaskan, atau menggabungkan data
- **Destinasi**: Sesi dan saluran mana yang menerima output

Keturunan membolehkan jejak ke hadapan ("ke mana rekod Salesforce ini pergi?"), jejak ke belakang ("sumber apa yang menyumbang kepada output ini?"), dan eksport pematuhan penuh.

### Lapisan 5: Hook Penguatkuasaan Dasar

**Melindungi daripada:** Serangan suntikan prompt, pintasan keselamatan yang dipacu LLM, pelaksanaan alat yang tidak terkawal.

Lapan hook deterministik mencelah setiap tindakan pada titik kritikal dalam aliran data:

| Hook                    | Apa yang dicegah                                |
| ----------------------- | ----------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Input luaran memasuki tetingkap konteks          |
| `PRE_TOOL_CALL`         | LLM meminta pelaksanaan alat                    |
| `POST_TOOL_RESPONSE`    | Data yang dikembalikan daripada pelaksanaan alat |
| `PRE_OUTPUT`            | Respons yang hendak meninggalkan sistem          |
| `SECRET_ACCESS`         | Permintaan akses kelayakan                      |
| `SESSION_RESET`         | Permintaan reset taint                           |
| `AGENT_INVOCATION`      | Panggilan ejen ke ejen                           |
| `MCP_TOOL_CALL`         | Invokasi alat pelayan MCP                        |

Hook adalah kod tulen: deterministik, sinkronous, dilog, dan tidak boleh dipalsukan. LLM tidak boleh memintas mereka kerana tiada laluan daripada output LLM ke konfigurasi hook. Lapisan hook tidak menghurai output LLM untuk perintah.

### Lapisan 6: Gateway MCP

**Melindungi daripada:** Akses alat luaran yang tidak terkawal, data tanpa pengkelasan memasuki melalui pelayan MCP, pelanggaran skema.

Semua pelayan MCP lalai kepada `UNTRUSTED` dan tidak boleh diinvok sehingga pentadbir atau pengguna mengkelaskannya. Gateway menguatkuasakan:

- Pengesahan pelayan dan status pengkelasan
- Kebenaran peringkat alat (alat individu boleh disekat walaupun pelayan dibenarkan)
- Pengesahan skema permintaan/respons
- Penjejakan taint pada semua respons MCP
- Pengimbasan corak suntikan dalam parameter

<img src="/diagrams/mcp-server-states.svg" alt="Keadaan pelayan MCP: UNTRUSTED (lalai), CLASSIFIED (disemak dan dibenarkan), BLOCKED (dilarang secara eksplisit)" style="max-width: 100%;" />

### Lapisan 7: Sandbox Plugin

Dayakan pemalam TypeScript dalam konfigurasi pengguna dengan `enabled: true`. Secara lalai, import dan pelaksanaan berlaku dalam Deno Worker dengan kebenaran terhad. Worker boleh membaca direktori pemalam dan hanya menyambung kepada hos dan port dalam `declaredEndpoints`. Penulisan fail, pembacaan persekitaran proses, subproses, FFI dan maklumat sistem terhad disekat. `trust: trusted` membenarkan import dalam proses Triggerfish. Pelaksana berjalan dalam proses itu jika manifes turut menyatakan `trusted`.

[Panduan pemalam lengkap](../integrations/plugins)

### Lapisan 8: Pengasingan Rahsia

**Melindungi daripada:** Kecurian kelayakan, rahsia dalam fail konfigurasi, penyimpanan kelayakan teks biasa.

Kelayakan disimpan dalam keychain OS (peringkat peribadi) atau integrasi vault (peringkat enterprise). Ia tidak pernah muncul dalam:

- Fail konfigurasi
- Nilai `StorageProvider`
- Entri log
- Konteks LLM (kelayakan disuntik pada lapisan HTTP, di bawah LLM)

Hook `SECRET_ACCESS` merekodkan setiap akses kelayakan dengan plugin yang meminta, skop kelayakan, dan keputusan.

### Lapisan 9: Sandbox Alat Sistem Fail

**Melindungi daripada:** Serangan traversal laluan, akses fail tanpa kebenaran, pintasan pengkelasan melalui operasi sistem fail langsung.

Semua operasi alat sistem fail (baca, tulis, sunting, senarai, cari) berjalan di dalam Deno Worker yang dikotak pasir dengan kebenaran peringkat OS yang diskopkan ke subdirektori ruang kerja yang sesuai taint sesi. Sandbox menguatkuasakan tiga sempadan:

- **Penjara laluan** — setiap laluan diselesaikan ke laluan mutlak dan diperiksa terhadap akar penjara dengan padanan berasaskan pemisah. Percubaan traversal (`../`) yang melepaskan ruang kerja ditolak sebelum sebarang I/O berlaku
- **Pengkelasan laluan** — setiap laluan sistem fail dikelaskan melalui rantaian resolusi tetap: laluan dilindungi yang dikodkan keras (RESTRICTED), direktori pengkelasan ruang kerja, pemetaan laluan yang dikonfigurasi, kemudian pengkelasan lalai. Ejen tidak boleh mengakses laluan di atas taint sesinya
- **Kebenaran berskop taint** — kebenaran Deno Worker sandbox ditetapkan ke subdirektori ruang kerja yang sepadan dengan tahap taint sesi semasa. Apabila taint meningkat, Worker dijanakan semula dengan kebenaran yang dikembangkan. Kebenaran hanya boleh melebar, tidak pernah menyempit dalam sesi
- **Perlindungan tulis** — fail kritikal (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) dilindungi tulis pada lapisan alat tanpa mengira kebenaran sandbox. Fail-fail ini hanya boleh diubah suai melalui alat pengurusan khusus yang menguatkuasakan peraturan pengkelasan mereka sendiri

### Lapisan 10: Identiti Ejen

**Melindungi daripada:** Peningkatan keistimewaan melalui rantaian ejen, pengubahan data melalui delegasi.

Apabila ejen memanggil ejen lain, rantaian delegasi kriptografi mencegah peningkatan keistimewaan:

- Setiap ejen mempunyai sijil yang menentukan kemampuan dan siling pengkelaannya
- Ejen yang dipanggil mewarisi `max(taint sendiri, taint pemanggil)` — taint hanya boleh meningkat melalui rantaian
- Pemanggil dengan taint yang melebihi siling ejen yang dipanggil disekat
- Invokasi bulat dikesan dan ditolak
- Kedalaman delegasi dihadkan dan dikuatkuasakan

<img src="/diagrams/data-laundering-defense.svg" alt="Pertahanan pencucian data: laluan serangan disekat pada semakan siling dan pewarisan taint mencegah output ke saluran pengkelasan rendah" style="max-width: 100%;" />

### Lapisan 11: Pengelogan Audit

**Melindungi daripada:** Pelanggaran yang tidak dapat dikesan, kegagalan pematuhan, ketidakupayaan menyiasat insiden.

Setiap keputusan yang berkaitan keselamatan direkodkan dengan konteks penuh:

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "user_id": "user_123",
  "session_id": "sess_456",
  "action": "slack.postMessage",
  "target_channel": "external_webhook",
  "session_taint": "CONFIDENTIAL",
  "target_classification": "PUBLIC",
  "decision": "DENIED",
  "reason": "classification_violation",
  "hook": "PRE_OUTPUT",
  "policy_rules_evaluated": ["rule_001", "rule_002"],
  "lineage_ids": ["lin_789", "lin_790"]
}
```

Apa yang direkodkan:

- Semua permintaan tindakan (yang dibenarkan DAN yang ditolak)
- Keputusan pengkelasan
- Perubahan taint sesi
- Peristiwa pengesahan saluran
- Penilaian peraturan dasar
- Penciptaan dan kemas kini rekod keturunan
- Keputusan Gateway MCP
- Invokasi ejen ke ejen

::: info Pengelogan audit tidak boleh dilumpuhkan. Ia adalah peraturan tetap dalam hierarki dasar. Walaupun pentadbir org tidak boleh mematikan pengelogan untuk tindakan mereka sendiri. Penyebaran enterprise boleh memilih untuk mendayakan pengelogan kandungan penuh (termasuk kandungan mesej yang disekat) untuk keperluan forensik. :::

### Lapisan 12: Pencegahan SSRF

**Melindungi daripada:** Pemalsuan permintaan sisi pelayan, tinjauan rangkaian dalaman, penyeludupan metadata awan.

Semua permintaan HTTP keluar (daripada `web_fetch`, `browser.navigate`, dan akses rangkaian plugin) menyelesaikan DNS terlebih dahulu dan memeriksa IP yang diselesaikan terhadap senarai tolak yang dikodkan keras bagi julat peribadi dan terpelihara. Ini mencegah penyerang daripada menipu ejen untuk mengakses perkhidmatan dalaman melalui URL yang direkayasa.

- Julat peribadi (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) sentiasa disekat
- Pautan-tempatan (`169.254.0.0/16`) dan titik akhir metadata awan disekat
- Loopback (`127.0.0.0/8`) disekat
- Senarai tolak dikodkan keras dan tidak boleh dikonfigurasi — tiada penggantian pentadbir
- Resolusi DNS berlaku sebelum permintaan, mencegah serangan DNS rebinding

### Lapisan 13: Penghadangan Pengkelasan Memori

**Melindungi daripada:** Kebocoran data merentas sesi melalui memori, penurunan pengkelasan melalui penulisan memori, akses tanpa kebenaran ke memori terklasifikasi.

Sistem memori merentas sesi menguatkuasakan pengkelasan semasa penulisan dan pembacaan:

- **Penulisan**: Entri memori dipaksa ke tahap taint sesi semasa. LLM tidak boleh memilih pengkelasan yang lebih rendah untuk memori yang disimpan.
- **Pembacaan**: Pertanyaan memori ditapis oleh `canFlowTo` — sesi hanya boleh membaca memori pada atau di bawah tahap taint semasa.

Ini mencegah ejen daripada menyimpan data CONFIDENTIAL sebagai PUBLIC dalam memori dan kemudiannya mendapatkannya semula dalam sesi taint rendah untuk memintas peraturan tiada write-down.

## Hierarki Kepercayaan

Model kepercayaan menentukan siapa yang mempunyai autoriti ke atas apa. Peringkat yang lebih tinggi tidak boleh memintas peraturan keselamatan peringkat yang lebih rendah, tetapi mereka boleh mengkonfigurasi parameter yang boleh dilaraskan dalam peraturan tersebut.

<img src="/diagrams/trust-hierarchy.svg" alt="Hierarki kepercayaan: Vendor Triggerfish (akses sifar), Pentadbir Org (menetapkan dasar), Pekerja (menggunakan ejen dalam batasan)" style="max-width: 100%;" />

::: tip **Peringkat peribadi:** Pengguna ADALAH pentadbir org. Kedaulatan penuh. Tiada keterlihatan Triggerfish. Vendor mempunyai akses sifar ke data pengguna secara lalai dan hanya boleh mendapat akses melalui pemberian yang eksplisit, terikat masa, dan direkodkan daripada pengguna. :::

## Cara Lapisan Bekerja Bersama

Pertimbangkan serangan suntikan prompt di mana mesej berniat jahat cuba menyeludup data:

| Langkah | Lapisan                  | Tindakan                                                        |
| ------- | ------------------------ | --------------------------------------------------------------- |
| 1       | Pengesahan saluran       | Mesej ditanda `{ source: "external" }` — bukan pemilik          |
| 2       | PRE_CONTEXT_INJECTION    | Input diimbas untuk corak suntikan, dikelaskan                  |
| 3       | Taint sesi               | Taint sesi tidak berubah (tiada data terklasifikasi diakses)    |
| 4       | LLM memproses mesej      | LLM mungkin dimanipulasi untuk meminta panggilan alat           |
| 5       | PRE_TOOL_CALL            | Semakan kebenaran alat terhadap peraturan sumber-luaran         |
| 6       | POST_TOOL_RESPONSE       | Sebarang data yang dikembalikan dikelaskan, taint dikemas kini  |
| 7       | PRE_OUTPUT               | Pengkelasan output lwn. sasaran diperiksa                       |
| 8       | Pengelogan audit         | Keseluruhan urutan direkodkan untuk semakan                     |

Walaupun LLM dikompromi sepenuhnya pada langkah 4 dan meminta panggilan alat penyeludupan data, lapisan-lapisan yang tinggal (semakan kebenaran, penjejakan taint, pengkelasan output, pengelogan audit) terus menguatkuasakan dasar. Tiada satu titik kegagalan yang menjejaskan sistem.
