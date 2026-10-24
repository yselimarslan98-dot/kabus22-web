# Kabus 22 Web

Kabus 22'nin (Sobee Studios, 2007, Acknex/3D GameStudio A6 motoru) tarayıcıda çalışan motor portu.

**Bu repo oyun verisi içermez.** Site açıldığında kendi Kabus 22 kurulum klasörünü seçersin;
dosyalar doğrudan bilgisayarından, sadece gerektiği kadar okunur. İndirme yok, yükleme yok.

## Durum

| Bileşen | Durum |
|---|---|
| WRS2 arşivleri (`*.wrs`, `*.k22`) | ✅ okunuyor (XOR 0xA5 ad + Okumura LZSS), dizin IndexedDB'de önbellekte |
| WMB6 bölümleri | ✅ geometri, RGB565/BGR888 dokular, ışık haritaları, nesneler |
| Bölüm listesi | ✅ oyunun kendi `LevelYonetim.wdl` dosyasından |
| Oyuncu | ✅ yürüme (kapsül çarpışma, yerçekimi, zıplama, koşma), serbest kamera, fener |
| Kontrolcü | ✅ Gamepad API (Xbox, DualSense, Switch Pro), menülerde gezinme, titreşim |
| MDL4/5/7 modeller, TGA sprite'lar, harita varlıkları | ✅ 795 modelin hepsi okunuyor; ışık bölümün ışık haritasından, köşe animasyonu |
| Varlık bayrakları | ✅ WMB bayrakları + oyunun WDL action'larının başlangıçta açtığı bayraklar (invisible, passable, bright...) |
| Uzak kaynak | ✅ kendi bulut kopyandan HTTP Range ile parça parça okuma, Cache Storage önbelleği |
| Ses (OGG/WAV, 3D ses) | ✅ snd_*/media_* WebAudio üzerinde; 3D denge oyunun kendi hesabıyla |
| WDL (C-Script) derleyici + çalışma zamanı | ✅ oyunun 106 bin satırlık script'i JS'e derleniyor (0 hata); açılış, ana menü, giriş hikâyesi ve ilk bölüm oyunun kendi koduyla çalışıyor |
| Motor fonksiyonları | ✅ paneller/yazılar, ses (snd_*/media_*), dosyalar (kayıtlar IndexedDB'de), klavye/fare/kumanda, level_load, ent_move/trace/scan, animasyon, parçacıklar · ⏳ eksikler test edildikçe |
| Ara sahne videoları (WMV2/WMV3) | ✅ ilk oynatmada tarayıcıda ffmpeg.wasm ile MP4'e çevrilip IndexedDB'de saklanıyor; altyazılar kare numarasıyla (25 kare/sn, karargâh videosunda doğrulandı); media_layer'ın altındaki paneller videonun arkasında kalır |

## Oynamak

1. Siteyi aç, **Oyun klasörünü seç**'e bas ve Kabus 22 klasörünü göster (`Kaynak.k22`'nin bulunduğu klasör).
2. Bölüm seç. Chrome/Edge klasör iznini hatırlar, sonraki açılışta **Devam et** yeterlidir.

| | Klavye / Fare | Kumanda |
|---|---|---|
| Hareket | WASD | Sol çubuk |
| Bakış | Fare (tıklayınca kilitlenir) | Sağ çubuk |
| Koş | Shift | LT / L3 |
| Zıpla / yüksel | Boşluk | A / ✕ |
| Çömel / alçal | C | B / ◯ |
| Fener | F | Y / △ |
| Menü | Esc | Start / Options |

Oyunun içinde oyunun kendi tuşları geçerlidir (Seçenekler'den değiştirilebilir): oklar hareket, S silahı kaldır, D ateş, A koş, Q büyü, M envanter, H harita, Esc menü. D aynı zamanda kapı açma, eşya alma ve inceleme tuşudur. Kumandada: sol çubuk veya yön tuşları hareket, LT silahı kaldır, RT ateş/eylem, LB koş, RB büyü, Y envanter, Back harita, A onay, B / Start geri.

| Arazi (HMP) | ✅ çizim + poligon çarpışma |
| Bölüm taraması | ✅ tanımlı tüm bölümler (1–103; 63 ve 96 oyunda boş) doğru karakterle oyunun kendi yükleyicisiyle açıldı (tools/cdp.mjs) |
| Dövüş | ✅ nişan alma (otomatik hedef), ateş, mermi izleri/sesleri, düşman saldırısı ve hasar, düşman ölümü (Mekke bölümünde test edildi) |
| Envanter | ✅ silahlar/mermi sayıları, nesneler, dokümanlar (metin + görsel), Kullan/Doldur/Göster alt menüsü |
| Kayıt / yükleme | ✅ kayıt noktaları ve otomatik kayıt IndexedDB'ye yazar; ana menüdeki Yükle listesi tarihle gösterir, yükleme bölümü ve durumu geri getirir |
| Oynanış | ✅ 1. bölümde yürüyerek çıkış kapısından 3. bölüme geçiş, kilitli kapı mesajları, eşya/mermi/doküman alma, ilk yardım kullanma, çıkışta tetiklenen ara sahne; kumandayla yürüme, nişan, ateş, envanter |

## Uzak kaynak (kendi kopyan için)

Oyunu kendi depolama alanından açmak için (ör. başka bir bilgisayar):

1. `node tools/manifest.mjs "H:/Kabus 22"` → klasöre `manifest.json` yazar (arşiv dizinleri dahil, ilk açılışta tarama gerekmez).
2. Klasörü (`video/` ve `saves/` hariç) Range isteklerini destekleyen bir depoya yükle, ör. Cloudflare R2.
   CORS'ta site adresine `GET` izni ver ve `Range` başlığına izin ver. Google Drive Range/CORS desteklemediği için uygun değildir.
3. Sitede **Kendi bulut kopyandan aç** → adresi gir. Sadece açılan bölümün baytları indirilir ve önbelleğe alınır.

Bu repo ve site oyun dosyası barındırmaz ve varsayılan bir indirme adresi içermez.

## Geliştirme

```sh
# headless test: K22_PROFILE=<klasör> node tools/cdp.mjs "http://localhost:8022/?dev=1&play=1" adimlar.json
node tools/devserver.mjs "H:/Kabus 22"    # http://localhost:8022/?dev=1&level=Kk  (&ent=opel.mdl&solo=1: tek varlığa bak)
node tools/wrs-cli.mjs list "H:/Kabus 22/K22.wrs"
node tools/wrs-cli.mjs extract "H:/Kabus 22/Kaynak.k22" out/
```

`?dev=1` sadece localhost'ta çalışır ve klasör seçmeden yerel oyun klasörünü kullanır.

## Dosya biçimi notları

- **WRS2:** `"WRS2"`, sonra tekrar eden girdiler: `ad[32]` (her bayt `^ 0xA5`), `u32be paketli`, `u32be boyut`, LZSS verisi (N=4096, F=18, eşik 2, halka boşlukla dolu, r=N−F).
- **WMB6:** 17 liste (ofset, uzunluk). Liste düzeni ve nesne yapıları [ikskuh/libgamestudio](https://github.com/ikskuh/libgamestudio) (MIT) çalışmasına dayanır.
  Yüzey kaydının 12–15. baytları ışık haritası yerleşimidir: `[12]` luxel boyutu log2, `[13]` sayfa, `[14]` x, `[15]` y.
  Blok boyutu Quake'teki gibi doku uzayı sınırlarından hesaplanır, aralarda 1 piksel kenarlık vardır.
