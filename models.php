<?php
// Auto-lista todos los .glb en /models/ y los devuelve como JSON.
// Cualquier GLB que subas a /models/ aparece automáticamente en el dropdown del visor.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');

$dir = __DIR__ . '/models';
if (!is_dir($dir)) {
    echo json_encode([]);
    exit;
}

$files = [];
$it = new DirectoryIterator($dir);
foreach ($it as $f) {
    if ($f->isDot() || !$f->isFile()) continue;
    $ext = strtolower($f->getExtension());
    if ($ext !== 'glb' && $ext !== 'gltf') continue;
    $files[] = [
        'name' => $f->getFilename(),
        'url'  => '/models/' . $f->getFilename(),
        'size' => $f->getSize(),
        'mtime'=> $f->getMTime(),
    ];
}

usort($files, fn($a, $b) => $b['mtime'] <=> $a['mtime']);
echo json_encode($files, JSON_UNESCAPED_SLASHES);
