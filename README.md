# Playable Studio

Playable oyunlarının release'lerini toplayan, varyant düzenleyip canlı önizleyen ve reklam ağları için
export alan editör.

```bash
npm install
npm run users -- add mehmet   # ilk kullanıcı (şifre sorulur)
npm run dev        # http://localhost:5300 — API + arayüz tek portta (Vite middleware)
npm test           # API testleri
npm run build && npm start   # arayüzü dist/'e derleyip üretim modunda çalıştırır
```

## Kullanıcılar ve giriş

Kayıt ekranı yok; hesapları Studio'yu çalıştıran kişi açar. Herkes aynı yetkiye sahiptir.

```bash
npm run users -- list
npm run users -- add ayse               # şifre sorulur (en az 8 karakter)
npm run users -- passwd ayse            # yeni şifre; açık oturumları kapatır
npm run users -- remove ayse
npm run users -- token mehmet laptop    # `npm run release` için publish token (bir kez gösterilir)
npm run users -- revoke-tokens mehmet
```

- Şifreler scrypt ile saklanır. Oturum 30 gün geçerli, `HttpOnly; SameSite=Lax` cookie'de tutulur
  (canlıda `Secure`). Veritabanında oturum ve token'ların yalnızca hash'i durur.
- 15 dakikada 10 hatalı girişten sonra o adresten giriş 15 dakika kilitlenir.
- Publish token'ları yalnızca release yükleyebilir (`Authorization: Bearer …`). Oyun klasöründe
  `.env.local` dosyasına yazılır (git'e girmez):
  ```
  PLAYABLE_STUDIO=https://studio.sirket.com
  PLAYABLE_STUDIO_TOKEN=pst_…
  ```
- `npm run dev` girişsiz çalışır (üst çubukta "Sign-in off"); `npm start` giriş ister. İkisi de
  `STUDIO_AUTH=0/1` ile değiştirilebilir.
- Kurulumda kullanıcı yoksa `STUDIO_ADMIN_PASSWORD` (ve isteğe bağlı `STUDIO_ADMIN_USER`, varsayılan
  `admin`) ile ilk hesap açılır. Hesap açıldıktan sonra bu değişkenin etkisi yoktur.

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

Üst çubuktan cihaz seçilir (iPhone 16 Pro Max, Galaxy S24, iPad…; boyutlar oyunun gördüğü CSS
çözünürlüğüdür), döndürülür ya da "Özel boyut" girilir. Dynamic Island, çentik ve kamera deliği
ekranın üstüne çizilir: oyunun o bölgelerde önemli bir şey göstermediği kontrol edilebilir. Cihaz
değiştirmek oyunu yeniden başlatmaz, sadece boyutu değiştirir.

**Select (⌖):** Açıkken oyunda üzerine gelinen parça çerçevelenir; tıklanınca sağ panelde o parça kalır:
en üstte tıklanan şeyin görseli ("What you clicked", ör. taş için gems atlası ve kare adı), sonra parçanın
ayarları, altta ilişkili parçalar ("Uses", "Part of", "Inside", "Behind") ("Show all" ile geri dönülür, Esc seçimi kapatır). Paneldeki bir grubun üzerine gelmek de o
parçayı oyunda gösterir. Release'in bunu desteklemesi gerekir (template'in güncel runtime'ı ile build).

Release, aynı origin'den (`/api/releases/<id>/play`) bir iframe'de önizleme modunda çalışır. Editör
değerleri template runtime'ının önizleme protokolüyle gönderir (`{ type: "pl:preview", overrides, assets }`).
İframe boş açılır ve değerler release yüklenmeden `window.name`'e yazılır. Böylece oyun doğrudan varyantın
değerleriyle başlar, tarayıcının yenilemede geri yüklediği eski bir `window.name` de kullanılmaz.

## Ayarlar (ortam değişkenleri)

| Değişken                | Varsayılan  | Açıklama                                                       |
| ----------------------- | ----------- | -------------------------------------------------------------- |
| `PORT`                  | `5300`      |                                                                |
| `HOST`                  | `localhost` | sunucuda / container'da `0.0.0.0`                              |
| `PLAYABLE_DATA`         | `./data`    | veritabanı ve dosyaların klasörü                               |
| `STUDIO_ADMIN_USER`     | `admin`     | kullanıcı yokken açılacak ilk hesap                            |
| `STUDIO_ADMIN_PASSWORD` |             | ⤴ şifresi                                                      |
| `STUDIO_AUTH`           | prod'da `1` | `0`: giriş yok, herkes yerel kullanıcı (sadece yerel test)     |
| `STUDIO_SECURE_COOKIES` | prod'da `1` | HTTPS yoksa `0` (cookie `Secure` olursa http'de çalışmaz)      |
| `STUDIO_TRUST_PROXY`    | `0`         | reverse proxy arkasında `1` (giriş kilidi gerçek IP'yi görsün) |

## Henüz yok

Rol/yetki ayrımı, varyant geçmişi (geri alma), aynı varyantı iki kişinin aynı anda düzenlemesine karşı koruma,
export geçmişi, kullanılmayan yüklemelerin temizlenmesi, önizlemenin ayrı bir origin'de izole çalışması
(şu an release'in kodu Studio ile aynı origin'de çalışır, yani önizleyen kişinin oturumuyla API'ye
istek atabilir; release'leri ekipteki geliştiriciler yüklediği için kabul edilebilir).
