"""
Preprocess GTFS data into compact JSON for the JPP Maribor web app.

Input:  gtfs_raw/ (routes, trips, stops, stop_times, shapes, calendar)
Output: data/marprom.json (compact, for web)
"""

import csv
import json
import math
from collections import defaultdict
from pathlib import Path

DATA = Path(__file__).parent / "data"
GTFS = Path(__file__).parent / "gtfs_raw"

# Barve ki so pretemne na dark karti → override
COLOR_OVERRIDES = {
    "G1": "#7B7880",
    "G4": "#4A7BBF",
    "G6": "#2EAD5A",
    "P7": "#D03035",
}

# Privzete barve po liniji (iz WFS / ročno)
LINE_COLORS = {
    "G1": "#7B7880", "G2": "#88A1A9", "G3": "#6F3A96",
    "G4": "#4A7BBF", "G5": "#DA1F27", "G6": "#2EAD5A",
    "P7": "#D03035", "P8": "#8EB3DF", "P9": "#E5861D",
    "P10": "#7BC258", "P11": "#D5DA76", "P12": "#1480C1",
    "P13": "#8C7174", "P14": "#F7B1CA", "P15": "#60C3AC",
    "P16": "#D5137B", "P17": "#9C8AC1", "P18": "#C07E65",
    "P19": "#F5DD26",
}


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
    parts = t.strip().split(":")
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + (int(parts[2]) if len(parts) > 2 else 0)


def find_nearest_index(coords, lat, lon):
    best_i, best_d = 0, float("inf")
    for i, c in enumerate(coords):
        d = (c[0] - lon) ** 2 + (c[1] - lat) ** 2
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def read_csv(name):
    with open(GTFS / name, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def main():
    print("Loading GTFS data...")

    routes_raw = read_csv("routes.txt")
    trips_raw = read_csv("trips.txt")
    stops_raw = read_csv("stops.txt")
    stop_times_raw = read_csv("stop_times.txt")
    shapes_raw = read_csv("shapes.txt")
    calendar_raw = read_csv("calendar.txt")

    # 1. Routes → lines
    route_map = {}  # route_id → route info
    lines = {}
    for r in routes_raw:
        code = r["route_short_name"]
        color = LINE_COLORS.get(code, "#4fc3f7")
        route_map[r["route_id"]] = {
            "code": code,
            "long_name": r["route_long_name"],
        }
        lines[code] = {
            "code": code,
            "name": f"{code} {r['route_long_name']}",
            "color": color,
            "lineId": int(r["route_id"]),
        }
    print(f"  {len(lines)} lines")

    # 2. Calendar → service_id → days
    service_days = {}
    for c in calendar_raw:
        days = []
        for d in ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]:
            if c[d] == "1":
                days.append(d[:3])
        service_days[c["service_id"]] = days

    # 3. Shapes → shape_id → [[lon, lat], ...]
    shapes = defaultdict(list)
    for s in shapes_raw:
        shapes[s["shape_id"]].append({
            "seq": int(s["shape_pt_sequence"]),
            "lat": float(s["shape_pt_lat"]),
            "lon": float(s["shape_pt_lon"]),
        })
    for sid in shapes:
        shapes[sid].sort(key=lambda x: x["seq"])
        shapes[sid] = [[round(p["lon"], 6), round(p["lat"], 6)] for p in shapes[sid]]
    print(f"  {len(shapes)} shapes ({sum(len(v) for v in shapes.values())} points)")

    # 4. Stops
    stop_map = {}  # stop_id → {name, lat, lon}
    for s in stops_raw:
        stop_map[s["stop_id"]] = {
            "name": s["stop_name"],
            "lat": float(s["stop_lat"]),
            "lon": float(s["stop_lon"]),
        }
    print(f"  {len(stop_map)} stops")

    # 5. Stop times grouped by trip
    trip_stop_times = defaultdict(list)
    for st in stop_times_raw:
        trip_stop_times[st["trip_id"]].append({
            "stop_id": st["stop_id"],
            "seq": int(st["stop_sequence"]),
            "arrival": time_to_sec(st["arrival_time"]),
            "departure": time_to_sec(st["departure_time"]),
        })
    for tid in trip_stop_times:
        trip_stop_times[tid].sort(key=lambda x: x["seq"])

    # 6. Build trips with interpolation along shapes
    trips_out = []
    skipped = 0

    trip_map = {}  # trip_id → trip info
    for t in trips_raw:
        trip_map[t["trip_id"]] = t

    for tid, stop_times in trip_stop_times.items():
        if len(stop_times) < 2:
            skipped += 1
            continue

        trip_info = trip_map.get(tid)
        if not trip_info:
            skipped += 1
            continue

        route_info = route_map.get(trip_info["route_id"])
        if not route_info:
            skipped += 1
            continue

        line_code = route_info["code"]
        headsign = trip_info.get("trip_headsign", "")
        shape_id = trip_info.get("shape_id", "")
        shape_coords = shapes.get(shape_id, [])
        days = service_days.get(trip_info.get("service_id", ""), [])

        path = []

        for i in range(len(stop_times) - 1):
            st_from = stop_times[i]
            st_to = stop_times[i + 1]

            s_from = stop_map.get(st_from["stop_id"])
            s_to = stop_map.get(st_to["stop_id"])
            if not s_from or not s_to:
                continue

            dep_time = st_from["departure"]
            arr_time = st_to["arrival"]
            if arr_time <= dep_time:
                path.append([round(s_from["lon"], 6), round(s_from["lat"], 6), dep_time])
                continue

            duration = arr_time - dep_time

            if shape_coords and len(shape_coords) > 2:
                idx_from = find_nearest_index(shape_coords, s_from["lat"], s_from["lon"])
                idx_to = find_nearest_index(shape_coords, s_to["lat"], s_to["lon"])

                if idx_from < idx_to:
                    segment = shape_coords[idx_from: idx_to + 1]
                elif idx_from > idx_to:
                    segment = shape_coords[idx_to: idx_from + 1][::-1]
                else:
                    segment = None

                if segment and len(segment) >= 2:
                    seg_len = polyline_length(segment)
                    if seg_len > 10:
                        cum = 0
                        path.append([round(segment[0][0], 6), round(segment[0][1], 6), dep_time])
                        for j in range(1, len(segment)):
                            cum += haversine(segment[j-1][1], segment[j-1][0], segment[j][1], segment[j][0])
                            frac = cum / seg_len
                            t_sec = dep_time + frac * duration
                            path.append([round(segment[j][0], 6), round(segment[j][1], 6), round(t_sec)])
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
        last_st = stop_times[-1]
        last_s = stop_map.get(last_st["stop_id"])
        if last_s:
            path.append([round(last_s["lon"], 6), round(last_s["lat"], 6), last_st["arrival"]])

        if len(path) >= 2:
            trips_out.append({
                "id": int(tid),
                "line": line_code,
                "headsign": headsign,
                "days": days,
                "path": path,
            })

    print(f"  {len(trips_out)} valid trips ({skipped} skipped)")

    # 7. Unique stops
    stops_out = []
    seen_stops = set()
    for sid, s in stop_map.items():
        key = f"{s['lat']:.5f}_{s['lon']:.5f}"
        if key not in seen_stops:
            seen_stops.add(key)
            stops_out.append({
                "name": s["name"],
                "lon": round(s["lon"], 6),
                "lat": round(s["lat"], 6),
            })
    print(f"  {len(stops_out)} unique stops")

    # 8. Route lines from shapes (for static display)
    # Group shapes by line code via trips
    shape_to_line = {}
    for t in trips_raw:
        route_info = route_map.get(t["route_id"])
        if route_info and t.get("shape_id"):
            shape_to_line.setdefault(t["shape_id"], route_info["code"])

    seen_shapes = set()
    route_lines = []
    for shape_id, coords in shapes.items():
        if shape_id in seen_shapes:
            continue
        seen_shapes.add(shape_id)
        line_code = shape_to_line.get(shape_id)
        if not line_code:
            continue
        route_lines.append({
            "code": line_code,
            "routeId": int(shape_id),
            "headsign": "",
            "coords": coords,
        })
    print(f"  {len(route_lines)} route line geometries")

    # 9. Write output
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
