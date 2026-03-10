<?php
// Configurar CORS y tipo de contenido
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');

// Configuración de Supabase
$supabase_url = 'https://zicowjlhaopgamhesqcz.supabase.co';
$supabase_key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppY293amxoYW9wZ2FtaGVzcWN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwMDI2MDYsImV4cCI6MjA4NjU3ODYwNn0.3r8kYbgjmEzj2zADZOHL3V0kH05_I8gi0hdVMu_odzA';

// Función para hacer peticiones a Supabase
function supabaseRequest($endpoint, $method = 'GET', $data = null) {
    global $supabase_url, $supabase_key;
    
    $url = $supabase_url . $endpoint;
    $ch = curl_init($url);
    
    $headers = [
        'apikey: ' . $supabase_key,
        'Authorization: Bearer ' . $supabase_key,
        'Content-Type: application/json'
    ];
    
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    } elseif ($method === 'PATCH') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'PATCH');
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    }
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return ['code' => $httpCode, 'response' => $response];
}

// Función para generar UUID v4
function generateUUID() {
    return sprintf('%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff), mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
    );
}

// Log para depuración
function writeLog($message) {
    $logFile = __DIR__ . '/epayco_log_' . date('Y-m-d') . '.txt';
    file_put_contents($logFile, date('Y-m-d H:i:s') . " - " . $message . PHP_EOL, FILE_APPEND);
}

writeLog("========== NUEVA NOTIFICACIÓN ==========");
writeLog("Método: " . $_SERVER['REQUEST_METHOD']);

// Obtener datos enviados por ePayco (POST o GET)
$inputData = $_POST ?: $_GET;
writeLog("Datos recibidos: " . print_r($inputData, true));

if (empty($inputData)) {
    $rawInput = file_get_contents('php://input');
    writeLog("Raw input: " . $rawInput);
    http_response_code(400);
    echo "ERROR: No data received";
    exit;
}

// Extraer TODOS los campos posibles de ePayco [citation:2]
$data = [
    // Campos principales
    'ref_payco' => $inputData['ref_payco'] ?? $inputData['x_ref_payco'] ?? '',
    'transaction_id' => $inputData['transaction_id'] ?? $inputData['x_transaction_id'] ?? '',
    'amount' => $inputData['amount'] ?? $inputData['x_amount'] ?? $inputData['x_amount_ok'] ?? 0,
    'currency' => $inputData['currency'] ?? $inputData['x_currency_code'] ?? 'COP',
    'cod_response' => $inputData['cod_response'] ?? $inputData['x_cod_response'] ?? '',
    'response' => $inputData['response'] ?? $inputData['x_response'] ?? '',
    'response_reason' => $inputData['response_reason'] ?? $inputData['x_response_reason_text'] ?? '',
    'franchise' => $inputData['franchise'] ?? $inputData['x_franchise'] ?? '',
    'payment_method' => $inputData['payment_method'] ?? $inputData['banco'] ?? $inputData['x_bank_name'] ?? $inputData['franchise'] ?? '',
    'date' => $inputData['date'] ?? $inputData['x_transaction_date'] ?? '',
    
    // Campos extra que enviamos desde checkout.html
    'extra1' => $inputData['extra1'] ?? $inputData['x_extra1'] ?? '', // user_id
    'extra2' => $inputData['extra2'] ?? $inputData['x_extra2'] ?? '', // package_type
    'extra3' => $inputData['extra3'] ?? $inputData['x_extra3'] ?? '', // credits
    
    // Datos del cliente
    'customer_name' => $inputData['customer_name'] ?? $inputData['x_customer_name'] ?? '',
    'customer_email' => $inputData['customer_email'] ?? $inputData['x_customer_email'] ?? '',
    'customer_document' => $inputData['customer_document'] ?? $inputData['x_customer_document'] ?? '',
];

writeLog("Datos procesados: " . print_r($data, true));

// Normalizar estado según tabla de ePayco [citation:2]
$statusNormalized = 'pendiente';
$completed_at = null;

// Códigos de respuesta ePayco: 1=Aceptada, 2=Rechazada, 3=Pendiente, 4=Fallida
switch ($data['cod_response']) {
    case '1':
        $statusNormalized = 'completado';
        $completed_at = date('Y-m-d H:i:s');
        writeLog("✅ Transacción ACEPTADA");
        break;
    case '2':
        $statusNormalized = 'rechazado';
        writeLog("❌ Transacción RECHAZADA - Motivo: " . $data['response_reason']);
        break;
    case '3':
        $statusNormalized = 'pendiente';
        writeLog("⏳ Transacción PENDIENTE");
        break;
    case '4':
        $statusNormalized = 'rechazado';
        writeLog("❌ Transacción FALLIDA");
        break;
    default:
        // Si no hay código pero hay respuesta textual
        if (stripos($data['response'], 'aceptada') !== false || stripos($data['response'], 'aprobada') !== false) {
            $statusNormalized = 'completado';
            $completed_at = date('Y-m-d H:i:s');
        } elseif (stripos($data['response'], 'rechazada') !== false || stripos($data['response'], 'fallida') !== false) {
            $statusNormalized = 'rechazado';
        }
        break;
}

writeLog("Estado normalizado: {$statusNormalized}");

// Verificar si ya existe la transacción por ref_payco
$checkEndpoint = "/rest/v1/transacciones?transaction_id=eq." . urlencode($data['ref_payco']);
$checkResult = supabaseRequest($checkEndpoint, 'GET');

if ($checkResult['code'] === 200) {
    $existing = json_decode($checkResult['response'], true);
    
    if (empty($existing)) {
        // SIEMPRE insertar la transacción, incluso si está rechazada o sin extra1
        // Esto es clave para tener HISTORIAL COMPLETO
        
        // Si no tenemos user_id, intentamos buscarlo por email o dejamos NULL
        $userId = !empty($data['extra1']) ? $data['extra1'] : null;
        
        // Si no tenemos extra2/extra3, intentamos determinarlos por el monto
        $credits_amount = intval($data['extra3'] ?: 0);
        $package_type = $data['extra2'] ?: 'desconocido';
        
        // Si no hay extra3 pero hay monto, intentamos inferir el paquete
        if ($credits_amount === 0 && $data['amount'] > 0) {
            $amount = floatval($data['amount']);
            if ($amount == 24900) {
                $credits_amount = 45;
                $package_type = 'basico';
            } elseif ($amount == 44900) {
                $credits_amount = 90;
                $package_type = 'estandar';
            } elseif ($amount == 54900) {
                $credits_amount = 180;
                $package_type = 'premium';
            }
        }
        
        $transaccionData = [
            'id' => generateUUID(),
            'user_id' => $userId,
            'transaction_id' => $data['ref_payco'],
            'credits_amount' => $credits_amount,
            'amount_paid' => floatval($data['amount'] ?: 0),
            'currency' => $data['currency'],
            'package_type' => $package_type,
            'status' => $statusNormalized,
            'payment_method' => $data['payment_method'] ?: $data['franchise'] ?: 'desconocido',
            'completed_at' => $completed_at,
            'created_at' => date('Y-m-d H:i:s')
        ];
        
        writeLog("Insertando transacción en Supabase: " . print_r($transaccionData, true));
        
        $insertResult = supabaseRequest('/rest/v1/transacciones', 'POST', $transaccionData);
        writeLog("Resultado inserción - Código: " . $insertResult['code'] . " - Respuesta: " . $insertResult['response']);
        
        // SOLO actualizar créditos si la transacción fue COMPLETADA y tenemos user_id
        if ($statusNormalized === 'completado' && !empty($userId) && $credits_amount > 0) {
            writeLog("Procesando actualización de créditos para usuario: {$userId}");
            
            // Obtener créditos actuales
            $userEndpoint = "/rest/v1/usuarios?id=eq." . urlencode($userId);
            $userResult = supabaseRequest($userEndpoint, 'GET');
            
            if ($userResult['code'] === 200) {
                $users = json_decode($userResult['response'], true);
                if (!empty($users)) {
                    $currentCredits = $users[0]['credits'] ?? 0;
                    $newCredits = $currentCredits + $credits_amount;
                    
                    writeLog("Actualizando créditos: {$currentCredits} + {$credits_amount} = {$newCredits}");
                    
                    $updateResult = supabaseRequest("/rest/v1/usuarios?id=eq." . urlencode($userId), 'PATCH', [
                        'credits' => $newCredits
                    ]);
                    
                    writeLog("Resultado actualización: " . $updateResult['code']);
                }
            }
        }
    } else {
        writeLog("La transacción YA EXISTE, actualizando estado si es necesario");
        
        // Si la transacción existe pero el estado cambió (ej: estaba pendiente y ahora completado)
        if ($existing[0]['status'] !== $statusNormalized) {
            $updateData = ['status' => $statusNormalized];
            if ($statusNormalized === 'completado') {
                $updateData['completed_at'] = date('Y-m-d H:i:s');
            }
            
            $updateResult = supabaseRequest("/rest/v1/transacciones?transaction_id=eq." . urlencode($data['ref_payco']), 'PATCH', $updateData);
            writeLog("Estado actualizado: " . $updateResult['code']);
        }
    }
} else {
    writeLog("ERROR consultando Supabase: " . $checkResult['response']);
}

// SIEMPRE responder OK para que ePayco no reintente [citation:2]
echo "OK";
writeLog("========== FIN NOTIFICACIÓN ==========\n");
?>