package app.deskdo.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Session token storage. The token is encrypted with an AES-256-GCM key that lives in the Android
 * Keystore (hardware-backed on most phones), so the key never leaves secure storage and the token
 * is never written in plain text.
 */
object TokenStore {
    private const val KEY_ALIAS = "deskdo_session_key"
    private const val PREFS = "deskdo_secure"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    fun save(ctx: Context, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
            .apply()
    }

    fun load(ctx: Context): String? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val iv = p.getString("iv", null) ?: return null
        val ct = p.getString("ct", null) ?: return null
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            null // key invalidated (e.g. device restored to new phone): sign in again
        }
    }

    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
    }
}
