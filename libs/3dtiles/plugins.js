// node_modules/3d-tiles-renderer/src/base/traverseFunctions.js
function traverseSet(tile, beforeCb = null, afterCb = null) {
  const stack = [];
  stack.push(tile);
  stack.push(null);
  stack.push(0);
  while (stack.length > 0) {
    const depth = stack.pop();
    const parent = stack.pop();
    const tile2 = stack.pop();
    if (beforeCb && beforeCb(tile2, parent, depth)) {
      if (afterCb) {
        afterCb(tile2, parent, depth);
      }
      return;
    }
    const children = tile2.children;
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
        stack.push(tile2);
        stack.push(depth + 1);
      }
    }
    if (afterCb) {
      afterCb(tile2, parent, depth);
    }
  }
}
function traverseAncestors(tile, callback = null) {
  let current = tile;
  while (current) {
    const depth = current.__depth;
    const parent = current.parent;
    if (callback) {
      callback(current, parent, depth);
    }
    current = parent;
  }
}

// node_modules/3d-tiles-renderer/src/plugins/three/GoogleAttributionsManager.js
var GoogleAttributionsManager = class {
  constructor() {
    this.creditsCount = {};
  }
  _adjustAttributions(line, add) {
    const creditsCount = this.creditsCount;
    const tokens = line.split(/;/g);
    for (let i = 0, l = tokens.length; i < l; i++) {
      const t = tokens[i];
      if (!(t in creditsCount)) {
        creditsCount[t] = 0;
      }
      creditsCount[t] += add ? 1 : -1;
      if (creditsCount[t] <= 0) {
        delete creditsCount[t];
      }
    }
  }
  addAttributions(line) {
    this._adjustAttributions(line, true);
  }
  removeAttributions(line) {
    this._adjustAttributions(line, false);
  }
  toString() {
    const sortedByCount = Object.entries(this.creditsCount).sort((a, b) => {
      const countA = a[1];
      const countB = b[1];
      return countB - countA;
    });
    return sortedByCount.map((pair) => pair[0]).join("; ");
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/GoogleCloudAuthPlugin.js
function getSessionToken(root) {
  let sessionToken = null;
  traverseSet(root, (tile) => {
    if (tile.content && tile.content.uri) {
      const [, params] = tile.content.uri.split("?");
      sessionToken = new URLSearchParams(params).get("session");
      return true;
    }
    return false;
  });
  return sessionToken;
}
var GoogleCloudAuthPlugin = class {
  constructor({ apiToken, autoRefreshToken = false, logoUrl = null, useRecommendedSettings = true }) {
    this.name = "GOOGLE_CLOUD_AUTH_PLUGIN";
    this.priority = -Infinity;
    this.apiToken = apiToken;
    this.autoRefreshToken = autoRefreshToken;
    this.useRecommendedSettings = useRecommendedSettings;
    this.logoUrl = logoUrl;
    this.sessionToken = null;
    this.tiles = null;
    this._onLoadCallback = null;
    this._visibilityChangeCallback = null;
    this._tokenRefreshPromise = null;
    this._attributionsManager = new GoogleAttributionsManager();
    this._logoAttribution = {
      value: "",
      type: "image",
      collapsible: false
    };
    this._attribution = {
      value: "",
      type: "string",
      collapsible: true
    };
  }
  init(tiles) {
    if (tiles == null) {
      return;
    }
    tiles.resetFailedTiles();
    if (tiles.rootURL == null) {
      tiles.rootURL = "https://tile.googleapis.com/v1/3dtiles/root.json";
    }
    if (this.useRecommendedSettings) {
      tiles.parseQueue.maxJobs = 10;
      tiles.downloadQueue.maxJobs = 30;
      tiles.errorTarget = 40;
    }
    this.tiles = tiles;
    this._onLoadCallback = ({ tileSet }) => {
      this.sessionToken = getSessionToken(tileSet.root);
      tiles.removeEventListener("load-tile-set", this._onLoadCallback);
    };
    this._visibilityChangeCallback = ({ tile, visible }) => {
      const copyright = tile.cached.metadata.asset.copyright || "";
      if (visible) {
        this._attributionsManager.addAttributions(copyright);
      } else {
        this._attributionsManager.removeAttributions(copyright);
      }
    };
    tiles.addEventListener("load-tile-set", this._onLoadCallback);
    tiles.addEventListener("tile-visibility-change", this._visibilityChangeCallback);
  }
  getAttributions(target) {
    if (this.tiles.visibleTiles.size > 0) {
      if (this.logoUrl) {
        this._logoAttribution.value = this.logoUrl;
        target.push(this._logoAttribution);
      }
      this._attribution.value = this._attributionsManager.toString();
      target.push(this._attribution);
    }
  }
  preprocessURL(uri) {
    uri = new URL(uri);
    if (/^http/.test(uri.protocol)) {
      uri.searchParams.append("key", this.apiToken);
      if (this.sessionToken !== null) {
        uri.searchParams.append("session", this.sessionToken);
      }
    }
    return uri.toString();
  }
  dispose() {
    const { tiles } = this;
    tiles.removeEventListener("load-tile-set", this._onLoadCallback);
    tiles.removeEventListener("tile-visibility-change", this._visibilityChangeCallback);
  }
  async fetchData(uri, options) {
    if (this._tokenRefreshPromise !== null) {
      await this._tokenRefreshPromise;
      uri = this.preprocessURL(uri);
    }
    const res = await fetch(uri, options);
    if (res.status >= 400 && res.status <= 499 && this.autoRefreshToken) {
      await this._refreshToken(options);
      return fetch(this.preprocessURL(uri), options);
    } else {
      return res;
    }
  }
  _refreshToken(options) {
    if (this._tokenRefreshPromise === null) {
      const rootURL = new URL(this.tiles.rootURL);
      rootURL.searchParams.append("key", this.apiToken);
      this._tokenRefreshPromise = fetch(rootURL, options).then((res) => res.json()).then((res) => {
        this.sessionToken = getSessionToken(res.root);
        this._tokenRefreshPromise = null;
      });
      this._tokenRefreshPromise.catch((error) => {
        this.tiles.dispatchEvent({
          type: "load-error",
          tile: null,
          error,
          rootURL
        });
      });
    }
    return this._tokenRefreshPromise;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/CesiumIonAuthPlugin.js
var CesiumIonAuthPlugin = class {
  constructor({ apiToken, assetId = null, autoRefreshToken = false }) {
    this.name = "CESIUM_ION_AUTH_PLUGIN";
    this.priority = -Infinity;
    this.apiToken = apiToken;
    this.assetId = assetId;
    this.autoRefreshToken = autoRefreshToken;
    this.tiles = null;
    this.endpointURL = null;
    this._bearerToken = null;
    this._tileSetVersion = -1;
    this._tokenRefreshPromise = null;
    this._attributions = [];
    this._disposed = false;
  }
  init(tiles) {
    if (this.assetId !== null) {
      tiles.rootURL = `https://api.cesium.com/v1/assets/${this.assetId}/endpoint`;
    }
    this.tiles = tiles;
    this.endpointURL = tiles.rootURL;
    tiles.resetFailedTiles();
  }
  loadRootTileSet() {
    return this._refreshToken().then(() => {
      return this.tiles.invokeOnePlugin((plugin) => plugin !== this && plugin.loadRootTileSet && plugin.loadRootTileSet());
    });
  }
  preprocessURL(uri) {
    uri = new URL(uri);
    if (/^http/.test(uri.protocol) && this._tileSetVersion != -1) {
      uri.searchParams.append("v", this._tileSetVersion);
    }
    return uri.toString();
  }
  fetchData(uri, options) {
    const tiles = this.tiles;
    if (tiles.getPluginByName("GOOGLE_CLOUD_AUTH_PLUGIN") !== null) {
      return null;
    } else {
      return Promise.resolve().then(async () => {
        if (this._tokenRefreshPromise !== null) {
          await this._tokenRefreshPromise;
          uri = this.preprocessURL(uri);
        }
        const res = await fetch(uri, options);
        if (res.status >= 400 && res.status <= 499 && this.autoRefreshToken) {
          await this._refreshToken(options);
          return fetch(this.preprocessURL(uri), options);
        } else {
          return res;
        }
      });
    }
  }
  getAttributions(target) {
    if (this.tiles.visibleTiles.size > 0) {
      target.push(...this._attributions);
    }
  }
  _refreshToken(options) {
    if (this._tokenRefreshPromise === null) {
      const url = new URL(this.endpointURL);
      url.searchParams.append("access_token", this.apiToken);
      this._tokenRefreshPromise = fetch(url, options).then((res) => {
        if (this._disposed) {
          return null;
        }
        if (!res.ok) {
          throw new Error(`CesiumIonAuthPlugin: Failed to load data with error code ${res.status}`);
        }
        return res.json();
      }).then((json) => {
        if (this._disposed) {
          return null;
        }
        const tiles = this.tiles;
        if ("externalType" in json) {
          const url2 = new URL(json.options.url);
          tiles.rootURL = json.options.url;
          tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: url2.searchParams.get("key") }));
        } else {
          tiles.rootURL = json.url;
          tiles.fetchOptions.headers = tiles.fetchOptions.headers || {};
          tiles.fetchOptions.headers.Authorization = `Bearer ${json.accessToken}`;
          if (url.searchParams.has("v") && this._tileSetVersion === -1) {
            const url2 = new URL(json.url);
            this._tileSetVersion = url2.searchParams.get("v");
          }
          this._bearerToken = json.accessToken;
          if (json.attributions) {
            this._attributions = json.attributions.map((att) => ({
              value: att.html,
              type: "html",
              collapsible: att.collapsible
            }));
          }
        }
        this._tokenRefreshPromise = null;
        return json;
      });
      this._tokenRefreshPromise.catch((error) => {
        this.tiles.dispatchEvent({
          type: "load-error",
          tile: null,
          error,
          url
        });
      });
    }
    return this._tokenRefreshPromise;
  }
  dispose() {
    this._disposed = true;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/UpdateOnChangePlugin.js
import { Matrix4 } from "three";
var _matrix = new Matrix4();
var UpdateOnChangePlugin = class {
  constructor() {
    this.name = "UPDATE_ON_CHANGE_PLUGIN";
    this.tiles = null;
    this.needsUpdate = false;
    this.cameraMatrices = /* @__PURE__ */ new Map();
  }
  init(tiles) {
    this.tiles = tiles;
    this._needsUpdateCallback = () => {
      this.needsUpdate = true;
    };
    this._onCameraAdd = ({ camera }) => {
      this.needsUpdate = true;
      this.cameraMatrices.set(camera, new Matrix4());
    };
    this._onCameraDelete = ({ camera }) => {
      this.needsUpdate = true;
      this.cameraMatrices.delete(camera);
    };
    tiles.addEventListener("camera-resolution-change", this._needsUpdateCallback);
    tiles.addEventListener("load-content", this._needsUpdateCallback);
    tiles.addEventListener("add-camera", this._onCameraAdd);
    tiles.addEventListener("delete-camera", this._onCameraDelete);
    tiles.cameras.forEach((camera) => {
      this._onCameraAdd({ camera });
    });
  }
  doTilesNeedUpdate() {
    const tiles = this.tiles;
    let didCamerasChange = false;
    this.cameraMatrices.forEach((matrix2, camera) => {
      _matrix.copy(tiles.group.matrixWorld).premultiply(camera.matrixWorldInverse).premultiply(camera.projectionMatrixInverse);
      didCamerasChange = didCamerasChange || !_matrix.equals(matrix2);
      matrix2.copy(_matrix);
    });
    const needsUpdate = this.needsUpdate;
    this.needsUpdate = false;
    return needsUpdate || didCamerasChange;
  }
  dispose() {
    const tiles = this.tiles;
    tiles.removeEventListener("camera-resolution-change", this._needsUpdateCallback);
    tiles.removeEventListener("load-content", this._needsUpdateCallback);
    tiles.removeEventListener("camera-add", this._onCameraAdd);
    tiles.removeEventListener("camera-delete", this._onCameraDelete);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/TileCompressionPlugin.js
import { Vector3, LinearFilter, BufferAttribute, MathUtils } from "three";
var _vec = new Vector3();
function compressAttribute(attribute, arrayType) {
  if (attribute.isInterleavedBufferAttribute || attribute.array instanceof arrayType) {
    return attribute;
  }
  const signed = arrayType === Int8Array || arrayType === Int16Array || arrayType === Int32Array;
  const minValue = signed ? -1 : 0;
  const array = new arrayType(attribute.count * attribute.itemSize);
  const newAttribute = new BufferAttribute(array, attribute.itemSize, true);
  const itemSize = attribute.itemSize;
  const count = attribute.count;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < itemSize; j++) {
      const v = MathUtils.clamp(attribute.getComponent(i, j), minValue, 1);
      newAttribute.setComponent(i, j, v);
    }
  }
  return newAttribute;
}
function compressPositionAttribute(mesh, arrayType = Int16Array) {
  const geometry = mesh.geometry;
  const attributes = geometry.attributes;
  const attribute = attributes.position;
  if (attribute.isInterleavedBufferAttribute || attribute.array instanceof arrayType) {
    return attribute;
  }
  const array = new arrayType(attribute.count * attribute.itemSize);
  const newAttribute = new BufferAttribute(array, attribute.itemSize, false);
  const itemSize = attribute.itemSize;
  const count = attribute.count;
  geometry.computeBoundingBox();
  const boundingBox = geometry.boundingBox;
  const { min, max } = boundingBox;
  const maxValue = 2 ** (8 * arrayType.BYTES_PER_ELEMENT - 1) - 1;
  const minValue = -maxValue;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < itemSize; j++) {
      const key = j === 0 ? "x" : j === 1 ? "y" : "z";
      const bbMinValue = min[key];
      const bbMaxValue = max[key];
      const v = MathUtils.mapLinear(
        attribute.getComponent(i, j),
        bbMinValue,
        bbMaxValue,
        minValue,
        maxValue
      );
      newAttribute.setComponent(i, j, v);
    }
  }
  boundingBox.getCenter(_vec);
  mesh.position.add(_vec);
  mesh.scale.x *= 0.5 * (max.x - min.x) / maxValue;
  mesh.scale.y *= 0.5 * (max.y - min.y) / maxValue;
  mesh.scale.z *= 0.5 * (max.z - min.z) / maxValue;
  attributes.position = newAttribute;
  mesh.geometry.boundingBox = null;
  mesh.geometry.boundingSphere = null;
  mesh.updateMatrixWorld();
}
var TileCompressionPlugin = class {
  constructor(options) {
    this._options = {
      // whether to generate normals if they don't already exist.
      generateNormals: false,
      // whether to disable use of mipmaps since they are typically not necessary
      // with something like 3d tiles.
      disableMipmaps: true,
      // whether to compress certain attributes
      compressIndex: true,
      compressNormals: false,
      compressUvs: false,
      compressPosition: false,
      // the TypedArray type to use when compressing the attributes
      uvType: Int8Array,
      normalType: Int8Array,
      positionType: Int16Array,
      ...options
    };
    this.name = "TILES_COMPRESSION_PLUGIN";
    this.priority = -100;
  }
  processTileModel(scene, tile) {
    const {
      generateNormals,
      disableMipmaps,
      compressIndex,
      compressUvs,
      compressNormals,
      compressPosition,
      uvType,
      normalType,
      positionType
    } = this._options;
    scene.traverse((c) => {
      if (c.material && disableMipmaps) {
        const material = c.material;
        for (const key in material) {
          const value = material[key];
          if (value && value.isTexture && value.generateMipmaps) {
            value.generateMipmaps = false;
            value.minFilter = LinearFilter;
          }
        }
      }
      if (c.geometry) {
        const geometry = c.geometry;
        const attributes = geometry.attributes;
        if (compressUvs) {
          const { uv, uv1, uv2, uv3 } = attributes;
          if (uv) attributes.uv = compressAttribute(uv, uvType);
          if (uv1) attributes.uv1 = compressAttribute(uv1, uvType);
          if (uv2) attributes.uv2 = compressAttribute(uv2, uvType);
          if (uv3) attributes.uv3 = compressAttribute(uv3, uvType);
        }
        if (generateNormals && !attributes.normals) {
          geometry.computeVertexNormals();
        }
        if (compressNormals && attributes.normals) {
          attributes.normals = compressAttribute(attributes.normals, normalType);
        }
        if (compressPosition) {
          compressPositionAttribute(c, positionType);
        }
        if (compressIndex && geometry.index) {
          const vertCount = attributes.position.count;
          const index = geometry.index;
          const type = vertCount > 65535 ? Uint32Array : vertCount > 255 ? Uint16Array : Uint8Array;
          if (!(index.array instanceof type)) {
            const array = new type(geometry.index.count);
            array.set(index.array);
            const attribute = new BufferAttribute(array, 1);
            geometry.setIndex(attribute);
          }
        }
      }
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/GLTFExtensionsPlugin.js
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/GLTFStructuralMetadataExtension.js
import { FileLoader } from "three";

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/utilities/ClassPropertyHelpers.js
import {
  Vector2,
  Vector3 as Vector32,
  Vector4,
  Matrix2,
  Matrix3,
  Matrix4 as Matrix42
} from "three";
function getField(object, key, def) {
  return object && key in object ? object[key] : def;
}
function isNumericType(type) {
  return type !== "BOOLEAN" && type !== "STRING" && type !== "ENUM";
}
function isFloatComponentType(type) {
  return /^FLOAT/.test(type);
}
function isVectorType(type) {
  return /^VEC/.test(type);
}
function isMatrixType(type) {
  return /^MAT/.test(type);
}
function readDataFromBufferToType(buffer, offset, type, target = null) {
  if (isMatrixType(type)) {
    return target.fromArray(buffer, offset);
  } else if (isVectorType(type)) {
    return target.fromArray(buffer, offset);
  } else {
    return buffer[offset];
  }
}
function getTypeInstance(property) {
  const { type, componentType } = property;
  switch (type) {
    case "SCALAR":
      return componentType === "INT64" ? 0n : 0;
    case "VEC2":
      return new Vector2();
    case "VEC3":
      return new Vector32();
    case "VEC4":
      return new Vector4();
    case "MAT2":
      return new Matrix2();
    case "MAT3":
      return new Matrix3();
    case "MAT4":
      return new Matrix42();
    case "BOOLEAN":
      return false;
    case "STRING":
      return "";
    // the final value for enums is a string but are represented as integers
    // during intermediate steps
    case "ENUM":
      return 0;
  }
}
function isTypeInstance(type, value) {
  if (value === null || value === void 0) {
    return false;
  }
  switch (type) {
    case "SCALAR":
      return typeof value === "number" || typeof value === "bigint";
    case "VEC2":
      return value.isVector2;
    case "VEC3":
      return value.isVector3;
    case "VEC4":
      return value.isVector4;
    case "MAT2":
      return value.isMatrix2;
    case "MAT3":
      return value.isMatrix3;
    case "MAT4":
      return value.isMatrix4;
    case "BOOLEAN":
      return typeof value === "boolean";
    case "STRING":
      return typeof value === "string";
    case "ENUM":
      return typeof value === "number" || typeof value === "bigint";
  }
  throw new Error("ClassProperty: invalid type.");
}
function getArrayConstructorFromComponentType(componentType, type = null) {
  switch (componentType) {
    case "INT8":
      return Int8Array;
    case "INT16":
      return Int16Array;
    case "INT32":
      return Int32Array;
    case "INT64":
      return BigInt64Array;
    case "UINT8":
      return Uint8Array;
    case "UINT16":
      return Uint16Array;
    case "UINT32":
      return Uint32Array;
    case "UINT64":
      return BigUint64Array;
    case "FLOAT32":
      return Float32Array;
    case "FLOAT64":
      return Float64Array;
  }
  switch (type) {
    case "BOOLEAN":
      return Uint8Array;
    case "STRING":
      return Uint8Array;
  }
  throw new Error("ClassProperty: invalid type.");
}
function resolveDefault(property, target = null) {
  const array = property.array;
  if (array) {
    target = target && Array.isArray(target) ? target : [];
    target.length = property.count;
    for (let i = 0, l = target.length; i < l; i++) {
      target[i] = resolveDefaultElement(property, target[i]);
    }
  } else {
    target = resolveDefaultElement(property, target);
  }
  return target;
}
function resolveDefaultElement(property, target = null) {
  const defaultValue = property.default;
  const type = property.type;
  target = target || getTypeInstance(property);
  if (defaultValue === null) {
    switch (type) {
      case "SCALAR":
        return 0;
      case "VEC2":
        return target.set(0, 0);
      case "VEC3":
        return target.set(0, 0, 0);
      case "VEC4":
        return target.set(0, 0, 0, 0);
      case "MAT2":
        return target.identity();
      case "MAT3":
        return target.identity();
      case "MAT4":
        return target.identity();
      case "BOOLEAN":
        return false;
      case "STRING":
        return "";
      case "ENUM":
        return "";
    }
    throw new Error("ClassProperty: invalid type.");
  } else {
    if (isMatrixType(type)) {
      target.fromArray(defaultValue);
    } else if (isVectorType(type)) {
      target.fromArray(defaultValue);
    } else {
      return defaultValue;
    }
  }
}
function resolveNoData(property, target) {
  if (property.noData === null) {
    return target;
  }
  const noData = property.noData;
  const type = property.type;
  if (Array.isArray(target)) {
    for (let i = 0, l = target.length; i < l; i++) {
      target[i] = performResolution(target[i]);
    }
  } else {
    target = performResolution(target);
  }
  return target;
  function performResolution(target2) {
    if (isNoDataEqual(target2)) {
      target2 = resolveDefaultElement(property, target2);
    }
    return target2;
  }
  function isNoDataEqual(value) {
    if (isMatrixType(type)) {
      const elements = value.elements;
      for (let i = 0, l = noData.length; i < l; i++) {
        if (noData[i] !== elements[i]) {
          return false;
        }
      }
      return true;
    } else if (isVectorType(type)) {
      for (let i = 0, l = noData.length; i < l; i++) {
        if (noData[i] !== value.getComponent(i)) {
          return false;
        }
      }
      return true;
    } else {
      return noData === value;
    }
  }
}
function normalizeValue(componentType, v) {
  switch (componentType) {
    case "INT8":
      return Math.max(v / 127, -1);
    case "INT16":
      return Math.max(v, 32767, -1);
    case "INT32":
      return Math.max(v / 2147483647, -1);
    case "INT64":
      return Math.max(Number(v) / 9223372036854776e3, -1);
    // eslint-disable-line no-loss-of-precision
    case "UINT8":
      return v / 255;
    case "UINT16":
      return v / 65535;
    case "UINT32":
      return v / 4294967295;
    case "UINT64":
      return Number(v) / 18446744073709552e3;
  }
}
function adjustValueScaleOffset(property, target) {
  const {
    type,
    componentType,
    scale,
    offset,
    normalized
  } = property;
  if (Array.isArray(target)) {
    for (let i = 0, l = target.length; i < l; i++) {
      target[i] = adjustFromType(target[i]);
    }
  } else {
    target = adjustFromType(target);
  }
  return target;
  function adjustFromType(value) {
    if (isMatrixType(type)) {
      value = adjustMatrix(value);
    } else if (isVectorType(type)) {
      value = adjustVector(value);
    } else {
      value = adjustScalar(value);
    }
    return value;
  }
  function adjustVector(value) {
    value.x = adjustScalar(value.x);
    value.y = adjustScalar(value.y);
    if ("z" in value) value.z = adjustScalar(value.z);
    if ("w" in value) value.w = adjustScalar(value.w);
    return value;
  }
  function adjustMatrix(value) {
    const elements = value.elements;
    for (let i = 0, l = elements.length; i < l; i++) {
      elements[i] = adjustScalar(elements[i]);
    }
    return value;
  }
  function adjustScalar(value) {
    if (normalized) {
      value = normalizeValue(componentType, value);
    }
    if (normalized || isFloatComponentType(componentType)) {
      value = value * scale + offset;
    }
    return value;
  }
}
function initializeFromProperty(property, target, overrideCount = null) {
  if (property.array) {
    if (!Array.isArray(target)) {
      target = new Array(property.count || 0);
    }
    target.length = overrideCount !== null ? overrideCount : property.count;
    for (let i = 0, l = target.length; i < l; i++) {
      if (!isTypeInstance(property.type, target[i])) {
        target[i] = getTypeInstance(property);
      }
    }
  } else {
    if (!isTypeInstance(property.type, target)) {
      target = getTypeInstance(property);
    }
  }
  return target;
}
function initializeFromClass(properties, target) {
  for (const key in target) {
    if (!(key in properties)) {
      delete target[key];
    }
  }
  for (const key in properties) {
    const prop = properties[key];
    target[key] = initializeFromProperty(prop, target[key]);
  }
}
function typeToComponentCount(type) {
  switch (type) {
    case "ENUM":
      return 1;
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
      return 4;
    case "MAT2":
      return 4;
    case "MAT3":
      return 9;
    case "MAT4":
      return 16;
    // unused
    case "BOOLEAN":
      return -1;
    case "STRING":
      return -1;
    default:
      return -1;
  }
}

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/ClassProperty.js
var ClassProperty = class {
  constructor(enums, property, accessorProperty = null) {
    this.name = property.name || null;
    this.description = property.description || null;
    this.type = property.type;
    this.componentType = property.componentType || null;
    this.enumType = property.enumType || null;
    this.array = property.array || false;
    this.count = property.count || 0;
    this.normalized = property.normalized || false;
    this.offset = property.offset || 0;
    this.scale = getField(property, "scale", 1);
    this.max = getField(property, "max", Infinity);
    this.min = getField(property, "min", -Infinity);
    this.required = property.required || false;
    this.noData = getField(property, "noData", null);
    this.default = getField(property, "default", null);
    this.semantic = getField(property, "semantic", null);
    this.enumSet = null;
    this.accessorProperty = accessorProperty;
    if (accessorProperty) {
      this.offset = getField(accessorProperty, "offset", this.offset);
      this.scale = getField(accessorProperty, "scale", this.scale);
      this.max = getField(accessorProperty, "max", this.max);
      this.min = getField(accessorProperty, "min", this.min);
    }
    if (property.type === "ENUM") {
      this.enumSet = enums[this.enumType];
      if (this.componentType === null) {
        this.componentType = getField(this.enumSet, "valueType", "UINT16");
      }
    }
  }
  // shape the given target to match the data type of the property
  // enums are set to their integer value
  shapeToProperty(target, countOverride = null) {
    return initializeFromProperty(this, target, countOverride);
  }
  // resolve the given object to the default value for the property for a single element
  // enums are set to a default string
  resolveDefaultElement(target) {
    return resolveDefaultElement(this, target);
  }
  // resolve the target to the default value for the property for every element if it's an array
  // enums are set to a default string
  resolveDefault(target) {
    return resolveDefault(this, target);
  }
  // converts any instances of no data to the default value
  resolveNoData(target) {
    return resolveNoData(this, target);
  }
  // converts enums integers in the given target to strings
  resolveEnumsToStrings(target) {
    const enumSet = this.enumSet;
    if (this.type === "ENUM") {
      if (Array.isArray(target)) {
        for (let i = 0, l = target.length; i < l; i++) {
          target[i] = getEnumName(target[i]);
        }
      } else {
        target = getEnumName(target);
      }
    }
    return target;
    function getEnumName(index) {
      const match = enumSet.values.find((e) => e.value === index);
      if (match === null) {
        return "";
      } else {
        return match.name;
      }
    }
  }
  // apply scales
  adjustValueScaleOffset(target) {
    if (isNumericType(this.type)) {
      return adjustValueScaleOffset(this, target);
    } else {
      return target;
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/PropertySetAccessor.js
var PropertySetAccessor = class {
  constructor(definition, classes = {}, enums = {}, data = null) {
    this.definition = definition;
    this.class = classes[definition.class];
    this.className = definition.class;
    this.enums = enums;
    this.data = data;
    this.name = "name" in definition ? definition.name : null;
    this.properties = null;
  }
  getPropertyNames() {
    return Object.keys(this.class.properties);
  }
  includesData(name) {
    return Boolean(this.definition.properties[name]);
  }
  dispose() {
  }
  _initProperties(propertyClass = ClassProperty) {
    const properties = {};
    for (const key in this.class.properties) {
      properties[key] = new propertyClass(this.enums, this.class.properties[key], this.definition.properties[key]);
    }
    this.properties = properties;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/PropertyAttributeAccessor.js
var PropertyAttributeClassProperty = class extends ClassProperty {
  constructor(enums, classProperty, attributeProperty = null) {
    super(enums, classProperty, attributeProperty);
    this.attribute = attributeProperty.attribute;
  }
};
var PropertyAttributeAccessor = class extends PropertySetAccessor {
  constructor(...args) {
    super(...args);
    this.isPropertyAttributeAccessor = true;
    this._initProperties(PropertyAttributeClassProperty);
  }
  getData(id, geometry, target = {}) {
    const properties = this.properties;
    initializeFromClass(properties, target);
    for (const name in properties) {
      target[name] = this.getPropertyValue(name, id, geometry, target[name]);
    }
    return target;
  }
  getPropertyValue(name, id, geometry, target = null) {
    if (id >= this.count) {
      throw new Error("PropertyAttributeAccessor: Requested index is outside the range of the buffer.");
    }
    const property = this.properties[name];
    const type = property.type;
    if (!property) {
      throw new Error("PropertyAttributeAccessor: Requested class property does not exist.");
    } else if (!this.definition.properties[name]) {
      return property.resolveDefault(target);
    }
    target = property.shapeToProperty(target);
    const attribute = geometry.getAttribute(property.attribute.toLowerCase());
    if (isMatrixType(type)) {
      const elements = target.elements;
      for (let i = 0, l = elements.length; i < l; i < l) {
        elements[i] = attribute.getComponent(id, i);
      }
    } else if (isVectorType(type)) {
      target.fromBufferAttribute(attribute, id);
    } else if (type === "SCALAR" || type === "ENUM") {
      target = attribute.getX(id);
    } else {
      throw new Error("StructuredMetadata.PropertyAttributeAccessor: BOOLEAN and STRING types are not supported by property attributes.");
    }
    target = property.adjustValueScaleOffset(target);
    target = property.resolveEnumsToStrings(target);
    target = property.resolveNoData(target);
    return target;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/PropertyTableAccessor.js
var PropertyTableClassProperty = class extends ClassProperty {
  constructor(enums, classProperty, tableProperty = null) {
    super(enums, classProperty, tableProperty);
    this.values = tableProperty.values;
    this.valueLength = typeToComponentCount(this.type);
    this.arrayOffsets = getField(tableProperty, "arrayOffsets", null);
    this.stringOffsets = getField(tableProperty, "stringOffsets", null);
    this.arrayOffsetType = getField(tableProperty, "arrayOffsetType", "UINT32");
    this.stringOffsetType = getField(tableProperty, "stringOffsetType", "UINT32");
  }
  // returns the necessary array length based on the array offsets if present
  getArrayLengthFromId(buffers, id) {
    let count = this.count;
    if (this.arrayOffsets !== null) {
      const { arrayOffsets, arrayOffsetType } = this;
      const bufferCons = getArrayConstructorFromComponentType(arrayOffsetType);
      const arr = new bufferCons(buffers[arrayOffsets]);
      count = arr[id + 1] - arr[id];
    }
    return count;
  }
  // returns the index offset into the data buffer for the given id based on the
  // the array offsets if present
  getIndexOffsetFromId(buffers, id) {
    let indexOffset = id;
    if (this.arrayOffsets) {
      const { arrayOffsets, arrayOffsetType } = this;
      const bufferCons = getArrayConstructorFromComponentType(arrayOffsetType);
      const arr = new bufferCons(buffers[arrayOffsets]);
      indexOffset = arr[indexOffset];
    } else if (this.array) {
      indexOffset *= this.count;
    }
    return indexOffset;
  }
};
var PropertyTableAccessor = class extends PropertySetAccessor {
  constructor(...args) {
    super(...args);
    this.isPropertyTableAccessor = true;
    this.count = this.definition.count;
    this._initProperties(PropertyTableClassProperty);
  }
  getData(id, target = {}) {
    const properties = this.properties;
    initializeFromClass(properties, target);
    for (const name in properties) {
      target[name] = this.getPropertyValue(name, id, target[name]);
    }
    return target;
  }
  // reads an individual element
  _readValueAtIndex(name, id, index, target = null) {
    const property = this.properties[name];
    const { componentType, type } = property;
    const buffers = this.data;
    const bufferView = buffers[property.values];
    const bufferCons = getArrayConstructorFromComponentType(componentType, type);
    const dataArray = new bufferCons(bufferView);
    const indexOffset = property.getIndexOffsetFromId(buffers, id);
    if (isNumericType(type) || type === "ENUM") {
      return readDataFromBufferToType(dataArray, (indexOffset + index) * property.valueLength, type, target);
    } else if (type === "STRING") {
      let stringIndex = indexOffset + index;
      let stringLength = 0;
      if (property.stringOffsets !== null) {
        const { stringOffsets, stringOffsetType } = property;
        const bufferCons2 = getArrayConstructorFromComponentType(stringOffsetType);
        const stringOffsetBuffer = new bufferCons2(buffers[stringOffsets]);
        stringLength = stringOffsetBuffer[stringIndex + 1] - stringOffsetBuffer[stringIndex];
        stringIndex = stringOffsetBuffer[stringIndex];
      }
      const byteArray = new Uint8Array(dataArray.buffer, stringIndex, stringLength);
      target = new TextDecoder().decode(byteArray);
    } else if (type === "BOOLEAN") {
      const offset = indexOffset + index;
      const byteIndex = Math.floor(offset / 8);
      const bitIndex = offset % 8;
      const bitValue = dataArray[byteIndex] >> bitIndex & 1;
      target = bitValue === 1;
    }
    return target;
  }
  // Reads the data for the given table index
  getPropertyValue(name, id, target = null) {
    if (id >= this.count) {
      throw new Error("PropertyTableAccessor: Requested index is outside the range of the table.");
    }
    const property = this.properties[name];
    if (!property) {
      throw new Error("PropertyTableAccessor: Requested property does not exist.");
    } else if (!this.definition.properties[name]) {
      return property.resolveDefault(target);
    }
    const array = property.array;
    const buffers = this.data;
    const count = property.getArrayLengthFromId(buffers, id);
    target = property.shapeToProperty(target, count);
    if (array) {
      for (let i = 0, l = target.length; i < l; i++) {
        target[i] = this._readValueAtIndex(name, id, i, target[i]);
      }
    } else {
      target = this._readValueAtIndex(name, id, 0, target);
    }
    target = property.adjustValueScaleOffset(target);
    target = property.resolveEnumsToStrings(target);
    target = property.resolveNoData(target);
    return target;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/PropertyTextureAccessor.js
import { Vector2 as Vector24 } from "three";

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/utilities/TextureReadUtility.js
import { WebGLRenderTarget, WebGLRenderer, Box2, Vector2 as Vector22, ShaderMaterial, CustomBlending, ZeroFactor, OneFactor } from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
var _box = /* @__PURE__ */ new Box2();
var _TextureReadUtility = class {
  constructor() {
    this._renderer = new WebGLRenderer();
    this._target = new WebGLRenderTarget(1, 1);
    this._texTarget = new WebGLRenderTarget();
    this._quad = new FullScreenQuad(new ShaderMaterial({
      blending: CustomBlending,
      blendDst: ZeroFactor,
      blendSrc: OneFactor,
      uniforms: {
        map: { value: null },
        pixel: { value: new Vector22() }
      },
      vertexShader: (
        /* glsl */
        `
				void main() {

					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

				}
			`
      ),
      fragmentShader: (
        /* glsl */
        `
				uniform sampler2D map;
				uniform ivec2 pixel;

				void main() {

					gl_FragColor = texelFetch( map, pixel, 0 );

				}
			`
      )
    }));
  }
  // increases the width of the target render target to support more data
  increaseSizeTo(width) {
    this._target.setSize(Math.max(this._target.width, width), 1);
  }
  // read data from the rendered texture asynchronously
  readDataAsync(buffer) {
    const { _renderer, _target } = this;
    return _renderer.readRenderTargetPixelsAsync(_target, 0, 0, buffer.length / 4, 1, buffer);
  }
  // read data from the rendered texture
  readData(buffer) {
    const { _renderer, _target } = this;
    _renderer.readRenderTargetPixels(_target, 0, 0, buffer.length / 4, 1, buffer);
  }
  // render a single pixel from the source at the destination point on the render target
  // takes the texture, pixel to read from, and pixel to render in to
  renderPixelToTarget(texture, pixel, dstPixel) {
    const { _renderer, _target } = this;
    _box.min.copy(pixel);
    _box.max.copy(pixel);
    _box.max.x += 1;
    _box.max.y += 1;
    _renderer.initRenderTarget(_target);
    _renderer.copyTextureToTexture(texture, _target.texture, _box, dstPixel, 0);
  }
};
var TextureReadUtility = /* @__PURE__ */ new class {
  constructor() {
    let reader = null;
    Object.getOwnPropertyNames(_TextureReadUtility.prototype).forEach((key) => {
      if (key !== "constructor") {
        this[key] = (...args) => {
          reader = reader || new _TextureReadUtility();
          return reader[key](...args);
        };
      }
    });
  }
}();

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/utilities/TexCoordUtilities.js
import { Vector2 as Vector23 } from "three";
var _uv0 = /* @__PURE__ */ new Vector23();
var _uv1 = /* @__PURE__ */ new Vector23();
var _uv2 = /* @__PURE__ */ new Vector23();
function getTextureCoordAttribute(geometry, index) {
  if (index === 0) {
    return geometry.getAttribute("uv");
  } else {
    return geometry.getAttribute(`uv${index}`);
  }
}
function getTriangleVertexIndices(geometry, faceIndex, target = new Array(3)) {
  let i0 = 3 * faceIndex;
  let i1 = 3 * faceIndex + 1;
  let i2 = 3 * faceIndex + 2;
  if (geometry.index) {
    i0 = geometry.index.getX(i0);
    i1 = geometry.index.getX(i1);
    i2 = geometry.index.getX(i2);
  }
  target[0] = i0;
  target[1] = i1;
  target[2] = i2;
  return target;
}
function getTexCoord(geometry, texCoord, barycoord, indices, target) {
  const [i0, i1, i2] = indices;
  const attr = getTextureCoordAttribute(geometry, texCoord);
  _uv0.fromBufferAttribute(attr, i0);
  _uv1.fromBufferAttribute(attr, i1);
  _uv2.fromBufferAttribute(attr, i2);
  target.set(0, 0, 0).addScaledVector(_uv0, barycoord.x).addScaledVector(_uv1, barycoord.y).addScaledVector(_uv2, barycoord.z);
}
function getTexelIndices(uv, width, height, target) {
  const fx = uv.x - Math.floor(uv.x);
  const fy = uv.y - Math.floor(uv.y);
  const px = Math.floor(fx * width % width);
  const py = Math.floor(fy * height % height);
  target.set(px, py);
  return target;
}

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/PropertyTextureAccessor.js
var _uv = /* @__PURE__ */ new Vector24();
var _srcPixel = /* @__PURE__ */ new Vector24();
var _dstPixel = /* @__PURE__ */ new Vector24();
var PropertyTextureClassProperty = class extends ClassProperty {
  constructor(enums, classProperty, textureProperty = null) {
    super(enums, classProperty, textureProperty);
    this.channels = getField(textureProperty, "channels", [0]);
    this.index = getField(textureProperty, "index", null);
    this.texCoord = getField(textureProperty, "texCoord", null);
    this.valueLength = parseInt(this.type.replace(/[^0-9]/g, "")) || 1;
  }
  // takes the buffer to read from and the value index to read
  readDataFromBuffer(buffer, index, target = null) {
    const type = this.type;
    if (type === "BOOLEAN" || type === "STRING") {
      throw new Error("PropertyTextureAccessor: BOOLEAN and STRING types not supported.");
    }
    return readDataFromBufferToType(buffer, index * this.valueLength, type, target);
  }
};
var PropertyTextureAccessor = class extends PropertySetAccessor {
  constructor(...args) {
    super(...args);
    this.isPropertyTextureAccessor = true;
    this._asyncRead = false;
    this._initProperties(PropertyTextureClassProperty);
  }
  // Reads the full set of property data
  getData(faceIndex, barycoord, geometry, target = {}) {
    const properties = this.properties;
    initializeFromClass(properties, target);
    const names = Object.keys(properties);
    const results = names.map((n) => target[n]);
    this.getPropertyValuesAtTexel(names, faceIndex, barycoord, geometry, results);
    names.forEach((n, i) => target[n] = results[i]);
    return target;
  }
  // Reads the full set of property data asynchronously
  async getDataAsync(faceIndex, barycoord, geometry, target = {}) {
    const properties = this.properties;
    initializeFromClass(properties, target);
    const names = Object.keys(properties);
    const results = names.map((n) => target[n]);
    await this.getPropertyValuesAtTexelAsync(names, faceIndex, barycoord, geometry, results);
    names.forEach((n, i) => target[n] = results[i]);
    return target;
  }
  // Reads values asynchronously
  getPropertyValuesAtTexelAsync(...args) {
    this._asyncRead = true;
    const result = this.getPropertyValuesAtTexel(...args);
    this._asyncRead = false;
    return result;
  }
  // Reads values from the textures synchronously
  getPropertyValuesAtTexel(names, faceIndex, barycoord, geometry, target = []) {
    while (target.length < names.length) target.push(null);
    target.length = names.length;
    TextureReadUtility.increaseSizeTo(target.length);
    const textures = this.data;
    const accessorProperties = this.definition.properties;
    const properties = this.properties;
    const indices = getTriangleVertexIndices(geometry, faceIndex);
    for (let i = 0, l = names.length; i < l; i++) {
      const name = names[i];
      if (!accessorProperties[name]) {
        continue;
      }
      const property = properties[name];
      const texture = textures[property.index];
      getTexCoord(geometry, property.texCoord, barycoord, indices, _uv);
      getTexelIndices(_uv, texture.image.width, texture.image.height, _srcPixel);
      _dstPixel.set(i, 0);
      TextureReadUtility.renderPixelToTarget(texture, _srcPixel, _dstPixel);
    }
    const buffer = new Uint8Array(names.length * 4);
    if (this._asyncRead) {
      return TextureReadUtility.readDataAsync(buffer).then(() => {
        readTextureSampleResults.call(this);
        return target;
      });
    } else {
      TextureReadUtility.readData(buffer);
      readTextureSampleResults.call(this);
      return target;
    }
    function readTextureSampleResults() {
      for (let i = 0, l = names.length; i < l; i++) {
        const name = names[i];
        const property = properties[name];
        const type = property.type;
        target[i] = initializeFromProperty(property, target[i]);
        if (!property) {
          throw new Error("PropertyTextureAccessor: Requested property does not exist.");
        } else if (!accessorProperties[name]) {
          target[i] = property.resolveDefault(target);
          continue;
        }
        const length = property.valueLength * (property.count || 1);
        const data = property.channels.map((c) => buffer[4 * i + c]);
        const componentType = property.componentType;
        const BufferCons = getArrayConstructorFromComponentType(componentType, type);
        const readBuffer = new BufferCons(length);
        new Uint8Array(readBuffer.buffer).set(data);
        if (property.array) {
          const arr = target[i];
          for (let j = 0, lj = arr.length; j < lj; j++) {
            arr[j] = property.readDataFromBuffer(readBuffer, j, arr[j]);
          }
        } else {
          target[i] = property.readDataFromBuffer(readBuffer, 0, target[i]);
        }
        target[i] = property.adjustValueScaleOffset(target[i]);
        target[i] = property.resolveEnumsToStrings(target[i]);
        target[i] = property.resolveNoData(target[i]);
      }
    }
  }
  // dispose all of the texture data used
  dispose() {
    this.data.forEach((texture) => {
      if (texture) {
        texture.dispose();
        if (texture.image instanceof ImageBitmap) {
          texture.image.close();
        }
      }
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/StructuralMetadata.js
var StructuralMetadata = class {
  constructor(definition, textures, buffers, nodeMetadata = null, object = null) {
    const {
      schema,
      propertyTables = [],
      propertyTextures = [],
      propertyAttributes = []
    } = definition;
    const { enums, classes } = schema;
    const tableAccessors = propertyTables.map((t) => new PropertyTableAccessor(t, classes, enums, buffers));
    let textureAccessors = [];
    let attributeAccessors = [];
    if (nodeMetadata) {
      if (nodeMetadata.propertyTextures) {
        textureAccessors = nodeMetadata.propertyTextures.map((i) => new PropertyTextureAccessor(propertyTextures[i], classes, enums, textures));
      }
      if (nodeMetadata.propertyAttributes) {
        attributeAccessors = nodeMetadata.propertyAttributes.map((i) => new PropertyAttributeAccessor(propertyAttributes[i], classes, enums));
      }
    }
    this.schema = schema;
    this.tableAccessors = tableAccessors;
    this.textureAccessors = textureAccessors;
    this.attributeAccessors = attributeAccessors;
    this.object = object;
    this.textures = textures;
    this.nodeMetadata = nodeMetadata;
  }
  // Property Tables
  getPropertyTableData(tableIndices, ids, target = null) {
    if (!Array.isArray(tableIndices) || !Array.isArray(ids)) {
      target = target || {};
      const table = this.tableAccessors[tableIndices];
      target = table.getData(ids, target);
    } else {
      target = target || [];
      const length = Math.min(tableIndices.length, ids.length);
      target.length = length;
      for (let i = 0; i < length; i++) {
        const table = this.tableAccessors[tableIndices[i]];
        target[i] = table.getData(ids[i], target[i]);
      }
    }
    return target;
  }
  getPropertyTableInfo(tableIndices = null) {
    if (tableIndices === null) {
      tableIndices = this.tableAccessors.map((t, i) => i);
    }
    if (Array.isArray(tableIndices)) {
      return tableIndices.map((i) => {
        const table = this.tableAccessors[i];
        return {
          name: table.name,
          className: table.definition.class
        };
      });
    } else {
      const table = this.tableAccessors[tableIndices];
      return {
        name: table.name,
        className: table.definition.class
      };
    }
  }
  // Property Textures
  getPropertyTextureData(triangle, barycoord, target = []) {
    const textureAccessors = this.textureAccessors;
    target.length = textureAccessors.length;
    for (let i = 0; i < textureAccessors.length; i++) {
      const accessor = textureAccessors[i];
      target[i] = accessor.getData(triangle, barycoord, this.object.geometry, target[i]);
    }
    return target;
  }
  async getPropertyTextureDataAsync(triangle, barycoord, target = []) {
    const textureAccessors = this.textureAccessors;
    target.length = textureAccessors.length;
    const promises = [];
    for (let i = 0; i < textureAccessors.length; i++) {
      const accessor = textureAccessors[i];
      const promise = accessor.getDataAsync(triangle, barycoord, this.object.geometry, target[i]).then((result) => {
        target[i] = result;
      });
      promises.push(promise);
    }
    await Promise.all(promises);
    return target;
  }
  getPropertyTextureInfo() {
    return this.textureAccessors;
  }
  // Property Attributes
  getPropertyAttributeData(attributeIndex, target = []) {
    const attributeAccessors = this.attributeAccessors;
    target.length = attributeAccessors.length;
    for (let i = 0; i < attributeAccessors.length; i++) {
      const accessor = attributeAccessors[i];
      target[i] = accessor.getData(attributeIndex, this.object.geometry, target[i]);
    }
    return target;
  }
  getPropertyAttributeInfo() {
    return this.attributeAccessors.map((acc) => {
      return {
        name: acc.name,
        className: acc.definition.class
      };
    });
  }
  dispose() {
    this.textureAccessors.forEach((acc) => acc.dispose());
    this.tableAccessors.forEach((acc) => acc.dispose());
    this.attributeAccessors.forEach((acc) => acc.dispose());
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/GLTFStructuralMetadataExtension.js
var EXT_NAME = "EXT_structural_metadata";
function getRelevantTextures(parser, propertyTextures = []) {
  const textureCount = parser.json.textures?.length || 0;
  const result = new Array(textureCount).fill(null);
  propertyTextures.forEach(({ properties }) => {
    for (const key in properties) {
      const { index } = properties[key];
      if (result[index] === null) {
        result[index] = parser.loadTexture(index);
      }
    }
  });
  return Promise.all(result);
}
function getRelevantBuffers(parser, propertyTables = []) {
  const textureCount = parser.json.bufferViews?.length || 0;
  const result = new Array(textureCount).fill(null);
  propertyTables.forEach(({ properties }) => {
    for (const key in properties) {
      const { values, arrayOffsets, stringOffsets } = properties[key];
      if (result[values] === null) {
        result[values] = parser.loadBufferView(values);
      }
      if (result[arrayOffsets] === null) {
        result[arrayOffsets] = parser.loadBufferView(arrayOffsets);
      }
      if (result[stringOffsets] === null) {
        result[stringOffsets] = parser.loadBufferView(stringOffsets);
      }
    }
  });
  return Promise.all(result);
}
var GLTFStructuralMetadataExtension = class {
  constructor(parser) {
    this.parser = parser;
    this.name = EXT_NAME;
  }
  async afterRoot({ scene, parser }) {
    const extensionsUsed = parser.json.extensionsUsed;
    if (!extensionsUsed || !extensionsUsed.includes(EXT_NAME)) {
      return;
    }
    let schemaPromise = null;
    let rootExtension = parser.json.extensions[EXT_NAME];
    if (rootExtension.schemaUri) {
      const { manager, path, requestHeader, crossOrigin } = parser.options;
      const finalUri = new URL(rootExtension.schemaUri, path).toString();
      const fileLoader = new FileLoader(manager);
      fileLoader.setCrossOrigin(crossOrigin);
      fileLoader.setResponseType("json");
      fileLoader.setRequestHeader(requestHeader);
      schemaPromise = fileLoader.loadAsync(finalUri).then((schema) => {
        rootExtension = { ...rootExtension, schema };
      });
    }
    const [textures, buffers] = await Promise.all([
      getRelevantTextures(parser, rootExtension.propertyTextures),
      getRelevantBuffers(parser, rootExtension.propertyTables),
      schemaPromise
    ]);
    const rootMetadata = new StructuralMetadata(rootExtension, textures, buffers);
    scene.userData.structuralMetadata = rootMetadata;
    scene.traverse((child) => {
      if (parser.associations.has(child)) {
        const { meshes, primitives } = parser.associations.get(child);
        const primitive = parser.json.meshes[meshes].primitives[primitives];
        if (primitive && primitive.extensions && primitive.extensions[EXT_NAME]) {
          const extension = primitive.extensions[EXT_NAME];
          child.userData.structuralMetadata = new StructuralMetadata(rootExtension, textures, buffers, extension, child);
        } else {
          child.userData.structuralMetadata = rootMetadata;
        }
      }
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/metadata/classes/MeshFeatures.js
import { Vector2 as Vector25 } from "three";
var _uv3 = /* @__PURE__ */ new Vector25();
var _pixel = /* @__PURE__ */ new Vector25();
var _dstPixel2 = /* @__PURE__ */ new Vector25();
function getMaxBarycoordIndex(barycoord) {
  if (barycoord.x > barycoord.y && barycoord.x > barycoord.z) {
    return 0;
  } else if (barycoord.y > barycoord.z) {
    return 1;
  } else {
    return 2;
  }
}
var MeshFeatures = class {
  constructor(geometry, textures, data) {
    this.geometry = geometry;
    this.textures = textures;
    this.data = data;
    this._asyncRead = false;
    this.featureIds = data.featureIds.map((info) => {
      const { texture, ...rest } = info;
      const result = {
        label: null,
        propertyTable: null,
        nullFeatureId: null,
        ...rest
      };
      if (texture) {
        result.texture = {
          texCoord: 0,
          channels: [0],
          ...texture
        };
      }
      return result;
    });
  }
  // returns list of textures
  getTextures() {
    return this.textures;
  }
  // returns a set of info for each feature
  getFeatureInfo() {
    return this.featureIds;
  }
  // performs texture data read back asynchronously
  getFeaturesAsync(...args) {
    this._asyncRead = true;
    const result = this.getFeatures(...args);
    this._asyncRead = false;
    return result;
  }
  // returns all features for the given point on the given triangle
  getFeatures(triangle, barycoord) {
    const { geometry, textures, featureIds } = this;
    const result = new Array(featureIds.length).fill(null);
    const width = featureIds.length;
    TextureReadUtility.increaseSizeTo(width);
    const indices = getTriangleVertexIndices(geometry, triangle);
    const closestIndex = indices[getMaxBarycoordIndex(barycoord)];
    for (let i = 0, l = featureIds.length; i < l; i++) {
      const featureId = featureIds[i];
      const nullFeatureId = "nullFeatureId" in featureId ? featureId.nullFeatureId : null;
      if ("texture" in featureId) {
        const texture = textures[featureId.texture.index];
        getTexCoord(geometry, featureId.texture.texCoord, barycoord, indices, _uv3);
        getTexelIndices(_uv3, texture.image.width, texture.image.height, _pixel);
        _dstPixel2.set(i, 0);
        TextureReadUtility.renderPixelToTarget(textures[featureId.texture.index], _pixel, _dstPixel2);
      } else if ("attribute" in featureId) {
        const attr = geometry.getAttribute(`_feature_id_${featureId.attribute}`);
        const value = attr.getX(closestIndex);
        if (value !== nullFeatureId) {
          result[i] = value;
        }
      } else {
        const value = closestIndex;
        if (value !== nullFeatureId) {
          result[i] = value;
        }
      }
    }
    const buffer = new Uint8Array(width * 4);
    if (this._asyncRead) {
      return TextureReadUtility.readDataAsync(buffer).then(() => {
        readTextureSampleResults();
        return result;
      });
    } else {
      TextureReadUtility.readData(buffer);
      readTextureSampleResults();
      return result;
    }
    function readTextureSampleResults() {
      const readBuffer = new Uint32Array(1);
      for (let i = 0, l = featureIds.length; i < l; i++) {
        const featureId = featureIds[i];
        const nullFeatureId = "nullFeatureId" in featureId ? featureId.nullFeatureId : null;
        if ("texture" in featureId) {
          const { channels } = featureId.texture;
          const data = channels.map((c) => buffer[4 * i + c]);
          new Uint8Array(readBuffer.buffer).set(data);
          const value = readBuffer[0];
          if (value !== nullFeatureId) {
            result[i] = value;
          }
        }
      }
    }
  }
  // dispose all of the texture data used
  dispose() {
    this.textures.forEach((texture) => {
      if (texture) {
        texture.dispose();
        if (texture.image instanceof ImageBitmap) {
          texture.image.close();
        }
      }
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/GLTFMeshFeaturesExtension.js
var EXT_NAME2 = "EXT_mesh_features";
function forEachPrimitiveExtension(scene, parser, callback) {
  scene.traverse((c) => {
    if (parser.associations.has(c)) {
      const { meshes, primitives } = parser.associations.get(c);
      const primitive = parser.json.meshes[meshes].primitives[primitives];
      if (primitive && primitive.extensions && primitive.extensions[EXT_NAME2]) {
        callback(c, primitive.extensions[EXT_NAME2]);
      }
    }
  });
}
var GLTFMeshFeaturesExtension = class {
  constructor(parser) {
    this.parser = parser;
    this.name = EXT_NAME2;
  }
  async afterRoot({ scene, parser }) {
    const extensionsUsed = parser.json.extensionsUsed;
    if (!extensionsUsed || !extensionsUsed.includes(EXT_NAME2)) {
      return;
    }
    const textureCount = parser.json.textures?.length || 0;
    const promises = new Array(textureCount).fill(null);
    forEachPrimitiveExtension(scene, parser, (child, { featureIds }) => {
      featureIds.forEach((info) => {
        if (info.texture && promises[info.texture.index] === null) {
          const index = info.texture.index;
          promises[index] = parser.loadTexture(index);
        }
      });
    });
    const textures = await Promise.all(promises);
    forEachPrimitiveExtension(scene, parser, (child, extension) => {
      child.userData.meshFeatures = new MeshFeatures(child.geometry, textures, extension);
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/gltf/GLTFCesiumRTCExtension.js
var GLTFCesiumRTCExtension = class {
  constructor() {
    this.name = "CESIUM_RTC";
  }
  afterRoot(res) {
    if (res.parser.json.extensions && res.parser.json.extensions.CESIUM_RTC) {
      const { center } = res.parser.json.extensions.CESIUM_RTC;
      if (center) {
        res.scene.position.x += center[0];
        res.scene.position.y += center[1];
        res.scene.position.z += center[2];
      }
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/GLTFExtensionsPlugin.js
var GLTFExtensionsPlugin = class {
  constructor(options) {
    options = {
      metadata: true,
      rtc: true,
      plugins: [],
      dracoLoader: null,
      ktxLoader: null,
      meshoptDecoder: null,
      autoDispose: true,
      ...options
    };
    this.tiles = null;
    this.metadata = options.metadata;
    this.rtc = options.rtc;
    this.plugins = options.plugins;
    this.dracoLoader = options.dracoLoader;
    this.ktxLoader = options.ktxLoader;
    this.meshoptDecoder = options.meshoptDecoder;
    this._gltfRegex = /\.(gltf|glb)$/g;
    this._dracoRegex = /\.drc$/g;
    this._loader = null;
  }
  init(tiles) {
    const loader = new GLTFLoader(tiles.manager);
    if (this.dracoLoader) {
      loader.setDRACOLoader(this.dracoLoader);
      tiles.manager.addHandler(this._dracoRegex, this.dracoLoader);
    }
    if (this.ktxLoader) {
      loader.setKTX2Loader(this.ktxLoader);
    }
    if (this.meshoptDecoder) {
      loader.setMeshoptDecoder(this.meshoptDecoder);
    }
    if (this.rtc) {
      loader.register(() => new GLTFCesiumRTCExtension());
    }
    if (this.metadata) {
      loader.register(() => new GLTFStructuralMetadataExtension());
      loader.register(() => new GLTFMeshFeaturesExtension());
    }
    this.plugins.forEach((plugin) => loader.register(plugin));
    tiles.manager.addHandler(this._gltfRegex, loader);
    this.tiles = tiles;
    this._loader = loader;
  }
  dispose() {
    this.tiles.manager.removeHandler(this._gltfRegex);
    this.tiles.manager.removeHandler(this._dracoRegex);
    if (this.autoDispose) {
      this.ktxLoader.dispose();
      this.dracoLoader.dispose();
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/ReorientationPlugin.js
import { Sphere as Sphere2, Vector3 as Vector35 } from "three";

// node_modules/3d-tiles-renderer/src/three/math/Ellipsoid.js
import { Vector3 as Vector34, Spherical as Spherical2, MathUtils as MathUtils3, Ray, Matrix4 as Matrix43, Sphere, Euler } from "three";

// node_modules/3d-tiles-renderer/src/three/math/GeoUtils.js
import { Spherical, Vector3 as Vector33, MathUtils as MathUtils2 } from "three";
var _spherical = new Spherical();
var _vec2 = new Vector33();
function swapToGeoFrame(target) {
  const { x, y, z } = target;
  target.x = z;
  target.y = x;
  target.z = y;
}
function latitudeToSphericalPhi(latitude) {
  return -latitude + Math.PI / 2;
}

// node_modules/3d-tiles-renderer/src/three/math/Ellipsoid.js
var _spherical2 = new Spherical2();
var _norm = new Vector34();
var _vec3 = new Vector34();
var _vec22 = new Vector34();
var _matrix2 = new Matrix43();
var _matrix22 = new Matrix43();
var _sphere = new Sphere();
var _euler = new Euler();
var _vecX = new Vector34();
var _vecY = new Vector34();
var _vecZ = new Vector34();
var _pos = new Vector34();
var _ray = new Ray();
var EPSILON12 = 1e-12;
var CENTER_EPS = 0.1;
var ENU_FRAME = 0;
var CAMERA_FRAME = 1;
var OBJECT_FRAME = 2;
var Ellipsoid = class {
  constructor(x = 1, y = 1, z = 1) {
    this.name = "";
    this.radius = new Vector34(x, y, z);
  }
  intersectRay(ray, target) {
    _matrix2.makeScale(...this.radius).invert();
    _sphere.center.set(0, 0, 0);
    _sphere.radius = 1;
    _ray.copy(ray).applyMatrix4(_matrix2);
    if (_ray.intersectSphere(_sphere, target)) {
      _matrix2.makeScale(...this.radius);
      target.applyMatrix4(_matrix2);
      return target;
    } else {
      return null;
    }
  }
  // returns a frame with Z indicating altitude
  // Y pointing north
  // X pointing east
  getEastNorthUpFrame(lat, lon, target) {
    this.getEastNorthUpAxes(lat, lon, _vecX, _vecY, _vecZ, _pos);
    return target.makeBasis(_vecX, _vecY, _vecZ).setPosition(_pos);
  }
  getEastNorthUpAxes(lat, lon, vecEast, vecNorth, vecUp, point = _pos) {
    this.getCartographicToPosition(lat, lon, 0, point);
    this.getCartographicToNormal(lat, lon, vecUp);
    vecEast.set(-point.y, point.x, 0).normalize();
    vecNorth.crossVectors(vecUp, vecEast).normalize();
  }
  // azimuth: measured off of true north, increasing towards "east"
  // elevation: measured off of the horizon, increasing towards sky
  // roll: rotation around northern axis
  getAzElRollFromRotationMatrix(lat, lon, rotationMatrix, target, frame = ENU_FRAME) {
    if (frame === CAMERA_FRAME) {
      _euler.set(-Math.PI / 2, 0, 0, "XYZ");
      _matrix22.makeRotationFromEuler(_euler).premultiply(rotationMatrix);
    } else if (frame === OBJECT_FRAME) {
      _euler.set(-Math.PI / 2, 0, Math.PI, "XYZ");
      _matrix22.makeRotationFromEuler(_euler).premultiply(rotationMatrix);
    } else {
      _matrix22.copy(rotationMatrix);
    }
    this.getEastNorthUpFrame(lat, lon, _matrix2).invert();
    _matrix22.premultiply(_matrix2);
    _euler.setFromRotationMatrix(_matrix22, "ZXY");
    target.azimuth = -_euler.z;
    target.elevation = _euler.x;
    target.roll = _euler.y;
    return target;
  }
  getRotationMatrixFromAzElRoll(lat, lon, az, el, roll, target, frame = ENU_FRAME) {
    this.getEastNorthUpFrame(lat, lon, _matrix2);
    _euler.set(el, roll, -az, "ZXY");
    target.makeRotationFromEuler(_euler).premultiply(_matrix2).setPosition(0, 0, 0);
    if (frame === CAMERA_FRAME) {
      _euler.set(Math.PI / 2, 0, 0, "XYZ");
      _matrix22.makeRotationFromEuler(_euler);
      target.multiply(_matrix22);
    } else if (frame === OBJECT_FRAME) {
      _euler.set(-Math.PI / 2, 0, Math.PI, "XYZ");
      _matrix22.makeRotationFromEuler(_euler);
      target.multiply(_matrix22);
    }
    return target;
  }
  getFrame(lat, lon, az, el, roll, height, target, frame = ENU_FRAME) {
    this.getRotationMatrixFromAzElRoll(lat, lon, az, el, roll, target, frame);
    this.getCartographicToPosition(lat, lon, height, _pos);
    target.setPosition(_pos);
    return target;
  }
  getCartographicToPosition(lat, lon, height, target) {
    this.getCartographicToNormal(lat, lon, _norm);
    const radius = this.radius;
    _vec3.copy(_norm);
    _vec3.x *= radius.x ** 2;
    _vec3.y *= radius.y ** 2;
    _vec3.z *= radius.z ** 2;
    const gamma = Math.sqrt(_norm.dot(_vec3));
    _vec3.divideScalar(gamma);
    return target.copy(_vec3).addScaledVector(_norm, height);
  }
  getPositionToCartographic(pos, target) {
    this.getPositionToSurfacePoint(pos, _vec3);
    this.getPositionToNormal(pos, _norm);
    const heightDelta = _vec22.subVectors(pos, _vec3);
    target.lon = Math.atan2(_norm.y, _norm.x);
    target.lat = Math.asin(_norm.z);
    target.height = Math.sign(heightDelta.dot(pos)) * heightDelta.length();
    return target;
  }
  getCartographicToNormal(lat, lon, target) {
    _spherical2.set(1, latitudeToSphericalPhi(lat), lon);
    target.setFromSpherical(_spherical2).normalize();
    swapToGeoFrame(target);
    return target;
  }
  getPositionToNormal(pos, target) {
    const radius = this.radius;
    target.copy(pos);
    target.x /= radius.x ** 2;
    target.y /= radius.y ** 2;
    target.z /= radius.z ** 2;
    target.normalize();
    return target;
  }
  getPositionToSurfacePoint(pos, target) {
    const radius = this.radius;
    const invRadiusSqX = 1 / radius.x ** 2;
    const invRadiusSqY = 1 / radius.y ** 2;
    const invRadiusSqZ = 1 / radius.z ** 2;
    const x2 = pos.x * pos.x * invRadiusSqX;
    const y2 = pos.y * pos.y * invRadiusSqY;
    const z2 = pos.z * pos.z * invRadiusSqZ;
    const squaredNorm = x2 + y2 + z2;
    const ratio = Math.sqrt(1 / squaredNorm);
    const intersection = _vec3.copy(pos).multiplyScalar(ratio);
    if (squaredNorm < CENTER_EPS) {
      return !isFinite(ratio) ? null : target.copy(intersection);
    }
    const gradient = _vec22.set(
      intersection.x * invRadiusSqX * 2,
      intersection.y * invRadiusSqY * 2,
      intersection.z * invRadiusSqZ * 2
    );
    let lambda = (1 - ratio) * pos.length() / (0.5 * gradient.length());
    let correction = 0;
    let func, denominator;
    let xMultiplier, yMultiplier, zMultiplier;
    let xMultiplier2, yMultiplier2, zMultiplier2;
    let xMultiplier3, yMultiplier3, zMultiplier3;
    do {
      lambda -= correction;
      xMultiplier = 1 / (1 + lambda * invRadiusSqX);
      yMultiplier = 1 / (1 + lambda * invRadiusSqY);
      zMultiplier = 1 / (1 + lambda * invRadiusSqZ);
      xMultiplier2 = xMultiplier * xMultiplier;
      yMultiplier2 = yMultiplier * yMultiplier;
      zMultiplier2 = zMultiplier * zMultiplier;
      xMultiplier3 = xMultiplier2 * xMultiplier;
      yMultiplier3 = yMultiplier2 * yMultiplier;
      zMultiplier3 = zMultiplier2 * zMultiplier;
      func = x2 * xMultiplier2 + y2 * yMultiplier2 + z2 * zMultiplier2 - 1;
      denominator = x2 * xMultiplier3 * invRadiusSqX + y2 * yMultiplier3 * invRadiusSqY + z2 * zMultiplier3 * invRadiusSqZ;
      const derivative = -2 * denominator;
      correction = func / derivative;
    } while (Math.abs(func) > EPSILON12);
    return target.set(
      pos.x * xMultiplier,
      pos.y * yMultiplier,
      pos.z * zMultiplier
    );
  }
  calculateHorizonDistance(latitude, elevation) {
    const effectiveRadius = this.calculateEffectiveRadius(latitude);
    return Math.sqrt(2 * effectiveRadius * elevation + elevation ** 2);
  }
  calculateEffectiveRadius(latitude) {
    const semiMajorAxis = this.radius.x;
    const semiMinorAxis = this.radius.z;
    const eSquared = 1 - semiMinorAxis ** 2 / semiMajorAxis ** 2;
    const phi = latitude * MathUtils3.DEG2RAD;
    const sinPhiSquared = Math.sin(phi) ** 2;
    const N = semiMajorAxis / Math.sqrt(1 - eSquared * sinPhiSquared);
    return N;
  }
  getPositionElevation(pos) {
    this.getPositionToSurfacePoint(pos, _vec3);
    const heightDelta = _vec22.subVectors(pos, _vec3);
    return Math.sign(heightDelta.dot(pos)) * heightDelta.length();
  }
  copy(source) {
    this.radius.copy(source.radius);
    return this;
  }
  clone() {
    return new this.constructor().copy(this);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/ReorientationPlugin.js
var sphere = /* @__PURE__ */ new Sphere2();
var vec = /* @__PURE__ */ new Vector35();
var ReorientationPlugin = class {
  constructor(options) {
    options = {
      up: "+z",
      recenter: true,
      lat: null,
      lon: null,
      height: 0,
      ...options
    };
    this.tiles = null;
    this.up = options.up.toLowerCase().replace(/\s+/, "");
    this.lat = options.lat;
    this.lon = options.lon;
    this.height = options.height;
    this.recenter = options.recenter;
    this._callback = null;
  }
  init(tiles) {
    this.tiles = tiles;
    this._callback = () => {
      const { up, lat, lon, height, recenter } = this;
      if (lat !== null && lon !== null) {
        this.transformLatLonHeightToOrigin(lat, lon, height);
      } else {
        const { ellipsoid } = tiles;
        const minRadii = Math.min(...ellipsoid.radius);
        tiles.getBoundingSphere(sphere);
        if (sphere.center.length() > minRadii * 0.5) {
          const cart = {};
          ellipsoid.getPositionToCartographic(sphere.center, cart);
          this.transformLatLonHeightToOrigin(cart.lat, cart.lon, cart.height);
        } else {
          const group = tiles.group;
          group.rotation.set(0, 0, 0);
          switch (up) {
            case "x":
            case "+x":
              group.rotation.z = Math.PI / 2;
              break;
            case "-x":
              group.rotation.z = -Math.PI / 2;
              break;
            case "y":
            case "+y":
              break;
            case "-y":
              group.rotation.z = Math.PI;
              break;
            case "z":
            case "+z":
              group.rotation.x = -Math.PI / 2;
              break;
            case "-z":
              group.rotation.x = Math.PI / 2;
              break;
          }
          tiles.group.position.copy(sphere.center).applyEuler(group.rotation).multiplyScalar(-1);
        }
      }
      if (!recenter) {
        tiles.group.position.setScalar(0);
      }
      tiles.removeEventListener("load-tile-set", this._callback);
    };
    tiles.addEventListener("load-tile-set", this._callback);
  }
  transformLatLonHeightToOrigin(lat, lon, height = 0) {
    const { group, ellipsoid } = this.tiles;
    ellipsoid.getRotationMatrixFromAzElRoll(lat, lon, 0, 0, 0, group.matrix, OBJECT_FRAME);
    ellipsoid.getCartographicToPosition(lat, lon, height, vec);
    group.matrix.setPosition(vec).invert().decompose(group.position, group.quaternion, group.scale);
    group.updateMatrixWorld();
  }
  dispose() {
    const { group } = this.tiles;
    group.position.setScalar(0);
    group.quaternion.identity();
    group.scale.set(1, 1, 1);
    this.tiles.addEventListener("load-tile-set", this._callback);
  }
};

// node_modules/3d-tiles-renderer/src/utilities/LRUCache.js
var GIGABYTE_BYTES = 2 ** 30;
var LRUCache = class {
  get unloadPriorityCallback() {
    return this._unloadPriorityCallback;
  }
  set unloadPriorityCallback(cb) {
    if (cb.length === 1) {
      console.warn('LRUCache: "unloadPriorityCallback" function has been changed to take two arguments.');
      this._unloadPriorityCallback = (a, b) => {
        const valA = cb(a);
        const valB = cb(b);
        if (valA < valB) return -1;
        if (valA > valB) return 1;
        return 0;
      };
    } else {
      this._unloadPriorityCallback = cb;
    }
  }
  constructor() {
    this.minSize = 6e3;
    this.maxSize = 8e3;
    this.minBytesSize = 0.3 * GIGABYTE_BYTES;
    this.maxBytesSize = 0.4 * GIGABYTE_BYTES;
    this.unloadPercent = 0.05;
    this.autoMarkUnused = true;
    this.itemSet = /* @__PURE__ */ new Map();
    this.itemList = [];
    this.usedSet = /* @__PURE__ */ new Set();
    this.callbacks = /* @__PURE__ */ new Map();
    this.unloadingHandle = -1;
    this.cachedBytes = 0;
    this.bytesMap = /* @__PURE__ */ new Map();
    this.loadedSet = /* @__PURE__ */ new Set();
    this._unloadPriorityCallback = null;
    this.computeMemoryUsageCallback = () => null;
    const itemSet = this.itemSet;
    this.defaultPriorityCallback = (item) => itemSet.get(item);
  }
  // Returns whether or not the cache has reached the maximum size
  isFull() {
    return this.itemSet.size >= this.maxSize || this.cachedBytes >= this.maxBytesSize;
  }
  getMemoryUsage(item) {
    return this.bytesMap.get(item) ?? null;
  }
  add(item, removeCb) {
    const itemSet = this.itemSet;
    if (itemSet.has(item)) {
      return false;
    }
    if (this.isFull()) {
      return false;
    }
    const usedSet = this.usedSet;
    const itemList = this.itemList;
    const callbacks = this.callbacks;
    const bytesMap = this.bytesMap;
    itemList.push(item);
    usedSet.add(item);
    itemSet.set(item, Date.now());
    callbacks.set(item, removeCb);
    const bytes = this.computeMemoryUsageCallback(item);
    this.cachedBytes += bytes || 0;
    bytesMap.set(item, bytes);
    return true;
  }
  has(item) {
    return this.itemSet.has(item);
  }
  remove(item) {
    const usedSet = this.usedSet;
    const itemSet = this.itemSet;
    const itemList = this.itemList;
    const bytesMap = this.bytesMap;
    const callbacks = this.callbacks;
    const loadedSet = this.loadedSet;
    if (itemSet.has(item)) {
      this.cachedBytes -= bytesMap.get(item) || 0;
      bytesMap.delete(item);
      callbacks.get(item)(item);
      const index = itemList.indexOf(item);
      itemList.splice(index, 1);
      usedSet.delete(item);
      itemSet.delete(item);
      callbacks.delete(item);
      loadedSet.delete(item);
      return true;
    }
    return false;
  }
  // Marks whether tiles in the cache have been completely loaded or not. Tiles that have not been completely
  // loaded are subject to being disposed early if the cache is full above its max size limits, even if they
  // are marked as used.
  setLoaded(item, value) {
    const { itemSet, loadedSet } = this;
    if (itemSet.has(item)) {
      if (value === true) {
        loadedSet.add(item);
      } else {
        loadedSet.delete(item);
      }
    }
  }
  updateMemoryUsage(item) {
    const itemSet = this.itemSet;
    const bytesMap = this.bytesMap;
    if (!itemSet.has(item)) {
      return;
    }
    this.cachedBytes -= bytesMap.get(item) || 0;
    const bytes = this.computeMemoryUsageCallback(item);
    bytesMap.set(item, bytes);
    this.cachedBytes += bytes;
  }
  markUsed(item) {
    const itemSet = this.itemSet;
    const usedSet = this.usedSet;
    if (itemSet.has(item) && !usedSet.has(item)) {
      itemSet.set(item, Date.now());
      usedSet.add(item);
    }
  }
  markUnused(item) {
    this.usedSet.delete(item);
  }
  markAllUnused() {
    this.usedSet.clear();
  }
  // TODO: this should be renamed because it's not necessarily unloading all unused content
  // Maybe call it "cleanup" or "unloadToMinSize"
  unloadUnusedContent() {
    const {
      unloadPercent,
      minSize,
      maxSize,
      itemList,
      itemSet,
      usedSet,
      loadedSet,
      callbacks,
      bytesMap,
      minBytesSize,
      maxBytesSize
    } = this;
    const unused = itemList.length - usedSet.size;
    const unloaded = itemList.length - loadedSet.size;
    const excessNodes = Math.max(Math.min(itemList.length - minSize, unused), 0);
    const excessBytes = this.cachedBytes - minBytesSize;
    const unloadPriorityCallback = this.unloadPriorityCallback || this.defaultPriorityCallback;
    let needsRerun = false;
    const hasNodesToUnload = excessNodes > 0 && unused > 0 || unloaded && itemList.length > maxSize;
    const hasBytesToUnload = unused && this.cachedBytes > minBytesSize || unloaded && this.cachedBytes > maxBytesSize;
    if (hasBytesToUnload || hasNodesToUnload) {
      itemList.sort((a, b) => {
        const usedA = usedSet.has(a);
        const usedB = usedSet.has(b);
        if (usedA === usedB) {
          const loadedA = loadedSet.has(a);
          const loadedB = loadedSet.has(b);
          if (loadedA === loadedB) {
            return -unloadPriorityCallback(a, b);
          } else {
            return loadedA ? 1 : -1;
          }
        } else {
          return usedA ? 1 : -1;
        }
      });
      const maxUnload = Math.max(minSize * unloadPercent, excessNodes * unloadPercent);
      const nodesToUnload = Math.ceil(Math.min(maxUnload, unused, excessNodes));
      const maxBytesUnload = Math.max(unloadPercent * excessBytes, unloadPercent * minBytesSize);
      const bytesToUnload = Math.min(maxBytesUnload, excessBytes);
      let removedNodes = 0;
      let removedBytes = 0;
      while (this.cachedBytes - removedBytes > maxBytesSize || itemList.length - removedNodes > maxSize) {
        const item = itemList[removedNodes];
        const bytes = bytesMap.get(item) || 0;
        if (usedSet.has(item) && loadedSet.has(item) || this.cachedBytes - removedBytes - bytes < maxBytesSize && itemList.length - removedNodes <= maxSize) {
          break;
        }
        removedBytes += bytes;
        removedNodes++;
      }
      while (removedBytes < bytesToUnload || removedNodes < nodesToUnload) {
        const item = itemList[removedNodes];
        const bytes = bytesMap.get(item) || 0;
        if (usedSet.has(item) || this.cachedBytes - removedBytes - bytes < minBytesSize && removedNodes >= nodesToUnload) {
          break;
        }
        removedBytes += bytes;
        removedNodes++;
      }
      itemList.splice(0, removedNodes).forEach((item) => {
        this.cachedBytes -= bytesMap.get(item) || 0;
        callbacks.get(item)(item);
        bytesMap.delete(item);
        itemSet.delete(item);
        callbacks.delete(item);
        loadedSet.delete(item);
        usedSet.delete(item);
      });
      needsRerun = removedNodes < excessNodes || removedBytes < excessBytes && removedNodes < unused;
      needsRerun = needsRerun && removedNodes > 0;
    }
    if (needsRerun) {
      this.unloadingHandle = requestAnimationFrame(() => this.scheduleUnload());
    }
  }
  scheduleUnload() {
    cancelAnimationFrame(this.unloadingHandle);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.unloadUnusedContent();
      });
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/UnloadTilesPlugin.js
var UnloadTilesPlugin = class {
  set delay(v) {
    this.deferCallbacks.delay = v;
  }
  get delay() {
    return this.deferCallbacks.delay;
  }
  set bytesTarget(v) {
    this.lruCache.minBytesSize = v;
  }
  get bytesTarget() {
    return this.lruCache.minBytesSize;
  }
  get estimatedGpuBytes() {
    return this.lruCache.cachedBytes;
  }
  constructor(options = {}) {
    const {
      delay = 0,
      bytesTarget = 0
    } = options;
    this.name = "UNLOAD_TILES_PLUGIN";
    this.tiles = null;
    this.lruCache = new LRUCache();
    this.deferCallbacks = new DeferCallbackManager();
    this.delay = delay;
    this.bytesTarget = bytesTarget;
  }
  init(tiles) {
    this.tiles = tiles;
    const { lruCache, deferCallbacks } = this;
    deferCallbacks.callback = (tile) => {
      lruCache.markUnused(tile);
      lruCache.scheduleUnload(false);
    };
    const unloadCallback = (tile) => {
      const scene = tile.cached.scene;
      const visible = tiles.visibleTiles.has(tile);
      if (!visible) {
        tiles.invokeOnePlugin((plugin) => plugin.unloadTileFromGPU && plugin.unloadTileFromGPU(scene, tile));
      }
    };
    this._onUpdateBefore = () => {
      lruCache.unloadPriorityCallback = tiles.lruCache.unloadPriorityCallback;
      lruCache.computeMemoryUsageCallback = tiles.lruCache.computeMemoryUsageCallback;
      lruCache.minSize = Infinity;
      lruCache.maxSize = Infinity;
      lruCache.maxBytesSize = Infinity;
      lruCache.unloadPercent = 1;
      lruCache.autoMarkUnused = false;
    };
    this._onVisibilityChangeCallback = ({ tile, visible }) => {
      if (visible) {
        lruCache.add(tile, unloadCallback);
        tiles.markTileUsed(tile);
        deferCallbacks.cancel(tile);
      } else {
        deferCallbacks.run(tile);
      }
    };
    tiles.forEachLoadedModel((scene, tile) => {
      const visible = tiles.visibleTiles.has(tile);
      this._onVisibilityChangeCallback({ scene, visible });
    });
    tiles.addEventListener("tile-visibility-change", this._onVisibilityChangeCallback);
    tiles.addEventListener("update-before", this._onUpdateBefore);
  }
  unloadTileFromGPU(scene, tile) {
    if (scene) {
      scene.traverse((c) => {
        if (c.material) {
          const material = c.material;
          material.dispose();
          for (const key in material) {
            const value = material[key];
            if (value && value.isTexture) {
              value.dispose();
            }
          }
        }
        if (c.geometry) {
          c.geometry.dispose();
        }
      });
    }
  }
  dispose() {
    this.tiles.removeEventListener("tile-visibility-change", this._onVisibilityChangeCallback);
    this.tiles.removeEventListener("update-before", this._onUpdateBefore);
    this.deferCallbacks.cancelAll();
  }
};
var DeferCallbackManager = class {
  constructor(callback = () => {
  }) {
    this.map = /* @__PURE__ */ new Map();
    this.callback = callback;
    this.delay = 0;
  }
  run(tile) {
    const { map, delay } = this;
    if (map.has(tile)) {
      throw new Error("DeferCallbackManager: Callback already initialized.");
    }
    if (delay === 0) {
      this.callback(tile);
    } else {
      map.set(tile, setTimeout(() => this.callback(tile), delay));
    }
  }
  cancel(tile) {
    const { map } = this;
    if (map.has(tile)) {
      clearTimeout(map.get(tile));
      map.delete(tile);
    }
  }
  cancelAll() {
    this.map.forEach((value, tile) => {
      this.cancel(tile);
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/fade/TilesFadePlugin.js
import { Matrix4 as Matrix44, Vector3 as Vector36, Quaternion } from "three";

// node_modules/3d-tiles-renderer/src/plugins/three/fade/FadeManager.js
import { MathUtils as MathUtils4 } from "three";
var { clamp } = MathUtils4;
var FadeManager = class {
  constructor() {
    this.duration = 250;
    this.fadeCount = 0;
    this._lastTick = -1;
    this._fadeState = /* @__PURE__ */ new Map();
    this.onFadeComplete = null;
    this.onFadeStart = null;
    this.onFadeSetComplete = null;
    this.onFadeSetStart = null;
  }
  // delete the object from the fade, reset the material data
  deleteObject(object) {
    if (!object) {
      return;
    }
    this.completeFade(object);
  }
  // Ensure we're storing a fade timer for the provided object
  // Returns whether a new state had to be added
  guaranteeState(object) {
    const fadeState = this._fadeState;
    if (fadeState.has(object)) {
      return false;
    }
    const state = {
      fadeInTarget: 0,
      fadeOutTarget: 0,
      fadeIn: 0,
      fadeOut: 0
    };
    fadeState.set(object, state);
    return true;
  }
  // Force the fade to complete in the direction it is already trending
  completeFade(object) {
    const fadeState = this._fadeState;
    if (!fadeState.has(object)) {
      return;
    }
    const visible = fadeState.get(object).fadeOutTarget === 0;
    fadeState.delete(object);
    this.fadeCount--;
    if (this.onFadeComplete) {
      this.onFadeComplete(object, visible);
    }
    if (this.fadeCount === 0 && this.onFadeSetComplete) {
      this.onFadeSetComplete();
    }
  }
  completeAllFades() {
    this._fadeState.forEach((value, key) => {
      this.completeFade(key);
    });
  }
  forEachObject(cb) {
    this._fadeState.forEach((info, object) => {
      cb(object, info);
    });
  }
  // Fade the object in
  fadeIn(object) {
    const noState = this.guaranteeState(object);
    const state = this._fadeState.get(object);
    state.fadeInTarget = 1;
    state.fadeOutTarget = 0;
    state.fadeOut = 0;
    if (noState) {
      this.fadeCount++;
      if (this.fadeCount === 1 && this.onFadeSetStart) {
        this.onFadeSetStart();
      }
      if (this.onFadeStart) {
        this.onFadeStart(object);
      }
    }
  }
  // Fade the object out
  fadeOut(object) {
    const noState = this.guaranteeState(object);
    const state = this._fadeState.get(object);
    state.fadeOutTarget = 1;
    if (noState) {
      state.fadeInTarget = 1;
      state.fadeIn = 1;
      this.fadeCount++;
      if (this.fadeCount === 1 && this.onFadeSetStart) {
        this.onFadeSetStart();
      }
      if (this.onFadeStart) {
        this.onFadeStart(object);
      }
    }
  }
  isFading(object) {
    return this._fadeState.has(object);
  }
  isFadingOut(object) {
    const state = this._fadeState.get(object);
    return state && state.fadeOutTarget === 1;
  }
  // Tick the fade timer for each actively fading object
  update() {
    const time = window.performance.now();
    if (this._lastTick === -1) {
      this._lastTick = time;
    }
    const delta = clamp((time - this._lastTick) / this.duration, 0, 1);
    this._lastTick = time;
    const fadeState = this._fadeState;
    fadeState.forEach((state, object) => {
      const {
        fadeOutTarget,
        fadeInTarget
      } = state;
      let {
        fadeOut,
        fadeIn
      } = state;
      const fadeInSign = Math.sign(fadeInTarget - fadeIn);
      fadeIn = clamp(fadeIn + fadeInSign * delta, 0, 1);
      const fadeOutSign = Math.sign(fadeOutTarget - fadeOut);
      fadeOut = clamp(fadeOut + fadeOutSign * delta, 0, 1);
      state.fadeIn = fadeIn;
      state.fadeOut = fadeOut;
      const fadeOutComplete = fadeOut === 1 || fadeOut === 0;
      const fadeInComplete = fadeIn === 1 || fadeIn === 0;
      if (fadeOutComplete && fadeInComplete || fadeOut >= fadeIn) {
        this.completeFade(object);
      }
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/fade/wrapFadeMaterial.js
function wrapFadeMaterial(material, previousOnBeforeCompile) {
  const params = {
    fadeIn: { value: 0 },
    fadeOut: { value: 0 },
    fadeTexture: { value: null }
  };
  material.defines = {
    ...material.defines || {},
    FEATURE_FADE: 0
  };
  material.onBeforeCompile = (shader) => {
    if (previousOnBeforeCompile) {
      previousOnBeforeCompile(shader);
    }
    shader.uniforms = {
      ...shader.uniforms,
      ...params
    };
    shader.vertexShader = shader.vertexShader.replace(
      /void\s+main\(\)\s+{/,
      (value) => (
        /* glsl */
        `
					#ifdef USE_BATCHING_FRAG

					varying float vBatchId;

					#endif

					${value}

						#ifdef USE_BATCHING_FRAG

						// add 0.5 to the value to avoid floating error that may cause flickering
						vBatchId = getIndirectIndex( gl_DrawID ) + 0.5;

						#endif
				`
      )
    );
    shader.fragmentShader = shader.fragmentShader.replace(/void main\(/, (value) => (
      /* glsl */
      `
				#if FEATURE_FADE

				// adapted from https://www.shadertoy.com/view/Mlt3z8
				float bayerDither2x2( vec2 v ) {

					return mod( 3.0 * v.y + 2.0 * v.x, 4.0 );

				}

				float bayerDither4x4( vec2 v ) {

					vec2 P1 = mod( v, 2.0 );
					vec2 P2 = floor( 0.5 * mod( v, 4.0 ) );
					return 4.0 * bayerDither2x2( P1 ) + bayerDither2x2( P2 );

				}

				// the USE_BATCHING define is not available in fragment shaders
				#ifdef USE_BATCHING_FRAG

				// functions for reading the fade state of a given batch id
				uniform sampler2D fadeTexture;
				varying float vBatchId;
				vec2 getFadeValues( const in float i ) {

					int size = textureSize( fadeTexture, 0 ).x;
					int j = int( i );
					int x = j % size;
					int y = j / size;
					return texelFetch( fadeTexture, ivec2( x, y ), 0 ).rg;

				}

				#else

				uniform float fadeIn;
				uniform float fadeOut;

				#endif

				#endif

				${value}
			`
    )).replace(/#include <dithering_fragment>/, (value) => (
      /* glsl */
      `

				${value}

				#if FEATURE_FADE

				#ifdef USE_BATCHING_FRAG

				vec2 fadeValues = getFadeValues( vBatchId );
				float fadeIn = fadeValues.r;
				float fadeOut = fadeValues.g;

				#endif

				float bayerValue = bayerDither4x4( floor( mod( gl_FragCoord.xy, 4.0 ) ) );
				float bayerBins = 16.0;
				float dither = ( 0.5 + bayerValue ) / bayerBins;
				if ( dither >= fadeIn ) {

					discard;

				}

				if ( dither < fadeOut ) {

					discard;

				}

				#endif

			`
    ));
  };
  return params;
}

// node_modules/3d-tiles-renderer/src/plugins/three/fade/FadeMaterialManager.js
var FadeMaterialManager = class {
  constructor() {
    this._fadeParams = /* @__PURE__ */ new WeakMap();
    this.fading = 0;
  }
  // Set the fade parameters for the given scene
  setFade(scene, fadeIn, fadeOut) {
    if (!scene) {
      return;
    }
    const fadeParams = this._fadeParams;
    scene.traverse((child) => {
      const material = child.material;
      if (material) {
        const params = fadeParams.get(material);
        params.fadeIn.value = fadeIn;
        params.fadeOut.value = fadeOut;
        const fadeInComplete = fadeIn === 0 || fadeIn === 1;
        const fadeOutComplete = fadeOut === 0 || fadeOut === 1;
        const value = Number(!fadeInComplete || !fadeOutComplete);
        if (material.defines.FEATURE_FADE !== value) {
          this.fading += value === 1 ? 1 : -1;
          material.defines.FEATURE_FADE = value;
          material.needsUpdate = true;
        }
      }
    });
  }
  // initialize materials in the object
  prepareScene(scene) {
    scene.traverse((child) => {
      if (child.material) {
        this.prepareMaterial(child.material);
      }
    });
  }
  // delete the object from the fade, reset the material data
  deleteScene(scene) {
    if (!scene) {
      return;
    }
    const fadeParams = this._fadeParams;
    scene.traverse((child) => {
      const material = child.material;
      if (material) {
        fadeParams.delete(material);
        material.onBeforeCompile = () => {
        };
        material.needsUpdate = true;
      }
    });
  }
  // initialize the material
  prepareMaterial(material) {
    const fadeParams = this._fadeParams;
    if (fadeParams.has(material)) {
      return;
    }
    fadeParams.set(material, wrapFadeMaterial(material));
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/fade/PassThroughBatchedMesh.js
import { MeshBasicMaterial } from "three";
var PassThroughBatchedMesh = class {
  constructor(other, material = new MeshBasicMaterial()) {
    this.other = other;
    this.material = material;
    this.visible = true;
    this.parent = null;
    this._instanceInfo = [];
    this._visibilityChanged = true;
    const proxyTarget = new Proxy(this, {
      get(target, key) {
        if (key in target) {
          return target[key];
        } else {
          const value = other[key];
          if (value instanceof Function) {
            return (...args) => {
              target.syncInstances();
              return value.call(proxyTarget, ...args);
            };
          } else {
            return other[key];
          }
        }
      },
      set(target, key, value) {
        if (key in target) {
          target[key] = value;
        } else {
          other[key] = value;
        }
        return true;
      },
      deleteProperty(target, key) {
        if (key in target) {
          return delete target[key];
        } else {
          return delete other[key];
        }
      }
      // ownKeys() {},
      // has(target, key) {},
      // defineProperty(target, key, descriptor) {},
      // getOwnPropertyDescriptor(target, key) {},
    });
    return proxyTarget;
  }
  syncInstances() {
    const instanceInfo = this._instanceInfo;
    const otherInstanceInfo = this.other._instanceInfo;
    while (otherInstanceInfo.length > instanceInfo.length) {
      const index = instanceInfo.length;
      instanceInfo.push(new Proxy({ visible: false }, {
        get(target, key) {
          if (key in target) {
            return target[key];
          } else {
            return otherInstanceInfo[index][key];
          }
        },
        set(target, key, value) {
          if (key in target) {
            target[key] = value;
          } else {
            otherInstanceInfo[index][key] = value;
          }
          return true;
        }
      }));
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/fade/FadeBatchedMesh.js
import { RGFormat, UnsignedByteType, DataTexture } from "three";
var FadeBatchedMesh = class extends PassThroughBatchedMesh {
  constructor(...args) {
    super(...args);
    const material = this.material;
    const params = wrapFadeMaterial(material, material.onBeforeCompile);
    material.defines.FEATURE_FADE = 1;
    material.defines.USE_BATCHING_FRAG = 1;
    material.needsUpdate = true;
    this.fadeTexture = null;
    this._fadeParams = params;
  }
  // Set the fade state
  setFadeAt(index, fadeIn, fadeOut) {
    this._initFadeTexture();
    this.fadeTexture.setValueAt(index, fadeIn * 255, fadeOut * 255);
  }
  // initialize the texture and resize it if needed
  _initFadeTexture() {
    let size = Math.sqrt(this._maxInstanceCount);
    size = Math.ceil(size);
    const length = size * size * 2;
    const oldFadeTexture = this.fadeTexture;
    if (!oldFadeTexture || oldFadeTexture.image.data.length !== length) {
      const fadeArray = new Uint8Array(length);
      const fadeTexture = new InstanceDataTexture(fadeArray, size, size, RGFormat, UnsignedByteType);
      if (oldFadeTexture) {
        oldFadeTexture.dispose();
        const src = oldFadeTexture.image.data;
        const dst = this.fadeTexture.image.data;
        const len = Math.min(src.length, dst.length);
        dst.set(new src.constructor(src.buffer, 0, len));
      }
      this.fadeTexture = fadeTexture;
      this._fadeParams.fadeTexture.value = fadeTexture;
      fadeTexture.needsUpdate = true;
    }
  }
  // dispose the fade texture. Super cannot be used here due to proxy
  dispose() {
    if (this.fadeTexture) {
      this.fadeTexture.dispose();
    }
  }
};
var InstanceDataTexture = class extends DataTexture {
  setValueAt(instance, ...values) {
    const { data, width, height } = this.image;
    const itemSize = Math.floor(data.length / (width * height));
    let needsUpdate = false;
    for (let i = 0; i < itemSize; i++) {
      const index = instance * itemSize + i;
      const prevValue = data[index];
      const newValue = values[i] || 0;
      if (prevValue !== newValue) {
        data[index] = newValue;
        needsUpdate = true;
      }
    }
    if (needsUpdate) {
      this.needsUpdate = true;
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/fade/TilesFadePlugin.js
var HAS_POPPED_IN = /* @__PURE__ */ Symbol("HAS_POPPED_IN");
var _fromPos = new Vector36();
var _toPos = new Vector36();
var _fromQuat = new Quaternion();
var _toQuat = new Quaternion();
var _scale = new Vector36();
function onUpdateBefore() {
  const fadeManager = this._fadeManager;
  const tiles = this.tiles;
  this._fadingBefore = fadeManager.fadeCount;
  this._displayActiveTiles = tiles.displayActiveTiles;
  tiles.displayActiveTiles = true;
}
function onUpdateAfter() {
  const fadeManager = this._fadeManager;
  const fadeMaterialManager = this._fadeMaterialManager;
  const displayActiveTiles = this._displayActiveTiles;
  const fadingBefore = this._fadingBefore;
  const prevCameraTransforms = this._prevCameraTransforms;
  const { tiles, maximumFadeOutTiles, batchedMesh } = this;
  const { cameras } = tiles;
  tiles.displayActiveTiles = displayActiveTiles;
  fadeManager.update();
  const fadingAfter = fadeManager.fadeCount;
  if (fadingBefore !== 0 && fadingAfter !== 0) {
    tiles.dispatchEvent({ type: "fade-change" });
    tiles.dispatchEvent({ type: "force-rerender" });
  }
  if (!displayActiveTiles) {
    tiles.visibleTiles.forEach((t) => {
      const scene = t.cached.scene;
      if (scene) {
        scene.visible = t.__inFrustum;
      }
      this.forEachBatchIds(t, (id, batchedMesh2, plugin) => {
        batchedMesh2.setVisibleAt(id, t.__inFrustum);
        plugin.batchedMesh.setVisibleAt(id, t.__inFrustum);
      });
    });
  }
  if (maximumFadeOutTiles < this._fadingOutCount) {
    let isMovingFast = true;
    cameras.forEach((camera) => {
      if (!prevCameraTransforms.has(camera)) {
        return;
      }
      const currMatrix = camera.matrixWorld;
      const prevMatrix = prevCameraTransforms.get(camera);
      currMatrix.decompose(_toPos, _toQuat, _scale);
      prevMatrix.decompose(_fromPos, _fromQuat, _scale);
      const angleTo = _toQuat.angleTo(_fromQuat);
      const positionTo = _toPos.distanceTo(_fromPos);
      isMovingFast = isMovingFast && (angleTo > 0.25 || positionTo > 0.1);
    });
    if (isMovingFast) {
      fadeManager.completeAllFades();
    }
  }
  cameras.forEach((camera) => {
    prevCameraTransforms.get(camera).copy(camera.matrixWorld);
  });
  fadeManager.forEachObject((tile, { fadeIn, fadeOut }) => {
    const scene = tile.cached.scene;
    const isFadingOut = fadeManager.isFadingOut(tile);
    tiles.markTileUsed(tile);
    if (scene) {
      fadeMaterialManager.setFade(scene, fadeIn, fadeOut);
      if (isFadingOut) {
        scene.visible = true;
      }
    }
    this.forEachBatchIds(tile, (id, batchedMesh2, plugin) => {
      batchedMesh2.setFadeAt(id, fadeIn, fadeOut);
      batchedMesh2.setVisibleAt(id, true);
      plugin.batchedMesh.setVisibleAt(id, false);
    });
  });
  if (batchedMesh) {
    const material = tiles.getPluginByName("BATCHED_TILES_PLUGIN").batchedMesh.material;
    batchedMesh.material.map = material.map;
  }
}
var TilesFadePlugin = class {
  get fadeDuration() {
    return this._fadeManager.duration;
  }
  set fadeDuration(value) {
    this._fadeManager.duration = Number(value);
  }
  get fadingTiles() {
    return this._fadeManager.fadeCount;
  }
  constructor(options) {
    options = {
      maximumFadeOutTiles: 50,
      fadeRootTiles: false,
      fadeDuration: 250,
      ...options
    };
    this.name = "FADE_TILES_PLUGIN";
    this.priority = -2;
    this.tiles = null;
    this.batchedMesh = null;
    this._fadeManager = new FadeManager();
    this._fadeMaterialManager = new FadeMaterialManager();
    this._prevCameraTransforms = null;
    this._fadingOutCount = 0;
    this.maximumFadeOutTiles = options.maximumFadeOutTiles;
    this.fadeRootTiles = options.fadeRootTiles;
    this.fadeDuration = options.fadeDuration;
  }
  init(tiles) {
    this._onLoadModel = ({ scene }) => {
      this._fadeMaterialManager.prepareScene(scene);
    };
    this._onDisposeModel = ({ tile, scene }) => {
      this._fadeManager.deleteObject(tile);
      this._fadeMaterialManager.deleteScene(scene);
    };
    this._onAddCamera = ({ camera }) => {
      this._prevCameraTransforms.set(camera, new Matrix44());
    };
    this._onDeleteCamera = ({ camera }) => {
      this._prevCameraTransforms.delete(camera);
    };
    this._onTileVisibilityChange = ({ tile, visible }) => {
      const scene = tile.cached.scene;
      if (scene) {
        scene.visible = true;
      }
      this.forEachBatchIds(tile, (id, batchedMesh, plugin) => {
        batchedMesh.setFadeAt(id, 0, 0);
        batchedMesh.setVisibleAt(id, false);
        plugin.batchedMesh.setVisibleAt(id, false);
      });
    };
    this._onUpdateBefore = () => {
      onUpdateBefore.call(this);
    };
    this._onUpdateAfter = () => {
      onUpdateAfter.call(this);
    };
    tiles.addEventListener("load-model", this._onLoadModel);
    tiles.addEventListener("dispose-model", this._onDisposeModel);
    tiles.addEventListener("add-camera", this._onAddCamera);
    tiles.addEventListener("delete-camera", this._onDeleteCamera);
    tiles.addEventListener("update-before", this._onUpdateBefore);
    tiles.addEventListener("update-after", this._onUpdateAfter);
    tiles.addEventListener("tile-visibility-change", this._onTileVisibilityChange);
    const fadeManager = this._fadeManager;
    fadeManager.onFadeSetStart = () => {
      tiles.dispatchEvent({ type: "fade-start" });
      tiles.dispatchEvent({ type: "force-rerender" });
    };
    fadeManager.onFadeSetComplete = () => {
      tiles.dispatchEvent({ type: "fade-end" });
      tiles.dispatchEvent({ type: "force-rerender" });
    };
    fadeManager.onFadeComplete = (tile, visible) => {
      this._fadeMaterialManager.setFade(tile.cached.scene, 0, 0);
      this.forEachBatchIds(tile, (id, batchedMesh, plugin) => {
        batchedMesh.setFadeAt(id, 0, 0);
        batchedMesh.setVisibleAt(id, false);
        plugin.batchedMesh.setVisibleAt(id, visible);
      });
      if (!visible) {
        tiles.invokeOnePlugin((plugin) => plugin !== this && plugin.setTileVisible && plugin.setTileVisible(tile, false));
        this._fadingOutCount--;
      }
    };
    const prevCameraTransforms = /* @__PURE__ */ new Map();
    tiles.cameras.forEach((camera) => {
      prevCameraTransforms.set(camera, new Matrix44());
    });
    tiles.forEachLoadedModel((scene, tile) => {
      this._onLoadModel({ scene });
    });
    this.tiles = tiles;
    this._fadeManager = fadeManager;
    this._prevCameraTransforms = prevCameraTransforms;
  }
  // initializes the batched mesh if it needs to be, dispose if it it's no longer needed
  initBatchedMesh() {
    const otherBatchedMesh = this.tiles.getPluginByName("BATCHED_TILES_PLUGIN")?.batchedMesh;
    if (otherBatchedMesh) {
      if (this.batchedMesh === null) {
        this._onBatchedMeshDispose = () => {
          this.batchedMesh.dispose();
          this.batchedMesh.removeFromParent();
          this.batchedMesh = null;
          otherBatchedMesh.removeEventListener("dispose", this._onBatchedMeshDispose);
        };
        const material = otherBatchedMesh.material.clone();
        material.onBeforeCompile = otherBatchedMesh.material.onBeforeCompile;
        this.batchedMesh = new FadeBatchedMesh(otherBatchedMesh, material);
        this.tiles.group.add(this.batchedMesh);
      }
    } else {
      if (this.batchedMesh !== null) {
        this._onBatchedMeshDispose();
        this._onBatchedMeshDispose = null;
      }
    }
  }
  // callback for fading to prevent tiles from being removed until the fade effect has completed
  setTileVisible(tile, visible) {
    const fadeManager = this._fadeManager;
    const wasFading = fadeManager.isFading(tile);
    if (fadeManager.isFadingOut(tile)) {
      this._fadingOutCount--;
    }
    if (!visible) {
      this._fadingOutCount++;
      fadeManager.fadeOut(tile);
    } else {
      const isRootRenderableTile = tile.__depthFromRenderedParent === 1;
      if (isRootRenderableTile) {
        if (tile[HAS_POPPED_IN] || this.fadeRootTiles) {
          this._fadeManager.fadeIn(tile);
        }
        tile[HAS_POPPED_IN] = true;
      } else {
        this._fadeManager.fadeIn(tile);
      }
    }
    if (wasFading) {
      return true;
    }
    const isFading = this._fadeManager.isFading(tile);
    if (!visible && isFading) {
      return true;
    }
    return false;
  }
  dispose() {
    const tiles = this.tiles;
    this._fadeManager.completeAllFades();
    if (this.batchedMesh !== null) {
      this._onBatchedMeshDispose();
    }
    tiles.removeEventListener("load-model", this._onLoadModel);
    tiles.removeEventListener("dispose-model", this._onDisposeModel);
    tiles.removeEventListener("add-camera", this._onAddCamera);
    tiles.removeEventListener("delete-camera", this._onDeleteCamera);
    tiles.removeEventListener("update-before", this._onUpdateBefore);
    tiles.removeEventListener("update-after", this._onUpdateAfter);
    tiles.removeEventListener("tile-visibility-change", this._onTileVisibilityChange);
    tiles.forEachLoadedModel((scene, tile) => {
      this._fadeManager.deleteObject(tile);
      if (scene) {
        scene.visible = true;
      }
    });
  }
  // helper for iterating over the batch ids for a given tile
  forEachBatchIds(tile, cb) {
    this.initBatchedMesh();
    if (this.batchedMesh) {
      const batchedPlugin = this.tiles.getPluginByName("BATCHED_TILES_PLUGIN");
      const instanceIds = batchedPlugin.getTileBatchIds(tile);
      if (instanceIds) {
        instanceIds.forEach((id) => {
          cb(id, this.batchedMesh, batchedPlugin);
        });
      }
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/batched/BatchedTilesPlugin.js
import { WebGLArrayRenderTarget, MeshBasicMaterial as MeshBasicMaterial2, DataTexture as DataTexture2, REVISION } from "three";
import { FullScreenQuad as FullScreenQuad2 } from "three/examples/jsm/postprocessing/Pass.js";

// node_modules/3d-tiles-renderer/src/plugins/three/batched/ExpandingBatchedMesh.js
import { Mesh, Box3, Sphere as Sphere3 } from "three";

// node_modules/3d-tiles-renderer/src/plugins/three/batched/ModelViewBatchedMesh.js
import { BatchedMesh, Matrix4 as Matrix45, Vector3 as Vector37, Source } from "three";
var matrix = new Matrix45();
var vec1 = new Vector37();
var vec2 = new Vector37();
var ModelViewBatchedMesh = class extends BatchedMesh {
  constructor(...args) {
    super(...args);
    this.resetDistance = 1e4;
    this._matricesTextureHandle = null;
    this._lastCameraPos = new Matrix45();
    this._forceUpdate = true;
    this._matrices = [];
  }
  setMatrixAt(instanceId, matrix2) {
    super.setMatrixAt(instanceId, matrix2);
    this._forceUpdate = true;
    const matrices = this._matrices;
    while (matrices.length <= instanceId) {
      matrices.push(new Matrix45());
    }
    matrices[instanceId].copy(matrix2);
  }
  setInstanceCount(...args) {
    super.setInstanceCount(...args);
    const matrices = this._matrices;
    while (matrices.length > this.instanceCount) {
      matrices.pop();
    }
  }
  onBeforeRender(renderer, scene, camera, geometry, material, group) {
    super.onBeforeRender(renderer, scene, camera, geometry, material, group);
    vec1.setFromMatrixPosition(camera.matrixWorld);
    vec2.setFromMatrixPosition(this._lastCameraPos);
    const matricesTexture = this._matricesTexture;
    let modelViewMatricesTexture = this._modelViewMatricesTexture;
    if (!modelViewMatricesTexture || modelViewMatricesTexture.image.width !== matricesTexture.image.width || modelViewMatricesTexture.image.height !== matricesTexture.image.height) {
      if (modelViewMatricesTexture) {
        modelViewMatricesTexture.dispose();
      }
      modelViewMatricesTexture = matricesTexture.clone();
      modelViewMatricesTexture.source = new Source({
        ...modelViewMatricesTexture.image,
        data: modelViewMatricesTexture.image.data.slice()
      });
      this._modelViewMatricesTexture = modelViewMatricesTexture;
    }
    if (this._forceUpdate || vec1.distanceTo(vec2) > this.resetDistance) {
      const matrices = this._matrices;
      const modelViewArray = modelViewMatricesTexture.image.data;
      for (let i = 0; i < this.maxInstanceCount; i++) {
        const instanceMatrix = matrices[i];
        if (instanceMatrix) {
          matrix.copy(instanceMatrix);
        } else {
          matrix.identity();
        }
        matrix.premultiply(this.matrixWorld).premultiply(camera.matrixWorldInverse).toArray(modelViewArray, i * 16);
      }
      modelViewMatricesTexture.needsUpdate = true;
      this._lastCameraPos.copy(camera.matrixWorld);
      this._forceUpdate = false;
    }
    this._matricesTextureHandle = this._matricesTexture;
    this._matricesTexture = this._modelViewMatricesTexture;
    this.matrixWorld.copy(this._lastCameraPos);
  }
  onAfterRender() {
    this.updateMatrixWorld();
    this._matricesTexture = this._matricesTextureHandle;
    this._matricesTextureHandle = null;
  }
  onAfterShadow(renderer, object, camera, shadowCamera, geometry, depthMaterial) {
    this.onAfterRender(renderer, null, shadowCamera, geometry, depthMaterial);
  }
  dispose() {
    super.dispose();
    if (this._modelViewMatricesTexture) {
      this._modelViewMatricesTexture.dispose();
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/batched/ExpandingBatchedMesh.js
var _raycastMesh = new Mesh();
var _batchIntersects = [];
var ExpandingBatchedMesh = class extends ModelViewBatchedMesh {
  constructor(...args) {
    super(...args);
    this.expandPercent = 0.25;
    this.maxInstanceExpansionSize = Infinity;
    this._freeGeometryIds = [];
  }
  // Finds a free id that can fit the geometry with the requested ranges. Returns -1 if it could not be found.
  findFreeId(geometry, reservedVertexRange, reservedIndexRange) {
    const needsIndex = Boolean(this.geometry.index);
    const neededIndexCount = Math.max(needsIndex ? geometry.index.count : -1, reservedIndexRange);
    const neededVertexCount = Math.max(geometry.attributes.position.count, reservedVertexRange);
    let bestIndex = -1;
    let bestScore = Infinity;
    const freeGeometryIds = this._freeGeometryIds;
    freeGeometryIds.forEach((id, i) => {
      const geometryInfo = this.getGeometryRangeAt(id);
      const { reservedIndexCount, reservedVertexCount } = geometryInfo;
      if (reservedIndexCount >= neededIndexCount && reservedVertexCount >= neededVertexCount) {
        const score = neededIndexCount - reservedIndexCount + (neededVertexCount - reservedVertexCount);
        if (score < bestScore) {
          bestIndex = i;
          bestScore = score;
        }
      }
    });
    if (bestIndex !== -1) {
      const id = freeGeometryIds[bestIndex];
      freeGeometryIds.splice(bestIndex, 1);
      return id;
    } else {
      return -1;
    }
  }
  // Overrides addGeometry to find an option geometry slot, expand, or optimized if needed
  addGeometry(geometry, reservedVertexRange, reservedIndexRange) {
    const needsIndex = Boolean(this.geometry.index);
    reservedIndexRange = Math.max(needsIndex ? geometry.index.count : -1, reservedIndexRange);
    reservedVertexRange = Math.max(geometry.attributes.position.count, reservedVertexRange);
    const { expandPercent, _freeGeometryIds } = this;
    let resultId = this.findFreeId(geometry, reservedVertexRange, reservedIndexRange);
    if (resultId !== -1) {
      this.setGeometryAt(resultId, geometry);
    } else {
      const needsMoreSpace = () => {
        const vertexNeedsSpace = this.unusedVertexCount < reservedVertexRange;
        const indexNeedsSpace = this.unusedIndexCount < reservedIndexRange;
        return vertexNeedsSpace || indexNeedsSpace;
      };
      const index = geometry.index;
      const position = geometry.attributes.position;
      reservedVertexRange = Math.max(reservedVertexRange, position.count);
      reservedIndexRange = Math.max(reservedIndexRange, index ? index.count : 0);
      if (needsMoreSpace()) {
        _freeGeometryIds.forEach((id) => this.deleteGeometry(id));
        _freeGeometryIds.length = 0;
        this.optimize();
        if (needsMoreSpace()) {
          const batchedIndex = this.geometry.index;
          const batchedPosition = this.geometry.attributes.position;
          let newIndexCount, newVertexCount;
          if (batchedIndex) {
            const addIndexCount = Math.ceil(expandPercent * batchedIndex.count);
            newIndexCount = Math.max(addIndexCount, reservedIndexRange, index.count) + batchedIndex.count;
          } else {
            newIndexCount = Math.max(this.unusedIndexCount, reservedIndexRange);
          }
          if (batchedPosition) {
            const addVertexCount = Math.ceil(expandPercent * batchedPosition.count);
            newVertexCount = Math.max(addVertexCount, reservedVertexRange, position.count) + batchedPosition.count;
          } else {
            newVertexCount = Math.max(this.unusedVertexCount, reservedVertexRange);
          }
          this.setGeometrySize(newVertexCount, newIndexCount);
        }
      }
      resultId = super.addGeometry(geometry, reservedVertexRange, reservedIndexRange);
    }
    return resultId;
  }
  // add an instance and automatically expand the number of instances if necessary
  addInstance(geometryId) {
    if (this.maxInstanceCount === this.instanceCount) {
      const newCount = Math.ceil(this.maxInstanceCount * (1 + this.expandPercent));
      this.setInstanceCount(Math.min(newCount, this.maxInstanceExpansionSize));
    }
    return super.addInstance(geometryId);
  }
  // delete an instance, keeping note that the geometry id is now unused
  deleteInstance(instanceId) {
    const geometryId = this.getGeometryIdAt(instanceId);
    if (geometryId !== -1) {
      this._freeGeometryIds.push(geometryId);
    }
    return super.deleteInstance(instanceId);
  }
  // add a function for raycasting per tile
  raycastInstance(instanceId, raycaster, intersects) {
    const batchGeometry = this.geometry;
    const geometryId = this.getGeometryIdAt(instanceId);
    _raycastMesh.material = this.material;
    _raycastMesh.geometry.index = batchGeometry.index;
    _raycastMesh.geometry.attributes = batchGeometry.attributes;
    const drawRange = this.getGeometryRangeAt(geometryId);
    _raycastMesh.geometry.setDrawRange(drawRange.start, drawRange.count);
    if (_raycastMesh.geometry.boundingBox === null) {
      _raycastMesh.geometry.boundingBox = new Box3();
    }
    if (_raycastMesh.geometry.boundingSphere === null) {
      _raycastMesh.geometry.boundingSphere = new Sphere3();
    }
    this.getMatrixAt(instanceId, _raycastMesh.matrixWorld).premultiply(this.matrixWorld);
    this.getBoundingBoxAt(geometryId, _raycastMesh.geometry.boundingBox);
    this.getBoundingSphereAt(geometryId, _raycastMesh.geometry.boundingSphere);
    _raycastMesh.raycast(raycaster, _batchIntersects);
    for (let j = 0, l = _batchIntersects.length; j < l; j++) {
      const intersect = _batchIntersects[j];
      intersect.object = this;
      intersect.batchId = instanceId;
      intersects.push(intersect);
    }
    _batchIntersects.length = 0;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/batched/utilities.js
function isColorWhite(color) {
  return color.r === 1 && color.g === 1 && color.b === 1;
}
function convertMapToArrayTexture(material) {
  material.needsUpdate = true;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      /* glsl */
      `
				#include <common>
				varying float texture_index;
				`
    ).replace(
      "#include <uv_vertex>",
      /* glsl */
      `
				#include <uv_vertex>
				texture_index = getIndirectIndex( gl_DrawID );
				`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_pars_fragment>",
      /* glsl */
      `
				#ifdef USE_MAP
				precision highp sampler2DArray;
				uniform sampler2DArray map;
				varying float texture_index;
				#endif
				`
    ).replace(
      "#include <map_fragment>",
      /* glsl */
      `
				#ifdef USE_MAP
					diffuseColor *= texture( map, vec3( vMapUv, texture_index ) );
				#endif
				`
    );
  };
}

// node_modules/3d-tiles-renderer/src/plugins/three/batched/BatchedTilesPlugin.js
var _textureRenderQuad = new FullScreenQuad2(new MeshBasicMaterial2());
var _whiteTex = new DataTexture2(new Uint8Array([255, 255, 255, 255]), 1, 1);
_whiteTex.needsUpdate = true;
var BatchedTilesPlugin = class {
  constructor(options = {}) {
    if (parseInt(REVISION) < 170) {
      throw new Error("BatchedTilesPlugin: Three.js revision 170 or higher required.");
    }
    options = {
      instanceCount: 500,
      vertexCount: 750,
      indexCount: 2e3,
      expandPercent: 0.25,
      maxInstanceCount: Infinity,
      discardOriginalContent: true,
      textureSize: null,
      material: null,
      renderer: null,
      ...options
    };
    this.name = "BATCHED_TILES_PLUGIN";
    this.priority = -1;
    const gl = options.renderer.getContext();
    this.instanceCount = options.instanceCount;
    this.vertexCount = options.vertexCount;
    this.indexCount = options.indexCount;
    this.material = options.material ? options.material.clone() : null;
    this.expandPercent = options.expandPercent;
    this.maxInstanceCount = Math.min(options.maxInstanceCount, gl.getParameter(gl.MAX_3D_TEXTURE_SIZE));
    this.renderer = options.renderer;
    this.discardOriginalContent = options.discardOriginalContent;
    this.textureSize = options.textureSize;
    this.batchedMesh = null;
    this.arrayTarget = null;
    this.tiles = null;
    this._onLoadModel = null;
    this._onDisposeModel = null;
    this._onVisibilityChange = null;
    this._tileToInstanceId = /* @__PURE__ */ new Map();
  }
  init(tiles) {
    this._onDisposeModel = ({ scene, tile }) => {
      this.removeSceneFromBatchedMesh(scene, tile);
    };
    tiles.addEventListener("dispose-model", this._onDisposeModel);
    this.tiles = tiles;
  }
  // init the batched mesh if it's not ready
  initBatchedMesh(target) {
    if (this.batchedMesh !== null) {
      return;
    }
    const { instanceCount, vertexCount, indexCount, tiles, renderer, textureSize } = this;
    const material = this.material ? this.material : new target.material.constructor();
    const batchedMesh = new ExpandingBatchedMesh(instanceCount, instanceCount * vertexCount, instanceCount * indexCount, material);
    batchedMesh.name = "BatchTilesPlugin";
    batchedMesh.frustumCulled = false;
    tiles.group.add(batchedMesh);
    batchedMesh.updateMatrixWorld();
    const map = target.material.map;
    const textureOptions = {
      colorSpace: map.colorSpace,
      wrapS: map.wrapS,
      wrapT: map.wrapT,
      wrapR: map.wrapS,
      // TODO: Generating mipmaps for the volume every time a new texture is added is extremely slow
      // generateMipmaps: map.generateMipmaps,
      // minFilter: map.minFilter,
      magFilter: map.magFilter
    };
    const arrayTarget = new WebGLArrayRenderTarget(textureSize || map.image.width, textureSize || map.image.height, instanceCount);
    Object.assign(arrayTarget.texture, textureOptions);
    renderer.initRenderTarget(arrayTarget);
    material.map = arrayTarget.texture;
    convertMapToArrayTexture(material);
    this.arrayTarget = arrayTarget;
    this.batchedMesh = batchedMesh;
  }
  setTileVisible(tile, visible) {
    const scene = tile.cached.scene;
    if (visible) {
      this.addSceneToBatchedMesh(scene, tile);
    }
    if (this._tileToInstanceId.has(tile)) {
      const instanceIds = this._tileToInstanceId.get(tile);
      instanceIds.forEach((instanceId) => {
        this.batchedMesh.setVisibleAt(instanceId, visible);
      });
      const tiles = this.tiles;
      if (visible) {
        tiles.visibleTiles.add(tile);
      } else {
        tiles.visibleTiles.delete(tile);
      }
      tiles.dispatchEvent({
        type: "tile-visibility-change",
        scene,
        tile,
        visible
      });
      return true;
    }
    return false;
  }
  unloadTileFromGPU(scene, tile) {
    if (!this.discardOriginalContent && this._tileToInstanceId.has(tile)) {
      this.removeSceneFromBatchedMesh(scene, tile);
      return true;
    }
    return false;
  }
  // render the given into the given layer
  assignTextureToLayer(texture, layer) {
    this.expandArrayTargetIfNeeded();
    const { renderer } = this;
    const currentRenderTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.arrayTarget, layer);
    _textureRenderQuad.material.map = texture;
    _textureRenderQuad.render(renderer);
    renderer.setRenderTarget(currentRenderTarget);
    _textureRenderQuad.material.map = null;
    texture.dispose();
  }
  // check if the array texture target needs to be expanded
  expandArrayTargetIfNeeded() {
    const { batchedMesh, arrayTarget, renderer } = this;
    const targetDepth = Math.min(batchedMesh.maxInstanceCount, this.maxInstanceCount);
    if (targetDepth > arrayTarget.depth) {
      const textureOptions = {
        colorSpace: arrayTarget.texture.colorSpace,
        wrapS: arrayTarget.texture.wrapS,
        wrapT: arrayTarget.texture.wrapT,
        generateMipmaps: arrayTarget.texture.generateMipmaps,
        minFilter: arrayTarget.texture.minFilter,
        magFilter: arrayTarget.texture.magFilter
      };
      const newArrayTarget = new WebGLArrayRenderTarget(arrayTarget.width, arrayTarget.height, targetDepth);
      Object.assign(newArrayTarget.texture, textureOptions);
      renderer.initRenderTarget(newArrayTarget);
      renderer.copyTextureToTexture(arrayTarget.texture, newArrayTarget.texture);
      arrayTarget.dispose();
      batchedMesh.material.map = newArrayTarget.texture;
      this.arrayTarget = newArrayTarget;
    }
  }
  removeSceneFromBatchedMesh(scene, tile) {
    if (this._tileToInstanceId.has(tile)) {
      const instanceIds = this._tileToInstanceId.get(tile);
      this._tileToInstanceId.delete(tile);
      instanceIds.forEach((instanceId) => {
        this.batchedMesh.deleteInstance(instanceId);
      });
    }
  }
  addSceneToBatchedMesh(scene, tile) {
    if (this._tileToInstanceId.has(tile)) {
      return;
    }
    const meshes = [];
    scene.traverse((c) => {
      if (c.isMesh) {
        meshes.push(c);
      }
    });
    let hasCorrectAttributes = true;
    meshes.forEach((mesh) => {
      if (this.batchedMesh && hasCorrectAttributes) {
        const attrs = mesh.geometry.attributes;
        const batchedAttrs = this.batchedMesh.geometry.attributes;
        for (const key in batchedAttrs) {
          if (!(key in attrs)) {
            hasCorrectAttributes = false;
            return;
          }
        }
      }
    });
    const canAddMeshes = !this.batchedMesh || this.batchedMesh.instanceCount + meshes.length <= this.maxInstanceCount;
    if (hasCorrectAttributes && canAddMeshes) {
      scene.updateMatrixWorld();
      const instanceIds = [];
      meshes.forEach((mesh) => {
        this.initBatchedMesh(mesh);
        const { geometry, material } = mesh;
        const { batchedMesh, expandPercent } = this;
        batchedMesh.expandPercent = expandPercent;
        const geometryId = batchedMesh.addGeometry(geometry, this.vertexCount, this.indexCount);
        const instanceId = batchedMesh.addInstance(geometryId);
        instanceIds.push(instanceId);
        batchedMesh.setMatrixAt(instanceId, mesh.matrixWorld);
        batchedMesh.setVisibleAt(instanceId, false);
        if (!isColorWhite(material.color)) {
          material.color.setHSL(Math.random(), 0.5, 0.5);
          batchedMesh.setColorAt(instanceId, material.color);
        }
        const texture = material.map;
        if (texture) {
          this.assignTextureToLayer(texture, instanceId);
        } else {
          this.assignTextureToLayer(_whiteTex, instanceId);
        }
      });
      this._tileToInstanceId.set(tile, instanceIds);
      if (this.discardOriginalContent) {
        tile.cached.textures.forEach((tex) => {
          if (tex.image instanceof ImageBitmap) {
            tex.image.close();
          }
        });
        tile.cached.scene = null;
        tile.cached.materials = [];
        tile.cached.geometries = [];
        tile.cached.textures = [];
      }
    }
  }
  // Override raycasting per tile to defer to the batched mesh
  raycastTile(tile, scene, raycaster, intersects) {
    if (!this._tileToInstanceId.has(tile)) {
      return false;
    }
    const instanceIds = this._tileToInstanceId.get(tile);
    instanceIds.forEach((instanceId) => {
      this.batchedMesh.raycastInstance(instanceId, raycaster, intersects);
    });
    return true;
  }
  dispose() {
    const { arrayTarget, tiles, batchedMesh } = this;
    if (arrayTarget) {
      arrayTarget.dispose();
    }
    if (batchedMesh) {
      batchedMesh.material.dispose();
      batchedMesh.geometry.dispose();
      batchedMesh.dispose();
      batchedMesh.removeFromParent();
    }
    tiles.removeEventListener("dispose-model", this._onDisposeModel);
  }
  getTileBatchIds(tile) {
    return this._tileToInstanceId.get(tile);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/LoadRegionPlugin.js
import { Ray as Ray3, Sphere as Sphere4 } from "three";

// node_modules/3d-tiles-renderer/src/three/math/OBB.js
import { Matrix4 as Matrix46, Box3 as Box32, Vector3 as Vector39, Plane, Ray as Ray2 } from "three";

// node_modules/3d-tiles-renderer/src/three/math/ExtendedFrustum.js
import { Frustum, Matrix3 as Matrix32, Vector3 as Vector38 } from "three";
var _mat3 = new Matrix32();
function findIntersectionPoint(plane1, plane2, plane3, target) {
  const A = _mat3.set(
    plane1.normal.x,
    plane1.normal.y,
    plane1.normal.z,
    plane2.normal.x,
    plane2.normal.y,
    plane2.normal.z,
    plane3.normal.x,
    plane3.normal.y,
    plane3.normal.z
  );
  target.set(-plane1.constant, -plane2.constant, -plane3.constant);
  target.applyMatrix3(A.invert());
  return target;
}
var ExtendedFrustum = class extends Frustum {
  constructor() {
    super();
    this.points = Array(8).fill().map(() => new Vector38());
  }
  setFromProjectionMatrix(m, coordinateSystem) {
    super.setFromProjectionMatrix(m, coordinateSystem);
    this.calculateFrustumPoints();
    return this;
  }
  calculateFrustumPoints() {
    const { planes, points } = this;
    const planeIntersections = [
      [planes[0], planes[3], planes[4]],
      // Near top left
      [planes[1], planes[3], planes[4]],
      // Near top right
      [planes[0], planes[2], planes[4]],
      // Near bottom left
      [planes[1], planes[2], planes[4]],
      // Near bottom right
      [planes[0], planes[3], planes[5]],
      // Far top left
      [planes[1], planes[3], planes[5]],
      // Far top right
      [planes[0], planes[2], planes[5]],
      // Far bottom left
      [planes[1], planes[2], planes[5]]
      // Far bottom right
    ];
    planeIntersections.forEach((planes2, index) => {
      findIntersectionPoint(planes2[0], planes2[1], planes2[2], points[index]);
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/math/OBB.js
var _worldMin = new Vector39();
var _worldMax = new Vector39();
var _norm2 = new Vector39();
var _ray2 = new Ray2();
var _frustum = new ExtendedFrustum();
var OBB = class {
  constructor(box = new Box32(), transform = new Matrix46()) {
    this.box = box.clone();
    this.transform = transform.clone();
    this.inverseTransform = new Matrix46();
    this.points = new Array(8).fill().map(() => new Vector39());
    this.planes = new Array(6).fill().map(() => new Plane());
  }
  copy(source) {
    this.box.copy(source.box);
    this.transform.copy(source.transform);
    this.update();
    return this;
  }
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Clamps the given point within the bounds of this OBB
   * @param {Vector3} point
   * @param {Vector3} result
   * @returns {Vector3}
   */
  clampPoint(point, result) {
    return result.copy(point).applyMatrix4(this.inverseTransform).clamp(this.box.min, this.box.max).applyMatrix4(this.transform);
  }
  /**
   * Returns the distance from any edge of this OBB to the specified point.
   * If the point lies inside of this box, the distance will be 0.
   * @param {Vector3} point
   * @returns {number}
   */
  distanceToPoint(point) {
    return this.clampPoint(point, _norm2).distanceTo(point);
  }
  containsPoint(point) {
    _norm2.copy(point).applyMatrix4(this.inverseTransform);
    return this.box.containsPoint(_norm2);
  }
  // returns boolean indicating whether the ray has intersected the obb
  intersectsRay(ray) {
    _ray2.copy(ray).applyMatrix4(this.inverseTransform);
    return _ray2.intersectsBox(this.box);
  }
  // Sets "target" equal to the intersection point.
  // Returns "null" if no intersection found.
  intersectRay(ray, target) {
    _ray2.copy(ray).applyMatrix4(this.inverseTransform);
    if (_ray2.intersectBox(this.box, target)) {
      target.applyMatrix4(this.transform);
      return target;
    } else {
      return null;
    }
  }
  update() {
    const { points, inverseTransform, transform, box } = this;
    inverseTransform.copy(transform).invert();
    const { min, max } = box;
    let index = 0;
    for (let x = -1; x <= 1; x += 2) {
      for (let y = -1; y <= 1; y += 2) {
        for (let z = -1; z <= 1; z += 2) {
          points[index].set(
            x < 0 ? min.x : max.x,
            y < 0 ? min.y : max.y,
            z < 0 ? min.z : max.z
          ).applyMatrix4(transform);
          index++;
        }
      }
    }
    this.updatePlanes();
  }
  updatePlanes() {
    _worldMin.copy(this.box.min).applyMatrix4(this.transform);
    _worldMax.copy(this.box.max).applyMatrix4(this.transform);
    _norm2.set(0, 0, 1).transformDirection(this.transform);
    this.planes[0].setFromNormalAndCoplanarPoint(_norm2, _worldMin);
    this.planes[1].setFromNormalAndCoplanarPoint(_norm2, _worldMax).negate();
    _norm2.set(0, 1, 0).transformDirection(this.transform);
    this.planes[2].setFromNormalAndCoplanarPoint(_norm2, _worldMin);
    this.planes[3].setFromNormalAndCoplanarPoint(_norm2, _worldMax).negate();
    _norm2.set(1, 0, 0).transformDirection(this.transform);
    this.planes[4].setFromNormalAndCoplanarPoint(_norm2, _worldMin);
    this.planes[5].setFromNormalAndCoplanarPoint(_norm2, _worldMax).negate();
  }
  // based on three.js' Box3 "intersects frustum" function
  intersectsFrustum(frustum) {
    const { points } = this;
    const { planes } = frustum;
    for (let i = 0; i < 6; i++) {
      const plane = planes[i];
      let maxDistance = -Infinity;
      for (let j = 0; j < 8; j++) {
        const v = points[j];
        const dist = plane.distanceToPoint(v);
        maxDistance = maxDistance < dist ? dist : maxDistance;
      }
      if (maxDistance < 0) {
        return false;
      }
    }
    for (let i = 0; i < 6; i++) {
      const plane = this.planes[i];
      let maxDistance = -Infinity;
      for (let j = 0; j < 8; j++) {
        const v = frustum.points[j];
        const dist = plane.distanceToPoint(v);
        maxDistance = maxDistance < dist ? dist : maxDistance;
      }
      if (maxDistance < 0) {
        return false;
      }
    }
    return true;
  }
  intersectsSphere(sphere2) {
    this.clampPoint(sphere2.center, _norm2);
    return _norm2.distanceToSquared(sphere2.center) <= sphere2.radius * sphere2.radius;
  }
  intersectsOBB(obb) {
    _frustum.set(...obb.planes);
    _frustum.calculateFrustumPoints();
    return this.intersectsFrustum(_frustum);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/LoadRegionPlugin.js
var LoadRegionPlugin = class {
  constructor() {
    this.name = "LOAD_REGION_PLUGIN";
    this.regions = [];
    this.tileErrors = /* @__PURE__ */ new Map();
    this.tiles = null;
  }
  init(tiles) {
    this.tiles = tiles;
    this._updateAfterCallback = () => {
      this.tileErrors.clear();
    };
    tiles.addEventListener("update-after", this._updateAfterCallback);
  }
  addRegion(region) {
    if (this.regions.indexOf(region) === -1) {
      this.regions.push(region);
    }
  }
  removeRegion(region) {
    const index = this.regions.indexOf(region);
    if (index !== -1) {
      this.regions.splice(index, 1);
    }
  }
  hasRegion(region) {
    return this.regions.indexOf(region) !== -1;
  }
  clearRegions() {
    this.regions = [];
  }
  tileInView(tile) {
    const boundingVolume = tile.cached.boundingVolume;
    const { regions, tileErrors, tiles } = this;
    let visible = false;
    let maxError = -Infinity;
    for (const region of regions) {
      const intersects = region.intersectsTile(boundingVolume, tile, tiles);
      if (intersects) {
        visible = true;
        maxError = Math.max(region.calculateError(tile, tiles), maxError);
      }
    }
    if (visible) {
      tileErrors.set(tile, maxError);
    }
    return visible;
  }
  calculateError(tile) {
    return this.tileErrors.has(tile) ? this.tileErrors.get(tile) : null;
  }
  dispose() {
    this.regions = [];
    this.tiles.removeEventListener("update-after", this._updateAfterCallback);
  }
};
var BaseRegion = class {
  constructor(errorTarget = 10) {
    this.errorTarget = errorTarget;
  }
  intersectsTile() {
  }
  calculateError(tile, tilesRenderer) {
    return tile.geometricError - this.errorTarget + tilesRenderer.errorTarget;
  }
};
var SphereRegion = class extends BaseRegion {
  constructor(errorTarget = 10, sphere2 = new Sphere4()) {
    super(errorTarget);
    this.sphere = sphere2.clone();
  }
  intersectsTile(boundingVolume) {
    return boundingVolume.intersectsSphere(this.sphere);
  }
};
var RayRegion = class extends BaseRegion {
  constructor(errorTarget = 10, ray = new Ray3()) {
    super(errorTarget);
    this.ray = ray.clone();
  }
  intersectsTile(boundingVolume) {
    return boundingVolume.intersectsRay(this.ray);
  }
};
var OBBRegion = class extends BaseRegion {
  constructor(errorTarget = 10, obb = new OBB()) {
    super(errorTarget);
    this.obb = obb.clone();
    this.obb.update();
  }
  intersectsTile(boundingVolume) {
    return boundingVolume.intersectsOBB(this.obb);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/DebugTilesPlugin.js
import { Box3Helper, Group, MeshStandardMaterial, PointsMaterial, Sphere as Sphere5, Color } from "three";

// node_modules/3d-tiles-renderer/src/plugins/three/objects/SphereHelper.js
import { LineSegments, BufferGeometry, Vector3 as Vector310, BufferAttribute as BufferAttribute2, LineBasicMaterial } from "three";
var _vector = new Vector310();
var axes = ["x", "y", "z"];
var SphereHelper = class extends LineSegments {
  constructor(sphere2, color = 16776960, angleSteps = 40) {
    const geometry = new BufferGeometry();
    const positions = [];
    for (let i = 0; i < 3; i++) {
      const axis1 = axes[i];
      const axis2 = axes[(i + 1) % 3];
      _vector.set(0, 0, 0);
      for (let a = 0; a < angleSteps; a++) {
        let angle;
        angle = 2 * Math.PI * a / (angleSteps - 1);
        _vector[axis1] = Math.sin(angle);
        _vector[axis2] = Math.cos(angle);
        positions.push(_vector.x, _vector.y, _vector.z);
        angle = 2 * Math.PI * (a + 1) / (angleSteps - 1);
        _vector[axis1] = Math.sin(angle);
        _vector[axis2] = Math.cos(angle);
        positions.push(_vector.x, _vector.y, _vector.z);
      }
    }
    geometry.setAttribute("position", new BufferAttribute2(new Float32Array(positions), 3));
    geometry.computeBoundingSphere();
    super(geometry, new LineBasicMaterial({ color, toneMapped: false }));
    this.sphere = sphere2;
    this.type = "SphereHelper";
  }
  updateMatrixWorld(force) {
    const sphere2 = this.sphere;
    this.position.copy(sphere2.center);
    this.scale.setScalar(sphere2.radius);
    super.updateMatrixWorld(force);
  }
};

// node_modules/3d-tiles-renderer/src/three/math/EllipsoidRegion.js
import { MathUtils as MathUtils5, Matrix4 as Matrix47 } from "three";
import { Vector3 as Vector311 } from "three";
var PI = Math.PI;
var HALF_PI = PI / 2;
var _orthoX = new Vector311();
var _orthoY = new Vector311();
var _orthoZ = new Vector311();
var _invMatrix = new Matrix47();
var _poolIndex = 0;
var _pointsPool = [];
function getVector(usePool = false) {
  if (!usePool) {
    return new Vector311();
  }
  if (!_pointsPool[_poolIndex]) {
    _pointsPool[_poolIndex] = new Vector311();
  }
  _poolIndex++;
  return _pointsPool[_poolIndex - 1];
}
function resetPool() {
  _poolIndex = 0;
}
var EllipsoidRegion = class extends Ellipsoid {
  constructor(x, y, z, latStart = -HALF_PI, latEnd = HALF_PI, lonStart = 0, lonEnd = 2 * PI, heightStart = 0, heightEnd = 0) {
    super(x, y, z);
    this.latStart = latStart;
    this.latEnd = latEnd;
    this.lonStart = lonStart;
    this.lonEnd = lonEnd;
    this.heightStart = heightStart;
    this.heightEnd = heightEnd;
  }
  _getPoints(usePool = false) {
    const {
      latStart,
      latEnd,
      lonStart,
      lonEnd,
      heightStart,
      heightEnd
    } = this;
    const midLat = MathUtils5.mapLinear(0.5, 0, 1, latStart, latEnd);
    const midLon = MathUtils5.mapLinear(0.5, 0, 1, lonStart, lonEnd);
    const lonOffset = Math.floor(lonStart / HALF_PI) * HALF_PI;
    const latlon = [
      [-PI / 2, 0],
      [PI / 2, 0],
      [0, lonOffset],
      [0, lonOffset + PI / 2],
      [0, lonOffset + PI],
      [0, lonOffset + 3 * PI / 2],
      [latStart, lonEnd],
      [latEnd, lonEnd],
      [latStart, lonStart],
      [latEnd, lonStart],
      [0, lonStart],
      [0, lonEnd],
      [midLat, midLon],
      [latStart, midLon],
      [latEnd, midLon],
      [midLat, lonStart],
      [midLat, lonEnd]
    ];
    const target = [];
    const total = latlon.length;
    for (let z = 0; z <= 1; z++) {
      const height = MathUtils5.mapLinear(z, 0, 1, heightStart, heightEnd);
      for (let i = 0, l = total; i < l; i++) {
        const [lat, lon] = latlon[i];
        if (lat >= latStart && lat <= latEnd && lon >= lonStart && lon <= lonEnd) {
          const v = getVector(usePool);
          target.push(v);
          this.getCartographicToPosition(lat, lon, height, v);
        }
      }
    }
    return target;
  }
  getBoundingBox(box, matrix2) {
    resetPool();
    const {
      latStart,
      latEnd,
      lonStart,
      lonEnd
    } = this;
    const latRange = latEnd - latStart;
    if (latRange < PI / 2) {
      const midLat = MathUtils5.mapLinear(0.5, 0, 1, latStart, latEnd);
      const midLon = MathUtils5.mapLinear(0.5, 0, 1, lonStart, lonEnd);
      this.getCartographicToNormal(midLat, midLon, _orthoZ);
      _orthoY.set(0, 0, 1);
      _orthoX.crossVectors(_orthoY, _orthoZ);
      _orthoY.crossVectors(_orthoX, _orthoZ);
      matrix2.makeBasis(_orthoX, _orthoY, _orthoZ);
    } else {
      _orthoX.set(1, 0, 0);
      _orthoY.set(0, 1, 0);
      _orthoZ.set(0, 0, 1);
      matrix2.makeBasis(_orthoX, _orthoY, _orthoZ);
    }
    _invMatrix.copy(matrix2).invert();
    const points = this._getPoints(true);
    for (let i = 0, l = points.length; i < l; i++) {
      points[i].applyMatrix4(_invMatrix);
    }
    box.makeEmpty();
    box.setFromPoints(points);
  }
  getBoundingSphere(sphere2, center) {
    resetPool();
    const points = this._getPoints(true);
    sphere2.makeEmpty();
    sphere2.setFromPoints(points, center);
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/objects/EllipsoidRegionHelper.js
import { Mesh as Mesh2, Vector3 as Vector312, MathUtils as MathUtils6, BoxGeometry, BufferGeometry as BufferGeometry2, EdgesGeometry, LineSegments as LineSegments2, BufferAttribute as BufferAttribute3 } from "three";
var _norm3 = new Vector312();
var _norm22 = new Vector312();
var _pos2 = new Vector312();
var _vec1 = new Vector312();
var _vec23 = new Vector312();
function getRegionGeometry(ellipsoidRegion, { computeNormals = false } = {}) {
  const {
    latStart = -Math.PI / 2,
    latEnd = Math.PI / 2,
    lonStart = 0,
    lonEnd = 2 * Math.PI,
    heightStart = 0,
    heightEnd = 0
  } = ellipsoidRegion;
  const geometry = new BoxGeometry(1, 1, 1, 32, 32);
  const { normal, position } = geometry.attributes;
  const refPosition = position.clone();
  for (let i = 0, l = position.count; i < l; i++) {
    _pos2.fromBufferAttribute(position, i);
    const lat = MathUtils6.mapLinear(_pos2.x, -0.5, 0.5, latStart, latEnd);
    const lon = MathUtils6.mapLinear(_pos2.y, -0.5, 0.5, lonStart, lonEnd);
    let height = heightStart;
    ellipsoidRegion.getCartographicToNormal(lat, lon, _norm3);
    if (_pos2.z < 0) {
      height = heightEnd;
    }
    ellipsoidRegion.getCartographicToPosition(lat, lon, height, _pos2);
    position.setXYZ(i, ..._pos2);
  }
  if (computeNormals) {
    geometry.computeVertexNormals();
  }
  for (let i = 0, l = refPosition.count; i < l; i++) {
    _pos2.fromBufferAttribute(refPosition, i);
    const lat = MathUtils6.mapLinear(_pos2.x, -0.5, 0.5, latStart, latEnd);
    const lon = MathUtils6.mapLinear(_pos2.y, -0.5, 0.5, lonStart, lonEnd);
    _norm3.fromBufferAttribute(normal, i);
    ellipsoidRegion.getCartographicToNormal(lat, lon, _norm22);
    if (Math.abs(_norm3.dot(_norm22)) > 0.1) {
      if (_pos2.z > 0) {
        _norm22.multiplyScalar(-1);
      }
      normal.setXYZ(i, ..._norm22);
    }
  }
  return geometry;
}
var EllipsoidRegionLineHelper = class extends LineSegments2 {
  constructor(ellipsoidRegion = new EllipsoidRegion(), color = 16776960) {
    super();
    this.ellipsoidRegion = ellipsoidRegion;
    this.material.color.set(color);
    this.update();
  }
  update() {
    const geometry = getRegionGeometry(this.ellipsoidRegion);
    this.geometry.dispose();
    this.geometry = new EdgesGeometry(geometry, 80);
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/DebugTilesPlugin.js
var ORIGINAL_MATERIAL = /* @__PURE__ */ Symbol("ORIGINAL_MATERIAL");
var HAS_RANDOM_COLOR = /* @__PURE__ */ Symbol("HAS_RANDOM_COLOR");
var HAS_RANDOM_NODE_COLOR = /* @__PURE__ */ Symbol("HAS_RANDOM_NODE_COLOR");
var LOAD_TIME = /* @__PURE__ */ Symbol("LOAD_TIME");
var PARENT_BOUND_REF_COUNT = /* @__PURE__ */ Symbol("PARENT_BOUND_REF_COUNT");
var _sphere2 = /* @__PURE__ */ new Sphere5();
var emptyRaycast = () => {
};
var colors = {};
function getIndexedRandomColor(index) {
  if (!colors[index]) {
    const h = Math.random();
    const s = 0.5 + Math.random() * 0.5;
    const l = 0.375 + Math.random() * 0.25;
    colors[index] = new Color().setHSL(h, s, l);
  }
  return colors[index];
}
var NONE = 0;
var SCREEN_ERROR = 1;
var GEOMETRIC_ERROR = 2;
var DISTANCE = 3;
var DEPTH = 4;
var RELATIVE_DEPTH = 5;
var IS_LEAF = 6;
var RANDOM_COLOR = 7;
var RANDOM_NODE_COLOR = 8;
var CUSTOM_COLOR = 9;
var LOAD_ORDER = 10;
var ColorModes = Object.freeze({
  NONE,
  SCREEN_ERROR,
  GEOMETRIC_ERROR,
  DISTANCE,
  DEPTH,
  RELATIVE_DEPTH,
  IS_LEAF,
  RANDOM_COLOR,
  RANDOM_NODE_COLOR,
  CUSTOM_COLOR,
  LOAD_ORDER
});
var DebugTilesPlugin = class {
  static get ColorModes() {
    return ColorModes;
  }
  constructor(options) {
    options = {
      displayParentBounds: false,
      displayBoxBounds: false,
      displaySphereBounds: false,
      displayRegionBounds: false,
      colorMode: NONE,
      maxDebugDepth: -1,
      maxDebugDistance: -1,
      maxDebugError: -1,
      customColorCallback: null,
      ...options
    };
    this.name = "DEBUG_TILES_PLUGIN";
    this.tiles = null;
    this._enabled = true;
    this.extremeDebugDepth = -1;
    this.extremeDebugError = -1;
    this.boxGroup = null;
    this.sphereGroup = null;
    this.regionGroup = null;
    this._displayParentBounds = options.displayParentBounds;
    this.displayBoxBounds = options.displayBoxBounds;
    this.displaySphereBounds = options.displaySphereBounds;
    this.displayRegionBounds = options.displayRegionBounds;
    this.colorMode = options.colorMode;
    this.maxDebugDepth = options.maxDebugDepth;
    this.maxDebugDistance = options.maxDebugDistance;
    this.maxDebugError = options.maxDebugError;
    this.customColorCallback = options.customColorCallback;
    this.getDebugColor = (value, target) => {
      target.setRGB(value, value, value);
    };
  }
  get enabled() {
    return this._enabled;
  }
  set enabled(v) {
    if (v !== this._enabled) {
      this._enabled = v;
      if (this._enabled) {
        if (this.tiles) {
          this.init(this.tiles);
        }
      } else {
        this.dispose();
      }
    }
  }
  get displayParentBounds() {
    return this._displayParentBounds;
  }
  set displayParentBounds(v) {
    if (this._displayParentBounds !== v) {
      this._displayParentBounds = v;
      if (!v) {
        traverseSet(this.tiles.root, null, (tile) => {
          tile[PARENT_BOUND_REF_COUNT] = null;
          this._onTileVisibilityChange(tile, tile.__visible);
        });
      } else {
        this.tiles.traverse((tile) => {
          if (tile.__visible) {
            this._onTileVisibilityChange(tile, true);
          }
        });
      }
    }
  }
  // initialize the groups for displaying helpers, register events, and initialize existing tiles
  init(tiles) {
    this.tiles = tiles;
    const tilesGroup = tiles.group;
    this.boxGroup = new Group();
    this.boxGroup.name = "DebugTilesRenderer.boxGroup";
    tilesGroup.add(this.boxGroup);
    this.boxGroup.updateMatrixWorld();
    this.sphereGroup = new Group();
    this.sphereGroup.name = "DebugTilesRenderer.sphereGroup";
    tilesGroup.add(this.sphereGroup);
    this.sphereGroup.updateMatrixWorld();
    this.regionGroup = new Group();
    this.regionGroup.name = "DebugTilesRenderer.regionGroup";
    tilesGroup.add(this.regionGroup);
    this.regionGroup.updateMatrixWorld();
    this._onLoadTileSetCB = () => {
      this._initExtremes();
    };
    this._onLoadModelCB = ({ scene, tile }) => {
      this._onLoadModel(scene, tile);
    };
    this._onDisposeModelCB = ({ tile }) => {
      this._onDisposeModel(tile);
    };
    this._onUpdateAfterCB = () => {
      this._onUpdateAfter();
    };
    this._onTileVisibilityChangeCB = ({ scene, tile, visible }) => {
      this._onTileVisibilityChange(tile, visible);
    };
    tiles.addEventListener("load-tile-set", this._onLoadTileSetCB);
    tiles.addEventListener("load-model", this._onLoadModelCB);
    tiles.addEventListener("dispose-model", this._onDisposeModelCB);
    tiles.addEventListener("update-after", this._onUpdateAfterCB);
    tiles.addEventListener("tile-visibility-change", this._onTileVisibilityChangeCB);
    this._initExtremes();
    tiles.traverse((tile) => {
      if (tile.cached.scene) {
        this._onLoadModel(tile.cached.scene, tile);
      }
    });
    tiles.visibleTiles.forEach((tile) => {
      this._onTileVisibilityChange(tile, true);
    });
  }
  getTileInformationFromActiveObject(object) {
    let targetTile = null;
    const activeTiles = this.tiles.activeTiles;
    activeTiles.forEach((tile) => {
      if (targetTile) {
        return true;
      }
      const scene = tile.cached.scene;
      if (scene) {
        scene.traverse((c) => {
          if (c === object) {
            targetTile = tile;
          }
        });
      }
    });
    if (targetTile) {
      return {
        distanceToCamera: targetTile.__distanceFromCamera,
        geometricError: targetTile.geometricError,
        screenSpaceError: targetTile.__error,
        depth: targetTile.__depth,
        isLeaf: targetTile.__isLeaf
      };
    } else {
      return null;
    }
  }
  _initExtremes() {
    if (!(this.tiles && this.tiles.root)) {
      return;
    }
    let maxDepth = -1;
    let maxError = -1;
    traverseSet(this.tiles.root, null, (tile, _, depth) => {
      maxDepth = Math.max(maxDepth, depth);
      maxError = Math.max(maxError, tile.geometricError);
    });
    this.extremeDebugDepth = maxDepth;
    this.extremeDebugError = maxError;
  }
  _onUpdateAfter() {
    const tiles = this.tiles;
    if (!tiles.root) {
      return;
    }
    this.boxGroup.visible = this.displayBoxBounds;
    this.sphereGroup.visible = this.displaySphereBounds;
    this.regionGroup.visible = this.displayRegionBounds;
    let maxDepth = -1;
    if (this.maxDebugDepth === -1) {
      maxDepth = this.extremeDebugDepth;
    } else {
      maxDepth = this.maxDebugDepth;
    }
    let maxError = -1;
    if (this.maxDebugError === -1) {
      maxError = this.extremeDebugError;
    } else {
      maxError = this.maxDebugError;
    }
    let maxDistance = -1;
    if (this.maxDebugDistance === -1) {
      tiles.getBoundingSphere(_sphere2);
      maxDistance = _sphere2.radius;
    } else {
      maxDistance = this.maxDebugDistance;
    }
    const errorTarget = this.errorTarget;
    const colorMode = this.colorMode;
    const visibleTiles = tiles.visibleTiles;
    let sortedTiles;
    if (colorMode === LOAD_ORDER) {
      sortedTiles = Array.from(visibleTiles).sort((a, b) => {
        return a[LOAD_TIME] - b[LOAD_TIME];
      });
    }
    visibleTiles.forEach((tile) => {
      const scene = tile.cached.scene;
      let h, s, l;
      if (colorMode === RANDOM_COLOR) {
        h = Math.random();
        s = 0.5 + Math.random() * 0.5;
        l = 0.375 + Math.random() * 0.25;
      }
      scene.traverse((c) => {
        if (colorMode === RANDOM_NODE_COLOR) {
          h = Math.random();
          s = 0.5 + Math.random() * 0.5;
          l = 0.375 + Math.random() * 0.25;
        }
        const currMaterial = c.material;
        if (currMaterial) {
          const originalMaterial = c[ORIGINAL_MATERIAL];
          if (colorMode === NONE && currMaterial !== originalMaterial) {
            c.material.dispose();
            c.material = c[ORIGINAL_MATERIAL];
          } else if (colorMode !== NONE && currMaterial === originalMaterial) {
            if (c.isPoints) {
              const pointsMaterial = new PointsMaterial();
              pointsMaterial.size = originalMaterial.size;
              pointsMaterial.sizeAttenuation = originalMaterial.sizeAttenuation;
              c.material = pointsMaterial;
            } else {
              c.material = new MeshStandardMaterial();
              c.material.flatShading = true;
            }
          }
          if (colorMode !== RANDOM_COLOR) {
            delete c.material[HAS_RANDOM_COLOR];
          }
          if (colorMode !== RANDOM_NODE_COLOR) {
            delete c.material[HAS_RANDOM_NODE_COLOR];
          }
          switch (colorMode) {
            case DEPTH: {
              const val = tile.__depth / maxDepth;
              this.getDebugColor(val, c.material.color);
              break;
            }
            case RELATIVE_DEPTH: {
              const val = tile.__depthFromRenderedParent / maxDepth;
              this.getDebugColor(val, c.material.color);
              break;
            }
            case SCREEN_ERROR: {
              const val = tile.__error / errorTarget;
              if (val > 1) {
                c.material.color.setRGB(1, 0, 0);
              } else {
                this.getDebugColor(val, c.material.color);
              }
              break;
            }
            case GEOMETRIC_ERROR: {
              const val = Math.min(tile.geometricError / maxError, 1);
              this.getDebugColor(val, c.material.color);
              break;
            }
            case DISTANCE: {
              const val = Math.min(tile.__distanceFromCamera / maxDistance, 1);
              this.getDebugColor(val, c.material.color);
              break;
            }
            case IS_LEAF: {
              if (!tile.children || tile.children.length === 0) {
                this.getDebugColor(1, c.material.color);
              } else {
                this.getDebugColor(0, c.material.color);
              }
              break;
            }
            case RANDOM_NODE_COLOR: {
              if (!c.material[HAS_RANDOM_NODE_COLOR]) {
                c.material.color.setHSL(h, s, l);
                c.material[HAS_RANDOM_NODE_COLOR] = true;
              }
              break;
            }
            case RANDOM_COLOR: {
              if (!c.material[HAS_RANDOM_COLOR]) {
                c.material.color.setHSL(h, s, l);
                c.material[HAS_RANDOM_COLOR] = true;
              }
              break;
            }
            case CUSTOM_COLOR: {
              if (this.customColorCallback) {
                this.customColorCallback(tile, c);
              } else {
                console.warn("DebugTilesRenderer: customColorCallback not defined");
              }
              break;
            }
            case LOAD_ORDER: {
              const value = sortedTiles.indexOf(tile);
              this.getDebugColor(value / (sortedTiles.length - 1), c.material.color);
              break;
            }
          }
        }
      });
    });
  }
  _onTileVisibilityChange(tile, visible) {
    if (this.displayParentBounds) {
      traverseAncestors(tile, (current) => {
        if (current[PARENT_BOUND_REF_COUNT] == null) {
          current[PARENT_BOUND_REF_COUNT] = 0;
        }
        if (visible) {
          current[PARENT_BOUND_REF_COUNT]++;
        } else if (current[PARENT_BOUND_REF_COUNT] > 0) {
          current[PARENT_BOUND_REF_COUNT]--;
        }
        const tileVisible = current === tile && visible || this.displayParentBounds && current[PARENT_BOUND_REF_COUNT] > 0;
        this._updateBoundHelper(current, tileVisible);
      });
    } else {
      this._updateBoundHelper(tile, visible);
    }
  }
  _createBoundHelper(tile) {
    const tiles = this.tiles;
    const cached = tile.cached;
    const { sphere: sphere2, obb, region } = cached.boundingVolume;
    if (obb) {
      const boxHelperGroup = new Group();
      boxHelperGroup.name = "DebugTilesRenderer.boxHelperGroup";
      boxHelperGroup.matrix.copy(obb.transform);
      boxHelperGroup.matrixAutoUpdate = false;
      const boxHelper = new Box3Helper(obb.box, getIndexedRandomColor(tile.__depth));
      boxHelper.raycast = emptyRaycast;
      boxHelperGroup.add(boxHelper);
      cached.boxHelperGroup = boxHelperGroup;
      if (tiles.visibleTiles.has(tile) && this.displayBoxBounds) {
        this.boxGroup.add(boxHelperGroup);
        boxHelperGroup.updateMatrixWorld(true);
      }
    }
    if (sphere2) {
      const sphereHelper = new SphereHelper(sphere2, getIndexedRandomColor(tile.__depth));
      sphereHelper.raycast = emptyRaycast;
      cached.sphereHelper = sphereHelper;
      if (tiles.visibleTiles.has(tile) && this.displaySphereBounds) {
        this.sphereGroup.add(sphereHelper);
        sphereHelper.updateMatrixWorld(true);
      }
    }
    if (region) {
      const regionHelper = new EllipsoidRegionLineHelper(region, getIndexedRandomColor(tile.__depth));
      regionHelper.raycast = emptyRaycast;
      const sphere3 = new Sphere5();
      region.getBoundingSphere(sphere3);
      regionHelper.position.copy(sphere3.center);
      sphere3.center.multiplyScalar(-1);
      regionHelper.geometry.translate(...sphere3.center);
      cached.regionHelper = regionHelper;
      if (tiles.visibleTiles.has(tile) && this.displayRegionBounds) {
        this.regionGroup.add(regionHelper);
        regionHelper.updateMatrixWorld(true);
      }
    }
  }
  _updateHelperMaterial(tile, material) {
    if (tile.__visible || !this.displayParentBounds) {
      material.opacity = 1;
    } else {
      material.opacity = 0.2;
    }
    const transparent = material.transparent;
    material.transparent = material.opacity < 1;
    if (material.transparent !== transparent) {
      material.needsUpdate = true;
    }
  }
  _updateBoundHelper(tile, visible) {
    const cached = tile.cached;
    if (!cached) {
      return;
    }
    const sphereGroup = this.sphereGroup;
    const boxGroup = this.boxGroup;
    const regionGroup = this.regionGroup;
    if (visible && (cached.boxHelperGroup == null && cached.sphereHelper == null && cached.regionHelper == null)) {
      this._createBoundHelper(tile);
    }
    const boxHelperGroup = cached.boxHelperGroup;
    const sphereHelper = cached.sphereHelper;
    const regionHelper = cached.regionHelper;
    if (!visible) {
      if (boxHelperGroup) {
        boxGroup.remove(boxHelperGroup);
      }
      if (sphereHelper) {
        sphereGroup.remove(sphereHelper);
      }
      if (regionHelper) {
        regionGroup.remove(regionHelper);
      }
    } else {
      if (boxHelperGroup) {
        boxGroup.add(boxHelperGroup);
        boxHelperGroup.updateMatrixWorld(true);
        this._updateHelperMaterial(tile, boxHelperGroup.children[0].material);
      }
      if (sphereHelper) {
        sphereGroup.add(sphereHelper);
        sphereHelper.updateMatrixWorld(true);
        this._updateHelperMaterial(tile, sphereHelper.material);
      }
      if (regionHelper) {
        regionGroup.add(regionHelper);
        regionHelper.updateMatrixWorld(true);
        this._updateHelperMaterial(tile, regionHelper.material);
      }
    }
  }
  _onLoadModel(scene, tile) {
    tile[LOAD_TIME] = performance.now();
    scene.traverse((c) => {
      const material = c.material;
      if (material) {
        c[ORIGINAL_MATERIAL] = material;
      }
    });
  }
  _onDisposeModel(tile) {
    const cached = tile.cached;
    if (cached.boxHelperGroup) {
      cached.boxHelperGroup.children[0].geometry.dispose();
      delete cached.boxHelperGroup;
    }
    if (cached.sphereHelper) {
      cached.sphereHelper.geometry.dispose();
      delete cached.sphereHelper;
    }
    if (cached.regionHelper) {
      cached.regionHelper.geometry.dispose();
      delete cached.regionHelper;
    }
  }
  dispose() {
    const tiles = this.tiles;
    if (tiles) {
      tiles.removeEventListener("load-tile-set", this._onLoadTileSetCB);
      tiles.removeEventListener("load-model", this._onLoadModelCB);
      tiles.removeEventListener("dispose-model", this._onDisposeModelCB);
      tiles.removeEventListener("update-after", this._onUpdateAfterCB);
      tiles.removeEventListener("tile-visibility-change", this._onTileVisibilityChangeCB);
      this.colorMode = NONE;
      this._onUpdateAfter();
      tiles.traverse((tile) => {
        this._onDisposeModel(tile);
      });
    }
    this.boxGroup?.removeFromParent();
    this.sphereGroup?.removeFromParent();
    this.regionGroup?.removeFromParent();
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/images/ImageFormatPlugin.js
import { MathUtils as MathUtils7, Mesh as Mesh3, MeshBasicMaterial as MeshBasicMaterial3, PlaneGeometry, SRGBColorSpace, Texture } from "three";

// node_modules/3d-tiles-renderer/src/utilities/PriorityQueue.js
var PriorityQueue = class {
  constructor() {
    this.maxJobs = 6;
    this.items = [];
    this.callbacks = /* @__PURE__ */ new Map();
    this.currJobs = 0;
    this.scheduled = false;
    this.autoUpdate = true;
    this.priorityCallback = () => {
      throw new Error("PriorityQueue: PriorityCallback function not defined.");
    };
    this.schedulingCallback = (func) => {
      requestAnimationFrame(func);
    };
    this._runjobs = () => {
      this.tryRunJobs();
      this.scheduled = false;
    };
  }
  sort() {
    const priorityCallback = this.priorityCallback;
    const items = this.items;
    items.sort(priorityCallback);
  }
  add(item, callback) {
    return new Promise((resolve, reject) => {
      const prCallback = (...args) => callback(...args).then(resolve).catch(reject);
      const items = this.items;
      const callbacks = this.callbacks;
      items.push(item);
      callbacks.set(item, prCallback);
      if (this.autoUpdate) {
        this.scheduleJobRun();
      }
    });
  }
  remove(item) {
    const items = this.items;
    const callbacks = this.callbacks;
    const index = items.indexOf(item);
    if (index !== -1) {
      items.splice(index, 1);
      callbacks.delete(item);
    }
  }
  tryRunJobs() {
    this.sort();
    const items = this.items;
    const callbacks = this.callbacks;
    const maxJobs = this.maxJobs;
    let currJobs = this.currJobs;
    while (maxJobs > currJobs && items.length > 0) {
      currJobs++;
      const item = items.pop();
      const callback = callbacks.get(item);
      callbacks.delete(item);
      callback(item).then(() => {
        this.currJobs--;
        if (this.autoUpdate) {
          this.scheduleJobRun();
        }
      }).catch(() => {
        this.currJobs--;
        if (this.autoUpdate) {
          this.scheduleJobRun();
        }
      });
    }
    this.currJobs = currJobs;
  }
  scheduleJobRun() {
    if (!this.scheduled) {
      this.schedulingCallback(this._runjobs);
      this.scheduled = true;
    }
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/images/ImageFormatPlugin.js
var TILE_X = /* @__PURE__ */ Symbol("TILE_X");
var TILE_Y = /* @__PURE__ */ Symbol("TILE_Y");
var TILE_LEVEL = /* @__PURE__ */ Symbol("TILE_LEVEL");
var UV_BOUNDS = /* @__PURE__ */ Symbol("UV_BOUNDS");
var ImageFormatPlugin = class {
  get maxLevel() {
    return this.levels - 1;
  }
  constructor(options = {}) {
    const {
      pixelSize = 0.01,
      center = false,
      useRecommendedSettings = true
    } = options;
    this.priority = -10;
    this.tiles = null;
    this.processQueue = null;
    this.processCallback = null;
    this.tileWidth = null;
    this.tileHeight = null;
    this.width = null;
    this.height = null;
    this.levels = null;
    this.overlap = 0;
    this.pixelSize = pixelSize;
    this.center = center;
    this.useRecommendedSettings = useRecommendedSettings;
    this.flipY = false;
    this._tilesNeedUpdate = true;
  }
  init(tiles) {
    const processQueue = new PriorityQueue();
    processQueue.priorityCallback = tiles.downloadQueue.priorityCallback;
    processQueue.maxJobs = 20;
    if (this.useRecommendedSettings) {
      tiles.errorTarget = window.devicePixelRatio;
    }
    this.processCallback = (tile) => {
      const level = tile[TILE_LEVEL];
      const x = tile[TILE_X];
      const y = tile[TILE_Y];
      for (let cx = 0; cx < 2; cx++) {
        for (let cy = 0; cy < 2; cy++) {
          const child = this.expand(level + 1, 2 * x + cx, 2 * y + cy);
          if (child) {
            tile.children.push(child);
          }
        }
      }
      this._tilesNeedUpdate = true;
      return Promise.resolve();
    };
    this.processQueue = processQueue;
    this.tiles = tiles;
  }
  async parseToMesh(buffer, tile, extension, uri, abortSignal) {
    const blob = new Blob([buffer]);
    const imageBitmap = await createImageBitmap(blob, {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
      imageOrientation: "flipY"
    });
    const texture = new Texture(imageBitmap);
    texture.generateMipmaps = false;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    let sx = 1, sy = 1;
    let x = 0, y = 0, z = 0;
    const boundingBox = tile.boundingVolume.box;
    if (boundingBox) {
      [x, y, z] = boundingBox;
      sx = boundingBox[3];
      sy = boundingBox[7];
    }
    const mesh = new Mesh3(new PlaneGeometry(2 * sx, 2 * sy), new MeshBasicMaterial3({ map: texture }));
    mesh.position.set(x, y, z);
    return mesh;
  }
  preprocessNode(tile, dir, parentTile) {
    const { maxLevel } = this;
    const level = tile[TILE_LEVEL];
    if (level < maxLevel) {
      this.processQueue.add(tile, this.processCallback);
      this._tilesNeedUpdate = true;
    }
  }
  getTileset(baseUrl) {
    const tileset = {
      asset: {
        version: "1.1"
      },
      geometricError: 1e5,
      root: {
        refine: "REPLACE",
        geometricError: 1e5,
        boundingVolume: {},
        children: []
      }
    };
    const { maxLevel, width, height, tileWidth, tileHeight, center, pixelSize } = this;
    const levelFactor = 2 ** -maxLevel;
    const tilesX = Math.ceil(levelFactor * width / tileWidth);
    const tilesY = Math.ceil(levelFactor * height / tileHeight);
    for (let x = 0; x < tilesX; x++) {
      for (let y = 0; y < tilesY; y++) {
        tileset.root.children.push(this.expand(0, x, y));
      }
    }
    const minX = center ? -width / 2 : 0;
    const minY = center ? -height / 2 : 0;
    tileset.root.boundingVolume.box = [
      pixelSize * (minX + width / 2),
      pixelSize * (minY + height / 2),
      0,
      pixelSize * width / 2,
      0,
      0,
      0,
      pixelSize * height / 2,
      0,
      0,
      0,
      0
    ];
    tileset.root[UV_BOUNDS] = [0, 0, 1, 1];
    this.tiles.preprocessTileSet(tileset, baseUrl);
    return tileset;
  }
  getUrl(level, x, y) {
  }
  expand(level, x, y) {
    const { maxLevel, width, height, overlap, pixelSize, center, tileWidth, tileHeight, flipY } = this;
    const offsetX = center ? pixelSize * -width / 2 : 0;
    const offsetY = center ? pixelSize * -height / 2 : 0;
    const levelFactor = 2 ** -(maxLevel - level);
    const levelWidth = Math.ceil(width * levelFactor);
    const levelHeight = Math.ceil(height * levelFactor);
    let tileX = tileWidth * x - overlap;
    let tileY = tileHeight * y - overlap;
    let tileWidthOverlap = tileWidth + overlap * 2;
    let tileHeightOverlap = tileHeight + overlap * 2;
    if (tileX < 0) {
      tileWidthOverlap += tileX;
      tileX = 0;
    }
    if (tileY < 0) {
      tileHeightOverlap += tileY;
      tileY = 0;
    }
    if (tileX + tileWidthOverlap > levelWidth) {
      tileWidthOverlap -= tileX + tileWidthOverlap - levelWidth;
    }
    if (tileY + tileHeightOverlap > levelHeight) {
      tileHeightOverlap -= tileY + tileHeightOverlap - levelHeight;
    }
    if (tileHeightOverlap <= 0 || tileWidthOverlap <= 0) {
      return null;
    }
    const centerX = tileX + tileWidthOverlap / 2;
    let centerY = tileY + tileHeightOverlap / 2;
    if (flipY) {
      centerY = levelHeight - centerY;
    }
    const ratioX = width / levelWidth;
    const ratioY = height / levelHeight;
    const boxX = ratioX * pixelSize * centerX;
    const boxY = ratioY * pixelSize * centerY;
    const extentsX = ratioX * pixelSize * tileWidthOverlap / 2;
    const extentsY = ratioY * pixelSize * tileHeightOverlap / 2;
    return {
      refine: "REPLACE",
      geometricError: pixelSize * (Math.max(width / levelWidth, height / levelHeight) - 1),
      boundingVolume: {
        // DZI operates in a left handed coordinate system so we have to flip y to orient it correctly. FlipY
        // is also enabled on the image bitmap texture generation above.
        box: [
          // center
          boxX + offsetX,
          boxY + offsetY,
          0,
          // x, y, z half vectors
          extentsX,
          0,
          0,
          0,
          extentsY,
          0,
          0,
          0,
          0
        ]
      },
      content: {
        uri: this.getUrl(level, x, y)
      },
      children: [],
      // save the tile params so we can expand later
      [TILE_X]: x,
      [TILE_Y]: y,
      [TILE_LEVEL]: level,
      [UV_BOUNDS]: [
        MathUtils7.mapLinear(boxX - extentsX, 0, pixelSize * width, 0, 1),
        MathUtils7.mapLinear(boxY - extentsY, 0, pixelSize * height, 0, 1),
        MathUtils7.mapLinear(boxX + extentsX, 0, pixelSize * width, 0, 1),
        MathUtils7.mapLinear(boxY + extentsY, 0, pixelSize * height, 0, 1)
      ]
    };
  }
  doTilesNeedUpdate() {
    if (this._tilesNeedUpdate) {
      this._tilesNeedUpdate = false;
      return true;
    }
    return null;
  }
};
var DeepZoomImagePlugin = class extends ImageFormatPlugin {
  constructor(...args) {
    super(...args);
    this.name = "DZI_TILES_PLUGIN";
    this.stem = null;
    this.format = null;
    this.flipY = true;
  }
  getUrl(level, x, y) {
    return `${this.stem}_files/${level}/${x}_${y}.${this.format}`;
  }
  loadRootTileSet() {
    const { tiles } = this;
    let url = tiles.rootURL;
    tiles.invokeAllPlugins((plugin) => url = plugin.preprocessURL ? plugin.preprocessURL(url, null) : url);
    return tiles.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(url, this.tiles.fetchOptions)).then((res) => res.text()).then((text) => {
      const xml = new DOMParser().parseFromString(text, "text/xml");
      if (xml.querySelector("DisplayRects") || xml.querySelector("Collection")) {
        throw new Error("DeepZoomImagesPlugin: DisplayRect and Collection DZI files not supported.");
      }
      const image = xml.querySelector("Image");
      const size = image.querySelector("Size");
      const tileSize = parseInt(image.getAttribute("TileSize"));
      this.tileWidth = tileSize;
      this.tileHeight = tileSize;
      this.overlap = parseInt(image.getAttribute("Overlap"));
      this.format = image.getAttribute("Format");
      this.width = parseInt(size.getAttribute("Width"));
      this.height = parseInt(size.getAttribute("Height"));
      this.levels = Math.ceil(Math.log2(Math.max(this.width, this.height))) + 1;
      this.stem = url.split(/\.[^.]+$/g)[0];
      return this.getTileset(url);
    });
  }
};

// node_modules/3d-tiles-renderer/src/plugins/three/images/EllipsoidProjectionTilesPlugin.js
import { MathUtils as MathUtils8, PlaneGeometry as PlaneGeometry2, Sphere as Sphere6, Vector2 as Vector26, Vector3 as Vector313 } from "three";
var _pos3 = /* @__PURE__ */ new Vector313();
var _norm4 = /* @__PURE__ */ new Vector313();
var _uv4 = /* @__PURE__ */ new Vector26();
var _sphere3 = /* @__PURE__ */ new Sphere6();
var _v0 = /* @__PURE__ */ new Vector313();
var _v1 = /* @__PURE__ */ new Vector313();
var EllipsoidProjectionTilesPlugin = class extends ImageFormatPlugin {
  constructor(options = {}) {
    const {
      shape = "planar",
      endCaps = true,
      ...rest
    } = options;
    super(rest);
    this.shape = shape;
    this.projection = "geodetic";
    this.endCaps = endCaps;
    this.minLat = -Math.PI / 2;
    this.maxLat = Math.PI / 2;
    this.minLon = -Math.PI;
    this.maxLon = Math.PI;
  }
  // override the parse to mesh logic to support a region mesh
  async parseToMesh(buffer, tile, ...args) {
    const { shape, projection, tiles } = this;
    const mesh = await super.parseToMesh(buffer, tile, ...args);
    if (shape === "ellipsoid") {
      const ellipsoid = tiles.ellipsoid;
      const [minU, minV, maxU, maxV] = tile[UV_BOUNDS];
      const [west, south, east, north] = tile.boundingVolume.region;
      const MAX_LON_VERTS = 30;
      const MAX_LAT_VERTS = 15;
      const latVerts = Math.ceil((north - south) * MathUtils8.RAD2DEG * 0.25);
      const lonVerts = Math.ceil((east - west) * MathUtils8.RAD2DEG * 0.25);
      const yVerts = Math.max(MAX_LAT_VERTS, latVerts);
      const xVerts = Math.max(MAX_LON_VERTS, lonVerts);
      const geometry = new PlaneGeometry2(
        1,
        1,
        xVerts,
        yVerts
      );
      const { position, normal, uv } = geometry.attributes;
      const vertCount = position.count;
      tile.cached.boundingVolume.getSphere(_sphere3);
      for (let i = 0; i < vertCount; i++) {
        _pos3.fromBufferAttribute(position, i);
        _norm4.fromBufferAttribute(normal, i);
        _uv4.fromBufferAttribute(uv, i);
        const lon = MathUtils8.mapLinear(_uv4.x, 0, 1, west, east);
        let lat = MathUtils8.mapLinear(_uv4.y, 0, 1, south, north);
        if (projection === "mercator" && _uv4.y !== 0 && _uv4.y !== 1) {
          const latLimit = this.mercatorToLatitude(1);
          const vStep = 1 / yVerts;
          const prevLat = MathUtils8.mapLinear(_uv4.y - vStep, 0, 1, south, north);
          const nextLat = MathUtils8.mapLinear(_uv4.y + vStep, 0, 1, south, north);
          if (lat > latLimit && prevLat < latLimit) {
            lat = latLimit;
          }
          if (lat < -latLimit && nextLat > -latLimit) {
            lat = -latLimit;
          }
        }
        ellipsoid.getCartographicToPosition(lat, lon, 0, _pos3).sub(_sphere3.center);
        ellipsoid.getCartographicToNormal(lat, lon, _norm4);
        position.setXYZ(i, ..._pos3);
        normal.setXYZ(i, ..._norm4);
        if (projection === "mercator") {
          const u = MathUtils8.mapLinear(this.longitudeToMercator(lon), minU, maxU, 0, 1);
          const v = MathUtils8.mapLinear(this.latitudeToMercator(lat), minV, maxV, 0, 1);
          uv.setXY(i, u, v);
        }
      }
      mesh.geometry = geometry;
      mesh.position.copy(_sphere3.center);
    }
    return mesh;
  }
  preprocessNode(tile, ...rest) {
    super.preprocessNode(tile, rest);
    const { shape, projection, tileWidth, tileHeight, width, height, endCaps } = this;
    if (shape === "ellipsoid") {
      const [minU, minV, maxU, maxV] = tile[UV_BOUNDS];
      const tileUWidth = (maxU - minU) / tileWidth;
      const tileVWidth = (maxV - minV) / tileHeight;
      const rootUWidth = 1 / width;
      const rootVWidth = 1 / height;
      let south, north, west, east;
      if (projection === "mercator") {
        south = this.mercatorToLatitude(minV);
        north = this.mercatorToLatitude(maxV);
        west = this.mercatorToLongitude(minU);
        east = this.mercatorToLongitude(maxU);
        if (endCaps) {
          if (maxV === 1) {
            north = Math.PI / 2;
          }
          if (minV === 0) {
            south = -Math.PI / 2;
          }
        }
      } else {
        const { minLat, maxLat, minLon, maxLon } = this;
        south = MathUtils8.lerp(minLat, maxLat, minV);
        north = MathUtils8.lerp(minLat, maxLat, maxV);
        west = MathUtils8.lerp(minLon, maxLon, minU);
        east = MathUtils8.lerp(minLon, maxLon, maxU);
      }
      tile.boundingVolume.region = [
        west,
        south,
        east,
        north,
        -1,
        1
        // min / max height
      ];
      const midLat = south > 0 !== north > 0 ? 0 : Math.min(Math.abs(south), Math.abs(north));
      let latFactor, lonFactor;
      if (projection === "mercator") {
        const mercatorY = this.latitudeToMercator(midLat);
        [latFactor, lonFactor] = this.getMercatorToCartographicDerivative(minU, mercatorY);
      } else {
        latFactor = Math.PI;
        lonFactor = 2 * Math.PI;
      }
      const [xDeriv, yDeriv] = this.getCartographicToMeterDerivative(midLat, east);
      const tilePixelWidth = Math.max(tileUWidth * lonFactor * xDeriv, tileVWidth * latFactor * yDeriv);
      const rootPixelWidth = Math.max(rootUWidth * lonFactor * xDeriv, rootVWidth * latFactor * yDeriv);
      tile.geometricError = tilePixelWidth - rootPixelWidth;
      delete tile.boundingVolume.box;
      if (tile.parent === null) {
        tile.geometricError = 1e50;
      }
    }
    return tile;
  }
  latitudeToMercator(lat) {
    const mercatorN = Math.log(Math.tan(Math.PI / 4 + lat / 2));
    return 1 / 2 + 1 * mercatorN / (2 * Math.PI);
  }
  longitudeToMercator(lon) {
    return (lon + Math.PI) / (2 * Math.PI);
  }
  mercatorToLatitude(value) {
    const ratio = MathUtils8.mapLinear(value, 0, 1, -1, 1);
    return 2 * Math.atan(Math.exp(ratio * Math.PI)) - Math.PI / 2;
  }
  mercatorToLongitude(value) {
    const { minLon, maxLon } = this;
    return MathUtils8.mapLinear(value, 0, 1, minLon, maxLon);
  }
  getMercatorToCartographicDerivative(x, y) {
    const EPS = 1e-5;
    let xp = x - EPS;
    let yp = y - EPS;
    if (xp < 0) {
      xp = x + EPS;
    }
    if (yp < 0) {
      yp = y + EPS;
    }
    return [
      Math.abs(this.mercatorToLatitude(y) - this.mercatorToLatitude(yp)) / EPS,
      Math.abs(this.mercatorToLongitude(x) - this.mercatorToLongitude(xp)) / EPS
    ];
  }
  getCartographicToMeterDerivative(lat, lon) {
    const { tiles } = this;
    const { ellipsoid } = tiles;
    const EPS = 1e-5;
    const lonp = lon + EPS;
    let latp = lat + EPS;
    if (Math.abs(latp) > Math.PI / 2) {
      latp = latp - EPS;
    }
    ellipsoid.getCartographicToPosition(lat, lon, 0, _v0);
    ellipsoid.getCartographicToPosition(latp, lon, 0, _v1);
    const dy = _v0.distanceTo(_v1) / EPS;
    ellipsoid.getCartographicToPosition(lat, lonp, 0, _v1);
    const dx = _v0.distanceTo(_v1) / EPS;
    return [dx, dy];
  }
};
var XYZTilesPlugin = class extends EllipsoidProjectionTilesPlugin {
  constructor(options = {}) {
    const {
      levels = 20,
      tileDimension = 256,
      pixelSize = 1e-5,
      ...rest
    } = options;
    super({ pixelSize, ...rest });
    this.name = "XYZ_TILES_PLUGIN";
    this.tileWidth = tileDimension;
    this.tileHeight = tileDimension;
    this.levels = levels;
    this.url = null;
    this.flipY = true;
  }
  async loadRootTileSet() {
    const { tiles, tileWidth, tileHeight, maxLevel } = this;
    let url = tiles.rootURL;
    tiles.invokeAllPlugins((plugin) => url = plugin.preprocessURL ? plugin.preprocessURL(url, null) : url);
    this.width = tileWidth * 2 ** maxLevel;
    this.height = tileHeight * 2 ** maxLevel;
    this.url = url;
    this.projection = "mercator";
    return this.getTileset(url);
  }
  getUrl(level, x, y) {
    return this.url.replace("{z}", level).replace("{x}", x).replace("{y}", y);
  }
};
var TMSTilesPlugin = class extends EllipsoidProjectionTilesPlugin {
  constructor(...args) {
    super(...args);
    this.name = "TMS_TILES_PLUGIN";
    this.flipY = false;
    this.url = null;
    this.extension = null;
  }
  loadRootTileSet() {
    const url = new URL("tilemapresource.xml", this.tiles.rootURL).toString();
    return this.tiles.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(url, this.tiles.fetchOptions)).then((res) => res.text()).then((text) => {
      const xml = new DOMParser().parseFromString(text, "text/xml");
      const tileFormat = xml.querySelector("TileFormat");
      const tileSets = xml.querySelector("TileSets");
      const tileSetList = [...tileSets.querySelectorAll("TileSet")].map((ts) => ({
        href: parseInt(ts.getAttribute("href")),
        unitsPerPixel: parseFloat(ts.getAttribute("units-per-pixel")),
        order: parseInt(ts.getAttribute("order"))
      })).sort((a, b) => {
        return a.order - b.order;
      });
      const tileWidth = parseInt(tileFormat.getAttribute("width"));
      const tileHeight = parseInt(tileFormat.getAttribute("height"));
      const extension = tileFormat.getAttribute("extension");
      const profile = tileSets.getAttribute("profile");
      const srs = xml.querySelector("SRS").textContent;
      switch (srs) {
        case "EPSG:3857":
        // web-mercator spherical projection
        case "EPSG:4326":
          break;
        default:
          throw new Error(`TMSTilesPlugin: ${srs} SRS not supported.`);
      }
      let widthMultiplier = 1;
      let heightMultiplier = 1;
      switch (profile) {
        case "geodetic":
        case "global-geodetic":
          widthMultiplier = 2;
          heightMultiplier = 1;
          this.projection = "geodetic";
          break;
        case "mercator":
        case "global-mercator":
          this.projection = "mercator";
          break;
        case "local":
        case "none":
        default:
          throw new Error(`TMSTilesPlugin: Profile ${profile} not supported.`);
      }
      const levels = tileSetList.length;
      const maxLevel = levels - 1;
      this.extension = extension;
      this.width = widthMultiplier * tileWidth * 2 ** maxLevel;
      this.height = heightMultiplier * tileHeight * 2 ** maxLevel;
      this.tileWidth = tileWidth;
      this.tileHeight = tileHeight;
      this.levels = levels;
      this.url = this.tiles.rootURL;
      this.tileSets = tileSetList;
      return this.getTileset(url);
    });
  }
  getUrl(level, x, y) {
    const { url, extension, tileSets } = this;
    return new URL(`${parseInt(tileSets[level].href)}/${x}/${y}.${extension}`, url).toString();
  }
};

// node_modules/3d-tiles-renderer/src/base/loaders/LoaderBase.js
var LoaderBase = class {
  constructor() {
    this.fetchOptions = {};
    this.workingPath = "";
  }
  load(url) {
    console.warn('Loader: "load" function has been deprecated in favor of "loadAsync".');
    return this.loadAsync(url);
  }
  loadAsync(url) {
    return fetch(url, this.fetchOptions).then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to load file "${url}" with status ${res.status} : ${res.statusText}`);
      }
      return res.arrayBuffer();
    }).then((buffer) => {
      if (this.workingPath === "") {
        this.workingPath = this.workingPathForURL(url);
      }
      return this.parse(buffer);
    });
  }
  resolveExternalURL(url) {
    if (/^[^\\/]/.test(url) && !/^http/.test(url)) {
      return this.workingPath + "/" + url;
    } else {
      return url;
    }
  }
  workingPathForURL(url) {
    const splits = url.split(/[\\/]/g);
    splits.pop();
    const workingPath = splits.join("/");
    return workingPath + "/";
  }
  parse(buffer) {
    throw new Error("LoaderBase: Parse not implemented.");
  }
};

// node_modules/3d-tiles-renderer/src/utilities/readMagicBytes.js
function readMagicBytes(bufferOrDataView) {
  let view;
  if (bufferOrDataView instanceof DataView) {
    view = bufferOrDataView;
  } else {
    view = new DataView(bufferOrDataView);
  }
  if (String.fromCharCode(view.getUint8(0)) === "{") {
    return null;
  }
  let magicBytes = "";
  for (let i = 0; i < 4; i++) {
    magicBytes += String.fromCharCode(view.getUint8(i));
  }
  return magicBytes;
}

// node_modules/3d-tiles-renderer/src/utilities/arrayToString.js
var utf8decoder = new TextDecoder();
function arrayToString(array) {
  return utf8decoder.decode(array);
}

// node_modules/3d-tiles-renderer/src/plugins/base/SUBTREELoader.js
function isOctreeSubdivision(tile) {
  return tile.__implicitRoot.implicitTiling.subdivisionScheme === "OCTREE";
}
function getBoundsDivider(tile) {
  return isOctreeSubdivision(tile) ? 8 : 4;
}
function getSubtreeCoordinates(tile, parentTile) {
  if (!parentTile) {
    return [0, 0, 0];
  }
  const x = 2 * parentTile.__x + tile.__subtreeIdx % 2;
  const y = 2 * parentTile.__y + Math.floor(tile.__subtreeIdx / 2) % 2;
  const z = isOctreeSubdivision(tile) ? 2 * parentTile.__z + Math.floor(tile.__subtreeIdx / 4) % 2 : 0;
  return [x, y, z];
}
var SubtreeTile = class {
  constructor(parentTile, childMortonIndex) {
    this.parent = parentTile;
    this.children = [];
    this.__level = parentTile.__level + 1;
    this.__implicitRoot = parentTile.__implicitRoot;
    this.__subtreeIdx = childMortonIndex;
    [this.__x, this.__y, this.__z] = getSubtreeCoordinates(this, parentTile);
  }
  static copy(tile) {
    const copyTile = {};
    copyTile.children = [];
    copyTile.__level = tile.__level;
    copyTile.__implicitRoot = tile.__implicitRoot;
    copyTile.__subtreeIdx = tile.__subtreeIdx;
    [copyTile.__x, copyTile.__y, copyTile.__z] = [tile.__x, tile.__y, tile.__z];
    copyTile.boundingVolume = tile.boundingVolume;
    copyTile.geometricError = tile.geometricError;
    return copyTile;
  }
};
var SUBTREELoader = class extends LoaderBase {
  constructor(tile) {
    super();
    this.tile = tile;
    this.rootTile = tile.__implicitRoot;
  }
  /**
   * A helper object for storing the two parts of the subtree binary
   *
   * @typedef {object} Subtree
   * @property {number} version
   * @property {JSON} subtreeJson
   * @property {ArrayBuffer} subtreeByte
   * @private
   */
  /**
   *
   * @param buffer
   * @return {Subtree}
   */
  parseBuffer(buffer) {
    const dataView = new DataView(buffer);
    let offset = 0;
    const magic = readMagicBytes(dataView);
    console.assert(magic === "subt", 'SUBTREELoader: The magic bytes equal "subt".');
    offset += 4;
    const version = dataView.getUint32(offset, true);
    console.assert(version === 1, 'SUBTREELoader: The version listed in the header is "1".');
    offset += 4;
    const jsonLength = dataView.getUint32(offset, true);
    offset += 8;
    const byteLength = dataView.getUint32(offset, true);
    offset += 8;
    const subtreeJson = JSON.parse(arrayToString(new Uint8Array(buffer, offset, jsonLength)));
    offset += jsonLength;
    const subtreeByte = buffer.slice(offset, offset + byteLength);
    return {
      version,
      subtreeJson,
      subtreeByte
    };
  }
  parse(buffer) {
    const subtree = this.parseBuffer(buffer);
    const subtreeJson = subtree.subtreeJson;
    subtreeJson.contentAvailabilityHeaders = [].concat(subtreeJson.contentAvailability);
    const bufferHeaders = this.preprocessBuffers(subtreeJson.buffers);
    const bufferViewHeaders = this.preprocessBufferViews(
      subtreeJson.bufferViews,
      bufferHeaders
    );
    this.markActiveBufferViews(subtreeJson, bufferViewHeaders);
    const buffersU8 = this.requestActiveBuffers(
      bufferHeaders,
      subtree.subtreeByte
    );
    const bufferViewsU8 = this.parseActiveBufferViews(bufferViewHeaders, buffersU8);
    this.parseAvailability(subtree, subtreeJson, bufferViewsU8);
    this.expandSubtree(this.tile, subtree);
  }
  /**
   * Determine which buffer views need to be loaded into memory. This includes:
   *
   * <ul>
   * <li>The tile availability bitstream (if a bitstream is defined)</li>
   * <li>The content availability bitstream(s) (if a bitstream is defined)</li>
   * <li>The child subtree availability bitstream (if a bitstream is defined)</li>
   * </ul>
   *
   * <p>
   * This function modifies the buffer view headers' isActive flags in place.
   * </p>
   *
   * @param {JSON} subtreeJson The JSON chunk from the subtree
   * @param {BufferViewHeader[]} bufferViewHeaders The preprocessed buffer view headers
   * @private
   */
  markActiveBufferViews(subtreeJson, bufferViewHeaders) {
    let header;
    const tileAvailabilityHeader = subtreeJson.tileAvailability;
    if (!isNaN(tileAvailabilityHeader.bitstream)) {
      header = bufferViewHeaders[tileAvailabilityHeader.bitstream];
    } else if (!isNaN(tileAvailabilityHeader.bufferView)) {
      header = bufferViewHeaders[tileAvailabilityHeader.bufferView];
    }
    if (header) {
      header.isActive = true;
      header.bufferHeader.isActive = true;
    }
    const contentAvailabilityHeaders = subtreeJson.contentAvailabilityHeaders;
    for (let i = 0; i < contentAvailabilityHeaders.length; i++) {
      header = void 0;
      if (!isNaN(contentAvailabilityHeaders[i].bitstream)) {
        header = bufferViewHeaders[contentAvailabilityHeaders[i].bitstream];
      } else if (!isNaN(contentAvailabilityHeaders[i].bufferView)) {
        header = bufferViewHeaders[contentAvailabilityHeaders[i].bufferView];
      }
      if (header) {
        header.isActive = true;
        header.bufferHeader.isActive = true;
      }
    }
    header = void 0;
    const childSubtreeAvailabilityHeader = subtreeJson.childSubtreeAvailability;
    if (!isNaN(childSubtreeAvailabilityHeader.bitstream)) {
      header = bufferViewHeaders[childSubtreeAvailabilityHeader.bitstream];
    } else if (!isNaN(childSubtreeAvailabilityHeader.bufferView)) {
      header = bufferViewHeaders[childSubtreeAvailabilityHeader.bufferView];
    }
    if (header) {
      header.isActive = true;
      header.bufferHeader.isActive = true;
    }
  }
  /**
   * Go through the list of buffers and gather all the active ones into
   * a dictionary.
   * <p>
   * The results are put into a dictionary object. The keys are indices of
   * buffers, and the values are Uint8Arrays of the contents. Only buffers
   * marked with the isActive flag are fetched.
   * </p>
   * <p>
   * The internal buffer (the subtree's binary chunk) is also stored in this
   * dictionary if it is marked active.
   * </p>
   * @param {BufferHeader[]} bufferHeaders The preprocessed buffer headers
   * @param {ArrayBuffer} internalBuffer The binary chunk of the subtree file
   * @returns {object} buffersU8 A dictionary of buffer index to a Uint8Array of its contents.
   * @private
   */
  requestActiveBuffers(bufferHeaders, internalBuffer) {
    const bufferResults = [];
    for (let i = 0; i < bufferHeaders.length; i++) {
      const bufferHeader = bufferHeaders[i];
      if (bufferHeader.isActive) {
        bufferResults.push(internalBuffer);
      } else {
        bufferResults.push(void 0);
      }
    }
    const buffersU8 = {};
    for (let i = 0; i < bufferResults.length; i++) {
      const result = bufferResults[i];
      if (result) {
        buffersU8[i] = result;
      }
    }
    return buffersU8;
  }
  /**
   * Go through the list of buffer views, and if they are marked as active,
   * extract a subarray from one of the active buffers.
   *
   * @param {BufferViewHeader[]} bufferViewHeaders
   * @param {object} buffersU8 A dictionary of buffer index to a Uint8Array of its contents.
   * @returns {object} A dictionary of buffer view index to a Uint8Array of its contents.
   * @private
   */
  parseActiveBufferViews(bufferViewHeaders, buffersU8) {
    const bufferViewsU8 = {};
    for (let i = 0; i < bufferViewHeaders.length; i++) {
      const bufferViewHeader = bufferViewHeaders[i];
      if (!bufferViewHeader.isActive) {
        continue;
      }
      const start = bufferViewHeader.byteOffset;
      const end = start + bufferViewHeader.byteLength;
      const buffer = buffersU8[bufferViewHeader.buffer];
      bufferViewsU8[i] = buffer.slice(start, end);
    }
    return bufferViewsU8;
  }
  /**
   * A buffer header is the JSON header from the subtree JSON chunk plus
   * a couple extra boolean flags for easy reference.
   *
   * Buffers are assumed inactive until explicitly marked active. This is used
   * to avoid fetching unneeded buffers.
   *
   * @typedef {object} BufferHeader
   * @property {boolean} isActive Whether this buffer is currently used.
   * @property {string} [uri] The URI of the buffer (external buffers only)
   * @property {number} byteLength The byte length of the buffer, including any padding contained within.
   * @private
   */
  /**
   * Iterate over the list of buffers from the subtree JSON and add the isActive field for easier parsing later.
   * This modifies the objects in place.
   * @param {Object[]} [bufferHeaders=[]] The JSON from subtreeJson.buffers.
   * @returns {BufferHeader[]} The same array of headers with additional fields.
   * @private
   */
  preprocessBuffers(bufferHeaders = []) {
    for (let i = 0; i < bufferHeaders.length; i++) {
      const bufferHeader = bufferHeaders[i];
      bufferHeader.isActive = false;
    }
    return bufferHeaders;
  }
  /**
   * A buffer header is the JSON header from the subtree JSON chunk plus
   * the isActive flag and a reference to the header for the underlying buffer
   *
   * @typedef {object} BufferViewHeader
   * @property {BufferHeader} bufferHeader A reference to the header for the underlying buffer
   * @property {boolean} isActive Whether this bufferView is currently used.
   * @property {number} buffer The index of the underlying buffer.
   * @property {number} byteOffset The start byte of the bufferView within the buffer.
   * @property {number} byteLength The length of the bufferView. No padding is included in this length.
   * @private
   */
  /**
   * Iterate the list of buffer views from the subtree JSON and add the
   * isActive flag. Also save a reference to the bufferHeader
   *
   * @param {Object[]} [bufferViewHeaders=[]] The JSON from subtree.bufferViews
   * @param {BufferHeader[]} bufferHeaders The preprocessed buffer headers
   * @returns {BufferViewHeader[]} The same array of bufferView headers with additional fields
   * @private
   */
  preprocessBufferViews(bufferViewHeaders = [], bufferHeaders) {
    for (let i = 0; i < bufferViewHeaders.length; i++) {
      const bufferViewHeader = bufferViewHeaders[i];
      bufferViewHeader.bufferHeader = bufferHeaders[bufferViewHeader.buffer];
      bufferViewHeader.isActive = false;
    }
    return bufferViewHeaders;
  }
  /**
   * Parse the three availability bitstreams and store them in the subtree
   *
   * @param {Subtree} subtree The subtree to modify
   * @param {Object} subtreeJson The subtree JSON
   * @param {Object} bufferViewsU8 A dictionary of buffer view index to a Uint8Array of its contents.
   * @private
   */
  parseAvailability(subtree, subtreeJson, bufferViewsU8) {
    const branchingFactor = getBoundsDivider(this.rootTile);
    const subtreeLevels = this.rootTile.implicitTiling.subtreeLevels;
    const tileAvailabilityBits = (Math.pow(branchingFactor, subtreeLevels) - 1) / (branchingFactor - 1);
    const childSubtreeBits = Math.pow(branchingFactor, subtreeLevels);
    subtree._tileAvailability = this.parseAvailabilityBitstream(
      subtreeJson.tileAvailability,
      bufferViewsU8,
      tileAvailabilityBits
    );
    subtree._contentAvailabilityBitstreams = [];
    for (let i = 0; i < subtreeJson.contentAvailabilityHeaders.length; i++) {
      const bitstream = this.parseAvailabilityBitstream(
        subtreeJson.contentAvailabilityHeaders[i],
        bufferViewsU8,
        // content availability has the same length as tile availability.
        tileAvailabilityBits
      );
      subtree._contentAvailabilityBitstreams.push(bitstream);
    }
    subtree._childSubtreeAvailability = this.parseAvailabilityBitstream(
      subtreeJson.childSubtreeAvailability,
      bufferViewsU8,
      childSubtreeBits
    );
  }
  /**
   * A helper object for storing the two parts of the subtree binary
   *
   * @typedef {object} ParsedBitstream
   * @property {Boolean} constant
   * @property {ArrayBuffer} bitstream
   * @property {number} lengthBits The length of the availability bitstream in bits
   * @private
   */
  /**
   * Given the JSON describing an availability bitstream, turn it into an
   * in-memory representation using an object. This handles bitstreams from a bufferView.
   *
   * @param {Object} availabilityJson A JSON object representing the availability
   * @param {Object} bufferViewsU8 A dictionary of bufferView index to its Uint8Array contents.
   * @param {number} lengthBits The length of the availability bitstream in bits
   * @returns {ParsedBitstream}
   * @private
   */
  parseAvailabilityBitstream(availabilityJson, bufferViewsU8, lengthBits) {
    if (!isNaN(availabilityJson.constant)) {
      return {
        constant: Boolean(availabilityJson.constant),
        lengthBits
      };
    }
    let bufferView;
    if (!isNaN(availabilityJson.bitstream)) {
      bufferView = bufferViewsU8[availabilityJson.bitstream];
    } else if (!isNaN(availabilityJson.bufferView)) {
      bufferView = bufferViewsU8[availabilityJson.bufferView];
    }
    return {
      bitstream: bufferView,
      lengthBits
    };
  }
  /**
   * Expand a single subtree tile. This transcodes the subtree into
   * a tree of {@link SubtreeTile}. The root of this tree is stored in
   * the placeholder tile's children array. This method also creates
   * tiles for the child subtrees to be lazily expanded as needed.
   *
   * @param {Object | SubtreeTile} subtreeRoot The first node of the subtree
   * @param {Subtree} subtree The parsed subtree
   * @private
   */
  expandSubtree(subtreeRoot, subtree) {
    const contentTile = SubtreeTile.copy(subtreeRoot);
    for (let i = 0; subtree && i < subtree._contentAvailabilityBitstreams.length; i++) {
      if (subtree && this.getBit(subtree._contentAvailabilityBitstreams[i], 0)) {
        contentTile.content = { uri: this.parseImplicitURI(subtreeRoot, this.rootTile.content.uri) };
        break;
      }
    }
    subtreeRoot.children.push(contentTile);
    const bottomRow = this.transcodeSubtreeTiles(
      contentTile,
      subtree
    );
    const childSubtrees = this.listChildSubtrees(subtree, bottomRow);
    for (let i = 0; i < childSubtrees.length; i++) {
      const subtreeLocator = childSubtrees[i];
      const leafTile = subtreeLocator.tile;
      const subtreeTile = this.deriveChildTile(
        null,
        leafTile,
        null,
        subtreeLocator.childMortonIndex
      );
      subtreeTile.content = { uri: this.parseImplicitURI(subtreeTile, this.rootTile.implicitTiling.subtrees.uri) };
      leafTile.children.push(subtreeTile);
    }
  }
  /**
   * Transcode the implicitly defined tiles within this subtree and generate
   * explicit {@link SubtreeTile} objects. This function only transcode tiles,
   * child subtrees are handled separately.
   *
   * @param {Object | SubtreeTile} subtreeRoot The root of the current subtree
   * @param {Subtree} subtree The subtree to get availability information
   * @returns {Array} The bottom row of transcoded tiles. This is helpful for processing child subtrees
   * @private
   */
  transcodeSubtreeTiles(subtreeRoot, subtree) {
    let parentRow = [subtreeRoot];
    let currentRow = [];
    for (let level = 1; level < this.rootTile.implicitTiling.subtreeLevels; level++) {
      const branchingFactor = getBoundsDivider(this.rootTile);
      const levelOffset = (Math.pow(branchingFactor, level) - 1) / (branchingFactor - 1);
      const numberOfChildren = branchingFactor * parentRow.length;
      for (let childMortonIndex = 0; childMortonIndex < numberOfChildren; childMortonIndex++) {
        const childBitIndex = levelOffset + childMortonIndex;
        const parentMortonIndex = childMortonIndex >> Math.log2(branchingFactor);
        const parentTile = parentRow[parentMortonIndex];
        if (!this.getBit(subtree._tileAvailability, childBitIndex)) {
          currentRow.push(void 0);
          continue;
        }
        const childTile = this.deriveChildTile(
          subtree,
          parentTile,
          childBitIndex,
          childMortonIndex
        );
        parentTile.children.push(childTile);
        currentRow.push(childTile);
      }
      parentRow = currentRow;
      currentRow = [];
    }
    return parentRow;
  }
  /**
   * Given a parent tile and information about which child to create, derive
   * the properties of the child tile implicitly.
   * <p>
   * This creates a real tile for rendering.
   * </p>
   *
   * @param {Subtree} subtree The subtree the child tile belongs to
   * @param {Object | SubtreeTile} parentTile The parent of the new child tile
   * @param {number} childBitIndex The index of the child tile within the tile's availability information.
   * @param {number} childMortonIndex The morton index of the child tile relative to its parent
   * @returns {SubtreeTile} The new child tile.
   * @private
   */
  deriveChildTile(subtree, parentTile, childBitIndex, childMortonIndex) {
    const subtreeTile = new SubtreeTile(parentTile, childMortonIndex);
    subtreeTile.boundingVolume = this.getTileBoundingVolume(subtreeTile);
    subtreeTile.geometricError = this.getGeometricError(subtreeTile);
    for (let i = 0; subtree && i < subtree._contentAvailabilityBitstreams.length; i++) {
      if (subtree && this.getBit(subtree._contentAvailabilityBitstreams[i], childBitIndex)) {
        subtreeTile.content = { uri: this.parseImplicitURI(subtreeTile, this.rootTile.content.uri) };
        break;
      }
    }
    return subtreeTile;
  }
  /**
   * Get a bit from the bitstream as a Boolean. If the bitstream
   * is a constant, the constant value is returned instead.
   *
   * @param {ParsedBitstream} object
   * @param {number} index The integer index of the bit.
   * @returns {boolean} The value of the bit
   * @private
   */
  getBit(object, index) {
    if (index < 0 || index >= object.lengthBits) {
      throw new Error("Bit index out of bounds.");
    }
    if (object.constant !== void 0) {
      return object.constant;
    }
    const byteIndex = index >> 3;
    const bitIndex = index % 8;
    return (new Uint8Array(object.bitstream)[byteIndex] >> bitIndex & 1) === 1;
  }
  /**
   * //TODO Adapt for Sphere
   * To maintain numerical stability during this subdivision process,
   * the actual bounding volumes should not be computed progressively by subdividing a non-root tile volume.
   * Instead, the exact bounding volumes are computed directly for a given level.
   * @param {Object | SubtreeTile} tile
   * @return {Object} object containing the bounding volume
   */
  getTileBoundingVolume(tile) {
    const boundingVolume = {};
    if (this.rootTile.boundingVolume.region) {
      const region = [...this.rootTile.boundingVolume.region];
      const minX = region[0];
      const maxX = region[2];
      const minY = region[1];
      const maxY = region[3];
      const sizeX = (maxX - minX) / Math.pow(2, tile.__level);
      const sizeY = (maxY - minY) / Math.pow(2, tile.__level);
      region[0] = minX + sizeX * tile.__x;
      region[2] = minX + sizeX * (tile.__x + 1);
      region[1] = minY + sizeY * tile.__y;
      region[3] = minY + sizeY * (tile.__y + 1);
      for (let k = 0; k < 4; k++) {
        const coord = region[k];
        if (coord < -Math.PI) {
          region[k] += 2 * Math.PI;
        } else if (coord > Math.PI) {
          region[k] -= 2 * Math.PI;
        }
      }
      if (isOctreeSubdivision(tile)) {
        const minZ = region[4];
        const maxZ = region[5];
        const sizeZ = (maxZ - minZ) / Math.pow(2, tile.__level);
        region[4] = minZ + sizeZ * tile.__z;
        region[5] = minZ + sizeZ * (tile.__z + 1);
      }
      boundingVolume.region = region;
    }
    if (this.rootTile.boundingVolume.box) {
      const box = [...this.rootTile.boundingVolume.box];
      const cellSteps = 2 ** tile.__level - 1;
      const scale = Math.pow(2, -tile.__level);
      const axisNumber = isOctreeSubdivision(tile) ? 3 : 2;
      for (let i = 0; i < axisNumber; i++) {
        box[3 + i * 3 + 0] *= scale;
        box[3 + i * 3 + 1] *= scale;
        box[3 + i * 3 + 2] *= scale;
        const x = box[3 + i * 3 + 0];
        const y = box[3 + i * 3 + 1];
        const z = box[3 + i * 3 + 2];
        const axisOffset = i === 0 ? tile.__x : i === 1 ? tile.__y : tile.__z;
        box[0] += 2 * x * (-0.5 * cellSteps + axisOffset);
        box[1] += 2 * y * (-0.5 * cellSteps + axisOffset);
        box[2] += 2 * z * (-0.5 * cellSteps + axisOffset);
      }
      boundingVolume.box = box;
    }
    return boundingVolume;
  }
  /**
   * Each child’s geometricError is half of its parent’s geometricError
   * @param {Object | SubtreeTile} tile
   * @return {number}
   */
  getGeometricError(tile) {
    return this.rootTile.geometricError / Math.pow(2, tile.__level);
  }
  /**
   * Determine what child subtrees exist and return a list of information
   *
   * @param {Object} subtree The subtree for looking up availability
   * @param {Array} bottomRow The bottom row of tiles in a transcoded subtree
   * @returns {[]} A list of identifiers for the child subtrees.
   * @private
   */
  listChildSubtrees(subtree, bottomRow) {
    const results = [];
    const branchingFactor = getBoundsDivider(this.rootTile);
    for (let i = 0; i < bottomRow.length; i++) {
      const leafTile = bottomRow[i];
      if (leafTile === void 0) {
        continue;
      }
      for (let j = 0; j < branchingFactor; j++) {
        const index = i * branchingFactor + j;
        if (this.getBit(subtree._childSubtreeAvailability, index)) {
          results.push({
            tile: leafTile,
            childMortonIndex: index
          });
        }
      }
    }
    return results;
  }
  parseImplicitURI(tile, uri) {
    uri = uri.replace("{level}", tile.__level);
    uri = uri.replace("{x}", tile.__x);
    uri = uri.replace("{y}", tile.__y);
    uri = uri.replace("{z}", tile.__z);
    return uri;
  }
};

// node_modules/3d-tiles-renderer/src/plugins/base/ImplicitTilingPlugin.js
var ImplicitTilingPlugin = class {
  constructor() {
    this.name = "IMPLICIT_TILING_PLUGIN";
  }
  init(tiles) {
    this.tiles = tiles;
  }
  preprocessNode(tile, tileSetDir, parentTile) {
    if (tile.implicitTiling) {
      tile.__hasUnrenderableContent = true;
      tile.__hasRenderableContent = false;
      tile.__subtreeIdx = 0;
      tile.__implicitRoot = tile;
      tile.__x = 0;
      tile.__y = 0;
      tile.__z = 0;
      tile.__level = 0;
    } else if (/.subtree$/i.test(tile.content?.uri)) {
      tile.__hasUnrenderableContent = true;
      tile.__hasRenderableContent = false;
    }
  }
  parseTile(buffer, parseTile, extension) {
    if (/^subtree$/i.test(extension)) {
      const loader = new SUBTREELoader(parseTile);
      loader.parse(buffer);
      return Promise.resolve();
    }
  }
  preprocessURL(url, tile) {
    if (tile && tile.implicitTiling) {
      const implicitUri = tile.implicitTiling.subtrees.uri.replace("{level}", tile.__level).replace("{x}", tile.__x).replace("{y}", tile.__y).replace("{z}", tile.__z);
      return new URL(implicitUri, tile.__basePath + "/").toString();
    }
    return url;
  }
  disposeTile(tile) {
    if (/.subtree$/i.test(tile.content?.uri)) {
      tile.children.length = 0;
    }
  }
};
export {
  BatchedTilesPlugin,
  CesiumIonAuthPlugin,
  DebugTilesPlugin,
  DeepZoomImagePlugin,
  GLTFCesiumRTCExtension,
  GLTFExtensionsPlugin,
  GLTFMeshFeaturesExtension,
  GLTFStructuralMetadataExtension,
  GoogleCloudAuthPlugin,
  ImageFormatPlugin,
  ImplicitTilingPlugin,
  LoadRegionPlugin,
  OBBRegion,
  RayRegion,
  ReorientationPlugin,
  SphereRegion,
  TILE_LEVEL,
  TILE_X,
  TILE_Y,
  TMSTilesPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UV_BOUNDS,
  UnloadTilesPlugin,
  UpdateOnChangePlugin,
  XYZTilesPlugin,
  getIndexedRandomColor
};
