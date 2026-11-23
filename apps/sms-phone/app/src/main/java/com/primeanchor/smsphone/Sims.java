package com.primeanchor.smsphone;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 双卡手机：短信是哪张卡收发的、手机上有哪几张卡。
 *
 * 短信库里每条都有 sub_id（哪张卡），网站靠它把两个号的短信分开显示；
 * 网站发短信时也会告诉手机用哪张卡（sub_id）发。
 */
final class Sims {

    private Sims() {}

    private static final String COL = "sub_id";
    private static final Map<Uri, Boolean> HAS_COL = new HashMap<>();

    /**
     * 短信库有没有 sub_id 这一列——标准安卓都有，个别改过的系统没有；
     * 查询里带了不存在的列整个查询都会失败，所以先试一下。
     */
    static synchronized boolean hasSubId(Context context, Uri uri) {
        Boolean known = HAS_COL.get(uri);
        if (known != null) return known;
        boolean ok;
        try (Cursor c = context.getContentResolver().query(uri, new String[]{"_id", COL}, "_id < 0", null, null)) {
            ok = true;
        } catch (Exception e) {
            ok = false;
        }
        HAS_COL.put(uri, ok);
        return ok;
    }

    /** 查询列后面加上 sub_id（有的话）。 */
    static String[] withSubId(Context context, Uri uri, String[] base) {
        if (!hasSubId(context, uri)) return base;
        String[] out = new String[base.length + 1];
        System.arraycopy(base, 0, out, 0, base.length);
        out[base.length] = COL;
        return out;
    }

    /** 读出 sub_id；没有这一列或是空的返回 -1。 */
    static int subId(Cursor cursor, String[] projection) {
        int idx = projection.length - 1;
        if (!COL.equals(projection[idx]) || cursor.isNull(idx)) return -1;
        return cursor.getInt(idx);
    }

    /** 手机上现在插着的卡: [{sub_id, slot, carrier, name, number}]。没权限时是空的。 */
    static JSONArray list(Context context) {
        JSONArray out = new JSONArray();
        try {
            if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE)
                    != PackageManager.PERMISSION_GRANTED) return out;
            SubscriptionManager sm = context.getSystemService(SubscriptionManager.class);
            List<SubscriptionInfo> subs = sm == null ? null : sm.getActiveSubscriptionInfoList();
            if (subs == null) return out;
            for (SubscriptionInfo si : subs) {
                JSONObject sim = new JSONObject();
                sim.put("sub_id", si.getSubscriptionId());
                sim.put("slot", si.getSimSlotIndex());
                sim.put("carrier", si.getCarrierName() == null ? "" : si.getCarrierName().toString());
                sim.put("name", si.getDisplayName() == null ? "" : si.getDisplayName().toString());
                sim.put("number", number(context, sm, si));
                out.put(sim);
            }
        } catch (Exception e) {
            // 读不了卡的信息不影响同步，网站上手动选号就行
        }
        return out;
    }

    /** 卡里写的本机号码（运营商不写就是空的）。 */
    @SuppressWarnings("deprecation")
    private static String number(Context context, SubscriptionManager sm, SubscriptionInfo si) {
        try {
            if (context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS)
                    != PackageManager.PERMISSION_GRANTED
                    && context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE)
                    != PackageManager.PERMISSION_GRANTED) return "";
            String n = Build.VERSION.SDK_INT >= 33 ? sm.getPhoneNumber(si.getSubscriptionId()) : si.getNumber();
            return n == null ? "" : n;
        } catch (Exception e) {
            return "";
        }
    }
}
