package app.unimsg.android.node;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The 32-byte key that encrypts the message archive and media cache (see loadDataKey in packages/host) lives here, sealed
 * by a non-exportable AES-256-GCM key in the Android Keystore (StrongBox when the device has it). The sealed blob is
 * filesDir/unimsg.key.android (iv || ciphertext || tag). The plaintext key is handed to the backend via the UNIMSG_DB_KEY
 * environment variable of this process only.
 *
 * Why not the host's KeyWrap hook: KeyWrap.wrap/unwrap are synchronous and the backend runs in a different thread/VM
 * from the Keystore; handing over the key at start-up needs no IPC and is the same code path as UNIMSG_DB_KEY on servers.
 *
 * Failure policy: if the blob exists but cannot be unsealed (Keystore key lost) we throw. We NEVER generate a new key over
 * an existing archive: the user would silently lose access to it.  The app is allowBackup=false: the blob is useless without
 * the device's Keystore, so it must not be restored on another phone.
 */
final class DataKey {
    private static final String ALIAS = "unimsg_data_kek_v1";
    private static final String PROVIDER = "AndroidKeyStore";

    static String hexKey(Context ctx) throws Exception {
        File f = new File(ctx.getFilesDir(), "unimsg.key.android");
        SecretKey kek = kek();
        if (f.exists()) {
            byte[] all = Files.readAllBytes(f.toPath());
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, kek, new GCMParameterSpec(128, all, 0, 12));
            byte[] key = c.doFinal(all, 12, all.length - 12);
            if (key.length != 32) throw new IllegalStateException("data key has wrong length");
            return hex(key);
        }
        byte[] key = new byte[32]; new SecureRandom().nextBytes(key);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, kek); // the Keystore picks the IV (randomized encryption is required)
        byte[] iv = c.getIV(), ct = c.doFinal(key);
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(iv); o.write(ct); o.getFD().sync(); }
        Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        return hex(key);
    }

    private static SecretKey kek() throws Exception {
        KeyStore ks = KeyStore.getInstance(PROVIDER); ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        try { return generate(true); } catch (StrongBoxUnavailableException e) { return generate(false); }
    }

    private static SecretKey generate(boolean strongBox) throws Exception {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true); // no user-auth requirement: the backend must start while the phone is locked
        if (strongBox && android.os.Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true);
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        g.init(b.build());
        return g.generateKey();
    }

    private static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
}
