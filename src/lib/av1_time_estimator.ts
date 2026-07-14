export class Av1TimeEstimator {
  startTime: Temporal.Instant
  slidingWindow: number
  frameEncodingTimes: Temporal.Instant[]

  constructor(startTime: Temporal.Instant, slidingWindow: number = 35) {
    this.startTime = startTime
    this.slidingWindow = slidingWindow
    this.frameEncodingTimes = []
  }

  nextFrameDone(when: Temporal.Instant) {
    this.frameEncodingTimes.push(when)
  }

  getEstimatedRemainingTime(totalFrames: number): Temporal.Duration | null {
    if (this.frameEncodingTimes.length <= this.slidingWindow) return null

    // first sample after the first sliding window
    const firstSample = this.frameEncodingTimes[this.slidingWindow]
    const lastSample =
      this.frameEncodingTimes[this.frameEncodingTimes.length - 1]

    const frameCount = this.frameEncodingTimes.length - this.slidingWindow
    const timeElapsed = lastSample.since(firstSample)

    if (frameCount === 0) return null

    const msPerFrame = timeElapsed.total('milliseconds') / frameCount

    const unpushedFrames = totalFrames - this.frameEncodingTimes.length
    const remainingEncodeFrames = unpushedFrames + this.slidingWindow
    const remainingTime = remainingEncodeFrames * msPerFrame

    return Temporal.Duration.from({ milliseconds: Math.round(remainingTime) })
  }
}
