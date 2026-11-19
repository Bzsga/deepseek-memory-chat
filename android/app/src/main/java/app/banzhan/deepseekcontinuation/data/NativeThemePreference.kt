package app.banzhan.deepseekcontinuation.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow

internal object NativeThemePreference {
    private fun preferences(context: Context) = context.getSharedPreferences("chat-appearance", Context.MODE_PRIVATE)

    fun save(context: Context, owner: String, preference: String) {
        if (preference !in setOf("system", "light", "dark")) return
        preferences(context).edit().putString(owner, preference).apply()
    }

    fun read(context: Context, owner: String) = preferences(context).getString(owner, "system") ?: "system"

    fun observe(context: Context, owner: String) = callbackFlow {
        val prefs = preferences(context)
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == owner || key == null) trySend(read(context, owner))
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        trySend(read(context, owner))
        awaitClose { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }
}
