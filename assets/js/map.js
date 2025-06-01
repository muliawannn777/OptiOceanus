// map.js - Logika peta (Leaflet.js)

// Fungsi optimasi rute dengan prioritas LNG bunkering
function getOptimalRoute(start, end, avoidWaves = true) {
  const waypoints = [];
  // 1. Hindari area gelombang >3m (data dari wave_data.json)
  if (avoidWaves && typeof waveData !== 'undefined') {
    waveData.forEach(wave => {
      if (wave.height > 3 && isPointNearLine([wave.lat, wave.lon], [start, end])) {
        waypoints.push([wave.lat - 2, wave.lon + 3]); // Geser rute
      }
    });
  }
  // 2. Tambahkan waypoint dekat LNG bunkering ports.
  // CATATAN: Dengan daftar pelabuhan internasional, pemilihan LNG port perlu lebih cerdas
  // (misalnya, yang terdekat dengan rute, bukan hanya yang pertama dalam daftar global).
  if (typeof ports !== 'undefined') {
    const lngPorts = ports.filter(p => p.hasLNGBunkering);
    if (lngPorts.length > 0) {
      // Logika saat ini hanya mengambil port LNG pertama dari daftar global.
      // Ini mungkin perlu disesuaikan untuk rute internasional agar lebih relevan.
      waypoints.push([lngPorts[0].lat, lngPorts[0].lon]);
    }
  }
  return waypoints.length > 0 ? [start, ...waypoints, end] : [start, end];
}

// Inisialisasi peta dengan pengecekan dan error handling yang lebih baik
window.map = null;
function initMap() {
    const mapDiv = document.getElementById('map');
    if (!mapDiv) {
        console.error('Elemen #map tidak ditemukan di halaman!');
        return;
    }
    console.log('Checking Leaflet availability:', typeof L); // Debug 1
    if (typeof L === 'undefined') {
        console.error('Leaflet library not loaded!'); // Debug 2
        mapDiv.innerHTML =
            '<div style="color:red;padding:20px;text-align:center;">' +
            'ERROR: Leaflet.js not loaded. Check internet connection.' +
            '</div>';
        return;
    }
    // Bersihkan map instance sebelumnya jika ada
    if (window.map && window.map.remove) {
        window.map.remove();
        window.map = null;
    }
    try {
        window.map = L.map('map').setView([-6.12, 106.87], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            errorTileUrl: '',
        }).addTo(window.map);
        console.log('Map successfully initialized:', window.map); // Debug 3
    } catch (error) {
        console.error('Map initialization failed:', error); // Debug 4
        mapDiv.innerHTML =
            '<div style="color:red;padding:20px;text-align:center;">' +
            'ERROR: ' + error.message +
            '</div>';
    }
}
