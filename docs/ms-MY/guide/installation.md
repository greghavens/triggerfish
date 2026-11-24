# Pemasangan & Penyebaran

Triggerfish dipasang dengan satu perintah pada macOS, Linux, Windows, dan Docker. Pemasang binari memuat turun keluaran pra-bina, mengesahkan checksum SHA256-nya, dan menjalankan wizard persediaan.

## Pasang dalam Satu Perintah

::: code-group

```bash [macOS / Linux]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.ps1 | iex
```

```bash [Docker]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

:::

### Apa yang Dilakukan oleh Pemasang Binari

1. **Mengesan platform** dan seni bina anda
2. **Memuat turun** binari pra-bina terbaru daripada GitHub Releases
3. **Mengesahkan checksum SHA256** untuk memastikan integriti
4. **Memasang** binari ke `/usr/local/bin` (atau `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **Menjalankan wizard persediaan** (`triggerfish dive`) untuk mengkonfigurasi ejen, pembekal LLM, dan saluran anda
6. **Memulakan daemon latar belakang** supaya ejen anda sentiasa berjalan

Selepas pemasang selesai, anda mempunyai ejen yang berfungsi sepenuhnya. Tiada langkah tambahan diperlukan.

### Pasang Versi Tertentu

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Keperluan Sistem

| Keperluan | Butiran |
| ---------------- | ------------------------------------------------------- |
| Sistem Pengendalian | macOS, Linux, atau Windows |
| Ruang Cakera | Lebih kurang 100 MB untuk binari yang dikompil |
| Rangkaian | Diperlukan untuk panggilan API LLM; semua pemprosesan berjalan secara tempatan |

::: tip Tiada Docker, tiada bekas, tiada akaun awan diperlukan. Triggerfish adalah binari tunggal yang berjalan pada mesin anda. Docker tersedia sebagai kaedah penyebaran alternatif. :::

## Docker

Penyebaran Docker menyediakan pembalut CLI `triggerfish` yang memberikan anda pengalaman perintah yang sama seperti binari natif. Semua data berada dalam volum Docker yang dinamakan.

### Permulaan Cepat

Pemasang menarik imej, memasang pembalut CLI, dan menjalankan wizard persediaan:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Atau jalankan pemasang daripada checkout tempatan:

```bash
./deploy/docker/install.sh
```

Pemasang:

1. Mengesan masa jalan bekas anda (podman atau docker)
2. Memasang pembalut CLI `triggerfish` ke `~/.local/bin` (atau `/usr/local/bin`)
3. Menyalin fail compose ke `~/.triggerfish/docker/`
4. Menarik imej terbaru
5. Menjalankan wizard persediaan (`triggerfish dive`) dalam bekas satu-tembak
6. Memulakan perkhidmatan

### Penggunaan Harian

Selepas pemasangan, perintah `triggerfish` berfungsi sama seperti binari natif:

```bash
triggerfish chat              # Sesi chat interaktif
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Diagnostik kesihatan
triggerfish logs              # Lihat log bekas
triggerfish status            # Semak sama ada bekas sedang berjalan
triggerfish stop              # Hentikan bekas
triggerfish start             # Mulakan bekas
triggerfish update            # Tarik imej terbaru dan mulakan semula
triggerfish dive              # Jalankan semula wizard persediaan
```

### Cara Pembalut Berfungsi

Skrip pembalut (`deploy/docker/triggerfish`) menghalakan perintah:

| Perintah | Tingkah Laku |
| --------------- | ------------------------------------------------------------ |
| `start` | Mulakan bekas melalui compose |
| `stop` | Hentikan bekas melalui compose |
| `run` | Jalankan di latar depan (Ctrl+C untuk berhenti) |
| `status` | Tunjukkan keadaan berjalan bekas |
| `logs` | Alir log bekas |
| `update` | Tarik imej terbaru, mulakan semula |
| `dive` | Bekas satu-tembak jika tidak berjalan; exec + mulakan semula jika berjalan |
| Semua yang lain | `exec` ke dalam bekas yang sedang berjalan |

Pembalut mengesan `podman` vs `docker` secara automatik. Gantikan dengan `TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Fail compose berada di `~/.triggerfish/docker/docker-compose.yml` selepas pemasangan. Anda juga boleh menggunakannya secara langsung:

```bash
cd deploy/docker
docker compose up -d
```

### Pemboleh Ubah Persekitaran

Salin `.env.example` ke `.env` di sebelah fail compose untuk menetapkan kunci API melalui pemboleh ubah persekitaran:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Edit ~/.triggerfish/docker/.env
```

### Rahsia dalam Docker

Oleh kerana keychain OS tidak tersedia dalam bekas, Triggerfish menggunakan stor rahsia yang disokong fail di `/data/secrets.json` di dalam volum. Gunakan pembalut CLI untuk mengurus rahsia:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Kegigihan Data

Bekas menyimpan semua data di bawah `/data`:

| Laluan | Kandungan |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml` | Konfigurasi |
| `/data/secrets.json` | Stor rahsia yang disokong fail |
| `/data/data/triggerfish.db` | Pangkalan data SQLite (sesi, cron, memori) |
| `/data/workspace/` | Ruang kerja ejen |
| `/data/skills/` | Kemahiran yang dipasang |
| `/data/logs/` | Fail log |
| `/data/SPINE.md` | Identiti ejen |

## Pasang daripada Sumber

Jika anda lebih suka membina daripada sumber atau ingin menyumbang:

```bash
# 1. Pasang Deno (jika anda belum memilikinya)
curl -fsSL https://deno.land/install.sh | sh

# 2. Klon repositori
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Kompil
deno task compile

# 4. Jalankan wizard persediaan
./triggerfish dive

# 5. (Pilihan) Pasang sebagai daemon latar belakang
./triggerfish start
```

::: info Membina daripada sumber memerlukan Deno 2.x dan git. Perintah `deno task compile` menghasilkan binari yang berdiri sendiri tanpa kebergantungan luaran. :::

## Direktori Runtime

Selepas menjalankan `triggerfish dive`, konfigurasi dan data anda berada di `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Konfigurasi utama
├── SPINE.md                  # Identiti dan misi ejen (system prompt)
├── TRIGGER.md                # Triggers tingkah laku proaktif
├── workspace/                # Ruang kerja kod ejen
├── skills/                   # Kemahiran yang dipasang
├── data/                     # Pangkalan data SQLite, keadaan sesi
└── logs/                     # Log daemon dan pelaksanaan
```

## Pengurusan Daemon

Pemasang menyediakan Triggerfish sebagai perkhidmatan latar belakang natif OS:

| Platform | Pengurus Perkhidmatan |
| -------- | -------------------------------- |
| macOS | launchd |
| Linux | systemd |
| Windows | Windows Service / Task Scheduler |

Selepas pemasangan, uruskan daemon dengan:

```bash
triggerfish start     # Pasang dan mulakan daemon
triggerfish stop      # Hentikan daemon
triggerfish status    # Semak sama ada daemon sedang berjalan
triggerfish logs      # Lihat log daemon
```

## Mengemas Kini

Untuk menyemak dan memasang kemas kini:

```bash
triggerfish update
```

## Sokongan Platform

| Platform | Binari | Docker | Skrip Pemasangan |
| ----------- | ------ | ------ | ---------------- |
| Linux x64 | ya | ya | ya |
| Linux arm64 | ya | ya | ya |
| macOS x64 | ya | — | ya |
| macOS arm64 | ya | — | ya |
| Windows x64 | ya | — | ya (PowerShell) |

## Langkah Seterusnya

Dengan Triggerfish dipasang, pergi ke panduan [Permulaan Cepat](./quickstart) untuk mengkonfigurasi ejen anda dan mula berbual.
