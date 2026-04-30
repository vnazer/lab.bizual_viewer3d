// Patch GLBs whose textures are missing a `source` and don't have an
// EXT_texture_webp/avif extension — Blender exports leftover slots like that
// and GLTFLoader crashes on them with "cannot read 'uri' of undefined".
export function sanitizeGLB(buf) {
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x46546c67) return null; // not 'glTF'
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) return null; // not 'JSON'
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));

  let touched = false;
  for (const tex of json.textures || []) {
    const ext = tex.extensions || {};
    const hasExtSource = ext.EXT_texture_webp || ext.EXT_texture_avif;
    if (tex.source === undefined && !hasExtSource && (json.images || []).length) {
      tex.source = 0;
      if (Object.keys(ext).length === 0) delete tex.extensions;
      touched = true;
    }
  }
  if (!touched) return null;

  let newJson = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (newJson.length % 4)) % 4;
  if (pad) {
    const padded = new Uint8Array(newJson.length + pad);
    padded.set(newJson);
    padded.fill(0x20, newJson.length);
    newJson = padded;
  }
  const rest = new Uint8Array(buf, 20 + jsonLen);
  const total = 12 + 8 + newJson.length + rest.length;
  const out = new ArrayBuffer(total);
  const ov = new DataView(out);
  ov.setUint32(0, 0x46546c67, true);
  ov.setUint32(4, 2, true);
  ov.setUint32(8, total, true);
  ov.setUint32(12, newJson.length, true);
  ov.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20).set(newJson);
  new Uint8Array(out, 20 + newJson.length).set(rest);
  console.warn('[lab] sanitized GLB: patched textures with missing source');
  return out;
}
