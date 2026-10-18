package com.primeanchor.smsphone;

import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.Telephony;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * 读手机彩信库（图片短信），整理成和 SmsRepo 一样的推送格式。
 *
 * 彩信分三张表：mms 一行一条，part 是正文/图片各一行，addr 是号码。
 * 规则和电脑端 electron/adb/mms.ts 一致，两边推上去的才对得上。
 */
final class MmsRepo {

    private MmsRepo() {}

    private static final Uri PART_URI = Uri.parse("content://mms/part");

    /** addr.type：137 = 发件人，151 = 收件人。 */
    private static final int ADDR_FROM = 137;
    private static final int ADDR_TO = 151;

    /** m_type：128 = 发出的，132 = 收到并已下载的。130 是「有彩信待下载」通知，没有内容，跳过。 */
    /**
     * 按时间 *或* 行号取新彩信。手动点「下载」的彩信下载完是新写的一行（行号更大），
     * 但 date 常常是对方当初发出的时间——比游标还早，只按时间取会漏掉它。
     */
    private static final String WHERE =
            "(date > ? OR _id > ?) AND msg_box != " + Telephony.Mms.MESSAGE_BOX_DRAFTS + " AND m_type IN (128,132)";

    /** 网站只收这几种；其它图片（如 HEIC）先转成 JPEG。 */
    static boolean webImage(String type) {
        return "image/jpeg".equals(type) || "image/png".equals(type)
                || "image/gif".equals(type) || "image/webp".equals(type);
    }

    /**
     * `sinceMs` 之后、或行号大于 `sinceId` 的彩信，按行号正序，最多 `limit` 条；
     * 顺带列出要补传的图片。`sinceId` 传 Long.MAX_VALUE = 只按时间。
     */
    static Batch readSince(Context context, long sinceMs, long sinceId, int limit) {
        JSONArray messages = new JSONArray();
        JSONArray images = new JSONArray();
        long maxDate = sinceMs;
        long maxId = sinceId == Long.MAX_VALUE ? 0 : sinceId;

        try (Cursor cursor = context.getContentResolver().query(
                Telephony.Mms.CONTENT_URI,
                new String[]{"_id", "date", "msg_box", "sub"},
                WHERE,
                // 彩信的 date 是秒
                new String[]{String.valueOf(sinceMs / 1000), String.valueOf(sinceId)},
                "_id ASC")) {
            if (cursor == null) return new Batch(messages, images, maxDate, maxId);

            while (cursor.moveToNext() && messages.length() < limit) {
                long id = cursor.getLong(0);
                long date = cursor.getLong(1) * 1000;
                int box = cursor.getInt(2);
                String direction = box == Telephony.Mms.MESSAGE_BOX_INBOX ? "in" : "out";

                StringBuilder body = new StringBuilder();
                int imageCount = 0;
                try (Cursor parts = context.getContentResolver().query(
                        PART_URI,
                        new String[]{"_id", "ct", "text"},
                        "mid = ?",
                        new String[]{String.valueOf(id)},
                        "_id ASC")) {
                    while (parts != null && parts.moveToNext()) {
                        long partId = parts.getLong(0);
                        String type = parts.getString(1) == null ? "" : parts.getString(1).toLowerCase();
                        if (type.equals("text/plain")) {
                            String text = parts.getString(2);
                            if (text != null && !text.trim().isEmpty()) {
                                if (body.length() > 0) body.append('\n');
                                body.append(text.trim());
                            }
                        } else if (type.startsWith("image/")) {
                            JSONObject image = new JSONObject();
                            image.put("id", "mms:" + id);
                            image.put("part", partId);
                            image.put("type", type);
                            images.put(image);
                            imageCount++;
                        }
                        // application/smil 等是排版描述，用户看不到，跳过
                    }
                }

                String subject = cursor.getString(3) == null ? "" : cursor.getString(3).trim();
                String text = body.length() > 0 ? body.toString() : subject;
                String address = address(context, id, direction);

                JSONObject message = new JSONObject();
                message.put("id", "mms:" + id);
                message.put("peer", SmsRepo.normalisePeer(address));
                message.put("address", address);
                message.put("direction", direction);
                message.put("kind", "mms");
                message.put("date", date);
                message.put("body", text);
                message.put("has_media", imageCount > 0);
                if ("out".equals(direction)) message.put("send_status", sendStatus(box));
                messages.put(message);

                if (date > maxDate) maxDate = date;
                if (id > maxId) maxId = id;
            }
        } catch (Exception e) {
            // 读不了就当这轮没有；彩信是附加功能，不能拖垮普通短信同步
        }
        return new Batch(messages, images, maxDate, maxId);
    }

    /** 彩信库里最大的行号，游标第一次建立时用。 */
    static long maxId(Context context) {
        try (Cursor cursor = context.getContentResolver().query(
                Telephony.Mms.CONTENT_URI, new String[]{"_id"}, null, null, "_id DESC")) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getLong(0);
        } catch (Exception e) {
            // 读不了就从 0 开始，下一轮再试
        }
        return 0;
    }

    /** 收到的取发件人，发出的取第一个收件人。 */
    private static String address(Context context, long id, String direction) {
        int want = "in".equals(direction) ? ADDR_FROM : ADDR_TO;
        try (Cursor cursor = context.getContentResolver().query(
                Uri.parse("content://mms/" + id + "/addr"),
                new String[]{"type", "address"},
                null, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                String address = cursor.getString(1);
                if (cursor.getInt(0) != want || address == null) continue;
                if (address.equals("insert-address-token")) continue; // 发出时的占位符
                return address;
            }
        } catch (Exception e) {
            // 没有号码就归到 (unknown)
        }
        return "";
    }

    /** msg_box: 2 已发 / 4 发件箱 / 5 失败。 */
    private static String sendStatus(int box) {
        if (box == Telephony.Mms.MESSAGE_BOX_FAILED) return "failed";
        if (box == Telephony.Mms.MESSAGE_BOX_OUTBOX) return "sending";
        return "sent";
    }

    /**
     * 读一张图片，必要时转成 JPEG。超过 `maxBytes` 或解不开返回 null。
     * 返回 [字节, 类型]。
     */
    static Object[] readImage(Context context, long partId, String type, int maxBytes) throws Exception {
        byte[] data;
        try (InputStream in = context.getContentResolver()
                .openInputStream(Uri.parse("content://mms/part/" + partId))) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) != -1) {
                out.write(buffer, 0, n);
                if (out.size() > maxBytes * 3) return null; // 原图大得离谱，转码也救不回来
            }
            data = out.toByteArray();
        }
        if (webImage(type) && data.length <= maxBytes) return new Object[]{data, type};

        // HEIC 之类浏览器看不了的、或太大的：解码后压成 JPEG
        Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length);
        if (bitmap == null) return null;
        ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, jpeg);
        bitmap.recycle();
        if (jpeg.size() > maxBytes) return null;
        return new Object[]{jpeg.toByteArray(), "image/jpeg"};
    }

    static final class Batch {
        final JSONArray messages;
        /** 要补传的图片：[{id, part, type}]。 */
        final JSONArray images;
        /** 这批里最新一条的时间（毫秒），推送成功后作为新的游标。 */
        final long maxDate;
        /** 这批里最大的行号，作为行号游标。 */
        final long maxId;

        Batch(JSONArray messages, JSONArray images, long maxDate, long maxId) {
            this.messages = messages;
            this.images = images;
            this.maxDate = maxDate;
            this.maxId = maxId;
        }
    }
}
