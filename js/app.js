/**
 * JPP Maribor — Glavna aplikacija
 * MapLibre GL + deck.gl TripsLayer animacija GTFS podatkov
 *
 * Arhitektura:
 *   - tripsCache[] se zgradi samo ob spremembi activeRoutes
 *   - animationLoop posodablja samo currentTime → deck.gl renderira
 *   - postaje so deck.gl ScatterplotLayer z dinamičnim barvanjem
 */

(() => {
    // ── State ──
    let map = null;
    let deckOverlay = null;
    let gtfsData = null;
    let activeRoutes = new Set();
    let currentTime = 14400; // 04:00
    let isPlaying = false;
    let speed = 1;
    let lastFrameTime = null;
    let animFrameId = null;

    // Cached data — rebuilt only on route change
    let tripsCache = [];
    let stopColorsCache = new Map(); // stopId → [r,g,b]
    let routeStopsMap = new Map();   // routeId → Set<stopId>

    // ── DOM ──
    const $ = id => document.getElementById(id);
    const uploadScreen = $('upload-screen');
    const mapScreen = $('map-screen');
    const dropZone = $('drop-zone');
    const fileInput = $('file-input');
    const uploadStatus = $('upload-status');
    const statusText = $('status-text');
    const routeList = $('route-list');
    const slider = $('time-slider');
    const timeDisplay = $('time-display');
    const playBtn = $('play-btn');
    const resetBtn = $('reset-btn');
    const speedSelect = $('speed-select');
    const selectAllBtn = $('select-all-btn');
    const deselectAllBtn = $('deselect-all-btn');
    const backBtn = $('back-btn');
    const statsInfo = $('stats-info');

    // ── Upload ──

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.zip')) handleFile(file);
        else showError('Prosim naloži .zip datoteko');
    });

    async function handleFile(file) {
        uploadStatus.classList.remove('hidden');
        statusText.textContent = 'Razčlenjujem GTFS podatke...';
        try {
            gtfsData = await GTFSParser.parse(file);
            if (gtfsData.tripPaths.size === 0) throw new Error('Ni najdenih veljavnih voženj.');
            statusText.textContent = `${gtfsData.routes.size} linij · ${gtfsData.tripPaths.size} voženj · ${gtfsData.stops.size} postaj`;

            // Pre-compute: kateri stopi pripadajo kateri liniji
            buildRouteStopsMap();

            setTimeout(showMap, 400);
        } catch (err) {
            showError(err.message);
        }
    }

    function buildRouteStopsMap() {
        routeStopsMap.clear();

        // Spatial hash: zaokroži koordinate → stop IDs
        const grid = new Map(); // "lat_lon" → [stopId, ...]
        const GRID_RES = 0.001; // ~111m
        for (const [stopId, stop] of gtfsData.stops) {
            const key = `${Math.round(stop.lat / GRID_RES)}_${Math.round(stop.lon / GRID_RES)}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(stopId);
        }

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!routeStopsMap.has(tripData.routeId)) routeStopsMap.set(tripData.routeId, new Set());
            const stopSet = routeStopsMap.get(tripData.routeId);

            for (const pt of tripData.path) {
                const key = `${Math.round(pt.lat / GRID_RES)}_${Math.round(pt.lon / GRID_RES)}`;
                // Preveri celico in 8 sosedov
                for (let di = -1; di <= 1; di++) {
                    for (let dj = -1; dj <= 1; dj++) {
                        const nk = `${Math.round(pt.lat / GRID_RES) + di}_${Math.round(pt.lon / GRID_RES) + dj}`;
                        const stops = grid.get(nk);
                        if (stops) stops.forEach(id => stopSet.add(id));
                    }
                }
            }
        }
    }

    function showError(msg) {
        statusText.textContent = `Napaka: ${msg}`;
        uploadStatus.querySelector('.spinner').style.display = 'none';
        setTimeout(() => {
            uploadStatus.classList.add('hidden');
            uploadStatus.querySelector('.spinner').style.display = '';
        }, 4000);
    }

    // ── Map ──

    function showMap() {
        uploadScreen.classList.add('hidden');
        mapScreen.classList.remove('hidden');

        const { bounds } = gtfsData;

        map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                sources: {
                    'carto-dark': {
                        type: 'raster',
                        tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
                        tileSize: 256,
                        attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                    }
                },
                layers: [{
                    id: 'carto-dark-layer',
                    type: 'raster',
                    source: 'carto-dark',
                    minzoom: 0,
                    maxzoom: 20
                }]
            },
            center: [(bounds.minLon + bounds.maxLon) / 2, (bounds.minLat + bounds.maxLat) / 2],
            zoom: 12,
            minZoom: 8,
            maxZoom: 18,
            antialias: true
        });

        map.on('load', () => {
            initDeckOverlay();
            populateSidebar();
            selectAll();
        });

        map.fitBounds(
            [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
            { padding: 60, maxZoom: 15 }
        );
    }

    // ── deck.gl ──

    function initDeckOverlay() {
        deckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
        map.addControl(deckOverlay);
    }

    /**
     * Rebuild trips + stops cache. Kliče se SAMO ob spremembi activeRoutes.
     */
    function rebuildCache() {
        // Trips
        tripsCache = [];
        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;
            const route = gtfsData.routes.get(tripData.routeId);
            if (!route) continue;
            tripsCache.push({
                path: tripData.path.map(p => [p.lon, p.lat, p.timestamp]),
                color: hexToRgb(route.color),
                routeId: tripData.routeId
            });
        }

        // Stop colors — zmeša barve aktivnih linij
        stopColorsCache.clear();
        for (const routeId of activeRoutes) {
            const route = gtfsData.routes.get(routeId);
            if (!route) continue;
            const stopSet = routeStopsMap.get(routeId);
            if (!stopSet) continue;
            const rgb = hexToRgb(route.color);
            for (const stopId of stopSet) {
                if (!stopColorsCache.has(stopId)) {
                    stopColorsCache.set(stopId, [...rgb]);
                }
                // Če več linij deli postajo, vzamemo zadnjo (ali lahko mešamo)
            }
        }

        renderLayers();
    }

    /**
     * Renderira deck.gl layerje. Kliče se na vsak frame (samo currentTime se spremeni).
     */
    function renderLayers() {
        if (!deckOverlay) return;

        const TRAIL_LENGTH = 180; // sekund trail

        // 1) Trips trail layer
        const tripsLayer = new deck.TripsLayer({
            id: 'trips',
            data: tripsCache,
            getPath: d => d.path,
            getTimestamps: d => d.path.map(p => p[2]),
            getColor: d => d.color,
            opacity: 0.85,
            widthMinPixels: 3,
            widthMaxPixels: 8,
            jointRounded: true,
            capRounded: true,
            trailLength: TRAIL_LENGTH,
            currentTime,
            shadowEnabled: false,
            // Glow: multiple layers trikotnik
            parameters: { depthTest: false }
        });

        // Soft glow layer (širši, prosojnejši trail pod glavnim)
        const glowLayer = new deck.TripsLayer({
            id: 'trips-glow',
            data: tripsCache,
            getPath: d => d.path,
            getTimestamps: d => d.path.map(p => p[2]),
            getColor: d => [...d.color, 60],
            opacity: 0.4,
            widthMinPixels: 10,
            widthMaxPixels: 24,
            jointRounded: true,
            capRounded: true,
            trailLength: TRAIL_LENGTH * 0.6,
            currentTime,
            shadowEnabled: false,
            parameters: { depthTest: false }
        });

        // 2) Vehicle positions (interpolirane pike)
        const vehicles = getVehiclePositions();

        const vehicleLayer = new deck.ScatterplotLayer({
            id: 'vehicles',
            data: vehicles,
            getPosition: d => d.position,
            getFillColor: d => [...d.color, 240],
            getRadius: 30,
            radiusMinPixels: 5,
            radiusMaxPixels: 14,
            radiusUnits: 'meters',
            stroked: true,
            getLineColor: [255, 255, 255, 200],
            lineWidthMinPixels: 1.5,
            pickable: true,
            parameters: { depthTest: false },
            transitions: { getPosition: 200 }
        });

        // Vehicle glow
        const vehicleGlowLayer = new deck.ScatterplotLayer({
            id: 'vehicles-glow',
            data: vehicles,
            getPosition: d => d.position,
            getFillColor: d => [...d.color, 50],
            getRadius: 100,
            radiusMinPixels: 12,
            radiusMaxPixels: 30,
            radiusUnits: 'meters',
            stroked: false,
            parameters: { depthTest: false }
        });

        // 3) Stops — dinamično obarvane
        const stopsData = buildStopsLayerData(vehicles);

        const stopsLayer = new deck.ScatterplotLayer({
            id: 'stops',
            data: stopsData,
            getPosition: d => d.position,
            getFillColor: d => d.color,
            getRadius: d => d.radius,
            radiusMinPixels: 2,
            radiusMaxPixels: 12,
            radiusUnits: 'meters',
            stroked: true,
            getLineColor: d => d.strokeColor,
            lineWidthMinPixels: 1,
            pickable: true,
            parameters: { depthTest: false },
            transitions: {
                getRadius: 300,
                getFillColor: 300
            },
            onClick: (info) => {
                if (info.object) showStopPopup(info.object, info.coordinate);
            }
        });

        // Stop labels (via TextLayer pri visokem zoomu)
        const zoom = map ? map.getZoom() : 12;
        const layers = [glowLayer, tripsLayer, stopsLayer, vehicleGlowLayer, vehicleLayer];

        if (zoom >= 14) {
            const textLayer = new deck.TextLayer({
                id: 'stop-labels',
                data: stopsData,
                getPosition: d => d.position,
                getText: d => d.name,
                getSize: 12,
                getColor: [255, 255, 255, 200],
                getTextAnchor: 'start',
                getAlignmentBaseline: 'center',
                getPixelOffset: [8, 0],
                fontFamily: '"Segoe UI", system-ui, sans-serif',
                fontWeight: 500,
                outlineWidth: 2,
                outlineColor: [0, 0, 0, 180],
                billboard: false,
                sizeUnits: 'pixels',
                parameters: { depthTest: false }
            });
            layers.push(textLayer);
        }

        deckOverlay.setProps({ layers });
    }

    function buildStopsLayerData(vehicles) {
        const PROXIMITY_METERS = 200;
        const result = [];
        const defaultColor = [180, 180, 200, 100];
        const defaultStroke = [255, 255, 255, 40];

        // Zgradi hitro lookup za bližnja vozila
        const vehicleLookup = [];
        for (const v of vehicles) {
            vehicleLookup.push({ lon: v.position[0], lat: v.position[1], color: v.color });
        }

        for (const [stopId, stop] of gtfsData.stops) {
            const cached = stopColorsCache.get(stopId);
            let color, strokeColor, radius;

            if (cached) {
                // Postaja pripada aktivni liniji
                color = [...cached, 160];
                strokeColor = [...cached, 200];
                radius = 20;

                // Preveri bližino vozila — pulse efekt
                for (const v of vehicleLookup) {
                    const dist = quickDist(stop.lat, stop.lon, v.lat, v.lon);
                    if (dist < PROXIMITY_METERS) {
                        // Vozilo blizu — večja, svetlejša
                        const intensity = 1 - (dist / PROXIMITY_METERS);
                        color = [...v.color, Math.floor(160 + 95 * intensity)];
                        strokeColor = [255, 255, 255, Math.floor(150 + 105 * intensity)];
                        radius = 20 + 40 * intensity;
                        break;
                    }
                }
            } else {
                // Neaktivna postaja
                color = defaultColor;
                strokeColor = defaultStroke;
                radius = 12;
            }

            result.push({
                position: [stop.lon, stop.lat],
                color,
                strokeColor,
                radius,
                name: stop.name,
                stopId
            });
        }

        return result;
    }

    function showStopPopup(stopData, coordinate) {
        if (!map) return;

        // Odstrani obstoječe popup-e
        document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());

        const schedule = getStopSchedule(stopData.stopId);

        new maplibregl.Popup({
            closeButton: true,
            maxWidth: '300px',
            className: 'jpp-popup'
        })
        .setLngLat(coordinate)
        .setHTML(`<div class="popup-content"><h4>${stopData.name}</h4>${schedule}</div>`)
        .addTo(map);
    }

    function getStopSchedule(stopId) {
        const items = [];
        const windowSec = 30 * 60;
        const stop = gtfsData.stops.get(stopId);
        if (!stop) return '<p class="popup-empty">Ni podatkov</p>';

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;
            const route = gtfsData.routes.get(tripData.routeId);
            if (!route) continue;

            for (const pt of tripData.path) {
                if (Math.abs(pt.timestamp - currentTime) <= windowSec) {
                    if (Math.abs(pt.lat - stop.lat) < 0.0005 && Math.abs(pt.lon - stop.lon) < 0.0005) {
                        items.push({ time: secondsToTime(pt.timestamp), route: route.name, color: route.color });
                        break;
                    }
                }
            }
        }

        if (items.length === 0) return '<p class="popup-empty">Ni prihodov v ±30 min</p>';

        items.sort((a, b) => a.time.localeCompare(b.time));
        return '<ul class="popup-schedule">' +
            items.slice(0, 12).map(i =>
                `<li><span class="popup-dot" style="background:${i.color}"></span><span class="popup-route">${i.route}</span><span class="popup-time">${i.time}</span></li>`
            ).join('') + '</ul>';
    }

    function getVehiclePositions() {
        const positions = [];
        for (const trip of tripsCache) {
            const path = trip.path;
            if (path.length < 2) continue;
            const startTime = path[0][2];
            const endTime = path[path.length - 1][2];
            if (currentTime < startTime || currentTime > endTime) continue;

            // Binarna interpolacija pozicije
            let lo = 0, hi = path.length - 2;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (path[mid + 1][2] < currentTime) lo = mid + 1;
                else hi = mid;
            }

            const a = path[lo], b = path[lo + 1];
            if (b[2] <= a[2]) continue;
            const t = Math.min(1, Math.max(0, (currentTime - a[2]) / (b[2] - a[2])));

            positions.push({
                position: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
                color: trip.color,
                routeId: trip.routeId
            });
        }
        return positions;
    }

    // Hitra razdalja (brez trigonometrije, dovolj za proximity check)
    function quickDist(lat1, lon1, lat2, lon2) {
        const dlat = (lat2 - lat1) * 111320;
        const dlon = (lon2 - lon1) * 111320 * Math.cos(lat1 * 0.01745329);
        return Math.sqrt(dlat * dlat + dlon * dlon);
    }

    // ── Sidebar ──

    function populateSidebar() {
        routeList.innerHTML = '';
        const sorted = [...gtfsData.routes.entries()].sort((a, b) => {
            const na = parseInt(a[1].name.replace(/\D/g, '')) || 0;
            const nb = parseInt(b[1].name.replace(/\D/g, '')) || 0;
            return na - nb || a[1].name.localeCompare(b[1].name);
        });

        for (const [routeId, route] of sorted) {
            const div = document.createElement('div');
            div.className = 'route-item';
            div.dataset.routeId = routeId;
            div.innerHTML = `
                <div class="route-color" style="background:${route.color}"></div>
                <span class="route-name" title="${route.longName || route.name}">${route.name}</span>
                <span class="route-count">${route.tripIds.size}</span>
            `;
            div.addEventListener('click', () => toggleRoute(routeId));
            routeList.appendChild(div);
        }
    }

    function toggleRoute(routeId) {
        if (activeRoutes.has(routeId)) activeRoutes.delete(routeId);
        else activeRoutes.add(routeId);
        onRoutesChanged();
    }

    function selectAll() {
        activeRoutes = new Set(gtfsData.routes.keys());
        onRoutesChanged();
    }

    function deselectAll() {
        activeRoutes.clear();
        onRoutesChanged();
    }

    function onRoutesChanged() {
        updateSidebarState();
        rebuildCache();
        updateStats();
    }

    function updateSidebarState() {
        document.querySelectorAll('.route-item').forEach(el => {
            el.classList.toggle('active', activeRoutes.has(el.dataset.routeId));
        });
    }

    function updateStats() {
        let activeVehicles = 0;
        for (const trip of tripsCache) {
            const path = trip.path;
            if (path.length >= 2 && currentTime >= path[0][2] && currentTime <= path[path.length - 1][2]) {
                activeVehicles++;
            }
        }
        statsInfo.innerHTML = `
            <div class="stat-row"><span>Linij</span><strong>${activeRoutes.size} / ${gtfsData.routes.size}</strong></div>
            <div class="stat-row"><span>Vozil</span><strong>${activeVehicles}</strong></div>
        `;
    }

    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);
    backBtn.addEventListener('click', () => {
        stopAnimation();
        mapScreen.classList.add('hidden');
        uploadScreen.classList.remove('hidden');
        if (map) { map.remove(); map = null; }
        deckOverlay = null; gtfsData = null; activeRoutes.clear();
        tripsCache = []; stopColorsCache.clear(); routeStopsMap.clear();
        fileInput.value = '';
        uploadStatus.classList.add('hidden');
    });

    // ── Timeline ──

    slider.addEventListener('input', () => {
        currentTime = parseInt(slider.value, 10);
        timeDisplay.textContent = secondsToTime(currentTime);
        renderLayers();
        updateStats();
    });

    playBtn.addEventListener('click', () => isPlaying ? stopAnimation() : startAnimation());

    resetBtn.addEventListener('click', () => {
        stopAnimation();
        currentTime = 14400;
        slider.value = currentTime;
        timeDisplay.textContent = secondsToTime(currentTime);
        renderLayers();
        updateStats();
    });

    speedSelect.addEventListener('change', () => { speed = parseFloat(speedSelect.value); });

    // Tudi zoom spremembe zahtevajo re-render (za text labels)
    function onMapChange() { if (deckOverlay && tripsCache.length) renderLayers(); }

    function startAnimation() {
        isPlaying = true;
        playBtn.textContent = '⏸';
        playBtn.classList.add('playing');
        lastFrameTime = performance.now();
        animFrameId = requestAnimationFrame(animLoop);
        // Track zoom changes med animacijo
        if (map) map.on('zoom', onMapChange);
    }

    function stopAnimation() {
        isPlaying = false;
        playBtn.textContent = '▶';
        playBtn.classList.remove('playing');
        lastFrameTime = null;
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        if (map) map.off('zoom', onMapChange);
    }

    let statsCounter = 0;

    function animLoop(now) {
        if (!isPlaying) return;

        const dt = Math.min((now - lastFrameTime) / 1000, 0.1); // cap za tab-switch
        lastFrameTime = now;

        currentTime += dt * speed * 60;

        if (currentTime > 86400) { currentTime = 86400; stopAnimation(); }

        slider.value = currentTime;
        timeDisplay.textContent = secondsToTime(currentTime);
        renderLayers();

        // Stats update vsakih ~500ms
        if (++statsCounter % 30 === 0) updateStats();

        animFrameId = requestAnimationFrame(animLoop);
    }

    // ── Utility ──

    function secondsToTime(sec) {
        sec = Math.max(0, Math.min(86400, Math.floor(sec)));
        const h = Math.floor(sec / 3600) % 24;
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
})();
