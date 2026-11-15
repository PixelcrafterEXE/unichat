package app.unimsg.android.node;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import androidx.core.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import app.unimsg.android.MainActivity;
import app.unimsg.android.R;

/** Notification channels and the two kinds of notification: the persistent service one and per-chat message ones. */
final class Notifier {
    static final String CH_SERVICE = "backend", CH_MESSAGES = "messages", CH_ALERTS = "alerts";
    static final int SERVICE_ID = 1, ALERT_ID = 3, MESSAGE_ID = 2;

    static void createChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel svc = new NotificationChannel(CH_SERVICE, "Background connection", NotificationManager.IMPORTANCE_LOW);
        svc.setDescription("Keeps UniChat connected to your messengers while the app is closed");
        svc.setShowBadge(false);
        NotificationChannel msg = new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        msg.setDescription("New messages");
        NotificationChannel al = new NotificationChannel(CH_ALERTS, "Connection problems", NotificationManager.IMPORTANCE_DEFAULT);
        al.setDescription("Shown when Android stops the background connection and UniChat needs to be opened again");
        nm.createNotificationChannel(al);
        nm.createNotificationChannel(svc);
        nm.createNotificationChannel(msg);
    }

    static Notification serviceNotification(Context c, String text) {
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(c, CH_SERVICE).setSmallIcon(R.drawable.ic_stat_unimsg).setContentTitle("UniChat")
            .setContentText(text).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open)
            .setCategory(NotificationCompat.CATEGORY_SERVICE).setVisibility(NotificationCompat.VISIBILITY_SECRET).build();
    }

    static void showMessage(Context c, String chatId, String messageId, String title, String body, String mode) {
        post(c, chatId, messageId, title, body, mode, null, true);
    }

    /** After a direct reply: replaces the notification (clears the inline-reply spinner), keeps the sent text as remote-input history. */
    static void showReplyResult(Context c, String chatId, String messageId, String sentText, boolean ok) {
        NativePrefs p = new NativePrefs(c);
        String mode = p.notifyContent();
        if (ok && sentText != null) post(c, chatId, messageId, "UniChat", "Reply sent", mode, sentText, false);
        else post(c, chatId, messageId, "UniChat", sentText == null ? "Nothing to send" : "Could not send your reply (backend not running or offline)", mode, null, false);
    }

    private static void post(Context c, String chatId, String messageId, String title, String body, String mode, String sentHistory, boolean alert) {
        if (Build.VERSION.SDK_INT >= 33 && c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        boolean hidden = "hidden".equals(mode);
        // hidden: ONE generic notification for everything, no chat identity, no actions (nothing to leak through count, tag or reply target)
        String tag = hidden ? "hidden" : chatId;
        PendingIntent tap = PendingIntent.getActivity(c, tag.hashCode(), hidden ? new Intent(c, MainActivity.class) : MainActivity.openChatIntent(c, chatId), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification pub = new NotificationCompat.Builder(c, CH_MESSAGES).setSmallIcon(R.drawable.ic_stat_unimsg).setContentTitle("UniChat").setContentText("New message").build();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CH_MESSAGES).setSmallIcon(R.drawable.ic_stat_unimsg)
            .setContentTitle(title).setContentText(body).setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true).setContentIntent(tap).setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(pub) // lock screen shows the generic version
            .setGroup("messages").setPriority(NotificationCompat.PRIORITY_HIGH).setOnlyAlertOnce(!alert);
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
