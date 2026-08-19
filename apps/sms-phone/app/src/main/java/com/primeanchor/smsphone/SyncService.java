package com.primeanchor.smsphone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.provider.Settings;
import android.telephony.SmsManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * 常驻同步服务：每 10 秒一轮。
 *
 *  1. 把新短信推到网站（服务器那边负责翻译和风险分）；
 *  2. 把网站上排队的短信用 SmsManager 直接发出去——这是真·直发，
 *     不是电脑那套「唤起短信 App 模拟点按钮」。
 *
 * 手机自己有网就行（WiFi 或流量都可以），没有任何要跟电脑保持的连接，
 * 也就没有「掉线」这个概念了。
 */
public class SyncService extends Service {

    /** 界面上的「立即同步」按钮发这个 action，马上跑一轮而不等 10 秒。 */
    public static final String ACTION_SYNC_NOW = "com.primeanchor.smsphone.SYNC_NOW";

    private static final String CHANNEL = "sync";
    private static final long TICK_MS = 10_000;
    /** 首次运行导入最近这么多天。 */
    private static final long FIRST_IMPORT_MS = 30L * 24 * 3600 * 1000;
    /** 游标回看窗口：短信写入时间偶尔比上一条还早一点。 */
    private static final long OVERLAP_MS = 60_000;

    private HandlerThread thread;
    private Handler handler;
    private volatile boolean running;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            doTick();
            if (running && handler != null) handler.postDelayed(this, TICK_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel =
                new NotificationChannel(CHANNEL, "短信同步", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("保持短信和网站之间的同步");
        manager.createNotificationChannel(channel);

        thread = new HandlerThread("sync");
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setContentTitle("短信同步运行中")
                .setContentText("短信会自动同步到公司网站")
                .setSmallIcon(R.drawable.ic_stat)
                .setOngoing(true)
                .build();

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(1, notification);
        }

        if (!running) {
            running = true;
            handler.post(tick);
        } else if (intent != null && ACTION_SYNC_NOW.equals(intent.getAction())) {
            // 只补跑一轮，不再排一个新循环——排了就成双循环了
            handler.post(this::doTick);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (thread != null) thread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── 一轮同步 ──

    private void doTick() {
        SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        // 心跳：界面靠它判断服务是不是真的活着（被系统杀了心跳就停在过去）
        prefs.edit().putLong("beat", System.currentTimeMillis()).apply();

        String base = prefs.getString("url", "").trim();
        String token = prefs.getString("token", "").trim();
        if (base.isEmpty() || token.isEmpty()) {
            status(prefs, "还没填网址或令牌");
            return;
        }
        String api = base.replaceAll("/+$", "") + "/api/device-sms";

        try {
            int pushed = pushNew(api, token, prefs);
            int sent = drainOutbox(api, token);
            if (pushed > 0) {
                prefs.edit().putLong("pushedTotal", prefs.getLong("pushedTotal", 0) + pushed).apply();
            }
            if (sent > 0) {
                prefs.edit().putLong("sentTotal", prefs.getLong("sentTotal", 0) + sent).apply();
            }
            prefs.edit().putString("lastError", "").apply();
            status(prefs, "正常 · " + now() + " 已同步");
        } catch (Exception e) {
            String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            prefs.edit().putString("lastError", now() + " " + message).apply();
            status(prefs, "出错: " + message);
        }
    }

    private int pushNew(String api, String token, SharedPreferences prefs) throws Exception {
        long cursor = prefs.getLong("cursor", 0);
        if (cursor == 0) cursor = System.currentTimeMillis() - FIRST_IMPORT_MS;

        SmsRepo.Batch batch = SmsRepo.readSince(this, cursor - OVERLAP_MS, 200);
        if (batch.messages.length() == 0) return 0;

        JSONObject body = new JSONObject();
        body.put("device_serial", serial());
        body.put("messages", batch.messages);
        Api.postJson(api + "/push", token, body);

        // 服务器收下了才挪游标；失败下一轮原样重推（服务器按 id 覆盖，安全）
        prefs.edit().putLong("cursor", batch.maxDate).apply();
        return batch.messages.length();
    }

    private int drainOutbox(String api, String token) throws Exception {
        JSONObject response = Api.getJson(api + "/outbox", token);
        JSONArray queued = response.optJSONArray("messages");
        if (queued == null) return 0;
        int sent = 0;

        for (int i = 0; i < queued.length(); i++) {
            JSONObject item = queued.getJSONObject(i);
            long id = item.getLong("id");
            boolean ok;
            String note;
            try {
                sendSms(item.getString("to_address"), item.getString("body"));
                ok = true;
                note = "已从手机直接发出";
            } catch (Exception e) {
                ok = false;
                note = String.valueOf(e.getMessage());
            }
            JSONObject result = new JSONObject();
            result.put("ok", ok);
            result.put("note", note);
            Api.postJson(api + "/outbox/" + id + "/result", token, result);
            if (ok) sent++;
        }
        return sent;
    }

    private void sendSms(String to, String body) {
        SmsManager manager = Build.VERSION.SDK_INT >= 31
                ? getSystemService(SmsManager.class)
                : SmsManager.getDefault();
        ArrayList<String> parts = manager.divideMessage(body);
        // 系统会替非默认短信 App 把发出的短信写进短信库，下一轮 pushNew 自然带上去
        if (parts.size() == 1) {
            manager.sendTextMessage(to, null, body, null, null);
        } else {
            manager.sendMultipartTextMessage(to, null, parts, null, null);
        }
    }

    private String serial() {
        String androidId =
                Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        return "app-" + (androidId == null ? "unknown" : androidId);
    }

    private void status(SharedPreferences prefs, String text) {
        prefs.edit().putString("status", text).apply();
    }

    private static String now() {
        return new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
    }
}
