package expo.modules.androidspeech

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.util.Collections
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = 29)
class BackgroundAudioCaptureSessionTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val notifications = context.getSystemService(NotificationManager::class.java)

  @Test
  fun homeKeepsAudioButSuppressesPreviewThenResumesWithResetAndReleasesService() = runBlocking {
    grantPermissions()
    var activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val session = AndroidAudioCaptureSession(UUID.randomUUID().toString(), context, SupervisorJob(),
      allowsBackgroundRecording = true, emitPcmToJs = true, emit = { events.add(it) })
    var retained: File? = null
    try {
      session.start()
      delay(200)
      val resources = resources(session)
      assertTrue(resources.lease.isActive())
      assertTrue(resources.wakeLock.isHeld)
      val notification = notifications.activeNotifications.first { it.id == MicrophoneRecordingService.NOTIFICATION_ID }.notification
      assertEquals(Notification.VISIBILITY_PUBLIC, notification.visibility)
      assertTrue(notification.contentIntent != null)
      session.setAppForeground(false)
      shell("input keyevent KEYCODE_HOME")
      delay(100)
      val count = previewCount(events)
      val frames = frames(session)
      delay(600)
      assertTrue("Native WAV capture must advance while the activity is on Home.", frames(session) > frames + 1_600)
      assertEquals("JS PCM/level events must not queue while backgrounded.", count, previewCount(events))
      val audioManager = context.getSystemService(AudioManager::class.java)
      assertTrue("A microphone foreground service must retain unsilenced recording access.",
        audioManager.activeRecordingConfigurations.any { it.clientAudioSessionId > 0 && !it.isClientSilenced })
      shell("input keyevent KEYCODE_SLEEP")
      try {
        delay(100)
        val sleepingFrames = frames(session)
        delay(600)
        assertFalse(context.getSystemService(PowerManager::class.java).isInteractive)
        assertTrue("Native WAV capture must advance with the screen off.", frames(session) > sleepingFrames + 1_600)
        assertTrue(resources.lease.isActive())
        assertTrue(resources.wakeLock.isHeld)
        assertTrue("The microphone must remain unsilenced with the screen off.",
          audioManager.activeRecordingConfigurations.any { it.clientAudioSessionId > 0 && !it.isClientSilenced })
        assertEquals("No JS PCM/level backlog may build while the screen is off.", count, previewCount(events))
      } finally {
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
      }
      activity.close()
      activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
      session.setAppForeground(true)
      delay(200)
      assertTrue(synchronized(events) { events.any { it["type"] == "preview-reset" } })
      assertTrue(previewCount(events) > count)
      val result = session.stop()
      assertFalse(result.containsKey("error"))
      retained = File(requireNotNull(Uri.parse(result["fileUri"] as String).path))
      assertEquals("transcript-audio", retained.parentFile?.name)
      assertTrue(retained.length() > 20_000)
      assertFalse(resources.wakeLock.isHeld)
      assertFalse(resources.lease.isActive())
      assertNoNotification()
    } finally { session.cancel(); retained?.delete(); activity.close() }
  }

  @Test
  fun nativeDurationFailureReleasesForegroundResourcesWithoutWaitingForJavaScriptStop() = runBlocking {
    grantPermissions()
    val activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
    val session = AndroidAudioCaptureSession(UUID.randomUUID().toString(), context, SupervisorJob(),
      allowsBackgroundRecording = true, durationLimitMs = 350, emit = {})
    var retained: File? = null
    try {
      session.start()
      val resources = resources(session)
      withTimeout(3_000L) { while (resources.wakeLock.isHeld || resources.lease.isActive()) delay(20) }
      assertNoNotification()
      val result = session.stop()
      assertEquals("DURATION_LIMIT", (result["error"] as Map<*, *>)["code"])
      retained = File(requireNotNull(Uri.parse(result["fileUri"] as String).path))
      assertTrue(retained.length() > 44)
    } finally { session.cancel(); retained?.delete(); activity.close() }
  }

  @Test
  @SdkSuppress(minSdkVersion = 33)
  fun deniedNotificationPermissionFailsBeforeOpeningMicrophoneOrForegroundService() = runBlocking {
    grantPermissions()
    val activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
    // Inject only the runtime permission boundary. Revoking an instrumented app's
    // permission kills its process; Android 17 also ignores app-op-only overrides.
    val deniedContext = object : ContextWrapper(context) {
      override fun getApplicationContext(): Context = this
      override fun checkSelfPermission(permission: String): Int =
        if (permission == Manifest.permission.POST_NOTIFICATIONS) PackageManager.PERMISSION_DENIED
        else super.checkSelfPermission(permission)
    }
    val session = AndroidAudioCaptureSession(UUID.randomUUID().toString(), deniedContext, SupervisorJob(),
      allowsBackgroundRecording = true, emit = {})
    try {
      try { session.start(); fail("Background capture must fail when recording notifications are blocked.") }
      catch (error: CodedException) { assertEquals("ERR_ANDROID_SPEECH_NOTIFICATION_PERMISSION", error.code) }
      session.cancel()
      assertNoNotification()
      assertFalse(session.hasStartedCapture)
      assertFalse((field(session, "file") as File).exists())
      assertFalse(context.getSystemService(AudioManager::class.java).activeRecordingConfigurations.any { it.clientAudioSessionId > 0 })
    } finally { session.cancel(); activity.close() }
  }

  @Test
  fun mlKitIntentionalBackgroundPauseKeepsWavAndRequiresFullFileTranscription() = runBlocking {
    grantPermissions()
    var testedModes = 0
    for (mode in listOf(SpeechRecognizerOptions.Mode.MODE_BASIC, SpeechRecognizerOptions.Mode.MODE_ADVANCED)) {
      val activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
      val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply { locale = Locale.US; preferredMode = mode }.build())
      var session: AndroidLiveSpeechSession? = null
      var retained: File? = null
      try {
        val status = withTimeout(15_000L) { recognizer.checkStatus() }
        if (status != FeatureStatus.AVAILABLE) continue // Never download a model as part of a lifecycle test.
        testedModes++
        val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
        val created = AndroidLiveSpeechSession(UUID.randomUUID().toString(), context, recognizer, SupervisorJob(),
          allowsBackgroundRecording = true, emit = { events.add(it) })
        session = created
        created.start()
        delay(100)
        val capture = field(created, "capture") as AndroidAudioCaptureSession
        val resources = resources(capture)
        created.setAppForeground(false)
        shell("input keyevent KEYCODE_HOME")
        delay(500)
        val result = created.stop()
        assertEquals(true, result["requiresFinalTranscription"])
        assertEquals("", result["text"])
        assertFalse("An intentional SDK pause is not a failed recording.", result.containsKey("error"))
        assertTrue(synchronized(events) { events.any { it["type"] == "preview-paused" } })
        assertFalse(synchronized(events) { events.any { it["type"] == "error" } })
        retained = File(requireNotNull(Uri.parse(result["fileUri"] as String).path))
        assertTrue(retained.length() > 10_000)
        assertFalse(resources.wakeLock.isHeld)
        assertNoNotification()
      } finally { session?.cancel(); recognizer.close(); retained?.delete(); activity.close() }
    }
    assumeTrue("No ML Kit mode already has its on-device model.", testedModes > 0)
  }

  @Test
  fun sdkBackgroundBlockedBeforeActivityCallbackPausesWithoutMarkingRecordingFailure() = runBlocking {
    val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply {
      locale = Locale.US; preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
    }.build())
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val session = AndroidLiveSpeechSession(UUID.randomUUID().toString(), context, recognizer, SupervisorJob(),
      allowsBackgroundRecording = true, emit = { events.add(it) })
    try {
      val capture = field(session, "capture") as AndroidAudioCaptureSession
      assertFalse(capture.hasStartedCapture)
      val handler = AndroidLiveSpeechSession::class.java.getDeclaredMethod("pauseAfterPreviewFailure", Exception::class.java).apply { isAccessible = true }
      assertEquals(false, handler.invoke(session, GenAiException("Foreground preparation failure", null, GenAiException.ErrorCode.UNKNOWN)))
      assertEquals(true, handler.invoke(session, GenAiException("Synthetic UID-background race", null, GenAiException.ErrorCode.BACKGROUND_USE_BLOCKED)))
      assertFalse(capture.hasFailure)
      assertTrue(synchronized(events) { events.any { it["type"] == "preview-paused" } })
      assertFalse(synchronized(events) { events.any { it["type"] == "error" } })
    } finally { session.cancel(); recognizer.close() }
  }

  @Test
  fun previewTransportFailureKeepsBackgroundCapableRecordingAndRequiresFullFileResult() = runBlocking {
    grantPermissions()
    val activity = ActivityScenario.launch(BackgroundCaptureTestActivity::class.java)
    val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply {
      locale = Locale.US; preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
    }.build())
    var session: AndroidLiveSpeechSession? = null
    var retained: File? = null
    try {
      val status = withTimeout(15_000L) { recognizer.checkStatus() }
      assumeTrue("Basic model is not already available.", status == FeatureStatus.AVAILABLE)
      val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
      val created = AndroidLiveSpeechSession(UUID.randomUUID().toString(), context, recognizer, SupervisorJob(),
        allowsBackgroundRecording = true, emit = { events.add(it) })
      session = created
      created.start()
      delay(100)
      val capture = field(created, "capture") as AndroidAudioCaptureSession
      val resources = resources(capture)
      val pipe = field(created, "pipe") as Array<*>
      (pipe[1] as ParcelFileDescriptor).close()
      withTimeout(2_000L) { while (synchronized(events) { events.none { it["type"] == "preview-paused" } }) delay(20) }
      val previous = frames(capture)
      delay(200)
      assertTrue(frames(capture) > previous)
      assertFalse(capture.hasFailure)
      val result = created.stop()
      assertEquals(true, result["requiresFinalTranscription"])
      assertEquals("", result["text"])
      assertFalse(result.containsKey("error"))
      retained = File(requireNotNull(Uri.parse(result["fileUri"] as String).path))
      assertTrue(retained.length() > 44)
      assertFalse(resources.wakeLock.isHeld)
      assertNoNotification()
    } finally { session?.cancel(); recognizer.close(); retained?.delete(); activity.close() }
  }

  private fun grantPermissions() {
    instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
  }
  private fun shell(command: String) {
    ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
  }
  private fun previewCount(events: MutableList<Map<String, Any>>) = synchronized(events) { events.count { it["type"] == "audio" || it["type"] == "level" } }
  private fun frames(session: AndroidAudioCaptureSession) = (field(session, "frameCount") as AtomicLong).get()
  private fun field(instance: Any, name: String): Any? = instance.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(instance)
  private fun resources(session: AndroidAudioCaptureSession): Resources {
    val lease = field(session, "foregroundLease") as MicrophoneForegroundLease
    val service = field(lease, "service") as MicrophoneRecordingService
    return Resources(lease, field(service, "wakeLock") as PowerManager.WakeLock)
  }
  private suspend fun assertNoNotification() {
    withTimeout(2_000L) { while (notifications.activeNotifications.any { it.id == MicrophoneRecordingService.NOTIFICATION_ID }) delay(20) }
  }
  private data class Resources(val lease: MicrophoneForegroundLease, val wakeLock: PowerManager.WakeLock)
}
