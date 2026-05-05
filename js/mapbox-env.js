// Mapbox GL JS + three.js custom layer to render the GLB inside the real-world
// environment (3D building footprints + satellite tiles). Lazy-loaded so users
// who never click "Entorno real" don't pay the bundle cost.
//
// Token: stored in localStorage[bizual_lab_mapbox_token]. If missing, prompted
// once on first open. Free tier from mapbox.com is plenty for internal lab use.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAPBOX_CSS_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css';
const MAPBOX_JS_URL  = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js';

let _mapboxgl = null;
let _cssInjected = false;
let _currentMap = null;
let _currentLayerHandle = null;

function injectCSS() {
  if (_cssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = MAPBOX_CSS_URL;
  document.head.appendChild(link);
  _cssInjected = true;
}

function loadMapboxScript() {
  if (_mapboxgl) return Promise.resolve(_mapboxgl);
  if (window.mapboxgl) { _mapboxgl = window.mapboxgl; return Promise.resolve(_mapboxgl); }
  injectCSS();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MAPBOX_JS_URL;
    s.onload = () => { _mapboxgl = window.mapboxgl; resolve(_mapboxgl); };
    s.onerror = () => reject(new Error('No se pudo cargar Mapbox GL JS'));
    document.head.appendChild(s);
  });
}

// Geocode via OpenStreetMap Nominatim — free, no key required.
// Their usage policy asks for a User-Agent and rate limits to ~1 req/s, fine
// for one-off lab usage.
export async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=cl,ar,uy,pe,co,mx,es`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  if (!res.ok) throw new Error(`Geocoder HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error('Dirección no encontrada. Probá con: Calle 123, Ciudad, País');
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display: data[0].display_name,
  };
}

// Build the three.js custom layer for Mapbox. Loads the GLB once and renders
// it tied to a (lng, lat) point with optional bearing rotation.
function createModelLayer({ lng, lat, modelUrl, bearingDeg = 0, scale = 1, altitude = 0 }) {
  const modelOrigin = [lng, lat];
  const modelRotateX = Math.PI / 2; // glTF Y-up → Mapbox Z-up
  let modelRotateY = bearingDeg * Math.PI / 180;
  const modelRotateZ = 0;

  const merc = _mapboxgl.MercatorCoordinate.fromLngLat(modelOrigin, altitude);

  const transform = {
    translateX: merc.x,
    translateY: merc.y,
    translateZ: merc.z,
    rotateX: modelRotateX,
    rotateY: modelRotateY,
    rotateZ: modelRotateZ,
    scale: merc.meterInMercatorCoordinateUnits() * scale,
  };

  let renderer, scene, camera, model;
  let mapRef = null;

  const layer = {
    id: 'bizual-model',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.45));
      const sun = new THREE.DirectionalLight(0xfff4e5, 1.4);
      sun.position.set(0, -70, 100).normalize();
      scene.add(sun);

      const loader = new GLTFLoader();
      loader.load(
        modelUrl,
        (gltf) => {
          model = gltf.scene;
          scene.add(model);
          map.triggerRepaint();
        },
        undefined,
        (err) => console.warn('[mapbox-env] GLB load failed:', err)
      );

      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },

    setBearing(deg) {
      transform.rotateY = deg * Math.PI / 180;
      mapRef?.triggerRepaint();
    },

    setScale(s) {
      transform.scale = merc.meterInMercatorCoordinateUnits() * s;
      mapRef?.triggerRepaint();
    },

    setAltitude(a) {
      const m2 = _mapboxgl.MercatorCoordinate.fromLngLat(modelOrigin, a);
      transform.translateX = m2.x;
      transform.translateY = m2.y;
      transform.translateZ = m2.z;
      mapRef?.triggerRepaint();
    },

    render(gl, matrix) {
      const rotX = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), transform.rotateX);
      const rotY = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 1, 0), transform.rotateY);
      const rotZ = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0, 0, 1), transform.rotateZ);
      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(transform.translateX, transform.translateY, transform.translateZ)
        .scale(new THREE.Vector3(transform.scale, -transform.scale, transform.scale))
        .multiply(rotX).multiply(rotY).multiply(rotZ);
      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
      mapRef.triggerRepaint();
    },
  };

  return layer;
}

// Open the modal panel with the map. Resolves with a handle that exposes
// `setBearing`, `setScale`, etc. to the caller for live adjustments.
export async function openEnvironment({ container, address, modelUrl, token }) {
  if (!token) throw new Error('Falta token de Mapbox');
  await loadMapboxScript();
  _mapboxgl.accessToken = token;

  const coords = await geocodeAddress(address);
  // Reset container
  container.innerHTML = '';

  const map = new _mapboxgl.Map({
    container,
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [coords.lon, coords.lat],
    zoom: 17,
    pitch: 55,
    bearing: -20,
    antialias: true,
  });

  _currentMap = map;
  let layerHandle = null;

  await new Promise((resolve) => map.on('load', resolve));

  // 3D building footprints from Mapbox itself (visible at z>=15, gives context).
  try {
    map.addLayer({
      id: 'mapbox-buildings-3d',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#aaaaaa',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.7,
      },
    });
  } catch (e) { /* style may not include building source — ignore */ }

  layerHandle = createModelLayer({ lng: coords.lon, lat: coords.lat, modelUrl, bearingDeg: 0, scale: 1 });
  map.addLayer(layerHandle);
  _currentLayerHandle = layerHandle;

  return {
    map,
    coords,
    setStyle: (styleId) => map.setStyle(`mapbox://styles/mapbox/${styleId}`),
    setBearing: (d) => layerHandle.setBearing(d),
    setScale:   (s) => layerHandle.setScale(s),
    setAltitude:(a) => layerHandle.setAltitude(a),
  };
}

export function closeEnvironment() {
  if (_currentMap) {
    try { _currentMap.remove(); } catch {}
    _currentMap = null;
    _currentLayerHandle = null;
  }
}
