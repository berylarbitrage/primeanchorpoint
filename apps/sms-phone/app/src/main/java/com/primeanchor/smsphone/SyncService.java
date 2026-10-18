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
import android.util.Base64;
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
            pushSendStatus(api, token, prefs);
            pushed += pushMms(api, token, prefs);
            uploadMmsImages(api, token, prefs);
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
        JSONObject resp = Api.postJson(api + "/push", token, body);

        // 服务器收下了才挪游标；失败下一轮原样重推（服务器按 id 覆盖，安全）
        // lastPush 给界面看：推了几条、服务器实际存了几条（重复的会被服务器丢掉）
        prefs.edit().putLong("cursor", batch.maxDate)
                .putString("lastPush", now() + " 推 " + batch.messages.length()
                        + " 条，服务器存 " + resp.optInt("saved", -1) + " 条")
                .apply();
        rememberSendStatus(prefs, batch.messages, false);
        return batch.messages.length();
    }

    // ── 彩信（图片短信） ──

    /** 网站单张图片上限。 */
    private static final int MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    /** 每轮补传几张，一张就是一次几百 KB 到几 MB 的上传。 */
    private static final int IMAGES_PER_TICK = 4;

    /**
     * 新彩信推上网站（游标和短信分开记），里面的图片排进补传队列。
     * 图片要等短信那一行在网站上有了才能挂上去，所以先推消息、再传图。
     */
    private int pushMms(String api, String token, SharedPreferences prefs) throws Exception {
        // 0.7.0 把网站返回的 404（网站还没部署）当成「这张传不了」直接放弃了。
        // 升级后清掉记录、从头重扫一次，那些图才补得回来（重复推送服务器会覆盖，安全）。
        if (prefs.getInt("mmsRescan", 0) < 1) {
            prefs.edit().putLong("mmsCursor", 0).putString("mmsImagesDone", "")
                    .putString("mmsImageQueue", "[]").putInt("mmsRescan", 1).apply();
        }
        long cursor = prefs.getLong("mmsCursor", 0);
        if (cursor == 0) cursor = System.currentTimeMillis() - FIRST_IMPORT_MS;

        MmsRepo.Batch batch = MmsRepo.readSince(this, cursor - OVERLAP_MS, 50);
        if (batch.messages.length() == 0) return 0;

        JSONObject body = new JSONObject();
        body.put("device_serial", serial());
        body.put("messages", batch.messages);
        Api.postJson(api + "/push", token, body);

        // 回看窗口会重读上一轮的彩信，按 id+part 去重，同一张图不排两次
        JSONArray queue = imageQueue(prefs);
        java.util.Set<String> queued = new java.util.HashSet<>();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject q = queue.getJSONObject(i);
            queued.add(q.getString("id") + "#" + q.getLong("part"));
        }
        java.util.Set<String> done = new java.util.HashSet<>(
                java.util.Arrays.asList(prefs.getString("mmsImagesDone", "").split(",")));
        for (int i = 0; i < batch.images.length(); i++) {
            JSONObject image = batch.images.getJSONObject(i);
            String key = image.getString("id") + "#" + image.getLong("part");
            if (queued.add(key) && !done.contains(key)) queue.put(image);
        }
        prefs.edit().putLong("mmsCursor", batch.maxDate)
                .putString("mmsImageQueue", queue.toString())
                .apply();
        return batch.messages.length();
    }

    /** 从队列头补传几张图片。传不上（网站挂了/没网）就停下，下一轮接着传。 */
    private void uploadMmsImages(String api, String token, SharedPreferences prefs) throws Exception {
        JSONArray queue = imageQueue(prefs);
        if (queue.length() == 0) return;

        JSONArray rest = new JSONArray();
        StringBuilder done = new StringBuilder(prefs.getString("mmsImagesDone", ""));
        int tried = 0;
        boolean stop = false;
        for (int i = 0; i < queue.length(); i++) {
            JSONObject image = queue.getJSONObject(i);
            if (stop || tried >= IMAGES_PER_TICK) {
                rest.put(image);
                continue;
            }
            tried++;
            String key = image.getString("id") + "#" + image.getLong("part");
            boolean finished;
            try {
                Object[] read = MmsRepo.readImage(this, image.getLong("part"),
                        image.optString("type"), MAX_IMAGE_BYTES);
                if (read == null) {
                    finished = true; // 太大或解不开，重试也一样
                } else {
                    JSONObject body = new JSONObject();
                    body.put("id", image.getString("id"));
                    body.put("part_id", image.getLong("part"));
                    body.put("type", read[1]);
                    body.put("data", Base64.encodeToString((byte[]) read[0], Base64.NO_WRAP));
                    Api.postJson(api + "/media-in", token, body);
                    finished = true;
                }
            } catch (Api.HttpError e) {
                // 400（不收这种图）/ 422（网站上没有这条）重试也没用；
                // 404 是网站还没部署这个接口，和 5xx 一样留着下轮再来
                finished = e.code == 400 || e.code == 422;
                if (!finished) stop = true;
                prefs.edit().putString("mmsImageError", now() + " " + e.getMessage()).apply();
            } catch (Exception e) {
                stop = true; // 没网等，下一轮再传
                finished = false;
                prefs.edit().putString("mmsImageError", now() + " " + e.getMessage()).apply();
            }
            if (finished) {
                done.append(done.length() > 0 ? "," : "").append(key);
                prefs.edit().putLong("mmsImagesSent", prefs.getLong("mmsImagesSent", 0) + 1).apply();
            }
            else rest.put(image);
        }

        // 已传记录只留最近这些，回看窗口用得到就够了
        String doneList = done.toString();
        if (doneList.length() > 8000) doneList = doneList.substring(doneList.indexOf(',', doneList.length() - 8000) + 1);
        prefs.edit().putString("mmsImageQueue", rest.toString())
                .putString("mmsImagesDone", doneList)
                .apply();
    }

    private static JSONArray imageQueue(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString("mmsImageQueue", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** 最近发出的短信多久之内还要盯着状态变化。 */
    private static final long SEND_STATUS_WATCH_MS = 24L * 60 * 60 * 1000;

    /**
     * 最近发出的短信里，发送状态和上次推的不一样的，补推一次。
     * 网页上「发送中 / 已发送 / 已送达 / 发送失败」就靠这个跟上手机。
     */
    private void pushSendStatus(String api, String token, SharedPreferences prefs) throws Exception {
        JSONArray recent = SmsRepo.readRecentOutgoing(this,
                System.currentTimeMillis() - SEND_STATUS_WATCH_MS, 100);
        JSONObject seen = seenSendStatus(prefs);
        JSONArray changed = new JSONArray();
        for (int i = 0; i < recent.length(); i++) {
            JSONObject m = recent.getJSONObject(i);
            if (!m.optString("send_status").equals(seen.optString(m.getString("id")))) changed.put(m);
        }
        if (changed.length() > 0) {
            JSONObject body = new JSONObject();
            body.put("device_serial", serial());
            body.put("messages", changed);
            Api.postJson(api + "/push", token, body);
        }
        // 只留这 24 小时内的，记录不会越积越多
        rememberSendStatus(prefs, recent, true);
    }

    private static JSONObject seenSendStatus(SharedPreferences prefs) {
        try {
            return new JSONObject(prefs.getString("sendStatusSeen", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void rememberSendStatus(SharedPreferences prefs, JSONArray messages, boolean replace)
            throws Exception {
        JSONObject seen = replace ? new JSONObject() : seenSendStatus(prefs);
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m = messages.getJSONObject(i);
            if (m.has("send_status")) seen.put(m.getString("id"), m.getString("send_status"));
        }
        prefs.edit().putString("sendStatusSeen", seen.toString()).apply();
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
