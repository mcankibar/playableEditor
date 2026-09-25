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
Her varyant en son hangi release ile düzenlendiğini/kontrol edildiğini saklar; daha yeni bir release varsa
listede "New release — check" ve editörde bir uyarı çıkar (artık olmayan alanlarla birlikte). "Playtest" ile
denenir, "Mark as checked" ile kapatılır; son release'te hatasız bir playtest de kontrol sayılır. Bir varyant
**Releases** penceresinden bir release'e sabitlenebilir (pin): o zaman önizleme ve export o release'i kullanır.

## Birlikte çalışma

- **Kayıt:** Editör sadece değişen alanları, başladığı revizyonla birlikte gönderir. İki kişi aynı varyantın
  farklı alanlarını düzenlerse ikisi de kaydedilir; açık editörler diğerinin değişikliğini ~8 sn içinde görür.
  Aynı alanı başkası değiştirdiyse "Conflicting changes" penceresi çıkar: _Keep mine_ / _Take theirs_.
- **Geçmiş (History):** Her düzenleme oturumu (aynı kişinin 10 dk içindeki kayıtları) bir kayıttır; ne değiştiği
  görülür, herhangi biri "Restore" ile geri getirilir (geri getirme de geçmişe yazılır).
- **Export:** Ekrandaki revizyonla yapılır; kaydedilmemiş değişiklik varsa önce kaydedilir, sunucudaki varyant
  farklıysa export reddedilir. Her export kaydedilir (kim, hangi revizyon, release, ağ, dil) ve **Exports**
  panelinden "Download again" ile aynı dosya yeniden üretilir (bayt bayt aynı olduğu kontrol edilir).
- **Toplu export:** Listede varyantlar işaretlenip "Export…" ile hepsi ağ × dil için arka planda paketlenir;
  ilerleme görünür, sonunda tek ZIP (varyant başına bir klasör + `export-summary.json`) iner. Paketleme
  worker thread'lerde çalışır, API'yi bloklamaz.
- **Kütüphane:** Arama (ad, etiket, kişi), durum (Draft / In review / Approved / Live) ve etiket filtreleri;
  işaretlenen varyantlara toplu durum/etiket. Yeni / kopya / ayrıntılar bir formla düzenlenir.
- **Asset kütüphanesi:** Bir oyun için yüklenen her dosya o oyunun kütüphanesine girer; görsel alanlarındaki
  "Library" ile başka varyantta tekrar kullanılır.
- **Boyut:** Üst çubuktaki gösterge, varyantın her ağdaki paket boyutunu anlık tahmin eder (kapalı parçalar
  hariç); tıklanınca ağ ağ listeler. HTML ağları kesin, ZIP ağları yaklaşık.

## Level editörü ve Playtest

- Oyun bir level alanına `editor: { type: "board", palette: [...] }` verirse (Match Squad'da `levelString`),
  alan ızgara olarak düzenlenir: paletten seç, boya (sağ tık / Alt+tık: damlalık), satır/sütun, level ekle/sil,
  başlangıç eşleşmeleri kırmızı, "Random fill" eşleşmesiz doldurur, "Text" ham metni gösterir. Palet görselleri
  varyantın kendi atlaslarından gelir (taş seti değişirse editör de değişir).
- **Playtest:** Oyun `registerBot(...)` ile bir bot adaptörü veriyorsa (template runtime'ı, "Bot playtest"),
  Studio varyantı gizli bir önizlemede hızlandırılmış olarak N kez oynatır: kazanma oranı, zorluk etiketi,
  kalan hamle, hatalar. Sonuç varyanta kaydedilir ve listede görünür. Birden fazla varyant seçilince "Check",
  her birini kısa oynatıp yeni release'te yüklenip hatasız çalıştığını doğrular. Adaptörü olmayan oyunlarda
  "This game doesn't support playtesting yet" yazar.

## Yedek ve depolama

Sunucu açıkken günde bir yedek alınır (`STUDIO_BACKUP_DIR`, varsayılan `data/` yanındaki `backups/`):
`db/studio-<gün>.db` (son 14 gün) + `releases/` ve `assets/` (bir kez kopyalanır, dosyalar değişmez).
Ana sayfadaki **Storage** bölümünde son yedek, "Back up now" ve "Clean up unused files" (hiçbir varyant,
geçmiş kaydı, export kaydı ya da kütüphanenin kullanmadığı, bir günden eski yüklemeleri siler) vardır.

Geri yükleme: Studio'yu durdur, `db/studio-<gün>.db` → `<data>/studio.db`, `releases/` ve `assets/` →
`<data>/` kopyala, başlat. Yedek klasörünü başka bir diske (ya da senkronize bir klasöre) koy; aynı disk
bozulursa yedek de gider.

Silme: release'ler (son release ve sabitlenmiş olanlar hariç) Releases penceresinden, oyunlar ana sayfadan
(oyun kimliği yazılarak onaylanır) silinir.

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

| Değişken                | Varsayılan                  | Açıklama                                                       |
| ----------------------- | --------------------------- | -------------------------------------------------------------- |
| `PORT`                  | `5300`                      |                                                                |
| `HOST`                  | `localhost`                 | sunucuda / container'da `0.0.0.0`                              |
| `PLAYABLE_DATA`         | `./data`                    | veritabanı ve dosyaların klasörü                               |
| `STUDIO_ADMIN_USER`     | `admin`                     | kullanıcı yokken açılacak ilk hesap                            |
| `STUDIO_ADMIN_PASSWORD` |                             | ⤴ şifresi                                                      |
| `STUDIO_AUTH`           | prod'da `1`                 | `0`: giriş yok, herkes yerel kullanıcı (sadece yerel test)     |
| `STUDIO_SECURE_COOKIES` | prod'da `1`                 | HTTPS yoksa `0` (cookie `Secure` olursa http'de çalışmaz)      |
| `STUDIO_TRUST_PROXY`    | `0`                         | reverse proxy arkasında `1` (giriş kilidi gerçek IP'yi görsün) |
| `STUDIO_BACKUP_DIR`     | `../backups` (data'ya göre) | günlük yedeklerin klasörü; başka bir disk önerilir             |
| `STUDIO_BACKUP_KEEP`    | `14`                        | tutulacak günlük veritabanı kopyası                            |
| `STUDIO_BACKUP`         | `1`                         | `0`: yedek kapalı                                              |

## Henüz yok

Rol/yetki ayrımı, varyant kartlarında önizleme görüntüsü, önizlemenin ayrı bir origin'de izole çalışması
(şu an release'in kodu Studio ile aynı origin'de çalışır, yani önizleyen kişinin oturumuyla API'ye
istek atabilir; release'leri ekipteki geliştiriciler yüklediği için kabul edilebilir).
