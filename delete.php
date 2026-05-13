<?php
// delete.php — endpoint para borrar GLBs de /models/.
// Mismo token que upload.php (compartido vía localStorage del navegador).
// Body: JSON { "files": ["a.glb", "b.glb"] }  o form-data files[]=...
// Solo borra dentro de /models/. Rechaza paths con .. o /.

declare(strict_types=1);

const UPLOAD_TOKEN = 'im-WpTLqucq4MB3Z1EnUx8vbd7f1DevJu2upTZHhVok';
const ALLOWED_EXT  = ['glb', 'gltf', 'bin', 'ktx2'];
const TARGET_DIR   = __DIR__ . '/models';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Upload-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$token = $_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? $_POST['token'] ?? '';
if (!hash_equals(UPLOAD_TOKEN, (string)$token)) {
    http_response_code(401);
    echo json_encode(['error' => 'Token inválido']);
    exit;
}

// Aceptar JSON o form-data
$files = [];
$raw = file_get_contents('php://input');
if ($raw && ($_SERVER['CONTENT_TYPE'] ?? '') && str_contains($_SERVER['CONTENT_TYPE'], 'application/json')) {
    $data = json_decode($raw, true);
    if (is_array($data['files'] ?? null)) $files = $data['files'];
} else {
    $files = $_POST['files'] ?? [];
    if (is_string($files)) $files = [$files];
}

if (!is_array($files) || !count($files)) {
    http_response_code(400);
    echo json_encode(['error' => 'Falta el array "files"']);
    exit;
}

$deleted = [];
$failed  = [];
$realTarget = realpath(TARGET_DIR);

foreach ($files as $name) {
    $name = (string)$name;
    // Validaciones duras de seguridad
    if ($name === '' || strpos($name, '/') !== false || strpos($name, '\\') !== false || strpos($name, '..') !== false) {
        $failed[] = ['file' => $name, 'error' => 'Nombre inválido'];
        continue;
    }
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    if (!in_array($ext, ALLOWED_EXT, true)) {
        $failed[] = ['file' => $name, 'error' => 'Extensión no permitida'];
        continue;
    }
    $path = TARGET_DIR . '/' . $name;
    $real = realpath($path);
    // Garantizar que el archivo está dentro de /models (defensa en profundidad)
    if (!$real || !$realTarget || strpos($real, $realTarget . DIRECTORY_SEPARATOR) !== 0) {
        $failed[] = ['file' => $name, 'error' => 'No existe o fuera de /models'];
        continue;
    }
    if (!is_file($real)) {
        $failed[] = ['file' => $name, 'error' => 'No es un archivo regular'];
        continue;
    }
    if (@unlink($real)) {
        $deleted[] = $name;
    } else {
        $failed[] = ['file' => $name, 'error' => 'No se pudo borrar (permisos?)'];
    }
}

echo json_encode([
    'ok'      => count($deleted) > 0,
    'deleted' => $deleted,
    'failed'  => $failed,
], JSON_UNESCAPED_SLASHES);
