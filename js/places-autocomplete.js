// Google Places Autocomplete for the "Dirección del proyecto" field.
// Picking a referenced address gives exact lat/lng straight from Google — the
// same source as the 3D tiles — instead of geocoding free text (which drifts,
// sometimes into the sea). The caller falls back to OSM/Nominatim when no pick
// is available. Requires the API key to have BOTH "Maps JavaScript API" and
// "Places API" enabled, with referer restrictions covering this origin.

const COORDS_KEY = 'bizual_g3d_coords';
let _mapsPromise = null;

function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google);
  if (_mapsPromise) return _mapsPromise;
  _mapsPromise = new Promise((resolve, reject) => {
    const cb = '__gmapsReady_' + Math.random().toString(36).slice(2);
    window[cb] = () => { delete window[cb]; resolve(window.google); };
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://maps.googleapis.com/maps/api/js'
      + '?key=' + encodeURIComponent(apiKey)
      + '&libraries=places&language=es&region=CL&loading=async&callback=' + cb;
    s.onerror = () => reject(new Error('No se pudo cargar Google Maps JS (¿"Maps JavaScript API" habilitada en la key?)'));
    document.head.appendChild(s);
  });
  return _mapsPromise;
}

export function getStoredCoords() {
  try { return JSON.parse(localStorage.getItem(COORDS_KEY) || 'null'); } catch { return null; }
}

function setStoredCoords(c) {
  if (c) localStorage.setItem(COORDS_KEY, JSON.stringify(c));
  else localStorage.removeItem(COORDS_KEY);
}

// Exact coords for `addr` only if it still matches the user's last pick —
// otherwise null, so the caller geocodes (OSM) the edited text.
export function resolvePickedCoords(addr) {
  const c = getStoredCoords();
  if (c && (addr || '').trim() === (c.display || '').trim()) {
    return { lat: c.lat, lon: c.lon, display: c.display };
  }
  return null;
}

// Wires autocomplete onto `inputEl`. `onPick({lat, lon, display})` fires when a
// referenced address is chosen. Returns the mode used ('new' | 'legacy').
export async function initAddressAutocomplete(inputEl, apiKey, onPick) {
  await loadGoogleMaps(apiKey);
  const places = await window.google.maps.importLibrary('places');

  const commit = (coords) => {
    inputEl.value = coords.display;
    setStoredCoords(coords);
    onPick?.(coords);
  };

  // Tier 1 — new PlaceAutocompleteElement (required on GCP projects created
  // after the legacy Places widgets were sunset).
  if (places.PlaceAutocompleteElement) {
    try {
      const pac = new places.PlaceAutocompleteElement();
      pac.id = 'gmp-address';
      pac.style.width = '100%';
      inputEl.style.display = 'none';
      inputEl.insertAdjacentElement('afterend', pac);
      const handler = async (e) => {
        const place = e.placePrediction ? e.placePrediction.toPlace() : e.place;
        if (!place) return;
        await place.fetchFields({ fields: ['location', 'formattedAddress'] });
        const loc = place.location;
        commit({ lat: loc.lat(), lon: loc.lng(), display: place.formattedAddress });
      };
      pac.addEventListener('gmp-select', handler);
      pac.addEventListener('gmp-placeselect', handler);
      console.log('[places] PlaceAutocompleteElement activo');
      return 'new';
    } catch (err) {
      console.warn('[places] PlaceAutocompleteElement falló, pruebo legacy:', err.message);
      inputEl.style.display = '';
    }
  }

  // Tier 2 — legacy Autocomplete bound to the existing input.
  if (places.Autocomplete) {
    const ac = new places.Autocomplete(inputEl, { fields: ['geometry', 'formatted_address'] });
    ac.addListener('place_changed', () => {
      const p = ac.getPlace();
      if (!p.geometry) return;
      const loc = p.geometry.location;
      commit({ lat: loc.lat(), lon: loc.lng(), display: p.formatted_address });
    });
    console.log('[places] Autocomplete (legacy) activo');
    return 'legacy';
  }

  throw new Error('Places cargó sin Autocomplete ni PlaceAutocompleteElement');
}
