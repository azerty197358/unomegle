<?php
// IPs مسموحة (أو يمكن جلبها من قاعدة بيانات)
$allowed = ['197.205.96.254'];

// استخراج IP حقيقي (Cloudflare/Proxy)
function realIP() {
    foreach (['HTTP_CLIENT_IP', 'HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'] as $key) {
        if (!empty($_SERVER[$key])) {
            $ip = trim(explode(',', $_SERVER[$key])[0]);
            if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

$ip = realIP();
if (!in_array($ip, $allowed, true)) {
    http_response_code(403);
    exit('Forbidden');
}
// إذا وصلنا هنا فالـ IP صحيح
?>
