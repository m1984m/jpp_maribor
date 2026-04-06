import pandas as pd
import json
import os
from datetime import datetime, time

# Podprta kodiranja za branje CSV datotek
podprta_kodiranja = ['utf-8', 'windows-1250', 'iso-8859-2']

# Funkcija za prebiranje datoteke z ustreznim kodiranjem
def read_csv_with_encoding(filepath, encodings):
    for encoding in encodings:
        try:
            return pd.read_csv(filepath, sep=';', encoding=encoding, low_memory=False)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError(f"Ni mogoče dekodirati datoteke {filepath} z nobenim podprtim kodiranjem.")

# Funkcija za čiščenje in pretvorbo časovnih vrednosti
def clean_time_value(value):
    if pd.isna(value) or not str(value).strip() or str(value).strip() == "    |":
        return None
    try:
        # Poskusi razdeliti čas z dvopičjem (npr. "22:39") ali poševnico (npr. "22/39")
        time_str = str(value).strip()
        if ':' in time_str:
            hours, minutes = map(int, time_str.split(':'))
        elif '/' in time_str:
            hours, minutes = map(int, time_str.split('/'))
        else:
            raise ValueError("Neveljaven format časa")

        # Preveri, ali so ure in minute veljavni (med 0 in 23 za ure, 0 in 59 za minute)
        if not (0 <= hours <= 23 and 0 <= minutes <= 59):
            raise ValueError("Neveljavne vrednosti za ure ali minute")

        # Izključi "00:00" kot neveljaven čas
        if hours == 0 and minutes == 0:
            return None

        # Pretvori v ISO format
        return datetime(2025, 2, 24, hours, minutes).isoformat() + "Z"
    except (ValueError, AttributeError) as e:
        print(f"Neveljaven format časa: {value}. Uporabljam privzeto vrednost (brez časa). Podrobnost: {str(e)}")
        return None

# Nastavitve
pot_do_mape = "vozila_csv"
izhodna_mapa = "vozila_json"

# Ustvari izhodno mapo, če ne obstaja
if not os.path.exists(izhodna_mapa):
    os.makedirs(izhodna_mapa)

# Seznam vozil in postajališč za kasnejšo uporabo
vozila_seznam = []
postajalisca_seznam = {}  # Shranjujemo unikatna postajališča po imenih

# Pretvori vsako CSV datoteko v JSON
for datoteka in os.listdir(pot_do_mape):
    if datoteka.endswith(".csv"):
        ime_linije = datoteka.replace(".csv", "")  # Npr. "G1plus", "P7minus", itd.
        
        pot = os.path.join(pot_do_mape, datoteka)
        
        try:
            # Preberi datoteko z ustreznim kodiranjem
            df = read_csv_with_encoding(pot, podprta_kodiranja)
            
            # Preveri, kateri stolpci obstajajo (lahko izpišeš za debug)
            print(f"Stolpci v datoteki {datoteka}: {df.columns.tolist()}")
            
            # Določi imena stolpcev (prilagodi za fleksibilnost z različnimi variacijami)
            lat_col = next((col for col in df.columns if col.lower() in ['lat', 'lan']), None)
            lon_col = next((col for col in df.columns if col.lower() == 'lon'), None)
            ime_col = next((col for col in df.columns if col.lower() == 'ime'), None)
            
            # Če kateri od stolpcev manjka, izpiši opozorilo in preskoči
            if lat_col is None or lon_col is None or ime_col is None:
                print(f"Napaka: Manjkajoči stolpci v datoteki {datoteka}. Preveri imena stolpcev: 'lat'/'Lan'/'Lat', 'lon'/'Lon', 'Ime'.")
                continue
            
            # Pripravi podatke za JSON
            vozila = []
            for col in df.columns[3:]:  # Stolpci od tretjega naprej predstavljajo vozila
                vozilo_ime = f"{ime_linije}-{col}"  # Npr. "G1plus-1/1", "P7minus-2/1", itd.
                postajalisca = []
                
                # Preveri, ali obstajajo veljavni časi v stolpcu
                valid_times = df[col].apply(clean_time_value).dropna().any()
                if not valid_times:
                    print(f"Vozilo {vozilo_ime} nima veljavnih časov, preskočeno.")
                    continue
                
                for _, row in df.iterrows():
                    # Preveri, ali so vrednosti v stolpcih (uporabi dinamična imena stolpcev)
                    if pd.isna(row[lat_col]) or pd.isna(row[lon_col]) or pd.isna(row[ime_col]) or str(row[ime_col]).strip() == '':
                        continue
                    
                    cas = row[col]
                    cas_iso = clean_time_value(cas)
                    if cas_iso:  # Samo če je čas veljaven
                        postajalisce = {
                            "lat": float(row[lat_col]),
                            "lon": float(row[lon_col]),
                            "ime": str(row[ime_col]).strip(),
                            "time": cas_iso
                        }
                        postajalisca.append(postajalisce)
                        
                        # Shranjujemo unikatna postajališča za prikaz na zemljevidu
                        postajalisce_id = f"{postajalisce['ime']}_{postajalisce['lat']}_{postajalisce['lon']}"
                        if postajalisce_id not in postajalisca_seznam:
                            postajalisca_seznam[postajalisce_id] = postajalisce
                
                if postajalisca:  # Samo če obstajajo postajališča
                    vozila.append({
                        "name": f"Vozilo {vozilo_ime}",
                        "path": postajalisca
                    })
            
            # Če ni nobenega vozila z veljavnimi časi, preskoči linijo
            if not vozila:
                print(f"Linija {ime_linije} nima nobenih vozil z veljavnimi časi, preskočena.")
                continue
            
            # Shrani kot "G1plus.json", "P7minus.json", itd. z vsemi vozili na liniji
            vehicle_data = {
                "line": f"Linija {ime_linije}",
                "vehicles": vozila
            }
            
            # Shrani v JSON
            izhodna_datoteka = os.path.join(izhodna_mapa, f"{ime_linije}.json")
            with open(izhodna_datoteka, 'w', encoding='utf-8') as f:
                json.dump(vehicle_data, f, indent=4, ensure_ascii=False)
            
            vozila_seznam.extend([f"{ime_linije}-{col}" for col in df.columns[3:] if df[col].apply(clean_time_value).dropna().any()])

        except UnicodeDecodeError as e:
            print(f"Napaka pri dekodiranju datoteke {datoteka}: {e}")
            continue
        except Exception as e:
            print(f"Napaka pri obdelavi datoteke {datoteka}: {e}")
            continue

# Shranimo unikatna postajališča v ločeno JSON datoteko za prikaz na zemljevidu
postajalisca_data = {
    "stations": list(postajalisca_seznam.values())
}
with open(os.path.join(izhodna_mapa, 'stations.json'), 'w', encoding='utf-8') as f:
    json.dump(postajalisca_data, f, indent=4, ensure_ascii=False)

print(f"Podatki pretvorjeni v JSON v mapi '{izhodna_mapa}'. Ustvarjene datoteke: {vozila_seznam}")
print(f"Unikatna postajališča shranjena v 'stations.json'.")