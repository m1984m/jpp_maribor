/**
 * JPP Maribor — Glavna aplikacija
 * MapLibre GL + deck.gl TripsLayer animacija GTFS podatkov
 */

(() => {
    // State
    let map = null;
    let deckOverlay = null;
    let gtfsData = null;  // { routes, trips, stops, tripPaths, bounds }
    let activeRoutes = new Set();
    let currentTime = 14400; // 04:00 v sekundah
    let isPlaying = false;
    let speed = 1;
    let lastFrameTime = null;
    let animFrameId = null;

    // DOM
    const uploadScreen = document.getElementById('upload-screen');
    const mapScreen = document.getElementById('map-screen');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const uploadStatus = document.getElementById('upload-status');
    const statusText = document.getElementById('status-text');
    const routeList = document.getElementById('route-list');
    const slider = document.getElementById('time-slider');
    const timeDisplay = document.getElementById('time-display');
    const playBtn = document.getElementById('play-btn');
    const resetBtn = document.getElementById('reset-btn');
    const speedSelect = document.getElementById('speed-select');
    const selectAllBtn = document.getElementById('select-all-btn');
    const deselectAllBtn = document.getElementById('deselect-all-btn');
    const backBtn = document.getElementById('back-btn');
    const statsInfo = document.getElementById('stats-info');

    // ── Upload handling ──

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        if (e.target.files[0]) handleFile(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.zip')) {
            handleFile(file);
        } else {
            showError('Prosim naloži .zip datoteko');
        }
    });

    async function handleFile(file) {
        uploadStatus.classList.remove('hidden');
        statusText.textContent = 'Razčlenjujem GTFS podatke...';

        try {
            gtfsData = await GTFSParser.parse(file);

            const tripCount = gtfsData.tripPaths.size;
            const routeCount = gtfsData.routes.size;
            const stopCount = gtfsData.stops.size;

            if (tripCount === 0) {
                throw new Error('Ni najdenih veljavnih voženj. Preveri GTFS datoteke.');
            }

            statusText.textContent = `Naloženo: ${routeCount} linij, ${tripCount} voženj, ${stopCount} postaj`;

            setTimeout(() => showMap(), 500);

        } catch (err) {
            showError(err.message);
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

    // ── Map initialization ──

    function showMap() {
        uploadScreen.classList.add('hidden');
        mapScreen.classList.remove('hidden');

        const { bounds } = gtfsData;
        const centerLat = (bounds.minLat + bounds.maxLat) / 2;
        const centerLon = (bounds.minLon + bounds.maxLon) / 2;

        map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                sources: {
                    'osm-tiles': {
                        type: 'raster',
                        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                        tileSize: 256,
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    },
                    'carto-dark': {
                        type: 'raster',
                        tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
                        tileSize: 256,
                        attribution: '&copy; <a href="https://carto.com/">CARTO</a>'
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
            center: [centerLon, centerLat],
            zoom: 12,
            minZoom: 8,
            maxZoom: 18
        });

        map.on('load', () => {
            // Dodaj postaje kot source + layer
            addStopsLayer();

            // Inicializiraj deck.gl overlay
            initDeckOverlay();

            // Populiraj sidebar
            populateSidebar();

            // Vklopi vse linije
            selectAll();

            // Posodobi statistiko
            updateStats();
        });

        // Fit bounds
        map.fitBounds(
            [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
            { padding: 60, maxZoom: 15 }
        );
    }

    function addStopsLayer() {
        const features = [];
        for (const [stopId, stop] of gtfsData.stops) {
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: { name: stop.name, id: stopId }
            });
        }

        map.addSource('stops', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features }
        });

        map.addLayer({
            id: 'stops-circle',
            type: 'circle',
            source: 'stops',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 4, 18, 8],
                'circle-color': '#ff5252',
                'circle-opacity': 0.7,
                'circle-stroke-width': 1,
                'circle-stroke-color': 'rgba(255,255,255,0.5)'
            }
        });

        map.addLayer({
            id: 'stops-label',
            type: 'symbol',
            source: 'stops',
            minzoom: 14,
            layout: {
                'text-field': ['get', 'name'],
                'text-size': 11,
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-max-width': 10
            },
            paint: {
                'text-color': '#ffffff',
                'text-halo-color': 'rgba(0,0,0,0.7)',
                'text-halo-width': 1
            }
        });

        // Popup ob kliku na postajo
        map.on('click', 'stops-circle', e => {
            const props = e.features[0].properties;
            const coords = e.features[0].geometry.coordinates;

            const schedule = getStopSchedule(props.id);

            new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
                .setLngLat(coords)
                .setHTML(`
                    <div style="color:#222;font-size:13px;max-height:200px;overflow-y:auto">
                        <strong>${props.name}</strong>
                        ${schedule}
                    </div>
                `)
                .addTo(map);
        });

        map.on('mouseenter', 'stops-circle', () => map.getCanvas().style.cursor = 'pointer');
        map.on('mouseleave', 'stops-circle', () => map.getCanvas().style.cursor = '');
    }

    function getStopSchedule(stopId) {
        const items = [];
        const windowSec = 30 * 60; // ±30 min

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;

            const trip = gtfsData.trips.get(tripId);
            const route = gtfsData.routes.get(tripData.routeId);
            if (!route) continue;

            // Najdi postajo v poti
            for (const pt of tripData.path) {
                // Preverimo po stop_times podatkih
                if (Math.abs(pt.timestamp - currentTime) <= windowSec) {
                    const stop = gtfsData.stops.get(stopId);
                    if (stop && haversineSimple(pt.lat, pt.lon, stop.lat, stop.lon) < 50) {
                        items.push({
                            time: secondsToTime(pt.timestamp),
                            route: route.name,
                            color: route.color
                        });
                        break;
                    }
                }
            }
        }

        if (items.length === 0) return '<p style="color:#888;margin-top:8px">Ni prihodov v ±30 min</p>';

        items.sort((a, b) => a.time.localeCompare(b.time));
        return '<ul style="list-style:none;padding:0;margin-top:8px">' +
            items.slice(0, 15).map(i =>
                `<li style="margin:3px 0"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${i.color};margin-right:6px"></span>${i.route} — ${i.time}</li>`
            ).join('') + '</ul>';
    }

    function haversineSimple(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    // ── deck.gl overlay ──

    function initDeckOverlay() {
        deckOverlay = new deck.MapboxOverlay({
            interleaved: false,
            layers: []
        });
        map.addControl(deckOverlay);
        updateDeckLayers();
    }

    function buildTripsData() {
        const tripsArray = [];

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;

            const route = gtfsData.routes.get(tripData.routeId);
            if (!route) continue;

            // deck.gl TripsLayer: path = [[lon, lat, timestamp], ...]
            const path = tripData.path.map(p => [p.lon, p.lat, p.timestamp]);

            tripsArray.push({
                path,
                color: hexToRgb(route.color),
                routeId: tripData.routeId
            });
        }

        return tripsArray;
    }

    function updateDeckLayers() {
        if (!deckOverlay) return;

        const tripsData = buildTripsData();
        const trailLength = 120; // sekund trail-a

        const tripsLayer = new deck.TripsLayer({
            id: 'trips-layer',
            data: tripsData,
            getPath: d => d.path,
            getTimestamps: d => d.path.map(p => p[2]),
            getColor: d => d.color,
            opacity: 0.9,
            widthMinPixels: 3,
            widthMaxPixels: 6,
            jointRounded: true,
            capRounded: true,
            trailLength,
            currentTime,
            shadowEnabled: false
        });

        // Vozila kot pike na trenutni poziciji
        const vehiclePositions = getVehiclePositions();
        const scatterLayer = new deck.ScatterplotLayer({
            id: 'vehicles-layer',
            data: vehiclePositions,
            getPosition: d => d.position,
            getFillColor: d => [...d.color, 220],
            getRadius: 6,
            radiusMinPixels: 4,
            radiusMaxPixels: 10,
            pickable: true,
            stroked: true,
            getLineColor: [255, 255, 255, 180],
            lineWidthMinPixels: 1
        });

        deckOverlay.setProps({
            layers: [tripsLayer, scatterLayer]
        });
    }

    function getVehiclePositions() {
        const positions = [];

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;

            const route = gtfsData.routes.get(tripData.routeId);
            if (!route) continue;

            const path = tripData.path;
            if (path.length < 2) continue;

            // Preveri ali je trip aktiven ob currentTime
            const startTime = path[0].timestamp;
            const endTime = path[path.length - 1].timestamp;

            if (currentTime < startTime || currentTime > endTime) continue;

            // Interpoliraj pozicijo
            let pos = null;
            for (let i = 0; i < path.length - 1; i++) {
                if (currentTime >= path[i].timestamp && currentTime <= path[i + 1].timestamp) {
                    const t = (currentTime - path[i].timestamp) / (path[i + 1].timestamp - path[i].timestamp);
                    pos = [
                        path[i].lon + t * (path[i + 1].lon - path[i].lon),
                        path[i].lat + t * (path[i + 1].lat - path[i].lat)
                    ];
                    break;
                }
            }

            if (pos) {
                positions.push({
                    position: pos,
                    color: hexToRgb(route.color),
                    routeName: route.name,
                    tripId
                });
            }
        }

        return positions;
    }

    // ── Sidebar ──

    function populateSidebar() {
        routeList.innerHTML = '';

        // Sortiraj po imenu linije
        const sortedRoutes = [...gtfsData.routes.entries()]
            .sort((a, b) => {
                const numA = parseInt(a[1].name.replace(/\D/g, '')) || 0;
                const numB = parseInt(b[1].name.replace(/\D/g, '')) || 0;
                return numA - numB || a[1].name.localeCompare(b[1].name);
            });

        for (const [routeId, route] of sortedRoutes) {
            const tripCount = route.tripIds.size;
            const div = document.createElement('div');
            div.className = 'route-item';
            div.dataset.routeId = routeId;
            div.innerHTML = `
                <div class="route-color" style="background:${route.color}"></div>
                <span class="route-name" title="${route.longName || route.name}">${route.name}</span>
                <span class="route-count">${tripCount}</span>
            `;
            div.addEventListener('click', () => toggleRoute(routeId));
            routeList.appendChild(div);
        }
    }

    function toggleRoute(routeId) {
        if (activeRoutes.has(routeId)) {
            activeRoutes.delete(routeId);
        } else {
            activeRoutes.add(routeId);
        }
        updateSidebarState();
        updateDeckLayers();
        updateStats();
    }

    function selectAll() {
        activeRoutes = new Set(gtfsData.routes.keys());
        updateSidebarState();
        updateDeckLayers();
        updateStats();
    }

    function deselectAll() {
        activeRoutes.clear();
        updateSidebarState();
        updateDeckLayers();
        updateStats();
    }

    function updateSidebarState() {
        document.querySelectorAll('.route-item').forEach(el => {
            el.classList.toggle('active', activeRoutes.has(el.dataset.routeId));
        });
    }

    function updateStats() {
        let activeTrips = 0;
        let totalTrips = 0;

        for (const [tripId, tripData] of gtfsData.tripPaths) {
            if (!activeRoutes.has(tripData.routeId)) continue;
            totalTrips++;
            const path = tripData.path;
            if (path.length >= 2 && currentTime >= path[0].timestamp && currentTime <= path[path.length - 1].timestamp) {
                activeTrips++;
            }
        }

        statsInfo.innerHTML = `
            Aktivnih linij: ${activeRoutes.size}/${gtfsData.routes.size}<br>
            Vozil na karti: <strong>${activeTrips}</strong> / ${totalTrips}
        `;
    }

    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);
    backBtn.addEventListener('click', () => {
        stopAnimation();
        mapScreen.classList.add('hidden');
        uploadScreen.classList.remove('hidden');
        if (map) { map.remove(); map = null; }
        deckOverlay = null;
        gtfsData = null;
        activeRoutes.clear();
        fileInput.value = '';
        uploadStatus.classList.add('hidden');
    });

    // ── Timeline ──

    slider.addEventListener('input', () => {
        currentTime = parseInt(slider.value, 10);
        timeDisplay.textContent = secondsToTime(currentTime);
        updateDeckLayers();
        updateStats();
    });

    playBtn.addEventListener('click', () => {
        if (isPlaying) {
            stopAnimation();
        } else {
            startAnimation();
        }
    });

    resetBtn.addEventListener('click', () => {
        stopAnimation();
        currentTime = 14400; // 04:00
        slider.value = currentTime;
        timeDisplay.textContent = secondsToTime(currentTime);
        updateDeckLayers();
        updateStats();
    });

    speedSelect.addEventListener('change', () => {
        speed = parseFloat(speedSelect.value);
    });

    function startAnimation() {
        isPlaying = true;
        playBtn.textContent = '⏸';
        lastFrameTime = performance.now();
        animFrameId = requestAnimationFrame(animationLoop);
    }

    function stopAnimation() {
        isPlaying = false;
        playBtn.textContent = '▶';
        lastFrameTime = null;
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
    }

    function animationLoop(now) {
        if (!isPlaying) return;

        const dt = (now - lastFrameTime) / 1000; // delta v sekundah (realni čas)
        lastFrameTime = now;

        currentTime += dt * speed * 60; // speed * 60 = simuliranih sekund na realno sekundo

        if (currentTime > 86400) {
            currentTime = 86400;
            stopAnimation();
        }

        slider.value = currentTime;
        timeDisplay.textContent = secondsToTime(currentTime);
        updateDeckLayers();

        // Posodobi stats vsakih ~30 frame-ov
        if (Math.floor(now / 500) !== Math.floor((now - dt * 1000) / 500)) {
            updateStats();
        }

        animFrameId = requestAnimationFrame(animationLoop);
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
        return [
            parseInt(hex.substring(0, 2), 16),
            parseInt(hex.substring(2, 4), 16),
            parseInt(hex.substring(4, 6), 16)
        ];
    }

})();
