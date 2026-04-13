/**
 * JPP Maribor — Marprom bus visualization
 *
 * Loads pre-processed Marprom data and animates buses on a map.
 * Architecture:
 *   - tripsCache: rebuilt only on line/day change
 *   - renderLayers: called per frame, only updates currentTime
 *   - Click bus → camera follows it
 *   - Dark/light theme toggle
 */

(() => {
    // ── State ──
    let map = null;
    let deckOverlay = null;
    let marprom = null;           // raw data from marprom.json
    let activeLines = new Set();
    let dayFilter = "mon";        // mon | sat | sun
    let currentTime = 14400;      // 04:00
    let isPlaying = false;
    let speed = 1;
    let lastFrameTime = null;
    let animFrameId = null;
    let lineWidth = 3;            // route line width (slider)
    let isDark = true;            // theme

    // Follow mode
    let followTripId = null;

    // Cache
    let tripsCache = [];         // [{path, color, line, id, headsign}, ...]
    let routeLinesCache = [];    // [{coords, color}, ...]
    let lineStopsMap = {};       // lineCode → Set<stopIdx>

    // ── Tiles ──
    const TILES = {
        dark: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        light: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
    };

    // ── DOM ──
    const $ = id => document.getElementById(id);
    const loadingScreen = $('loading-screen');
    const mapScreen = $('map-screen');
    const loadingStatus = $('loading-status');
    const routeList = $('route-list');
    const slider = $('time-slider');
    const timeDisplay = $('time-display');
    const playBtn = $('play-btn');
    const resetBtn = $('reset-btn');
    const speedSelect = $('speed-select');
    const selectAllBtn = $('select-all-btn');
    const deselectAllBtn = $('deselect-all-btn');
    const statsInfo = $('stats-info');
    const followBanner = $('follow-banner');
    const followInfo = $('follow-info');
    const followClose = $('follow-close');
    const lineWidthSlider = $('line-width-slider');
    const themeBtn = $('theme-btn');

    // ── Load data ──

    async function init() {
        try {
            loadingStatus.textContent = 'Nalagam podatke Marprom...';
            const resp = await fetch('data/marprom.json');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            marprom = await resp.json();
            loadingStatus.textContent = `${Object.keys(marprom.lines).length} linij · ${marprom.trips.length} voženj · ${marprom.stops.length} postaj`;

            buildLineStopsMap();

            // Restore theme from localStorage
            const saved = localStorage.getItem('jpp-theme');
            if (saved === 'light') isDark = false;

            setTimeout(showMap, 300);
        } catch (err) {
            loadingStatus.textContent = `Napaka: ${err.message}`;
        }
    }

    function buildLineStopsMap() {
        lineStopsMap = {};
        const stopGrid = new Map();
        const RES = 0.0008;
        marprom.stops.forEach((s, idx) => {
            const key = `${Math.round(s.lat / RES)}_${Math.round(s.lon / RES)}`;
            if (!stopGrid.has(key)) stopGrid.set(key, []);
            stopGrid.get(key).push(idx);
        });

        for (const trip of marprom.trips) {
            if (!lineStopsMap[trip.line]) lineStopsMap[trip.line] = new Set();
            const set = lineStopsMap[trip.line];
            for (const pt of trip.path) {
                const key = `${Math.round(pt[1] / RES)}_${Math.round(pt[0] / RES)}`;
                for (let di = -1; di <= 1; di++) {
                    for (let dj = -1; dj <= 1; dj++) {
                        const nk = `${Math.round(pt[1] / RES) + di}_${Math.round(pt[0] / RES) + dj}`;
                        const ids = stopGrid.get(nk);
                        if (ids) ids.forEach(id => set.add(id));
                    }
                }
            }
        }
    }

    function tripMatchesDay(trip) {
        if (!trip.days || trip.days.length === 0) return true;
        if (dayFilter === "mon") return trip.days.some(d => ["mon", "tue", "wed", "thu", "fri"].includes(d));
        if (dayFilter === "sat") return trip.days.includes("sat");
        if (dayFilter === "sun") return trip.days.includes("sun");
        return true;
    }

    // ── Map ──

    function showMap() {
        loadingScreen.classList.add('hidden');
        mapScreen.classList.remove('hidden');

        applyThemeClass();

        map = new maplibregl.Map({
            container: 'map',
            style: buildMapStyle(),
            center: [15.6459, 46.5546],
            zoom: 13,
            minZoom: 10,
            maxZoom: 18,
            antialias: true
        });

        map.on('load', () => {
            initDeckOverlay();
            populateSidebar();
            selectAll();
        });

        map.on('zoomend', () => { if (tripsCache.length) renderLayers(); });
    }

    function buildMapStyle() {
        const tile = isDark ? TILES.dark : TILES.light;
        return {
            version: 8,
            sources: {
                'carto': {
                    type: 'raster',
                    tiles: [tile],
                    tileSize: 256,
                    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                }
            },
            layers: [{ id: 'base', type: 'raster', source: 'carto' }]
        };
    }

    // ── Theme ──

    function applyThemeClass() {
        document.body.classList.toggle('light-theme', !isDark);
        if (themeBtn) themeBtn.textContent = isDark ? '☀' : '☾';
    }

    function toggleTheme() {
        isDark = !isDark;
        localStorage.setItem('jpp-theme', isDark ? 'dark' : 'light');
        applyThemeClass();
        if (map) map.setStyle(buildMapStyle());
        // Re-init deck after style change
        map.once('style.load', () => {
            initDeckOverlay();
            rebuildCache();
        });
    }

    // ── deck.gl ──

    function initDeckOverlay() {
        deckOverlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
        map.addControl(deckOverlay);
    }

    function rebuildCache() {
        tripsCache = [];
        for (const trip of marprom.trips) {
            if (!activeLines.has(trip.line)) continue;
            if (!tripMatchesDay(trip)) continue;
            const lineInfo = marprom.lines[trip.line];
            if (!lineInfo) continue;
            tripsCache.push({
                path: trip.path,
                color: hexToRgb(lineInfo.color),
                line: trip.line,
                id: trip.id,
                headsign: trip.headsign
            });
        }

        routeLinesCache = [];
        const seenRoutes = new Set();
        for (const rl of marprom.routeLines) {
            if (!activeLines.has(rl.code)) continue;
            const key = rl.routeId;
            if (seenRoutes.has(key)) continue;
            seenRoutes.add(key);
            const lineInfo = marprom.lines[rl.code];
            if (!lineInfo) continue;
            const alpha = isDark ? 50 : 80;
            routeLinesCache.push({
                coords: rl.coords,
                color: [...hexToRgb(lineInfo.color), alpha]
            });
        }

        renderLayers();
    }

    function renderLayers() {
        if (!deckOverlay) return;

        const TRAIL = 150;
        const zoom = map ? map.getZoom() : 13;

        // 1. Static route lines
        const routePathLayer = new deck.PathLayer({
            id: 'route-paths',
            data: routeLinesCache,
            getPath: d => d.coords,
            getColor: d => d.color,
            getWidth: lineWidth,
            widthMinPixels: Math.max(0.5, lineWidth * 0.3),
            widthMaxPixels: lineWidth * 2,
            jointRounded: true,
            capRounded: true,
            parameters: { depthTest: false }
        });

        // 2. Main trail
        const tripsLayer = new deck.TripsLayer({
            id: 'trips',
            data: tripsCache,
            getPath: d => d.path,
            getTimestamps: d => d.path.map(p => p[2]),
            getColor: d => d.color,
            opacity: isDark ? 0.85 : 0.95,
            widthMinPixels: Math.max(1, lineWidth * 0.8),
            widthMaxPixels: Math.max(3, lineWidth * 2.5),
            jointRounded: true,
            capRounded: true,
            trailLength: TRAIL,
            currentTime,
            parameters: { depthTest: false }
        });

        // 3. Vehicles
        const vehicles = getVehiclePositions();

        const vehicleLayer = new deck.ScatterplotLayer({
            id: 'vehicles',
            data: vehicles,
            getPosition: d => d.position,
            getFillColor: d => d.id === followTripId
                ? (isDark ? [255, 255, 255, 255] : [40, 40, 40, 255])
                : [...d.color, 240],
            getRadius: d => d.id === followTripId ? 40 : 25,
            radiusMinPixels: 5,
            radiusMaxPixels: 16,
            radiusUnits: 'meters',
            stroked: true,
            getLineColor: d => d.id === followTripId
                ? d.color
                : (isDark ? [255, 255, 255, 180] : [40, 40, 40, 180]),
            lineWidthMinPixels: 1.5,
            pickable: true,
            autoHighlight: true,
            highlightColor: isDark ? [255, 255, 255, 80] : [0, 0, 0, 60],
            onClick: onVehicleClick,
            parameters: { depthTest: false }
        });

        // 4. Stops
        const stopsData = buildStopsData(vehicles);

        const stopsLayer = new deck.ScatterplotLayer({
            id: 'stops',
            data: stopsData,
            getPosition: d => d.position,
            getFillColor: d => d.color,
            getRadius: d => d.radius,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 12,
            radiusUnits: 'meters',
            stroked: true,
            getLineColor: d => d.stroke,
            lineWidthMinPixels: 0.5,
            pickable: true,
            parameters: { depthTest: false },
            onClick: onStopClick,
            transitions: { getRadius: 200, getFillColor: 200 }
        });

        // 5. Layers
        const layers = [routePathLayer, tripsLayer, stopsLayer, vehicleLayer];

        // 6. Stop labels at high zoom
        if (zoom >= 15) {
            layers.push(new deck.TextLayer({
                id: 'stop-labels',
                data: stopsData.filter(s => s.isActive),
                getPosition: d => d.position,
                getText: d => d.name,
                getSize: 11,
                getColor: isDark ? [255, 255, 255, 180] : [30, 30, 30, 200],
                getTextAnchor: 'start',
                getAlignmentBaseline: 'center',
                getPixelOffset: [8, 0],
                fontFamily: '"Segoe UI", system-ui, sans-serif',
                fontWeight: 500,
                outlineWidth: 2,
                outlineColor: isDark ? [0, 0, 0, 200] : [255, 255, 255, 220],
                billboard: false,
                sizeUnits: 'pixels',
                parameters: { depthTest: false }
            }));
        }

        deckOverlay.setProps({ layers });

        // Follow mode
        if (followTripId) {
            const followed = vehicles.find(v => v.id === followTripId);
            if (followed) {
                map.easeTo({
                    center: followed.position,
                    duration: isPlaying ? 800 : 300,
                    easing: t => t * (2 - t)
                });
            } else {
                unfollowVehicle();
            }
        }
    }

    function getVehiclePositions() {
        const out = [];
        for (const trip of tripsCache) {
            const path = trip.path;
            if (path.length < 2) continue;
            if (currentTime < path[0][2] || currentTime > path[path.length - 1][2]) continue;

            let lo = 0, hi = path.length - 2;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (path[mid + 1][2] < currentTime) lo = mid + 1;
                else hi = mid;
            }

            const a = path[lo], b = path[lo + 1];
            if (b[2] <= a[2]) continue;
            const t = Math.min(1, Math.max(0, (currentTime - a[2]) / (b[2] - a[2])));

            out.push({
                position: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
                color: trip.color,
                line: trip.line,
                id: trip.id,
                headsign: trip.headsign
            });
        }
        return out;
    }

    function buildStopsData(vehicles) {
        const PROXIMITY = 150;
        const result = [];
        const defaultColor = isDark ? [140, 140, 170, 70] : [120, 120, 140, 100];
        const defaultStroke = isDark ? [255, 255, 255, 20] : [80, 80, 80, 40];

        const stopColors = new Map();
        for (const line of activeLines) {
            const stops = lineStopsMap[line];
            if (!stops) continue;
            const lineInfo = marprom.lines[line];
            if (!lineInfo) continue;
            const rgb = hexToRgb(lineInfo.color);
            for (const idx of stops) {
                if (!stopColors.has(idx)) stopColors.set(idx, rgb);
            }
        }

        marprom.stops.forEach((stop, idx) => {
            const cached = stopColors.get(idx);
            let color, stroke, radius;
            const isActive = !!cached;

            if (cached) {
                color = [...cached, isDark ? 130 : 180];
                stroke = [...cached, isDark ? 180 : 220];
                radius = 16;

                for (const v of vehicles) {
                    const dist = quickDist(stop.lat, stop.lon, v.position[1], v.position[0]);
                    if (dist < PROXIMITY) {
                        const intensity = 1 - dist / PROXIMITY;
                        color = [...v.color, Math.floor(140 + 115 * intensity)];
                        stroke = isDark
                            ? [255, 255, 255, Math.floor(120 + 135 * intensity)]
                            : [40, 40, 40, Math.floor(120 + 135 * intensity)];
                        radius = 16 + 50 * intensity * intensity;
                        break;
                    }
                }
            } else {
                color = defaultColor;
                stroke = defaultStroke;
                radius = 8;
            }

            result.push({
                position: [stop.lon, stop.lat],
                color, stroke, radius,
                name: stop.name,
                idx, isActive
            });
        });

        return result;
    }

    // ── Interactions ──

    function onVehicleClick(info) {
        if (!info.object) return;
        const v = info.object;
        followTripId = v.id;
        const lineInfo = marprom.lines[v.line];
        followInfo.innerHTML = `<span class="follow-dot" style="background:${lineInfo?.color || '#4fc3f7'}"></span><strong>${v.line}</strong> ${v.headsign}`;
        followBanner.classList.remove('hidden');
        renderLayers();
    }

    function unfollowVehicle() {
        followTripId = null;
        followBanner.classList.add('hidden');
        renderLayers();
    }

    followClose.addEventListener('click', unfollowVehicle);

    function onStopClick(info) {
        if (!info.object || !map) return;
        const s = info.object;
        document.querySelectorAll('.maplibregl-popup').forEach(p => p.remove());

        const schedule = getStopSchedule(s.idx);
        new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'jpp-popup' })
            .setLngLat(s.position)
            .setHTML(`<div class="popup-content"><h4>${s.name}</h4>${schedule}</div>`)
            .addTo(map);
    }

    function getStopSchedule(stopIdx) {
        const stop = marprom.stops[stopIdx];
        if (!stop) return '';
        const items = [];
        const window = 30 * 60;

        for (const trip of tripsCache) {
            const path = trip.path;
            for (const pt of path) {
                if (Math.abs(pt[2] - currentTime) <= window &&
                    Math.abs(pt[1] - stop.lat) < 0.0004 &&
                    Math.abs(pt[0] - stop.lon) < 0.0004) {
                    const lineInfo = marprom.lines[trip.line];
                    items.push({
                        time: secsToTime(pt[2]),
                        line: trip.line,
                        headsign: trip.headsign,
                        color: lineInfo?.color || '#4fc3f7'
                    });
                    break;
                }
            }
        }

        if (!items.length) return '<p class="popup-empty">Ni prihodov v ±30 min</p>';
        items.sort((a, b) => a.time.localeCompare(b.time));
        return '<ul class="popup-schedule">' +
            items.slice(0, 12).map(i =>
                `<li><span class="popup-dot" style="background:${i.color}"></span><span class="popup-line">${i.line}</span><span class="popup-head">${i.headsign}</span><span class="popup-time">${i.time}</span></li>`
            ).join('') + '</ul>';
    }

    // ── Sidebar ──

    function populateSidebar() {
        routeList.innerHTML = '';
        const sorted = Object.values(marprom.lines).sort((a, b) => {
            const na = parseInt(a.code.replace(/\D/g, '')) || 0;
            const nb = parseInt(b.code.replace(/\D/g, '')) || 0;
            return na - nb;
        });

        for (const line of sorted) {
            const tripCount = marprom.trips.filter(t => t.line === line.code && tripMatchesDay(t)).length;
            const div = document.createElement('div');
            div.className = 'route-item';
            div.dataset.line = line.code;
            div.innerHTML = `
                <div class="route-color" style="background:${line.color}"></div>
                <span class="route-name" title="${line.name}">${line.code}</span>
                <span class="route-desc">${line.name.replace(line.code + ' ', '')}</span>
                <span class="route-count">${tripCount}</span>
            `;
            div.addEventListener('click', () => toggleLine(line.code));
            routeList.appendChild(div);
        }
    }

    function toggleLine(code) {
        if (activeLines.has(code)) activeLines.delete(code);
        else activeLines.add(code);
        onLinesChanged();
    }

    function selectAll() {
        activeLines = new Set(Object.keys(marprom.lines));
        onLinesChanged();
    }

    function deselectAll() {
        activeLines.clear();
        onLinesChanged();
    }

    function onLinesChanged() {
        updateSidebarActive();
        rebuildCache();
        updateStats();
    }

    function updateSidebarActive() {
        document.querySelectorAll('.route-item').forEach(el => {
            el.classList.toggle('active', activeLines.has(el.dataset.line));
        });
    }

    function updateStats() {
        let active = 0;
        for (const trip of tripsCache) {
            const p = trip.path;
            if (p.length >= 2 && currentTime >= p[0][2] && currentTime <= p[p.length - 1][2]) active++;
        }
        statsInfo.innerHTML = `
            <div class="stat-row"><span>Linij</span><strong>${activeLines.size} / ${Object.keys(marprom.lines).length}</strong></div>
            <div class="stat-row"><span>Vozil</span><strong>${active}</strong></div>
        `;
    }

    selectAllBtn.addEventListener('click', selectAll);
    deselectAllBtn.addEventListener('click', deselectAll);

    // Day filter
    document.querySelectorAll('.day-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            dayFilter = btn.dataset.day;
            populateSidebar();
            onLinesChanged();
        });
    });

    // ── Timeline ──

    slider.addEventListener('input', () => {
        currentTime = parseInt(slider.value, 10);
        timeDisplay.textContent = secsToTime(currentTime);
        renderLayers();
        updateStats();
    });

    playBtn.addEventListener('click', () => isPlaying ? stopAnim() : startAnim());
    resetBtn.addEventListener('click', () => {
        stopAnim();
        currentTime = 14400;
        slider.value = currentTime;
        timeDisplay.textContent = secsToTime(currentTime);
        renderLayers();
        updateStats();
    });

    speedSelect.addEventListener('change', () => { speed = parseFloat(speedSelect.value); });

    function startAnim() {
        isPlaying = true;
        playBtn.textContent = '\u23F8';
        playBtn.classList.add('playing');
        lastFrameTime = performance.now();
        animFrameId = requestAnimationFrame(loop);
        map?.on('zoom', onZoom);
    }

    function stopAnim() {
        isPlaying = false;
        playBtn.textContent = '\u25B6';
        playBtn.classList.remove('playing');
        if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
        map?.off('zoom', onZoom);
    }

    function onZoom() { if (tripsCache.length) renderLayers(); }

    let frameCount = 0;

    function loop(now) {
        if (!isPlaying) return;
        const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
        lastFrameTime = now;
        currentTime += dt * speed * 60;
        if (currentTime > 86400) { currentTime = 86400; stopAnim(); }
        slider.value = currentTime;
        timeDisplay.textContent = secsToTime(currentTime);
        renderLayers();
        if (++frameCount % 30 === 0) updateStats();
        animFrameId = requestAnimationFrame(loop);
    }

    // ── Util ──

    function secsToTime(sec) {
        sec = Math.max(0, Math.min(86400, Math.floor(sec)));
        const h = Math.floor(sec / 3600) % 24;
        const m = Math.floor((sec % 3600) / 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }

    function quickDist(lat1, lon1, lat2, lon2) {
        const dlat = (lat2 - lat1) * 111320;
        const dlon = (lon2 - lon1) * 111320 * Math.cos(lat1 * 0.01745329);
        return Math.sqrt(dlat * dlat + dlon * dlon);
    }

    // ── Line width slider ──
    lineWidthSlider.addEventListener('input', () => {
        lineWidth = parseFloat(lineWidthSlider.value);
        renderLayers();
    });

    // ── Sidebar resize (mobile) ──
    const sidebarEl = $('sidebar');
    const sidebarHandle = $('sidebar-handle');
    let dragging = false;
    let dragStartY = 0;
    let dragStartH = 0;

    function onDragStart(e) {
        if (window.innerWidth > 768) return;
        dragging = true;
        const touch = e.touches ? e.touches[0] : e;
        dragStartY = touch.clientY;
        dragStartH = sidebarEl.offsetHeight;
        sidebarHandle.style.cursor = 'grabbing';
        e.preventDefault();
    }

    function onDragMove(e) {
        if (!dragging) return;
        const touch = e.touches ? e.touches[0] : e;
        const dy = dragStartY - touch.clientY;
        const newH = Math.max(80, Math.min(window.innerHeight * 0.6, dragStartH + dy));
        sidebarEl.style.maxHeight = newH + 'px';
        e.preventDefault();
    }

    function onDragEnd() {
        if (!dragging) return;
        dragging = false;
        sidebarHandle.style.cursor = '';
    }

    sidebarHandle.addEventListener('touchstart', onDragStart, { passive: false });
    sidebarHandle.addEventListener('mousedown', onDragStart);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('touchend', onDragEnd);
    document.addEventListener('mouseup', onDragEnd);

    // ── Theme toggle ──
    themeBtn.addEventListener('click', toggleTheme);

    // ── Start ──
    init();

})();
