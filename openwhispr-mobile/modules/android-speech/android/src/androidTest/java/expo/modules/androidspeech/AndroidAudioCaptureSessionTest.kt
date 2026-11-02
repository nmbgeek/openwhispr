package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.media.AudioManager
import android.net.Uri
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/** Capture-only tests never construct a recognizer or check/download an ML Kit model. */
@RunWith(AndroidJUnit4::class)
class AndroidAudioCaptureSessionTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  @Test
  fun captureEmitsBoundedOrderedPcmAndLevelsMatchingTheEntireManagedWav() = runBlocking {
    grantMicrophone()
    val beforeRecordings = activeRecordings()
    val id = UUID.randomUUID().toString()
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val session = AndroidAudioCaptureSession(id, context, SupervisorJob(), emitPcmToJs = true, emit = { events.add(it) })
    var retained: File? = null
    try {
      session.start()
      delay(575) // Not a multiple of120ms, so the last partial chunk must also be flushed.
      val result = withTimeout(8_000L) { session.stop() }
      assertFalse(result.containsKey("error"))
      retained = File(requireNotNull(Uri.parse(result["fileUri"] as? String).path))
      assertEquals("transcript-audio", retained.parentFile?.name)
      val wav = retained.readBytes()
      val header = ByteBuffer.wrap(wav, 0, 44).order(ByteOrder.LITTLE_ENDIAN)
      assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
      assertEquals(1, header.getShort(20).toInt())
      assertEquals(1, header.getShort(22).toInt())
      assertEquals(16_000, header.getInt(24))
      assertEquals(16, header.getShort(34).toInt())
      assertEquals(wav.size - 44, header.getInt(40))
      val snapshot = synchronized(events) { events.toList() }
      assertTrue(snapshot.all { it["sessionId"] == id })
      val audio = snapshot.filter { it["type"] == "audio" }
      assertTrue("The live preview must receive more than one PCM chunk.", audio.size >= 2)
      val pcm = ByteArrayOutputStream()
      var nextOffset = 0L
      audio.forEachIndexed { index, event ->
        val bytes = Base64.decode(event["pcmBase64"] as String, Base64.NO_WRAP)
        assertEquals(index.toLong(), event["sequence"])
        assertEquals(nextOffset, event["frameOffset"])
        assertTrue("Chunks must be nonempty PCM16 and bounded to200ms.", bytes.isNotEmpty() && bytes.size % 2 == 0 && bytes.size <= 6_400)
        if (index < audio.lastIndex) assertTrue("Full chunks must cover at least100ms.", bytes.size >= 3_200)
        pcm.write(bytes)
        nextOffset += bytes.size / 2
      }
      assertArrayEquals("Preview PCM must match all saved samples, including the final tail.", wav.copyOfRange(44, wav.size), pcm.toByteArray())
      assertEquals(nextOffset * 1_000 / 16_000, result["durationMs"])
      val levels = snapshot.filter { it["type"] == "level" }
      assertTrue(levels.isNotEmpty())
      assertTrue(levels.all { (it["level"] as Double) in 0.0..1.0 })
      withTimeout(2_000L) { while (activeRecordings() != beforeRecordings) delay(20) }
      session.cancel()
      assertTrue("Cancel after successful stop must not delete transferred audio.", retained.exists())
      try {
        session.stop()
        fail("A stale stop must be rejected.")
      } catch (error: CodedException) {
        assertEquals("ERR_ANDROID_SPEECH_STALE_SESSION", error.code)
      }
    } finally {
      session.cancel()
      retained?.delete()
    }
  }

  @Test
  fun cancelledCaptureDeletesTemporaryAudioAndCannotBeRestarted() = runBlocking {
    grantMicrophone()
    val beforeFiles = activeFiles()
    val beforeRecordings = activeRecordings()
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val session = AndroidAudioCaptureSession(UUID.randomUUID().toString(), context, SupervisorJob(), emitPcmToJs = true, emit = { events.add(it) })
    try {
      session.start()
      delay(200)
      session.cancel()
      val count = events.size
      delay(200)
      assertEquals(count, events.size)
      assertEquals(beforeFiles, activeFiles())
      withTimeout(2_000L) { while (activeRecordings() != beforeRecordings) delay(20) }
      try {
        session.start()
        fail("A cancelled session must never reopen the microphone.")
      } catch (error: CodedException) {
        assertEquals("ERR_ANDROID_SPEECH_STALE_SESSION", error.code)
      }
    } finally {
      session.cancel()
    }
  }

  @Test
  fun cancellingPendingCaptureStartPreventsLateMicrophoneAndPcmEvents() = runBlocking {
    grantMicrophone()
    val beforeFiles = activeFiles()
    val beforeRecordings = activeRecordings()
    val events = Collections.synchronizedList(mutableListOf<Map<String, Any>>())
    val session = AndroidAudioCaptureSession(UUID.randomUUID().toString(), context, SupervisorJob(), emitPcmToJs = true, emit = { events.add(it) })
    val start = async(Dispatchers.IO) { runCatching { session.start() } }
    try {
      session.cancel()
      runCatching { start.await() }
      val count = events.size
      delay(300)
      assertEquals(count, events.size)
      assertEquals(beforeFiles, activeFiles())
      assertEquals(beforeRecordings, activeRecordings())
    } finally {
      session.cancel()
    }
  }

  private fun grantMicrophone() {
    InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
  }

  private fun activeFiles() = context.cacheDir.listFiles().orEmpty()
    .filter { it.name.startsWith("live-speech-") && it.extension == "wav" }.map { it.name }.toSet()

  private fun activeRecordings() = audioManager.activeRecordingConfigurations.map { it.clientAudioSessionId }.filter { it > 0 }.toSet()
}
