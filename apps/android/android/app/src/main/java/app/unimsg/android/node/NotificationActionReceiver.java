package app.unimsg.android.node;

import android.app.NotificationManager;
import androidx.core.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import org.json.JSONObject;

/** Handles the "Reply" (RemoteInput) and "Mark as read" actions of message notifications. Not exported: only our own PendingIntents reach it. */
public class NotificationActionReceiver extends BroadcastReceiver {
    private static final String TAG = "UnimsgNotif";
    static final String ACTION_REPLY = "app.unimsg.android.action.REPLY", ACTION_READ = "app.unimsg.android.action.MARK_READ";
    static final String EXTRA_CHAT = "chatId", EXTRA_MESSAGE = "messageId", KEY_REPLY = "reply_text";

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        final String chat = intent.getStringExtra(EXTRA_CHAT), msg = intent.getStringExtra(EXTRA_MESSAGE);
        if (chat == null) return;
        final PendingResult pr = goAsync(); // the bridge call is asynchronous; allow up to the ~10 s a receiver gets
        try {
            if (ACTION_REPLY.equals(intent.getAction())) {
                Bundle in = RemoteInput.getResultsFromIntent(intent);
                CharSequence text = in == null ? null : in.getCharSequence(KEY_REPLY);
                if (text == null || text.toString().trim().isEmpty()) { Notifier.showReplyResult(ctx, chat, msg, null, false); pr.finish(); return; }
                final String t = text.toString();
                JSONObject p = new JSONObject().put("chatId", chat).put("text", t);
                boolean sent = NodeBridge.get().callControl(ctx, "$reply", p.toString(), (ok, err) -> {
                    if (!ok) Log.w(TAG, "reply failed: " + err);
                    Notifier.showReplyResult(ctx, chat, msg, t, ok);
                    if (ok) NodeBridge.get().callControl(ctx, "$markRead", markReadParams(chat, msg), null);
                    pr.finish();
                });
                if (!sent) { Notifier.showReplyResult(ctx, chat, msg, t, false); pr.finish(); }
            } else if (ACTION_READ.equals(intent.getAction())) {
                ctx.getSystemService(NotificationManager.class).cancel(chat, Notifier.MESSAGE_ID);
                NodeBridge.get().callControl(ctx, "$markRead", markReadParams(chat, msg), (ok, err) -> pr.finish());
                // fire-and-forget if the backend is down: pr is finished by the timeout in callControl
            } else pr.finish();
        } catch (Exception e) { Log.w(TAG, "action failed", e); pr.finish(); }
    }

    private static String markReadParams(String chat, String msg) {
        try { return new JSONObject().put("chatId", chat).put("messageId", msg == null ? "" : msg).toString(); } catch (Exception e) { return "{}"; }
    }
}
