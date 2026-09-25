# Playable Studio

Playable oyunlarının release'lerini toplayan, varyant düzenleyip canlı önizleyen ve reklam ağları için
export alan editör. Şimdilik tek makinede, giriş/çıkış olmadan çalışır.

```bash
npm install
npm run dev        # http://localhost:5300 — API + arayüz tek portta (Vite middleware)
npm test           # API testleri
npm run build && npm start   # arayüzü dist/'e derleyip üretim modunda çalıştırır
```

## Akış

1. **Release yükle.** Oyun klasöründe `npm run release` (build alır ve Studio'ya gönderir) ya da
   `dist/index.html` dosyasını ana sayfaya sürükle-bırak. Oyun `package.json` adıyla tanınır; ilk
   release'te oyun ve boş bir "Default" varyantı oluşur. Aynı build ikinci kez yüklenmez.
2. **Varyant düzenle.** Alanlar release'in manifest'inden gelir (oyunun `src/params.js`'i). Değişiklikler
   yarım saniye sonra otomatik kaydedilir ve önizlemeye anında gider: oyun destekliyorsa canlı, ↻ işaretli
   alanlarda baştan başlayarak. Görsel/ses gibi dosyalar yüklenince içerik hash'iyle saklanır (`u/<hash>.<ext>`).
3. **Export.** Ağ × dil seçilir; tek çıktı doğrudan, birden fazlası `report.json` ile birlikte ZIP olarak
   iner. Çıktılar template'teki `npm run export` ile birebir aynıdır.

Varyant release'e değil oyuna bağlıdır: yeni release geldiğinde varyantlar olduğu gibi yeni sürüme uygulanır.
Yeni release'te artık olmayan alanlar editörde uyarı olarak görünür ve export'ta yok sayılır. Eski bir
release, üst çubuktan seçilerek önizlenebilir ve export edilebilir.

Template dev panelinin indirdiği `variant.json` dosyaları "İçe aktar" ile alınabilir. "JSON indir" aynı
formatta dosya verir: `npm run export -- --variant=...` ile kullanılabilir.

## Yapı

```
server/        Fastify API (app.js), SQLite metadata (db.js, node:sqlite), dosyalar (store.js), export (exporter.js)
web/           React arayüz: oyun listesi, varyant editörü (form + önizleme), export penceresi
shared/playable/  template'ten kopyalanan release formatı kodu: alan şeması, doğrulama, yama, ağ profilleri
data/          (git dışı) studio.db, releases/<id>.html, assets/<sha256>
```

`shared/playable` elle düzenlenmez; template güncellenince:

```bash
npm run sync-kit -- /path/to/threejstemplate   # varsayılan ../threejstemplate
```

Hangi template commit'inden alındığı `shared/playable/SOURCE.json` dosyasında yazar. Release'in format
sürümü uymazsa yükleme reddedilir.

## Önizleme

Release, aynı origin'den (`/api/releases/<id>/play`) bir iframe'de önizleme modunda çalışır. Editör
değerleri template runtime'ının önizleme protokolüyle gönderir (`{ type: "pl:preview", overrides, assets }`).
İframe boş açılır ve değerler release yüklenmeden `window.name`'e yazılır. Böylece oyun doğrudan varyantın
değerleriyle başlar, tarayıcının yenilemede geri yüklediği eski bir `window.name` de kullanılmaz.

## Ayarlar (ortam değişkenleri)

| Değişken        | Varsayılan  | Açıklama                                             |
| --------------- | ----------- | ---------------------------------------------------- |
| `PORT`          | `5300`      |                                                      |
| `HOST`          | `localhost` | LAN'dan erişim için `0.0.0.0` (henüz giriş yok!)     |
| `PLAYABLE_DATA` | `./data`    | veritabanı ve dosyaların klasörü                     |

## Henüz yok

Giriş/yetki, varyant geçmişi (geri alma), aynı varyantı iki kişinin aynı anda düzenlemesine karşı koruma,
export geçmişi, kullanılmayan yüklemelerin temizlenmesi, önizlemenin ayrı bir origin'de izole çalışması.
