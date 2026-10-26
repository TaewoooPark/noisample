/* Audio stays in this processor and the local page. No microphone monitoring. */
class PeakCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.generation = 0;
    this.preLength = Math.round(sampleRate * 0.032);
    this.pre = new Float32Array(this.preLength);
    this.preCursor = 0;
    this.floor = 0.003;
    this.fast = 0;
    this.previousRms = 0;
    this.armed = true;
    this.quietSamples = 0;
    this.cooldown = 0;
    this.levelCounter = 0;
    this.capture = null;
    this.playbacks = [];
    this.port.onmessage = ({data}) => {
      if (data.type === 'reset') {
        this.generation = data.generation;
        this.pre.fill(0);
        this.preCursor = 0;
        this.floor = 0.003;
        this.fast = 0;
        this.previousRms = 0;
        this.capture = null;
        this.cooldown = Math.round(sampleRate * 0.15);
        this.armed = true;
        this.quietSamples = 0;
        this.playbacks = [];
      }
      if (data.type === 'playback' && data.generation === this.generation) {
        this.playbacks.push(data.time);
        if (this.playbacks.length > 48) this.playbacks.shift();
      }
    };
  }
  beginCapture() {
    const buffer = new Float32Array(Math.round(sampleRate * 1.8));
    for (let i = 0; i < this.preLength; i++) buffer[i] = this.pre[(this.preCursor + i) % this.preLength];
    this.capture = {buffer, length:this.preLength, quiet:0, peak:0, generation:this.generation};
    this.armed = false;
  }
  finishCapture() {
    const capture = this.capture;
    this.capture = null;
    this.cooldown = Math.round(sampleRate * 0.24);
    if (!capture || capture.peak < 0.045) return;
    const pcm = capture.buffer.slice(0, capture.length);
    this.port.postMessage({type:'capture', pcm, sampleRate, peak:capture.peak, generation:capture.generation}, [pcm.buffer]);
  }
  process(inputs, outputs) {
    // Explicitly write silence, even when a browser recycles an output quantum.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    const input = channels[0];
    const n = input.length;
    let square = 0, peak = 0;
    for (let i = 0; i < n; i++) { const value = input[i]; square += value * value; peak = Math.max(peak, Math.abs(value)); }
    const rms = Math.sqrt(square / Math.max(1, n));
    this.fast = this.fast * 0.5 + rms * 0.5;
    this.cooldown = Math.max(0, this.cooldown - n);
    const baseThreshold = Math.max(10 ** (-34 / 20), this.floor * 3.2);
    this.playbacks = this.playbacks.filter(time => time > currentTime - 0.08);
    const nearPlayback = this.playbacks.some(time => currentTime >= time - 0.008 && currentTime <= time + 0.065);
    const threshold = baseThreshold * (nearPlayback ? 1.7 : 1);
    if (rms < baseThreshold * 0.65) this.quietSamples += n;
    else this.quietSamples = 0;
    // A stationary tone can make one sound, but cannot keep retriggering itself.
    if (this.quietSamples > sampleRate * 0.055) this.armed = true;
    if (!this.capture) {
      // Quiet environments adapt quickly downward. Stationary loud backgrounds
      // also adapt slowly upward, so an air conditioner cannot lock the gate.
      const stationary = Math.abs(rms - this.previousRms) < Math.max(0.003, rms * 0.22);
      const coefficient = rms < this.floor ? 0.012 : (rms < baseThreshold || stationary) ? 0.0015 : 0;
      this.floor += (rms - this.floor) * coefficient;
      this.floor = Math.max(0.00015, Math.min(0.16, this.floor));
    }
    const rising = rms > this.previousRms * 1.18 || rms > baseThreshold * 2.8;
    if (!this.capture && this.armed && !this.cooldown && rms > threshold && peak > 0.045 && rising) this.beginCapture();
    if (this.capture) {
      const capture = this.capture;
      const remaining = capture.buffer.length - capture.length;
      const copyLength = Math.min(remaining, n);
      capture.buffer.set(input.subarray(0, copyLength), capture.length);
      capture.length += copyLength;
      capture.peak = Math.max(capture.peak, peak);
      capture.quiet = rms < baseThreshold * 0.7 ? capture.quiet + n : 0;
      if (capture.length >= capture.buffer.length || (capture.length >= sampleRate * 0.8 && capture.quiet >= sampleRate * 0.24)) this.finishCapture();
    }
    for (let i = 0; i < n; i++) { this.pre[this.preCursor] = input[i]; this.preCursor = (this.preCursor + 1) % this.preLength; }
    this.previousRms = rms;
    this.levelCounter += n;
    if (this.levelCounter >= sampleRate / 30) {
      this.levelCounter = 0;
      this.port.postMessage({type:'level', rms, peak, db:20 * Math.log10(Math.max(rms, 0.000001)), threshold:20 * Math.log10(threshold), capturing:!!this.capture, generation:this.generation});
    }
    return true;
  }
}
registerProcessor('peak-capture', PeakCaptureProcessor);
