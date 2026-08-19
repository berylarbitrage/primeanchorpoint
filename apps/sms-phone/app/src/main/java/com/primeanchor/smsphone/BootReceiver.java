package com.primeanchor.smsphone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/** 开机自动把同步服务拉起来——配置过令牌才拉，没配置说明还没用起来。 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences("cfg", Context.MODE_PRIVATE);
        if (prefs.getString("token", "").isEmpty()) return;
        try {
            context.startForegroundService(new Intent(context, SyncService.class));
        } catch (Exception ignored) {
            // 某些系统限制开机启动前台服务；用户打开一次 App 也会启动
        }
    }
}
