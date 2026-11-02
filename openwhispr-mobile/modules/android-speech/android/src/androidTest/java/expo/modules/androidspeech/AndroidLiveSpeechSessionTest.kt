package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Real microphone lifecycle tests. Recognition quality is tested separately with known speech. */
@RunWith(AndroidJUnit4::class)
class AndroidLiveSpeechSessionTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  @Test
  fun cancelReleasesMicrophoneDeletesAudioAndStopsEvents() = runBlocking {
    val beforeFiles = liveFiles()
    val beforeRecordings = activeRecordings()
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val fixture = createSession { events.add(it) }
    try {
      fixture.session.start()
      withTimeout(2_000L) {
        while (activeRecordings() == beforeRecordings) delay(20)
      }
      withTimeout(2_000L) {
        while (synchronized(events) { events.none { it["type"] == "level" } }) delay(20)
      }
      fixture.session.cancel()
      withTimeout(2_000L) {
        while (activeRecordings() != beforeRecordings) delay(20)
      }
      assertEquals(beforeFiles, liveFiles())
      val count = events.size
      delay(200)
      assertEquals("Cancelled sessions must not keep emitting events.", count, events.size)
    } finally {
      fixture.session.cancel()
    }
  }

  @Test
  fun cancelInvalidatesPendingStartBeforeItCanLaterOpenMicrophone() = runBlocking {
    val beforeFiles = liveFiles()
    val beforeRecordings = activeRecordings()
    val fixture = createSession {}
    val start = async(Dispatchers.IO) { runCatching { fixture.session.start() } }
    try {
      fixture.session.cancel()
      runCatching { start.await() }
      delay(300)
      assertEquals(beforeRecordings, activeRecordings())
      assertEquals(beforeFiles, liveFiles())
    } finally {
      fixture.session.cancel()
    }
  }

  @Test
  fun recognitionFailureRetainsValidWavAndReturnsFailureInsteadOfPartialSuccess() = runBlocking {
    val failed = CompletableDeferred<Unit>()
    val beforeRecordings = activeRecordings()
    val fixture = createSession { event ->
      if (event["type"] == "error") failed.complete(Unit)
    }
    var retained: File? = null
    try {
      fixture.session.start()
      delay(300)
      // Break the actual writer transport. SDK close/stop alone do not guarantee a failed
      // response while the source pipe remains open, so they are not deterministic stimuli.
      val field = AndroidLiveSpeechSession::class.java.getDeclaredField("pipe").apply { isAccessible = true }
      val pipe = requireNotNull(field.get(fixture.session) as? Array<*>)
      (pipe[1] as ParcelFileDescriptor).close()
      withTimeout(5_000L) { failed.await() }
      val result = withTimeout(15_000L) { fixture.session.stop() }
      assertTrue("A failed recognizer must remain a failure even when audio is recoverable.", result["error"] is Map<*, *>)
      val path = Uri.parse(requireNotNull(result["fileUri"] as? String)).path
      retained = File(requireNotNull(path))
      assertTrue(retained.exists())
      assertEquals("The stop result must already be in JavaScript's managed retry directory.", "transcript-audio", retained.parentFile?.name)
      val header = ByteBuffer.wrap(retained.readBytes().copyOfRange(0, 44)).order(ByteOrder.LITTLE_ENDIAN)
      assertEquals("RIFF", String(header.array(), 0, 4, Charsets.US_ASCII))
      assertEquals(1, header.getShort(20).toInt())
      assertEquals(1, header.getShort(22).toInt())
      assertEquals(16_000, header.getInt(24))
      assertEquals(16, header.getShort(34).toInt())
      assertEquals(retained.length() - 44, header.getInt(40).toLong())
      assertTrue((result["durationMs"] as? Long ?: 0L) > 0L)
      withTimeout(2_000L) { while (activeRecordings() != beforeRecordings) delay(20) }
      fixture.session.cancel()
      assertTrue("After stop transfers ownership, cancel must not delete the caller's WAV.", retained.exists())
    } finally {
      fixture.session.cancel()
      retained?.delete()
    }
  }

  @Test
  fun failedAtomicAdoptionPreservesOriginalAudioAndReportsRetentionFailure() = runBlocking {
    val failed = CompletableDeferred<Unit>()
    val fixture = createSession { if (it["type"] == "error") failed.complete(Unit) }
    val directory = File(context.cacheDir, "transcript-audio")
    val backup = File(context.cacheDir, "retry-backup-${UUID.randomUUID()}")
    var retained: File? = null
    var movedDirectory = false
    var blockedDirectory = false
    try {
      fixture.session.start()
      delay(300)
      val field = AndroidLiveSpeechSession::class.java.getDeclaredField("pipe").apply { isAccessible = true }
      val pipe = requireNotNull(field.get(fixture.session) as? Array<*>)
      (pipe[1] as ParcelFileDescriptor).close()
      withTimeout(5_000L) { failed.await() }
      if (directory.exists()) {
        assertTrue("The test must preserve existing retry storage.", directory.renameTo(backup))
        movedDirectory = true
      }
      blockedDirectory = true
      directory.writeText("Temporarily block directory creation for the failure test.")
      val result = withTimeout(15_000L) { fixture.session.stop() }
      val failure = result["error"] as? Map<*, *>
      assertEquals("AUDIO_RETENTION", failure?.get("code"))
      retained = File(requireNotNull(Uri.parse(result["fileUri"] as? String).path))
      assertEquals(context.cacheDir.canonicalPath, retained.parentFile?.canonicalPath)
      assertTrue("A failed atomic move must not delete the original recording.", retained.exists() && retained.length() > 44)
      fixture.session.cancel()
      assertTrue("Returned error audio is owned by the caller.", retained.exists())
    } finally {
      fixture.session.cancel()
      retained?.delete()
      if (blockedDirectory) directory.delete()
      if (movedDirectory) assertTrue("Existing retry storage must be restored.", backup.renameTo(directory))
    }
  }

  private suspend fun createSession(emit: (Map<String, Any>) -> Unit): Fixture {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply {
      locale = Locale.US
      preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
    }.build())
    try {
      val status = withTimeout(15_000L) { recognizer.checkStatus() }
      assumeTrue("Basic model is not already installed.", status == FeatureStatus.AVAILABLE)
      return Fixture(AndroidLiveSpeechSession(UUID.randomUUID().toString(), context, recognizer, SupervisorJob(), emit), recognizer)
    } catch (error: Throwable) {
      recognizer.close()
      throw error
    }
  }

  private fun liveFiles() = context.cacheDir.listFiles().orEmpty()
    .filter { it.name.startsWith("live-speech-") && it.extension == "wav" }.map { it.name }.toSet()

  private fun activeRecordings() = audioManager.activeRecordingConfigurations
    .map { it.clientAudioSessionId }.filter { it > 0 }.toSet()

  private data class Fixture(val session: AndroidLiveSpeechSession, val recognizer: SpeechRecognizer)
}
