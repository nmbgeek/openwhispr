package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.audio.AudioSource
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerRequest
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerResponse
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Synthetic fixture only; never opens a microphone or downloads a model. */
@RunWith(AndroidJUnit4::class)
class AndroidSpeechStreamingProbeTest {
  @Test
  fun recognizePacedRawPcmWithBasic() = runBlocking {
    val context: Context = ApplicationProvider.getApplicationContext()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply {
      locale = Locale.US
      preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
    }.build())
    val pipe = ParcelFileDescriptor.createPipe()
    Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_SETFL,
      Os.fcntlInt(pipe[1].fileDescriptor, OsConstants.F_GETFL, 0) or OsConstants.O_NONBLOCK)
    val source = AudioSource.fromPfd(pipe[0], AudioSource.Mode.STREAMING)
    try {
      val status = withTimeout(15_000L) { recognizer.checkStatus() }
      assumeTrue("Basic is not ready: SDK status=$status", status == FeatureStatus.AVAILABLE)
      val request = SpeechRecognizerRequest.Builder().apply { audioSource = source }.build()
      val finalText = mutableListOf<String>()
      var completed = false
      withTimeout(30_000L) {
        coroutineScope {
          val writer = launch(Dispatchers.IO) {
            // Let collection establish the service session before pacing a local PCM pipe.
            delay(300)
            try {
              instrumentation.context.assets.open("speech-en-US.pcm").use { input ->
                val startedAt = SystemClock.elapsedRealtime()
                val buffer = ByteArray(640) //20 ms of PCM16 mono at16kHz.
                var total = 0L
                while (true) {
                  val count = input.read(buffer)
                  if (count < 0) break
                  var offset = 0
                  while (offset < count) {
                    currentCoroutineContext().ensureActive()
                    try {
                      offset += Os.write(pipe[1].fileDescriptor, buffer, offset, count - offset)
                    } catch (error: ErrnoException) {
                      if (error.errno != OsConstants.EAGAIN) throw error
                      delay(5)
                    }
                  }
                  total += count
                  val wait = total * 1_000 / 32_000 - (SystemClock.elapsedRealtime() - startedAt)
                  if (wait > 0) delay(wait)
                }
                Log.i(TAG, "writer-complete bytes=$total durationMs=${SystemClock.elapsedRealtime() - startedAt}")
              }
            } finally {
              pipe[1].close()
            }
            delay(500)
            recognizer.stopRecognition()
          }
          try {
            recognizer.startRecognition(request).takeWhile { response ->
              if (response is SpeechRecognizerResponse.CompletedResponse) completed = true
              !completed
            }.collect { response ->
              when (response) {
                is SpeechRecognizerResponse.FinalTextResponse -> {
                  finalText.add(response.text)
                  Log.i(TAG, "basic-streaming-final text=${response.text}")
                }
                is SpeechRecognizerResponse.ErrorResponse -> {
                  Log.i(TAG, "basic-streaming-error code=${response.e.errorCode} reason=${response.e.message}")
                  throw response.e
                }
                else -> Unit
              }
            }
            writer.join()
          } finally {
            writer.cancel()
          }
        }
      }
      val text = finalText.joinToString(" ").trim()
      Log.i(TAG, "probe-complete completed=$completed text=$text microphone=not-opened downloads=not-requested")
      assertTrue("Recognition must report completion.", completed)
      assertTrue("The known speech fixture must produce final text.", text.isNotBlank())
    } finally {
      withContext(NonCancellable) {
        try {
          withTimeout(2_000L) { recognizer.stopRecognition() }
        } finally {
          recognizer.close()
          source.close()
          pipe[1].close()
        }
      }
    }
  }

  companion object {
    private const val TAG = "OpenWhisprStreamProbe"
  }
}
