---
title: Pusat Kepercayaan
description: Kawalan keselamatan, kedudukan pematuhan, dan ketelusan seni bina untuk Triggerfish.
---

# Pusat Kepercayaan

Triggerfish menguatkuasakan keselamatan dalam kod deterministik di bawah lapisan LLM -- bukan dalam arahan yang mungkin diabaikan oleh model. Setiap keputusan dasar dibuat oleh kod yang tidak boleh dipengaruhi oleh suntikan arahan, kejuruteraan sosial, atau salah laku model. Lihat halaman [Reka Bentuk Keselamatan-Dahulu](/ms-MY/security/) penuh untuk penjelasan teknikal mendalam.

## Kawalan Keselamatan

Kawalan ini aktif dalam keluaran semasa. Setiap satu dikuatkuasakan dalam kod, diuji dalam CI, dan boleh diaudit dalam repositori sumber terbuka.

| Kawalan                           | Status                           | Keterangan                                                                                                                                           |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Penguatkuasaan Dasar Sub-LLM      | <StatusBadge status="active" />  | Lapan hook deterministik memintas setiap tindakan sebelum dan selepas pemprosesan LLM. Model tidak boleh memintas, mengubah suai, atau mempengaruhi keputusan keselamatan. |
| Sistem Pengkelasan Data           | <StatusBadge status="active" />  | Hierarki empat peringkat (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) dengan penguatkuasaan tanpa-tulis-bawah mandatori.                             |
| Penjejakan Taint Sesi             | <StatusBadge status="active" />  | Setiap sesi menjejaki pengkelasan data tertinggi yang diakses. Taint hanya meningkat, tidak pernah menurun.                                          |
| Log Audit Tidak Boleh Diubah      | <StatusBadge status="active" />  | Semua keputusan dasar dilog dengan konteks penuh. Log audit tidak boleh dilumpuhkan oleh mana-mana komponen sistem.                                  |
| Pengasingan Rahsia                | <StatusBadge status="active" />  | Kelayakan disimpan dalam keychain OS atau vault. Tidak pernah dalam fail konfigurasi, storan, log, atau konteks LLM.                                 |
| Sandboxing Plugin                 | <StatusBadge status="active" />  | [Pemalam](../integrations/plugins) |
| Pengimbasan Kebergantungan        | <StatusBadge status="active" />  | Pengimbasan kelemahan automatik melalui GitHub Dependabot. PR dibuka secara automatik untuk CVE hulu.                                               |
| Kod Sumber Terbuka                | <StatusBadge status="active" />  | Seni bina keselamatan penuh berlesen Apache 2.0 dan boleh diaudit secara awam.                                                                       |
| Pelancaran Dalam Premis           | <StatusBadge status="active" />  | Berjalan sepenuhnya pada infrastruktur anda. Tiada kebergantungan awan, tiada telemetri, tiada pemprosesan data luaran.                              |
| Enkripsi                          | <StatusBadge status="active" />  | TLS untuk semua data dalam transit. Enkripsi peringkat OS semasa rehat. Integrasi vault perusahaan tersedia.                                         |
| Program Pendedahan Bertanggungjawab | <StatusBadge status="active" /> | Proses pelaporan kelemahan yang terdokumentasi dengan garis masa respons yang ditentukan. Lihat [dasar pendedahan](/ms-MY/security/responsible-disclosure). |
| Imej Bekas Dikeraskan             | <StatusBadge status="planned" /> | Imej Docker pada asas Google Distroless dengan hampir sifar CVE. Pengimbasan Trivy automatik dalam CI.                                               |

## Pertahanan Berlapis -- 13 Lapisan Bebas

Tiada satu lapisan pun yang mencukupi sendiri. Jika satu lapisan terkompromi, lapisan yang tinggal terus melindungi sistem.

| Lapisan | Nama                               | Penguatkuasaan                                           |
| ------- | ---------------------------------- | -------------------------------------------------------- |
| 01      | Pengesahan Saluran                 | Identiti yang disahkan oleh kod semasa penubuhan sesi    |
| 02      | Akses Data Sedar-Kebenaran         | Kebenaran sistem sumber, bukan kelayakan sistem          |
| 03      | Penjejakan Taint Sesi              | Automatik, mandatori, peningkatan sahaja                 |
| 04      | Keturunan Data                     | Rantaian provenance penuh untuk setiap elemen data       |
| 05      | Hook Penguatkuasaan Dasar          | Deterministik, tidak boleh dipintas, dilog               |
| 06      | MCP Gateway                        | Kebenaran per-alat, pengkelasan pelayan                  |
| 07      | Sandbox Plugin                     | [Pemalam](../integrations/plugins) |
| 08      | Pengasingan Rahsia                 | Keychain OS atau vault, di bawah lapisan LLM             |
| 09      | Sandbox Alat Sistem Fail           | Penjara laluan, pengkelasan laluan, I/O berlingkup-taint |
| 10      | Identiti & Delegasi Ejen           | Rantaian delegasi kriptografi                            |
| 11      | Log Audit                          | Tidak boleh dilumpuhkan                                  |
| 12      | Pencegahan SSRF                    | Senarai tolak IP + semakan resolusi DNS                  |
| 13      | Penggerbangan Pengkelasan Memori   | Tulis pada tahap sendiri, baca ke bawah sahaja           |

Baca dokumentasi seni bina [Pertahanan Berlapis](/ms-MY/architecture/defense-in-depth) penuh.

## Mengapa Penguatkuasaan Sub-LLM Penting

::: info Kebanyakan platform ejen AI menguatkuasakan keselamatan melalui arahan sistem -- arahan kepada LLM yang berkata "jangan kongsi data sensitif." Serangan suntikan arahan boleh mengatasi arahan ini.

Triggerfish mengambil pendekatan berbeza: LLM mempunyai **sifar autoriti** ke atas keputusan keselamatan. Semua penguatkuasaan berlaku dalam kod deterministik di bawah lapisan LLM. Tiada laluan dari output LLM ke konfigurasi keselamatan. :::

## Peta Jalan Pematuhan

Triggerfish adalah pra-pensijilan. Kedudukan keselamatan kami adalah seni bina dan boleh disahkan dalam kod sumber hari ini. Pensijilan formal ada dalam peta jalan.

| Pensijilan                   | Status                           | Nota                                                                  |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| SOC 2 Jenis I                | <StatusBadge status="planned" /> | Kriteria perkhidmatan kepercayaan Keselamatan + Kerahsiaan            |
| SOC 2 Jenis II               | <StatusBadge status="planned" /> | Keberkesanan kawalan berterusan sepanjang tempoh pemerhatian          |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Perjanjian rakan kongsi perniagaan untuk pelanggan penjagaan kesihatan |
| ISO 27001                    | <StatusBadge status="planned" /> | Sistem pengurusan keselamatan maklumat                                |
| Ujian Penembusan Pihak Ketiga | <StatusBadge status="planned" /> | Penilaian keselamatan bebas                                           |
| Pematuhan GDPR               | <StatusBadge status="planned" /> | Seni bina hos sendiri dengan pengekalan dan pemadaman yang boleh dikonfigurasi |

## Nota tentang Kepercayaan

::: tip Teras keselamatan adalah sumber terbuka di bawah Apache 2.0. Anda boleh membaca setiap baris kod penguatkuasaan dasar, menjalankan suite ujian, dan mengesahkan tuntutan sendiri. Pensijilan ada dalam peta jalan. :::

## Audit Sumber

Kod sumber Triggerfish penuh tersedia di
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) --
berlesen Apache 2.0.

## Pelaporan Kelemahan

Jika anda menemui kelemahan keselamatan, sila laporkannya melalui [Dasar Pendedahan Bertanggungjawab](/ms-MY/security/responsible-disclosure) kami. Jangan buka isu GitHub awam untuk kelemahan keselamatan.
