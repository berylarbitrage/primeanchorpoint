package com.primeanchor.smsphone;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面。0.2.0 重做：状态放最上面、大字、带颜色；每一项权限单独显示 ✓/✗
 * 并带「修」按钮；「立即同步」点了几秒内就能看到结果。
 * 目标：不懂技术的人打开就能看出哪里不对、点哪里能修好。
 */
public class MainActivity extends Activity {

    private static final int REQ_START = 1;
    private static final int REQ_FIX = 2;
    /** 服务每 10 秒写一次心跳；超过这个时长没写，就是被系统杀了。 */
    private static final long BEAT_STALE_MS = 35_000;

    private static final int GREEN = 0xFF1E8E3E;
    private static final int RED = 0xFFC5221F;
    private static final int GRAY = 0xFF6B7280;

    private TextView statusCard;
    private TextView lastErrorView;
    private TextView countersView;
    private TextView checkReadSms;
    private TextView checkSendSms;
    private TextView checkNotify;
    private TextView checkBattery;
    private Button fixReadSms;
    private Button fixSendSms;
    private Button fixNotify;
    private Button fixBattery;
    private EditText urlInput;
    private EditText tokenInput;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            refreshNow();
            ui.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusCard = findViewById(R.id.statusCard);
        lastErrorView = findViewById(R.id.lastError);
        countersView = findViewById(R.id.counters);
        checkReadSms = findViewById(R.id.checkReadSms);
        checkSendSms = findViewById(R.id.checkSendSms);
        checkNotify = findViewById(R.id.checkNotify);
        checkBattery = findViewById(R.id.checkBattery);
        fixReadSms = findViewById(R.id.fixReadSms);
        fixSendSms = findViewById(R.id.fixSendSms);
        fixNotify = findViewById(R.id.fixNotify);
        fixBattery = findViewById(R.id.fixBattery);
        urlInput = findViewById(R.id.url);
        tokenInput = findViewById(R.id.token);

        SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        urlInput.setText(prefs.getString("url", "https://primeanchorpoint.com"));
        tokenInput.setText(prefs.getString("token", ""));

        findViewById(R.id.syncNow).setOnClickListener(v -> syncNow());
        findViewById(R.id.start).setOnClickListener(v -> saveAndStart());
        findViewById(R.id.stop).setOnClickListener(v -> {
            stopService(new Intent(this, SyncService.class));
            prefs.edit().putString("status", "已停止").apply();
            refreshNow();
        });

        fixReadSms.setOnClickListener(v ->
                requestPermissions(new String[]{Manifest.permission.READ_SMS}, REQ_FIX));
        fixSendSms.setOnClickListener(v ->
                requestPermissions(new String[]{Manifest.permission.SEND_SMS}, REQ_FIX));
        fixNotify.setOnClickListener(v -> fixNotify());
        fixBattery.setOnClickListener(v -> askIgnoreBattery());
    }

    @Override
    protected void onResume() {
        super.onResume();
        ui.post(refresh);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(refresh);
    }

    // ── 状态刷新 ──

    private void refreshNow() {
        SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        String status = prefs.getString("status", "");
        long beat = prefs.getLong("beat", 0);
        long beatAge = System.currentTimeMillis() - beat;

        if (status.isEmpty()) {
            paint(GRAY, "还没启动\n填好下面的网址和令牌，点「保存并启动」");
        } else if ("已停止".equals(status)) {
            paint(GRAY, "已停止\n要恢复就点「保存并启动」");
        } else if (beat > 0 && beatAge > BEAT_STALE_MS) {
            paint(RED, "✗ 服务没在跑（可能被系统杀了）\n点「保存并启动」重启，再把下面「电池不限制」修成 ✓");
        } else if (status.startsWith("正常")) {
            paint(GREEN, "✓ " + status);
        } else {
            paint(RED, "✗ " + status);
        }

        String lastError = prefs.getString("lastError", "");
        lastErrorView.setVisibility(lastError.isEmpty() ? View.GONE : View.VISIBLE);
        if (!lastError.isEmpty()) lastErrorView.setText("最近一次错误：" + lastError);

        countersView.setText("已推到网站 " + prefs.getLong("pushedTotal", 0)
                + " 条 · 已替网站发出 " + prefs.getLong("sentTotal", 0) + " 条");

        NotificationManager notifications = getSystemService(NotificationManager.class);
        PowerManager power = getSystemService(PowerManager.class);
        check(checkReadSms, fixReadSms, has(Manifest.permission.READ_SMS),
                "读短信权限", "收不到别人的短信就是因为它");
        check(checkSendSms, fixSendSms, has(Manifest.permission.SEND_SMS),
                "发短信权限", "网站上发不出去就是因为它");
        check(checkNotify, fixNotify, notifications != null && notifications.areNotificationsEnabled(),
                "通知权限", "开着才看得到「同步运行中」");
        check(checkBattery, fixBattery,
                power != null && power.isIgnoringBatteryOptimizations(getPackageName()),
                "电池不限制", "不修的话系统过一会就把同步杀了");
    }

    private boolean has(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void paint(int color, String text) {
        statusCard.setBackgroundColor(color);
        statusCard.setText(text);
    }

    private void check(TextView view, Button fix, boolean ok, String name, String why) {
        if (ok) {
            view.setText("✓ " + name);
            view.setTextColor(GREEN);
            fix.setVisibility(View.GONE);
        } else {
            view.setText("✗ " + name + " — " + why);
            view.setTextColor(RED);
            fix.setVisibility(View.VISIBLE);
        }
    }

    // ── 按钮动作 ──

    private void syncNow() {
        SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        if (prefs.getString("url", "").trim().isEmpty()
                || prefs.getString("token", "").trim().isEmpty()) {
            Toast.makeText(this, "先填网址和令牌，点「保存并启动」", Toast.LENGTH_SHORT).show();
            return;
        }
        // 服务活着就补跑一轮；被杀了这一下也会把它拉起来
        startForegroundService(new Intent(this, SyncService.class)
                .setAction(SyncService.ACTION_SYNC_NOW));
        Toast.makeText(this, "正在同步……几秒后看最上面的状态", Toast.LENGTH_SHORT).show();
    }

    private void saveAndStart() {
        String url = urlInput.getText().toString().trim();
        String token = tokenInput.getText().toString().trim();
        if (url.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "网址和令牌都要填", Toast.LENGTH_SHORT).show();
            return;
        }
        getSharedPreferences("cfg", MODE_PRIVATE)
                .edit().putString("url", url).putString("token", token).apply();

        String[] permissions = Build.VERSION.SDK_INT >= 33
                ? new String[]{Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS,
                        Manifest.permission.POST_NOTIFICATIONS}
                : new String[]{Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS};
        requestPermissions(permissions, REQ_START);
    }

    private void fixNotify() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_FIX);
            return;
        }
        // 权限有了但 App 通知被整体关掉：带去本 App 的通知设置页
        try {
            startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
        } catch (Exception ignored) {
        }
    }

    private void askIgnoreBattery() {
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null && power.isIgnoringBatteryOptimizations(getPackageName())) return;
        try {
            startActivity(new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // 个别 ROM 不认这个 intent；界面上那行会一直显示 ✗ 提醒
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);

        if (requestCode == REQ_FIX) {
            boolean denied = false;
            for (String permission : permissions) {
                if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) denied = true;
            }
            if (denied) {
                // 三星把旁路安装 App 的短信权限锁成「受限设置」，弹窗根本不出来，只能手动开
                Toast.makeText(this,
                        "系统不给弹窗。去：应用信息 → 右上角 ⋮ → 允许受限设置 → 权限 → 短信 → 允许",
                        Toast.LENGTH_LONG).show();
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) {
                }
            }
            refreshNow();
            return;
        }

        // REQ_START：保存并启动
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this,
                    "没拿到短信权限。若设置里是灰的：应用信息 → 右上角 ⋮ → 允许受限设置，再来一次",
                    Toast.LENGTH_LONG).show();
            refreshNow();
            return;
        }

        startForegroundService(new Intent(this, SyncService.class));
        Toast.makeText(this, "已启动，短信开始同步", Toast.LENGTH_SHORT).show();
        askIgnoreBattery();
        refreshNow();
    }
}
