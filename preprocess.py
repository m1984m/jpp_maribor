"""
Preprocess Marprom WFS data into compact JSON for the web app.

Input:  data/marprom_lines_routes.geojson
        data/marprom_linije_geom.geojson
        data/marprom_postajalisca.geojson
Output: data/marprom.json (compact, for web)
"""

import json
import math
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).parent / "data"


def load(name):
    with open(DATA / name, encoding="utf-8") as f:
        return json.load(f)


def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def polyline_length(coords):
    d = 0
    for i in range(1, len(coords)):
        d += haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0])
    return d


def time_to_sec(t):
    """HH:MM:SS → seconds since midnight"""
    parts = t.strip().split(":")
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + (int(parts[2]) if len(parts) > 2 else 0)


def interpolate_along_line(coords, frac):
    """Interpolate position at fraction [0,1] along a polyline."""
    if frac <= 0:
        return coords[0]
    if frac >= 1:
        return coords[-1]

    total = polyline_length(coords)
    target = frac * total
    cum = 0

    for i in range(1, len(coords)):
        seg = haversine(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0])
        if cum + seg >= target:
            t = (target - cum) / seg if seg > 0 else 0
            return [
                coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
                coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
            ]
        cum += seg

    return coords[-1]


def find_nearest_index(coords, lat, lon):
    """Find index of nearest coord to (lat, lon)."""
    best_i, best_d = 0, float("inf")
    for i, c in enumerate(coords):
        d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def main():
    print("Loading WFS data...")
    lines_routes = load("marprom_lines_routes.geojson")
    line_geom = load("marprom_linije_geom.geojson")
    stops_data = load("marprom_postajalisca.geojson")

    # 1. Lines metadata
    lines = {}
    for feat in lines_routes["features"]:
        p = feat["properties"]
        code = p["code"]
        lines[code] = {
            "code": code,
            "name": f"{code} {p['description']}",
            "color": p["color"].strip(),
            "lineId": p["line_id"],
        }
    print(f"  {len(lines)} lines")

    # 2. Route geometries: route_id → coords
    route_geoms = {}
    for feat in line_geom["features"]:
        p = feat["properties"]
        g = feat["geometry"]
        if g and g["type"] == "LineString":
            route_geoms[p["route_id"]] = g["coordinates"]
    print(f"  {len(route_geoms)} route geometries")

    # 3. Group stop-times by trip_id
    trips_raw = defaultdict(list)
    for feat in stops_data["features"]:
        p = feat["properties"]
        g = feat["geometry"]
        if not g or not p.get("arrival_time"):
            continue
        coord = g["coordinates"]
        trips_raw[p["trip_id"]].append({
            "seq": p["stop_sequence"],
            "stop_name": p["stop_name"],
            "arrival": time_to_sec(p["arrival_time"]),
            "departure": time_to_sec(p["departure_time"]),
            "lat": coord[1],
            "lon": coord[0],
            "route": p["route_short_name"],
            "headsign": p.get("trip_headsign", ""),
            "monday": p.get("monday", 0),
            "tuesday": p.get("tuesday", 0),
            "wednesday": p.get("wednesday", 0),
            "thursday": p.get("thursday", 0),
            "friday": p.get("friday", 0),
            "saturday": p.get("saturday", 0),
            "sunday": p.get("sunday", 0),
        })

    print(f"  {len(trips_raw)} trips from stop-times")

    # Sort each trip by stop_sequence
    for tid in trips_raw:
        trips_raw[tid].sort(key=lambda x: x["seq"])

    # 4. Build trip paths with interpolation along route geometry
    # Map route_short_name → list of route_ids (to find geometry)
    route_code_to_geom = defaultdict(list)
    for feat in line_geom["features"]:
        p = feat["properties"]
        route_code_to_geom[p["code"]].append({
            "route_id": p["route_id"],
            "headsign": p.get("headsign_name", ""),
            "coords": feat["geometry"]["coordinates"] if feat["geometry"] else [],
        })

    trips_out = []
    skipped = 0

    for tid, stop_times in trips_raw.items():
        if len(stop_times) < 2:
            skipped += 1
            continue

        route_code = stop_times[0]["route"]
        # Prefix G for single-digit garni lines
        line_code = f"G{route_code}" if route_code.isdigit() and int(route_code) <= 6 else f"P{route_code}" if route_code.isdigit() else route_code
        headsign = stop_times[0]["headsign"]

        # Find best matching geometry
        best_geom = None
        candidates = route_code_to_geom.get(line_code, [])

        if candidates:
            # Try to match by headsign similarity
            for cand in candidates:
                if cand["headsign"] and headsign and (
                    cand["headsign"][:20].lower() in headsign.lower()
                    or headsign[:20].lower() in cand["headsign"].lower()
                ):
                    best_geom = cand["coords"]
                    break

            # Fallback: pick geometry closest to first stop
            if not best_geom:
                first_stop = stop_times[0]
                best_d = float("inf")
                for cand in candidates:
                    if cand["coords"]:
                        c = cand["coords"][0]
                        d = (c[0] - first_stop["lon"]) ** 2 + (c[1] - first_stop["lat"]) ** 2
                        if d < best_d:
                            best_d = d
                            best_geom = cand["coords"]

        # Build path: interpolate between stops along geometry
        path = []

        for i in range(len(stop_times) - 1):
            s_from = stop_times[i]
            s_to = stop_times[i + 1]

            dep_time = s_from["departure"]
            arr_time = s_to["arrival"]

            if arr_time <= dep_time:
                path.append([round(s_from["lon"], 6), round(s_from["lat"], 6), dep_time])
                continue

            duration = arr_time - dep_time

            if best_geom and len(best_geom) > 2:
                # Find segment of geometry between these two stops
                idx_from = find_nearest_index(best_geom, s_from["lat"], s_from["lon"])
                idx_to = find_nearest_index(best_geom, s_to["lat"], s_to["lon"])

                if idx_from < idx_to:
                    segment = best_geom[idx_from : idx_to + 1]
                elif idx_from > idx_to:
                    segment = best_geom[idx_to : idx_from + 1][::-1]
                else:
                    segment = None

                if segment and len(segment) >= 2:
                    seg_len = polyline_length(segment)
                    if seg_len > 10:  # at least 10m
                        cum = 0
                        path.append([round(segment[0][0], 6), round(segment[0][1], 6), dep_time])
                        for j in range(1, len(segment)):
                            cum += haversine(segment[j-1][1], segment[j-1][0], segment[j][1], segment[j][0])
                            frac = cum / seg_len
                            t = dep_time + frac * duration
                            path.append([round(segment[j][0], 6), round(segment[j][1], 6), round(t)])
                        continue

            # Fallback: linear interpolation
            n_steps = max(2, min(15, int(duration / 20)))
            for step in range(n_steps):
                frac = step / (n_steps - 1)
                path.append([
                    round(s_from["lon"] + frac * (s_to["lon"] - s_from["lon"]), 6),
                    round(s_from["lat"] + frac * (s_to["lat"] - s_from["lat"]), 6),
                    round(dep_time + frac * duration),
                ])

        # Add last stop
        last = stop_times[-1]
        path.append([round(last["lon"], 6), round(last["lat"], 6), last["arrival"]])

        if len(path) >= 2:
            # Day flags from first stop
            days = []
            s0 = stop_times[0]
            for d in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]:
                if s0.get(d):
                    days.append(d[:3])

            trips_out.append({
                "id": tid,
                "line": line_code,
                "headsign": headsign,
                "days": days,
                "path": path,
            })

    print(f"  {len(trips_out)} valid trips ({skipped} skipped)")

    # 5. Unique stops (deduplicate by stop_code or coords)
    stops_seen = {}
    for feat in stops_data["features"]:
        p = feat["properties"]
        g = feat["geometry"]
        if not g:
            continue
        key = p.get("stop_code") or f"{g['coordinates'][0]}_{g['coordinates'][1]}"
        if key not in stops_seen:
            stops_seen[key] = {
                "name": p["stop_name"],
                "lon": round(g["coordinates"][0], 6),
                "lat": round(g["coordinates"][1], 6),
            }

    stops_out = list(stops_seen.values())
    print(f"  {len(stops_out)} unique stops")

    # 6. Route geometries for static display
    route_lines = []
    for feat in line_geom["features"]:
        p = feat["properties"]
        g = feat["geometry"]
        if g and g["type"] == "LineString":
            route_lines.append({
                "code": p["code"],
                "routeId": p["route_id"],
                "headsign": p.get("headsign_name", ""),
                "coords": [[round(c[0], 6), round(c[1], 6)] for c in g["coordinates"]],
            })
    print(f"  {len(route_lines)} route line geometries")

    # 7. Write output
    output = {
        "lines": lines,
        "trips": trips_out,
        "stops": stops_out,
        "routeLines": route_lines,
    }

    out_path = DATA / "marprom.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, separators=(",", ":"))

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"\nOutput: {out_path} ({size_mb:.1f} MB)")
    print(f"  {len(lines)} lines, {len(trips_out)} trips, {len(stops_out)} stops, {len(route_lines)} route geometries")


if __name__ == "__main__":
    main()
