package app.unimsg.android.node;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import androidx.core.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.os.Build;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import app.unimsg.android.MainActivity;
import app.unimsg.android.R;

/**
 * Notification channels and the two kinds of notification: the persistent service one and per-chat message ones.
 * Two channel groups, so Android's settings list them apart: "Chats" (Messages, Starred chats) and "UniChat itself"
 * (Background connection, Connection problems). The background notification is silent, minimal and in a group of its
 * own: it never bundles with message notifications, and the user can hide its channel without touching chats.
 */
final class Notifier {
    /** "service" replaces the old "backend" channel: a channel's importance can't be lowered once created, so it gets a new id (the old one is deleted). */
    static final String CH_SERVICE = "service", CH_MESSAGES = "messages", CH_STARRED = "starred", CH_ALERTS = "alerts";
    static final String GROUP_CHATS = "chats", GROUP_APP = "app";
    static final int SERVICE_ID = 1, ALERT_ID = 3, MESSAGE_ID = 2;

    static void createChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        nm.createNotificationChannelGroup(new NotificationChannelGroup(GROUP_CHATS, "Chats"));
        nm.createNotificationChannelGroup(new NotificationChannelGroup(GROUP_APP, "UniChat itself"));
        try { nm.deleteNotificationChannel("backend"); } catch (RuntimeException e) { /* still carrying the running service's notification: removed on a later start */ } // the old background channel
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Background connection", NotificationManager.IMPORTANCE_MIN);
        svc.setDescription("The permanent notice that keeps UniChat connected while the app is closed. You can hide it here; UniChat keeps running.");
        svc.setShowBadge(false); svc.setSound(null, null); svc.enableVibration(false); svc.setGroup(GROUP_APP);
        NotificationChannel msg = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("New messages"); msg.setGroup(GROUP_CHATS);
        NotificationChannel star = new NotificationChannel(CH_STARRED, "Starred chats", NotificationManager.IMPORTANCE_HIGH);
        star.setDescription("New messages in the chats you starred. Set a sound of its own here, or let only these through Do Not Disturb.");
        star.setGroup(GROUP_CHATS);
        NotificationChannel al = new NotificationChannel(CH_ALERTS, "Connection problems", NotificationManager.IMPORTANCE_DEFAULT);
        al.setDescription("Shown when Android stops the background connection and UniChat needs to be opened again"); al.setGroup(GROUP_APP);
        nm.createNotificationChannel(al);
        nm.createNotificationChannel(svc);
        nm.createNotificationChannel(msg);
        nm.createNotificationChannel(star);
    }

    static Notification serviceNotification(Context c, String text) {
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(c, CH_SERVICE).setSmallIcon(R.drawable.ic_stat_unimsg).setContentTitle("UniChat")
            .setContentText(text).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open).setSilent(true).setShowWhen(false)
            .setGroup("service").setPriority(NotificationCompat.PRIORITY_MIN) // its own group: Android never bundles it with chat notifications
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setVisibility(NotificationCompat.VISIBILITY_SECRET).build();
    }

    static void showMessage(Context c, String chatId, String messageId, String title, String body, String mode, String avatarB64, boolean starred) {
        post(c, chatId, messageId, title, body, mode, null, true, avatarB64, starred);
    }

    /** Decodes the chat picture sent by the backend (base64 PNG/JPEG/WebP, small) into a round bitmap for setLargeIcon. Returns null for anything unusable: the notification then simply has no picture. */
    static Bitmap avatarBitmap(String b64) {
        if (b64 == null || b64.isEmpty() || b64.length() > 200_000) return null;
        try {
            byte[] raw = Base64.decode(b64, Base64.DEFAULT);
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0 || bounds.outWidth > 4096 || bounds.outHeight > 4096) return null;
            Bitmap src = BitmapFactory.decodeByteArray(raw, 0, raw.length);
            if (src == null) return null;
            int size = 128, side = Math.min(src.getWidth(), src.getHeight());
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(out);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            cv.drawCircle(size / 2f, size / 2f, size / 2f, p);
            p.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN)); // center-crop the picture into the circle
            Rect from = new Rect((src.getWidth() - side) / 2, (src.getHeight() - side) / 2, (src.getWidth() + side) / 2, (src.getHeight() + side) / 2);
            cv.drawBitmap(src, from, new Rect(0, 0, size, size), p);
            if (src != out) src.recycle();
            return out;
        } catch (Throwable t) { return null; } // bad base64, bad image, out of memory: no picture
    }

    /** After a direct reply: replaces the notification (clears the inline-reply spinner), keeps the sent text as remote-input history. */
    static void showReplyResult(Context c, String chatId, String messageId, String sentText, boolean ok) {
        NativePrefs p = new NativePrefs(c);
        String mode = p.notifyContent();
        if (ok && sentText != null) post(c, chatId, messageId, "UniChat", "Reply sent", mode, sentText, false, null, false);
        else post(c, chatId, messageId, "UniChat", sentText == null ? "Nothing to send" : "Could not send your reply (backend not running or offline)", mode, null, false, null, false);
    }

    private static void post(Context c, String chatId, String messageId, String title, String body, String mode, String sentHistory, boolean alert, String avatarB64, boolean starred) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        boolean hidden = "hidden".equals(mode);
        // hidden: ONE generic notification for everything, no chat identity, no actions (nothing to leak through count, tag or reply target)
        String tag = hidden ? "hidden" : chatId;
        PendingIntent tap = PendingIntent.getActivity(c, tag.hashCode(), hidden ? new Intent(c, MainActivity.class) : MainActivity.openChatIntent(c, chatId), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String ch = starred && !hidden ? CH_STARRED : CH_MESSAGES; // hidden content: one generic notification, no starred identity either
        Notification pub = new NotificationCompat.Builder(c, ch).setSmallIcon(R.drawable.ic_stat_unimsg).setContentTitle("UniChat").setContentText("New message").build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, ch).setSmallIcon(R.drawable.ic_stat_unimsg)
            .setContentTitle(title).setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true).setContentIntent(tap).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(pub) // lock screen shows the generic version
            .setGroup("messages").setPriority(NotificationCompat.PRIORITY_HIGH).setOnlyAlertOnce(!alert);
        if (!hidden) { Bitmap av = avatarBitmap(avatarB64); if (av != null) b.setLargeIcon(av); } // hidden: never a personal picture
        if (!hidden && sentHistory != null) b.setRemoteInputHistory(new CharSequence[]{sentHistory});
        if (!hidden) {
            int flagsMut = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0); // RemoteInput needs a mutable PI
            Intent reply = new Intent(c, NotificationActionReceiver.class).setAction(NotificationActionReceiver.ACTION_REPLY)
                .putExtra(NotificationActionReceiver.EXTRA_CHAT, chatId).putExtra(NotificationActionReceiver.EXTRA_MESSAGE, messageId);
            PendingIntent replyPi = PendingIntent.getBroadcast(c, tag.hashCode() * 2, reply, flagsMut);
            RemoteInput ri = new RemoteInput.Builder(NotificationActionReceiver.KEY_REPLY).setLabel("Reply").build();
            b.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_unimsg, "Reply", replyPi).addRemoteInput(ri)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setShowsUserInterface(false).build());
            Intent read = new Intent(c, NotificationActionReceiver.class).setAction(NotificationActionReceiver.ACTION_READ)
                .putExtra(NotificationActionReceiver.EXTRA_CHAT, chatId).putExtra(NotificationActionReceiver.EXTRA_MESSAGE, messageId);
            PendingIntent readPi = PendingIntent.getBroadcast(c, tag.hashCode() * 2 + 1, read, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_stat_unimsg, "Mark as read", readPi)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ).setShowsUserInterface(false).build());
        }
        NotificationManagerCompat.from(c).notify(tag, MESSAGE_ID, b.build());
    }

    /** The chat was read: take its notification off the shade (tag = chat id, or "hidden" when the content is hidden). */
    static void clearChat(Context c, String chatId) {
        if (chatId == null || chatId.isEmpty()) return;
        NotificationManagerCompat m = NotificationManagerCompat.from(c);
        m.cancel(chatId, MESSAGE_ID);
        if ("hidden".equals(new NativePrefs(c).notifyContent())) m.cancel("hidden", MESSAGE_ID); // one shared notification, no chat identity
    }

    /**
     * The message notification that carries no chat id ("hidden" content mode). Never cancelAll(): that would take the
     * foreground-service notification with it, and the service must keep one.
     */
    static void clearMessages(Context c) { NotificationManagerCompat.from(c).cancel("hidden", MESSAGE_ID); }

    /** Alert shown when the system stopped/refused our foreground service (timeout, boot restriction). Tap opens the app, which can always restart it. */
    static void showReconnectNeeded(Context c, String text) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        createChannels(c);
        PendingIntent open = PendingIntent.getActivity(c, 7, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(c, CH_ALERTS).setSmallIcon(R.drawable.ic_stat_unimsg).setContentTitle("UniChat is not connected")
            .setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true).setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_STATUS).setVisibility(NotificationCompat.VISIBILITY_PUBLIC).build();
        NotificationManagerCompat.from(c).notify(ALERT_ID, n);
    }
}
