# Gambaran Keseluruhan Seni Bina

Triggerfish adalah platform ejen AI yang selamat dan berbilang saluran dengan satu invarian teras:

::: warning KESELAMATAN **Keselamatan adalah deterministik dan sub-LLM.** Setiap keputusan keselamatan dibuat oleh kod tulen yang tidak boleh dipintas, dikesampingkan, atau dipengaruhi oleh LLM. LLM mempunyai autoriti sifar — ia meminta tindakan; lapisan dasar yang memutuskan. :::

Halaman ini menyediakan gambaran keseluruhan cara Triggerfish berfungsi. Setiap komponen utama menghubungkan ke halaman penyelaman mendalam yang khusus.

## Seni Bina Sistem

<img src="/diagrams/system-architecture.svg" alt="Seni bina sistem: saluran mengalir melalui Router Saluran ke Gateway, yang menyelaraskan Pengurus Sesi, Enjin Dasar, dan Gelung Ejen" style="max-width: 100%;" />

### Aliran Data

Setiap mesej mengikuti laluan ini melalui sistem:

<img src="/diagrams/data-flow-9-steps.svg" alt="Aliran data: saluran paip 9 langkah daripada mesej masuk melalui hook dasar ke penghantaran keluar" style="max-width: 100%;" />

Di setiap titik penguatkuasaan, keputusan adalah deterministik — input yang sama sentiasa menghasilkan keputusan yang sama. Tiada panggilan LLM di dalam hook, tiada kerawakan, dan tiada cara LLM mempengaruhi hasil.

## Komponen Utama

### Sistem Pengkelasan

Data mengalir melalui empat tahap yang tersusun: `RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Peraturan teras adalah **tiada write-down**: data hanya boleh mengalir ke pengkelasan yang sama atau lebih tinggi. Sesi `CONFIDENTIAL` tidak boleh menghantar data ke saluran `PUBLIC`. Tiada pengecualian. Tiada penggantian LLM.

[Baca lebih lanjut tentang Sistem Pengkelasan.](./classification)

### Enjin Dasar dan Hook

Lapan hook penguatkuasaan deterministik mencelah setiap tindakan pada titik kritikal dalam aliran data. Hook adalah fungsi tulen: sinkronous, dilog, dan tidak boleh dipalsukan. Enjin dasar menyokong peraturan tetap (tidak boleh dikonfigurasi), peraturan yang boleh diselaraskan oleh pentadbir, dan escape hatch YAML deklaratif untuk enterprise.

[Baca lebih lanjut tentang Enjin Dasar.](./policy-engine)

### Sesi dan Taint

Setiap perbualan adalah sesi dengan penjejakan taint yang bebas. Apabila sesi mengakses data yang dikelaskan, taintnya meningkat ke tahap tersebut dan tidak pernah boleh berkurang dalam sesi. Reset penuh mengosongkan taint DAN sejarah perbualan. Setiap elemen data membawa metadata asal melalui sistem penjejakan keturunan.

[Baca lebih lanjut tentang Sesi dan Taint.](./taint-and-sessions)

### Gateway

Gateway adalah pusat kawalan — perkhidmatan tempatan yang berjalan lama yang mengurus sesi, saluran, alat, peristiwa, dan proses ejen melalui titik akhir WebSocket JSON-RPC. Ia menyelaraskan perkhidmatan pemberitahuan, penjadual cron, pengambilan webhook, dan penghalaan saluran.

[Baca lebih lanjut tentang Gateway.](./gateway)

### Storan

Semua data berkeadaan mengalir melalui abstraksi `StorageProvider` yang bersatu. Kunci bernamespace (`sessions:`, `taint:`, `lineage:`, `audit:`) memisahkan kebimbangan sambil membolehkan backend ditukar tanpa menyentuh logik perniagaan. Lalai adalah SQLite WAL di `~/.triggerfish/data/triggerfish.db`.

[Baca lebih lanjut tentang Storan.](./storage)

### Pertahanan Berlapis

Keselamatan dibahagi kepada 13 mekanisme bebas, daripada pengesahan saluran dan akses data sedar-kebenaran melalui taint sesi, hook dasar, sandboxing plugin, sandboxing alat sistem fail, dan pengelogan audit. Tiada lapisan tunggal yang mencukupi sendirian; bersama-sama mereka membentuk pertahanan yang menurun dengan anggun walaupun satu lapisan terkompromi.

[Baca lebih lanjut tentang Pertahanan Berlapis.](./defense-in-depth)

## Prinsip Reka Bentuk

| Prinsip | Maksudnya |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Penguatkuasaan deterministik** | Hook dasar menggunakan fungsi tulen. Tiada panggilan LLM, tiada kerawakan. Input yang sama sentiasa menghasilkan keputusan yang sama. |
| **Penyebaran taint** | Semua data membawa metadata pengkelasan. Taint sesi hanya boleh meningkat, tidak pernah berkurang. |
| **Tiada write-down** | Data tidak boleh mengalir ke tahap pengkelasan yang lebih rendah. Pernah. |
| **Audit semua** | Semua keputusan dasar dilog dengan konteks penuh: cap masa, jenis hook, ID sesi, input, keputusan, peraturan yang dinilai. |
| **Hook tidak boleh dipalsukan** | LLM tidak boleh memintas, mengubah, atau mempengaruhi keputusan hook dasar. Hook berjalan dalam kod di bawah lapisan LLM. |
| **Pengasingan sesi** | Setiap sesi menjejak taint secara bebas. Sesi latar belakang dilahirkan dengan taint PUBLIC yang segar. Ruang kerja ejen diasingkan sepenuhnya. |
| **Abstraksi storan** | Tiada modul yang mencipta storan sendiri. Semua kegigihan mengalir melalui `StorageProvider`. |

## Timbunan Teknologi

| Komponen | Teknologi |
| ------------------ | ------------------------------------------------------------------------- |
| Runtime | Deno 2.x (mod ketat TypeScript) |
| Ujian | Pelari ujian terbina dalam Deno |
| Saluran | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Automasi penyemak imbas | puppeteer-core (CDP) |
| Suara | Whisper (STT tempatan), ElevenLabs/OpenAI (TTS) |
| Storan | SQLite WAL (lalai), backend enterprise (Postgres, S3) |
| Rahsia | Keychain OS (peribadi), integrasi vault (enterprise) |

::: info Triggerfish tidak memerlukan alat binaan luaran, Docker, atau kebergantungan awan. Ia berjalan secara tempatan, memproses data secara tempatan, dan memberikan pengguna kedaulatan penuh ke atas data mereka. :::
