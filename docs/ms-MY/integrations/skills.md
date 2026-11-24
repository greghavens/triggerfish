# Platform Kemahiran

Kemahiran adalah mekanisme kebolehpanjangan utama Triggerfish. Kemahiran adalah folder yang mengandungi fail `SKILL.md` -- arahan dan metadata yang memberi ejen keupayaan baru tanpa memerlukan anda menulis plugin atau membina kod tersuai.

Kemahiran adalah cara ejen belajar melakukan perkara baru: semak kalendar anda, sediakan taklimat pagi, triaj isu GitHub, draf ringkasan mingguan. Kemahiran boleh dipasang dari pasaran, ditulis dengan tangan, atau dikarang oleh ejen sendiri.

## Apakah Kemahiran?

Kemahiran adalah folder dengan fail `SKILL.md` di akarnya. Fail tersebut mengandungi frontmatter YAML (metadata) dan badan markdown (arahan untuk ejen). Fail sokongan pilihan -- skrip, templat, konfigurasi -- boleh tinggal bersamanya.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Kod sokongan pilihan
  template.md        # Templat pilihan
```

Frontmatter `SKILL.md` mengisytiharkan apa yang kemahiran lakukan, apa yang diperlukannya, dan kekangan keselamatan apa yang terpakai:

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Instructions

When triggered (daily at 7 AM) or invoked by the user:

1. Fetch today's calendar events from Google Calendar
2. Summarize unread emails from the last 12 hours
3. Get the weather forecast for the user's location
4. Compile a concise briefing and deliver it to the configured channel

Format the briefing with sections for Calendar, Email, and Weather.
Keep it scannable -- bullet points, not paragraphs.
```

### Medan Frontmatter

| Medan                                         | Diperlukan | Keterangan                                                                  |
| --------------------------------------------- | :--------: | --------------------------------------------------------------------------- |
| `name`                                        |    Ya      | Pengecam kemahiran unik                                                     |
| `description`                                 |    Ya      | Keterangan yang boleh dibaca manusia tentang apa yang kemahiran lakukan     |
| `version`                                     |    Ya      | Versi semantik                                                              |
| `category`                                    |   Tidak    | Kategori pengelompokan (produktiviti, pembangunan, komunikasi, dll.)        |
| `tags`                                        |   Tidak    | Tag yang boleh dicari untuk penemuan                                        |
| `triggers`                                    |   Tidak    | Peraturan pemanggilan automatik (jadual cron, corak peristiwa)              |
| `metadata.triggerfish.classification_ceiling` |   Tidak    | Tahap taint maksimum yang boleh dicapai kemahiran ini (lalai: `PUBLIC`)    |
| `metadata.triggerfish.requires_tools`         |   Tidak    | Alat yang bergantung pada kemahiran (pelayar, exec, dll.)                   |
| `metadata.triggerfish.network_domains`        |   Tidak    | Titik akhir rangkaian yang dibenarkan untuk kemahiran                       |

## Jenis Kemahiran

Triggerfish menyokong tiga jenis kemahiran, dengan susunan keutamaan yang jelas apabila nama bercanggah.

### Kemahiran Terbundel

Dihantar bersama Triggerfish dalam direktori `skills/bundled/`. Diselenggarakan oleh projek. Sentiasa tersedia.

Triggerfish merangkumi sepuluh kemahiran terbundel yang menjadikan ejen mencukupi diri dari hari pertama:

| Kemahiran                 | Keterangan                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Metodologi Pembangunan Didorong Ujian untuk Deno 2.x. Kitaran merah-hijau-susun semula, corak `Deno.test()`, penggunaan `@std/assert`, pengujian jenis Result, pembantu ujian. |
| **mastering-typescript**  | Corak TypeScript untuk Deno dan Triggerfish. Mod ketat, `Result<T, E>`, jenis berjenama, fungsi kilang, antara muka tidak boleh diubah, tong `mod.ts`. |
| **skill-builder**         | Cara mengarang kemahiran baru. Format SKILL.md, medan frontmatter, siling pengkelasan, aliran kerja pengarangan diri, pengimbasan keselamatan. |
| **integration-builder**   | Cara membina integrasi Triggerfish. Semua enam corak: penyesuai saluran, pembekal LLM, pelayan MCP, pembekal penyimpanan, alat exec, dan plugin. |
| **git-branch-management** | Aliran kerja cawangan git untuk pembangunan. Cawangan ciri, komit atomik, penciptaan PR melalui `gh` CLI, penjejakan PR, gelung maklum balas semakan melalui webhook, cantum dan bersihkan. |
| **deep-research**         | Metodologi penyelidikan berbilang langkah. Penilaian sumber, carian selari, sintesis, dan pemformatan petikan. |
| **pdf**                   | Pemprosesan dokumen PDF. Pengekstrakan teks, ringkasan, dan pengekstrakan data berstruktur dari fail PDF. |
| **triggerfish**           | Pengetahuan diri tentang dalaman Triggerfish. Seni bina, konfigurasi, penyelesaian masalah, dan corak pembangunan. |
| **triggers**              | Pengarangan tingkah laku proaktif. Menulis fail TRIGGER.md yang berkesan, corak pemantauan, dan peraturan peningkatan. |

Ini adalah kemahiran bootstrap -- ejen menggunakannya untuk melanjutkan dirinya sendiri. skill-builder mengajar ejen cara mencipta kemahiran baru, dan integration-builder mengajarnya cara membina penyesuai dan pembekal baru.

Lihat [Membina Kemahiran](/ms-MY/integrations/building-skills) untuk panduan langsung mencipta anda sendiri.

### Kemahiran Diurus

Dipasang dari **The Reef** (pasaran kemahiran komuniti). Dimuat turun dan disimpan dalam `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Kemahiran Ruang Kerja

Dicipta oleh pengguna atau dikarang oleh ejen dalam [persekitaran exec](./exec-environment). Disimpan dalam ruang kerja ejen di `~/.triggerfish/workspace/<agent-id>/skills/`.

Kemahiran ruang kerja mengambil keutamaan tertinggi. Jika anda mencipta kemahiran dengan nama yang sama seperti kemahiran terbundel atau diurus, versi anda mengambil keutamaan.

```
Keutamaan:  Ruang Kerja  >  Diurus  >  Terbundel
```

::: tip Susunan keutamaan ini bermakna anda sentiasa boleh menindih kemahiran terbundel atau pasaran dengan versi anda sendiri. Penyesuaian anda tidak pernah ditindih oleh kemas kini. :::

## Penemuan dan Pemuatan Kemahiran

Apabila ejen bermula atau apabila kemahiran berubah, Triggerfish menjalankan proses penemuan kemahiran:

1. **Pengimbas** -- Mencari semua kemahiran yang dipasang merentasi direktori terbundel, diurus, dan ruang kerja
2. **Pemuat** -- Membaca frontmatter SKILL.md dan mengesahkan metadata
3. **Penyelesai** -- Menyelesaikan konflik penamaan menggunakan susunan keutamaan
4. **Pendaftaran** -- Menjadikan kemahiran tersedia kepada ejen dengan keupayaan dan kekangan yang diisytiharkan

Kemahiran dengan `triggers` dalam frontmatter mereka secara automatik dihubungkan ke penjadual. Kemahiran dengan `requires_tools` diperiksa terhadap alat yang tersedia ejen -- jika alat yang diperlukan tidak tersedia, kemahiran ditandakan tetapi tidak disekat.

## Pengarangan Diri Ejen

Pembeza utama: ejen boleh menulis kemahirannya sendiri. Apabila diminta melakukan sesuatu yang tidak tahu, ejen boleh menggunakan [persekitaran exec](./exec-environment) untuk mencipta `SKILL.md` dan kod sokongan, kemudian membungkusnya sebagai kemahiran ruang kerja.

### Aliran Pengarangan Diri

```
1. Anda:   "Saya perlukan anda menyemak Notion saya untuk tugas baru setiap pagi"
2. Ejen:   Mencipta kemahiran di ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
           Menulis SKILL.md dengan metadata dan arahan
           Menulis kod sokongan (notion-tasks.ts)
           Menguji kod dalam persekitaran exec
3. Ejen:   Menandakan kemahiran sebagai PENDING_APPROVAL
4. Anda:   Menerima pemberitahuan: "Kemahiran baru dicipta: notion-tasks. Semak dan luluskan?"
5. Anda:   Meluluskan kemahiran
6. Ejen:   Menghubungkan kemahiran ke cron job untuk pelaksanaan harian
```

::: warning KESELAMATAN Kemahiran yang dikarang oleh ejen sentiasa memerlukan kelulusan pemilik sebelum menjadi aktif. Ejen tidak boleh meluluskan kemahirannya sendiri. Ini menghalang ejen dari mencipta keupayaan yang memintas pengawasan anda. :::

### Kawalan Perusahaan

Dalam penerapan perusahaan, kawalan tambahan terpakai kepada kemahiran yang dikarang sendiri:

- Kemahiran yang dikarang ejen sentiasa memerlukan kelulusan pemilik atau pentadbir
- Kemahiran tidak boleh mengisytiharkan siling pengkelasan di atas kebenaran pengguna
- Pengisytiharan titik akhir rangkaian diaudit
- Semua kemahiran yang dikarang sendiri direkodkan untuk semakan pematuhan

## The Reef <ComingSoon :inline="true" />

The Reef adalah pasaran kemahiran komuniti Triggerfish -- daftar di mana anda boleh menemui, memasang, menerbitkan, dan berkongsi kemahiran.

| Ciri                | Keterangan                                             |
| ------------------- | ------------------------------------------------------ |
| Cari dan semak imbas | Cari kemahiran mengikut kategori, tag, atau populariti |
| Pasang satu-arahan  | `triggerfish skill install <nama>`                     |
| Terbitkan           | Kongsi kemahiran anda dengan komuniti                  |
| Pengimbasan keselamatan | Pengimbasan automatik untuk corak hasad sebelum penyenaraian |
| Pengurusan versi    | Kemahiran diberi versi dengan pengurusan kemas kini    |
| Ulasan dan penilaian | Maklum balas komuniti tentang kualiti kemahiran        |

### Arahan CLI

```bash
# Cari kemahiran
triggerfish skill search "calendar"

# Pasang kemahiran dari The Reef
triggerfish skill install google-cal

# Senaraikan kemahiran yang dipasang
triggerfish skill list

# Kemas kini semua kemahiran diurus
triggerfish skill update --all

# Terbitkan kemahiran ke The Reef
triggerfish skill publish

# Buang kemahiran
triggerfish skill remove google-cal
```

### Keselamatan

Kemahiran yang dipasang dari The Reef melalui kitaran hayat yang sama seperti integrasi lain:

1. Dimuat turun ke direktori kemahiran diurus
2. Diimbas untuk corak hasad (suntikan kod, akses rangkaian tidak dibenarkan, dll.)
3. Memasuki keadaan `UNTRUSTED` sehingga anda mengkelaskannya
4. Diklasifikasikan dan diaktifkan oleh pemilik atau pentadbir

::: info The Reef mengimbas semua kemahiran yang diterbitkan untuk corak hasad yang diketahui sebelum ia disenaraikan. Walau bagaimanapun, anda masih sepatutnya menyemak kemahiran sebelum mengkelaskannya, terutama kemahiran yang mengisytiharkan akses rangkaian atau memerlukan alat berkuasa seperti `exec` atau `browser`. :::

## Ringkasan Keselamatan Kemahiran

- Kemahiran mengisytiharkan keperluan keselamatan mereka lebih awal (siling pengkelasan, alat, domain rangkaian)
- Akses alat digerbang oleh dasar -- kemahiran yang `requires_tools: [browser]` tidak akan berfungsi jika akses pelayar disekat oleh dasar
- Domain rangkaian dikuatkuasakan -- kemahiran tidak boleh mengakses titik akhir yang tidak diisytiharkannya
- Kemahiran yang dikarang ejen memerlukan kelulusan pemilik/pentadbir yang eksplisit
- Semua pemanggilan kemahiran melalui hook dasar dan diaudit sepenuhnya
