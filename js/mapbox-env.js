// Mapbox GL JS + three.js custom layer to render the GLB inside the real-world
// environment (3D building footprints + satellite tiles).
//
// Token: stored in localStorage[bizual_lab_mapbox_token]. Free tier from
// mapbox.com is plenty for internal lab use.
//
// Math notes (the tricky part):
//   • Mapbox's coordinate system is Mercator with Z-up.
//   • three.js scenes are Y-up by default.
//   • Models are auto-centered: base (Y_min) → 0, X/Z midpoints → 0.
//   • Model scale = 1 meter in Mercator units (provided by Mapbox).
//   • Rotation around the world vertical: applied IN MODEL SPACE around Y
//     (the GLB's up axis), then the X-rotation 90° converts Y-up → Z-up.
//   • render() does NOT call map.triggerRepaint(): Mapbox handles redraws on
//     its own, and slider setters call triggerRepaint() explicitly.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const MAPBOX_CSS_URL = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.css';
const MAPBOX_JS_URL  = 'https://api.mapbox.com/mapbox-gl-js/v3.7.0/mapbox-gl.js';
const DRACO_DECODER  = 'https://www.gstatic.com/draco/v1/decoders/';

let _mapboxgl = null;
let _cssInjected = false;
let _currentMap = null;

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

// Build the three.js custom layer for Mapbox.
function createModelLayer({ lng, lat, modelUrl, onModelReady }) {
  const modelOrigin = [lng, lat];
  const modelAltitudeBase = 0;

  // Mutable state (driven by sliders).
  let rotationDeg = 0;       // building heading (0–360°)
  let scaleBonus = 1.0;      // fine-tuning factor; 1.0 = real-world meters
  let altOffset = 0;         // meters above ground (compensate slope)

  let renderer, scene, camera, model;
  let mapRef = null;
  let metersToMercator = 1;
  let mercator = null;

  // Reusable matrices/vectors to avoid GC pressure on every frame.
  const _xRot = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const _yRot = new THREE.Matrix4();
  const _scale = new THREE.Vector3();
  const _xform = new THREE.Matrix4();
  const _proj = new THREE.Matrix4();

  const layer = {
    id: 'bizual-model',
    type: 'custom',
    renderingMode: '3d',

    // Public API for sliders.
    setRotation(deg)  { rotationDeg = deg; mapRef?.triggerRepaint(); },
    setScale(s)       { scaleBonus = s;    mapRef?.triggerRepaint(); },
    setAltOffset(m)   { altOffset = m;     mapRef?.triggerRepaint(); },
    getModelBox()     { return model ? new THREE.Box3().setFromObject(model) : null; },

    onAdd(map, gl) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 0.7));
      const sun = new THREE.DirectionalLight(0xfff4e5, 1.2);
      sun.position.set(10, 20, 10);
      scene.add(sun);

      mercator = _mapboxgl.MercatorCoordinate.fromLngLat(modelOrigin, modelAltitudeBase);
      metersToMercator = mercator.meterInMercatorCoordinateUnits();

      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath(DRACO_DECODER);
      draco.setDecoderConfig({ type: 'js' });
      loader.setDRACOLoader(draco);

      loader.load(
        modelUrl,
        (gltf) => {
          model = gltf.scene;

          // Auto-center: base at Y=0, X/Z mid at 0. Important — GLBs from
          // gltf-transform sometimes have origins offset from the building base.
          const box = new THREE.Box3().setFromObject(model);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          model.position.set(-center.x, -box.min.y, -center.z);
          model.updateMatrixWorld();
          scene.add(model);

          // Heuristic check: if Y-size < 5m, model is probably in cm — flag it.
          const isLikelyCm = size.y < 5 && size.x < 5 && size.z < 5;
          window.__modelBBox = { box, size, center, isLikelyCm };

          console.log('[mapbox-env] model loaded:', {
            sizeM: { x: +size.x.toFixed(1), y: +size.y.toFixed(1), z: +size.z.toFixed(1) },
            metersToMercator,
            isLikelyCm,
          });

          if (onModelReady) onModelReady({ box, size, center, isLikelyCm });
          mapRef.triggerRepaint();
        },
        undefined,
        (err) => console.warn('[mapbox-env] GLB load failed:', err)
      );

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    },

    render(gl, matrix) {
      if (!model || !mercator) return;

      // Re-derive Mercator with current altitude offset (matters for terrains
      // with slope — the GLB base sits at modelAltitudeBase + altOffset).
      const m = _mapboxgl.MercatorCoordinate.fromLngLat(modelOrigin, modelAltitudeBase + altOffset);

      const scale = metersToMercator * scaleBonus;
      _scale.set(scale, -scale, scale); // negate Y to flip handedness for Mapbox

      // Building heading: rotate around the model's Y axis BEFORE the Y→Z-up
      // flip. After the flip, that rotation maps to a rotation around world Z
      // (vertical), which is what we want.
      _yRot.makeRotationAxis(new THREE.Vector3(0, 1, 0), rotationDeg * Math.PI / 180);

      _xform
        .makeTranslation(m.x, m.y, m.z)
        .scale(_scale)
        .multiply(_xRot)
        .multiply(_yRot);

      // Mapbox supplies the combined view-projection matrix; we post-multiply
      // by our local transform to get the final clip-space matrix.
      _proj.fromArray(matrix).multiply(_xform);
      camera.projectionMatrix.copy(_proj);
      camera.projectionMatrixInverse.copy(_proj).invert();

      renderer.resetState();
      renderer.render(scene, camera);
      // No triggerRepaint here — Mapbox already repaints on view change /
      // explicit triggerRepaint calls from slider setters.
    },
  };

  return layer;
}

export async function openEnvironment({ container, address, modelUrl, token, initial = {} }) {
  if (!token) throw new Error('Falta token de Mapbox');
  await loadMapboxScript();
  _mapboxgl.accessToken = token;

  const coords = await geocodeAddress(address);
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

  // 3D building footprints from Mapbox itself.
  try {
    map.addLayer({
      id: 'mapbox-buildings-3d',
      source: 'composite',
      'source-layer': 'building',
      filter: ['==', 'extrude', 'true'],
      type: 'fill-extrusion',
      minzoom: 15,
      paint: {
        'fill-extrusion-color': '#aab',
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': ['get', 'min_height'],
        'fill-extrusion-opacity': 0.65,
      },
    });
  } catch (e) { /* style may not include building source — ignore */ }

  layerHandle = createModelLayer({
    lng: coords.lon,
    lat: coords.lat,
    modelUrl,
    onModelReady: ({ size, isLikelyCm }) => {
      // FlyTo once we know where the building actually is — gentle re-frame.
      map.flyTo({
        center: [coords.lon, coords.lat],
        zoom: 17,
        pitch: 55,
        bearing: -20 + (initial.rotation || 0),
        duration: 1500,
      });
      // If the GLB is in cm (size < 5m), nudge the user via console.
      if (isLikelyCm) {
        console.warn('[mapbox-env] modelo parece estar en cm, no en metros — subí Escala a ~100×');
      }
    },
  });
  map.addLayer(layerHandle);

  // Apply persisted/initial values.
  if (initial.rotation != null) layerHandle.setRotation(initial.rotation);
  if (initial.scale    != null) layerHandle.setScale(initial.scale);
  if (initial.altitude != null) layerHandle.setAltOffset(initial.altitude);

  return {
    map,
    coords,
    setStyle:    (styleId) => map.setStyle(`mapbox://styles/mapbox/${styleId}`),
    setBearing:  (d) => layerHandle.setRotation(d),
    setScale:    (s) => layerHandle.setScale(s),
    setAltitude: (a) => layerHandle.setAltOffset(a),
    getModelBox: () => layerHandle.getModelBox(),
  };
}

export function closeEnvironment() {
  if (_currentMap) {
    try { _currentMap.remove(); } catch {}
    _currentMap = null;
  }
}
