package expo.modules.androidspeech

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
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

/** Uses real platform extractors/decoders and an AAC encoder, rather than mocked codec buffers. */
@RunWith(AndroidJUnit4::class)
class AudioToWavConverterTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  @Test
  fun pcmWavPreservesStereoSamplesRateAndDuration() = runBlocking {
    val pcm = sinePcm(sampleRate = 44_100, channels = 2, frames = 4_410)
    val input = writeWave(pcm, 44_100, 2)
    var output: File? = null
    try {
      output = File(requireNotNull(Uri.parse(AudioToWavConverter.convert(context, Uri.fromFile(input))).path))
      val decoded = readWave(output)
      assertEquals(44_100, decoded.sampleRate)
      assertEquals(2, decoded.channels)
      assertEquals(16, decoded.bitsPerSample)
      assertEquals(1, decoded.audioFormat)
      assertEquals(4_410, decoded.pcm.size / (decoded.channels * 2))
      assertArrayEquals(pcm, decoded.pcm)
      assertEquals(0.1, decoded.durationSeconds, 0.0001)
      assertTrue(input.exists()) // Conversion creates a separate file; it never consumes the input.
      assertFalse(input.absolutePath == output.absolutePath)
    } finally {
      input.delete()
      output?.delete()
    }
  }

  @Test
  fun aacM4aDecodesWholeFileToRecognizablePcm16Audio() = runBlocking {
    val sampleRate = 16_000
    val input = encodeAac(sinePcm(sampleRate, 1, sampleRate), sampleRate)
    var output: File? = null
    try {
      output = File(requireNotNull(Uri.parse(AudioToWavConverter.convert(context, Uri.fromFile(input))).path))
      val decoded = readWave(output)
      assertEquals(sampleRate, decoded.sampleRate)
      assertEquals(1, decoded.channels)
      assertEquals(16, decoded.bitsPerSample)
      assertEquals(1, decoded.audioFormat)
      // AAC-LC encodes 1024 samples per packet. MediaMuxer does not add gapless trimming
      // metadata to this fixture, so verify ALL encoded packets, including priming/padding.
      val packetCount = aacPacketCount(input)
      assertEquals(packetCount * 1_024, decoded.pcm.size / 2)
      val samples = ByteBuffer.wrap(decoded.pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      var energy = 0.0
      var crossings = 0
      var negativeHalfCycle = false
      var firstAudibleSample = -1
      var lastAudibleSample = -1
      var sampleIndex = 0
      while (samples.hasRemaining()) {
        val sample = samples.get().toInt()
        energy += sample.toDouble() * sample
        if (sample < -1_000 || sample > 1_000) {
          if (firstAudibleSample < 0) firstAudibleSample = sampleIndex
          lastAudibleSample = sampleIndex
        }
        if (sample < -1_000) negativeHalfCycle = true
        if (negativeHalfCycle && sample > 1_000) {
          crossings++
          negativeHalfCycle = false
        }
        sampleIndex++
      }
      val rms = sqrt(energy / (decoded.pcm.size / 2))
      assertTrue("Decoded amplitude must resemble the original signal: $rms", rms in 6_000.0..10_000.0)
      assertTrue("Decoded frequency must resemble the 440 Hz input: $crossings", crossings in 420..480)
      assertTrue("The entire original one-second signal must remain audible.", firstAudibleSample >= 0)
      assertEquals(1.0, (lastAudibleSample - firstAudibleSample + 1).toDouble() / sampleRate, 0.04)
    } finally {
      input.delete()
      output?.delete()
    }
  }

  @Test
  fun invalidInputFailsAndRemovesTheIncompleteCacheFile() = runBlocking {
    val input = File.createTempFile("invalid-audio-", ".m4a", context.cacheDir).apply {
      writeText("This file does not contain any audio.")
    }
    val before = conversionFiles()
    try {
      try {
        AudioToWavConverter.convert(context, Uri.fromFile(input))
        fail("Invalid input must not return a successful WAV.")
      } catch (_: Exception) {
        assertEquals(before, conversionFiles())
      }
    } finally {
      input.delete()
    }
  }

  @Test
  fun cancelledConversionRemovesItsPartialCacheFile() = runBlocking {
    val input = writeWave(sinePcm(48_000, 2, 48_000), 48_000, 2, repetitions = 120)
    val before = conversionFiles()
    val conversion = async(Dispatchers.IO) {
      AudioToWavConverter.convert(context, Uri.fromFile(input))
    }
    try {
      withTimeout(5_000) {
        while (conversionFiles() == before && conversion.isActive) delay(1)
      }
      conversion.cancelAndJoin()
      assertTrue("The test must cancel a running conversion.", conversion.isCancelled)
      assertEquals(before, conversionFiles())
    } finally {
      conversion.cancelAndJoin()
      input.delete()
      // Also reclaim files if an assertion fails after a surprisingly fast conversion.
      conversionFiles().filterNot { it in before }.forEach { File(context.cacheDir, it).delete() }
    }
  }

  private fun conversionFiles(): Set<String> = context.cacheDir.listFiles().orEmpty()
    .filter { it.name.startsWith("whisper-") && it.extension == "wav" }
    .map { it.name }
    .toSet()

  private fun sinePcm(sampleRate: Int, channels: Int, frames: Int): ByteArray =
    ByteBuffer.allocate(frames * channels * 2).order(ByteOrder.LITTLE_ENDIAN).apply {
      repeat(frames) { frame ->
        repeat(channels) { channel ->
          val frequency = if (channel == 0) 440.0 else 660.0
          putShort((sin(2 * PI * frequency * frame / sampleRate) * 12_000).toInt().toShort())
        }
      }
    }.array()

  private fun writeWave(pcm: ByteArray, sampleRate: Int, channels: Int, repetitions: Int = 1): File {
    val file = File.createTempFile("input-audio-", ".wav", context.cacheDir)
    val size = pcm.size * repetitions
    val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII))
      putInt(36 + size)
      put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
      putInt(16)
      putShort(1)
      putShort(channels.toShort())
      putInt(sampleRate)
      putInt(sampleRate * channels * 2)
      putShort((channels * 2).toShort())
      putShort(16)
      put("data".toByteArray(Charsets.US_ASCII))
      putInt(size)
    }
    file.outputStream().use { output ->
      output.write(header.array())
      repeat(repetitions) { output.write(pcm) }
    }
    return file
  }

  private data class Wave(
    val audioFormat: Int,
    val channels: Int,
    val sampleRate: Int,
    val bitsPerSample: Int,
    val pcm: ByteArray
  ) {
    val durationSeconds: Double get() = pcm.size.toDouble() / (sampleRate * channels * 2)
  }

  private fun readWave(file: File): Wave = RandomAccessFile(file, "r").use { input ->
    val header = ByteBuffer.wrap(ByteArray(44).also { input.readFully(it) }).order(ByteOrder.LITTLE_ENDIAN)
    assertEquals("RIFF", String(header.array(), 0, 4, Charsets.US_ASCII))
    assertEquals("WAVE", String(header.array(), 8, 4, Charsets.US_ASCII))
    assertEquals(file.length() - 8, header.getInt(4).toLong())
    val size = header.getInt(40)
    assertEquals(file.length() - 44, size.toLong())
    Wave(
      audioFormat = header.getShort(20).toInt(),
      channels = header.getShort(22).toInt(),
      sampleRate = header.getInt(24),
      bitsPerSample = header.getShort(34).toInt(),
      pcm = ByteArray(size).also { input.readFully(it) }
    )
  }

  private fun encodeAac(pcm: ByteArray, sampleRate: Int): File {
    val file = File.createTempFile("input-audio-", ".m4a", context.cacheDir)
    val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    var muxerStarted = false
    var succeeded = false
    try {
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, 64_000)
      }
      encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      encoder.start()
      var offset = 0
      var inputEnded = false
      var outputEnded = false
      var track = -1
      val info = MediaCodec.BufferInfo()
      val deadline = System.nanoTime() + 20_000_000_000L
      while (!outputEnded) {
        check(System.nanoTime() < deadline) { "Test AAC encoder timed out." }
        if (!inputEnded) {
          val index = encoder.dequeueInputBuffer(10_000)
          if (index >= 0) {
            val buffer = requireNotNull(encoder.getInputBuffer(index))
            buffer.clear()
            val count = minOf(buffer.remaining(), pcm.size - offset)
            if (count > 0) buffer.put(pcm, offset, count)
            encoder.queueInputBuffer(
              index, 0, count, offset.toLong() * 1_000_000 / (sampleRate * 2),
              if (count == 0) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0
            )
            offset += count
            inputEnded = count == 0
          }
        }
        when (val index = encoder.dequeueOutputBuffer(info, 10_000)) {
          MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            track = muxer.addTrack(encoder.outputFormat)
            muxer.start()
            muxerStarted = true
          }
          else -> if (index >= 0) {
            try {
              if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                check(muxerStarted)
                val buffer = requireNotNull(encoder.getOutputBuffer(index))
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                muxer.writeSampleData(track, buffer, info)
              }
              outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            } finally {
              encoder.releaseOutputBuffer(index, false)
            }
          }
        }
      }
      succeeded = true
      return file
    } finally {
      encoder.release()
      if (muxerStarted) muxer.stop()
      muxer.release()
      if (!succeeded) file.delete()
    }
  }

  private fun aacPacketCount(file: File): Int {
    val extractor = MediaExtractor()
    try {
      extractor.setDataSource(file.absolutePath)
      val track = (0 until extractor.trackCount).first { index ->
        extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) == MediaFormat.MIMETYPE_AUDIO_AAC
      }
      extractor.selectTrack(track)
      var packets = 0
      while (extractor.sampleTrackIndex >= 0) {
        packets++
        if (!extractor.advance()) break
      }
      return packets
    } finally {
      extractor.release()
    }
  }
}
