package expo.modules.androidspeech

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizer
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Read-only hardware probe. It does not download a model, record audio, or start inference. */
@RunWith(AndroidJUnit4::class)
class AndroidSpeechCapabilityProbeTest {
  @Test
  fun reportsBasicAndAdvancedStatusWithoutDownloadingAndClosesEachClient() = runBlocking {
    Log.i(TAG, "device=${Build.MANUFACTURER}/${Build.MODEL} api=${Build.VERSION.SDK_INT} locale=en-US inference=not-run")
    var clientsOpened = 0
    var clientsClosed = 0
    for ((mode, name) in listOf(
      SpeechRecognizerOptions.Mode.MODE_BASIC to "basic",
      SpeechRecognizerOptions.Mode.MODE_ADVANCED to "advanced"
    )) {
      // A second independent client checks that closing one client does not break future probes.
      repeat(2) { attempt ->
        var recognizer: SpeechRecognizer? = null
        try {
          val options = SpeechRecognizerOptions.Builder().apply {
            locale = Locale.US
            preferredMode = mode
          }.build()
          val client = SpeechRecognition.getClient(options)
          recognizer = client
          clientsOpened++
          val status = withTimeout(15_000L) { client.checkStatus() }
          val label = when (status) {
            FeatureStatus.AVAILABLE -> "available"
            FeatureStatus.DOWNLOADABLE -> "downloadable"
            FeatureStatus.DOWNLOADING -> "downloading"
            FeatureStatus.UNAVAILABLE -> "unavailable"
            else -> error("The SDK returned an unknown feature status: $status")
          }
          Log.i(TAG, "mode=$name attempt=${attempt + 1} status=$label sdkEnum=$status reason=none downloads=not-requested")
        } catch (error: TimeoutCancellationException) {
          Log.i(TAG, "mode=$name attempt=${attempt + 1} status=unavailable reason=status-timeout-15000ms downloads=not-requested")
        } catch (error: CancellationException) {
          throw error
        } catch (error: Exception) {
          // The production bridge also reports service initialization/binding errors as unavailable.
          val reason = (error.message ?: "no-message").replace('\n', ' ').replace('\r', ' ')
          Log.i(TAG, "mode=$name attempt=${attempt + 1} status=unavailable reason=${error.javaClass.simpleName}:$reason downloads=not-requested")
        } finally {
          recognizer?.let {
            it.close()
            clientsClosed++
          }
        }
      }
    }
    assertEquals("Every successfully created SDK client must be closed.", clientsOpened, clientsClosed)
    assertEquals("Both modes must be queried with independent fresh clients.", 4, clientsOpened)
    Log.i(TAG, "probe-complete clientsOpened=$clientsOpened clientsClosed=$clientsClosed inference=not-run downloads=not-requested")
    Unit // JUnit requires a void method; Log.i returns an integer.
  }

  companion object {
    private const val TAG = "OpenWhisprMLKitProbe"
  }
}
