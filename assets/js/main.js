// main.js - DRO Frontend Logic (IMO MEPC 82/6/38 Integration)
// Pastikan Leaflet.js sudah di-load di index.html untuk peta interaktif

// --- DATA STATIS (IMO, Spec, dsb) ---
const EMISSION_FACTORS = {
  // ton CO2/ton BBM (hanya CO2 dari pembakaran)
  LNG: 2.75,
  LSFO: 3.114,
};
const METHANE_SLIP_RATE_LNG = 0.01; // Asumsi 1% slip rate untuk LNG, dapat bervariasi tergantung teknologi mesin
const METHANE_GWP_100_YEAR = 28; // GWP untuk CH4 selama 100 tahun (IPCC AR6 lebih umum menggunakan 28 atau 29.8)

const avgFuelPerNM = { LSFO: 0.1, LNG: 0.05 }; // ton/nm (IMO Table 2, estimasi tanker 40,000 DWT)
const shipSpecs = { name: "Amaryllis VLGC", DWT: 40000, ESD: "Flettner" };
const CII_BENCHMARK = 3.88; // g CO2/ton-mile (IMO Table 3, tanker)
const WAVE_HEIGHT_THRESHOLD_HIGH = 3; // meter, batas untuk ombak tinggi
const WAVE_AREA_RADIUS_METERS = 80000; // meter, radius visualisasi area ombak
const OPTIMAL_ROUTE_SPEED_REDUCTION_FACTOR = 0.9; // Pengurangan kecepatan 10% untuk rute optimal
// const WEATHER_API_KEY = 'caf767a6bd36486caea10517250106'; // API Key Anda (dinonaktifkan untuk simulasi paksa)

// Data hambatan statis yang dipaksakan untuk setiap port tujuan (indeks array = portIdx)
// Format: { height: TinggiGelombangMeter, customShiftMagnitude?: number }.
// Tinggi gelombang diatur > WAVE_HEIGHT_THRESHOLD_HIGH untuk memicu deviasi.
const FORCED_OBSTACLES_BY_PORT_INDEX = [
  { height: 4.5 }, // 0: Port of Singapore (default shift)
  { height: 5.0, customShiftMagnitude: 1.2 }, // 1: Port of Rotterdam
  { height: 4.8, customShiftMagnitude: 1.2 }, // 2: Port of Shanghai
  { height: 4.7 }, // 3: Port of Busan (default shift)
  { height: 5.2, customShiftMagnitude: 1.8 }, // 4: Port of Los Angeles (trans-pacific, larger shift)
  { height: 4.6 }, // 5: Port of Jebel Ali (default shift)
  { height: 5.1, customShiftMagnitude: 1.2 }, // 6: Port of Hamburg
];

// --- DATA DINAMIS ---
let userPosition = null;
let ports = [];
let waveData = [];
// let map = null;
let shipMarker = null;
let portMarker = null;
let normalRouteLine = null;
let optimalRouteLine = null;
let waveLayer = null;

// --- INIT ---
document.addEventListener("DOMContentLoaded", async function () {
  await loadPorts();
  // await loadWaveData(); // Kita akan fetch data ombak secara dinamis per kalkulasi
  initMap();
  setupEventListeners();
  updateDashboardPlaceholder();
});

// --- LOAD DATA ---
async function loadPorts() {
  const res = await fetch("assets/data/ports.json");
  ports = await res.json();
  const select = document.getElementById("port-select");
  select.innerHTML = "";
  ports.forEach((port, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = port.name;
    select.appendChild(opt);
  });
}

// async function loadWaveData() { // Fungsi ini tidak lagi digunakan jika kita fetch dari API
//     const res = await fetch('assets/data/wave_data.json');
//     waveData = await res.json();
// }

// Fungsi getForcedObstacleForPort tidak lagi digunakan, logika dipindahkan ke calculateRoute

// Fungsi fetchWaveDataForRoute tidak lagi dipanggil secara default jika simulasi paksa aktif.
// Bisa diaktifkan kembali jika diperlukan dengan menghapus komentar dan menyesuaikan logika di calculateRoute.
/*
async function fetchWaveDataForRoute(routePoints) {
    if (!routePoints || routePoints.length < 2) {
        console.warn("Tidak cukup titik untuk mengambil data ombak.");
        return [];
    }
    const midPointIndex = Math.floor(routePoints.length / 2);
    const lat = routePoints[midPointIndex][0];
    const lon = routePoints[midPointIndex][1];

    const apiUrl = `https://api.weatherapi.com/v1/marine.json?key=${WEATHER_API_KEY}&q=${lat.toFixed(4)},${lon.toFixed(4)}&days=1`;

    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`Error fetching wave data from WeatherAPI: ${response.status} ${response.statusText}`);
            const errorData = await response.json();
            console.error("API Error Details:", errorData);
            return [];
        }
        const data = await response.json();

        if (!(data && data.forecast && data.forecast.forecastday && data.forecast.forecastday.length > 0 && data.forecast.forecastday[0].hour)) {
            console.warn("WeatherAPI response format is missing expected forecast structure (data.forecast.forecastday[0].hour). Full response:", data);
            return [];
        }

        const hourlyData = data.forecast.forecastday[0].hour;
        const rawWaveHeights = hourlyData.map(h => h.wave_hm);
        const waveHeights = rawWaveHeights.filter(h => typeof h === 'number' && h !== null && !isNaN(h));

        if (waveHeights.length > 0) {
            const maxHeight = Math.max(...waveHeights);
            return [{ lat: lat, lon: lon, height: maxHeight }];
        } else {
            console.warn(`No valid numeric wave height data (wave_hm) found in the hourly forecast for lat: ${lat.toFixed(4)}, lon: ${lon.toFixed(4)}. Raw wave_hm values might be null or non-numeric. Raw values sample:`, rawWaveHeights.slice(0,10));
            return [];
        }
    } catch (error) {
        console.error("Gagal mengambil atau memproses data ombak dari WeatherAPI:", error);
        return [];
    }
}
*/

// --- MAP ---
function initMap() {
  const mapDiv = document.getElementById("map");
  if (!mapDiv) {
    console.error("Elemen #map tidak ditemukan di halaman (main.js)!");
    return;
  }
  if (typeof L === "undefined") {
    console.error("Leaflet library not loaded (main.js)!");
    mapDiv.innerHTML =
      '<div style="color:#888;text-align:center;margin-top:40px;">[Peta membutuhkan Leaflet.js]</div>';
    return;
  }

  // Bersihkan map instance sebelumnya jika ada (konsisten dengan map.js)
  if (window.map && window.map.remove) {
    window.map.remove();
    window.map = null;
  }

  try {
    window.map = L.map("map").setView([-6.12, 106.87], 5); // Assign to window.map
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      errorTileUrl: "", // Tambahkan errorTileUrl untuk konsistensi
    }).addTo(window.map);
    console.log("Map successfully initialized from main.js:", window.map);
  } catch (error) {
    console.error("Map initialization failed (main.js):", error);
    mapDiv.innerHTML =
      '<div style="color:red;padding:20px;text-align:center;">ERROR (main.js): ' +
      error.message +
      "</div>";
  }
}

function updateMap(lat, lng) {
  if (!window.map) return;
  if (shipMarker) window.map.removeLayer(shipMarker);
  shipMarker = L.marker([lat, lng], { icon: blueIcon() }).addTo(window.map);
  window.map.setView([lat, lng], 7);
}

function updatePortMarker(lat, lng) {
  if (!window.map) return;
  if (portMarker) window.map.removeLayer(portMarker);
  portMarker = L.marker([lat, lng], { icon: redIcon() }).addTo(window.map);
}

function drawRoute(route, color) {
  if (!window.map) return null;

  // Remove existing route if any
  if (color === "black" && normalRouteLine)
    window.map.removeLayer(normalRouteLine);
  if (color === "green" && optimalRouteLine)
    window.map.removeLayer(optimalRouteLine);

  const polyline = L.polyline(route, {
    color: color,
    weight: 4,
    opacity: 0.8,
  }).addTo(window.map);

  // Add snake animation
  // Ensure the snakeIn method is available from the plugin
  if (typeof polyline.snakeIn === "function") {
    polyline.snakeIn({
      duration: 3000, // Animation duration in ms
      delay: 200, // Delay before animation starts
    });
  } else {
    console.warn(
      "L.Polyline.SnakeAnim plugin or snakeIn method not found. Drawing route without snake animation."
    );
  }

  // Store reference
  if (color === "black") normalRouteLine = polyline;
  if (color === "green") optimalRouteLine = polyline;

  return polyline;
}

function clearRoutes() {
  if (normalRouteLine) window.map.removeLayer(normalRouteLine);
  if (optimalRouteLine) window.map.removeLayer(optimalRouteLine);
}

function drawWaveAreas() {
  if (!window.map) return;
  if (waveLayer) window.map.removeLayer(waveLayer);
  waveLayer = L.layerGroup();
  waveData.forEach((w) => {
    if (w.height > WAVE_HEIGHT_THRESHOLD_HIGH) {
      const circle = L.circle([w.lat, w.lon], {
        color: "#e74c3c",
        fillColor: "#e74c3c",
        fillOpacity: 0.25,
        radius: WAVE_AREA_RADIUS_METERS,
      });
      waveLayer.addLayer(circle);
    }
  });
  waveLayer.addTo(window.map);
}

// --- EVENT HANDLERS ---
function setupEventListeners() {
  const gpsBtn = document.getElementById("gps-btn");
  const gpsBtnText = document.getElementById("gps-btn-text");
  const gpsBtnLoading = document.getElementById("gps-btn-loading");
  const gpsBtnActive = document.getElementById("gps-btn-active");
  const gpsStatusPanel = document.getElementById("gps-status-panel");
  const gpsStatus = document.getElementById("gps-status");
  const gpsCoord = document.getElementById("gps-coord");

  // Reset awal
  gpsStatusPanel.style.display = "none";
  gpsBtn.className = "gps-inactive";
  gpsBtnText.style.display = "";
  gpsBtnLoading.style.display = "none";
  gpsBtnActive.style.display = "none";

  gpsBtn.onclick = function () {
    if (!navigator.geolocation) {
      alert("Geolocation tidak didukung browser ini.");
      return;
    }
    // Loading state
    gpsBtn.className = "gps-loading";
    gpsBtnText.textContent = "Activating...";
    gpsBtnLoading.style.display = "";
    gpsBtnActive.style.display = "none";
    gpsStatusPanel.style.display = "none";
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        userPosition = { lat: latitude, lng: longitude };
        // Reverse geocoding untuk nama lokasi
        let locationName = "";
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}`
          );
          const data = await res.json();
          if (data && data.display_name) {
            locationName = ` (${data.display_name})`;
          }
        } catch (e) {
          locationName = "";
        }
        gpsStatusPanel.style.display = "";
        gpsStatus.textContent = "Detected";
        gpsCoord.textContent = `[${latitude.toFixed(4)}, ${longitude.toFixed(
          4
        )}]${locationName}`;
        updateMap(latitude, longitude);
        // Aktif state
        gpsBtn.className = "gps-active";
        gpsBtnText.textContent = "GPS Active";
        gpsBtnLoading.style.display = "none";
        gpsBtnActive.style.display = "";
      },
      () => {
        gpsStatusPanel.style.display = "";
        gpsStatus.textContent = "Failed";
        gpsCoord.textContent = "";
        gpsBtn.className = "gps-inactive";
        gpsBtnText.textContent = "Enable GPS";
        gpsBtnLoading.style.display = "none";
        gpsBtnActive.style.display = "none";
      }
    );
  };

  document.getElementById("port-select").onchange = function () {
    const idx = parseInt(this.value, 10); // Konversi ke integer
    const port = ports[idx];
    if (port) {
      updatePortMarker(port.lat, port.lon);
    } else {
      console.error(
        `Port data not found for index: ${idx} in onchange handler.`
      );
      // Opsional: Bersihkan marker pelabuhan jika data tidak valid
      if (portMarker) window.map.removeLayer(portMarker);
    }
  };

  // Speed slider bubble (modern)
  const speedSlider = document.getElementById("speed-slider");
  const speedDisplay = document.createElement("div");
  speedDisplay.className = "speed-value-display";
  speedSlider.parentNode.appendChild(speedDisplay);
  function setSpeedBubble(val) {
    speedDisplay.textContent = `${val} knot`;
    const min = +speedSlider.min;
    const max = +speedSlider.max;
    const percent = (val - min) / (max - min);
    speedDisplay.style.left = `calc(${percent * 100}% - 24px)`;
  }
  speedSlider.addEventListener("input", function () {
    setSpeedBubble(this.value);
  });
  setSpeedBubble(speedSlider.value);

  // Fuel mode radio & slider
  const fuelModeLNG = document.getElementById("fuel-mode-lng");
  const fuelModeLSFO = document.getElementById("fuel-mode-lsfo");
  const fuelSlider = document.getElementById("fuel-slider");
  const fuelSliderValue = document.getElementById("fuel-slider-value");
  // Dual slider logic for LNG/LSFO
  const fuelSliderGroupLNG = document.getElementById("fuel-slider-group-lng");
  const fuelSliderGroupLSFO = document.getElementById("fuel-slider-group-lsfo");
  const fuelSliderLNG = document.getElementById("fuel-slider-lng");
  const fuelSliderLSFO = document.getElementById("fuel-slider-lsfo");
  const fuelSliderValueLNG = document.getElementById("fuel-slider-value-lng");
  const fuelSliderValueLSFO = document.getElementById("fuel-slider-value-lsfo");
  const fuelNoteLNG = document.getElementById("fuel-note-lng");
  const fuelNoteLSFO = document.getElementById("fuel-note-lsfo");

  function updateFuelSliderState() {
    if (fuelModeLNG.checked) {
      fuelSliderGroupLNG.style.display = "";
      fuelSliderGroupLSFO.style.display = "none";
      fuelNoteLNG.style.display = "";
      fuelNoteLSFO.style.display = "none";
    } else {
      fuelSliderGroupLNG.style.display = "none";
      fuelSliderGroupLSFO.style.display = "";
      fuelNoteLNG.style.display = "none";
      fuelNoteLSFO.style.display = "";
    }
  }
  fuelModeLNG.onchange = updateFuelSliderState;
  fuelModeLSFO.onchange = updateFuelSliderState;
  fuelSliderLNG.oninput = function () {
    fuelSliderValueLNG.textContent = this.value + "%";
  };
  fuelSliderLSFO.oninput = function () {
    fuelSliderValueLSFO.textContent = this.value + "%";
  };
  updateFuelSliderState();

  document.getElementById("route-form").onsubmit = function (e) {
    e.preventDefault();
    calculateRoute();
  };

  // Back to Map button
  const backToMapBtn = document.getElementById("back-to-map-btn");
  if (backToMapBtn) {
    backToMapBtn.onclick = function () {
      document
        .querySelector(".map-panel")
        .scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
}

// --- ROUTE & AI LOGIC ---
async function calculateRoute() {
  if (!userPosition) {
    alert("Aktifkan GPS terlebih dahulu.");
    return;
  }
  // Visualisasi loading pada tombol dan dashboard
  const calcBtn = document.getElementById("calculate-btn");
  calcBtn.disabled = true;
  calcBtn.innerHTML =
    '<span class="gps-loading" style="display:inline-block;vertical-align:middle;"></span> Calculating...';
  const dashboardSection = document.querySelector(".dashboard");
  dashboardSection.classList.add("dashboard-loading");
  // Ambil input user
  const portIdxString = document.getElementById("port-select").value;
  const portIdx = parseInt(portIdxString, 10); // Konversi ke integer

  const port = ports[portIdx];
  if (!port) {
    throw new Error(`Data pelabuhan tidak ditemukan untuk indeks ${portIdx}.`);
  }
  const speed = parseFloat(document.getElementById("speed-slider").value);
  const fuelModeLNGChecked = document.getElementById("fuel-mode-lng").checked;
  let LNG_percent = 0,
    LSFO_percent = 0;
  if (fuelModeLNGChecked) {
    LNG_percent = parseInt(document.getElementById("fuel-slider-lng").value);
    LSFO_percent = 100 - LNG_percent;
  } else {
    LSFO_percent = parseInt(document.getElementById("fuel-slider-lsfo").value);
    LNG_percent = 100 - LSFO_percent;
  }
  const LNG_ratio = LNG_percent / 100;
  const LSFO_ratio = LSFO_percent / 100;
  // 1. Normal route: garis lurus (great circle, laut)

  let normalRoute = [
    [userPosition.lat, userPosition.lng],
    [port.lat, port.lon],
  ];

  // --- Penentuan Posisi Badai (Forced Obstacle) ---
  // Tujuannya: Garis normal (hitam) berada di antara garis optimal (hijau) dan badai.
  // 1. Tentukan titik dasar badai (tengah rute normal).
  const p0_normal_for_storm = normalRoute[0];
  const pN_normal_for_storm = normalRoute[normalRoute.length - 1]; // Gunakan titik akhir aktual dari normalRoute
  const storm_base_lat = (p0_normal_for_storm[0] + pN_normal_for_storm[0]) / 2;
  const storm_base_lon = (p0_normal_for_storm[1] + pN_normal_for_storm[1]) / 2;

  // Tentukan besaran pergeseran. Default 0.5, bisa di-override per port.
  let waveAvoidanceShiftMagnitude = 0.5; // Default shift magnitude
  const obstacleConfig = FORCED_OBSTACLES_BY_PORT_INDEX[portIdx];
  if (
    obstacleConfig &&
    typeof obstacleConfig.customShiftMagnitude === "number"
  ) {
    waveAvoidanceShiftMagnitude = obstacleConfig.customShiftMagnitude;
    const portNameForLog = ports[portIdx]
      ? ports[portIdx].name
      : `Index ${portIdx}`;
    console.log(
      `SIMULASI: Menggunakan custom shift magnitude ${waveAvoidanceShiftMagnitude} untuk ${portNameForLog}`
    );
  }

  // 2. Hitung vektor deviasi yang AKAN digunakan oleh rute optimal.
  //    Variabel waveAvoidanceShiftMagnitude yang sudah ditentukan di atas akan digunakan.
  const dx_route_vec = pN_normal_for_storm[1] - p0_normal_for_storm[1]; // Perubahan longitude
  const dy_route_vec = pN_normal_for_storm[0] - p0_normal_for_storm[0]; // Perubahan latitude
  const routeLength_for_dev = Math.sqrt(
    dx_route_vec * dx_route_vec + dy_route_vec * dy_route_vec
  );

  let optimal_dev_lat_component = waveAvoidanceShiftMagnitude; // Default jika routeLength sangat kecil
  let optimal_dev_lon_component = waveAvoidanceShiftMagnitude; // Default jika routeLength sangat kecil

  if (routeLength_for_dev > 0.001) {
    // Vektor deviasi tegak lurus untuk rute optimal (komponen untuk latitude dan longitude)
    optimal_dev_lat_component =
      (-dy_route_vec / routeLength_for_dev) * waveAvoidanceShiftMagnitude;
    optimal_dev_lon_component =
      (dx_route_vec / routeLength_for_dev) * waveAvoidanceShiftMagnitude;
  }

  // 3. Posisikan badai dengan menggeser titik dasar ke arah BERLAWANAN dari deviasi rute optimal.
  const storm_actual_lat = storm_base_lat - optimal_dev_lat_component;
  const storm_actual_lon = storm_base_lon - optimal_dev_lon_component;

  // Gunakan obstacleConfig yang sudah diambil sebelumnya untuk mendapatkan height
  if (obstacleConfig) {
    waveData = [
      {
        lat: storm_actual_lat,
        lon: storm_actual_lon,
        height: obstacleConfig.height,
      },
    ];
    const portName = ports[portIdx]
      ? ports[portIdx].name
      : `Port Index ${portIdx}`;
    console.log(
      `SIMULASI: Badai diposisikan untuk ${portName} di: Lat=${storm_actual_lat.toFixed(
        2
      )}, Lon=${storm_actual_lon.toFixed(2)}, Height=${
        obstacleConfig.height
      }m (Shift Mag: ${waveAvoidanceShiftMagnitude})`
    );
  } else {
    waveData = []; // Kosongkan jika tidak ada definisi
    console.warn(
      `SIMULASI: Tidak ada definisi hambatan paksa untuk port index: ${portIdx}.`
    );
  }
  // Jika ingin kembali menggunakan API, komentari blok penentuan posisi badai di atas dan aktifkan baris di bawah:
  // waveData = await fetchWaveDataForRoute([[userPosition.lat, userPosition.lng], [port.lat, port.lon]]);

  // Deteksi rute menabrak daratan (manual, contoh Indonesia)
  // Jika lintasan antara dua titik menabrak pulau besar, tambahkan waypoint di laut
  // Contoh: waypoint di Selat Sunda (antara Sumatera dan Jawa)
  // Fungsi ini sekarang lebih spesifik untuk rute yang relevan melintasi Selat Sunda.
  function needsSundaStraitWaypoint(start, destinationPort) {
    // Hanya relevan jika GPS awal di sekitar Indonesia/Asia Tenggara
    // dan tujuan adalah pelabuhan yang logis melewati Selat Sunda dari sana.
    const isStartNearSunda =
      start[0] > -8 && start[0] < 2 && start[1] > 100 && start[1] < 110; // Perkiraan area

    // Pelabuhan yang mungkin memerlukan waypoint Selat Sunda dari area tersebut
    // (misalnya, jika dari utara Sumatera ke Australia, atau dari Laut Jawa ke Samudra Hindia)
    // Untuk daftar port saat ini, ini mungkin kurang relevan kecuali GPS awal sangat spesifik.
    // Kita akan buat lebih konservatif: hanya jika tujuan BUKAN Eropa/Amerika.
    const isDestinationNotEuropeOrAmerica = ![
      "Port of Rotterdam, Netherlands",
      "Port of Los Angeles, USA",
      "Port of Hamburg, Germany",
    ].includes(destinationPort.name);

    // Kondisi dasar untuk melintasi area Selat Sunda (kasar)
    const crossesSundaArea =
      (start[1] < 105.5 &&
        destinationPort.lon > 106.5 &&
        destinationPort.lat < 0) || // Dari Barat ke Timur, selatan khatulistiwa
      (start[1] > 106.5 &&
        destinationPort.lon < 105.5 &&
        destinationPort.lat < 0); // Dari Timur ke Barat, selatan khatulistiwa

    return (
      isStartNearSunda && isDestinationNotEuropeOrAmerica && crossesSundaArea
    );
  }

  if (needsSundaStraitWaypoint(userPosition, port)) {
    console.log(
      "SIMULASI: Menambahkan waypoint Selat Sunda untuk rute normal."
    );
    normalRoute.splice(1, 0, [-5.95, 105.95]); // Sisipkan waypoint
  }
  // 2. Rute optimal: waypoint laut (hindari ombak tinggi)
  let optimalRoute = normalRoute.slice();
  let deviatedForWaves = false; // Flag untuk menandai jika rute diubah karena ombak

  // Logika untuk mengubah rute optimal berdasarkan data ombak dari API
  // fetchWaveDataForRoute saat ini mengembalikan array dengan maksimal satu elemen
  // yang merepresentasikan kondisi ombak di titik tengah rute.
  if (waveData.length > 0) {
    const w = waveData[0]; // Ambil data ombak representatif
    if (w.height > WAVE_HEIGHT_THRESHOLD_HIGH) {
      console.log(
        `High waves detected (height: ${
          w.height
        }m) at representative point [${w.lat.toFixed(2)}, ${w.lon.toFixed(
          2
        )}]. Deviating optimal route.`
      );

      const p0 = normalRoute[0]; // Titik awal rute normal
      const pN = normalRoute[normalRoute.length - 1]; // Titik akhir rute normal

      // Hitung vektor arah rute normal
      const dx_route = pN[1] - p0[1]; // Perbedaan longitude
      const dy_route = pN[0] - p0[0]; // Perbedaan latitude
      const routeLength = Math.sqrt(dx_route * dx_route + dy_route * dy_route);

      // Besaran pergeseran untuk menghindari ombak
      // Gunakan waveAvoidanceShiftMagnitude yang sudah ditentukan di awal fungsi calculateRoute

      let perp_dx_offset = waveAvoidanceShiftMagnitude;
      let perp_dy_offset = waveAvoidanceShiftMagnitude;

      if (routeLength > 0.001) {
        // Hindari pembagian dengan nol
        // Vektor unit tegak lurus: (-dy_route/routeLength, dx_route/routeLength)
        perp_dx_offset =
          (-dy_route / routeLength) * waveAvoidanceShiftMagnitude;
        perp_dy_offset = (dx_route / routeLength) * waveAvoidanceShiftMagnitude;
      }

      // Buat deviasi melengkung menggunakan dua titik offset dari titik ombak (w.lat, w.lon)
      // Titik w.lat, w.lon adalah titik tengah rute tempat ombak tinggi terdeteksi.
      // Kita akan membuat lengkungan "di sekitar" titik ini.
      // Titik 1: Sedikit sebelum titik ombak (relatif terhadap arah rute), di-offset
      const p_before_wave_lat = p0[0] + dy_route * 0.4; // Kira-kira 40% jalan
      const p_before_wave_lon = p0[1] + dx_route * 0.4;
      const dev_wp1_lat = p_before_wave_lat + perp_dx_offset;
      const dev_wp1_lon = p_before_wave_lon + perp_dy_offset;

      // Titik 2: Sedikit setelah titik ombak (relatif terhadap arah rute), di-offset
      const p_after_wave_lat = p0[0] + dy_route * 0.6; // Kira-kira 60% jalan
      const p_after_wave_lon = p0[1] + dx_route * 0.6;
      const dev_wp2_lat = p_after_wave_lat + perp_dx_offset;
      const dev_wp2_lon = p_after_wave_lon + perp_dy_offset;

      optimalRoute = [
        p0,
        [dev_wp1_lat, dev_wp1_lon],
        [dev_wp2_lat, dev_wp2_lon],
        pN,
      ];
      deviatedForWaves = true;
    }
  }

  // --- Kalkulasi jarak (laut, bukan darat) ---
  function routeDistance(route) {
    let dist = 0;
    for (let i = 1; i < route.length; i++) {
      dist += haversine(...route[i - 1], ...route[i]);
    }
    return dist;
  }
  const distNormal = routeDistance(normalRoute);
  const distOptimal = routeDistance(optimalRoute);
  const speedExponent = 2.8; // Eksponen empiris konsumsi BBM kapal
  const speedRef = 14; // Kecepatan referensi (knot)
  const recommendedSpeed = speed * OPTIMAL_ROUTE_SPEED_REDUCTION_FACTOR;
  const speedFactor = Math.pow(speed / speedRef, speedExponent);
  const speedFactorOptimal = Math.pow(
    recommendedSpeed / speedRef,
    speedExponent
  );
  // --- Estimasi konsumsi BBM (ton) ---
  // Rumus: konsumsi per NM * jarak * rasio * speed factor eksponensial
  const LNG_normal = avgFuelPerNM.LNG * distNormal * LNG_ratio * speedFactor;
  const LSFO_normal = avgFuelPerNM.LSFO * distNormal * LSFO_ratio * speedFactor;
  const LNG_opt =
    avgFuelPerNM.LNG * distOptimal * LNG_ratio * speedFactorOptimal;
  const LSFO_opt =
    avgFuelPerNM.LSFO * distOptimal * LSFO_ratio * speedFactorOptimal;
  // --- Speed factor (pengaruh kecepatan kapal) ---
  // const speedFactor = 1 + (Math.abs(speed - 14) * 0.05);
  // const recommendedSpeed = speed * 0.9;
  // const speedFactorOptimal = 1 + (Math.abs(recommendedSpeed - 14) * 0.05);
  // // --- Estimasi konsumsi BBM (ton) ---
  // const LNG_normal = avgFuelPerNM.LNG * distNormal * LNG_ratio * speedFactor;
  // const LSFO_normal = avgFuelPerNM.LSFO * distNormal * LSFO_ratio * speedFactor;
  // const LNG_opt = avgFuelPerNM.LNG * distOptimal * LNG_ratio * speedFactorOptimal;
  // const LSFO_opt = avgFuelPerNM.LSFO * distOptimal * LSFO_ratio * speedFactorOptimal;
  // --- Kalkulasi emisi ---
  const emisNormal = calculateEmissions(LNG_normal, LSFO_normal);
  const emisOptimal = calculateEmissions(LNG_opt, LSFO_opt);
  // --- Kalkulasi CII ---
  const ciiNormalVal = validateCII(emisNormal, shipSpecs.DWT, distNormal);
  const ciiOptimalVal = validateCII(emisOptimal, shipSpecs.DWT, distOptimal);
  // --- Tinggi ombak ---
  const waveNormal = getWaveHeightOnRoute(normalRoute);
  const waveOptimal = getWaveHeightOnRoute(optimalRoute);

  // --- Visualisasi ---
  // Show loading state for routes on the map
  const mapDiv = document.getElementById("map");
  if (mapDiv) {
    // Ensure mapDiv exists
    mapDiv.classList.add("route-loading");
  }

  // Clear existing routes before drawing new ones
  clearRoutes();

  // Draw routes with animation
  normalRouteLine = drawRoute(normalRoute, "black");
  optimalRouteLine = drawRoute(optimalRoute, "green");

  // Remove loading state when animation is likely done and draw wave areas
  const SNAKE_ANIM_DURATION = 3000; // As defined in drawRoute's snakeIn options
  const SNAKE_ANIM_DELAY = 200; // As defined in drawRoute's snakeIn options
  const totalAnimationTimeForOneRoute = SNAKE_ANIM_DURATION + SNAKE_ANIM_DELAY;

  setTimeout(() => {
    if (mapDiv) mapDiv.classList.remove("route-loading");
    drawWaveAreas(); // Draw wave areas after routes are drawn
  }, totalAnimationTimeForOneRoute + 500); // Add a 500ms buffer

  // --- Dashboard ---
  try {
    await new Promise((r) => setTimeout(r, 800)); // Simulasi loading
    // Pastikan rute optimal selalu berbeda dari normal
    // Jika rute TIDAK diubah karena ombak DAN masih sama dengan rute normal, buat perbedaan visual.
    if (
      !deviatedForWaves &&
      JSON.stringify(optimalRoute) === JSON.stringify(normalRoute)
    ) {
      // Jika rute optimal masih sama dengan normal (misalnya tidak ada ombak yang dihindari),
      // buat sedikit deviasi agar berbeda secara visual dan untuk kalkulasi.
      // Buat deviasi melengkung menggunakan dua titik offset yang tegak lurus dari rute normal.
      const p0 = normalRoute[0];
      const pN = normalRoute[normalRoute.length - 1];

      const dx = pN[1] - p0[1]; // Perbedaan longitude
      const dy = pN[0] - p0[0]; // Perbedaan latitude
      const length = Math.sqrt(dx * dx + dy * dy);
      const shiftMagnitude = 0.2; // Besaran pergeseran (derajat), bisa disesuaikan

      let perp_dx = shiftMagnitude; // Fallback default
      let perp_dy = shiftMagnitude; // Fallback default

      if (length > 0.001) {
        // Hindari pembagian dengan nol jika titik awal dan akhir sangat dekat/sama
        // Vektor unit tegak lurus: (-dy/length, dx/length)
        perp_dx = (-dy / length) * shiftMagnitude;
        perp_dy = (dx / length) * shiftMagnitude;
      }

      // Titik 1/3 dan 2/3 sepanjang rute normal, di-offset secara tegak lurus
      const p1_3_lat = p0[0] + dy * (1 / 3) + perp_dx;
      const p1_3_lon = p0[1] + dx * (1 / 3) + perp_dy;

      const p2_3_lat = p0[0] + dy * (2 / 3) + perp_dx;
      const p2_3_lon = p0[1] + dx * (2 / 3) + perp_dy;

      optimalRoute = [p0, [p1_3_lat, p1_3_lon], [p2_3_lat, p2_3_lon], pN];
      console.log(
        "Waypoint tambahan (melengkung) ditambahkan untuk membedakan rute optimal dari normal."
      );
    }
    let optRoute = optimalRoute; // Gunakan optimalRoute yang mungkin sudah diubah
    // Hitung waktu tempuh (jam)
    const hoursNormal = distNormal / speed;
    const hoursOptimal = distOptimal / recommendedSpeed;
    // Pembaruan textContent untuk waktu tempuh dan kecepatan akan ditangani oleh updateDashboard.

    updateDashboard({
      distNormal,
      distOptimal,
      emisNormal,
      emisOptimal,
      ciiNormal: ciiNormalVal,
      ciiOptimal: ciiOptimalVal,
      waveNormal,
      waveOptimal,
      LNG_normal,
      LSFO_normal,
      LNG_opt,
      LSFO_opt,
      portName: port.name,
      userPos: userPosition,
      optimalRoute: optRoute,
      speed,
      recommendedSpeed,
      hoursNormal,
      hoursOptimal,
    });
    // --- Simpan ke localStorage ---
    saveUserInput({
      gps: userPosition,
      port: port.name,
      speed,
      fuel: fuelModeLNGChecked ? "LNG" : "LSFO",
      LNG_percent,
      LSFO_percent,
    });
    // --- Dummy API endpoint (future) ---
    // fetch('/simulate', { method: 'POST', body: JSON.stringify({ ... }) });
    // Scroll ke dashboard dengan smooth
    dashboardSection.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    alert("Terjadi error saat kalkulasi: " + err);
    console.error(err);
  }
  if (dashboardSection) dashboardSection.classList.remove("dashboard-loading"); // Check if dashboardSection exists
  calcBtn.disabled = false;
  calcBtn.innerHTML = "Hitung";
}

// --- UTILITIES ---
function isPointNearLine(point, line) {
  const NEAR_LINE_THRESHOLD_DEGREES = 1.5; // Ambang batas kedekatan (dalam derajat)
  // Cek jika point (lat,lon) dekat dengan garis line (array koordinat)
  // Sederhana: jika jarak ke segmen < 1.5 derajat
  const [a, b] = line;
  const d =
    Math.abs(
      (b[1] - a[1]) * (a[0] - point[0]) - (b[0] - a[0]) * (a[1] - point[1])
    ) / Math.sqrt(Math.pow(b[1] - a[1], 2) + Math.pow(b[0] - a[0], 2));
  return d < NEAR_LINE_THRESHOLD_DEGREES;
}

function getWaveHeightOnRoute(route) {
  // Ambil ombak tertinggi di sepanjang rute
  let maxH = 0;
  waveData.forEach((w) => {
    if (isPointNearLine([w.lat, w.lon], route)) {
      if (w.height > maxH) maxH = w.height;
    }
  });
  return maxH;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3440; // Radius bumi dalam nm
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function calculateEmissions(LNG_amt, LSFO_amt) {
  const co2FromLNG = LNG_amt * EMISSION_FACTORS.LNG;
  const co2FromLSFO = LSFO_amt * EMISSION_FACTORS.LSFO;
  const methaneEmissionCO2e =
    LNG_amt * METHANE_SLIP_RATE_LNG * METHANE_GWP_100_YEAR; // Emisi CH4 dikonversi ke CO2e
  return co2FromLNG + co2FromLSFO + methaneEmissionCO2e;
}

function validateCII(emissionCO2e, DWT, distance) {
  const cii = (emissionCO2e * 1e6) / (DWT * distance); // g/ton-mile
  let rating = "D";
  if (cii < 3.88) rating = "C";
  if (cii < 3.0) rating = "B";
  if (cii < 2.0) rating = "A";
  return `${rating} (${cii.toFixed(2)})`;
}

function formatTravelTime(hours) {
  const days = Math.floor(hours / 24);
  const remainingHours = Math.round(hours % 24);
  return `${days}d ${remainingHours}h`;
}

function updateDashboard({
  distNormal,
  distOptimal,
  emisNormal,
  emisOptimal,
  ciiNormal,
  ciiOptimal,
  waveNormal,
  waveOptimal,
  LNG_normal,
  LSFO_normal,
  LNG_opt,
  LSFO_opt,
  portName,
  userPos,
  optimalRoute,
  speed,
  recommendedSpeed,
  hoursNormal,
  hoursOptimal,
}) {
  const table = document.getElementById("dashboard-tbody");
  // Delta waktu tempuh
  function deltaTime(a, b) {
    const d = b - a;
    const pct = a !== 0 ? (d / a) * 100 : 0; // Hindari pembagian dengan nol
    return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"; // >= 0 untuk +0.0%
  }
  table.innerHTML = `
        <tr>
            <td>Distance</td>
            <td>${distNormal.toFixed(0)} nm</td>
            <td>${distOptimal.toFixed(0)} nm <span class="delta">(${deltaPct(
    distNormal,
    distOptimal
  )})</span></td>
        </tr>
        <tr>
            <td>CO₂e Emissions</td>
            <td>${emisNormal.toFixed(1)} ton</td>
            <td>${emisOptimal.toFixed(1)} ton <span class="delta">(${deltaPct(
    emisNormal,
    emisOptimal
  )})</span></td>
        </tr>
        <tr>
            <td>Fuel Consumption (Total)</td>
            <td>${(LNG_normal + LSFO_normal).toFixed(2)} ton</td>
            <td>${(LNG_opt + LSFO_opt).toFixed(
              2
            )} ton <span class="delta">(${deltaPct(
    LNG_normal + LSFO_normal,
    LNG_opt + LSFO_opt
  )})</span></td>
        </tr>
        <tr>
            <td>CII Rating</td>
            <td>${ciiNormal}</td>
            <td>${ciiOptimal} <span class="delta improvement">${ciiDelta(
    ciiNormal,
    ciiOptimal
  )}</span></td>
        </tr>
        <tr>
            <td>Average Speed</td>
            <td id="speed-normal">${speed} knot</td>
            <td id="speed-optimal">${recommendedSpeed.toFixed(
              1
            )} knot <span class="delta">(${(
    OPTIMAL_ROUTE_SPEED_REDUCTION_FACTOR * 100 -
    100
  ).toFixed(0)}%)</span></td>
        </tr>
        <tr>
            <td>Estimated Duration</td>
            <td id="travel-time-normal">${formatTravelTime(hoursNormal)}</td>
            <td id="travel-time-optimal">${formatTravelTime(
              hoursOptimal
            )} <span class="delta">(${deltaTime(
    hoursNormal,
    hoursOptimal
  )})</span></td>
        </tr>
        <tr>
            <td>Significant Wave Height</td>
            <td>${waveNormal.toFixed(1)} m</td>
            <td>${waveOptimal.toFixed(1)} m <span class="delta">(${deltaPct(
    waveNormal,
    waveOptimal
  )})</span></td>
        </tr>
    `;
  // Rekomendasi dinamis
  let rec = `<strong>RECOMMENDATION:</strong> Choose the optimal route `;
  if (optimalRoute.length > 2) {
    rec += `via waypoint <b>[${optimalRoute[1][0].toFixed(
      2
    )}, ${optimalRoute[1][1].toFixed(2)}]</b> `;
  }
  rec += `to reduce emissions by <b>${deltaPct(
    emisNormal,
    emisOptimal
  )}</b> and wave height from <b>${waveNormal.toFixed(
    1
  )} m</b> to <b>${waveOptimal.toFixed(1)} m</b>.`;
  document.querySelector(".recommendation").innerHTML = rec;
}

function updateDashboardPlaceholder() {
  const table = document.getElementById("dashboard-tbody");
  table.innerHTML = `
        <tr><td>Distance</td><td>–</td><td>–</td></tr>
        <tr><td>CO₂e Emissions</td><td>–</td><td>–</td></tr>
        <tr><td>Fuel Consumption (Total)</td><td>–</td><td>–</td></tr>
        <tr><td>CII Rating</td><td>–</td><td>–</td></tr>
        <tr><td>Average Speed</td><td id="speed-normal">–</td><td id="speed-optimal">–</td></tr>
        <tr><td>Estimated Duration</td><td id="travel-time-normal">–</td><td id="travel-time-optimal">–</td></tr>
        <tr><td>Significant Wave Height</td><td>–</td><td>–</td></tr>
    `;
  document.querySelector(".recommendation").innerHTML = "";
}

function deltaPct(a, b) {
  if (a === 0) return "0%";
  const pct = ((b - a) / a) * 100;
  return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%"; // >= 0 untuk +0.0%
}
function ciiDelta(a, b) {
  // a, b: "C (3.89)"
  const valA = parseFloat(a.split("(")[1]);
  const valB = parseFloat(b.split("(")[1]);
  const delta = valB - valA;
  // Determine if it's an improvement (e.g., B is better than C, A is better than B)
  // Assuming lower CII value is better.
  // Also, consider letter grade improvement.
  const gradeA = a.charAt(0);
  const gradeB = b.charAt(0);
  return gradeB < gradeA
    ? `Improved to ${gradeB}`
    : gradeB > gradeA
    ? `Worsened to ${gradeB}`
    : `No change`;
}

function saveUserInput(data) {
  localStorage.setItem("dro_user_input", JSON.stringify(data));
}

// --- LEAFLET ICONS ---
function blueIcon() {
  return L.icon({
    iconUrl:
      "https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-blue.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowUrl: "https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png",
    shadowSize: [41, 41],
  });
}
function redIcon() {
  return L.icon({
    iconUrl:
      "https://cdn.jsdelivr.net/gh/pointhi/leaflet-color-markers@master/img/marker-icon-red.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowUrl: "https://unpkg.com/leaflet@1.7.1/dist/images/marker-shadow.png",
    shadowSize: [41, 41],
  });
}
