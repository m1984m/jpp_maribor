let map, isPlaying = false, currentMarkers = {}, currentLabels = {}, animationTimeout = null;

function initMap() {
    console.log('Starting initMap...');

    const mapDiv = document.getElementById('map');
    if (!mapDiv) {
        console.error('Map div not found!');
        return;
    }

    const mapStyles = [
        {"featureType": "all", "elementType": "geometry.fill", "stylers": [{"visibility": "on"}]},
        {"featureType": "administrative", "elementType": "all", "stylers": [{"color": "#f2f2f2"}]},
        {"featureType": "administrative", "elementType": "labels.text.fill", "stylers": [{"color": "#686868"}, {"visibility": "on"}]},
        {"featureType": "landscape", "elementType": "all", "stylers": [{"color": "#f2f2f2"}]},
        {"featureType": "poi", "elementType": "all", "stylers": [{"visibility": "off"}]},
        {"featureType": "poi.park", "elementType": "all", "stylers": [{"visibility": "on"}]},
        {"featureType": "poi.park", "elementType": "labels.icon", "stylers": [{"visibility": "off"}]},
        {"featureType": "road", "elementType": "all", "stylers": [{"saturation": -100}, {"lightness": 45}]},
        {"featureType": "road.highway", "elementType": "all", "stylers": [{"visibility": "simplified"}]},
        {"featureType": "road.highway", "elementType": "geometry.fill", "stylers": [{"lightness": "-22"}, {"visibility": "on"}, {"color": "#b4b4b4"}]},
        {"featureType": "road.highway", "elementType": "geometry.stroke", "stylers": [{"saturation": "-51"}, {"lightness": "11"}]},
        {"featureType": "road.highway", "elementType": "labels.text", "stylers": [{"saturation": "3"}, {"lightness": "-56"}, {"visibility": "simplified"}]},
        {"featureType": "road.highway", "elementType": "labels.text.fill", "stylers": [{"lightness": "-52"}, {"color": "#9094a0"}, {"visibility": "simplified"}]},
        {"featureType": "road.highway", "elementType": "labels.text.stroke", "stylers": [{"weight": "6.13"}]},
        {"featureType": "road.highway", "elementType": "labels.icon", "stylers": [{"weight": "1.24"}, {"saturation": "-100"}, {"lightness": "-10"}, {"gamma": "0.94"}, {"visibility": "off"}]},
        {"featureType": "road.highway.controlled_access", "elementType": "geometry.fill", "stylers": [{"visibility": "on"}, {"color": "#b4b4b4"}, {"weight": "5.40"}, {"lightness": "7"}]},
        {"featureType": "road.highway.controlled_access", "elementType": "labels.text", "stylers": [{"visibility": "simplified"}, {"color": "#231f1f"}]},
        {"featureType": "road.highway.controlled_access", "elementType": "labels.text.fill", "stylers": [{"visibility": "simplified"}, {"color": "#595151"}]},
        {"featureType": "road.arterial", "elementType": "geometry", "stylers": [{"lightness": "-16"}]},
        {"featureType": "road.arterial", "elementType": "geometry.fill", "stylers": [{"visibility": "on"}, {"color": "#d7d7d7"}]},
        {"featureType": "road.arterial", "elementType": "labels.text", "stylers": [{"color": "#282626"}, {"visibility": "simplified"}]},
        {"featureType": "road.arterial", "elementType": "labels.text.fill", "stylers": [{"saturation": "-41"}, {"lightness": "-41"}, {"color": "#2a4592"}, {"visibility": "simplified"}]},
        {"featureType": "road.arterial", "elementType": "labels.text.stroke", "stylers": [{"weight": "1.10"}, {"color": "#ffffff"}]},
        {"featureType": "road.arterial", "elementType": "labels.icon", "stylers": [{"visibility": "on"}]},
        {"featureType": "road.local", "elementType": "geometry.fill", "stylers": [{"lightness": "-16"}, {"weight": "0.72"}]},
        {"featureType": "road.local", "elementType": "labels.text.fill", "stylers": [{"lightness": "-37"}, {"color": "#2a4592"}]},
        {"featureType": "transit", "elementType": "all", "stylers": [{"visibility": "off"}]},
        {"featureType": "transit.line", "elementType": "geometry.fill", "stylers": [{"visibility": "off"}, {"color": "#eeed6a"}]},
        {"featureType": "transit.line", "elementType": "geometry.stroke", "stylers": [{"visibility": "off"}, {"color": "#0a0808"}]},
        {"featureType": "water", "elementType": "all", "stylers": [{"color": "#b7e4f4"}, {"visibility": "on"}]}
    ];

    try {
        map = new google.maps.Map(mapDiv, {
            center: { lat: 46.5546, lng: 15.6459 },
            zoom: 14,
            minZoom: 12,
            maxZoom: 18,
            styles: mapStyles
        });
        console.log('Map initialized successfully with custom styles:', map);
    } catch (error) {
        console.error('Error initializing Google Maps:', error);
        return;
    }

    const vehicleFiles = [
        "G1plus", "G1minus", "G2minus", "G2plus", "G3minus", "G3plus", "G4minus", "G4plus",
        "G5minus", "G5plus", "G6minus", "G6plus", "P7minus", "P7plus", "P8minus", "P8plus",
        "P9minus", "P9plus", "P10minus", "P10plus", "P11minus", "P11plus", "P12minus", "P12plus",
        "P13minus", "P13plus", "P14minus", "P14plus", "P15minus", "P15plus", "P16minus", "P16plus",
        "P17minus", "P17plus", "P18minus", "P18plus"
    ];

    const vehiclesData = {}, stations = {};
    const timelineElements = ['time-slider', 'play-btn', 'stop-btn', 'reset-btn', 'time-display', 'speed-select']
        .map(id => document.getElementById(id));
    const [slider, playBtn, stopBtn, resetBtn, timeDisplay, speedSelect] = timelineElements;

    const sidebarButtons = ['select-all-btn', 'deselect-all-btn', 'select-plus-btn', 'deselect-plus-btn', 'select-minus-btn', 'deselect-minus-btn']
        .map(id => document.getElementById(id));
    const [selectAllBtn, deselectAllBtn, selectPlusBtn, deselectPlusBtn, selectMinusBtn, deselectMinusBtn] = sidebarButtons;

    if (timelineElements.some(el => !el) || sidebarButtons.some(el => !el)) {
        console.error('Missing DOM elements:', { timeline: timelineElements, sidebar: sidebarButtons });
        return;
    }

    let speed = parseFloat(speedSelect.value || 9);
    const baseDate = new Date('2025-02-24T00:00:00Z');
    const globalMinTime = baseDate.setUTCHours(4, 0, 0, 0);
    const globalMaxTime = baseDate.setUTCHours(23, 59, 0, 0);

    // Inicializiraj drsnik na 0 ob zagonu
    slider.value = 0;
    timeDisplay.textContent = new Date(globalMinTime).toLocaleTimeString();
    updateMarkers(); // Posodobi markerje ob zagonu

    speedSelect.onchange = () => {
        speed = parseFloat(speedSelect.value || 9);
        console.log('Speed updated:', speed);
    };

    function populateSidebar() {
        const vehicleList = document.getElementById('vehicle-list');
        if (!vehicleList) {
            console.error('Vehicle list not found!');
            return;
        }
        vehicleFiles.forEach(file => {
            const lineName = `Linija ${file}`;
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.textContent = lineName;
            button.id = lineName;
            button.onclick = () => toggleLine(lineName);
            li.appendChild(button);
            vehicleList.appendChild(li);
            vehiclesData[lineName] = { vehicles: {}, active: false };
        });
        console.log('Sidebar populated with buttons');
    }

    fetch('vozila_json/stations.json')
        .then(response => response.ok ? response.json() : Promise.reject(`Stations load failed: ${response.status}`))
        .then(data => {
            data.stations.forEach(station => {
                if (!station.lat || !station.lon || isNaN(station.lat) || isNaN(station.lon)) return;
                const marker = new google.maps.Marker({
                    position: { lat: station.lat, lng: station.lon },
                    map: map,
                    icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: 'red', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2, scale: 5 }
                });
                stations[station.ime] = marker;
                marker.addListener('click', () => {
                    const infoWindow = new google.maps.InfoWindow({ content: getStationSchedule(station.ime) });
                    infoWindow.open(map, marker);
                });
            });
            console.log('Stations loaded:', Object.keys(stations).length);
        })
        .catch(error => console.error('Error loading stations:', error));

    vehicleFiles.forEach(file => fetch(`vozila_json/${file}.json`)
        .then(response => response.ok ? response.json() : Promise.reject(`Failed to load ${file}.json: ${response.status}`))
        .then(data => {
            if (!data || !data.vehicles) return;
            const lineName = data.line;
            vehiclesData[lineName].vehicles = {};
            const lineColor = file.includes('plus') ? 'green' : 'red';

            data.vehicles.forEach(vehicle => {
                const path = vehicle.path
                    .filter(p => p.time && new Date(p.time).getTime() >= globalMinTime && new Date(p.time).getTime() <= globalMaxTime)
                    .map(p => ({
                        time: new Date(p.time).getTime(),
                        lat: p.lat,
                        lon: p.lon,
                        station: p.ime
                    }))
                    .sort((a, b) => a.time - b.time);

                if (path.length) {
                    vehiclesData[lineName].vehicles[vehicle.name] = {
                        path,
                        marker: new google.maps.Marker({
                            position: { lat: path[0].lat, lng: path[0].lon },
                            map: null,
                            icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: 'black', fillOpacity: 1, strokeColor: 'white', strokeWeight: 1, scale: 5 }
                        }),
                        label: new google.maps.Marker({
                            position: { lat: path[0].lat, lng: path[0].lon },
                            map: null,
                            label: { text: vehicle.name.split('-')[1], color: lineColor, fontSize: '14px', fontWeight: 'bold' }
                        })
                    };
                }
            });
            console.log(`Loaded ${file}:`, Object.keys(vehiclesData[lineName].vehicles).length, 'vehicles');
            updateMarkers(); // Posodobi markerje po nalaganju podatkov
        })
        .catch(error => console.error(`Error loading ${file}:`, error)));

    function toggleLine(lineName) {
        if (!vehiclesData[lineName]) {
            console.warn(`Line ${lineName} not yet initialized`);
            vehiclesData[lineName] = { vehicles: {}, active: false };
        }
        vehiclesData[lineName].active = !vehiclesData[lineName].active;
        const button = document.getElementById(lineName);
        if (button) {
            button.classList.toggle('active');
        }
        console.log(`Toggled ${lineName} to ${vehiclesData[lineName].active}`);
        updateMarkers();
    }

    selectAllBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            vehiclesData[line].active = true;
            const button = document.getElementById(line);
            if (button) button.classList.add('active');
        });
        updateMarkers();
        console.log('Selected all lines');
    };

    deselectAllBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            vehiclesData[line].active = false;
            const button = document.getElementById(line);
            if (button) button.classList.remove('active');
        });
        updateMarkers();
        console.log('Deselected all lines');
    };

    selectPlusBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            if (line.includes('plus')) {
                vehiclesData[line].active = true;
                const button = document.getElementById(line);
                if (button) button.classList.add('active');
            }
        });
        updateMarkers();
        console.log('Selected all plus lines');
    };

    deselectPlusBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            if (line.includes('plus')) {
                vehiclesData[line].active = false;
                const button = document.getElementById(line);
                if (button) button.classList.remove('active');
            }
        });
        updateMarkers();
        console.log('Deselected all plus lines');
    };

    selectMinusBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            if (line.includes('minus')) {
                vehiclesData[line].active = true;
                const button = document.getElementById(line);
                if (button) button.classList.add('active');
            }
        });
        updateMarkers();
        console.log('Selected all minus lines');
    };

    deselectMinusBtn.onclick = () => {
        Object.keys(vehiclesData).forEach(line => {
            if (line.includes('minus')) {
                vehiclesData[line].active = false;
                const button = document.getElementById(line);
                if (button) button.classList.remove('active');
            }
        });
        updateMarkers();
        console.log('Deselected all minus lines');
    };

    function getStationSchedule(stationName) {
        const sliderValue = parseFloat(slider.value);
        const currentTime = globalMinTime + (sliderValue / 100) * (globalMaxTime - globalMinTime);
        const timeWindow = 30 * 60 * 1000;
        const schedule = [];

        Object.entries(vehiclesData).forEach(([line, data]) => {
            if (!data.active) return;
            Object.entries(data.vehicles).forEach(([name, vehicle]) => {
                vehicle.path.forEach(point => {
                    if (point.station === stationName && Math.abs(point.time - currentTime) <= timeWindow) {
                        schedule.push({ vehicle: name, time: new Date(point.time).toLocaleTimeString() });
                    }
                });
            });
        });

        return `<b>${stationName}</b><br><ul>${schedule.sort((a, b) => a.time.localeCompare(b.time)).map(s => `<li>${s.vehicle} - ${s.time}</li>`).join('') || 'No vehicles nearby'}</ul>`;
    }

    function updateMarkers() {
        if (!map) {
            console.error('Map not available');
            return;
        }
        const sliderValue = parseFloat(slider.value);
        const currentTime = globalMinTime + (sliderValue / 100) * (globalMaxTime - globalMinTime);
        timeDisplay.textContent = new Date(currentTime).toLocaleTimeString();

        Object.entries(vehiclesData).forEach(([line, data]) => {
            if (!data.active) {
                Object.values(data.vehicles).forEach(v => {
                    v.marker.setMap(null);
                    v.label.setMap(null);
                });
            } else {
                Object.entries(data.vehicles).forEach(([name, vehicle]) => {
                    const currentPoint = vehicle.path.find(p => Math.abs(p.time - currentTime) < 5 * 60 * 1000) || 
                                        vehicle.path.reduce((prev, curr) => Math.abs(curr.time - currentTime) < Math.abs(prev.time - currentTime) ? curr : prev);
                    
                    const isActive = vehicle.path.some(p => Math.abs(p.time - currentTime) < 5 * 60 * 1000);
                    
                    if (isActive) {
                        vehicle.marker.setPosition({ lat: currentPoint.lat, lng: currentPoint.lon });
                        vehicle.marker.setMap(map);
                        vehicle.label.setPosition({ lat: currentPoint.lat, lng: currentPoint.lon });
                        vehicle.label.setMap(map);
                    } else {
                        vehicle.marker.setMap(null);
                        vehicle.label.setMap(null);
                    }
                });
            }
        });
    }

    slider.oninput = () => updateMarkers();

    function animate() {
        if (!isPlaying) {
            clearTimeout(animationTimeout);
            return;
        }
        const value = parseFloat(slider.value);
        if (value < 100) {
            slider.value = Math.min(value + (0.05 / speed), 100);
            updateMarkers();
            animationTimeout = setTimeout(animate, 50);
        } else {
            isPlaying = false;
            playBtn.textContent = "Predvajaj";
            clearTimeout(animationTimeout);
        }
    }

    playBtn.onclick = () => {
        console.log('Play clicked, isPlaying:', !isPlaying);
        if (!isPlaying) {
            // Če ni še igralo, inicializiraj na začetku
            if (parseFloat(slider.value) >= 100) {
                slider.value = 0; // Ponastavi na začetek, če je na koncu
            }
            updateMarkers(); // Posodobi markerje pred začetkom
        }
        isPlaying = !isPlaying;
        playBtn.textContent = isPlaying ? "Pavza" : "Predvajaj";
        if (isPlaying) animate();
    };

    stopBtn.onclick = () => {
        console.log('Stop clicked');
        isPlaying = false;
        playBtn.textContent = "Predvajaj";
        clearTimeout(animationTimeout);
    };

    resetBtn.onclick = () => {
        console.log('Reset clicked');
        slider.value = 0;
        isPlaying = false;
        playBtn.textContent = "Predvajaj";
        clearTimeout(animationTimeout);
        updateMarkers();
    };

    populateSidebar();
    setTimeout(updateMarkers, 500);
    console.log('initMap completed');
}

window.initMap = initMap;