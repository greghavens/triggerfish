# Pemalam

Dayakan pemalam TypeScript dalam konfigurasi pengguna dengan `enabled: true`. Secara lalai, import dan pelaksanaan berlaku dalam Deno Worker dengan kebenaran terhad. Worker boleh membaca direktori pemalam dan hanya menyambung kepada hos dan port dalam `declaredEndpoints`. Penulisan fail, pembacaan persekitaran proses, subproses, FFI dan maklumat sistem terhad disekat. `trust: trusted` membenarkan import dalam proses Triggerfish. Pelaksana berjalan dalam proses itu jika manifes turut menyatakan `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Panduan pemalam lengkap](/integrations/plugins)

## Penamaan Ruang Nama Alat

Alat diberi awalan secara automatik untuk mencegah perlanggaran:

- Alat plugin `forecast` dalam plugin `weather` menjadi `plugin_weather_forecast`
- Pelaksana mendekod awalan (padanan terpanjang-dahulu) dan mendelegasikan ke plugin yang betul dengan nama alat asal

## Pengkelasan dan Taint

Alat plugin mengikut peraturan pengkelasan yang sama seperti semua alat lain:

- Tahap `classification` manifes didaftarkan untuk semua alat dengan awalan `plugin_<name>_`
- Taint sesi meningkat apabila alat plugin mengembalikan data pada tahap yang lebih tinggi
- Pencegahan tulis-bawah terpakai: plugin CONFIDENTIAL tidak boleh mengalirkan datanya ke saluran PUBLIC
- Semua penguatkuasaan hook (PRE_TOOL_CALL, POST_TOOL_RESPONSE) terpakai tanpa perubahan

## The Reef: Pasaran Plugin

Plugin boleh diterbitkan ke dan dipasang dari The Reef, pasaran yang sama yang digunakan untuk kemahiran.

### Arahan CLI

```bash
triggerfish plugin search "weather"     # Cari plugin
triggerfish plugin install weather      # Pasang dari The Reef
triggerfish plugin update               # Semak kemas kini
triggerfish plugin publish ./my-plugin  # Sediakan untuk penerbitan
triggerfish plugin scan ./my-plugin     # Imbasan keselamatan
triggerfish plugin list                 # Senaraikan plugin yang dipasang
```

### Pasang dari The Reef

Pemasangan Reef disahkan dengan checksum SHA-256 dan diimbas keselamatan sebelum pengaktifan:

```
1. Ambil catalog.json (dicache 1 jam)
2. Cari versi terkini plugin
3. Muat turun mod.ts
4. Sahkan checksum SHA-256 sepadan dengan entri katalog
5. Tulis ke ~/.triggerfish/plugins/<name>/mod.ts
6. Imbasan keselamatan -- buang jika imbasan gagal
7. Rekod hash integriti dalam .plugin-hash.json
```

### Penerbitan

Arahan terbit mengesahkan plugin (manifes, eksport, imbasan keselamatan), mengira checksum SHA-256, dan menghasilkan struktur direktori yang bersedia untuk penyerahan ke repositori Reef.
