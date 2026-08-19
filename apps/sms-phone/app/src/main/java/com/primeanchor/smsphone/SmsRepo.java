package com.primeanchor.smsphone;

import android.content.Context;
import android.database.Cursor;
import android.provider.Telephony;

import org.json.JSONArray;
import org.json.JSONObject;

/** 读手机短信库，整理成网站 /api/device-sms/push 要的样子。 */
final class SmsRepo {

    private SmsRepo() {}

    /**
     * 号码归一化，用于把同一个人的短信归到一个会话。
     *
     * 必须和电脑端 normalisePeer 的规则一字不差（取后 10 位数字；8 位及以下
     * 视作服务短号原样保留；无数字的字母号码转大写）——两边算出来不一样，
     * 网站上同一个人就会裂成两个会话。
     */
    static String normalisePeer(String address) {
        String trimmed = address == null ? "" : address.trim();
        if (trimmed.isEmpty()) return "(unknown)";
        String digits = trimmed.replaceAll("[^0-9]", "");
        if (digits.isEmpty()) return trimmed.toUpperCase();
        if (digits.length() <= 8) return digits;
        return digits.substring(digits.length() - 10);
    }

    /**
     * `sinceMs` 之后的短信，按时间正序，最多 `limit` 条。
     *
     * 首次同步可能积压几百条，一次全推会超时；调用方每轮取一批、推完把游标
     * 往前挪，几轮就追平了。
     */
    static Batch readSince(Context context, long sinceMs, int limit) {
        JSONArray messages = new JSONArray();
        long maxDate = sinceMs;

        String[] projection = {"_id", "address", "date", "type", "read", "body"};
        try (Cursor cursor = context.getContentResolver().query(
                Telephony.Sms.CONTENT_URI,
                projection,
                "date > ?",
                new String[]{String.valueOf(sinceMs)},
                "date ASC")) {
            if (cursor == null) return new Batch(messages, maxDate);

            int count = 0;
            while (cursor.moveToNext() && count < limit) {
                long id = cursor.getLong(0);
                String address = cursor.getString(1) == null ? "" : cursor.getString(1);
                long date = cursor.getLong(2);
                int type = cursor.getInt(3);

                // 1 = 收件箱；2/4/5/6 = 发出（含发送中/失败）；3 = 草稿，跳过
                String direction;
                if (type == Telephony.Sms.MESSAGE_TYPE_INBOX) direction = "in";
                else if (type == Telephony.Sms.MESSAGE_TYPE_DRAFT) continue;
                else direction = "out";

                String body = cursor.getString(5) == null ? "" : cursor.getString(5);

                JSONObject message = new JSONObject();
                message.put("id", "sms:" + id);
                message.put("peer", normalisePeer(address));
                message.put("address", address);
                message.put("direction", direction);
                message.put("kind", "sms");
                message.put("date", date);
                message.put("body", body);
                messages.put(message);

                if (date > maxDate) maxDate = date;
                count++;
            }
        } catch (Exception e) {
            // 读不了就当这轮没有——权限被收回时 tick 循环里会把状态写出来
        }
        return new Batch(messages, maxDate);
    }

    static final class Batch {
        final JSONArray messages;
        /** 这批里最新一条的时间，推送成功后作为新的游标。 */
        final long maxDate;

        Batch(JSONArray messages, long maxDate) {
            this.messages = messages;
            this.maxDate = maxDate;
        }
    }
}
