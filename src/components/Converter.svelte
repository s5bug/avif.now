<script module lang="ts">
import { actions } from 'astro:actions'
import type { Frame, LibAV, Stream } from 'libav.js/from-browser-to-avif'
import { onMount, untrack } from 'svelte'
import { Av1TimeEstimator } from '../lib/av1_time_estimator.ts'
import { AVCodecID } from '../lib/ffmpeg_codec_ids.ts'

let libav: Promise<LibAV>
if (import.meta.env.SSR) {
  libav = (async () => {
    throw new Error("shouldn't await libav during SSR")
  })()
} else {
  const LibAV = await import('libav.js/from-browser-to-avif')
  const libavFactoryUrl = await import(
    '../../node_modules/libav.js/dist/libav-6.9.8.1-from-browser-to-avif.wasm.mjs?url'
  )
  const libavWasmUrl = await import(
    '../../node_modules/libav.js/dist/libav-6.9.8.1-from-browser-to-avif.wasm.wasm?url'
  )

  libav = LibAV.default.LibAV({
    noworker: false,
    nothreads: true,
    yesthreads: false,
    toImport: libavFactoryUrl.default,
    wasmurl: libavWasmUrl.default,
  })
}

const avcodecToWebcodec = (avcodec: number): string => {
  switch (avcodec) {
    case AVCodecID.AV_CODEC_ID_H264:
      return 'avc1.4d401e'
    case AVCodecID.AV_CODEC_ID_HEVC:
      return 'hev1.1.6.L93.B0'
    case AVCodecID.AV_CODEC_ID_VP8:
      return 'vp8'
    case AVCodecID.AV_CODEC_ID_VP9:
      return 'vp09.00.10.08'
    case AVCodecID.AV_CODEC_ID_AV1:
      return 'av01.0.04M.08'
    default:
      throw new Error(
        `don't know how to turn ${avcodec} (${AVCodecID[avcodec]}) into webcodec`,
      )
  }
}

interface DemuxCtx {
  fmt_ctx: number
  videoStream: Stream
  videoStreamIdx: number
}

const setupDemuxer = async (av: LibAV): Promise<DemuxCtx> => {
  // 2: create demuxer for input
  const [fmt_ctx, streams] = await av.ff_init_demuxer_file('in.vid')
  // find first video stream
  let videoStreamIdx: number = -1
  let videoStream: Stream | null = null
  for (let i = 0; i < streams.length; i++) {
    if (streams[i].codec_type === av.AVMEDIA_TYPE_VIDEO) {
      videoStreamIdx = i
      videoStream = streams[i]
      break
    }
  }
  if (videoStream === null) throw new Error('unable to find video stream')

  return { fmt_ctx, videoStream, videoStreamIdx }
}

interface VideoInfo {
  codec_id: number
  width: number
  height: number

  framerate_num: number
  framerate_den: number

  extradata?: Uint8Array
}

const readVideoInfo = async (av: LibAV, ctx: DemuxCtx): Promise<VideoInfo> => {
  const codecpar_ptr = ctx.videoStream.codecpar

  const codec_id = await av.AVCodecParameters_codec_id(codecpar_ptr)
  const width = await av.AVCodecParameters_width(codecpar_ptr)
  const height = await av.AVCodecParameters_height(codecpar_ptr)
  const framerate_num = await av.AVCodecParameters_framerate_num(codecpar_ptr)
  const framerate_den = await av.AVCodecParameters_framerate_den(codecpar_ptr)
  const extradata_ptr = await av.AVCodecParameters_extradata(codecpar_ptr)
  const extradata_size = await av.AVCodecParameters_extradata_size(codecpar_ptr)

  let result: VideoInfo = {
    codec_id,
    width,
    height,
    framerate_num,
    framerate_den,
  }
  if (extradata_ptr !== 0 && extradata_size > 0) {
    result.extradata = await av.copyout_u8(extradata_ptr, extradata_size)
  }
  return result
}

interface EncodeCtx {
  c_ctx: number
  frame_ptr: number
  pkt_ptr: number
  fmt_ctx: number
  io_ctx: number
}

const setupEncoder = async (
  av: LibAV,
  width: number,
  height: number,
): Promise<EncodeCtx> => {
  const [_codec, c_ctx, frame_ptr, pkt_ptr, _frame_size] =
    await av.ff_init_encoder('libaom-av1', {
      ctx: {
        width,
        height,
        pix_fmt: av.AV_PIX_FMT_YUV420P,
      },
      // 1 tick = 1 microsecond
      time_base: [1, 1000000],
      options: {
        'cpu-used': '4',
        // 'row-mt': '1',
        crf: '40',
        flags: '+global_header',
      },
    })

  const [fmt_ctx, _out_fmt, io_ctx, _streams] = await av.ff_init_muxer(
    { format_name: 'avif', filename: 'out.avif', open: true },
    // the stream operates in microseconds
    [[c_ctx, 1, 1000000]],
  )

  const writeHeaderRet = await av.avformat_write_header(fmt_ctx, 0)
  if (writeHeaderRet < 0)
    throw new Error(`avformat_write_header failed (${writeHeaderRet})`)

  return { c_ctx, frame_ptr, pkt_ptr, fmt_ctx, io_ctx }
}

const encodeFrame = async (
  av: LibAV,
  videoFrame: VideoFrame,
  avCtx: EncodeCtx,
) => {
  const { c_ctx, frame_ptr, pkt_ptr, fmt_ctx, io_ctx } = avCtx

  if (videoFrame.format !== 'I420') {
    console.warn(`the ${videoFrame.format} peg goes in the I420 hole`)
  }

  const visibleRect = videoFrame.visibleRect
  if (visibleRect === null)
    throw new Error(`malformed video? visibleRect was null`)
  const exactWidth = visibleRect.width
  const exactHeight = visibleRect.height

  const copyOptions: VideoFrameCopyToOptions = { rect: visibleRect }
  const allocationSize = videoFrame.allocationSize(copyOptions)
  const rawBuffer = new Uint8Array(allocationSize)
  await videoFrame.copyTo(rawBuffer, copyOptions)
  videoFrame.close()

  const frame: Frame = {
    data: rawBuffer,
    format: av.AV_PIX_FMT_YUV420P,
    width: exactWidth,
    height: exactHeight,
    // this timestamp is in microseconds so it lines up with the encoder timeline
    pts: videoFrame.timestamp,
    ptshi: 0,
  }

  const packets = await av.ff_encode_multi(
    c_ctx,
    frame_ptr,
    pkt_ptr,
    [frame],
    false,
  )

  if (packets.length > 0) {
    await av.ff_write_multi(fmt_ctx, pkt_ptr, packets)
  }
}

const flushAndExtract = async (
  av: LibAV,
  avCtx: EncodeCtx,
): Promise<Uint8Array<ArrayBuffer>> => {
  const { c_ctx, frame_ptr, pkt_ptr, fmt_ctx, io_ctx } = avCtx

  const flushPackets = await av.ff_encode_multi(
    c_ctx,
    frame_ptr,
    pkt_ptr,
    [],
    true,
  )
  if (flushPackets.length > 0) {
    await av.ff_write_multi(fmt_ctx, pkt_ptr, flushPackets)
  }

  const writeTrailerRet = await av.av_write_trailer(fmt_ctx)
  if (writeTrailerRet < 0)
    throw new Error(`av_write_trailer failed (${writeTrailerRet})`)

  await av.ff_free_muxer(fmt_ctx, io_ctx)
  await av.ff_free_encoder(c_ctx, frame_ptr, pkt_ptr)

  const avifData = await av.readFile('out.avif')

  await av.unlink('out.avif')

  return avifData as Uint8Array<ArrayBuffer>
}

const demuxIntoDecoder = async (
  av: LibAV,
  demuxCtx: DemuxCtx,
  videoInfo: VideoInfo,
  decoder: VideoDecoder,
): Promise<void> => {
  const demux_pkt_ptr = await av.av_packet_alloc()

  // default to 30fps
  let lastKnownDurationUs = 33333
  if (videoInfo.framerate_num > 0 && videoInfo.framerate_den > 0) {
    lastKnownDurationUs = Math.round(
      // microseconds from fraction
      (videoInfo.framerate_den / videoInfo.framerate_num) * 1000000,
    )
  }

  let previousPtsUs = 0

  while (true) {
    const [res, streamPackets] = await av.ff_read_frame_multi(
      demuxCtx.fmt_ctx,
      demux_pkt_ptr,
      {
        // 1MiB
        limit: 1048576,
      },
    )

    const videoPackets = streamPackets[demuxCtx.videoStreamIdx]

    for (const pkt of videoPackets) {
      const tb_num = demuxCtx.videoStream.time_base_num
      const tb_den = demuxCtx.videoStream.time_base_den

      let durationUs: number
      if (pkt.duration !== undefined && pkt.duration > 0) {
        durationUs = Math.round((pkt.duration * tb_num * 1000000) / tb_den)
        lastKnownDurationUs = durationUs
      } else {
        durationUs = lastKnownDurationUs
      }

      let ptsUs: number
      if (pkt.pts !== undefined) {
        ptsUs = Math.round((pkt.pts * tb_num * 1000000) / tb_den)
      } else {
        ptsUs = previousPtsUs + durationUs
      }

      previousPtsUs = ptsUs

      decoder.decode(
        new EncodedVideoChunk({
          type: (pkt.flags || 0) & av.AV_PKT_FLAG_KEY ? 'key' : 'delta',
          timestamp: ptsUs,
          duration: durationUs,
          data: pkt.data,
        }),
      )
    }

    if (res === av.AVERROR_EOF) {
      break
    }
  }

  await av.av_packet_free(demux_pkt_ptr)
}

// non-null if file written to internal FS
let usingForConversion: 'file' | 'tenor' | null = $state(null)
let nameForFfmpeg: string | null = $state(null)
let commandForFfmpeg: string[] | null = $derived.by(() => {
  if (nameForFfmpeg === null) return null
  else
    return [
      'ffmpeg',
      `-i "${nameForFfmpeg}"`,
      '-c:v libaom-av1',
      '-cpu-used 1',
      '-b:v 0',
      '-crf 40',
      'my_avif.avif',
    ]
})

let tenorViewUrl: string | null = $state(null)
let tenorViewUrlValid: boolean = $derived.by(() => {
  if (tenorViewUrl === null) return false
  return tenorViewUrl.startsWith('https://tenor.com/view/')
})
let tenorFetchError: string | false | null = $state(null)
const fetchGivenTenorUrl = async () => {
  if (tenorViewUrl !== null) {
    tenorFetchError = false
    const actionResult = await actions.tenorToMediaUrl({ url: tenorViewUrl })
    if (actionResult.error !== undefined) {
      // TODO check this
      tenorFetchError = `Couldn't retrieve video URL from Tenor (${actionResult.error.name}): ${actionResult.error.message}`
      usingForConversion = null
      return
    }

    const mediaUrl = actionResult.data
    let fetchFromTenor: Response
    try {
      fetchFromTenor = await fetch(mediaUrl)
    } catch {
      tenorFetchError = `Couldn't retrieve video data from Tenor`
      usingForConversion = null
      return
    }
    if (!fetchFromTenor.ok) {
      tenorFetchError = `Error when trying to retrieve video data from Tenor: ${fetchFromTenor.statusText}`
      usingForConversion = null
    }

    const videoBytes = await fetchFromTenor.bytes()
    const av = await libav
    await av.writeFile('in.vid', videoBytes)

    tenorFetchError = null
    usingForConversion = 'tenor'
    nameForFfmpeg = mediaUrl
  }
}

let files: FileList | null = $state(null)

let startTime: Temporal.Instant | null = $state(null)
let elapsed: Temporal.Duration | null = $state(null)
let lastEncodedFrame: Temporal.Instant | null = $state(null)
let estimatedTimeRemaining: Temporal.Duration | null = $state(null)
const timeRemainingNow = () => {
  if (estimatedTimeRemaining === null || lastEncodedFrame === null) return null
  else {
    const now = Temporal.Now.instant()
    const timePassed = lastEncodedFrame.until(now)
    return estimatedTimeRemaining.subtract(timePassed)
  }
}
let currentFrame: number = $state(0)
let totalFrames: number = $state(0)

let resultArray: Uint8Array<ArrayBuffer> | null = $state(null)
let resultUrl: string | null = $derived.by(() => {
  if (resultArray !== null) {
    const blob = new Blob([resultArray], { type: 'image/avif' })
    return URL.createObjectURL(blob)
  } else return null
})

const convertFile = async () => {
  if (usingForConversion !== null && startTime === null) {
    resultArray = null

    startTime = Temporal.Now.instant()
    const localTimeEstimator = new Av1TimeEstimator(startTime)
    currentFrame = 0
    totalFrames = 0

    const av = await libav

    const demuxCtx = await setupDemuxer(av)

    const videoInfo = await readVideoInfo(av, demuxCtx)

    const encodeCtx = await setupEncoder(av, videoInfo.width, videoInfo.height)

    let frameEncodingQueue: Promise<void> = Promise.resolve()

    const decoder = new VideoDecoder({
      output: (frame) => {
        totalFrames++

        frameEncodingQueue = frameEncodingQueue.then(async () => {
          await encodeFrame(av, frame, encodeCtx)
          lastEncodedFrame = Temporal.Now.instant()
          localTimeEstimator.nextFrameDone(lastEncodedFrame)
          estimatedTimeRemaining =
            localTimeEstimator.getEstimatedRemainingTime(totalFrames)
          currentFrame++
        })
      },
      error: (e) => console.error('video decoder error', e),
    })

    decoder.configure({
      codec: avcodecToWebcodec(videoInfo.codec_id),
      codedWidth: videoInfo.width,
      codedHeight: videoInfo.height,
      description: videoInfo.extradata,
      // we want to force I420
      hardwareAcceleration: 'prefer-software',
    })

    await demuxIntoDecoder(av, demuxCtx, videoInfo, decoder)

    await decoder.flush()
    await frameEncodingQueue
    resultArray = await flushAndExtract(av, encodeCtx)

    startTime = null
  }
}

const downloadAvif = () => {
  if (resultUrl !== null) {
    const link = document.createElement('a')
    link.href = resultUrl
    link.download = 'my_avif.avif'

    link.click()
  }
}
</script>

<script lang="ts">
let displayTimeRemaining: Temporal.Duration | null = $state(null)

onMount(() => {
  $effect(() => {
    const currentFileList = files
    untrack(async () => {
      if (currentFileList !== null) {
        const file = currentFileList[0]
        if (file !== undefined) {
          const uploadBytes = await file.bytes()
          const av = await libav
          await av.writeFile('in.vid', uploadBytes)

          usingForConversion = 'file'
          nameForFfmpeg = file.name
        }
      }
    })
  })

  $effect(() => {
    const timeNow = startTime
    if (timeNow !== null) {
      let keepGoing = true

      untrack(() => {
        const updateElapsed = () => {
          elapsed = Temporal.Now.instant().since(timeNow)
          displayTimeRemaining = timeRemainingNow()
          if (keepGoing) {
            requestAnimationFrame(updateElapsed)
          }
        }
        requestAnimationFrame(updateElapsed)
      })

      return () => {
        keepGoing = false
      }
    }
  })
})

const formatter = new Intl.DurationFormat('en-US', {
  style: 'narrow',
})

const roundOptions: Temporal.DurationRoundingOptions = {
  largestUnit: 'hours',
  smallestUnit: 'seconds',
}
const useFormatter = (x: Temporal.Duration) =>
  formatter.format(x.round(roundOptions))

let formattedElapsed = $derived.by(() => {
  if (elapsed !== null) return useFormatter(elapsed)
  else return '--:--'
})
let formattedTotal = $derived.by(() => {
  if (elapsed !== null && displayTimeRemaining !== null)
    return `~${useFormatter(elapsed.add(displayTimeRemaining))}`
  else return '--:--'
})
let formattedRemaining = $derived.by(() => {
  if (displayTimeRemaining !== null)
    return `~${useFormatter(displayTimeRemaining)}`
  else return null
})
</script>

<div>
  <label for="file-upload">Select a video (MP4, WebM):</label>
  <input id="file-upload" type="file" bind:files>
  {#if usingForConversion === 'file'}
    &check;
  {/if}
</div>

<div class="or-bar">
  <h4>or</h4>
</div>

<div>
  <label for="tenor-url">Tenor URL:</label>
  <input
    id="tenor-url"
    type="text"
    pattern="https:\/\/tenor\.com\/view\/.*"
    bind:value={tenorViewUrl}
    oninput={() => usingForConversion = null}
  >
  <button
    type="button"
    disabled={!tenorViewUrlValid || startTime !== null}
    onclick={fetchGivenTenorUrl}
  >
    Check
  </button>
  {#if usingForConversion === 'tenor'}
    &check;
  {/if}
  {#if tenorFetchError !== null && tenorFetchError === false}
    ⋯
  {/if}
  {#if tenorFetchError !== null && tenorFetchError !== false}
    &cross; {tenorFetchError}
  {/if}
</div>

<div>
  <p>
    FFmpeg command (much faster <em>and higher-quality</em> than using the
    browser):
  </p>
  {#if nameForFfmpeg !== null}
    <p class="code-paragraph">
      <code>
        {#each commandForFfmpeg as frag}
          <span class="dont-break">{frag}</span>{' '}
        {/each}
      </code>
    </p>
  {:else}
    <p><i>Select a video first!</i></p>
  {/if}
</div>

<div>
  <label for="convert">No FFmpeg? Use the browser anyway (slow): </label>
  <button
    id="convert"
    type="button"
    disabled={usingForConversion === null || nameForFfmpeg === null || startTime !== null}
    onclick={convertFile}
  >
    Convert
  </button>
</div>

{#if startTime !== null}
  <div class="progress-wrapper">
    <progress
      class="progress-bar"
      max={totalFrames}
      value={currentFrame}
    ></progress>

    <div class="progress-numbers">
      <span class="progress-fraction">{currentFrame}/{totalFrames}</span>
      <span class="progress-time">
        {formattedElapsed}/{formattedTotal}
        {#if formattedRemaining !== null}
          ({formattedRemaining}
          remaining)
        {/if}
      </span>
    </div>
  </div>
{/if}

{#if resultUrl !== null}
  <hr>
  <h3>Done!</h3>
  <div>
    Right click → "Save As", or
    <button type="button" onclick={downloadAvif}>Download</button>
  </div>
  <img alt="AVIF conversion of user input" src={resultUrl}>
{/if}

<style>
input,
button {
  max-width: 100%;
}

.or-bar h4 {
  text-transform: uppercase;
  display: flex;
  flex-direction: row;

  &:before,
  &:after {
    content: "";
    flex: 1 1;
    border-bottom: 1px solid;
    margin: auto;
  }

  &:before {
    margin-right: 10px;
  }

  &:after {
    margin-left: 10px;
  }
}

.code-paragraph {
  border-radius: 4px;
  padding: 4px;
  background-color: var(--bg-main);

  overflow-x: auto;
  overflow-wrap: normal;
}

.dont-break {
  white-space: nowrap;
}

.progress-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.progress-numbers {
  display: flex;
  justify-content: space-between;
}

.progress-bar {
  width: 100%;
}
</style>
