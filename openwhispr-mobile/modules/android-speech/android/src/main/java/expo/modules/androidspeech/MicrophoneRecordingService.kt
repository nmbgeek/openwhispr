package expo.modules.androidspeech

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import expo.modules.kotlin.exception.CodedException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Visible microphone entitlement only. AudioRecord and WAV ownership remain in the shared session. */
class MicrophoneRecordingService : Service() {
  inner class RecordingBinder : Binder() { val service: MicrophoneRecordingService get() = this@MicrophoneRecordingService }
  private val binder = RecordingBinder()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  @Volatile private var sessionId: String? = null
  private var interrupted: (() -> Unit)? = null
  private var startupFailure: Throwable? = null
  @Volatile private var wakeLock: PowerManager.WakeLock? = null
  private var renewal: Job? = null

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra(SESSION_ID)
    if (id.isNullOrBlank()) { stopSelfResult(startId); return START_NOT_STICKY }
    try { promote(id) } catch (error: Exception) { startupFailure = error; stopSelfResult(startId) }
    return START_NOT_STICKY
  }

  fun attach(id: String, onInterrupted: () -> Unit) {
    startupFailure?.let { throw it }
    promote(id)
    interrupted = onInterrupted
  }

  private fun promote(id: String) {
    if (sessionId == id) return
    check(sessionId == null) { "A different recording already owns the microphone service." }
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Recording audio", NotificationManager.IMPORTANCE_LOW))
    if (!manager.areNotificationsEnabled() || manager.getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) {
      throw CodedException("ERR_ANDROID_SPEECH_NOTIFICATION_PERMISSION", "Enable recording notifications to record in the background.", null)
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("OpenWhispr is recording")
      .setContentText("Tap to return and stop recording")
      .setContentIntent(pending)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else startForeground(NOTIFICATION_ID, notification)
    sessionId = id
    val power = getSystemService(PowerManager::class.java)
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:MicrophoneRecording").apply {
      setReferenceCounted(false)
      acquire(WAKE_TIMEOUT_MS)
    }
    renewal = scope.launch {
      while (isActive && sessionId == id) {
        delay(5 * 60_000L)
        if (sessionId == id) wakeLock?.acquire(WAKE_TIMEOUT_MS)
      }
    }
  }

  fun release(id: String) {
    if (sessionId != id) return
    sessionId = null
    interrupted = null
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun releaseWakeLock() {
    renewal?.cancel()
    renewal = null
    wakeLock?.let { runCatching { if (it.isHeld) it.release() } }
    wakeLock = null
  }

  override fun onDestroy() {
    val notify = if (sessionId == null) null else interrupted
    sessionId = null
    interrupted = null
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    scope.cancel()
    runCatching { notify?.invoke() }
    super.onDestroy()
  }

  internal fun owns(id: String): Boolean = sessionId == id && wakeLock?.isHeld == true

  companion object {
    internal const val SESSION_ID = "recording-session-id"
    internal const val CHANNEL = "openwhispr_microphone_recording"
    internal const val NOTIFICATION_ID = 3_101
    private const val WAKE_TIMEOUT_MS = 15 * 60_000L
  }
}

/** Binds and awaits foreground promotion before a session is allowed to open the microphone. */
internal class MicrophoneForegroundLease private constructor(
  private val context: Context,
  private val id: String,
  private val onInterrupted: () -> Unit
) {
  private val connected = CompletableDeferred<MicrophoneRecordingService>()
  private val closed = AtomicBoolean(false)
  private var bound = false
  private var service: MicrophoneRecordingService? = null
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      val current = (binder as? MicrophoneRecordingService.RecordingBinder)?.service
      if (current == null) connected.completeExceptionally(IllegalStateException("Invalid recording-service connection."))
      else {
        service = current
        if (closed.get()) current.release(id) else connected.complete(current)
      }
    }
    override fun onServiceDisconnected(name: ComponentName?) {
      if (!closed.get()) onInterrupted()
    }
    override fun onBindingDied(name: ComponentName?) {
      if (!closed.get()) onInterrupted()
    }
  }

  suspend fun close() {
    if (!closed.compareAndSet(false, true)) return
    withContext(NonCancellable + Dispatchers.Main.immediate) {
      service?.release(id) ?: context.stopService(Intent(context, MicrophoneRecordingService::class.java))
      if (bound) runCatching { context.unbindService(connection) }
      bound = false
      service = null
    }
  }

  internal fun isActive(): Boolean = !closed.get() && service?.owns(id) == true

  companion object {
    suspend fun acquire(context: Context, id: String, onInterrupted: () -> Unit): MicrophoneForegroundLease {
      val application = context.applicationContext
      if (Build.VERSION.SDK_INT >= 33 && application.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("ERR_ANDROID_SPEECH_NOTIFICATION_PERMISSION", "Allow recording notifications to record in the background.", null)
      }
      val lease = MicrophoneForegroundLease(application, id, onInterrupted)
      try {
        withContext(Dispatchers.Main.immediate) {
          val intent = Intent(application, MicrophoneRecordingService::class.java).putExtra(MicrophoneRecordingService.SESSION_ID, id)
          application.startForegroundService(intent)
          lease.bound = application.bindService(intent, lease.connection, Context.BIND_AUTO_CREATE)
          check(lease.bound) { "The recording service could not be connected." }
        }
        val service = withTimeout(4_000L) { lease.connected.await() }
        withContext(Dispatchers.Main.immediate) { service.attach(id, onInterrupted) }
        return lease
      } catch (error: Throwable) {
        lease.close()
        if (error is CancellationException) throw error
        if (error is CodedException) throw error
        throw CodedException("ERR_ANDROID_SPEECH_BACKGROUND_START", "Background recording could not start. Keep OpenWhispr open and try again.", error)
      }
    }
  }
}
