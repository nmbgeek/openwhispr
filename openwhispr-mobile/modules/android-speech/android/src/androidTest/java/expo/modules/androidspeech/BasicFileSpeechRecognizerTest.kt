package expo.modules.androidspeech

import android.Manifest
import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.speechrecognition.SpeechRecognition
import com.google.mlkit.genai.speechrecognition.SpeechRecognizerOptions
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import kotlin.math.floor
import kotlin.math.roundToInt
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BasicFileSpeechRecognizerTest {
  @Test
  fun recognizesFullStereo44100HzFileAfterNativeNormalizationWithoutLeakingConversionCache() = runBlocking {
    val context: Context = ApplicationProvider.getApplicationContext()
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.RECORD_AUDIO)
    val recognizer = SpeechRecognition.getClient(SpeechRecognizerOptions.Builder().apply {
      locale = Locale.US
      preferredMode = SpeechRecognizerOptions.Mode.MODE_BASIC
    }.build())
    var input: File? = null
    try {
      val status = withTimeout(15_000L) { recognizer.checkStatus() }
      assumeTrue("Basic model is not already installed.", status == FeatureStatus.AVAILABLE)
      input = makeStereoWave(context)
      val before = conversionFiles(context)
      val result = withTimeout(30_000L) {
        BasicFileSpeechRecognizer.transcribe(context, Uri.fromFile(input), recognizer)
      }
      val text = requireNotNull(result["text"]).lowercase(Locale.US)
      assertTrue("The beginning of the full fixture must survive normalization: $text", text.contains("offline speech recognition test"))
      assertTrue("The end of the full fixture must survive normalization: $text", text.contains("quick brown fox") && text.contains("lazy dog"))
      assertEquals("The decoded cache file must be reclaimed after recognition.", before, conversionFiles(context))
    } finally {
      input?.delete()
      recognizer.close()
    }
  }

  private fun conversionFiles(context: Context) = context.cacheDir.listFiles().orEmpty()
    .filter { it.name.startsWith("whisper-") && it.extension == "wav" }.map { it.name }.toSet()

  private fun makeStereoWave(context: Context): File {
    val raw = InstrumentationRegistry.getInstrumentation().context.assets.open("speech-en-US.pcm").use { it.readBytes() }
    val samples = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val frames = (samples.limit().toDouble() * 44_100 / 16_000).roundToInt()
    val payload = ByteBuffer.allocate(frames * 4).order(ByteOrder.LITTLE_ENDIAN)
    repeat(frames) { frame ->
      val position = frame.toDouble() * 16_000 / 44_100
      val lower = floor(position).toInt().coerceAtMost(samples.limit() - 1)
      val upper = (lower + 1).coerceAtMost(samples.limit() - 1)
      val sample = (samples.get(lower) + (samples.get(upper) - samples.get(lower)) * (position - lower)).roundToInt().toShort()
      payload.putShort(sample)
      payload.putShort((sample / 2).toShort())
    }
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII)); putInt(payload.capacity() + 36)
      put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); putInt(16)
      putShort(1); putShort(2); putInt(44_100); putInt(44_100 * 4); putShort(4); putShort(16)
      put("data".toByteArray(Charsets.US_ASCII)); putInt(payload.capacity())
    }
    return File.createTempFile("stereo-speech-", ".wav", context.cacheDir).apply {
      outputStream().use { it.write(header.array()); it.write(payload.array()) }
    }
  }
}
