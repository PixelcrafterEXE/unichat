package app.unimsg.android.node;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.StatFs;
import android.provider.DocumentsContract;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * "Find the backup on this phone": the Storage Access Framework route to the WhatsApp / Signal backup files, without any broad storage permission.
 * The user picks ONE folder in the system picker (pre-pointed at the usual place, one tap on "Use this folder"); we keep that grant
 * (takePersistableUriPermission, read only), list the matching backup files and stream the chosen ones into the backend's managed
 * import folder (<filesDir>/unimsg-data/.backup/saf/<kind>/...), because the importers need real file paths. Nothing outside the picked folder
 * is ever readable and nothing is ever written to it.
 *
 * WhatsApp: <base>/WhatsApp/Databases/msgstore*.crypt14|15 and (optional, user-selected top-level folders) <base>/WhatsApp/Media/<folder>/...,
 * which is exactly the layout the importer's "Media folder next to the backup" discovery expects. Signal: <base>/Signal/<file>.
 * Requests are by file NAME inside the located folder, never by a caller-supplied URI.
 */
public final class SafImport {
    private static final String TAG = "UnimsgSaf";
    private static final String AUTH = "com.android.externalstorage.documents";
    private static final String[] COLS = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
    private static final SafImport INSTANCE = new SafImport();
    public static SafImport get() { return INSTANCE; }

    public interface Out { void ok(JSONObject result); void fail(String message); }
    public interface Progress { void at(JSONObject data); }

    private static final class Row { String id, name, mime; long size, modified; boolean dir() { return DocumentsContract.Document.MIME_TYPE_DIR.equals(mime); } }
    private static final class Loc { Uri tree; String dbDoc, mediaDoc; List<Row> files = new ArrayList<>(); }

    private final AtomicBoolean cancel = new AtomicBoolean(false), busy = new AtomicBoolean(false);
    private SafImport() {}

    public static boolean validKind(String k) { return "whatsapp".equals(k) || "signal".equals(k); }

    /** Where the system picker should open: the folder where the backups normally are. */
    public static Uri hint(String kind) {
        return DocumentsContract.buildDocumentUri(AUTH, "whatsapp".equals(kind) ? "primary:Android/media/com.whatsapp/WhatsApp" : "primary:Signal");
    }

    private static SharedPreferences prefs(Context c) { return c.getSharedPreferences("unimsg_saf", Context.MODE_PRIVATE); }
    public static Uri savedTree(Context c, String kind) {
        String s = prefs(c).getString(kind, null);
        if (s == null) return null;
        Uri u = Uri.parse(s);
        for (android.content.UriPermission p : c.getContentResolver().getPersistedUriPermissions()) if (p.getUri().equals(u) && p.isReadPermission()) return u;
        return null;
    }
    /** Keep the read grant of a freshly picked folder (and drop the previous one of this kind so the list of grants stays short). */
    public static void remember(Context c, String kind, Uri tree) {
        try { c.getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION); }
        catch (Exception e) { Log.w(TAG, "persist: " + e); }
        String old = prefs(c).getString(kind, null);
        prefs(c).edit().putString(kind, tree.toString()).apply();
        if (old != null && !old.equals(tree.toString())) {
            try { c.getContentResolver().releasePersistableUriPermission(Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
        }
    }
    public static void forget(Context c, String kind) {
        String old = prefs(c).getString(kind, null);
        prefs(c).edit().remove(kind).apply();
        if (old != null) { try { c.getContentResolver().releasePersistableUriPermission(Uri.parse(old), Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { } }
    }

    public static File baseDir(Context c, String kind) { return new File(new File(new File(new File(c.getFilesDir(), "unimsg-data"), ".backup"), "saf"), kind); }

    // ---- listing ------------------------------------------------------------------------------------------------------------------
    private static List<Row> children(ContentResolver cr, Uri tree, String docId) {
        List<Row> out = new ArrayList<>();
        Uri u = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        try (Cursor c = cr.query(u, COLS, null, null, null)) {
            while (c != null && c.moveToNext()) {
                Row r = new Row(); r.id = c.getString(0); r.name = c.getString(1); r.mime = c.getString(2);
                r.size = c.isNull(3) ? 0 : c.getLong(3); r.modified = c.isNull(4) ? 0 : c.getLong(4);
                if (r.name != null && r.id != null) out.add(r);
            }
        } catch (Exception e) { Log.w(TAG, "list failed: " + e); }
        return out;
    }
    private static Row dirNamed(List<Row> rows, String name) { for (Row r : rows) if (r.dir() && r.name.equalsIgnoreCase(name)) return r; return null; }

    private static boolean wanted(String kind, String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if ("whatsapp".equals(kind)) return n.startsWith("msgstore") && !n.contains("increment") && (n.endsWith(".crypt15") || n.endsWith(".crypt14"));
        return n.startsWith("signal") && n.endsWith(".backup") || n.endsWith(".binary");
    }

    /** Finds the backup folder inside whatever the user picked (the WhatsApp folder, its Databases folder, Android/media/com.whatsapp, or the Signal folder). */
    private static Loc find(ContentResolver cr, String kind, Uri tree) {
        Loc loc = new Loc(); loc.tree = tree;
        String root = DocumentsContract.getTreeDocumentId(tree);
        List<Row> top = children(cr, tree, root);
        List<Row> hit = new ArrayList<>();
        for (Row r : top) if (!r.dir() && wanted(kind, r.name)) hit.add(r);
        if (!hit.isEmpty()) { loc.dbDoc = root; loc.files = hit; if ("whatsapp".equals(kind)) { Row m = dirNamed(top, "Media"); if (m != null) loc.mediaDoc = m.id; } return loc; }
        if ("whatsapp".equals(kind)) {
            String wa = root; Row w = dirNamed(top, "WhatsApp"); List<Row> inWa = top;
            if (w != null) { wa = w.id; inWa = children(cr, tree, wa); }
            Row d = dirNamed(inWa, "Databases");
            if (d != null) {
                for (Row r : children(cr, tree, d.id)) if (!r.dir() && wanted(kind, r.name)) hit.add(r);
                loc.dbDoc = d.id; loc.files = hit; Row m = dirNamed(inWa, "Media"); if (m != null) loc.mediaDoc = m.id;
            }
        } else {
            Row b = dirNamed(top, "Backups"); if (b == null) b = dirNamed(top, "Signal");
            if (b != null) { for (Row r : children(cr, tree, b.id)) if (!r.dir() && wanted(kind, r.name)) hit.add(r); loc.dbDoc = b.id; loc.files = hit; }
        }
        return loc;
    }

    /** Lists the backup files (newest first) and, for WhatsApp, the top-level Media folders with their sizes. Runs on a worker thread, replies through `out`. */
    public void locate(final Context c, final String kind, final Uri tree, final Out out) {
        new Thread(() -> {
            try {
                ContentResolver cr = c.getContentResolver();
                Loc loc = find(cr, kind, tree);
                Collections.sort(loc.files, (a, b) -> Long.compare(b.modified, a.modified));
                JSONObject res = new JSONObject().put("kind", kind).put("folder", folderName(tree));
                JSONArray files = new JSONArray();
                for (Row r : loc.files) files.put(new JSONObject().put("name", r.name).put("size", r.size).put("modified", r.modified));
                res.put("files", files);
                JSONArray media = new JSONArray();
                if (loc.mediaDoc != null) {
                    for (Row d : children(cr, tree, loc.mediaDoc)) {
                        if (!d.dir() || d.name.startsWith(".")) continue;
                        long[] t = new long[2]; walk(cr, tree, d.id, t);
                        if (t[1] > 0) media.put(new JSONObject().put("name", d.name).put("bytes", t[0]).put("files", t[1]));
                    }
                }
                res.put("media", media).put("hasMedia", loc.mediaDoc != null);
                out.ok(res);
            } catch (Exception e) { Log.w(TAG, "locate", e); out.fail("Could not read that folder: " + e.getMessage()); }
        }, "unimsg-saf-list").start();
    }
    private static String folderName(Uri tree) { String id = DocumentsContract.getTreeDocumentId(tree); int i = id.lastIndexOf('/'); return i >= 0 ? id.substring(i + 1) : id.substring(id.indexOf(':') + 1); }
    private static void walk(ContentResolver cr, Uri tree, String docId, long[] t) {
        for (Row r : children(cr, tree, docId)) { if (r.dir()) walk(cr, tree, r.id, t); else { t[0] += r.size; t[1]++; } }
    }

    public void cancel() { cancel.set(true); }

    /** Streams the named backup file (and the named Media folders) into the managed import folder. Replies {path, name, bytes, mediaFiles}. */
    public void copy(final Context c, final String kind, final Uri tree, final String name, final List<String> mediaDirs, final Out out, final Progress pr) {
        if (!busy.compareAndSet(false, true)) { out.fail("A copy is already running."); return; }
        cancel.set(false);
        new Thread(() -> {
            try {
                ContentResolver cr = c.getContentResolver();
                Loc loc = find(cr, kind, tree);
                Row src = null; for (Row r : loc.files) if (r.name.equals(name)) src = r;
                if (src == null) { out.fail("That backup file is no longer in the folder."); return; }
                File base = baseDir(c, kind), dbDir = "whatsapp".equals(kind) ? new File(base, "WhatsApp/Databases") : base;
                // plan the media first so the free-space check and the progress bar cover everything
                List<Object[]> plan = new ArrayList<>(); // {Row, File}
                long total = src.size;
                if (loc.mediaDoc != null && mediaDirs != null && !mediaDirs.isEmpty()) {
                    for (Row d : children(cr, tree, loc.mediaDoc)) if (d.dir() && mediaDirs.contains(d.name)) total += plan(cr, tree, d, new File(base, "WhatsApp/Media/" + safeName(d.name)), plan);
                }
                StatFs fs = new StatFs(c.getFilesDir().getPath());
                if (fs.getAvailableBytes() < total + (256L << 20)) { out.fail("Not enough free space on the phone: about " + (total >> 20) + " MB are needed for the copy (plus the room the import itself needs). Free some space or leave out the media folders."); return; }
                long[] done = { 0 }; long[] lastAt = { 0 };
                File target = new File(dbDir, safeName(src.name));
                copyOne(cr, tree, src, target, done, total, lastAt, pr);
                long files = 0;
                for (Object[] p : plan) { copyOne(cr, tree, (Row) p[0], (File) p[1], done, total, lastAt, pr); files++; }
                JSONObject res = new JSONObject().put("path", target.getAbsolutePath()).put("name", src.name).put("bytes", src.size).put("mediaFiles", files);
                if (files > 0) res.put("mediaPath", new File(base, "WhatsApp").getAbsolutePath());
                out.ok(res);
            } catch (Cancelled e) { out.fail("Copy cancelled."); }
            catch (Exception e) { Log.w(TAG, "copy", e); out.fail("Copy failed: " + e.getMessage()); }
            finally { busy.set(false); }
        }, "unimsg-saf-copy").start();
    }

    private static final class Cancelled extends Exception { }
    private static String safeName(String n) { if (n.contains("/") || n.contains("\\") || n.equals("..") || n.equals(".") || n.indexOf('\0') >= 0) throw new IllegalArgumentException("unsafe file name"); return n; }
    private long plan(ContentResolver cr, Uri tree, Row dir, File into, List<Object[]> plan) {
        long sum = 0;
        for (Row r : children(cr, tree, dir.id)) {
            if (r.dir()) sum += plan(cr, tree, r, new File(into, safeName(r.name)), plan);
            else { plan.add(new Object[] { r, new File(into, safeName(r.name)) }); sum += r.size; }
        }
        return sum;
    }

    private void copyOne(ContentResolver cr, Uri tree, Row src, File dst, long[] done, long total, long[] lastAt, Progress pr) throws Exception {
        if (cancel.get()) throw new Cancelled();
        if (dst.isFile() && dst.length() == src.size) { done[0] += src.size; report(pr, done[0], total, lastAt, false); return; } // copied by an earlier run
        File dir = dst.getParentFile(); if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("cannot create " + dir);
        File part = new File(dir, dst.getName() + ".part");
        try (InputStream in = cr.openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, src.id)); OutputStream o = new FileOutputStream(part)) {
            if (in == null) throw new java.io.IOException("cannot open " + src.name);
            byte[] buf = new byte[1 << 20]; int n;
            while ((n = in.read(buf)) > 0) { if (cancel.get()) throw new Cancelled(); o.write(buf, 0, n); done[0] += n; report(pr, done[0], total, lastAt, false); }
        } catch (Exception e) { part.delete(); throw e; }
        if (dst.exists()) dst.delete();
        if (!part.renameTo(dst)) throw new java.io.IOException("cannot rename " + part);
        report(pr, done[0], total, lastAt, true);
    }
    private static void report(Progress pr, long done, long total, long[] lastAt, boolean force) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (!force && now - lastAt[0] < 300) return;
        lastAt[0] = now;
        try { pr.at(new JSONObject().put("op", "saf-copy").put("stage", "copying").put("done", done).put("total", total)); } catch (Exception ignored) { }
    }

    /** Deletes the copies (after the import, or when the user starts over): the media alone can be several GB. */
    public static void discard(Context c, String kind) { deleteTree(baseDir(c, kind)); }
    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
