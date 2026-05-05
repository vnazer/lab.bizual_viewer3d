<?php
// upload.php — endpoint de upload con token para subir GLBs al visor
// Token se valida vía header X-Upload-Token o campo POST `token`.

declare(strict_types=1);

// ────────────────────────────────────────────────────────────────────
// CONFIG — cambiá este token cuando quieras (también se guarda en
// localStorage del navegador, no se mandan passwords por la red).
// Para regenerar: python3 -c "import secrets; print(secrets.token_urlsafe(32))"
// ────────────────────────────────────────────────────────────────────
const UPLOAD_TOKEN = 'im-WpTLqucq4MB3Z1EnUx8vbd7f1DevJu2upTZHhVok';
const ALLOWED_EXT  = ['glb', 'gltf', 'bin', 'ktx2'];
const MAX_SIZE_MB  = 100;
const MAX_SIZE     = MAX_SIZE_MB * 1024 * 1024;
const TARGET_DIR   = __DIR__ . '/models';

// ────────────────────────────────────────────────────────────────────

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Upload-Token');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// Token check
$token = $_SERVER['HTTP_X_UPLOAD_TOKEN'] ?? $_POST['token'] ?? '';
if (!hash_equals(UPLOAD_TOKEN, (string)$token)) {
    http_response_code(401);
    echo json_encode(['error' => 'Token inválido']);
    exit;
}

// File check
if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    $php_err = $_FILES['file']['error'] ?? -1;
    $msg = match ($php_err) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Archivo demasiado grande para el servidor',
        UPLOAD_ERR_PARTIAL    => 'Upload incompleto',
        UPLOAD_ERR_NO_FILE    => 'No se mandó ningún archivo',
        UPLOAD_ERR_NO_TMP_DIR => 'Servidor sin tmp dir',
        UPLOAD_ERR_CANT_WRITE => 'No se pudo escribir en disco',
        default => 'Error de upload (' . $php_err . ')',
    };
    http_response_code(400);
    echo json_encode(['error' => $msg]);
    exit;
}

$file = $_FILES['file'];

// Size check
if ($file['size'] > MAX_SIZE) {
    $sizeMb = round($file['size'] / 1024 / 1024, 1);
    http_response_code(413);
    echo json_encode([
        'error' => "El archivo pesa {$sizeMb} MB y el límite es " . MAX_SIZE_MB . " MB. " .
                   "Reducí el tamaño con Draco/KTX2 o decimación antes de subirlo.",
        'limit_mb' => MAX_SIZE_MB,
        'file_mb'  => $sizeMb,
    ]);
    exit;
}

// Extension whitelist
$origName = (string)$file['name'];
$ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
if (!in_array($ext, ALLOWED_EXT, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Extensión no permitida. Permitidas: .' . implode(', .', ALLOWED_EXT)]);
    exit;
}

// Sanitize filename — solo letras, números, guion, punto, underscore
$base = pathinfo($origName, PATHINFO_FILENAME);
$safeBase = preg_replace('/[^a-zA-Z0-9._-]/', '_', $base);
$safeBase = trim($safeBase, '._');
if ($safeBase === '') $safeBase = 'model_' . date('YmdHis');
$safeName = $safeBase . '.' . $ext;

// Ensure target dir
if (!is_dir(TARGET_DIR)) {
    if (!mkdir(TARGET_DIR, 0755, true) && !is_dir(TARGET_DIR)) {
        http_response_code(500);
        echo json_encode(['error' => 'No se pudo crear /models']);
        exit;
    }
}

$dest = TARGET_DIR . '/' . $safeName;

// Si ya existe, agregamos sufijo timestamp para no pisar
if (file_exists($dest)) {
    $safeName = $safeBase . '_' . date('YmdHis') . '.' . $ext;
    $dest = TARGET_DIR . '/' . $safeName;
}

if (!move_uploaded_file($file['tmp_name'], $dest)) {
    http_response_code(500);
    echo json_encode(['error' => 'No se pudo guardar el archivo']);
    exit;
}

// Optional: chmod legible
@chmod($dest, 0644);

echo json_encode([
    'ok'   => true,
    'name' => $safeName,
    'url'  => 'models/' . $safeName,
    'size' => filesize($dest),
], JSON_UNESCAPED_SLASHES);
