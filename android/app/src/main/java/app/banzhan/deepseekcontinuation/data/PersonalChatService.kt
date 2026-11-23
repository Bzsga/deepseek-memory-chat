package app.banzhan.deepseekcontinuation.data

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import app.banzhan.deepseekcontinuation.MainActivity
import app.banzhan.deepseekcontinuation.R

/** Owns the foreground lifetime. Job input stays in process memory and is never part of an Intent. */
internal class PersonalChatService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private var currentStartId = 0
    private var foreground = false
    private var destroyed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        currentStartId = startId
        if (intent?.action == ACTION_STOP) {
            PersonalChatTasks.cancelAll()
            stopWhenIdle()
            return START_NOT_STICKY
        }
        if (!foreground) {
            try {
                val serviceType = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), serviceType)
                foreground = true
            } catch (_: RuntimeException) {
                PersonalChatTasks.serviceFailed("personal_chat_unavailable", "无法启动后台聊天，请返回聊天页面后重试。")
                stopSelfResult(startId)
                return START_NOT_STICKY
            }
        }
        PersonalChatTasks.dispatch { main.post { stopWhenIdle() } }
        stopWhenIdle()
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        PersonalChatTasks.serviceFailed("personal_chat_service_timeout", "系统已结束本次后台聊天。")
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        destroyed = true
        PersonalChatTasks.serviceFailed(
            "personal_chat_interrupted", "系统已结束本次后台聊天，请先确认服务商是否已处理本次请求。",
            dispatchedOnly = true,
        )
        super.onDestroy()
    }

    private fun stopWhenIdle() {
        if (destroyed || PersonalChatTasks.hasActiveTasks()) return
        // If a more recent start is waiting in Android's queue, keep its foreground state.
        if (stopSelfResult(currentStartId) && foreground) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            foreground = false
        }
    }

    private fun notification(): Notification {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "后台聊天", NotificationManager.IMPORTANCE_LOW).apply {
                description = "个人 API 聊天在后台生成时显示"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
        val openApp = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 0, Intent(this, PersonalChatService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_whale)
            .setContentTitle("后台聊天进行中")
            .setContentText("正在等待个人 API 回复")
            .setContentIntent(openApp)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, "停止生成", stop).build())
            .build()
    }

    private companion object {
        const val CHANNEL = "personal_chat"
        const val ACTION_STOP = "app.banzhan.deepseekcontinuation.STOP_PERSONAL_CHAT"
        const val NOTIFICATION_ID = 24035
    }
}
