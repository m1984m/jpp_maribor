/**
 * GTFS Parser — razčleni GTFS ZIP v strukturirane podatke za animacijo.
 *
 * Vrne: { routes, trips, stops, tripPaths, bounds }
 *   - tripPaths: Map<tripId, { routeId, path: [{lon, lat, timestamp}] }>
 *   - routes: Map<routeId, { name, color, tripIds }>
 */

const GTFSParser = (() => {

    function parseCSV(text) {
        const result = Papa.parse(text.trim(), {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: false
        });
        return result.data;
    }

    function timeToSeconds(timeStr) {
        if (!timeStr) return null;
        const parts = timeStr.trim().split(':');
        if (parts.length < 2) return null;
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        const s = parts[2] ? parseInt(parts[2], 10) : 0;
        if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
        // GTFS dovolj ure > 23 (naslednji dan)
        return h * 3600 + m * 60 + s;
    }

    // Privzete barve za linije brez barve
    const DEFAULT_COLORS = [
        '#4fc3f7', '#7c4dff', '#ff5252', '#69f0ae', '#ffd740',
        '#ff6e40', '#40c4ff', '#b388ff', '#ff80ab', '#a7ffeb',
        '#ea80fc', '#ccff90', '#84ffff', '#f4ff81', '#ff9e80'
    ];

    async function parse(zipFile) {
        const zip = await JSZip.loadAsync(zipFile);

        // Poišči datoteke (lahko so v podmapi)
        function findFile(name) {
            for (const path of Object.keys(zip.files)) {
                if (path.endsWith(name) && !zip.files[path].dir) {
                    return zip.files[path];
                }
            }
            return null;
        }

        const requiredFiles = ['stops.txt', 'stop_times.txt', 'trips.txt', 'routes.txt'];
        for (const f of requiredFiles) {
            if (!findFile(f)) {
                throw new Error(`Manjka obvezna datoteka: ${f}`);
            }
        }

        // Preberi vse datoteke
        const [stopsRaw, stopTimesRaw, tripsRaw, routesRaw, shapesRaw] = await Promise.all([
            findFile('stops.txt').async('string'),
            findFile('stop_times.txt').async('string'),
            findFile('trips.txt').async('string'),
            findFile('routes.txt').async('string'),
            findFile('shapes.txt')?.async('string') ?? null
        ]);

        // Parse
        const stopsData = parseCSV(stopsRaw);
        const stopTimesData = parseCSV(stopTimesRaw);
        const tripsData = parseCSV(tripsRaw);
        const routesData = parseCSV(routesRaw);
        const shapesData = shapesRaw ? parseCSV(shapesRaw) : null;

        // Stops: stop_id → {lat, lon, name}
        const stops = new Map();
        for (const s of stopsData) {
            const lat = parseFloat(s.stop_lat);
            const lon = parseFloat(s.stop_lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                stops.set(s.stop_id, {
                    lat, lon,
                    name: s.stop_name || s.stop_id
                });
            }
        }

        // Routes: route_id → {name, color, tripIds}
        const routes = new Map();
        let colorIdx = 0;
        for (const r of routesData) {
            let color = r.route_color ? `#${r.route_color}` : DEFAULT_COLORS[colorIdx % DEFAULT_COLORS.length];
            colorIdx++;
            routes.set(r.route_id, {
                name: r.route_short_name || r.route_long_name || r.route_id,
                longName: r.route_long_name || '',
                color,
                tripIds: new Set()
            });
        }

        // Trips: trip_id → {routeId, shapeId, directionId}
        const trips = new Map();
        for (const t of tripsData) {
            trips.set(t.trip_id, {
                routeId: t.route_id,
                shapeId: t.shape_id || null,
                directionId: t.direction_id || '0'
            });
            const route = routes.get(t.route_id);
            if (route) route.tripIds.add(t.trip_id);
        }

        // Shapes: shape_id → [{lon, lat, seq}] (sortirano)
        const shapes = new Map();
        if (shapesData) {
            for (const s of shapesData) {
                const shapeId = s.shape_id;
                if (!shapes.has(shapeId)) shapes.set(shapeId, []);
                shapes.get(shapeId).push({
                    lat: parseFloat(s.shape_pt_lat),
                    lon: parseFloat(s.shape_pt_lon),
                    seq: parseInt(s.shape_pt_sequence, 10)
                });
            }
            for (const [, pts] of shapes) {
                pts.sort((a, b) => a.seq - b.seq);
            }
        }

        // Stop times: grupiraj po trip_id, sortiraj po stop_sequence
        const stopTimesByTrip = new Map();
        for (const st of stopTimesData) {
            const tripId = st.trip_id;
            if (!stopTimesByTrip.has(tripId)) stopTimesByTrip.set(tripId, []);
            stopTimesByTrip.get(tripId).push({
                stopId: st.stop_id,
                arrival: timeToSeconds(st.arrival_time),
                departure: timeToSeconds(st.departure_time),
                seq: parseInt(st.stop_sequence, 10)
            });
        }
        for (const [, sts] of stopTimesByTrip) {
            sts.sort((a, b) => a.seq - b.seq);
        }

        // Build trip paths z interpolacijo
        const tripPaths = new Map();
        let bounds = { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 };

        for (const [tripId, stopTimes] of stopTimesByTrip) {
            const trip = trips.get(tripId);
            if (!trip) continue;

            // Filtriraj stop čase brez veljavnih koordinat ali časov
            const validStops = stopTimes.filter(st => {
                const stop = stops.get(st.stopId);
                return stop && st.arrival !== null;
            });

            if (validStops.length < 2) continue;

            const path = [];
            const shapePoints = trip.shapeId ? shapes.get(trip.shapeId) : null;

            for (let i = 0; i < validStops.length - 1; i++) {
                const fromST = validStops[i];
                const toST = validStops[i + 1];
                const fromStop = stops.get(fromST.stopId);
                const toStop = stops.get(toST.stopId);

                const departTime = fromST.departure ?? fromST.arrival;
                const arriveTime = toST.arrival;

                if (departTime === null || arriveTime === null || arriveTime <= departTime) {
                    // Dodaj samo začetno točko
                    path.push({ lon: fromStop.lon, lat: fromStop.lat, timestamp: fromST.arrival });
                    continue;
                }

                // Če imamo shape points, interpoliraj vzdolž shape-a
                if (shapePoints && shapePoints.length > 2) {
                    const segmentPoints = extractShapeSegment(shapePoints, fromStop, toStop);
                    if (segmentPoints.length >= 2) {
                        const totalDist = polylineLength(segmentPoints);
                        const duration = arriveTime - departTime;
                        let cumDist = 0;

                        path.push({ lon: segmentPoints[0].lon, lat: segmentPoints[0].lat, timestamp: departTime });

                        for (let j = 1; j < segmentPoints.length; j++) {
                            cumDist += haversine(segmentPoints[j - 1], segmentPoints[j]);
                            const t = totalDist > 0 ? cumDist / totalDist : 1;
                            const time = departTime + t * duration;
                            path.push({ lon: segmentPoints[j].lon, lat: segmentPoints[j].lat, timestamp: time });
                        }
                        continue;
                    }
                }

                // Fallback: linearna interpolacija med postajama
                const duration = arriveTime - departTime;
                const numSteps = Math.max(2, Math.min(20, Math.ceil(duration / 15)));

                for (let step = 0; step < numSteps; step++) {
                    const t = step / (numSteps - 1);
                    path.push({
                        lon: fromStop.lon + t * (toStop.lon - fromStop.lon),
                        lat: fromStop.lat + t * (toStop.lat - fromStop.lat),
                        timestamp: departTime + t * duration
                    });
                }
            }

            // Dodaj zadnjo postajo
            const lastST = validStops[validStops.length - 1];
            const lastStop = stops.get(lastST.stopId);
            path.push({ lon: lastStop.lon, lat: lastStop.lat, timestamp: lastST.arrival });

            if (path.length >= 2) {
                tripPaths.set(tripId, {
                    routeId: trip.routeId,
                    path
                });

                // Posodobi bounds
                for (const p of path) {
                    bounds.minLat = Math.min(bounds.minLat, p.lat);
                    bounds.maxLat = Math.max(bounds.maxLat, p.lat);
                    bounds.minLon = Math.min(bounds.minLon, p.lon);
                    bounds.maxLon = Math.max(bounds.maxLon, p.lon);
                }
            }
        }

        return { routes, trips, stops, tripPaths, bounds };
    }

    // Pomožne funkcije

    function haversine(a, b) {
        const R = 6371000;
        const dLat = (b.lat - a.lat) * Math.PI / 180;
        const dLon = (b.lon - a.lon) * Math.PI / 180;
        const sin1 = Math.sin(dLat / 2);
        const sin2 = Math.sin(dLon / 2);
        const h = sin1 * sin1 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sin2 * sin2;
        return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function polylineLength(pts) {
        let d = 0;
        for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]);
        return d;
    }

    function distToPoint(shapePt, stop) {
        return haversine(shapePt, stop);
    }

    function extractShapeSegment(shapePoints, fromStop, toStop) {
        // Poišči najbližji shape point za vsako postajo
        let fromIdx = 0, toIdx = shapePoints.length - 1;
        let minFromDist = Infinity, minToDist = Infinity;

        for (let i = 0; i < shapePoints.length; i++) {
            const d = distToPoint(shapePoints[i], fromStop);
            if (d < minFromDist) { minFromDist = d; fromIdx = i; }
        }

        for (let i = fromIdx; i < shapePoints.length; i++) {
            const d = distToPoint(shapePoints[i], toStop);
            if (d < minToDist) { minToDist = d; toIdx = i; }
        }

        if (fromIdx >= toIdx) return [fromStop, toStop];
        return shapePoints.slice(fromIdx, toIdx + 1);
    }

    return { parse };
})();
