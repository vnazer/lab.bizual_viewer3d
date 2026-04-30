# lab.bizual.ai

Entorno de testing técnico para iterar optimizaciones de modelos 3D
(Draco, KTX2, AO baked, decimación). **No es** staging del producto Bizual.

## Stack

- HTML estático + Three.js r184 (vía importmap, CDN unpkg)
- WebGPU con fallback automático a WebGL2
- DRACOLoader (CDN gstatic) + KTX2Loader (CDN unpkg) + Meshopt
- HDRI Polyhaven `kloofendal_partly_cloudy_puresky_2k` (2k)
- ACES Filmic + sRGB output + ContactShadows + sun direccional con sombras
- PHP opcional para auto-listar GLBs (Hostinger lo soporta nativo)

## Rutas

| URL | Qué hace |
| --- | --- |
| `/` | Visor principal con dropdown, toggles, stats |
| `/compare.html` | Splitscreen para comparar 2 GLBs lado a lado, con cámaras sincronizadas |
| `/models.php` | Endpoint que lista todos los `.glb` de `/models/` (usado por el visor) |
| `/models/manifest.json` | Fallback si el hosting no ejecuta PHP |

## Cómo subir un GLB nuevo

### Opción A — Si el hosting tiene PHP (Hostinger por defecto sí)

1. Subí el `.glb` a `/models/` (FTP, File Manager de Hostinger, o `scp`)
2. Recargá `https://lab.bizual.ai` — aparece automáticamente en el dropdown

### Opción B — Hosting estático sin PHP

1. Subí el `.glb` a `/models/`
2. Corré localmente:
   ```bash
   bash tools/generate-manifest.sh
   ```
3. Subí el `models/manifest.json` actualizado
4. Recargá

## Cargar un GLB de URL externa

En el HUD del visor principal, pegá la URL en el campo "URL externa" y dale Cargar.
La URL tiene que servir CORS abierto (la mayoría de CDNs lo hacen).

## Stats que muestra el visor

- **FPS** — actualizado cada 500ms
- **Tamaño** — peso real del GLB en bytes (medido vía fetch)
- **Carga** — tiempo desde fetch hasta scene-ready (incluye decode Draco/KTX2)
- **Triángulos** — suma de todos los meshes
- **Draw calls** — `renderer.info.render.calls` del último frame

## Comparativa splitscreen

`/compare.html` levanta dos renderers independientes lado a lado.
Por defecto las cámaras están sincronizadas (mover una mueve la otra) —
se puede desactivar con el toggle. Útil para comparar:

- Mismo modelo a distinto nivel de Draco/decimación
- KTX2 vs PNG en texturas
- AO baked vs AO en runtime
- Diferentes presets de export desde Blender

## Local dev

```bash
cd lab.bizual.ai
python3 -m http.server 8000
# abrir http://localhost:8000
```

(Para que `/models.php` funcione localmente necesitás un server con PHP, ej. `php -S 0.0.0.0:8000`. Sin PHP, el visor cae al `manifest.json`.)

## Deploy a Hostinger

1. Crear subdominio `lab.bizual.ai` apuntado a una carpeta dedicada
   (ej. `public_html/lab/`)
2. Subir el contenido de este repo a esa carpeta (NO el directorio
   `lab.bizual.ai` en sí, su contenido)
3. Apuntar el CNAME en Cloudflare:
   - Type: `CNAME`
   - Name: `lab`
   - Target: el que indique Hostinger (ej. `lab.bizual.ai.<...>.hostingersite.com`
     o el dominio raíz). Confirmar con Hostinger después de crear el subdominio.
   - Proxy status: DNS only (sin proxy naranja) hasta validar que Let's Encrypt emite el cert
4. Esperar emisión del cert SSL (Let's Encrypt automático en Hostinger, ~1-5 min)
5. Verificar `https://lab.bizual.ai` carga el visor

## Estructura

```
lab.bizual.ai/
├── index.html              # Visor principal
├── compare.html            # Splitscreen
├── models.php              # Auto-listing endpoint
├── .htaccess               # MIME, CORS, HTTPS redirect
├── README.md
├── css/
│   └── style.css
├── js/
│   ├── scene.js            # Factory compartida (renderer, scene, loaders)
│   ├── viewer.js           # Visor principal
│   └── compare.js          # Splitscreen
├── models/                 # ← subir GLBs acá
│   └── manifest.json       # Fallback sin PHP
├── hdri/                   # (vacío, HDRI se carga del CDN de Polyhaven)
└── tools/
    └── generate-manifest.sh
```

## Notas técnicas

- **Three.js r184** vía importmap. Para upgradear, cambiar la versión en
  los dos `<script type="importmap">` de `index.html` y `compare.html`,
  y la URL del KTX2 transcoder en `js/scene.js` (constante `KTX2_TRANSCODER`).
- **WebGPU**: deshabilitado por defecto para no romper navegadores sin soporte.
  Para probarlo, agregar `?webgpu=1` a la URL (ej. `https://lab.bizual.ai/?webgpu=1`).
  Si falla la init, cae automáticamente a `WebGLRenderer`. El backend activo se
  muestra en el HUD (esquina sup-izq).
- **ContactShadows**: implementado como un plano con `ShadowMaterial` que recibe
  sombra del sun light. La versión "drei-style" (render desde abajo + blur) no
  está en addons stock de three.js — si necesitás esa calidad, swappear por
  `@pmndrs/vanilla-extract` o portear el shader de drei.
- **HDRI desde CDN**: el primer load es ~5MB. Se cachea con PMREMGenerator
  y se reusa entre cambios de modelo. No re-descarga.
- **Sombras**: `DirectionalLight` con shadow map 2048×2048 + `ContactShadows`
  encima para sombras suaves de contacto. Toggle independiente.
- **GLBs muy pesados**: el `loadGLBWithStats` hace `fetch → blob → arrayBuffer →
  GLTFLoader.parse`, así medimos el peso exacto. Para modelos muy grandes (>100MB)
  puede ser preferible swappear a `loader.load(url, ...)` y leer el peso del
  header HTTP.
