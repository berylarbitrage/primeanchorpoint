package com.primeanchor.smsphone;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 跟网站说话的最小 HTTP 封装。
 *
 * 故意不用任何网络库：HttpURLConnection 和 org.json 都是系统自带的，
 * 少一个依赖就少一种编译失败和一份体积。
 */
final class Api {

    private Api() {}

    static JSONObject postJson(String url, String token, JSONObject body) throws Exception {
        return request("POST", url, token, body);
    }

    static JSONObject getJson(String url, String token) throws Exception {
        return request("GET", url, token, null);
    }

    private static JSONObject request(String method, String url, String token, JSONObject body)
            throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                }
            }

            int code = conn.getResponseCode();
            InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(stream);
            if (code == 401) throw new IOException("网站不认这个令牌，请重新生成一个");
            if (code >= 400) {
                throw new IOException("网站返回 " + code
                        + (text.isEmpty() ? "" : ": " + text.substring(0, Math.min(120, text.length()))));
            }
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int n;
        while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n);
        return out.toString("UTF-8").trim();
    }
}
