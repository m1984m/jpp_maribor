import pandas as pd
import folium
from folium.plugins import TimestampedGeoJson
import os
import random
import json

# Funkcija za naključno barvo
def random_color():
    return "#{:06x}".format(random.randint(0, 0xFFFFFF))

# Nastavitve
mesto_sredisce = [46.5546, 15.6459]  # Maribor
casovni_korak = "PT2M"  # 2 minuti
map_zoom = 12
mapa_datoteka = "zemljevid_vozila.html"

# Ustvari zemljevid
m = folium.Map(location=mesto_sredisce, zoom_start=map_zoom, tiles='CartoDB Positron')

# Preberi CSV datoteke
pot_do_mape = "vozila_csv"
all_features = []

if not os.path.exists(pot_do_mape):
    print("Mapa 'vozila_csv' ne obstaja. Ustvarjam jo...")
    os.makedirs(pot_do_mape)
    print("Dodaj CSV datoteke v 'vozila_csv' in znova zaženi program.")
    exit()

for datoteka in os.listdir(pot_do_mape):
    if datoteka.endswith(".csv"):
        ime_vozila = datoteka.replace(".csv", "")
        oznaka_vozila = f"Vozilo G{ime_vozila.replace('vozilo', '')}"
        pot = os.path.join(pot_do_mape, datoteka)
        
        # Uvozi podatke
        df = pd.read_csv(pot, sep=';')
        df['cas'] = pd.to_datetime(df['cas'], format='%d.%m.%Y %H:%M:%S').astype(str)
        
        # Dodeli barvo za ikono
        barva = random_color()
        
        # Nariši celotno pot kot rdečo črto
        folium.PolyLine(
            locations=df[['lat', 'lon']].values.tolist(),
            weight=3,
            color='#FF0000',
            opacity=1,
            tooltip=oznaka_vozila
        ).add_to(m)
        
        # Pripravi animacijo za ikono vozila
        features = []
        for _, row in df.iterrows():
            feature_point = {
                'type': 'Feature',
                'geometry': {
                    'type': 'Point',
                    'coordinates': [row['lon'], row['lat']],
                },
                'properties': {
                    'time': row['cas'],
                    'popup': f"{oznaka_vozila} - Čas: {row['cas']}",
                    'vehicle': oznaka_vozila,  # Identifikator vozila za JS
                    'icon': 'car',
                    'iconstyle': {
                        'iconUrl': 'https://cdn-icons-png.flaticon.com/512/3082/3082383.png',
                        'iconSize': [25, 25],
                        'color': barva
                    }
                }
            }
            features.append(feature_point)
        all_features.extend(features)

# Dodaj animacijo z časovnico
TimestampedGeoJson(
    {'type': 'FeatureCollection', 'features': all_features},
    period=casovni_korak,
    add_last_point=True,
    auto_play=False,
    loop=False,
    max_speed=1,
    time_slider_drag_update=True,
    duration='P1D'
).add_to(m)

# Dodaj JavaScript za prikaz oznak nad aktivnimi markerji
html = """
<script>
document.addEventListener('DOMContentLoaded', function() {
    var map = window.L.map;  // Dostop do Leaflet zemljevida
    var markers = {};
    var labels = {};

    // Poišči vse markerje po inicializaciji
    map.eachLayer(function(layer) {
        if (layer instanceof L.Marker && layer.options.geojson) {
            var geojson = layer.options.geojson;
            var vehicle = geojson.properties.vehicle;
            var time = geojson.properties.time;
            if (!markers[vehicle]) markers[vehicle] = {};
            markers[vehicle][time] = layer;

            // Dodaj oznako nad markerjem, a skrito
            var latlng = layer.getLatLng();
            var label = L.divIcon({
                className: 'vehicle-label',
                html: `<div style="background: white; padding: 2px 5px; border: 1px solid black; border-radius: 3px; white-space: nowrap;">${vehicle}</div>`,
                iconSize: [null, null],
                iconAnchor: [0, -30]  // Postavi nad markerjem
            });
            var labelMarker = L.marker(latlng, {icon: label, interactive: false}).addTo(map);
            labelMarker.setOpacity(0);  // Skrij na začetku
            if (!labels[vehicle]) labels[vehicle] = {};
            labels[vehicle][time] = labelMarker;
        }
    });

    // Posodobi oznake glede na trenutno vidne markerje
    function updateLabels() {
        for (var vehicle in markers) {
            for (var time in markers[vehicle]) {
                var marker = markers[vehicle][time];
                var label = labels[vehicle][time];
                if (marker._icon && marker._icon.style.opacity > 0) {  // Če je marker viden
                    label.setLatLng(marker.getLatLng());
                    label.setOpacity(1);
                } else {
                    label.setOpacity(0);
                }
            }
        }
    }

    // Posodobi ob vsaki spremembi (npr. premik drsnika)
    map.on('moveend overlayadd overlayremove', updateLabels);
    setInterval(updateLabels, 500);  // Redno preverjanje za animacijo
    updateLabels();  // Inicialni klic
});
</script>
<style>
.vehicle-label { pointer-events: none; } /* Prepreči interakcijo z oznakami */
</style>
"""

# Dodaj JavaScript in CSS v glavo zemljevida
m.get_root().html.add_child(folium.Element(html))

# Shrani
m.save(mapa_datoteka)
print(f"Zemljevid je shranjen kot '{mapa_datoteka}'. Odpri ga v brskalniku!")