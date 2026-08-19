package com.primeanchor.smsphone;

import android.Manifest;
import android.app.Activity;
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
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

/** 设置页：网址 + 令牌，一个启动按钮，一行实时状态。能不给用户看的都不给看。 */
public class MainActivity extends Activity {

    private EditText urlInput;
    private EditText tokenInput;
    private TextView statusView;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
            statusView.setText("状态：" + prefs.getString("status", "还没启动"));
            ui.postDelayed(this, 2000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        urlInput = findViewById(R.id.url);
        tokenInput = findViewById(R.id.token);
        statusView = findViewById(R.id.status);
        Button startButton = findViewById(R.id.start);
        Button stopButton = findViewById(R.id.stop);

        SharedPreferences prefs = getSharedPreferences("cfg", MODE_PRIVATE);
        urlInput.setText(prefs.getString("url", "https://primeanchorpoint.com"));
        tokenInput.setText(prefs.getString("token", ""));

        startButton.setOnClickListener(v -> saveAndStart());
        stopButton.setOnClickListener(v -> {
            stopService(new Intent(this, SyncService.class));
            prefs.edit().putString("status", "已停止").apply();
        });
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
        requestPermissions(permissions, 1);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            // 三星对旁路安装的 App 会把 SMS 权限锁成「受限设置」，路径要指给人看
            Toast.makeText(this,
                    "没拿到短信权限。若设置里是灰的：应用信息 → 右上角 ⋮ → 允许受限设置，再来一次",
                    Toast.LENGTH_LONG).show();
            return;
        }

        startForegroundService(new Intent(this, SyncService.class));
        Toast.makeText(this, "已启动，短信开始同步", Toast.LENGTH_SHORT).show();

        // 让系统别为了省电把服务杀了——这是「装了却收不到」的第一大原因
        PowerManager power = getSystemService(PowerManager.class);
        if (power != null && !power.isIgnoringBatteryOptimizations(getPackageName())) {
            try {
                startActivity(new Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {
                // 个别 ROM 不认这个 intent；服务照样启动，只是可能被杀
            }
        }
    }
}
