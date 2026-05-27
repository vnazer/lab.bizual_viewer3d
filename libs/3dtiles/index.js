var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// node_modules/3d-tiles-renderer/src/utilities/urlExtension.js
function getUrlExtension(url) {
  if (!url) {
    return null;
  }
  const filename = url.replace(/[a-z]+:\/\/[^/]+/i, "").replace(/\?.*$/i, "").replace(/.*\//g, "");
  const lastPeriod = filename.lastIndexOf(".");
  if (lastPeriod === -1) {
    return null;
  }
  return filename.substring(lastPeriod + 1) || null;
}

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
    const priorityCallback2 = this.priorityCallback;
    const items = this.items;
    items.sort(priorityCallback2);
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

// node_modules/3d-tiles-renderer/src/base/constants.js
var FAILED = -1;
var UNLOADED = 0;
var LOADING = 1;
var PARSING = 2;
var LOADED = 3;
var WGS84_RADIUS = 6378137;
var WGS84_FLATTENING = 1 / 298.257223563;
var WGS84_HEIGHT = -(WGS84_FLATTENING * WGS84_RADIUS - WGS84_RADIUS);

// node_modules/3d-tiles-renderer/src/base/traverseFunctions.js
function isDownloadFinished(value) {
  return value === LOADED || value === FAILED;
}
function isUsedThisFrame(tile, frameCount) {
  return tile.__lastFrameVisited === frameCount && tile.__used;
}
function resetFrameState(tile, renderer) {
  if (tile.__lastFrameVisited !== renderer.frameCount) {
    tile.__lastFrameVisited = renderer.frameCount;
    tile.__used = false;
    tile.__inFrustum = false;
    tile.__isLeaf = false;
    tile.__visible = false;
    tile.__active = false;
    tile.__error = Infinity;
    tile.__distanceFromCamera = Infinity;
    tile.__childrenWereVisible = false;
    tile.__allChildrenLoaded = false;
    tile.__inFrustum = renderer.tileInView(tile);
    renderer.calculateError(tile);
  }
}
function recursivelyMarkUsed(tile, renderer) {
  renderer.ensureChildrenArePreprocessed(tile);
  resetFrameState(tile, renderer);
  markUsed(tile, renderer);
  if (!tile.__hasRenderableContent) {
    const children = tile.children;
    for (let i = 0, l = children.length; i < l; i++) {
      recursivelyMarkUsed(children[i], renderer);
    }
  }
}
function recursivelyLoadNextRenderableTiles(tile, renderer) {
  renderer.ensureChildrenArePreprocessed(tile);
  if (isUsedThisFrame(tile, renderer.frameCount)) {
    if (tile.__hasContent && tile.__loadingState === UNLOADED && !renderer.lruCache.isFull()) {
      renderer.queueTileForDownload(tile);
    }
    const children = tile.children;
    for (let i = 0, l = children.length; i < l; i++) {
      recursivelyLoadNextRenderableTiles(children[i], renderer);
    }
  }
}
function markUsed(tile, renderer) {
  if (tile.__used) {
    return;
  }
  tile.__used = true;
  renderer.markTileUsed(tile);
  renderer.stats.used++;
  if (tile.__inFrustum === true) {
    renderer.stats.inFrustum++;
  }
}
function canTraverse(tile, renderer) {
  if (tile.__error <= renderer.errorTarget) {
    return false;
  }
  if (renderer.maxDepth > 0 && tile.__depth + 1 >= renderer.maxDepth) {
    return false;
  }
  return true;
}
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
function markUsedTiles(tile, renderer) {
  renderer.ensureChildrenArePreprocessed(tile);
  resetFrameState(tile, renderer);
  if (!tile.__inFrustum) {
    return;
  }
  if (!canTraverse(tile, renderer)) {
    markUsed(tile, renderer);
    return;
  }
  let anyChildrenUsed = false;
  let anyChildrenInFrustum = false;
  const children = tile.children;
  for (let i = 0, l = children.length; i < l; i++) {
    const c = children[i];
    markUsedTiles(c, renderer);
    anyChildrenUsed = anyChildrenUsed || isUsedThisFrame(c, renderer.frameCount);
    anyChildrenInFrustum = anyChildrenInFrustum || c.__inFrustum;
  }
  if (tile.refine === "REPLACE" && !anyChildrenInFrustum && children.length !== 0 && !tile.__hasUnrenderableContent) {
    tile.__inFrustum = false;
    return;
  }
  markUsed(tile, renderer);
  if (anyChildrenUsed && tile.refine === "REPLACE") {
    for (let i = 0, l = children.length; i < l; i++) {
      const c = children[i];
      recursivelyMarkUsed(c, renderer);
    }
  }
}
function markUsedSetLeaves(tile, renderer) {
  const frameCount = renderer.frameCount;
  if (!isUsedThisFrame(tile, frameCount)) {
    return;
  }
  const children = tile.children;
  let anyChildrenUsed = false;
  for (let i = 0, l = children.length; i < l; i++) {
    const c = children[i];
    anyChildrenUsed = anyChildrenUsed || isUsedThisFrame(c, frameCount);
  }
  if (!anyChildrenUsed) {
    tile.__isLeaf = true;
  } else {
    let childrenWereVisible = false;
    let allChildrenLoaded = true;
    for (let i = 0, l = children.length; i < l; i++) {
      const c = children[i];
      markUsedSetLeaves(c, renderer);
      childrenWereVisible = childrenWereVisible || c.__wasSetVisible || c.__childrenWereVisible;
      if (isUsedThisFrame(c, frameCount)) {
        const childLoaded = c.__allChildrenLoaded || c.__hasRenderableContent && isDownloadFinished(c.__loadingState) || !c.__hasContent && c.children.length === 0 || c.__hasUnrenderableContent && c.__loadingState === FAILED;
        allChildrenLoaded = allChildrenLoaded && childLoaded;
      }
    }
    tile.__childrenWereVisible = childrenWereVisible;
    tile.__allChildrenLoaded = allChildrenLoaded;
  }
}
function markVisibleTiles(tile, renderer) {
  const stats = renderer.stats;
  if (!isUsedThisFrame(tile, renderer.frameCount)) {
    return;
  }
  const lruCache = renderer.lruCache;
  if (tile.__isLeaf) {
    if (tile.__loadingState === LOADED) {
      if (tile.__inFrustum) {
        tile.__visible = true;
        stats.visible++;
      }
      tile.__active = true;
      stats.active++;
    } else if (!lruCache.isFull() && tile.__hasContent) {
      renderer.queueTileForDownload(tile);
    }
    return;
  }
  const children = tile.children;
  const hasContent = tile.__hasContent;
  const loadedContent = isDownloadFinished(tile.__loadingState) && hasContent;
  const errorRequirement = (renderer.errorTarget + 1) * renderer.errorThreshold;
  const meetsSSE = tile.__error <= errorRequirement;
  const childrenWereVisible = tile.__childrenWereVisible;
  const allChildrenLoaded = tile.__allChildrenLoaded;
  const includeTile = meetsSSE || tile.refine === "ADD";
  if (includeTile && !loadedContent && !lruCache.isFull() && hasContent) {
    renderer.queueTileForDownload(tile);
  }
  if (meetsSSE && !allChildrenLoaded && !childrenWereVisible && loadedContent || tile.refine === "ADD" && loadedContent) {
    if (tile.__inFrustum) {
      tile.__visible = true;
      stats.visible++;
    }
    tile.__active = true;
    stats.active++;
  }
  if (tile.refine === "REPLACE" && meetsSSE && !allChildrenLoaded) {
    for (let i = 0, l = children.length; i < l; i++) {
      const c = children[i];
      if (isUsedThisFrame(c, renderer.frameCount)) {
        recursivelyLoadNextRenderableTiles(c, renderer);
      }
    }
  } else {
    for (let i = 0, l = children.length; i < l; i++) {
      markVisibleTiles(children[i], renderer);
    }
  }
}
function toggleTiles(tile, renderer) {
  const isUsed = isUsedThisFrame(tile, renderer.frameCount);
  if (isUsed || tile.__usedLastFrame) {
    let setActive = false;
    let setVisible = false;
    if (isUsed) {
      setActive = tile.__active;
      if (renderer.displayActiveTiles) {
        setVisible = tile.__active || tile.__visible;
      } else {
        setVisible = tile.__visible;
      }
    } else {
      resetFrameState(tile, renderer);
    }
    if (tile.__hasRenderableContent && tile.__loadingState === LOADED) {
      if (tile.__wasSetActive !== setActive) {
        renderer.setTileActive(tile, setActive);
      }
      if (tile.__wasSetVisible !== setVisible) {
        renderer.invokeOnePlugin((plugin) => plugin.setTileVisible && plugin.setTileVisible(tile, setVisible));
      }
    }
    tile.__wasSetActive = setActive;
    tile.__wasSetVisible = setVisible;
    tile.__usedLastFrame = isUsed;
    const children = tile.children;
    for (let i = 0, l = children.length; i < l; i++) {
      const c = children[i];
      toggleTiles(c, renderer);
    }
  }
}

// node_modules/3d-tiles-renderer/src/base/TilesRendererBase.js
var PLUGIN_REGISTERED = /* @__PURE__ */ Symbol("PLUGIN_REGISTERED");
var priorityCallback = (a, b) => {
  if (a.__depthFromRenderedParent !== b.__depthFromRenderedParent) {
    return a.__depthFromRenderedParent > b.__depthFromRenderedParent ? -1 : 1;
  } else if (a.__inFrustum !== b.__inFrustum) {
    return a.__inFrustum ? 1 : -1;
  } else if (a.__used !== b.__used) {
    return a.__used ? 1 : -1;
  } else if (a.__error !== b.__error) {
    return a.__error > b.__error ? 1 : -1;
  } else if (a.__distanceFromCamera !== b.__distanceFromCamera) {
    return a.__distanceFromCamera > b.__distanceFromCamera ? -1 : 1;
  }
  return 0;
};
var lruPriorityCallback = (a, b) => {
  if (a.__depthFromRenderedParent !== b.__depthFromRenderedParent) {
    return a.__depthFromRenderedParent > b.__depthFromRenderedParent ? 1 : -1;
  } else if (a.__loadingState !== b.__loadingState) {
    return a.__loadingState > b.__loadingState ? -1 : 1;
  } else if (a.__lastFrameVisited !== b.__lastFrameVisited) {
    return a.__lastFrameVisited > b.__lastFrameVisited ? -1 : 1;
  } else if (a.__hasUnrenderableContent !== b.__hasUnrenderableContent) {
    return a.__hasUnrenderableContent ? -1 : 1;
  } else if (a.__error !== b.__error) {
    return a.__error > b.__error ? -1 : 1;
  }
  return 0;
};
var TilesRendererBase = class {
  get root() {
    const tileSet = this.rootTileSet;
    return tileSet ? tileSet.root : null;
  }
  get loadProgress() {
    const stats = this.stats;
    const loading = stats.downloading + stats.parsing;
    const total = stats.inCacheSinceLoad;
    return total === 0 ? 1 : 1 - loading / total;
  }
  get errorThreshold() {
    return this._errorThreshold;
  }
  set errorThreshold(v) {
    console.warn('TilesRenderer: The "errorThreshold" option has been deprecated.');
    this._errorThreshold = v;
  }
  constructor(url = null) {
    this.rootLoadingState = UNLOADED;
    this.rootTileSet = null;
    this.rootURL = url;
    this.fetchOptions = {};
    this.plugins = [];
    this.queuedTiles = [];
    this.cachedSinceLoadComplete = /* @__PURE__ */ new Set();
    const lruCache = new LRUCache();
    lruCache.unloadPriorityCallback = lruPriorityCallback;
    const downloadQueue = new PriorityQueue();
    downloadQueue.maxJobs = 10;
    downloadQueue.priorityCallback = priorityCallback;
    const parseQueue = new PriorityQueue();
    parseQueue.maxJobs = 1;
    parseQueue.priorityCallback = priorityCallback;
    this.visibleTiles = /* @__PURE__ */ new Set();
    this.activeTiles = /* @__PURE__ */ new Set();
    this.usedSet = /* @__PURE__ */ new Set();
    this.lruCache = lruCache;
    this.downloadQueue = downloadQueue;
    this.parseQueue = parseQueue;
    this.stats = {
      inCacheSinceLoad: 0,
      inCache: 0,
      parsing: 0,
      downloading: 0,
      failed: 0,
      inFrustum: 0,
      used: 0,
      active: 0,
      visible: 0
    };
    this.frameCount = 0;
    this.errorTarget = 6;
    this._errorThreshold = Infinity;
    this.displayActiveTiles = false;
    this.maxDepth = Infinity;
  }
  // Plugins
  registerPlugin(plugin) {
    if (plugin[PLUGIN_REGISTERED] === true) {
      throw new Error("TilesRendererBase: A plugin can only be registered to a single tile set");
    }
    const plugins = this.plugins;
    const priority = plugin.priority || 0;
    let insertionPoint = plugins.length;
    for (let i = 0; i < plugins.length; i++) {
      const otherPriority = plugins[i].priority || 0;
      if (otherPriority > priority) {
        insertionPoint = i;
        break;
      }
    }
    plugins.splice(insertionPoint, 0, plugin);
    plugin[PLUGIN_REGISTERED] = true;
    if (plugin.init) {
      plugin.init(this);
    }
  }
  unregisterPlugin(plugin) {
    const plugins = this.plugins;
    if (typeof plugin === "string") {
      plugin = this.getPluginByName(name);
    }
    if (plugins.includes(plugin)) {
      const index = plugins.indexOf(plugin);
      plugins.splice(index, 1);
      if (plugin.dispose) {
        plugin.dispose();
      }
      return true;
    }
    return false;
  }
  getPluginByName(name2) {
    return this.plugins.find((p) => p.name === name2) || null;
  }
  traverse(beforecb, aftercb, ensureFullyProcessed = true) {
    if (!this.root) return;
    traverseSet(this.root, (tile, ...args) => {
      if (ensureFullyProcessed) {
        this.ensureChildrenArePreprocessed(tile);
      }
      return beforecb ? beforecb(tile, ...args) : false;
    }, aftercb);
  }
  queueTileForDownload(tile) {
    if (tile.__loadingState !== UNLOADED) {
      return;
    }
    this.queuedTiles.push(tile);
  }
  markTileUsed(tile) {
    this.usedSet.add(tile);
    this.lruCache.markUsed(tile);
  }
  // Public API
  update() {
    const { lruCache, usedSet, stats, root } = this;
    if (this.rootLoadingState === UNLOADED) {
      this.rootLoadingState = LOADING;
      this.invokeOnePlugin((plugin) => plugin.loadRootTileSet && plugin.loadRootTileSet()).then((root2) => {
        this.rootLoadingState = LOADED;
        this.rootTileSet = root2;
        this.dispatchEvent({
          type: "load-tile-set",
          tileSet: root2
        });
      }).catch((error) => {
        this.rootLoadingState = FAILED;
        console.error(error);
        this.rootTileSet = null;
        this.dispatchEvent({
          type: "load-error",
          tile: null,
          error
        });
      });
    }
    if (!root) {
      return;
    }
    stats.inFrustum = 0;
    stats.used = 0;
    stats.active = 0;
    stats.visible = 0;
    this.frameCount++;
    usedSet.forEach((tile) => lruCache.markUnused(tile));
    usedSet.clear();
    markUsedTiles(root, this);
    markUsedSetLeaves(root, this);
    markVisibleTiles(root, this);
    toggleTiles(root, this);
    const queuedTiles = this.queuedTiles;
    queuedTiles.sort(lruCache.unloadPriorityCallback);
    for (let i = 0, l = queuedTiles.length; i < l && !lruCache.isFull(); i++) {
      this.requestTileContents(queuedTiles[i]);
    }
    queuedTiles.length = 0;
    lruCache.scheduleUnload();
  }
  resetFailedTiles() {
    if (this.rootLoadingState === FAILED) {
      this.rootLoadingState = UNLOADED;
    }
    const stats = this.stats;
    if (stats.failed === 0) {
      return;
    }
    this.traverse((tile) => {
      if (tile.__loadingState === FAILED) {
        tile.__loadingState = UNLOADED;
      }
    }, null, false);
    stats.failed = 0;
  }
  dispose() {
    this.plugins.forEach((plugin) => {
      this.unregisterPlugin(plugin);
    });
    const lruCache = this.lruCache;
    const toRemove = [];
    this.traverse((t) => {
      toRemove.push(t);
      return false;
    }, null, false);
    for (let i = 0, l = toRemove.length; i < l; i++) {
      lruCache.remove(toRemove[i]);
    }
    this.stats = {
      parsing: 0,
      downloading: 0,
      failed: 0,
      inFrustum: 0,
      used: 0,
      active: 0,
      visible: 0
    };
    this.frameCount = 0;
  }
  // Overrideable
  dispatchEvent(e) {
  }
  fetchData(url, options) {
    return fetch(url, options);
  }
  parseTile(buffer, tile, extension) {
    return null;
  }
  disposeTile(tile) {
    if (tile.__visible) {
      this.invokeOnePlugin((plugin) => plugin.setTileVisible && plugin.setTileVisible(tile, false));
      tile.__visible = false;
    }
    if (tile.__active) {
      this.setTileActive(tile, false);
      tile.__active = false;
    }
  }
  preprocessNode(tile, tileSetDir, parentTile = null) {
    if (tile.content) {
      if (!("uri" in tile.content) && "url" in tile.content) {
        tile.content.uri = tile.content.url;
        delete tile.content.url;
      }
      if (tile.content.boundingVolume && !("box" in tile.content.boundingVolume || "sphere" in tile.content.boundingVolume || "region" in tile.content.boundingVolume)) {
        delete tile.content.boundingVolume;
      }
    }
    tile.parent = parentTile;
    tile.children = tile.children || [];
    if (tile.content?.uri) {
      const extension = getUrlExtension(tile.content.uri);
      tile.__hasContent = true;
      tile.__hasUnrenderableContent = Boolean(extension && /json$/.test(extension));
      tile.__hasRenderableContent = !tile.__hasUnrenderableContent;
    } else {
      tile.__hasContent = false;
      tile.__hasUnrenderableContent = false;
      tile.__hasRenderableContent = false;
    }
    tile.__distanceFromCamera = Infinity;
    tile.__error = Infinity;
    tile.__inFrustum = false;
    tile.__isLeaf = false;
    tile.__usedLastFrame = false;
    tile.__used = false;
    tile.__wasSetVisible = false;
    tile.__visible = false;
    tile.__childrenWereVisible = false;
    tile.__allChildrenLoaded = false;
    tile.__wasSetActive = false;
    tile.__active = false;
    tile.__loadingState = UNLOADED;
    if (parentTile === null) {
      tile.__depth = 0;
      tile.__depthFromRenderedParent = tile.__hasRenderableContent ? 1 : 0;
      tile.refine = tile.refine || "REPLACE";
    } else {
      tile.__depth = parentTile.__depth + 1;
      tile.__depthFromRenderedParent = parentTile.__depthFromRenderedParent + (tile.__hasRenderableContent ? 1 : 0);
      tile.refine = tile.refine || parentTile.refine;
    }
    tile.__basePath = tileSetDir;
    tile.__lastFrameVisited = -1;
    this.invokeAllPlugins((plugin) => {
      plugin !== this && plugin.preprocessNode && plugin.preprocessNode(tile, tileSetDir, parentTile);
    });
  }
  setTileActive(tile, active) {
    active ? this.activeTiles.add(tile) : this.activeTiles.delete(tile);
  }
  setTileVisible(tile, visible) {
    visible ? this.visibleTiles.add(tile) : this.visibleTiles.delete(tile);
  }
  calculateError(tile) {
    return 0;
  }
  tileInView(tile) {
    return true;
  }
  ensureChildrenArePreprocessed(tile) {
    const children = tile.children;
    for (let i = 0, l = children.length; i < l; i++) {
      const child = children[i];
      if ("__depth" in child) {
        break;
      }
      this.preprocessNode(child, tile.__basePath, tile);
    }
  }
  // Private Functions
  preprocessTileSet(json, url, parent = null) {
    const version = json.asset.version;
    const [major, minor] = version.split(".").map((v) => parseInt(v));
    console.assert(
      major <= 1,
      "TilesRenderer: asset.version is expected to be a 1.x or a compatible version."
    );
    if (major === 1 && minor > 0) {
      console.warn("TilesRenderer: tiles versions at 1.1 or higher have limited support. Some new extensions and features may not be supported.");
    }
    let basePath = url.replace(/\/[^/]*\/?$/, "");
    basePath = new URL(basePath, window.location.href).toString();
    this.preprocessNode(json.root, basePath, parent);
  }
  loadRootTileSet() {
    let processedUrl = this.rootURL;
    this.invokeAllPlugins((plugin) => processedUrl = plugin.preprocessURL ? plugin.preprocessURL(processedUrl, null) : processedUrl);
    const pr = this.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(processedUrl, this.fetchOptions)).then((res) => {
      if (res.ok) {
        return res.json();
      } else {
        throw new Error(`TilesRenderer: Failed to load tileset "${processedUrl}" with status ${res.status} : ${res.statusText}`);
      }
    }).then((root) => {
      this.preprocessTileSet(root, processedUrl);
      return root;
    });
    return pr;
  }
  requestTileContents(tile) {
    if (tile.__loadingState !== UNLOADED) {
      return;
    }
    let isExternalTileSet = false;
    let uri = new URL(tile.content.uri, tile.__basePath + "/").toString();
    this.invokeAllPlugins((plugin) => uri = plugin.preprocessURL ? plugin.preprocessURL(uri, tile) : uri);
    const stats = this.stats;
    const lruCache = this.lruCache;
    const downloadQueue = this.downloadQueue;
    const parseQueue = this.parseQueue;
    const extension = getUrlExtension(uri);
    const controller = new AbortController();
    const signal = controller.signal;
    const addedSuccessfully = lruCache.add(tile, (t) => {
      controller.abort();
      if (isExternalTileSet) {
        t.children.length = 0;
      } else {
        this.invokeAllPlugins((plugin) => {
          plugin.disposeTile && plugin.disposeTile(t);
        });
      }
      stats.inCache--;
      if (this.cachedSinceLoadComplete.has(tile)) {
        this.cachedSinceLoadComplete.delete(tile);
        stats.inCacheSinceLoad--;
      }
      if (t.__loadingState === LOADING) {
        stats.downloading--;
      } else if (t.__loadingState === PARSING) {
        stats.parsing--;
      }
      t.__loadingState = UNLOADED;
      parseQueue.remove(t);
      downloadQueue.remove(t);
    });
    if (!addedSuccessfully) {
      return;
    }
    if (stats.parsing === 0 && stats.downloading === 0) {
      this.dispatchEvent({ type: "tiles-load-start" });
    }
    this.cachedSinceLoadComplete.add(tile);
    stats.inCacheSinceLoad++;
    stats.inCache++;
    stats.downloading++;
    tile.__loadingState = LOADING;
    return downloadQueue.add(tile, (downloadTile) => {
      if (signal.aborted) {
        return Promise.resolve();
      }
      return this.invokeOnePlugin((plugin) => plugin.fetchData && plugin.fetchData(uri, { ...this.fetchOptions, signal }));
    }).then((res) => {
      if (signal.aborted) {
        return;
      }
      if (res.ok) {
        return extension === "json" ? res.json() : res.arrayBuffer();
      } else {
        throw new Error(`Failed to load model with error code ${res.status}`);
      }
    }).then((content) => {
      if (signal.aborted) {
        return;
      }
      stats.downloading--;
      stats.parsing++;
      tile.__loadingState = PARSING;
      return parseQueue.add(tile, (parseTile) => {
        if (signal.aborted) {
          return Promise.resolve();
        }
        if (extension === "json" && content.root) {
          this.preprocessTileSet(content, uri, tile);
          tile.children.push(content.root);
          isExternalTileSet = true;
          return Promise.resolve();
        } else {
          return this.invokeOnePlugin((plugin) => plugin.parseTile && plugin.parseTile(content, parseTile, extension, uri, signal));
        }
      });
    }).then(() => {
      if (signal.aborted) {
        return;
      }
      stats.parsing--;
      tile.__loadingState = LOADED;
      lruCache.setLoaded(tile, true);
      if (lruCache.getMemoryUsage(tile) === null) {
        if (lruCache.isFull() && lruCache.computeMemoryUsageCallback(tile) > 0) {
          lruCache.remove(tile);
        } else {
          lruCache.updateMemoryUsage(tile);
        }
      }
      if (tile.cached.scene) {
        this.dispatchEvent({
          type: "load-model",
          scene: tile.cached.scene,
          tile
        });
      }
    }).catch((error) => {
      if (signal.aborted) {
        return;
      }
      if (error.name !== "AbortError") {
        parseQueue.remove(tile);
        downloadQueue.remove(tile);
        if (tile.__loadingState === PARSING) {
          stats.parsing--;
        } else if (tile.__loadingState === LOADING) {
          stats.downloading--;
        }
        stats.failed++;
        console.error(`TilesRenderer : Failed to load tile at url "${tile.content.uri}".`);
        console.error(error);
        tile.__loadingState = FAILED;
        lruCache.setLoaded(tile, true);
        this.dispatchEvent({
          type: "load-error",
          tile,
          error,
          uri
        });
      } else {
        lruCache.remove(tile);
      }
    }).finally(() => {
      if (stats.parsing === 0 && stats.downloading === 0) {
        this.cachedSinceLoadComplete.clear();
        stats.inCacheSinceLoad = 0;
        this.dispatchEvent({ type: "tiles-load-end" });
      }
    });
  }
  getAttributions(target = []) {
    this.invokeAllPlugins((plugin) => plugin !== this && plugin.getAttributions && plugin.getAttributions(target));
    return target;
  }
  invokeOnePlugin(func) {
    const plugins = [...this.plugins, this];
    for (let i = 0; i < plugins.length; i++) {
      const result = func(plugins[i]);
      if (result) {
        return result;
      }
    }
    return null;
  }
  invokeAllPlugins(func) {
    const plugins = [...this.plugins, this];
    const pending = [];
    for (let i = 0; i < plugins.length; i++) {
      const result = func(plugins[i]);
      if (result) {
        pending.push(result);
      }
    }
    return pending.length === 0 ? null : Promise.all(pending);
  }
};

// node_modules/3d-tiles-renderer/src/utilities/arrayToString.js
var utf8decoder = new TextDecoder();
function arrayToString(array) {
  return utf8decoder.decode(array);
}

// node_modules/3d-tiles-renderer/src/utilities/FeatureTable.js
function parseBinArray(buffer, arrayStart, count, type, componentType, propertyName) {
  let stride;
  switch (type) {
    case "SCALAR":
      stride = 1;
      break;
    case "VEC2":
      stride = 2;
      break;
    case "VEC3":
      stride = 3;
      break;
    case "VEC4":
      stride = 4;
      break;
    default:
      throw new Error(`FeatureTable : Feature type not provided for "${propertyName}".`);
  }
  let data;
  const arrayLength = count * stride;
  switch (componentType) {
    case "BYTE":
      data = new Int8Array(buffer, arrayStart, arrayLength);
      break;
    case "UNSIGNED_BYTE":
      data = new Uint8Array(buffer, arrayStart, arrayLength);
      break;
    case "SHORT":
      data = new Int16Array(buffer, arrayStart, arrayLength);
      break;
    case "UNSIGNED_SHORT":
      data = new Uint16Array(buffer, arrayStart, arrayLength);
      break;
    case "INT":
      data = new Int32Array(buffer, arrayStart, arrayLength);
      break;
    case "UNSIGNED_INT":
      data = new Uint32Array(buffer, arrayStart, arrayLength);
      break;
    case "FLOAT":
      data = new Float32Array(buffer, arrayStart, arrayLength);
      break;
    case "DOUBLE":
      data = new Float64Array(buffer, arrayStart, arrayLength);
      break;
    default:
      throw new Error(`FeatureTable : Feature component type not provided for "${propertyName}".`);
  }
  return data;
}
var FeatureTable = class {
  constructor(buffer, start, headerLength, binLength) {
    this.buffer = buffer;
    this.binOffset = start + headerLength;
    this.binLength = binLength;
    let header = null;
    if (headerLength !== 0) {
      const headerData = new Uint8Array(buffer, start, headerLength);
      header = JSON.parse(arrayToString(headerData));
    } else {
      header = {};
    }
    this.header = header;
  }
  getKeys() {
    return Object.keys(this.header);
  }
  getData(key, count, defaultComponentType = null, defaultType = null) {
    const header = this.header;
    if (!(key in header)) {
      return null;
    }
    const feature = header[key];
    if (!(feature instanceof Object)) {
      return feature;
    } else if (Array.isArray(feature)) {
      return feature;
    } else {
      const { buffer, binOffset, binLength } = this;
      const byteOffset = feature.byteOffset || 0;
      const featureType = feature.type || defaultType;
      const featureComponentType = feature.componentType || defaultComponentType;
      if ("type" in feature && defaultType && feature.type !== defaultType) {
        throw new Error("FeatureTable: Specified type does not match expected type.");
      }
      const arrayStart = binOffset + byteOffset;
      const data = parseBinArray(buffer, arrayStart, count, featureType, featureComponentType, key);
      const dataEnd = arrayStart + data.byteLength;
      if (dataEnd > binOffset + binLength) {
        throw new Error("FeatureTable: Feature data read outside binary body length.");
      }
      return data;
    }
  }
  getBuffer(byteOffset, byteLength) {
    const { buffer, binOffset } = this;
    return buffer.slice(binOffset + byteOffset, binOffset + byteOffset + byteLength);
  }
};

// node_modules/3d-tiles-renderer/src/utilities/BatchTableHierarchyExtension.js
var BatchTableHierarchyExtension = class {
  constructor(batchTable) {
    this.batchTable = batchTable;
    const extensionHeader = batchTable.header.extensions["3DTILES_batch_table_hierarchy"];
    this.classes = extensionHeader.classes;
    for (const classDef of this.classes) {
      const instances = classDef.instances;
      for (const property in instances) {
        classDef.instances[property] = this._parseProperty(instances[property], classDef.length, property);
      }
    }
    this.instancesLength = extensionHeader.instancesLength;
    this.classIds = this._parseProperty(extensionHeader.classIds, this.instancesLength, "classIds");
    if (extensionHeader.parentCounts) {
      this.parentCounts = this._parseProperty(extensionHeader.parentCounts, this.instancesLength, "parentCounts");
    } else {
      this.parentCounts = new Array(this.instancesLength).fill(1);
    }
    if (extensionHeader.parentIds) {
      const parentIdsLength = this.parentCounts.reduce((a, b) => a + b, 0);
      this.parentIds = this._parseProperty(extensionHeader.parentIds, parentIdsLength, "parentIds");
    } else {
      this.parentIds = null;
    }
    this.instancesIds = [];
    const classCounter = {};
    for (const classId of this.classIds) {
      classCounter[classId] = classCounter[classId] ?? 0;
      this.instancesIds.push(classCounter[classId]);
      classCounter[classId]++;
    }
  }
  _parseProperty(property, propertyLength, propertyName) {
    if (Array.isArray(property)) {
      return property;
    } else {
      const { buffer, binOffset } = this.batchTable;
      const byteOffset = property.byteOffset;
      const componentType = property.componentType || "UNSIGNED_SHORT";
      const arrayStart = binOffset + byteOffset;
      return parseBinArray(buffer, arrayStart, propertyLength, "SCALAR", componentType, propertyName);
    }
  }
  getDataFromId(id, target = {}) {
    const parentCount = this.parentCounts[id];
    if (this.parentIds && parentCount > 0) {
      let parentIdsOffset = 0;
      for (let i = 0; i < id; i++) {
        parentIdsOffset += this.parentCounts[i];
      }
      for (let i = 0; i < parentCount; i++) {
        const parentId = this.parentIds[parentIdsOffset + i];
        if (parentId !== id) {
          this.getDataFromId(parentId, target);
        }
      }
    }
    const classId = this.classIds[id];
    const instances = this.classes[classId].instances;
    const className = this.classes[classId].name;
    const instanceId = this.instancesIds[id];
    for (const key in instances) {
      target[className] = target[className] || {};
      target[className][key] = instances[key][instanceId];
    }
    return target;
  }
};

// node_modules/3d-tiles-renderer/src/utilities/BatchTable.js
var BatchTable = class extends FeatureTable {
  get batchSize() {
    console.warn("BatchTable.batchSize has been deprecated and replaced with BatchTable.count.");
    return this.count;
  }
  constructor(buffer, count, start, headerLength, binLength) {
    super(buffer, start, headerLength, binLength);
    this.count = count;
    this.extensions = {};
    const extensions = this.header.extensions;
    if (extensions) {
      if (extensions["3DTILES_batch_table_hierarchy"]) {
        this.extensions["3DTILES_batch_table_hierarchy"] = new BatchTableHierarchyExtension(this);
      }
    }
  }
  getData(key, componentType = null, type = null) {
    console.warn("BatchTable: BatchTable.getData is deprecated. Use BatchTable.getDataFromId to get allproperties for an id or BatchTable.getPropertyArray for getting an array of value for a property.");
    return super.getData(key, this.count, componentType, type);
  }
  getDataFromId(id, target = {}) {
    if (id < 0 || id >= this.count) {
      throw new Error(`BatchTable: id value "${id}" out of bounds for "${this.count}" features number.`);
    }
    for (const key of this.getKeys()) {
      if (key !== "extensions") {
        target[key] = super.getData(key, this.count)[id];
      }
    }
    for (const extensionName in this.extensions) {
      const extension = this.extensions[extensionName];
      if (extension.getDataFromId instanceof Function) {
        target[extensionName] = target[extensionName] || {};
        extension.getDataFromId(id, target[extensionName]);
      }
    }
    return target;
  }
  getPropertyArray(key) {
    return super.getData(key, this.count);
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

// node_modules/3d-tiles-renderer/src/base/loaders/B3DMLoaderBase.js
var B3DMLoaderBase = class extends LoaderBase {
  parse(buffer) {
    const dataView = new DataView(buffer);
    const magic = readMagicBytes(dataView);
    console.assert(magic === "b3dm");
    const version = dataView.getUint32(4, true);
    console.assert(version === 1);
    const byteLength = dataView.getUint32(8, true);
    console.assert(byteLength === buffer.byteLength);
    const featureTableJSONByteLength = dataView.getUint32(12, true);
    const featureTableBinaryByteLength = dataView.getUint32(16, true);
    const batchTableJSONByteLength = dataView.getUint32(20, true);
    const batchTableBinaryByteLength = dataView.getUint32(24, true);
    const featureTableStart = 28;
    const featureTableBuffer = buffer.slice(
      featureTableStart,
      featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength
    );
    const featureTable = new FeatureTable(
      featureTableBuffer,
      0,
      featureTableJSONByteLength,
      featureTableBinaryByteLength
    );
    const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
    const batchTableBuffer = buffer.slice(
      batchTableStart,
      batchTableStart + batchTableJSONByteLength + batchTableBinaryByteLength
    );
    const batchTable = new BatchTable(
      batchTableBuffer,
      featureTable.getData("BATCH_LENGTH"),
      0,
      batchTableJSONByteLength,
      batchTableBinaryByteLength
    );
    const glbStart = batchTableStart + batchTableJSONByteLength + batchTableBinaryByteLength;
    const glbBytes = new Uint8Array(buffer, glbStart, byteLength - glbStart);
    return {
      version,
      featureTable,
      batchTable,
      glbBytes
    };
  }
};

// node_modules/3d-tiles-renderer/src/three/loaders/B3DMLoader.js
import { DefaultLoadingManager, Matrix4 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
var B3DMLoader = class extends B3DMLoaderBase {
  constructor(manager = DefaultLoadingManager) {
    super();
    this.manager = manager;
    this.adjustmentTransform = new Matrix4();
  }
  parse(buffer) {
    const b3dm = super.parse(buffer);
    const gltfBuffer = b3dm.glbBytes.slice().buffer;
    return new Promise((resolve, reject) => {
      const manager = this.manager;
      const fetchOptions = this.fetchOptions;
      const loader = manager.getHandler("path.gltf") || new GLTFLoader(manager);
      if (fetchOptions.credentials === "include" && fetchOptions.mode === "cors") {
        loader.setCrossOrigin("use-credentials");
      }
      if ("credentials" in fetchOptions) {
        loader.setWithCredentials(fetchOptions.credentials === "include");
      }
      if (fetchOptions.headers) {
        loader.setRequestHeader(fetchOptions.headers);
      }
      let workingPath = this.workingPath;
      if (!/[\\/]$/.test(workingPath) && workingPath.length) {
        workingPath += "/";
      }
      const adjustmentTransform = this.adjustmentTransform;
      loader.parse(gltfBuffer, workingPath, (model) => {
        const { batchTable, featureTable } = b3dm;
        const { scene } = model;
        const rtcCenter = featureTable.getData("RTC_CENTER");
        if (rtcCenter) {
          scene.position.x += rtcCenter[0];
          scene.position.y += rtcCenter[1];
          scene.position.z += rtcCenter[2];
        }
        model.scene.updateMatrix();
        model.scene.matrix.multiply(adjustmentTransform);
        model.scene.matrix.decompose(model.scene.position, model.scene.quaternion, model.scene.scale);
        model.batchTable = batchTable;
        model.featureTable = featureTable;
        scene.batchTable = batchTable;
        scene.featureTable = featureTable;
        resolve(model);
      }, reject);
    });
  }
};

// node_modules/3d-tiles-renderer/src/base/loaders/PNTSLoaderBase.js
var PNTSLoaderBase = class extends LoaderBase {
  parse(buffer) {
    const dataView = new DataView(buffer);
    const magic = readMagicBytes(dataView);
    console.assert(magic === "pnts");
    const version = dataView.getUint32(4, true);
    console.assert(version === 1);
    const byteLength = dataView.getUint32(8, true);
    console.assert(byteLength === buffer.byteLength);
    const featureTableJSONByteLength = dataView.getUint32(12, true);
    const featureTableBinaryByteLength = dataView.getUint32(16, true);
    const batchTableJSONByteLength = dataView.getUint32(20, true);
    const batchTableBinaryByteLength = dataView.getUint32(24, true);
    const featureTableStart = 28;
    const featureTableBuffer = buffer.slice(
      featureTableStart,
      featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength
    );
    const featureTable = new FeatureTable(
      featureTableBuffer,
      0,
      featureTableJSONByteLength,
      featureTableBinaryByteLength
    );
    const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
    const batchTableBuffer = buffer.slice(
      batchTableStart,
      batchTableStart + batchTableJSONByteLength + batchTableBinaryByteLength
    );
    const batchTable = new BatchTable(
      batchTableBuffer,
      featureTable.getData("BATCH_LENGTH") || featureTable.getData("POINTS_LENGTH"),
      0,
      batchTableJSONByteLength,
      batchTableBinaryByteLength
    );
    return Promise.resolve({
      version,
      featureTable,
      batchTable
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/loaders/PNTSLoader.js
import {
  Points,
  PointsMaterial,
  BufferGeometry,
  BufferAttribute,
  DefaultLoadingManager as DefaultLoadingManager2,
  Vector3 as Vector32,
  Color
} from "three";

// node_modules/3d-tiles-renderer/src/utilities/rgb565torgb.js
function rgb565torgb(rgb565) {
  const red5 = rgb565 >> 11;
  const green6 = rgb565 >> 5 & 63;
  const blue5 = rgb565 & 31;
  const red8 = Math.round(red5 / 31 * 255);
  const green8 = Math.round(green6 / 63 * 255);
  const blue8 = Math.round(blue5 / 31 * 255);
  return [red8, green8, blue8];
}

// node_modules/3d-tiles-renderer/src/utilities/decodeOctNormal.js
import { Vector2, MathUtils, Vector3 } from "three";
var f = new Vector2();
function decodeOctNormal(x, y, target = new Vector3()) {
  f.set(x, y).divideScalar(256).multiplyScalar(2).subScalar(1);
  target.set(f.x, f.y, 1 - Math.abs(f.x) - Math.abs(f.y));
  const t = MathUtils.clamp(-target.z, 0, 1);
  if (target.x >= 0) {
    target.setX(target.x - t);
  } else {
    target.setX(target.x + t);
  }
  if (target.y >= 0) {
    target.setY(target.y - t);
  } else {
    target.setY(target.y + t);
  }
  target.normalize();
  return target;
}

// node_modules/3d-tiles-renderer/src/three/loaders/PNTSLoader.js
var DRACO_ATTRIBUTE_MAP = {
  RGB: "color",
  POSITION: "position"
};
var PNTSLoader = class extends PNTSLoaderBase {
  constructor(manager = DefaultLoadingManager2) {
    super();
    this.manager = manager;
  }
  parse(buffer) {
    return super.parse(buffer).then(async (result) => {
      const { featureTable, batchTable } = result;
      const material = new PointsMaterial();
      const extensions = featureTable.header.extensions;
      const translationOffset = new Vector32();
      let geometry;
      if (extensions && extensions["3DTILES_draco_point_compression"]) {
        const { byteOffset, byteLength, properties } = extensions["3DTILES_draco_point_compression"];
        const dracoLoader = this.manager.getHandler("draco.drc");
        if (dracoLoader == null) {
          throw new Error("PNTSLoader: dracoLoader not available.");
        }
        const attributeIDs = {};
        for (const key in properties) {
          if (key in DRACO_ATTRIBUTE_MAP && key in properties) {
            const mappedKey = DRACO_ATTRIBUTE_MAP[key];
            attributeIDs[mappedKey] = properties[key];
          }
        }
        const taskConfig = {
          attributeIDs,
          attributeTypes: {
            position: "Float32Array",
            color: "Uint8Array"
          },
          useUniqueIDs: true
        };
        const buffer2 = featureTable.getBuffer(byteOffset, byteLength);
        geometry = await dracoLoader.decodeGeometry(buffer2, taskConfig);
        if (geometry.attributes.color) {
          material.vertexColors = true;
        }
      } else {
        const POINTS_LENGTH = featureTable.getData("POINTS_LENGTH");
        const POSITION = featureTable.getData("POSITION", POINTS_LENGTH, "FLOAT", "VEC3");
        const NORMAL = featureTable.getData("NORMAL", POINTS_LENGTH, "FLOAT", "VEC3");
        const NORMAL_OCT16P = featureTable.getData("NORMAL", POINTS_LENGTH, "UNSIGNED_BYTE", "VEC2");
        const RGB = featureTable.getData("RGB", POINTS_LENGTH, "UNSIGNED_BYTE", "VEC3");
        const RGBA = featureTable.getData("RGBA", POINTS_LENGTH, "UNSIGNED_BYTE", "VEC4");
        const RGB565 = featureTable.getData("RGB565", POINTS_LENGTH, "UNSIGNED_SHORT", "SCALAR");
        const CONSTANT_RGBA = featureTable.getData("CONSTANT_RGBA", POINTS_LENGTH, "UNSIGNED_BYTE", "VEC4");
        const POSITION_QUANTIZED = featureTable.getData("POSITION_QUANTIZED", POINTS_LENGTH, "UNSIGNED_SHORT", "VEC3");
        const QUANTIZED_VOLUME_SCALE = featureTable.getData("QUANTIZED_VOLUME_SCALE", POINTS_LENGTH, "FLOAT", "VEC3");
        const QUANTIZED_VOLUME_OFFSET = featureTable.getData("QUANTIZED_VOLUME_OFFSET", POINTS_LENGTH, "FLOAT", "VEC3");
        geometry = new BufferGeometry();
        if (POSITION_QUANTIZED) {
          const decodedPositions = new Float32Array(POINTS_LENGTH * 3);
          for (let i = 0; i < POINTS_LENGTH; i++) {
            for (let j = 0; j < 3; j++) {
              const index = 3 * i + j;
              decodedPositions[index] = POSITION_QUANTIZED[index] / 65535 * QUANTIZED_VOLUME_SCALE[j];
            }
          }
          translationOffset.x = QUANTIZED_VOLUME_OFFSET[0];
          translationOffset.y = QUANTIZED_VOLUME_OFFSET[1];
          translationOffset.z = QUANTIZED_VOLUME_OFFSET[2];
          geometry.setAttribute("position", new BufferAttribute(decodedPositions, 3, false));
        } else {
          geometry.setAttribute("position", new BufferAttribute(POSITION, 3, false));
        }
        if (NORMAL !== null) {
          geometry.setAttribute("normal", new BufferAttribute(NORMAL, 3, false));
        } else if (NORMAL_OCT16P !== null) {
          const decodedNormals = new Float32Array(POINTS_LENGTH * 3);
          const n = new Vector32();
          for (let i = 0; i < POINTS_LENGTH; i++) {
            const x = NORMAL_OCT16P[i * 2];
            const y = NORMAL_OCT16P[i * 2 + 1];
            const normal = decodeOctNormal(x, y, n);
            decodedNormals[i * 3] = normal.x;
            decodedNormals[i * 3 + 1] = normal.y;
            decodedNormals[i * 3 + 2] = normal.z;
          }
          geometry.setAttribute("normal", new BufferAttribute(decodedNormals, 3, false));
        }
        if (RGBA !== null) {
          geometry.setAttribute("color", new BufferAttribute(RGBA, 4, true));
          material.vertexColors = true;
          material.transparent = true;
          material.depthWrite = false;
        } else if (RGB !== null) {
          geometry.setAttribute("color", new BufferAttribute(RGB, 3, true));
          material.vertexColors = true;
        } else if (RGB565 !== null) {
          const color = new Uint8Array(POINTS_LENGTH * 3);
          for (let i = 0; i < POINTS_LENGTH; i++) {
            const rgbColor = rgb565torgb(RGB565[i]);
            for (let j = 0; j < 3; j++) {
              const index = 3 * i + j;
              color[index] = rgbColor[j];
            }
          }
          geometry.setAttribute("color", new BufferAttribute(color, 3, true));
          material.vertexColors = true;
        } else if (CONSTANT_RGBA !== null) {
          const color = new Color(CONSTANT_RGBA[0], CONSTANT_RGBA[1], CONSTANT_RGBA[2]);
          material.color = color;
          const opacity = CONSTANT_RGBA[3] / 255;
          if (opacity < 1) {
            material.opacity = opacity;
            material.transparent = true;
            material.depthWrite = false;
          }
        }
      }
      const object = new Points(geometry, material);
      object.position.copy(translationOffset);
      result.scene = object;
      result.scene.featureTable = featureTable;
      result.scene.batchTable = batchTable;
      const rtcCenter = featureTable.getData("RTC_CENTER");
      if (rtcCenter) {
        result.scene.position.x += rtcCenter[0];
        result.scene.position.y += rtcCenter[1];
        result.scene.position.z += rtcCenter[2];
      }
      return result;
    });
  }
};

// node_modules/3d-tiles-renderer/src/base/loaders/I3DMLoaderBase.js
var I3DMLoaderBase = class extends LoaderBase {
  parse(buffer) {
    const dataView = new DataView(buffer);
    const magic = readMagicBytes(dataView);
    console.assert(magic === "i3dm");
    const version = dataView.getUint32(4, true);
    console.assert(version === 1);
    const byteLength = dataView.getUint32(8, true);
    console.assert(byteLength === buffer.byteLength);
    const featureTableJSONByteLength = dataView.getUint32(12, true);
    const featureTableBinaryByteLength = dataView.getUint32(16, true);
    const batchTableJSONByteLength = dataView.getUint32(20, true);
    const batchTableBinaryByteLength = dataView.getUint32(24, true);
    const gltfFormat = dataView.getUint32(28, true);
    const featureTableStart = 32;
    const featureTableBuffer = buffer.slice(
      featureTableStart,
      featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength
    );
    const featureTable = new FeatureTable(
      featureTableBuffer,
      0,
      featureTableJSONByteLength,
      featureTableBinaryByteLength
    );
    const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
    const batchTableBuffer = buffer.slice(
      batchTableStart,
      batchTableStart + batchTableJSONByteLength + batchTableBinaryByteLength
    );
    const batchTable = new BatchTable(
      batchTableBuffer,
      featureTable.getData("INSTANCES_LENGTH"),
      0,
      batchTableJSONByteLength,
      batchTableBinaryByteLength
    );
    const glbStart = batchTableStart + batchTableJSONByteLength + batchTableBinaryByteLength;
    const bodyBytes = new Uint8Array(buffer, glbStart, byteLength - glbStart);
    let glbBytes = null;
    let promise = null;
    let gltfWorkingPath = null;
    if (gltfFormat) {
      glbBytes = bodyBytes;
      promise = Promise.resolve();
    } else {
      const externalUri = this.resolveExternalURL(arrayToString(bodyBytes));
      const uriSplits = externalUri.split(/[\\/]/g);
      uriSplits.pop();
      gltfWorkingPath = uriSplits.join("/");
      promise = fetch(externalUri, this.fetchOptions).then((res) => {
        if (!res.ok) {
          throw new Error(`I3DMLoaderBase : Failed to load file "${externalUri}" with status ${res.status} : ${res.statusText}`);
        }
        return res.arrayBuffer();
      }).then((buffer2) => {
        glbBytes = new Uint8Array(buffer2);
      });
    }
    return promise.then(() => {
      return {
        version,
        featureTable,
        batchTable,
        glbBytes,
        gltfWorkingPath
      };
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/loaders/I3DMLoader.js
import { DefaultLoadingManager as DefaultLoadingManager3, Matrix4 as Matrix43, InstancedMesh, Vector3 as Vector35, Quaternion } from "three";
import { GLTFLoader as GLTFLoader2 } from "three/examples/jsm/loaders/GLTFLoader.js";

// node_modules/3d-tiles-renderer/src/three/math/Ellipsoid.js
import { Vector3 as Vector34, Spherical as Spherical2, MathUtils as MathUtils3, Ray, Matrix4 as Matrix42, Sphere, Euler } from "three";

// node_modules/3d-tiles-renderer/src/three/math/GeoUtils.js
var GeoUtils_exports = {};
__export(GeoUtils_exports, {
  latitudeToSphericalPhi: () => latitudeToSphericalPhi,
  sphericalPhiToLatitude: () => sphericalPhiToLatitude,
  swapToGeoFrame: () => swapToGeoFrame,
  swapToThreeFrame: () => swapToThreeFrame,
  toLatLonString: () => toLatLonString
});
import { Spherical, Vector3 as Vector33, MathUtils as MathUtils2 } from "three";
var _spherical = new Spherical();
var _vec = new Vector33();
var _geoResults = {};
function swapToGeoFrame(target) {
  const { x, y, z } = target;
  target.x = z;
  target.y = x;
  target.z = y;
}
function swapToThreeFrame(target) {
  const { x, y, z } = target;
  target.z = x;
  target.x = y;
  target.y = z;
}
function sphericalPhiToLatitude(phi) {
  return -(phi - Math.PI / 2);
}
function latitudeToSphericalPhi(latitude) {
  return -latitude + Math.PI / 2;
}
function correctGeoCoordWrap(lat, lon, target = {}) {
  _spherical.theta = lon;
  _spherical.phi = latitudeToSphericalPhi(lat);
  _vec.setFromSpherical(_spherical);
  _spherical.setFromVector3(_vec);
  target.lat = sphericalPhiToLatitude(_spherical.phi);
  target.lon = _spherical.theta;
  return target;
}
function toHoursMinutesSecondsString(value, pos = "E", neg = "W") {
  const direction = value < 0 ? neg : pos;
  value = Math.abs(value);
  const hours = ~~value;
  const minDec = (value - hours) * 60;
  const minutes = ~~minDec;
  const secDec = (minDec - minutes) * 60;
  const seconds = ~~secDec;
  return `${hours}\xB0 ${minutes}' ${seconds}" ${direction}`;
}
function toLatLonString(lat, lon, decimalFormat = false) {
  const result = correctGeoCoordWrap(lat, lon, _geoResults);
  let latString, lonString;
  if (decimalFormat) {
    latString = `${(MathUtils2.RAD2DEG * result.lat).toFixed(4)}\xB0`;
    lonString = `${(MathUtils2.RAD2DEG * result.lon).toFixed(4)}\xB0`;
  } else {
    latString = toHoursMinutesSecondsString(MathUtils2.RAD2DEG * result.lat, "N", "S");
    lonString = toHoursMinutesSecondsString(MathUtils2.RAD2DEG * result.lon, "E", "W");
  }
  return `${latString} ${lonString}`;
}

// node_modules/3d-tiles-renderer/src/three/math/Ellipsoid.js
var _spherical2 = new Spherical2();
var _norm = new Vector34();
var _vec2 = new Vector34();
var _vec22 = new Vector34();
var _matrix = new Matrix42();
var _matrix2 = new Matrix42();
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
    _matrix.makeScale(...this.radius).invert();
    _sphere.center.set(0, 0, 0);
    _sphere.radius = 1;
    _ray.copy(ray).applyMatrix4(_matrix);
    if (_ray.intersectSphere(_sphere, target)) {
      _matrix.makeScale(...this.radius);
      target.applyMatrix4(_matrix);
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
      _matrix2.makeRotationFromEuler(_euler).premultiply(rotationMatrix);
    } else if (frame === OBJECT_FRAME) {
      _euler.set(-Math.PI / 2, 0, Math.PI, "XYZ");
      _matrix2.makeRotationFromEuler(_euler).premultiply(rotationMatrix);
    } else {
      _matrix2.copy(rotationMatrix);
    }
    this.getEastNorthUpFrame(lat, lon, _matrix).invert();
    _matrix2.premultiply(_matrix);
    _euler.setFromRotationMatrix(_matrix2, "ZXY");
    target.azimuth = -_euler.z;
    target.elevation = _euler.x;
    target.roll = _euler.y;
    return target;
  }
  getRotationMatrixFromAzElRoll(lat, lon, az, el, roll, target, frame = ENU_FRAME) {
    this.getEastNorthUpFrame(lat, lon, _matrix);
    _euler.set(el, roll, -az, "ZXY");
    target.makeRotationFromEuler(_euler).premultiply(_matrix).setPosition(0, 0, 0);
    if (frame === CAMERA_FRAME) {
      _euler.set(Math.PI / 2, 0, 0, "XYZ");
      _matrix2.makeRotationFromEuler(_euler);
      target.multiply(_matrix2);
    } else if (frame === OBJECT_FRAME) {
      _euler.set(-Math.PI / 2, 0, Math.PI, "XYZ");
      _matrix2.makeRotationFromEuler(_euler);
      target.multiply(_matrix2);
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
    _vec2.copy(_norm);
    _vec2.x *= radius.x ** 2;
    _vec2.y *= radius.y ** 2;
    _vec2.z *= radius.z ** 2;
    const gamma = Math.sqrt(_norm.dot(_vec2));
    _vec2.divideScalar(gamma);
    return target.copy(_vec2).addScaledVector(_norm, height);
  }
  getPositionToCartographic(pos, target) {
    this.getPositionToSurfacePoint(pos, _vec2);
    this.getPositionToNormal(pos, _norm);
    const heightDelta = _vec22.subVectors(pos, _vec2);
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
    const intersection = _vec2.copy(pos).multiplyScalar(ratio);
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
    this.getPositionToSurfacePoint(pos, _vec2);
    const heightDelta = _vec22.subVectors(pos, _vec2);
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

// node_modules/3d-tiles-renderer/src/three/math/GeoConstants.js
var WGS84_ELLIPSOID = new Ellipsoid(WGS84_RADIUS, WGS84_RADIUS, WGS84_HEIGHT);
WGS84_ELLIPSOID.name = "WGS84 Earth";

// node_modules/3d-tiles-renderer/src/three/loaders/I3DMLoader.js
var tempFwd = /* @__PURE__ */ new Vector35();
var tempUp = /* @__PURE__ */ new Vector35();
var tempRight = /* @__PURE__ */ new Vector35();
var tempPos = /* @__PURE__ */ new Vector35();
var tempQuat = /* @__PURE__ */ new Quaternion();
var tempSca = /* @__PURE__ */ new Vector35();
var tempMat = /* @__PURE__ */ new Matrix43();
var tempMat2 = /* @__PURE__ */ new Matrix43();
var tempGlobePos = /* @__PURE__ */ new Vector35();
var tempEnuFrame = /* @__PURE__ */ new Matrix43();
var tempLocalQuat = /* @__PURE__ */ new Quaternion();
var tempLatLon = {};
var I3DMLoader = class extends I3DMLoaderBase {
  constructor(manager = DefaultLoadingManager3) {
    super();
    this.manager = manager;
    this.adjustmentTransform = new Matrix43();
    this.ellipsoid = WGS84_ELLIPSOID.clone();
  }
  resolveExternalURL(url) {
    return this.manager.resolveURL(super.resolveExternalURL(url));
  }
  parse(buffer) {
    return super.parse(buffer).then((i3dm) => {
      const { featureTable, batchTable } = i3dm;
      const gltfBuffer = i3dm.glbBytes.slice().buffer;
      return new Promise((resolve, reject) => {
        const fetchOptions = this.fetchOptions;
        const manager = this.manager;
        const loader = manager.getHandler("path.gltf") || new GLTFLoader2(manager);
        if (fetchOptions.credentials === "include" && fetchOptions.mode === "cors") {
          loader.setCrossOrigin("use-credentials");
        }
        if ("credentials" in fetchOptions) {
          loader.setWithCredentials(fetchOptions.credentials === "include");
        }
        if (fetchOptions.headers) {
          loader.setRequestHeader(fetchOptions.headers);
        }
        let workingPath = i3dm.gltfWorkingPath ?? this.workingPath;
        if (!/[\\/]$/.test(workingPath)) {
          workingPath += "/";
        }
        const adjustmentTransform = this.adjustmentTransform;
        loader.parse(gltfBuffer, workingPath, (model) => {
          const INSTANCES_LENGTH = featureTable.getData("INSTANCES_LENGTH");
          const POSITION = featureTable.getData("POSITION", INSTANCES_LENGTH, "FLOAT", "VEC3");
          const NORMAL_UP = featureTable.getData("NORMAL_UP", INSTANCES_LENGTH, "FLOAT", "VEC3");
          const NORMAL_RIGHT = featureTable.getData("NORMAL_RIGHT", INSTANCES_LENGTH, "FLOAT", "VEC3");
          const SCALE_NON_UNIFORM = featureTable.getData("SCALE_NON_UNIFORM", INSTANCES_LENGTH, "FLOAT", "VEC3");
          const SCALE = featureTable.getData("SCALE", INSTANCES_LENGTH, "FLOAT", "SCALAR");
          const RTC_CENTER = featureTable.getData("RTC_CENTER");
          const EAST_NORTH_UP = featureTable.getData("EAST_NORTH_UP");
          [
            "QUANTIZED_VOLUME_OFFSET",
            "QUANTIZED_VOLUME_SCALE",
            "POSITION_QUANTIZED",
            "NORMAL_UP_OCT32P",
            "NORMAL_RIGHT_OCT32P"
          ].forEach((feature) => {
            if (feature in featureTable.header) {
              console.warn(`I3DMLoader: Unsupported FeatureTable feature "${feature}" detected.`);
            }
          });
          const averageVector = new Vector35();
          for (let i = 0; i < INSTANCES_LENGTH; i++) {
            averageVector.x += POSITION[i * 3 + 0] / INSTANCES_LENGTH;
            averageVector.y += POSITION[i * 3 + 1] / INSTANCES_LENGTH;
            averageVector.z += POSITION[i * 3 + 2] / INSTANCES_LENGTH;
          }
          const instances = [];
          const meshes = [];
          model.scene.updateMatrixWorld();
          model.scene.traverse((child) => {
            if (child.isMesh) {
              meshes.push(child);
              const { geometry, material } = child;
              const instancedMesh = new InstancedMesh(geometry, material, INSTANCES_LENGTH);
              instancedMesh.position.copy(averageVector);
              if (RTC_CENTER) {
                instancedMesh.position.x += RTC_CENTER[0];
                instancedMesh.position.y += RTC_CENTER[1];
                instancedMesh.position.z += RTC_CENTER[2];
              }
              instances.push(instancedMesh);
            }
          });
          for (let i = 0; i < INSTANCES_LENGTH; i++) {
            tempPos.set(
              POSITION[i * 3 + 0] - averageVector.x,
              POSITION[i * 3 + 1] - averageVector.y,
              POSITION[i * 3 + 2] - averageVector.z
            );
            tempQuat.identity();
            if (NORMAL_UP) {
              tempUp.set(
                NORMAL_UP[i * 3 + 0],
                NORMAL_UP[i * 3 + 1],
                NORMAL_UP[i * 3 + 2]
              );
              tempRight.set(
                NORMAL_RIGHT[i * 3 + 0],
                NORMAL_RIGHT[i * 3 + 1],
                NORMAL_RIGHT[i * 3 + 2]
              );
              tempFwd.crossVectors(tempRight, tempUp).normalize();
              tempMat.makeBasis(
                tempRight,
                tempUp,
                tempFwd
              );
              tempQuat.setFromRotationMatrix(tempMat);
            }
            tempSca.set(1, 1, 1);
            if (SCALE_NON_UNIFORM) {
              tempSca.set(
                SCALE_NON_UNIFORM[i * 3 + 0],
                SCALE_NON_UNIFORM[i * 3 + 1],
                SCALE_NON_UNIFORM[i * 3 + 2]
              );
            }
            if (SCALE) {
              tempSca.multiplyScalar(SCALE[i]);
            }
            for (let j = 0, l = instances.length; j < l; j++) {
              const instance = instances[j];
              tempLocalQuat.copy(tempQuat);
              if (EAST_NORTH_UP) {
                instance.updateMatrixWorld();
                tempGlobePos.copy(tempPos).applyMatrix4(instance.matrixWorld);
                this.ellipsoid.getPositionToCartographic(tempGlobePos, tempLatLon);
                this.ellipsoid.getEastNorthUpFrame(tempLatLon.lat, tempLatLon.lon, tempEnuFrame);
                tempLocalQuat.setFromRotationMatrix(tempEnuFrame);
              }
              tempMat.compose(tempPos, tempLocalQuat, tempSca).multiply(adjustmentTransform);
              const mesh = meshes[j];
              tempMat2.multiplyMatrices(tempMat, mesh.matrixWorld);
              instance.setMatrixAt(i, tempMat2);
            }
          }
          model.scene.clear();
          model.scene.add(...instances);
          model.batchTable = batchTable;
          model.featureTable = featureTable;
          model.scene.batchTable = batchTable;
          model.scene.featureTable = featureTable;
          resolve(model);
        }, reject);
      });
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/loaders/CMPTLoader.js
import { Group, DefaultLoadingManager as DefaultLoadingManager4, Matrix4 as Matrix44 } from "three";

// node_modules/3d-tiles-renderer/src/base/loaders/CMPTLoaderBase.js
var CMPTLoaderBase = class extends LoaderBase {
  parse(buffer) {
    const dataView = new DataView(buffer);
    const magic = readMagicBytes(dataView);
    console.assert(magic === "cmpt", 'CMPTLoader: The magic bytes equal "cmpt".');
    const version = dataView.getUint32(4, true);
    console.assert(version === 1, 'CMPTLoader: The version listed in the header is "1".');
    const byteLength = dataView.getUint32(8, true);
    console.assert(byteLength === buffer.byteLength, "CMPTLoader: The contents buffer length listed in the header matches the file.");
    const tilesLength = dataView.getUint32(12, true);
    const tiles = [];
    let offset = 16;
    for (let i = 0; i < tilesLength; i++) {
      const tileView = new DataView(buffer, offset, 12);
      const tileMagic = readMagicBytes(tileView);
      const tileVersion = tileView.getUint32(4, true);
      const byteLength2 = tileView.getUint32(8, true);
      const tileBuffer = new Uint8Array(buffer, offset, byteLength2);
      tiles.push({
        type: tileMagic,
        buffer: tileBuffer,
        version: tileVersion
      });
      offset += byteLength2;
    }
    return {
      version,
      tiles
    };
  }
};

// node_modules/3d-tiles-renderer/src/three/loaders/CMPTLoader.js
var CMPTLoader = class extends CMPTLoaderBase {
  constructor(manager = DefaultLoadingManager4) {
    super();
    this.manager = manager;
    this.adjustmentTransform = new Matrix44();
    this.ellipsoid = WGS84_ELLIPSOID.clone();
  }
  parse(buffer) {
    const result = super.parse(buffer);
    const { manager, ellipsoid, adjustmentTransform } = this;
    const promises = [];
    for (const i in result.tiles) {
      const { type, buffer: buffer2 } = result.tiles[i];
      switch (type) {
        case "b3dm": {
          const slicedBuffer = buffer2.slice();
          const loader = new B3DMLoader(manager);
          loader.workingPath = this.workingPath;
          loader.fetchOptions = this.fetchOptions;
          loader.adjustmentTransform.copy(adjustmentTransform);
          const promise = loader.parse(slicedBuffer.buffer);
          promises.push(promise);
          break;
        }
        case "pnts": {
          const slicedBuffer = buffer2.slice();
          const loader = new PNTSLoader(manager);
          loader.workingPath = this.workingPath;
          loader.fetchOptions = this.fetchOptions;
          const promise = loader.parse(slicedBuffer.buffer);
          promises.push(promise);
          break;
        }
        case "i3dm": {
          const slicedBuffer = buffer2.slice();
          const loader = new I3DMLoader(manager);
          loader.workingPath = this.workingPath;
          loader.fetchOptions = this.fetchOptions;
          loader.ellipsoid.copy(ellipsoid);
          loader.adjustmentTransform.copy(adjustmentTransform);
          const promise = loader.parse(slicedBuffer.buffer);
          promises.push(promise);
          break;
        }
      }
    }
    return Promise.all(promises).then((results) => {
      const group = new Group();
      results.forEach((result2) => {
        group.add(result2.scene);
      });
      return {
        tiles: results,
        scene: group
      };
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/TilesGroup.js
import { Group as Group2, Matrix4 as Matrix45 } from "three";
var tempMat3 = new Matrix45();
var TilesGroup = class extends Group2 {
  constructor(tilesRenderer) {
    super();
    this.isTilesGroup = true;
    this.name = "TilesRenderer.TilesGroup";
    this.tilesRenderer = tilesRenderer;
    this.matrixWorldInverse = new Matrix45();
  }
  raycast(raycaster, intersects) {
    if (this.tilesRenderer.optimizeRaycast) {
      this.tilesRenderer.raycast(raycaster, intersects);
      return false;
    }
    return true;
  }
  updateMatrixWorld(force) {
    if (this.matrixAutoUpdate) {
      this.updateMatrix();
    }
    if (this.matrixWorldNeedsUpdate || force) {
      if (this.parent === null) {
        tempMat3.copy(this.matrix);
      } else {
        tempMat3.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      const elA = tempMat3.elements;
      const elB = this.matrixWorld.elements;
      let isDifferent = false;
      for (let i = 0; i < 16; i++) {
        const itemA = elA[i];
        const itemB = elB[i];
        const diff = Math.abs(itemA - itemB);
        if (diff > Number.EPSILON) {
          isDifferent = true;
          break;
        }
      }
      if (isDifferent) {
        this.matrixWorld.copy(tempMat3);
        this.matrixWorldInverse.copy(tempMat3).invert();
        const children = this.children;
        for (let i = 0, l = children.length; i < l; i++) {
          children[i].updateMatrixWorld();
        }
      }
    }
  }
};

// node_modules/3d-tiles-renderer/src/three/TilesRenderer.js
import {
  Matrix4 as Matrix48,
  Vector3 as Vector311,
  Vector2 as Vector22,
  Euler as Euler2,
  LoadingManager,
  EventDispatcher
} from "three";

// node_modules/3d-tiles-renderer/src/three/raycastTraverse.js
import { Ray as Ray2, Vector3 as Vector36 } from "three";
var _localRay = new Ray2();
var _vec3 = new Vector36();
var _hitArray = [];
function distanceSort(a, b) {
  return a.distance - b.distance;
}
function intersectTileScene(tile, raycaster, renderer, intersects) {
  const { scene } = tile.cached;
  const didRaycast = renderer.invokeOnePlugin((plugin) => plugin.raycastTile && plugin.raycastTile(tile, scene, raycaster, intersects));
  if (!didRaycast) {
    raycaster.intersectObject(scene, true, intersects);
  }
}
function intersectTileSceneFirstHist(tile, raycaster, renderer) {
  intersectTileScene(tile, raycaster, renderer, _hitArray);
  _hitArray.sort(distanceSort);
  const hit = _hitArray[0] || null;
  _hitArray.length = 0;
  return hit;
}
function raycastTraverseFirstHit(renderer, tile, raycaster, localRay = null) {
  const { group, activeTiles } = renderer;
  renderer.ensureChildrenArePreprocessed(tile);
  if (localRay === null) {
    localRay = _localRay;
    localRay.copy(raycaster.ray).applyMatrix4(group.matrixWorldInverse);
  }
  const array = [];
  const children = tile.children;
  for (let i = 0, l = children.length; i < l; i++) {
    const child = children[i];
    if (!child.__used) {
      continue;
    }
    const boundingVolume = child.cached.boundingVolume;
    if (boundingVolume.intersectRay(localRay, _vec3) !== null) {
      _vec3.applyMatrix4(group.matrixWorld);
      array.push({
        distance: _vec3.distanceToSquared(raycaster.ray.origin),
        tile: child
      });
    }
  }
  array.sort(distanceSort);
  let bestHit = null;
  let bestHitDistSq = Infinity;
  if (activeTiles.has(tile)) {
    const hit = intersectTileSceneFirstHist(tile, raycaster, renderer);
    if (hit) {
      bestHit = hit;
      bestHitDistSq = hit.distance * hit.distance;
    }
  }
  for (let i = 0, l = array.length; i < l; i++) {
    const data = array[i];
    const boundingVolumeDistSq = data.distance;
    const tile2 = data.tile;
    if (boundingVolumeDistSq > bestHitDistSq) {
      break;
    }
    const hit = raycastTraverseFirstHit(renderer, tile2, raycaster, localRay);
    if (hit) {
      const hitDistSq = hit.distance * hit.distance;
      if (hitDistSq < bestHitDistSq) {
        bestHit = hit;
        bestHitDistSq = hitDistSq;
      }
    }
  }
  return bestHit;
}
function raycastTraverse(renderer, tile, raycaster, intersects, localRay = null) {
  const { group, activeTiles } = renderer;
  const { boundingVolume } = tile.cached;
  renderer.ensureChildrenArePreprocessed(tile);
  if (localRay === null) {
    localRay = _localRay;
    localRay.copy(raycaster.ray).applyMatrix4(group.matrixWorldInverse);
  }
  if (!tile.__used || !boundingVolume.intersectsRay(localRay)) {
    return;
  }
  if (activeTiles.has(tile)) {
    intersectTileScene(tile, raycaster, renderer, intersects);
  }
  const children = tile.children;
  for (let i = 0, l = children.length; i < l; i++) {
    raycastTraverse(renderer, children[i], raycaster, intersects, localRay);
  }
}

// node_modules/3d-tiles-renderer/src/three/math/TileBoundingVolume.js
import { Vector3 as Vector310, Sphere as Sphere2 } from "three";

// node_modules/3d-tiles-renderer/src/three/math/OBB.js
import { Matrix4 as Matrix46, Box3, Vector3 as Vector38, Plane, Ray as Ray3 } from "three";

// node_modules/3d-tiles-renderer/src/three/math/ExtendedFrustum.js
import { Frustum, Matrix3, Vector3 as Vector37 } from "three";
var _mat3 = new Matrix3();
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
    this.points = Array(8).fill().map(() => new Vector37());
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
var _worldMin = new Vector38();
var _worldMax = new Vector38();
var _norm2 = new Vector38();
var _ray2 = new Ray3();
var _frustum = new ExtendedFrustum();
var OBB = class {
  constructor(box = new Box3(), transform = new Matrix46()) {
    this.box = box.clone();
    this.transform = transform.clone();
    this.inverseTransform = new Matrix46();
    this.points = new Array(8).fill().map(() => new Vector38());
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
  intersectsSphere(sphere) {
    this.clampPoint(sphere.center, _norm2);
    return _norm2.distanceToSquared(sphere.center) <= sphere.radius * sphere.radius;
  }
  intersectsOBB(obb) {
    _frustum.set(...obb.planes);
    _frustum.calculateFrustumPoints();
    return this.intersectsFrustum(_frustum);
  }
};

// node_modules/3d-tiles-renderer/src/three/math/EllipsoidRegion.js
import { MathUtils as MathUtils4, Matrix4 as Matrix47 } from "three";
import { Vector3 as Vector39 } from "three";
var PI = Math.PI;
var HALF_PI = PI / 2;
var _orthoX = new Vector39();
var _orthoY = new Vector39();
var _orthoZ = new Vector39();
var _invMatrix = new Matrix47();
var _poolIndex = 0;
var _pointsPool = [];
function getVector(usePool = false) {
  if (!usePool) {
    return new Vector39();
  }
  if (!_pointsPool[_poolIndex]) {
    _pointsPool[_poolIndex] = new Vector39();
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
    const midLat = MathUtils4.mapLinear(0.5, 0, 1, latStart, latEnd);
    const midLon = MathUtils4.mapLinear(0.5, 0, 1, lonStart, lonEnd);
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
      const height = MathUtils4.mapLinear(z, 0, 1, heightStart, heightEnd);
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
  getBoundingBox(box, matrix) {
    resetPool();
    const {
      latStart,
      latEnd,
      lonStart,
      lonEnd
    } = this;
    const latRange = latEnd - latStart;
    if (latRange < PI / 2) {
      const midLat = MathUtils4.mapLinear(0.5, 0, 1, latStart, latEnd);
      const midLon = MathUtils4.mapLinear(0.5, 0, 1, lonStart, lonEnd);
      this.getCartographicToNormal(midLat, midLon, _orthoZ);
      _orthoY.set(0, 0, 1);
      _orthoX.crossVectors(_orthoY, _orthoZ);
      _orthoY.crossVectors(_orthoX, _orthoZ);
      matrix.makeBasis(_orthoX, _orthoY, _orthoZ);
    } else {
      _orthoX.set(1, 0, 0);
      _orthoY.set(0, 1, 0);
      _orthoZ.set(0, 0, 1);
      matrix.makeBasis(_orthoX, _orthoY, _orthoZ);
    }
    _invMatrix.copy(matrix).invert();
    const points = this._getPoints(true);
    for (let i = 0, l = points.length; i < l; i++) {
      points[i].applyMatrix4(_invMatrix);
    }
    box.makeEmpty();
    box.setFromPoints(points);
  }
  getBoundingSphere(sphere, center) {
    resetPool();
    const points = this._getPoints(true);
    sphere.makeEmpty();
    sphere.setFromPoints(points, center);
  }
};

// node_modules/3d-tiles-renderer/src/three/math/TileBoundingVolume.js
var _vecX2 = new Vector310();
var _vecY2 = new Vector310();
var _vecZ2 = new Vector310();
var _sphereVec = new Vector310();
var _obbVec = new Vector310();
var TileBoundingVolume = class {
  constructor() {
    this.sphere = null;
    this.obb = null;
    this.region = null;
    this.regionObb = null;
  }
  intersectsRay(ray) {
    const sphere = this.sphere;
    const obb = this.obb || this.regionObb;
    if (sphere && !ray.intersectsSphere(sphere)) {
      return false;
    }
    if (obb && !obb.intersectsRay(ray)) {
      return false;
    }
    return true;
  }
  intersectRay(ray, target = null) {
    const sphere = this.sphere;
    const obb = this.obb || this.regionObb;
    let sphereDistSq = -Infinity;
    let obbDistSq = -Infinity;
    if (sphere) {
      if (ray.intersectSphere(sphere, _sphereVec)) {
        sphereDistSq = sphere.containsPoint(ray.origin) ? 0 : ray.origin.distanceToSquared(_sphereVec);
      }
    }
    if (obb) {
      if (obb.intersectRay(ray, _obbVec)) {
        obbDistSq = obb.containsPoint(ray.origin) ? 0 : ray.origin.distanceToSquared(_obbVec);
      }
    }
    const furthestDist = Math.max(sphereDistSq, obbDistSq);
    if (furthestDist === -Infinity) {
      return null;
    }
    ray.at(Math.sqrt(furthestDist), target);
    return target;
  }
  distanceToPoint(point) {
    const sphere = this.sphere;
    const obb = this.obb || this.regionObb;
    let sphereDistance = -Infinity;
    let obbDistance = -Infinity;
    if (sphere) {
      sphereDistance = Math.max(sphere.distanceToPoint(point), 0);
    }
    if (obb) {
      obbDistance = obb.distanceToPoint(point);
    }
    return sphereDistance > obbDistance ? sphereDistance : obbDistance;
  }
  intersectsFrustum(frustum) {
    const obb = this.obb || this.regionObb;
    const sphere = this.sphere;
    if (sphere && !frustum.intersectsSphere(sphere)) {
      return false;
    }
    if (obb && !obb.intersectsFrustum(frustum)) {
      return false;
    }
    return Boolean(sphere || obb);
  }
  intersectsSphere(otherSphere) {
    const obb = this.obb || this.regionObb;
    const sphere = this.sphere;
    if (sphere && !sphere.intersectsSphere(otherSphere)) {
      return false;
    }
    if (obb && !obb.intersectsSphere(otherSphere)) {
      return false;
    }
    return Boolean(sphere || obb);
  }
  intersectsOBB(otherObb) {
    const obb = this.obb || this.regionObb;
    const sphere = this.sphere;
    if (sphere && !otherObb.intersectsSphere(sphere)) {
      return false;
    }
    if (obb && !obb.intersectsOBB(otherObb)) {
      return false;
    }
    return Boolean(sphere || obb);
  }
  getOBB(targetBox, targetMatrix) {
    const obb = this.obb || this.regionObb;
    if (obb) {
      targetBox.copy(obb.box);
      targetMatrix.copy(obb.transform);
    } else {
      this.getAABB(targetBox);
      targetMatrix.identity();
    }
  }
  getAABB(target) {
    if (this.sphere) {
      this.sphere.getBoundingBox(target);
    } else {
      const obb = this.obb || this.regionObb;
      target.copy(obb.box).applyMatrix4(obb.transform);
    }
  }
  getSphere(target) {
    if (this.sphere) {
      target.copy(this.sphere);
    } else if (this.region) {
      this.region.getBoundingSphere(target);
    } else {
      const obb = this.obb || this.regionObb;
      obb.box.getBoundingSphere(target);
      target.applyMatrix4(obb.transform);
    }
  }
  setObbData(data, transform) {
    const obb = new OBB();
    _vecX2.set(data[3], data[4], data[5]);
    _vecY2.set(data[6], data[7], data[8]);
    _vecZ2.set(data[9], data[10], data[11]);
    const scaleX = _vecX2.length();
    const scaleY = _vecY2.length();
    const scaleZ = _vecZ2.length();
    _vecX2.normalize();
    _vecY2.normalize();
    _vecZ2.normalize();
    if (scaleX === 0) {
      _vecX2.crossVectors(_vecY2, _vecZ2);
    }
    if (scaleY === 0) {
      _vecY2.crossVectors(_vecX2, _vecZ2);
    }
    if (scaleZ === 0) {
      _vecZ2.crossVectors(_vecX2, _vecY2);
    }
    obb.transform.set(
      _vecX2.x,
      _vecY2.x,
      _vecZ2.x,
      data[0],
      _vecX2.y,
      _vecY2.y,
      _vecZ2.y,
      data[1],
      _vecX2.z,
      _vecY2.z,
      _vecZ2.z,
      data[2],
      0,
      0,
      0,
      1
    ).premultiply(transform);
    obb.box.min.set(-scaleX, -scaleY, -scaleZ);
    obb.box.max.set(scaleX, scaleY, scaleZ);
    obb.update();
    this.obb = obb;
  }
  setSphereData(x, y, z, radius, transform) {
    const sphere = new Sphere2();
    sphere.center.set(x, y, z);
    sphere.radius = radius;
    sphere.applyMatrix4(transform);
    this.sphere = sphere;
  }
  setRegionData(ellipsoid, west, south, east, north, minHeight, maxHeight) {
    const region = new EllipsoidRegion(
      ...ellipsoid.radius,
      south,
      north,
      west,
      east,
      minHeight,
      maxHeight
    );
    const obb = new OBB();
    region.getBoundingBox(obb.box, obb.transform);
    obb.update();
    this.region = region;
    this.regionObb = obb;
  }
};

// node_modules/3d-tiles-renderer/src/three/utilities.js
import { estimateBytesUsed as _estimateBytesUsed } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as THREE from "three";
function estimateBytesUsed(object) {
  const { TextureUtils } = THREE;
  if (!TextureUtils) {
    return 0;
  }
  const dedupeSet = /* @__PURE__ */ new Set();
  let totalBytes = 0;
  object.traverse((c) => {
    if (c.geometry && !dedupeSet.has(c.geometry)) {
      totalBytes += _estimateBytesUsed(c.geometry);
      dedupeSet.add(c.geometry);
    }
    if (c.material) {
      const material = c.material;
      for (const key in material) {
        const value = material[key];
        if (value && value.isTexture && !dedupeSet.has(value)) {
          const { format, type, image } = value;
          const { width, height } = image;
          const bytes = TextureUtils.getByteLength(width, height, format, type);
          totalBytes += value.generateMipmaps ? bytes * 4 / 3 : bytes;
          dedupeSet.add(value);
        }
      }
    }
  });
  return totalBytes;
}

// node_modules/3d-tiles-renderer/src/three/TilesRenderer.js
import { GLTFLoader as GLTFLoader3 } from "three/examples/jsm/loaders/GLTFLoader.js";
var _mat = new Matrix48();
var _euler2 = new Euler2();
var INITIAL_FRUSTUM_CULLED = /* @__PURE__ */ Symbol("INITIAL_FRUSTUM_CULLED");
var tempMat4 = new Matrix48();
var tempVector = new Vector311();
var tempVector2 = new Vector22();
var X_AXIS = new Vector311(1, 0, 0);
var Y_AXIS = new Vector311(0, 1, 0);
function updateFrustumCulled(object, toInitialValue) {
  object.traverse((c) => {
    c.frustumCulled = c[INITIAL_FRUSTUM_CULLED] && toInitialValue;
  });
}
var TilesRenderer = class extends TilesRendererBase {
  get autoDisableRendererCulling() {
    return this._autoDisableRendererCulling;
  }
  set autoDisableRendererCulling(value) {
    if (this._autoDisableRendererCulling !== value) {
      super._autoDisableRendererCulling = value;
      this.forEachLoadedModel((scene) => {
        updateFrustumCulled(scene, !value);
      });
    }
  }
  get optimizeRaycast() {
    return this._optimizeRaycast;
  }
  set optimizeRaycast(v) {
    console.warn('TilesRenderer: The "optimizeRaycast" option has been deprecated.');
    this._optimizeRaycast = v;
  }
  constructor(...args) {
    super(...args);
    this.group = new TilesGroup(this);
    this.ellipsoid = WGS84_ELLIPSOID.clone();
    this.cameras = [];
    this.cameraMap = /* @__PURE__ */ new Map();
    this.cameraInfo = [];
    this._optimizeRaycast = true;
    this._upRotationMatrix = new Matrix48();
    this.lruCache.computeMemoryUsageCallback = (tile) => tile.cached.bytesUsed ?? null;
    this._autoDisableRendererCulling = true;
    const manager = new LoadingManager();
    manager.setURLModifier((url) => {
      if (this.preprocessURL) {
        return this.preprocessURL(url);
      } else {
        return url;
      }
    });
    this.manager = manager;
    this._listeners = {};
  }
  addEventListener(...args) {
    EventDispatcher.prototype.addEventListener.call(this, ...args);
  }
  hasEventListener(...args) {
    EventDispatcher.prototype.hasEventListener.call(this, ...args);
  }
  removeEventListener(...args) {
    EventDispatcher.prototype.removeEventListener.call(this, ...args);
  }
  dispatchEvent(...args) {
    EventDispatcher.prototype.dispatchEvent.call(this, ...args);
  }
  /* Public API */
  getBoundingBox(target) {
    if (!this.root) {
      return false;
    }
    const boundingVolume = this.root.cached.boundingVolume;
    if (boundingVolume) {
      boundingVolume.getAABB(target);
      return true;
    } else {
      return false;
    }
  }
  getOrientedBoundingBox(targetBox, targetMatrix) {
    if (!this.root) {
      return false;
    }
    const boundingVolume = this.root.cached.boundingVolume;
    if (boundingVolume) {
      boundingVolume.getOBB(targetBox, targetMatrix);
      return true;
    } else {
      return false;
    }
  }
  getBoundingSphere(target) {
    if (!this.root) {
      return false;
    }
    const boundingVolume = this.root.cached.boundingVolume;
    if (boundingVolume) {
      boundingVolume.getSphere(target);
      return true;
    } else {
      return false;
    }
  }
  forEachLoadedModel(callback) {
    this.traverse((tile) => {
      const scene = tile.cached && tile.cached.scene;
      if (scene) {
        callback(scene, tile);
      }
    }, null, false);
  }
  raycast(raycaster, intersects) {
    if (!this.root) {
      return;
    }
    if (raycaster.firstHitOnly) {
      const hit = raycastTraverseFirstHit(this, this.root, raycaster);
      if (hit) {
        intersects.push(hit);
      }
    } else {
      raycastTraverse(this, this.root, raycaster, intersects);
    }
  }
  hasCamera(camera) {
    return this.cameraMap.has(camera);
  }
  setCamera(camera) {
    const cameras = this.cameras;
    const cameraMap = this.cameraMap;
    if (!cameraMap.has(camera)) {
      cameraMap.set(camera, new Vector22());
      cameras.push(camera);
      this.dispatchEvent({ type: "add-camera", camera });
      return true;
    }
    return false;
  }
  setResolution(camera, xOrVec, y) {
    const cameraMap = this.cameraMap;
    if (!cameraMap.has(camera)) {
      return false;
    }
    const width = xOrVec.isVector2 ? xOrVec.x : xOrVec;
    const height = xOrVec.isVector2 ? xOrVec.y : y;
    const cameraVec = cameraMap.get(camera);
    if (cameraVec.width !== width || cameraVec.height !== height) {
      cameraVec.set(width, height);
      this.dispatchEvent({ type: "camera-resolution-change" });
    }
    return true;
  }
  setResolutionFromRenderer(camera, renderer) {
    renderer.getSize(tempVector2).multiplyScalar(renderer.getPixelRatio());
    return this.setResolution(camera, tempVector2.x, tempVector2.y);
  }
  deleteCamera(camera) {
    const cameras = this.cameras;
    const cameraMap = this.cameraMap;
    if (cameraMap.has(camera)) {
      const index = cameras.indexOf(camera);
      cameras.splice(index, 1);
      cameraMap.delete(camera);
      this.dispatchEvent({ type: "delete-camera", camera });
      return true;
    }
    return false;
  }
  /* Overriden */
  loadRootTileSet(...args) {
    return super.loadRootTileSet(...args).then((root) => {
      const { asset, extensions = {} } = root;
      const upAxis = asset && asset.gltfUpAxis || "y";
      switch (upAxis.toLowerCase()) {
        case "x":
          this._upRotationMatrix.makeRotationAxis(Y_AXIS, -Math.PI / 2);
          break;
        case "y":
          this._upRotationMatrix.makeRotationAxis(X_AXIS, Math.PI / 2);
          break;
      }
      if ("3DTILES_ellipsoid" in extensions) {
        const ext = extensions["3DTILES_ellipsoid"];
        const { ellipsoid } = this;
        ellipsoid.name = ext.body;
        if (ext.radii) {
          ellipsoid.radius.set(...ext.radii);
        } else {
          ellipsoid.radius.set(1, 1, 1);
        }
      }
      this.dispatchEvent({ type: "load-content" });
      return root;
    });
  }
  update() {
    let needsUpdate = null;
    this.invokeAllPlugins((plugin) => {
      if (plugin.doTilesNeedUpdate) {
        const res = plugin.doTilesNeedUpdate();
        needsUpdate = needsUpdate === null ? res : needsUpdate || res;
      }
    });
    if (needsUpdate === false) {
      this.dispatchEvent({ type: "update-before" });
      this.dispatchEvent({ type: "update-after" });
      return;
    }
    this.dispatchEvent({ type: "update-before" });
    const group = this.group;
    const cameras = this.cameras;
    const cameraMap = this.cameraMap;
    const cameraInfo = this.cameraInfo;
    if (cameras.length === 0) {
      console.warn("TilesRenderer: no cameras defined. Cannot update 3d tiles.");
      return;
    }
    while (cameraInfo.length > cameras.length) {
      cameraInfo.pop();
    }
    while (cameraInfo.length < cameras.length) {
      cameraInfo.push({
        frustum: new ExtendedFrustum(),
        isOrthographic: false,
        sseDenominator: -1,
        // used if isOrthographic:false
        position: new Vector311(),
        invScale: -1,
        pixelSize: 0
        // used if isOrthographic:true
      });
    }
    tempVector.setFromMatrixScale(group.matrixWorldInverse);
    if (Math.abs(Math.max(tempVector.x - tempVector.y, tempVector.x - tempVector.z)) > 1e-6) {
      console.warn("ThreeTilesRenderer : Non uniform scale used for tile which may cause issues when calculating screen space error.");
    }
    for (let i = 0, l = cameraInfo.length; i < l; i++) {
      const camera = cameras[i];
      const info = cameraInfo[i];
      const frustum = info.frustum;
      const position = info.position;
      const resolution = cameraMap.get(camera);
      if (resolution.width === 0 || resolution.height === 0) {
        console.warn("TilesRenderer: resolution for camera error calculation is not set.");
      }
      const projection = camera.projectionMatrix.elements;
      info.isOrthographic = projection[15] === 1;
      if (info.isOrthographic) {
        const w = 2 / projection[0];
        const h = 2 / projection[5];
        info.pixelSize = Math.max(h / resolution.height, w / resolution.width);
      } else {
        info.sseDenominator = 2 / projection[5] / resolution.height;
      }
      tempMat4.copy(group.matrixWorld);
      tempMat4.premultiply(camera.matrixWorldInverse);
      tempMat4.premultiply(camera.projectionMatrix);
      frustum.setFromProjectionMatrix(tempMat4);
      position.set(0, 0, 0);
      position.applyMatrix4(camera.matrixWorld);
      position.applyMatrix4(group.matrixWorldInverse);
    }
    super.update();
    this.dispatchEvent({ type: "update-after" });
  }
  preprocessNode(tile, tileSetDir, parentTile = null) {
    super.preprocessNode(tile, tileSetDir, parentTile);
    const transform = new Matrix48();
    if (tile.transform) {
      const transformArr = tile.transform;
      for (let i = 0; i < 16; i++) {
        transform.elements[i] = transformArr[i];
      }
    }
    if (parentTile) {
      transform.premultiply(parentTile.cached.transform);
    }
    const transformInverse = new Matrix48().copy(transform).invert();
    const boundingVolume = new TileBoundingVolume();
    if ("sphere" in tile.boundingVolume) {
      boundingVolume.setSphereData(...tile.boundingVolume.sphere, transform);
    }
    if ("box" in tile.boundingVolume) {
      boundingVolume.setObbData(tile.boundingVolume.box, transform);
    }
    if ("region" in tile.boundingVolume) {
      boundingVolume.setRegionData(this.ellipsoid, ...tile.boundingVolume.region);
    }
    tile.cached = {
      transform,
      transformInverse,
      active: false,
      boundingVolume,
      metadata: null,
      scene: null,
      geometry: null,
      materials: null,
      textures: null
    };
  }
  async requestTileContents(...args) {
    await super.requestTileContents(...args);
    this.dispatchEvent({ type: "load-content" });
  }
  async parseTile(buffer, tile, extension, uri, abortSignal) {
    const cached = tile.cached;
    const uriSplits = uri.split(/[\\/]/g);
    uriSplits.pop();
    const workingPath = uriSplits.join("/");
    const fetchOptions = this.fetchOptions;
    const manager = this.manager;
    let promise = null;
    const cachedTransform = cached.transform;
    const upRotationMatrix = this._upRotationMatrix;
    const fileType = (readMagicBytes(buffer) || extension).toLowerCase();
    switch (fileType) {
      case "b3dm": {
        const loader = new B3DMLoader(manager);
        loader.workingPath = workingPath;
        loader.fetchOptions = fetchOptions;
        loader.adjustmentTransform.copy(upRotationMatrix);
        promise = loader.parse(buffer);
        break;
      }
      case "pnts": {
        const loader = new PNTSLoader(manager);
        loader.workingPath = workingPath;
        loader.fetchOptions = fetchOptions;
        promise = loader.parse(buffer);
        break;
      }
      case "i3dm": {
        const loader = new I3DMLoader(manager);
        loader.workingPath = workingPath;
        loader.fetchOptions = fetchOptions;
        loader.adjustmentTransform.copy(upRotationMatrix);
        loader.ellipsoid.copy(this.ellipsoid);
        promise = loader.parse(buffer);
        break;
      }
      case "cmpt": {
        const loader = new CMPTLoader(manager);
        loader.workingPath = workingPath;
        loader.fetchOptions = fetchOptions;
        loader.adjustmentTransform.copy(upRotationMatrix);
        loader.ellipsoid.copy(this.ellipsoid);
        promise = loader.parse(buffer).then((res) => res.scene);
        break;
      }
      // 3DTILES_content_gltf
      case "gltf":
      case "glb": {
        const loader = manager.getHandler("path.gltf") || manager.getHandler("path.glb") || new GLTFLoader3(manager);
        loader.setWithCredentials(fetchOptions.credentials === "include");
        loader.setRequestHeader(fetchOptions.headers || {});
        if (fetchOptions.credentials === "include" && fetchOptions.mode === "cors") {
          loader.setCrossOrigin("use-credentials");
        }
        let resourcePath = loader.resourcePath || loader.path || workingPath;
        if (!/[\\/]$/.test(resourcePath) && resourcePath.length) {
          resourcePath += "/";
        }
        promise = loader.parseAsync(buffer, resourcePath).then((result2) => {
          const { scene: scene2 } = result2;
          scene2.updateMatrix();
          scene2.matrix.multiply(upRotationMatrix).decompose(scene2.position, scene2.quaternion, scene2.scale);
          return result2;
        });
        break;
      }
      default: {
        promise = this.invokeOnePlugin((plugin) => plugin.parseToMesh && plugin.parseToMesh(buffer, tile, extension, uri, abortSignal));
        break;
      }
    }
    const result = await promise;
    if (result === null) {
      throw new Error(`TilesRenderer: Content type "${fileType}" not supported.`);
    }
    let scene;
    let metadata;
    if (result.isObject3D) {
      scene = result;
      metadata = null;
    } else {
      scene = result.scene;
      metadata = result;
    }
    await this.invokeAllPlugins((plugin) => {
      return plugin.processTileModel && plugin.processTileModel(scene, tile);
    });
    scene.updateMatrix();
    scene.matrix.premultiply(cachedTransform);
    scene.matrix.decompose(scene.position, scene.quaternion, scene.scale);
    scene.traverse((c) => {
      c[INITIAL_FRUSTUM_CULLED] = c.frustumCulled;
    });
    updateFrustumCulled(scene, !this.autoDisableRendererCulling);
    const materials = [];
    const geometry = [];
    const textures = [];
    scene.traverse((c) => {
      if (c.geometry) {
        geometry.push(c.geometry);
      }
      if (c.material) {
        const material = c.material;
        materials.push(c.material);
        for (const key in material) {
          const value = material[key];
          if (value && value.isTexture) {
            textures.push(value);
          }
        }
      }
    });
    if (abortSignal.aborted) {
      for (let i = 0, l = textures.length; i < l; i++) {
        const texture = textures[i];
        if (texture.image instanceof ImageBitmap) {
          texture.image.close();
        }
        texture.dispose();
      }
      return;
    }
    cached.materials = materials;
    cached.geometry = geometry;
    cached.textures = textures;
    cached.scene = scene;
    cached.metadata = metadata;
    cached.bytesUsed = estimateBytesUsed(scene);
  }
  disposeTile(tile) {
    super.disposeTile(tile);
    const cached = tile.cached;
    if (cached.scene) {
      const materials = cached.materials;
      const geometry = cached.geometry;
      const textures = cached.textures;
      const parent = cached.scene.parent;
      cached.scene.traverse((child) => {
        if (child.userData.meshFeatures) {
          child.userData.meshFeatures.dispose();
        }
        if (child.userData.structuralMetadata) {
          child.userData.structuralMetadata.dispose();
        }
      });
      for (let i = 0, l = geometry.length; i < l; i++) {
        geometry[i].dispose();
      }
      for (let i = 0, l = materials.length; i < l; i++) {
        materials[i].dispose();
      }
      for (let i = 0, l = textures.length; i < l; i++) {
        const texture = textures[i];
        if (texture.image instanceof ImageBitmap) {
          texture.image.close();
        }
        texture.dispose();
      }
      if (parent) {
        parent.remove(cached.scene);
      }
      this.dispatchEvent({
        type: "dispose-model",
        scene: cached.scene,
        tile
      });
      cached.scene = null;
      cached.materials = null;
      cached.textures = null;
      cached.geometry = null;
      cached.metadata = null;
    }
  }
  setTileVisible(tile, visible) {
    const scene = tile.cached.scene;
    const group = this.group;
    if (visible) {
      if (scene) {
        group.add(scene);
        scene.updateMatrixWorld(true);
      }
    } else {
      if (scene) {
        group.remove(scene);
      }
    }
    super.setTileVisible(tile, visible);
    this.dispatchEvent({
      type: "tile-visibility-change",
      scene,
      tile,
      visible
    });
  }
  calculateError(tile) {
    const cached = tile.cached;
    const cameras = this.cameras;
    const cameraInfo = this.cameraInfo;
    const boundingVolume = cached.boundingVolume;
    let maxError = -Infinity;
    let minDistance = Infinity;
    for (let i = 0, l = cameras.length; i < l; i++) {
      const info = cameraInfo[i];
      let error;
      if (info.isOrthographic) {
        const pixelSize = info.pixelSize;
        error = tile.geometricError / pixelSize;
      } else {
        const distance = boundingVolume.distanceToPoint(info.position);
        const sseDenominator = info.sseDenominator;
        error = tile.geometricError / (distance * sseDenominator);
        minDistance = Math.min(minDistance, distance);
      }
      maxError = Math.max(maxError, error);
    }
    this.invokeAllPlugins((plugin) => {
      if (plugin !== this && plugin.calculateError) {
        maxError = Math.max(maxError, plugin.calculateError(tile) || 0);
      }
    });
    tile.__distanceFromCamera = minDistance;
    tile.__error = maxError;
  }
  tileInView(tile) {
    let inView = false;
    this.invokeAllPlugins((plugin) => {
      inView = inView || plugin !== this && plugin.tileInView && plugin.tileInView(tile);
    });
    if (inView) {
      return true;
    }
    const cached = tile.cached;
    const boundingVolume = cached.boundingVolume;
    const cameraInfo = this.cameraInfo;
    for (let i = 0, l = cameraInfo.length; i < l; i++) {
      const frustum = cameraInfo[i].frustum;
      if (boundingVolume.intersectsFrustum(frustum)) {
        return true;
      }
    }
    return false;
  }
  // TODO: deprecate this function and provide a plugin to help with this
  // adjust the rotation of the group such that Y is altitude, X is North, and Z is East
  setLatLonToYUp(lat, lon) {
    console.warn("TilesRenderer: setLatLonToYUp is deprecated. Use the ReorientationPlugin, instead.");
    const { ellipsoid, group } = this;
    _euler2.set(Math.PI / 2, Math.PI / 2, 0);
    _mat.makeRotationFromEuler(_euler2);
    ellipsoid.getEastNorthUpFrame(lat, lon, group.matrix).multiply(_mat).invert().decompose(
      group.position,
      group.quaternion,
      group.scale
    );
    group.updateMatrixWorld(true);
  }
  dispose() {
    super.dispose();
    this.group.removeFromParent();
  }
};

// node_modules/3d-tiles-renderer/src/three/controls/GlobeControls.js
import {
  Matrix4 as Matrix411,
  Quaternion as Quaternion3,
  Vector2 as Vector26,
  Vector3 as Vector314,
  MathUtils as MathUtils6,
  Ray as Ray6
} from "three";

// node_modules/3d-tiles-renderer/src/three/controls/EnvironmentControls.js
import {
  Matrix4 as Matrix410,
  Quaternion as Quaternion2,
  Vector2 as Vector25,
  Vector3 as Vector313,
  Raycaster,
  Plane as Plane2,
  EventDispatcher as EventDispatcher2,
  MathUtils as MathUtils5,
  Clock,
  Ray as Ray5
} from "three";

// node_modules/3d-tiles-renderer/src/three/controls/PivotPointMesh.js
import { Mesh, PlaneGeometry, ShaderMaterial, Vector2 as Vector23 } from "three";
var PivotPointMesh = class extends Mesh {
  constructor() {
    super(new PlaneGeometry(0, 0), new PivotMaterial());
    this.renderOrder = Infinity;
  }
  onBeforeRender(renderer) {
    const uniforms = this.material.uniforms;
    renderer.getSize(uniforms.resolution.value);
  }
  updateMatrixWorld() {
    this.matrixWorld.makeTranslation(this.position);
  }
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
};
var PivotMaterial = class extends ShaderMaterial {
  constructor() {
    super({
      depthWrite: false,
      depthTest: false,
      transparent: true,
      uniforms: {
        resolution: { value: new Vector23() },
        size: { value: 15 },
        thickness: { value: 2 },
        opacity: { value: 1 }
      },
      vertexShader: (
        /* glsl */
        `

				uniform float pixelRatio;
				uniform float size;
				uniform float thickness;
				uniform vec2 resolution;
				varying vec2 vUv;

				void main() {

					vUv = uv;

					float aspect = resolution.x / resolution.y;
					vec2 offset = uv * 2.0 - vec2( 1.0 );
					offset.y *= aspect;

					vec4 screenPoint = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
					screenPoint.xy += offset * ( size + thickness ) * screenPoint.w / resolution.x;

					gl_Position = screenPoint;

				}
			`
      ),
      fragmentShader: (
        /* glsl */
        `

				uniform float size;
				uniform float thickness;
				uniform float opacity;

				varying vec2 vUv;
				void main() {

					float ht = 0.5 * thickness;
					float planeDim = size + thickness;
					float offset = ( planeDim - ht - 2.0 ) / planeDim;
					float texelThickness = ht / planeDim;

					vec2 vec = vUv * 2.0 - vec2( 1.0 );
					float dist = abs( length( vec ) - offset );
					float fw = fwidth( dist ) * 0.5;
					float a = smoothstep( texelThickness - fw, texelThickness + fw, dist );

					gl_FragColor = vec4( 1, 1, 1, opacity * ( 1.0 - a ) );

				}
			`
      )
    });
  }
};

// node_modules/3d-tiles-renderer/src/three/controls/PointerTracker.js
import { Vector2 as Vector24 } from "three";
var _vec4 = new Vector24();
var _vec23 = new Vector24();
var PointerTracker = class {
  constructor() {
    this.domElement = null;
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.pointerSetThisFrame = {};
    this.hoverPosition = new Vector24();
    this.hoverSet = false;
  }
  reset() {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.pointerSetThisFrame = {};
    this.hoverPosition = new Vector24();
    this.hoverSet = false;
  }
  // The pointers can be set multiple times per frame so track whether the pointer has
  // been set this frame or not so we don't overwrite the previous position and lose information
  // about pointer movement
  updateFrame() {
    const { previousPositions, pointerPositions } = this;
    for (const id in pointerPositions) {
      previousPositions[id].copy(pointerPositions[id]);
    }
  }
  setHoverEvent(e) {
    if (e.pointerType === "mouse" || e.type === "wheel") {
      this.getAdjustedPointer(e, this.hoverPosition);
      this.hoverSet = true;
    }
  }
  getLatestPoint(target) {
    if (this.pointerType !== null) {
      this.getCenterPoint(target);
      return target;
    } else if (this.hoverSet) {
      target.copy(this.hoverPosition);
      return target;
    } else {
      return null;
    }
  }
  // get the pointer position in the coordinate system of the target element
  getAdjustedPointer(e, target) {
    const domRef = this.domElement ? this.domElement : e.target;
    const rect = domRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    target.set(x, y);
  }
  addPointer(e) {
    const id = e.pointerId;
    const position = new Vector24();
    this.getAdjustedPointer(e, position);
    this.pointerOrder.push(id);
    this.pointerPositions[id] = position;
    this.previousPositions[id] = position.clone();
    this.startPositions[id] = position.clone();
    if (this.getPointerCount() === 1) {
      this.pointerType = e.pointerType;
      this.buttons = e.buttons;
    }
  }
  updatePointer(e) {
    const id = e.pointerId;
    if (!(id in this.pointerPositions)) {
      return false;
    }
    this.getAdjustedPointer(e, this.pointerPositions[id]);
    return true;
  }
  deletePointer(e) {
    const id = e.pointerId;
    const pointerOrder = this.pointerOrder;
    pointerOrder.splice(pointerOrder.indexOf(id), 1);
    delete this.pointerPositions[id];
    delete this.previousPositions[id];
    delete this.startPositions[id];
    if (this.getPointerCount.length === 0) {
      this.buttons = 0;
      this.pointerType = null;
    }
  }
  getPointerCount() {
    return this.pointerOrder.length;
  }
  getCenterPoint(target, pointerPositions = this.pointerPositions) {
    const pointerOrder = this.pointerOrder;
    if (this.getPointerCount() === 1 || this.getPointerType() === "mouse") {
      const id = pointerOrder[0];
      target.copy(pointerPositions[id]);
      return target;
    } else if (this.getPointerCount() === 2) {
      const id0 = this.pointerOrder[0];
      const id1 = this.pointerOrder[1];
      const p0 = pointerPositions[id0];
      const p1 = pointerPositions[id1];
      target.addVectors(p0, p1).multiplyScalar(0.5);
      return target;
    }
    return null;
  }
  getPreviousCenterPoint(target) {
    return this.getCenterPoint(target, this.previousPositions);
  }
  getStartCenterPoint(target) {
    return this.getCenterPoint(target, this.startPositions);
  }
  getMoveDistance() {
    this.getCenterPoint(_vec4);
    this.getPreviousCenterPoint(_vec23);
    return _vec4.sub(_vec23).length();
  }
  getTouchPointerDistance(pointerPositions = this.pointerPositions) {
    if (this.getPointerCount() <= 1 || this.getPointerType() === "mouse") {
      return 0;
    }
    const { pointerOrder } = this;
    const id0 = pointerOrder[0];
    const id1 = pointerOrder[1];
    const p0 = pointerPositions[id0];
    const p1 = pointerPositions[id1];
    return p0.distanceTo(p1);
  }
  getPreviousTouchPointerDistance() {
    return this.getTouchPointerDistance(this.previousPositions);
  }
  getStartTouchPointerDistance() {
    return this.getTouchPointerDistance(this.startPositions);
  }
  getPointerType() {
    return this.pointerType;
  }
  isPointerTouch() {
    return this.getPointerType() === "touch";
  }
  getPointerButtons() {
    return this.buttons;
  }
  isLeftClicked() {
    return Boolean(this.buttons & 1);
  }
  isRightClicked() {
    return Boolean(this.buttons & 2);
  }
};

// node_modules/3d-tiles-renderer/src/three/controls/utils.js
import { Matrix4 as Matrix49, Ray as Ray4, Vector3 as Vector312 } from "three";
var _matrix3 = new Matrix49();
var _ray3 = new Ray4();
var _vec5 = new Vector312();
function makeRotateAroundPoint(point, quat, target) {
  target.makeTranslation(-point.x, -point.y, -point.z);
  _matrix3.makeRotationFromQuaternion(quat);
  target.premultiply(_matrix3);
  _matrix3.makeTranslation(point.x, point.y, point.z);
  target.premultiply(_matrix3);
  return target;
}
function mouseToCoords(clientX, clientY, element, target) {
  target.x = (clientX - element.offsetLeft) / element.clientWidth * 2 - 1;
  target.y = -((clientY - element.offsetTop) / element.clientHeight) * 2 + 1;
  if (target.isVector3) {
    target.z = 0;
  }
}
function closestRayEllipsoidSurfacePointEstimate(ray, ellipsoid, target) {
  if (ellipsoid.intersectRay(ray, target)) {
    return target;
  } else {
    _matrix3.makeScale(...ellipsoid.radius).invert();
    _ray3.copy(ray).applyMatrix4(_matrix3);
    _vec5.set(0, 0, 0);
    _ray3.closestPointToPoint(_vec5, target).normalize();
    _matrix3.makeScale(...ellipsoid.radius);
    return target.applyMatrix4(_matrix3);
  }
}
function closestRaySpherePointFromRotation(ray, radius, target) {
  const hypotenuse = ray.origin.length();
  const theta = Math.acos(radius / hypotenuse);
  target.copy(ray.origin).multiplyScalar(-1).normalize();
  const rotationVec = _vec5.crossVectors(target, ray.direction).normalize();
  target.multiplyScalar(-1).applyAxisAngle(rotationVec, -theta).normalize().multiplyScalar(radius);
}
function setRaycasterFromCamera(raycaster, coords, camera) {
  const ray = raycaster instanceof Ray4 ? raycaster : raycaster.ray;
  const { origin, direction } = ray;
  origin.set(coords.x, coords.y, -1).unproject(camera);
  direction.set(coords.x, coords.y, 1).unproject(camera).sub(origin);
  if (!raycaster.isRay) {
    raycaster.near = 0;
    raycaster.far = direction.length();
    raycaster.camera = camera;
  }
  direction.normalize();
}

// node_modules/3d-tiles-renderer/src/three/controls/EnvironmentControls.js
var NONE = 0;
var DRAG = 1;
var ROTATE = 2;
var ZOOM = 3;
var WAITING = 4;
var DRAG_PLANE_THRESHOLD = 0.05;
var DRAG_UP_THRESHOLD = 0.025;
var _rotMatrix = /* @__PURE__ */ new Matrix410();
var _delta = /* @__PURE__ */ new Vector313();
var _vec6 = /* @__PURE__ */ new Vector313();
var _forward = /* @__PURE__ */ new Vector313();
var _right = /* @__PURE__ */ new Vector313();
var _rotationAxis = /* @__PURE__ */ new Vector313();
var _quaternion = /* @__PURE__ */ new Quaternion2();
var _plane = /* @__PURE__ */ new Plane2();
var _localUp = /* @__PURE__ */ new Vector313();
var _mouseBefore = /* @__PURE__ */ new Vector313();
var _mouseAfter = /* @__PURE__ */ new Vector313();
var _identityQuat = /* @__PURE__ */ new Quaternion2();
var _ray4 = /* @__PURE__ */ new Ray5();
var _zoomPointPointer = /* @__PURE__ */ new Vector25();
var _pointer = /* @__PURE__ */ new Vector25();
var _prevPointer = /* @__PURE__ */ new Vector25();
var _deltaPointer = /* @__PURE__ */ new Vector25();
var _centerPoint = /* @__PURE__ */ new Vector25();
var _startCenterPoint = /* @__PURE__ */ new Vector25();
var _changeEvent = { type: "change" };
var _startEvent = { type: "start" };
var _endEvent = { type: "end" };
var EnvironmentControls = class extends EventDispatcher2 {
  get enabled() {
    return this._enabled;
  }
  set enabled(v) {
    if (v !== this.enabled) {
      this._enabled = v;
      this.resetState();
      this.pointerTracker.reset();
      if (!this.enabled) {
        this.dragInertia.set(0, 0, 0);
        this.rotationInertia.set(0, 0);
      }
    }
  }
  constructor(scene = null, camera = null, domElement = null, tilesRenderer = null) {
    super();
    this.isEnvironmentControls = true;
    this.domElement = null;
    this.camera = null;
    this.scene = null;
    this.tilesRenderer = null;
    this._enabled = true;
    this.cameraRadius = 5;
    this.rotationSpeed = 1;
    this.minAltitude = 0;
    this.maxAltitude = 0.45 * Math.PI;
    this.minDistance = 10;
    this.maxDistance = Infinity;
    this.minZoom = 0;
    this.maxZoom = Infinity;
    this.zoomSpeed = 1;
    this.adjustHeight = true;
    this.enableDamping = false;
    this.dampingFactor = 0.15;
    this.reorientOnDrag = true;
    this.scaleZoomOrientationAtEdges = false;
    this.state = NONE;
    this.pointerTracker = new PointerTracker();
    this.needsUpdate = false;
    this.actionHeightOffset = 0;
    this.pivotPoint = new Vector313();
    this.zoomDirectionSet = false;
    this.zoomPointSet = false;
    this.zoomDirection = new Vector313();
    this.zoomPoint = new Vector313();
    this.zoomDelta = 0;
    this.rotationInertiaPivot = new Vector313();
    this.rotationInertia = new Vector25();
    this.dragInertia = new Vector313();
    this.inertiaTargetDistance = Infinity;
    this.inertiaStableFrames = 0;
    this.pivotMesh = new PivotPointMesh();
    this.pivotMesh.raycast = () => {
    };
    this.pivotMesh.scale.setScalar(0.25);
    this.raycaster = new Raycaster();
    this.raycaster.firstHitOnly = true;
    this.up = new Vector313(0, 1, 0);
    this.clock = new Clock();
    this.fallbackPlane = new Plane2(new Vector313(0, 1, 0), 0);
    this.useFallbackPlane = true;
    this._detachCallback = null;
    this._upInitialized = false;
    this._lastUsedState = NONE;
    this._zoomPointWasSet = false;
    this._tilesOnChangeCallback = () => this.zoomPointSet = false;
    if (domElement) this.attach(domElement);
    if (camera) this.setCamera(camera);
    if (scene) this.setScene(scene);
    if (tilesRenderer) this.setTilesRenderer(tilesRenderer);
  }
  setScene(scene) {
    this.scene = scene;
  }
  setCamera(camera) {
    this.camera = camera;
    this._upInitialized = false;
    this.zoomDirectionSet = false;
    this.zoomPointSet = false;
    this.needsUpdate = true;
    this.raycaster.camera = camera;
    this.resetState();
  }
  setTilesRenderer(tilesRenderer) {
    if (this.tilesRenderer) {
      this.tilesRenderer.removeEventListener("tile-visibility-change", this._tilesOnChangeCallback);
    }
    this.tilesRenderer = tilesRenderer;
    if (this.tilesRenderer !== null) {
      this.tilesRenderer.addEventListener("tile-visibility-change", this._tilesOnChangeCallback);
      if (this.scene === null) {
        this.setScene(this.tilesRenderer.group);
      }
    }
  }
  attach(domElement) {
    if (this.domElement) {
      throw new Error("EnvironmentControls: Controls already attached to element");
    }
    this.domElement = domElement;
    this.pointerTracker.domElement = domElement;
    domElement.style.touchAction = "none";
    let shiftClicked = false;
    const contextMenuCallback = (e) => {
      e.preventDefault();
    };
    const keydownCallback = (e) => {
      if (e.key === "Shift") {
        shiftClicked = true;
      }
    };
    const keyupCallback = (e) => {
      if (e.key === "Shift") {
        shiftClicked = false;
      }
    };
    const pointerdownCallback = (e) => {
      e.preventDefault();
      const {
        camera,
        raycaster,
        domElement: domElement2,
        up,
        pivotMesh,
        pointerTracker,
        scene,
        pivotPoint,
        enabled
      } = this;
      pointerTracker.addPointer(e);
      this.needsUpdate = true;
      if (pointerTracker.isPointerTouch()) {
        pivotMesh.visible = false;
        if (pointerTracker.getPointerCount() === 0) {
          domElement2.setPointerCapture(e.pointerId);
        } else if (pointerTracker.getPointerCount() > 2) {
          this.resetState();
          return;
        }
      }
      pointerTracker.getCenterPoint(_pointer);
      mouseToCoords(_pointer.x, _pointer.y, domElement2, _pointer);
      setRaycasterFromCamera(raycaster, _pointer, camera);
      const dot = Math.abs(raycaster.ray.direction.dot(up));
      if (dot < DRAG_PLANE_THRESHOLD || dot < DRAG_UP_THRESHOLD) {
        return;
      }
      const hit = this._raycast(raycaster);
      if (hit) {
        if (pointerTracker.getPointerCount() === 2 || pointerTracker.isRightClicked() || pointerTracker.isLeftClicked() && shiftClicked) {
          this.setState(pointerTracker.isPointerTouch() ? WAITING : ROTATE);
          pivotPoint.copy(hit.point);
          pivotMesh.position.copy(hit.point);
          pivotMesh.visible = pointerTracker.isPointerTouch() ? false : enabled;
          pivotMesh.updateMatrixWorld();
          scene.add(pivotMesh);
        } else if (pointerTracker.isLeftClicked()) {
          this.setState(DRAG);
          pivotPoint.copy(hit.point);
          pivotMesh.position.copy(hit.point);
          pivotMesh.updateMatrixWorld();
          scene.add(pivotMesh);
        }
      }
    };
    let _pointerMoveQueued = false;
    const pointermoveCallback = (e) => {
      e.preventDefault();
      const {
        pivotMesh,
        enabled
      } = this;
      this.zoomDirectionSet = false;
      this.zoomPointSet = false;
      if (this.state !== NONE) {
        this.needsUpdate = true;
      }
      const { pointerTracker } = this;
      pointerTracker.setHoverEvent(e);
      if (!pointerTracker.updatePointer(e)) {
        return;
      }
      if (pointerTracker.isPointerTouch() && pointerTracker.getPointerCount() === 2) {
        if (!_pointerMoveQueued) {
          _pointerMoveQueued = true;
          queueMicrotask(() => {
            _pointerMoveQueued = false;
            pointerTracker.getCenterPoint(_centerPoint);
            const startDist = pointerTracker.getStartTouchPointerDistance();
            const pointerDist = pointerTracker.getTouchPointerDistance();
            const separateDelta = pointerDist - startDist;
            if (this.state === NONE || this.state === WAITING) {
              pointerTracker.getCenterPoint(_centerPoint);
              pointerTracker.getStartCenterPoint(_startCenterPoint);
              const dragThreshold = 2 * window.devicePixelRatio;
              const parallelDelta = _centerPoint.distanceTo(_startCenterPoint);
              if (Math.abs(separateDelta) > dragThreshold || parallelDelta > dragThreshold) {
                if (Math.abs(separateDelta) > parallelDelta) {
                  this.setState(ZOOM);
                  this.zoomDirectionSet = false;
                } else {
                  this.setState(ROTATE);
                }
              }
            }
            if (this.state === ZOOM) {
              const previousDist = pointerTracker.getPreviousTouchPointerDistance();
              this.zoomDelta += pointerDist - previousDist;
              pivotMesh.visible = false;
            } else if (this.state === ROTATE) {
              pivotMesh.visible = enabled;
            }
          });
        }
      }
      this.dispatchEvent(_changeEvent);
    };
    const pointerupCallback = (e) => {
      const { pointerTracker } = this;
      pointerTracker.deletePointer(e);
      if (pointerTracker.getPointerType() === "touch" && pointerTracker.getPointerCount() === 0) {
        domElement.releasePointerCapture(e.pointerId);
      }
      this.resetState();
      this.needsUpdate = true;
    };
    const wheelCallback = (e) => {
      e.preventDefault();
      const { pointerTracker } = this;
      pointerTracker.setHoverEvent(e);
      pointerTracker.updatePointer(e);
      this.dispatchEvent(_startEvent);
      let delta;
      switch (e.deltaMode) {
        case 2:
          delta = e.deltaY * 800;
          break;
        case 1:
          delta = e.deltaY * 40;
          break;
        case 0:
          delta = e.deltaY;
          break;
      }
      const deltaSign = Math.sign(delta);
      const normalizedDelta = Math.abs(delta);
      this.zoomDelta -= 0.25 * deltaSign * normalizedDelta;
      this.needsUpdate = true;
      this._lastUsedState = ZOOM;
      this.dispatchEvent(_endEvent);
    };
    const pointerenterCallback = (e) => {
      const { pointerTracker } = this;
      shiftClicked = false;
      if (e.buttons !== pointerTracker.getPointerButtons()) {
        pointerTracker.deletePointer(e);
        this.resetState();
      }
    };
    domElement.addEventListener("contextmenu", contextMenuCallback);
    domElement.addEventListener("keydown", keydownCallback);
    domElement.addEventListener("keyup", keyupCallback);
    domElement.addEventListener("pointerdown", pointerdownCallback);
    domElement.addEventListener("pointermove", pointermoveCallback);
    domElement.addEventListener("pointerup", pointerupCallback);
    domElement.addEventListener("wheel", wheelCallback, { passive: false });
    domElement.addEventListener("pointerenter", pointerenterCallback);
    this._detachCallback = () => {
      domElement.removeEventListener("contextmenu", contextMenuCallback);
      domElement.removeEventListener("keydown", keydownCallback);
      domElement.removeEventListener("keyup", keyupCallback);
      domElement.removeEventListener("pointerdown", pointerdownCallback);
      domElement.removeEventListener("pointermove", pointermoveCallback);
      domElement.removeEventListener("pointerup", pointerupCallback);
      domElement.removeEventListener("wheel", wheelCallback);
      domElement.removeEventListener("pointerenter", pointerenterCallback);
    };
  }
  // override-able functions for retrieving the up direction at a point
  getUpDirection(point, target) {
    target.copy(this.up);
  }
  getCameraUpDirection(target) {
    this.getUpDirection(this.camera.position, target);
  }
  // returns the active / last used pivot point for the scene
  getPivotPoint(target) {
    let result = null;
    if (this._lastUsedState === ZOOM) {
      if (this._zoomPointWasSet) {
        result = target.copy(this.zoomPoint);
      }
    } else if (this._lastUsedState === ROTATE || this._lastUsedState === DRAG) {
      result = target.copy(this.pivotPoint);
    }
    const { camera, raycaster } = this;
    if (result !== null) {
      _vec6.copy(result).project(camera);
      if (_vec6.x < -1 || _vec6.x > 1 || _vec6.y < -1 || _vec6.y > 1) {
        result = null;
      }
    }
    setRaycasterFromCamera(raycaster, { x: 0, y: 0 }, camera);
    const hit = this._raycast(raycaster);
    if (hit) {
      if (result === null || hit.distance < result.distanceTo(raycaster.ray.origin)) {
        result = target.copy(hit.point);
      }
    }
    return result;
  }
  detach() {
    this.domElement = null;
    if (this._detachCallback) {
      this._detachCallback();
      this._detachCallback = null;
      this.pointerTracker.reset();
    }
  }
  resetState() {
    if (this.state !== NONE) {
      this.dispatchEvent(_endEvent);
    }
    this.state = NONE;
    this.pivotMesh.removeFromParent();
    this.pivotMesh.visible = this.enabled;
    this.actionHeightOffset = 0;
  }
  setState(state = this.state, fireEvent = true) {
    if (this.state === state) {
      return;
    }
    if (this.state === NONE && fireEvent) {
      this.dispatchEvent(_startEvent);
    }
    this.pivotMesh.visible = this.enabled;
    this.dragInertia.set(0, 0, 0);
    this.rotationInertia.set(0, 0);
    this.inertiaStableFrames = 0;
    this.state = state;
    if (state !== NONE && state !== WAITING) {
      this._lastUsedState = state;
    }
  }
  update(deltaTime = Math.min(this.clock.getDelta(), 64 / 1e3)) {
    if (!this.enabled || !this.camera || deltaTime === 0) {
      return;
    }
    const {
      camera,
      cameraRadius,
      pivotPoint,
      up,
      state,
      adjustHeight
    } = this;
    camera.updateMatrixWorld();
    this.getCameraUpDirection(_localUp);
    if (!this._upInitialized) {
      this._upInitialized = true;
      this.up.copy(_localUp);
    }
    const inertiaNeedsUpdate = this._inertiaNeedsUpdate();
    if (this.needsUpdate || inertiaNeedsUpdate) {
      const zoomDelta = this.zoomDelta;
      this._updateZoom();
      this._updatePosition(deltaTime);
      this._updateRotation(deltaTime);
      if (state === DRAG || state === ROTATE) {
        _forward.set(0, 0, -1).transformDirection(camera.matrixWorld);
        this.inertiaTargetDistance = _vec6.copy(this.pivotPoint).sub(camera.position).dot(_forward);
      } else if (state === NONE) {
        this._updateInertia(deltaTime);
      }
      if (state !== NONE || zoomDelta !== 0 || inertiaNeedsUpdate) {
        this.dispatchEvent(_changeEvent);
      }
      this.needsUpdate = false;
    }
    const hit = camera.isOrthographicCamera ? null : adjustHeight && this._getPointBelowCamera() || null;
    const rotationPoint = camera.isOrthographicCamera ? pivotPoint : hit && hit.point || null;
    this.getCameraUpDirection(_localUp);
    this._setFrame(_localUp, rotationPoint);
    if ((this.state === DRAG || this.state === ROTATE) && this.actionHeightOffset !== 0) {
      const { actionHeightOffset } = this;
      camera.position.addScaledVector(up, -actionHeightOffset);
      pivotPoint.addScaledVector(up, -actionHeightOffset);
      if (hit) {
        hit.distance -= actionHeightOffset;
      }
    }
    this.actionHeightOffset = 0;
    if (hit) {
      const dist = hit.distance;
      if (dist < cameraRadius) {
        const delta = cameraRadius - dist;
        camera.position.addScaledVector(up, delta);
        pivotPoint.addScaledVector(up, delta);
        this.actionHeightOffset = delta;
      }
    }
    this.pointerTracker.updateFrame();
  }
  // updates the camera to position it based on the constraints of the controls
  adjustCamera(camera) {
    const { adjustHeight, cameraRadius } = this;
    if (camera.isPerspectiveCamera) {
      this.getUpDirection(camera.position, _localUp);
      const hit = adjustHeight && this._getPointBelowCamera(camera.position, _localUp) || null;
      if (hit) {
        const dist = hit.distance;
        if (dist < cameraRadius) {
          camera.position.addScaledVector(_localUp, cameraRadius - dist);
        }
      }
    }
  }
  dispose() {
    this.detach();
  }
  // private
  _updateInertia(deltaTime) {
    const {
      rotationInertia,
      pivotPoint,
      dragInertia,
      enableDamping,
      dampingFactor,
      camera,
      cameraRadius,
      minDistance,
      inertiaTargetDistance
    } = this;
    if (!this.enableDamping || this.inertiaStableFrames > 1) {
      dragInertia.set(0, 0, 0);
      rotationInertia.set(0, 0, 0);
      return;
    }
    const factor = Math.pow(2, -deltaTime / dampingFactor);
    const stableDistance = Math.max(camera.near, cameraRadius, minDistance, inertiaTargetDistance);
    const resolution = 2 * 1e3;
    const pixelWidth = 2 / resolution;
    const pixelThreshold = 0.25 * pixelWidth;
    if (rotationInertia.lengthSq() > 0) {
      setRaycasterFromCamera(_ray4, _vec6.set(0, 0, -1), camera);
      _ray4.applyMatrix4(camera.matrixWorldInverse);
      _ray4.direction.normalize();
      _ray4.recast(-_ray4.direction.dot(_ray4.origin)).at(stableDistance / _ray4.direction.z, _vec6);
      _vec6.applyMatrix4(camera.matrixWorld);
      setRaycasterFromCamera(_ray4, _delta.set(pixelThreshold, pixelThreshold, -1), camera);
      _ray4.applyMatrix4(camera.matrixWorldInverse);
      _ray4.direction.normalize();
      _ray4.recast(-_ray4.direction.dot(_ray4.origin)).at(stableDistance / _ray4.direction.z, _delta);
      _delta.applyMatrix4(camera.matrixWorld);
      _vec6.sub(pivotPoint).normalize();
      _delta.sub(pivotPoint).normalize();
      const threshold = _vec6.angleTo(_delta) / deltaTime;
      rotationInertia.multiplyScalar(factor);
      if (rotationInertia.lengthSq() < threshold ** 2 || !enableDamping) {
        rotationInertia.set(0, 0);
      }
    }
    if (dragInertia.lengthSq() > 0) {
      setRaycasterFromCamera(_ray4, _vec6.set(0, 0, -1), camera);
      _ray4.applyMatrix4(camera.matrixWorldInverse);
      _ray4.direction.normalize();
      _ray4.recast(-_ray4.direction.dot(_ray4.origin)).at(stableDistance / _ray4.direction.z, _vec6);
      _vec6.applyMatrix4(camera.matrixWorld);
      setRaycasterFromCamera(_ray4, _delta.set(pixelThreshold, pixelThreshold, -1), camera);
      _ray4.applyMatrix4(camera.matrixWorldInverse);
      _ray4.direction.normalize();
      _ray4.recast(-_ray4.direction.dot(_ray4.origin)).at(stableDistance / _ray4.direction.z, _delta);
      _delta.applyMatrix4(camera.matrixWorld);
      const threshold = _vec6.distanceTo(_delta) / deltaTime;
      dragInertia.multiplyScalar(factor);
      if (dragInertia.lengthSq() < threshold ** 2 || !enableDamping) {
        dragInertia.set(0, 0, 0);
      }
    }
    if (rotationInertia.lengthSq() > 0) {
      this._applyRotation(rotationInertia.x * deltaTime, rotationInertia.y * deltaTime, pivotPoint);
    }
    if (dragInertia.lengthSq() > 0) {
      camera.position.addScaledVector(dragInertia, deltaTime);
      camera.updateMatrixWorld();
    }
  }
  _inertiaNeedsUpdate() {
    const { rotationInertia, dragInertia } = this;
    return rotationInertia.lengthSq() !== 0 || dragInertia.lengthSq() !== 0;
  }
  _updateZoom() {
    const {
      zoomPoint,
      zoomDirection,
      camera,
      minDistance,
      maxDistance,
      pointerTracker,
      domElement,
      minZoom,
      maxZoom,
      zoomSpeed,
      state
    } = this;
    let scale = this.zoomDelta;
    this.zoomDelta = 0;
    if (!pointerTracker.getLatestPoint(_pointer) || scale === 0 && state !== ZOOM) {
      return;
    }
    this.rotationInertia.set(0, 0);
    this.dragInertia.set(0, 0, 0);
    if (camera.isOrthographicCamera) {
      this._updateZoomDirection();
      const zoomIntoPoint = this.zoomPointSet || this._updateZoomPoint();
      _mouseBefore.unproject(camera);
      const normalizedDelta = Math.pow(0.95, Math.abs(scale * 0.05));
      let scaleFactor = scale > 0 ? 1 / Math.abs(normalizedDelta) : normalizedDelta;
      scaleFactor *= zoomSpeed;
      if (scaleFactor > 1) {
        if (maxZoom < camera.zoom * scaleFactor) {
          scaleFactor = 1;
        }
      } else {
        if (minZoom > camera.zoom * scaleFactor) {
          scaleFactor = 1;
        }
      }
      camera.zoom *= scaleFactor;
      camera.updateProjectionMatrix();
      if (zoomIntoPoint) {
        mouseToCoords(_pointer.x, _pointer.y, domElement, _mouseAfter);
        _mouseAfter.unproject(camera);
        camera.position.sub(_mouseAfter).add(_mouseBefore);
        camera.updateMatrixWorld();
      }
    } else {
      this._updateZoomDirection();
      const finalZoomDirection = _vec6.copy(zoomDirection);
      if (this.zoomPointSet || this._updateZoomPoint()) {
        const dist = zoomPoint.distanceTo(camera.position);
        if (scale < 0) {
          const remainingDistance = Math.min(0, dist - maxDistance);
          scale = scale * dist * zoomSpeed * 25e-4;
          scale = Math.max(scale, remainingDistance);
        } else {
          const remainingDistance = Math.max(0, dist - minDistance);
          scale = scale * Math.max(dist - minDistance, 0) * zoomSpeed * 25e-4;
          scale = Math.min(scale, remainingDistance);
        }
        camera.position.addScaledVector(zoomDirection, scale);
        camera.updateMatrixWorld();
      } else {
        const hit = this._getPointBelowCamera();
        if (hit) {
          const dist = hit.distance;
          finalZoomDirection.set(0, 0, -1).transformDirection(camera.matrixWorld);
          camera.position.addScaledVector(finalZoomDirection, scale * dist * 0.01);
          camera.updateMatrixWorld();
        }
      }
    }
  }
  _updateZoomDirection() {
    if (this.zoomDirectionSet) {
      return;
    }
    const { domElement, raycaster, camera, zoomDirection, pointerTracker } = this;
    pointerTracker.getLatestPoint(_pointer);
    mouseToCoords(_pointer.x, _pointer.y, domElement, _mouseBefore);
    setRaycasterFromCamera(raycaster, _mouseBefore, camera);
    zoomDirection.copy(raycaster.ray.direction).normalize();
    this.zoomDirectionSet = true;
  }
  // update the point being zoomed in to based on the zoom direction
  _updateZoomPoint() {
    const {
      camera,
      zoomDirectionSet,
      zoomDirection,
      raycaster,
      zoomPoint,
      pointerTracker,
      domElement
    } = this;
    this._zoomPointWasSet = false;
    if (!zoomDirectionSet) {
      return false;
    }
    if (camera.isOrthographicCamera && pointerTracker.getLatestPoint(_zoomPointPointer)) {
      mouseToCoords(_zoomPointPointer.x, _zoomPointPointer.y, domElement, _zoomPointPointer);
      setRaycasterFromCamera(raycaster, _zoomPointPointer, camera);
    } else {
      raycaster.ray.origin.copy(camera.position);
      raycaster.ray.direction.copy(zoomDirection);
      raycaster.near = 0;
      raycaster.far = Infinity;
    }
    const hit = this._raycast(raycaster);
    if (hit) {
      zoomPoint.copy(hit.point);
      this.zoomPointSet = true;
      this._zoomPointWasSet = true;
      return true;
    }
    return false;
  }
  // returns the point below the camera
  _getPointBelowCamera(point = this.camera.position, up = this.up) {
    const { raycaster } = this;
    raycaster.ray.direction.copy(up).multiplyScalar(-1);
    raycaster.ray.origin.copy(point).addScaledVector(up, 1e5);
    raycaster.near = 0;
    raycaster.far = Infinity;
    const hit = this._raycast(raycaster);
    if (hit) {
      hit.distance -= 1e5;
    }
    return hit;
  }
  // update the drag action
  _updatePosition(deltaTime) {
    const {
      raycaster,
      camera,
      pivotPoint,
      up,
      pointerTracker,
      domElement,
      state,
      dragInertia
    } = this;
    if (state === DRAG) {
      pointerTracker.getCenterPoint(_pointer);
      mouseToCoords(_pointer.x, _pointer.y, domElement, _pointer);
      _plane.setFromNormalAndCoplanarPoint(up, pivotPoint);
      setRaycasterFromCamera(raycaster, _pointer, camera);
      if (Math.abs(raycaster.ray.direction.dot(up)) < DRAG_PLANE_THRESHOLD) {
        const angle = Math.acos(DRAG_PLANE_THRESHOLD);
        _rotationAxis.crossVectors(raycaster.ray.direction, up).normalize();
        raycaster.ray.direction.copy(up).applyAxisAngle(_rotationAxis, angle).multiplyScalar(-1);
      }
      this.getUpDirection(pivotPoint, _localUp);
      if (Math.abs(raycaster.ray.direction.dot(_localUp)) < DRAG_UP_THRESHOLD) {
        const angle = Math.acos(DRAG_UP_THRESHOLD);
        _rotationAxis.crossVectors(raycaster.ray.direction, _localUp).normalize();
        raycaster.ray.direction.copy(_localUp).applyAxisAngle(_rotationAxis, angle).multiplyScalar(-1);
      }
      if (raycaster.ray.intersectPlane(_plane, _vec6)) {
        _delta.subVectors(pivotPoint, _vec6);
        camera.position.add(_delta);
        camera.updateMatrixWorld();
        _delta.multiplyScalar(1 / deltaTime);
        if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
          this.inertiaStableFrames++;
        } else {
          dragInertia.copy(_delta);
          this.inertiaStableFrames = 0;
        }
      }
    }
  }
  _updateRotation(deltaTime) {
    const {
      pivotPoint,
      pointerTracker,
      domElement,
      state,
      rotationInertia
    } = this;
    if (state === ROTATE) {
      pointerTracker.getCenterPoint(_pointer);
      pointerTracker.getPreviousCenterPoint(_prevPointer);
      _deltaPointer.subVectors(_pointer, _prevPointer).multiplyScalar(2 * Math.PI / domElement.clientHeight);
      this._applyRotation(_deltaPointer.x, _deltaPointer.y, pivotPoint);
      _deltaPointer.multiplyScalar(1 / deltaTime);
      if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
        this.inertiaStableFrames++;
      } else {
        rotationInertia.copy(_deltaPointer);
        this.inertiaStableFrames = 0;
      }
    }
  }
  _applyRotation(x, y, pivotPoint) {
    if (x === 0 && y === 0) {
      return;
    }
    const {
      camera,
      minAltitude,
      maxAltitude,
      rotationSpeed
    } = this;
    const azimuth = -x * rotationSpeed;
    let altitude = y * rotationSpeed;
    _forward.set(0, 0, 1).transformDirection(camera.matrixWorld);
    this.getUpDirection(pivotPoint, _localUp);
    _vec6.crossVectors(_localUp, _forward).normalize();
    _right.set(1, 0, 0).transformDirection(camera.matrixWorld).normalize();
    const sign = Math.sign(_vec6.dot(_right));
    const angle = sign * _localUp.angleTo(_forward);
    if (altitude > 0) {
      altitude = Math.min(angle - minAltitude - 0.01, altitude);
      altitude = Math.max(0, altitude);
    } else {
      altitude = Math.max(angle - maxAltitude, altitude);
      altitude = Math.min(0, altitude);
    }
    _quaternion.setFromAxisAngle(_localUp, azimuth);
    makeRotateAroundPoint(pivotPoint, _quaternion, _rotMatrix);
    camera.matrixWorld.premultiply(_rotMatrix);
    _rotationAxis.set(-1, 0, 0).transformDirection(camera.matrixWorld);
    _quaternion.setFromAxisAngle(_rotationAxis, altitude);
    makeRotateAroundPoint(pivotPoint, _quaternion, _rotMatrix);
    camera.matrixWorld.premultiply(_rotMatrix);
    camera.matrixWorld.decompose(camera.position, camera.quaternion, _vec6);
  }
  // sets the "up" axis for the current surface of the tile set
  _setFrame(newUp, pivot) {
    const {
      up,
      camera,
      state,
      zoomPoint,
      zoomDirectionSet,
      zoomPointSet,
      reorientOnDrag,
      scaleZoomOrientationAtEdges
    } = this;
    camera.updateMatrixWorld();
    _quaternion.setFromUnitVectors(up, newUp);
    const action = state;
    if (zoomDirectionSet && (zoomPointSet || this._updateZoomPoint())) {
      this.getUpDirection(zoomPoint, _vec6);
      if (scaleZoomOrientationAtEdges) {
        let amt = Math.max(_vec6.dot(up) - 0.6, 0) / 0.4;
        amt = MathUtils5.mapLinear(amt, 0, 0.5, 0, 1);
        amt = Math.min(amt, 1);
        if (camera.isOrthographicCamera) {
          amt *= 0.1;
        }
        _quaternion.slerp(_identityQuat, 1 - amt);
      }
      makeRotateAroundPoint(zoomPoint, _quaternion, _rotMatrix);
      camera.matrixWorld.premultiply(_rotMatrix);
      camera.matrixWorld.decompose(camera.position, camera.quaternion, _vec6);
      this.zoomDirectionSet = false;
      this._updateZoomDirection();
    } else if (action === DRAG && reorientOnDrag) {
      if (pivot) {
        makeRotateAroundPoint(pivot, _quaternion, _rotMatrix);
        camera.matrixWorld.premultiply(_rotMatrix);
        camera.matrixWorld.decompose(camera.position, camera.quaternion, _vec6);
      }
    }
    up.copy(newUp);
    camera.updateMatrixWorld();
  }
  _raycast(raycaster) {
    const { scene, useFallbackPlane, fallbackPlane } = this;
    const result = raycaster.intersectObject(scene)[0] || null;
    if (result) {
      return result;
    } else if (useFallbackPlane) {
      const plane = fallbackPlane;
      if (raycaster.ray.intersectPlane(plane, _vec6)) {
        const planeHit = {
          point: _vec6.clone(),
          distance: raycaster.ray.origin.distanceTo(_vec6)
        };
        return planeHit;
      }
    }
    return null;
  }
};

// node_modules/3d-tiles-renderer/src/three/controls/GlobeControls.js
var _invMatrix2 = /* @__PURE__ */ new Matrix411();
var _rotMatrix2 = /* @__PURE__ */ new Matrix411();
var _pos2 = /* @__PURE__ */ new Vector314();
var _vec7 = /* @__PURE__ */ new Vector314();
var _center = /* @__PURE__ */ new Vector314();
var _forward2 = /* @__PURE__ */ new Vector314();
var _right2 = /* @__PURE__ */ new Vector314();
var _targetRight = /* @__PURE__ */ new Vector314();
var _globalUp = /* @__PURE__ */ new Vector314();
var _quaternion2 = /* @__PURE__ */ new Quaternion3();
var _zoomPointUp = /* @__PURE__ */ new Vector314();
var _toCenter = /* @__PURE__ */ new Vector314();
var _ray5 = /* @__PURE__ */ new Ray6();
var _ellipsoid = /* @__PURE__ */ new Ellipsoid();
var _latLon = {};
var _pointer2 = new Vector26();
var MIN_ELEVATION = 400;
var GlobeControls = class extends EnvironmentControls {
  get ellipsoid() {
    return this.tilesRenderer ? this.tilesRenderer.ellipsoid : null;
  }
  get tilesGroup() {
    return this.tilesRenderer ? this.tilesRenderer.group : null;
  }
  constructor(scene = null, camera = null, domElement = null, tilesRenderer = null) {
    super(scene, camera, domElement);
    this.isGlobeControls = true;
    this._dragMode = 0;
    this._rotationMode = 0;
    this.maxZoom = 0.01;
    this.nearMargin = 0.25;
    this.farMargin = 0;
    this.useFallbackPlane = false;
    this.reorientOnDrag = false;
    this.globeInertia = new Quaternion3();
    this.globeInertiaFactor = 0;
    this.setTilesRenderer(tilesRenderer);
  }
  setScene(scene) {
    if (scene === null && this.tilesRenderer !== null) {
      super.setScene(this.tilesRenderer.group);
    } else {
      super.setScene(scene);
    }
  }
  getPivotPoint(target) {
    const { camera, tilesGroup, ellipsoid } = this;
    _forward2.set(0, 0, -1).transformDirection(camera.matrixWorld);
    _ray5.origin.copy(camera.position);
    _ray5.direction.copy(_forward2);
    _ray5.applyMatrix4(tilesGroup.matrixWorldInverse);
    closestRayEllipsoidSurfacePointEstimate(_ray5, ellipsoid, _vec7);
    _vec7.applyMatrix4(tilesGroup.matrixWorld);
    if (super.getPivotPoint(target) === null || target.distanceTo(_ray5.origin) > _vec7.distanceTo(_ray5.origin)) {
      target.copy(_vec7);
    }
    return target;
  }
  // get the vector to the center of the provided globe
  getVectorToCenter(target) {
    const { tilesGroup, camera } = this;
    return target.setFromMatrixPosition(tilesGroup.matrixWorld).sub(camera.position);
  }
  // get the distance to the center of the globe
  getDistanceToCenter() {
    return this.getVectorToCenter(_vec7).length();
  }
  getUpDirection(point, target) {
    const { tilesGroup, ellipsoid } = this;
    _vec7.copy(point).applyMatrix4(tilesGroup.matrixWorldInverse);
    ellipsoid.getPositionToNormal(_vec7, target);
    target.transformDirection(tilesGroup.matrixWorld);
  }
  getCameraUpDirection(target) {
    const { tilesGroup, ellipsoid, camera } = this;
    if (camera.isOrthographicCamera) {
      this._getVirtualOrthoCameraPosition(_vec7);
      _vec7.applyMatrix4(tilesGroup.matrixWorldInverse);
      ellipsoid.getPositionToNormal(_vec7, target);
      target.transformDirection(tilesGroup.matrixWorld);
    } else {
      this.getUpDirection(camera.position, target);
    }
  }
  update(deltaTime = Math.min(this.clock.getDelta(), 64 / 1e3)) {
    if (!this.enabled || !this.tilesGroup || !this.camera || deltaTime === 0) {
      return;
    }
    const { camera, pivotMesh } = this;
    if (this._isNearControls()) {
      this.scaleZoomOrientationAtEdges = this.zoomDelta < 0;
    } else {
      if (this.state !== NONE && this._dragMode !== 1 && this._rotationMode !== 1) {
        pivotMesh.visible = false;
      }
      this.scaleZoomOrientationAtEdges = false;
    }
    super.update(deltaTime);
    this.adjustCamera(camera);
  }
  // Updates the passed camera near and far clip planes to encapsulate the ellipsoid from the
  // current position in addition to adjusting the height.
  adjustCamera(camera) {
    super.adjustCamera(camera);
    const { tilesGroup, ellipsoid, nearMargin, farMargin } = this;
    const maxRadius = Math.max(...ellipsoid.radius);
    if (camera.isPerspectiveCamera) {
      const distanceToCenter = _vec7.setFromMatrixPosition(tilesGroup.matrixWorld).sub(camera.position).length();
      const margin = nearMargin * maxRadius;
      const alpha = MathUtils6.clamp((distanceToCenter - maxRadius) / margin, 0, 1);
      const minNear = MathUtils6.lerp(1, 1e3, alpha);
      camera.near = Math.max(minNear, distanceToCenter - maxRadius - margin);
      _pos2.copy(camera.position).applyMatrix4(tilesGroup.matrixWorldInverse);
      ellipsoid.getPositionToCartographic(_pos2, _latLon);
      const elevation = Math.max(ellipsoid.getPositionElevation(_pos2), MIN_ELEVATION);
      const horizonDistance = ellipsoid.calculateHorizonDistance(_latLon.lat, elevation);
      camera.far = horizonDistance * 2.5 + 0.1 + maxRadius * farMargin;
      camera.updateProjectionMatrix();
    } else {
      this._getVirtualOrthoCameraPosition(camera.position, camera);
      camera.updateMatrixWorld();
      _invMatrix2.copy(camera.matrixWorld).invert();
      _vec7.setFromMatrixPosition(tilesGroup.matrixWorld).applyMatrix4(_invMatrix2);
      const distanceToCenter = -_vec7.z;
      camera.near = distanceToCenter - maxRadius * (1 + nearMargin);
      camera.far = distanceToCenter + 0.1 + maxRadius * farMargin;
      camera.position.addScaledVector(_forward2, camera.near);
      camera.far -= camera.near;
      camera.near = 0;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    }
  }
  // resets the "stuck" drag modes
  resetState() {
    super.resetState();
    this._dragMode = 0;
    this._rotationMode = 0;
  }
  _updateInertia(deltaTime) {
    super._updateInertia(deltaTime);
    const {
      globeInertia,
      enableDamping,
      dampingFactor,
      camera,
      cameraRadius,
      minDistance,
      inertiaTargetDistance,
      tilesGroup
    } = this;
    if (!this.enableDamping || this.inertiaStableFrames > 1) {
      this.globeInertiaFactor = 0;
      this.globeInertia.identity();
      return;
    }
    const factor = Math.pow(2, -deltaTime / dampingFactor);
    const stableDistance = Math.max(camera.near, cameraRadius, minDistance, inertiaTargetDistance);
    const resolution = 2 * 1e3;
    const pixelWidth = 2 / resolution;
    const pixelThreshold = 0.25 * pixelWidth;
    _center.setFromMatrixPosition(tilesGroup.matrixWorld);
    if (this.globeInertiaFactor !== 0) {
      setRaycasterFromCamera(_ray5, _vec7.set(0, 0, -1), camera);
      _ray5.applyMatrix4(camera.matrixWorldInverse);
      _ray5.direction.normalize();
      _ray5.recast(-_ray5.direction.dot(_ray5.origin)).at(stableDistance / _ray5.direction.z, _vec7);
      _vec7.applyMatrix4(camera.matrixWorld);
      setRaycasterFromCamera(_ray5, _pos2.set(pixelThreshold, pixelThreshold, -1), camera);
      _ray5.applyMatrix4(camera.matrixWorldInverse);
      _ray5.direction.normalize();
      _ray5.recast(-_ray5.direction.dot(_ray5.origin)).at(stableDistance / _ray5.direction.z, _pos2);
      _pos2.applyMatrix4(camera.matrixWorld);
      _vec7.sub(_center).normalize();
      _pos2.sub(_center).normalize();
      this.globeInertiaFactor *= factor;
      const threshold = _vec7.angleTo(_pos2) / deltaTime;
      const globeAngle = 2 * Math.acos(globeInertia.w) * this.globeInertiaFactor;
      if (globeAngle < threshold || !enableDamping) {
        this.globeInertiaFactor = 0;
        globeInertia.identity();
      }
    }
    if (this.globeInertiaFactor !== 0) {
      if (globeInertia.w === 1 && (globeInertia.x !== 0 || globeInertia.y !== 0 || globeInertia.z !== 0)) {
        globeInertia.w = Math.min(globeInertia.w, 1 - 1e-9);
      }
      _center.setFromMatrixPosition(tilesGroup.matrixWorld);
      _quaternion2.identity().slerp(globeInertia, this.globeInertiaFactor * deltaTime);
      makeRotateAroundPoint(_center, _quaternion2, _rotMatrix2);
      camera.matrixWorld.premultiply(_rotMatrix2);
      camera.matrixWorld.decompose(camera.position, camera.quaternion, _vec7);
    }
  }
  _inertiaNeedsUpdate() {
    return super._inertiaNeedsUpdate() || this.globeInertiaFactor !== 0;
  }
  _updatePosition(deltaTime) {
    if (this.state === DRAG) {
      if (this._dragMode === 0) {
        this._dragMode = this._isNearControls() ? 1 : -1;
      }
      const {
        raycaster,
        camera,
        pivotPoint,
        pointerTracker,
        domElement,
        tilesGroup
      } = this;
      const pivotDir = _pos2;
      const newPivotDir = _targetRight;
      pointerTracker.getCenterPoint(_pointer2);
      mouseToCoords(_pointer2.x, _pointer2.y, domElement, _pointer2);
      setRaycasterFromCamera(raycaster, _pointer2, camera);
      raycaster.ray.applyMatrix4(tilesGroup.matrixWorldInverse);
      const pivotRadius = _vec7.copy(pivotPoint).applyMatrix4(tilesGroup.matrixWorldInverse).length();
      _ellipsoid.radius.setScalar(pivotRadius);
      if (camera.isPerspectiveCamera) {
        if (!_ellipsoid.intersectRay(raycaster.ray, _vec7)) {
          closestRaySpherePointFromRotation(raycaster.ray, pivotRadius, _vec7);
        }
      } else {
        closestRayEllipsoidSurfacePointEstimate(raycaster.ray, _ellipsoid, _vec7);
      }
      _vec7.applyMatrix4(tilesGroup.matrixWorld);
      _center.setFromMatrixPosition(tilesGroup.matrixWorld);
      pivotDir.subVectors(pivotPoint, _center).normalize();
      newPivotDir.subVectors(_vec7, _center).normalize();
      _quaternion2.setFromUnitVectors(newPivotDir, pivotDir);
      makeRotateAroundPoint(_center, _quaternion2, _rotMatrix2);
      camera.matrixWorld.premultiply(_rotMatrix2);
      camera.matrixWorld.decompose(camera.position, camera.quaternion, _vec7);
      if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
        this.inertiaStableFrames++;
      } else {
        this.globeInertia.copy(_quaternion2);
        this.globeInertiaFactor = 1 / deltaTime;
        this.inertiaStableFrames = 0;
      }
    }
    this._alignCameraUp(this.up);
  }
  // disable rotation once we're outside the control transition
  _updateRotation(...args) {
    if (this._rotationMode === 1 || this._isNearControls()) {
      this._rotationMode = 1;
      super._updateRotation(...args);
    } else {
      this.pivotMesh.visible = false;
      this._rotationMode = -1;
    }
    this._alignCameraUp(this.up);
  }
  _updateZoom() {
    const { zoomDelta, ellipsoid, zoomSpeed, zoomPoint, camera, maxZoom, state } = this;
    if (state !== ZOOM && zoomDelta === 0) {
      return;
    }
    this.rotationInertia.set(0, 0);
    this.dragInertia.set(0, 0, 0);
    this.globeInertia.identity();
    this.globeInertiaFactor = 0;
    const deltaAlpha = MathUtils6.clamp(MathUtils6.mapLinear(Math.abs(zoomDelta), 0, 20, 0, 1), 0, 1);
    if (this._isNearControls() || zoomDelta > 0) {
      this._updateZoomDirection();
      if (zoomDelta < 0 && (this.zoomPointSet || this._updateZoomPoint())) {
        _forward2.set(0, 0, -1).transformDirection(camera.matrixWorld).normalize();
        _toCenter.copy(this.up).multiplyScalar(-1);
        this.getUpDirection(zoomPoint, _zoomPointUp);
        const upAlpha = MathUtils6.clamp(MathUtils6.mapLinear(-_zoomPointUp.dot(_toCenter), 1, 0.95, 0, 1), 0, 1);
        const forwardAlpha = 1 - _forward2.dot(_toCenter);
        const cameraAlpha = camera.isOrthographicCamera ? 0.05 : 1;
        const adjustedDeltaAlpha = MathUtils6.clamp(deltaAlpha * 3, 0, 1);
        const alpha = Math.min(upAlpha * forwardAlpha * cameraAlpha * adjustedDeltaAlpha, 0.1);
        _toCenter.lerpVectors(_forward2, _toCenter, alpha).normalize();
        _quaternion2.setFromUnitVectors(_forward2, _toCenter);
        makeRotateAroundPoint(zoomPoint, _quaternion2, _rotMatrix2);
        camera.matrixWorld.premultiply(_rotMatrix2);
        camera.matrixWorld.decompose(camera.position, camera.quaternion, _toCenter);
        this.zoomDirection.subVectors(zoomPoint, camera.position).normalize();
      }
      super._updateZoom();
    } else if (camera.isPerspectiveCamera) {
      const transitionDistance = this._getPerspectiveTransitionDistance();
      const maxDistance = this._getMaxPerspectiveDistance();
      const distanceAlpha = MathUtils6.mapLinear(this.getDistanceToCenter(), transitionDistance, maxDistance, 0, 1);
      this._tiltTowardsCenter(MathUtils6.lerp(0, 0.4, distanceAlpha * deltaAlpha));
      this._alignCameraUpToNorth(MathUtils6.lerp(0, 0.2, distanceAlpha * deltaAlpha));
      const dist = this.getDistanceToCenter() - ellipsoid.radius.x;
      const scale = zoomDelta * dist * zoomSpeed * 25e-4;
      const clampedScale = Math.max(scale, Math.min(this.getDistanceToCenter() - maxDistance, 0));
      this.getVectorToCenter(_vec7).normalize();
      this.camera.position.addScaledVector(_vec7, clampedScale);
      this.camera.updateMatrixWorld();
      this.zoomDelta = 0;
    } else {
      const transitionZoom = this._getOrthographicTransitionZoom();
      const minZoom = this._getMinOrthographicZoom();
      const distanceAlpha = MathUtils6.mapLinear(camera.zoom, transitionZoom, minZoom, 0, 1);
      this._tiltTowardsCenter(MathUtils6.lerp(0, 0.4, distanceAlpha * deltaAlpha));
      this._alignCameraUpToNorth(MathUtils6.lerp(0, 0.2, distanceAlpha * deltaAlpha));
      const scale = this.zoomDelta;
      const normalizedDelta = Math.pow(0.95, Math.abs(scale * 0.05));
      const scaleFactor = scale > 0 ? 1 / Math.abs(normalizedDelta) : normalizedDelta;
      const maxScaleFactor = minZoom / camera.zoom;
      const clampedScaleFactor = Math.max(scaleFactor * zoomSpeed, Math.min(maxScaleFactor, 1));
      camera.zoom = Math.min(maxZoom, camera.zoom * clampedScaleFactor);
      camera.updateProjectionMatrix();
      this.zoomDelta = 0;
      this.zoomDirectionSet = false;
    }
  }
  // tilt the camera to align with north
  _alignCameraUpToNorth(alpha) {
    const { tilesGroup } = this;
    _globalUp.set(0, 0, 1).transformDirection(tilesGroup.matrixWorld);
    this._alignCameraUp(_globalUp, alpha);
  }
  // tilt the camera to align with the provided "up" value
  _alignCameraUp(up, alpha = null) {
    const { camera } = this;
    _forward2.set(0, 0, -1).transformDirection(camera.matrixWorld);
    _right2.set(-1, 0, 0).transformDirection(camera.matrixWorld);
    _targetRight.crossVectors(up, _forward2);
    if (alpha === null) {
      alpha = 1 - Math.abs(_forward2.dot(up));
      alpha = MathUtils6.mapLinear(alpha, 0, 1, -0.01, 1);
      alpha = MathUtils6.clamp(alpha, 0, 1) ** 2;
    }
    _targetRight.lerp(_right2, 1 - alpha).normalize();
    _quaternion2.setFromUnitVectors(_right2, _targetRight);
    camera.quaternion.premultiply(_quaternion2);
    camera.updateMatrixWorld();
  }
  // tilt the camera to look at the center of the globe
  _tiltTowardsCenter(alpha) {
    const {
      camera,
      tilesGroup
    } = this;
    _forward2.set(0, 0, -1).transformDirection(camera.matrixWorld).normalize();
    _vec7.setFromMatrixPosition(tilesGroup.matrixWorld).sub(camera.position).normalize();
    _vec7.lerp(_forward2, 1 - alpha).normalize();
    _quaternion2.setFromUnitVectors(_forward2, _vec7);
    camera.quaternion.premultiply(_quaternion2);
    camera.updateMatrixWorld();
  }
  // returns the perspective camera transition distance can move to based on globe size and fov
  _getPerspectiveTransitionDistance() {
    const { camera, ellipsoid } = this;
    if (!camera.isPerspectiveCamera) {
      throw new Error();
    }
    const ellipsoidRadius = Math.max(...ellipsoid.radius);
    const fovHoriz = 2 * Math.atan(Math.tan(MathUtils6.DEG2RAD * camera.fov * 0.5) * camera.aspect);
    const distVert = ellipsoidRadius / Math.tan(MathUtils6.DEG2RAD * camera.fov * 0.5);
    const distHoriz = ellipsoidRadius / Math.tan(fovHoriz * 0.5);
    const dist = Math.max(distVert, distHoriz);
    return dist;
  }
  // returns the max distance the perspective camera can move to based on globe size and fov
  _getMaxPerspectiveDistance() {
    const { camera, ellipsoid } = this;
    if (!camera.isPerspectiveCamera) {
      throw new Error();
    }
    const ellipsoidRadius = Math.max(...ellipsoid.radius);
    const fovHoriz = 2 * Math.atan(Math.tan(MathUtils6.DEG2RAD * camera.fov * 0.5) * camera.aspect);
    const distVert = ellipsoidRadius / Math.tan(MathUtils6.DEG2RAD * camera.fov * 0.5);
    const distHoriz = ellipsoidRadius / Math.tan(fovHoriz * 0.5);
    const dist = 2 * Math.max(distVert, distHoriz);
    return dist;
  }
  // returns the transition threshold for orthographic zoom based on the globe size and camera settings
  _getOrthographicTransitionZoom() {
    const { camera, ellipsoid } = this;
    if (!camera.isOrthographicCamera) {
      throw new Error();
    }
    const orthoHeight = camera.top - camera.bottom;
    const orthoWidth = camera.right - camera.left;
    const orthoSize = Math.max(orthoHeight, orthoWidth);
    const ellipsoidRadius = Math.max(...ellipsoid.radius);
    const ellipsoidDiameter = 2 * ellipsoidRadius;
    return 2 * orthoSize / ellipsoidDiameter;
  }
  // returns the minimum allowed orthographic zoom based on the globe size and camera settings
  _getMinOrthographicZoom() {
    const { camera, ellipsoid } = this;
    if (!camera.isOrthographicCamera) {
      throw new Error();
    }
    const orthoHeight = camera.top - camera.bottom;
    const orthoWidth = camera.right - camera.left;
    const orthoSize = Math.min(orthoHeight, orthoWidth);
    const ellipsoidRadius = Math.max(...ellipsoid.radius);
    const ellipsoidDiameter = 2 * ellipsoidRadius;
    return 0.7 * orthoSize / ellipsoidDiameter;
  }
  // returns the "virtual position" of the orthographic based on where it is and
  // where it's looking primarily so we can reasonably position the camera object
  // in space and derive a reasonable "up" value.
  _getVirtualOrthoCameraPosition(target, camera = this.camera) {
    const { tilesGroup, ellipsoid } = this;
    if (!camera.isOrthographicCamera) {
      throw new Error();
    }
    _ray5.origin.copy(camera.position);
    _ray5.direction.set(0, 0, -1).transformDirection(camera.matrixWorld);
    _ray5.applyMatrix4(tilesGroup.matrixWorldInverse);
    closestRayEllipsoidSurfacePointEstimate(_ray5, ellipsoid, _pos2);
    _pos2.applyMatrix4(tilesGroup.matrixWorld);
    const orthoHeight = camera.top - camera.bottom;
    const orthoWidth = camera.right - camera.left;
    const orthoSize = Math.max(orthoHeight, orthoWidth) / camera.zoom;
    _forward2.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const dist = _pos2.sub(camera.position).dot(_forward2);
    target.copy(camera.position).addScaledVector(_forward2, dist - orthoSize * 4);
  }
  _isNearControls() {
    const { camera } = this;
    if (camera.isPerspectiveCamera) {
      return this.getDistanceToCenter() < this._getPerspectiveTransitionDistance();
    } else {
      return camera.zoom > this._getOrthographicTransitionZoom();
    }
  }
  _raycast(raycaster) {
    const result = super._raycast(raycaster);
    if (result === null) {
      const { ellipsoid, tilesGroup } = this;
      _ray5.copy(raycaster.ray).applyMatrix4(tilesGroup.matrixWorldInverse);
      const point = ellipsoid.intersectRay(_ray5, _vec7);
      if (point !== null) {
        return {
          point: point.clone().applyMatrix4(tilesGroup.matrixWorld)
        };
      } else {
        return null;
      }
    } else {
      return result;
    }
  }
};

// node_modules/3d-tiles-renderer/src/three/controls/CameraTransitionManager.js
import { Clock as Clock2, EventDispatcher as EventDispatcher3, MathUtils as MathUtils7, OrthographicCamera, PerspectiveCamera, Quaternion as Quaternion4, Vector3 as Vector315 } from "three";
var _forward3 = new Vector315();
var _vec8 = new Vector315();
var _orthographicCamera = new OrthographicCamera();
var _targetOffset = new Vector315();
var _perspOffset = new Vector315();
var _orthoOffset = new Vector315();
var _quat = new Quaternion4();
var _targetQuat = new Quaternion4();
var CameraTransitionManager = class extends EventDispatcher3 {
  get animating() {
    return this._alpha !== 0 && this._alpha !== 1;
  }
  get camera() {
    if (this._alpha === 0) return this.perspectiveCamera;
    if (this._alpha === 1) return this.orthographicCamera;
    return this.transitionCamera;
  }
  get mode() {
    return this._target === 0 ? "perspective" : "orthographic";
  }
  set mode(v) {
    if (v === this.mode) {
      return;
    }
    const prevCamera = this.camera;
    if (v === "perspective") {
      this._target = 0;
      this._alpha = 0;
    } else {
      this._target = 1;
      this._alpha = 1;
    }
    this.dispatchEvent({ type: "camera-change", camera: this.camera, prevCamera });
  }
  constructor(perspectiveCamera = new PerspectiveCamera(), orthographicCamera = new OrthographicCamera()) {
    super();
    this.perspectiveCamera = perspectiveCamera;
    this.orthographicCamera = orthographicCamera;
    this.transitionCamera = new PerspectiveCamera();
    this.orthographicPositionalZoom = true;
    this.orthographicOffset = 50;
    this.fixedPoint = new Vector315();
    this.duration = 200;
    this.autoSync = true;
    this.easeFunction = (x) => x;
    this._target = 0;
    this._alpha = 0;
    this._clock = new Clock2();
  }
  toggle() {
    this._target = this._target === 1 ? 0 : 1;
    this._clock.getDelta();
    this.dispatchEvent({ type: "toggle" });
  }
  update(deltaTime = Math.min(this._clock.getDelta(), 64 / 1e3)) {
    if (this.autoSync) {
      this.syncCameras();
    }
    const { perspectiveCamera, orthographicCamera, transitionCamera, camera } = this;
    const delta = deltaTime * 1e3;
    if (this._alpha !== this._target) {
      const direction = Math.sign(this._target - this._alpha);
      const step = direction * delta / this.duration;
      this._alpha = MathUtils7.clamp(this._alpha + step, 0, 1);
      this.dispatchEvent({ type: "change" });
    }
    const prevCamera = camera;
    let newCamera = null;
    if (this._alpha === 0) {
      newCamera = perspectiveCamera;
    } else if (this._alpha === 1) {
      newCamera = orthographicCamera;
    } else {
      newCamera = transitionCamera;
      this._updateTransitionCamera();
    }
    if (prevCamera !== newCamera) {
      if (newCamera === transitionCamera) {
        this.dispatchEvent({ type: "transition-start" });
      }
      this.dispatchEvent({ type: "camera-change", camera: newCamera, prevCamera });
      if (prevCamera === transitionCamera) {
        this.dispatchEvent({ type: "transition-end" });
      }
    }
  }
  syncCameras() {
    const fromCamera = this._getFromCamera();
    const { perspectiveCamera, orthographicCamera, transitionCamera, fixedPoint } = this;
    _forward3.set(0, 0, -1).transformDirection(fromCamera.matrixWorld).normalize();
    if (fromCamera.isPerspectiveCamera) {
      if (this.orthographicPositionalZoom) {
        orthographicCamera.position.copy(perspectiveCamera.position).addScaledVector(_forward3, -this.orthographicOffset);
        orthographicCamera.rotation.copy(perspectiveCamera.rotation);
        orthographicCamera.updateMatrixWorld();
      } else {
        const orthoDist = _vec8.subVectors(fixedPoint, orthographicCamera.position).dot(_forward3);
        const perspDist = _vec8.subVectors(fixedPoint, perspectiveCamera.position).dot(_forward3);
        _vec8.copy(perspectiveCamera.position).addScaledVector(_forward3, perspDist);
        orthographicCamera.rotation.copy(perspectiveCamera.rotation);
        orthographicCamera.position.copy(_vec8).addScaledVector(_forward3, -orthoDist);
        orthographicCamera.updateMatrixWorld();
      }
      const distToPoint = Math.abs(_vec8.subVectors(perspectiveCamera.position, fixedPoint).dot(_forward3));
      const projectionHeight = 2 * Math.tan(MathUtils7.DEG2RAD * perspectiveCamera.fov * 0.5) * distToPoint;
      const orthoHeight = orthographicCamera.top - orthographicCamera.bottom;
      orthographicCamera.zoom = orthoHeight / projectionHeight;
      orthographicCamera.updateProjectionMatrix();
    } else {
      const distToPoint = Math.abs(_vec8.subVectors(orthographicCamera.position, fixedPoint).dot(_forward3));
      const orthoHeight = (orthographicCamera.top - orthographicCamera.bottom) / orthographicCamera.zoom;
      const targetDist = orthoHeight * 0.5 / Math.tan(MathUtils7.DEG2RAD * perspectiveCamera.fov * 0.5);
      perspectiveCamera.rotation.copy(orthographicCamera.rotation);
      perspectiveCamera.position.copy(orthographicCamera.position).addScaledVector(_forward3, distToPoint).addScaledVector(_forward3, -targetDist);
      perspectiveCamera.updateMatrixWorld();
      if (this.orthographicPositionalZoom) {
        orthographicCamera.position.copy(perspectiveCamera.position).addScaledVector(_forward3, -this.orthographicOffset);
        orthographicCamera.updateMatrixWorld();
      }
    }
    transitionCamera.position.copy(perspectiveCamera.position);
    transitionCamera.rotation.copy(perspectiveCamera.rotation);
  }
  _getTransitionDirection() {
    return Math.sign(this._target - this._alpha);
  }
  _getToCamera() {
    const dir = this._getTransitionDirection();
    if (dir === 0) {
      return this._target === 0 ? this.perspectiveCamera : this.orthographicCamera;
    } else if (dir > 0) {
      return this.orthographicCamera;
    } else {
      return this.perspectiveCamera;
    }
  }
  _getFromCamera() {
    const dir = this._getTransitionDirection();
    if (dir === 0) {
      return this._target === 0 ? this.perspectiveCamera : this.orthographicCamera;
    } else if (dir > 0) {
      return this.perspectiveCamera;
    } else {
      return this.orthographicCamera;
    }
  }
  _updateTransitionCamera() {
    const { perspectiveCamera, orthographicCamera, transitionCamera, fixedPoint } = this;
    const alpha = this.easeFunction(this._alpha);
    _forward3.set(0, 0, -1).transformDirection(orthographicCamera.matrixWorld).normalize();
    _orthographicCamera.copy(orthographicCamera);
    _orthographicCamera.position.addScaledVector(_forward3, orthographicCamera.near);
    orthographicCamera.far -= orthographicCamera.near;
    orthographicCamera.near = 0;
    _forward3.set(0, 0, -1).transformDirection(perspectiveCamera.matrixWorld).normalize();
    const distToPoint = Math.abs(_vec8.subVectors(perspectiveCamera.position, fixedPoint).dot(_forward3));
    const projectionHeight = 2 * Math.tan(MathUtils7.DEG2RAD * perspectiveCamera.fov * 0.5) * distToPoint;
    const targetQuat = _targetQuat.slerpQuaternions(perspectiveCamera.quaternion, _orthographicCamera.quaternion, alpha);
    const targetFov = MathUtils7.lerp(perspectiveCamera.fov, 1, alpha);
    const targetDistance = projectionHeight * 0.5 / Math.tan(MathUtils7.DEG2RAD * targetFov * 0.5);
    const orthoOffset = _orthoOffset.copy(_orthographicCamera.position).sub(fixedPoint).applyQuaternion(_quat.copy(_orthographicCamera.quaternion).invert());
    const perspOffset = _perspOffset.copy(perspectiveCamera.position).sub(fixedPoint).applyQuaternion(_quat.copy(perspectiveCamera.quaternion).invert());
    const targetOffset = _targetOffset.lerpVectors(perspOffset, orthoOffset, alpha);
    targetOffset.z -= Math.abs(targetOffset.z) - targetDistance;
    const distToPersp = -(perspOffset.z - targetOffset.z);
    const distToOrtho = -(orthoOffset.z - targetOffset.z);
    const targetNearPlane = MathUtils7.lerp(distToPersp + perspectiveCamera.near, distToOrtho + _orthographicCamera.near, alpha);
    const targetFarPlane = MathUtils7.lerp(distToPersp + perspectiveCamera.far, distToOrtho + _orthographicCamera.far, alpha);
    const planeDelta = Math.max(targetFarPlane, 0) - Math.max(targetNearPlane, 0);
    transitionCamera.aspect = perspectiveCamera.aspect;
    transitionCamera.fov = targetFov;
    transitionCamera.near = Math.max(targetNearPlane, planeDelta * 1e-5);
    transitionCamera.far = targetFarPlane;
    transitionCamera.position.copy(targetOffset).applyQuaternion(targetQuat).add(fixedPoint);
    transitionCamera.quaternion.copy(targetQuat);
    transitionCamera.updateProjectionMatrix();
    transitionCamera.updateMatrixWorld();
  }
};
export {
  B3DMLoader,
  B3DMLoaderBase,
  CAMERA_FRAME,
  CMPTLoader,
  CMPTLoaderBase,
  CameraTransitionManager,
  ENU_FRAME,
  Ellipsoid,
  EllipsoidRegion,
  EnvironmentControls,
  FAILED,
  GeoUtils_exports as GeoUtils,
  GlobeControls,
  I3DMLoader,
  I3DMLoaderBase,
  LOADED,
  LOADING,
  LRUCache,
  LoaderBase,
  OBB,
  OBJECT_FRAME,
  PARSING,
  PNTSLoader,
  PNTSLoaderBase,
  PriorityQueue,
  TilesRenderer,
  TilesRendererBase,
  UNLOADED,
  WGS84_ELLIPSOID,
  WGS84_FLATTENING,
  WGS84_HEIGHT,
  WGS84_RADIUS
};
