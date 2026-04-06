# JPP Maribor — Vizualizacija javnega potniškega prometa

Interaktivna spletna aplikacija za animacijo gibanja avtobusov na karti. Naloži GTFS podatke in opazuj, kako se vozila premikajo po trasah v realnem času.

## Funkcionalnosti

- **GTFS upload** — naloži standardno GTFS .zip datoteko
- **Animirana karta** — vozila se premikajo po trasah z gladko interpolacijo
- **Trail efekt** — svetleče sledi za vozili (deck.gl TripsLayer)
- **Timeline** — časovnica s predvajanjem, pavzo, hitrostjo (0.5x–60x)
- **Filtriranje linij** — vklop/izklop posameznih linij v sidebaru
- **Postaje** — klikni na postajo za prikaz prihodov

## Uporaba

1. Odpri `index.html` v brskalniku
2. Povleci GTFS .zip datoteko na upload polje
3. Aplikacija razčleni podatke in prikaže karto
4. Uporabi timeline za premikanje po dnevu

### Potrebne GTFS datoteke

| Datoteka | Obvezna | Opis |
|-----------|---------|------|
| `stops.txt` | Da | Lokacije postaj |
| `stop_times.txt` | Da | Časi prihodov/odhodov |
| `trips.txt` | Da | Povezave med linijami in vožnjami |
| `routes.txt` | Da | Definicije linij |
| `shapes.txt` | Ne | Geometrije tras (za natančnejšo animacijo) |

## Tehnologije

- [MapLibre GL JS](https://maplibre.org/) — WebGL karta (brezplačno, odprtokodno)
- [deck.gl](https://deck.gl/) — TripsLayer za animacijo + ScatterplotLayer za vozila
- [OpenStreetMap](https://www.openstreetmap.org/) — kartografski podatki (CARTO Dark stil)
- [JSZip](https://stuk.github.io/jszip/) + [PapaParse](https://www.papaparse.com/) — razčlenjevanje GTFS

## Struktura

```
├── index.html          Glavna stran
├── css/style.css       Stili
├── js/
│   ├── app.js          Aplikacijska logika
│   └── gtfs-parser.js  GTFS razčlenjevalnik
├── archive/            Stare datoteke (Google Maps verzija)
└── vozila_json/        Statični podatki (stara verzija)
```

## Razvoj

Statična spletna stran brez build koraka. Za lokalni razvoj:

```bash
# Python
python -m http.server 8000

# Node.js
npx serve .
```

Nato odpri http://localhost:8000
