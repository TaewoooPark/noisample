export const GROOVE_PRESETS = [
  {name:'boom-bap-1', family:'boom-bap', swing:0.13, lanes:[[0,7,10,16,22,27],[4,12,20,28],[0,10,16,26],[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30],[14,30],[6,15,23,31]]},
  {name:'boom-bap-2', family:'boom-bap', swing:0.17, lanes:[[0,6,11,16,19,26],[4,12,20,28],[0,11,16,26],[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30],[10,30],[9,14,25,31]]},
  {name:'boom-bap-3', family:'boom-bap', swing:0.1, lanes:[[0,3,10,16,23,26],[4,12,20,28],[0,10,16,23],[0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30],[6,22,30],[7,15,24,31]]},
  {name:'trap-1', family:'trap', swing:0, lanes:[[0,6,10,16,23,27],[8,24],[0,10,16,27],[0,2,4,6,8,10,12,14,15,16,18,20,22,24,26,28,29,30,31],[7,23],[11,19,30]]},
  {name:'trap-2', family:'trap', swing:0, lanes:[[0,3,14,16,21,26],[8,24],[0,14,16,26],[0,2,4,6,7,8,10,12,14,16,18,20,22,23,24,26,28,30,31],[12,28],[5,15,22,31]]},
  {name:'trap-3', family:'trap', swing:0.035, lanes:[[0,5,11,16,22,29],[8,24],[0,11,16,29],[0,2,4,5,6,8,10,12,14,16,18,20,21,22,24,26,28,30,31],[6,22,30],[3,13,19,27]]}
];

export function waveformPeaks(pcm, count = 48) {
  const peaks = [];
  let largest = 0.0001;
  for (let i = 0; i < count; i++) {
    let peak = 0;
    const from = Math.floor(i * pcm.length / count);
    const to = Math.max(from + 1, Math.floor((i + 1) * pcm.length / count));
    for (let j = from; j < to && j < pcm.length; j++) peak = Math.max(peak, Math.abs(pcm[j]));
    peaks.push(peak); largest = Math.max(largest, peak);
  }
  return peaks.map(value => value / largest);
}

export function chooseLane(pcm, sampleRate, occupiedCounts = [0,0,0,0,0,0]) {
  let energy = 0, lowEnergy = 0, differences = 0, low = 0, crossings = 0, tail = 0;
  const alpha = 1 - Math.exp(-2 * Math.PI * 240 / sampleRate);
  for (let i = 0; i < pcm.length; i++) {
    const value = pcm[i];
    energy += value * value;
    low += alpha * (value - low);
    lowEnergy += low * low;
    if (i) { differences += (value - pcm[i-1]) ** 2; if (value * pcm[i-1] < 0) crossings++; }
    if (i > pcm.length * 0.6) tail += value * value;
  }
  const bass = Math.min(1, lowEnergy / Math.max(energy, 1e-12));
  const bright = Math.min(1, differences / Math.max(energy, 1e-12) / 1.8);
  const noisy = Math.min(1, crossings / Math.max(1, pcm.length) * 4);
  const sustain = Math.min(1, tail / Math.max(energy, 1e-12) * 3);
  const scores = [bass * 2 + (1-sustain)*0.3, noisy*0.65 + (1-bright)*0.35, bass*1.4+sustain*0.45, bright*1.3+noisy*0.4+(1-sustain)*0.25, bright+noisy*0.4+sustain*0.4, 0.55+(1-bass)*(1-bright)*0.35];
  const vacant = occupiedCounts.map((count,lane) => count === 0 ? lane : -1).filter(lane => lane >= 0);
  const options = vacant.length ? vacant : [0,1,2,3,4,5];
  return options.reduce((winner,lane) => scores[lane] - occupiedCounts[lane]*0.09 > scores[winner] - occupiedCounts[winner]*0.09 ? lane : winner, options[0]);
}

// Keep complete recordings apart on the two-bar circle, including its seam.
// Trying every anchor keeps the largest deterministic subset of preset onsets.
export function fitPatternSteps(patternSteps, duration, swing = 0) {
  const steps = [...new Set(patternSteps)].sort((a,b) => a-b);
  const gap = Math.max(0, duration) + 0.003;
  if (!steps.length || gap > 4) return [];
  const onset = step => step * 0.125 + (step % 2 ? swing * 0.125 : 0);
  let best = [];
  for (let anchorIndex = 0; anchorIndex < steps.length; anchorIndex++) {
    const anchor = steps[anchorIndex];
    const selected = [anchor];
    let previous = 0;
    for (let offset = 1; offset < steps.length; offset++) {
      const step = steps[(anchorIndex + offset) % steps.length];
      const elapsed = (onset(step) - onset(anchor) + 4) % 4;
      if (elapsed - previous >= gap - 1e-9 && 4 - elapsed >= gap - 1e-9) {
        selected.push(step);
        previous = elapsed;
      }
    }
    if (selected.length > best.length) best = selected;
  }
  return best.sort((a,b) => a-b);
}

export class BeatEngine {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.bpm = 120;
    this.state = 'idle';
    this.samples = Array.from({length:6},()=>[]);
    this.laneStepPools = Array(6).fill(null);
    this.laneBusyUntil = Array(6).fill(0);
    this.preset = GROOVE_PRESETS[Math.floor(Math.random()*GROOVE_PRESETS.length)];
    this.context = null;
    this.stream = null;
    this.generation = 0;
    this.serial = 0;
    this.sources = new Set();
    this.hitTimers = new Set();
    this.tick = null;
    this._starting = null;
    this._destroyed = false;
    this._onVisibility = () => {
      if (!this.context || this._destroyed) return;
      if(document.hidden) {
        this._stopTransport();
        this.context.suspend().catch(()=>{});
        if(this.state === 'running') this._setState('suspended');
      } else if(this.stream && this.stream.getAudioTracks().some(track=>track.readyState==='live')) {
        this.context.resume().then(()=>this._resumeTransport()).catch(()=>this._setState('suspended'));
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange',this._onVisibility);
  }
  _setState(state, error) {
    this.state = state;
    this.callbacks.onState?.(state,error);
  }
  start() {
    if(this._destroyed) return Promise.reject(new Error('This audio session has ended.'));
    if(this._starting) return this._starting;
    if(this.context && this.stream && this.stream.getAudioTracks().some(track=>track.readyState==='live')) {
      // Called directly inside a touch gesture so Safari can unlock audio.
      const resume=this.context.resume();
      return resume.then(()=>{this._resumeTransport();return this;});
    }
    if(!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone capture requires HTTPS and a browser with microphone support.');
      this._setState('error',error); return Promise.reject(error);
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if(!AudioContextClass) { const error=new Error('Web Audio is unavailable.');this._setState('error',error);return Promise.reject(error); }
    // Retrying after a disconnected device must not retain the old graph.
    this._releaseSession();
    this._setState('requesting');
    // Do not await permission before creating/resuming the context: iOS requires
    // this call while the initial touch still has user activation.
    this.context = new AudioContextClass({latencyHint:'interactive'});
    const context = this.context;
    const resume = context.resume();
    resume.catch(()=>{});
    this._starting = this._initialize(context,resume).finally(()=>{this._starting=null;});
    return this._starting;
  }
  async _initialize(context, firstResume) {
    try {
      const media = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:false,autoGainControl:false},video:false});
      if(this._destroyed || context !== this.context) {media.getTracks().forEach(track=>track.stop());return this;}
      this.stream = media;
      await firstResume.catch(()=>{});
      await context.resume();
      if(!context.audioWorklet) throw new Error('This browser does not support live audio processing.');
      await context.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url));
      if(this._destroyed || context !== this.context) {media.getTracks().forEach(track=>track.stop());return this;}
      this.input = context.createMediaStreamSource(media);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.input.connect(this.analyser);
      this.captureNode = new AudioWorkletNode(context,'peak-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      this.input.connect(this.captureNode);
      this.captureNode.connect(context.destination); // Processor outputs silence.
      this.captureNode.port.onmessage = ({data}) => {
        if(this._destroyed || data.generation !== this.generation || this.state !== 'running') return;
        if(data.type === 'level') this.callbacks.onLevels?.(data);
        if(data.type === 'capture') this._acceptSample(data);
      };
      this.captureNode.port.postMessage({type:'reset',generation:this.generation});
      this.master = context.createGain();
      // Six unchanged recordings can coincide. Fixed attenuation leaves headroom
      // without compressing, normalizing or reshaping their recorded dynamics.
      this.master.gain.value = 0.14;
      this.master.connect(context.destination);
      context.onstatechange=()=>{
        if(this._destroyed || context !== this.context) return;
        if(context.state==='suspended' || context.state==='interrupted') {
          this._stopTransport();
          if(this.state==='running')this._setState('suspended');
        } else if(context.state==='running' && this.state==='suspended' && !document.hidden) this._resumeTransport();
      };
      for(const track of media.getAudioTracks()) {
        track.addEventListener('ended',()=>{if(!this._destroyed && context===this.context && media===this.stream){this._stopTransport();this._setState('error',new Error('Microphone access ended.'));}});
        track.addEventListener('mute',()=>{if(!this._destroyed && context===this.context && media===this.stream && this.state==='running'){this._stopTransport();this._setState('suspended');}});
        track.addEventListener('unmute',()=>{if(!this._destroyed && context===this.context && media===this.stream && !document.hidden && context.state==='running')this._resumeTransport();});
      }
      this._resumeTransport(true);
      return this;
    } catch(error) {
      this._stopTransport();
      this.stream?.getTracks().forEach(track=>track.stop());
      this.stream=null;
      try {await context.close();} catch(_) {}
      if(this.context===context)this.context=null;
      if(!this._destroyed)this._setState(error.name==='NotAllowedError' || error.name==='PermissionDeniedError' ? 'denied' : 'error',error);
      throw error;
    }
  }
  _releaseSession() {
    this._stopTransport();
    const context=this.context,stream=this.stream;
    this.context=null;this.stream=null;
    if(context)context.onstatechange=null;
    if(this.captureNode)this.captureNode.port.onmessage=null;
    for(const name of ['input','analyser','captureNode','master']) {try{this[name]?.disconnect();}catch(_){}this[name]=null;}
    stream?.getTracks().forEach(track=>track.stop());
    if(context && context.state!=='closed')context.close().catch(()=>{});
  }
  _resumeTransport(fromStart=false) {
    if(!this.context || this.context.state!=='running' || !this.master || this._destroyed) {if(!this._destroyed)this._setState('suspended');return;}
    if(this.tick) {if(this.state!=='running')this._setState('running');return;}
    this.origin=this.context.currentTime+0.12;
    this.nextStep=0;
    this.absoluteStep=0;
    this._setState('running');
    this.tick=setInterval(()=>this._schedule(),25);
    this._schedule();
  }
  _stopTransport() {
    clearInterval(this.tick);this.tick=null;
    this.laneBusyUntil.fill(0);
    for(const timer of this.hitTimers)clearTimeout(timer);this.hitTimers.clear();
    for(const source of this.sources){try{source.stop();}catch(_){}try{source.disconnect();}catch(_){}}this.sources.clear();
  }
  _acceptSample(data) {
    // The browser's captured PCM is the playback material, unchanged. Analysis
    // decides a rhythmic role only; it never writes into the recording.
    const pcm=data.pcm;
    const lane=chooseLane(pcm,data.sampleRate,this.samples.map(samples=>samples.length));
    const origin=Number.isFinite(this.origin) ? this.origin : this.context.currentTime;
    const sample={id:++this.serial,lane,peaks:waveformPeaks(pcm),steps:[],duration:pcm.length/data.sampleRate,strength:Math.min(1,data.peak*2.5),createdAt:performance.now(),activeAt:origin+Math.ceil((this.context.currentTime+0.66-origin)/0.125)*0.125,buffer:this.context.createBuffer(1,pcm.length,data.sampleRate)};
    sample.buffer.copyToChannel(pcm,0);
    const samples=this.samples[lane];
    const evicted=[];
    samples.push(sample);
    while(samples.length>3)evicted.push(samples.shift().id);
    evicted.push(...this._assignSteps(lane));
    if(evicted.length){sample.evictedId=evicted[0];sample.evictedIds=evicted;}
    this.callbacks.onCapture?.(sample);
  }
  _assignSteps(lane) {
    const samples=this.samples[lane];
    if(!samples.length)return [];
    const longest=Math.max(...samples.map(sample=>sample.duration));
    // A lane may thin as longer sounds arrive, but only removes old onsets.
    // This also keeps tails already scheduled on the previous plan safe.
    const pool=this.laneStepPools[lane] || this.preset.lanes[lane];
    const steps=fitPatternSteps(pool,longest,this.preset.swing);
    this.laneStepPools[lane]=steps;
    const evicted=[];
    while(samples.length>steps.length)evicted.push(samples.shift().id);
    for(const sample of samples)sample.steps=[];
    steps.forEach((step,index)=>samples[index%samples.length].steps.push(step));
    return evicted;
  }
  _schedule() {
    if(this.state!=='running' || !this.context)return;
    const duration=60/this.bpm/4;
    const now=this.context.currentTime;
    if(this.origin+this.absoluteStep*duration < now-0.2) this.absoluteStep=Math.ceil((now-this.origin)/duration);
    while(this.origin+this.absoluteStep*duration < now+0.11) {
      const step=this.absoluteStep%32;
      const loop=Math.floor(this.absoluteStep/32);
      const time=this.origin+this.absoluteStep*duration+(step%2 ? duration*this.preset.swing : 0);
      for(let lane=0;lane<6;lane++) {
        const sample=this.samples[lane].find(sample=>sample.steps.includes(step));
        if(sample && time>=sample.activeAt && time>=now-0.008) {
          this._play(sample,Math.max(now,time),1,step,loop);
        }
      }
      this.absoluteStep++;
    }
  }
  _trackSource(source) {
    this.sources.add(source);
    source.onended=()=>{this.sources.delete(source);try{source.disconnect();}catch(_){};};
  }
  _play(sample,time,velocity,step,loop) {
    const context=this.context,lane=sample.lane;
    // Defensive only: the visible lane plan already spaces complete recordings.
    if(time < this.laneBusyUntil[lane] - 1e-6)return false;
    const source=context.createBufferSource();
    const gain=context.createGain();
    const length=sample.buffer.duration;
    const edge=Math.min(0.003,length/2);
    source.buffer=sample.buffer;
    source.playbackRate.value=1;
    source.detune.value=0;
    source.loop=false;
    // Only the first/last 3 ms are softened to avoid boundary clicks. The entire
    // body plays at its recorded speed, pitch and relative level in every role.
    gain.gain.setValueAtTime(0,time);
    gain.gain.linearRampToValueAtTime(1,time+edge);
    gain.gain.setValueAtTime(1,time+length-edge);
    gain.gain.linearRampToValueAtTime(0,time+length);
    source.connect(gain);gain.connect(this.master);
    this._trackSource(source);
    source.addEventListener('ended',()=>gain.disconnect(),{once:true});
    source.start(time);source.stop(time+length);
    this.laneBusyUntil[lane]=time+length;
    this.captureNode?.port.postMessage({type:'playback',time,generation:this.generation});
    const generation=this.generation;
    const delayMs=Math.max(0,(time-context.currentTime+(context.outputLatency || context.baseLatency || 0))*1000);
    const timer=setTimeout(()=>{this.hitTimers.delete(timer);if(generation===this.generation && this.state==='running')this.callbacks.onHit?.({lane,sampleId:sample.id,step,time,delayMs:0,velocity:1,duration:length});},delayMs);
    this.hitTimers.add(timer);
    return true;
  }
  getPosition() {
    if(!this.context || !Number.isFinite(this.origin) || this.state!=='running')return 0;
    const duration=60/this.bpm/4;
    let clock=this.context.currentTime;
    if(typeof this.context.getOutputTimestamp==='function') {
      const stamp=this.context.getOutputTimestamp();
      if(stamp.contextTime>0)clock=stamp.contextTime+(performance.now()-stamp.performanceTime)/1000;
    }
    return Math.max(0,(clock-this.origin)/duration)%32;
  }
  getWaveform(target) {
    if(this.analyser && this.state==='running')this.analyser.getFloatTimeDomainData(target);
    else target.fill(0);
    return target;
  }
  reset() {
    this.generation++;
    this._stopTransport();
    this.samples=Array.from({length:6},()=>[]);
    this.laneStepPools=Array(6).fill(null);
    this.preset=GROOVE_PRESETS[Math.floor(Math.random()*GROOVE_PRESETS.length)];
    this.captureNode?.port.postMessage({type:'reset',generation:this.generation});
    this.callbacks.onLevels?.({rms:0,peak:0,db:-120,threshold:-34,capturing:false,generation:this.generation});
    if(this.context?.state==='running' && this.stream)this._resumeTransport(true);
    else if(this.stream)this._setState('suspended');
    else this._setState('idle');
  }
  async destroy() {
    this._destroyed=true;
    this.generation++;
    this._stopTransport();
    document.removeEventListener('visibilitychange',this._onVisibility);
    this.stream?.getTracks().forEach(track=>track.stop());this.stream=null;
    this.input?.disconnect();this.analyser?.disconnect();this.captureNode?.disconnect();this.master?.disconnect();
    if(this.captureNode)this.captureNode.port.onmessage=null;
    if(this.context){this.context.onstatechange=null;try{await this.context.close();}catch(_){}this.context=null;}
    this.samples=Array.from({length:6},()=>[]);
    this._setState('idle');
  }
}
