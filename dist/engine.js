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

function cleanPCM(input) {
  const output = new Float32Array(input.length);
  let mean = 0, peak = 0;
  for (const value of input) mean += value;
  mean /= Math.max(1, input.length);
  for (let i = 0; i < input.length; i++) { output[i] = input[i] - mean; peak = Math.max(peak, Math.abs(output[i])); }
  const multiplier = 0.84 / Math.max(peak, 0.001);
  const fade = Math.min(120, Math.floor(input.length / 6));
  for (let i = 0; i < output.length; i++) {
    const edge = Math.min(1, i / Math.max(1,fade), (output.length - 1 - i) / Math.max(1,fade));
    output[i] *= multiplier * edge;
  }
  return output;
}

function prepareTexture(pcm, sampleRate, lane) {
  let onset=0;
  while(onset<pcm.length-1 && Math.abs(pcm[onset])<0.055)onset++;
  const start=Math.max(0,onset-Math.round(sampleRate*0.002));
  const texture=pcm.slice(start);
  if(lane!==3 && lane!==4)return texture;
  // Drive and differentiate the actual recording before normalizing its high
  // frequencies. Even a low-pitched first sound can become an audible hat.
  let low=0,peak=0;
  const alpha=1-Math.exp(-2*Math.PI*2100/sampleRate);
  for(let i=0;i<texture.length;i++) {
    const driven=Math.tanh(texture[i]*9);
    low+=alpha*(driven-low);
    texture[i]=driven-low;
    peak=Math.max(peak,Math.abs(texture[i]));
  }
  const scale=0.8/Math.max(peak,0.0001);
  for(let i=0;i<texture.length;i++)texture[i]*=scale;
  return texture;
}

// A loopable waveform is cut from the recorded transient. This is a sample
// instrument: no oscillator or prerecorded drums are used for its low end.
function makeGrain(pcm, sampleRate) {
  const length = Math.round(sampleRate / 55);
  let best = Math.min(Math.round(sampleRate*0.035), Math.max(0,pcm.length-length)), bestEnergy = -1;
  for (let start = Math.round(sampleRate*0.015); start + length < pcm.length; start += Math.max(1,Math.floor(length/4))) {
    let energy = 0;
    for (let i=0; i<length; i++) energy += pcm[start+i]*pcm[start+i];
    if (energy > bestEnergy) { bestEnergy=energy; best=start; }
  }
  const grain = new Float32Array(length);
  for (let i=0; i<length; i++) grain[i]=pcm[Math.min(pcm.length-1,best+i)] || 0;
  const crossfade = Math.floor(length*0.14);
  for (let i=0; i<crossfade; i++) {
    const t=i/crossfade;
    const a=grain[i], b=grain[length-crossfade+i];
    const mixed=a*t+b*(1-t);
    grain[i]=mixed;
    grain[length-crossfade+i]=mixed;
  }
  let smooth=0;
  const alpha=1-Math.exp(-2*Math.PI*220/sampleRate);
  for(let cycle=0;cycle<4;cycle++)for(let i=0;i<length;i++){smooth+=alpha*(grain[i]-smooth);if(cycle===3)grain[i]=smooth;}
  let mean=0; for(const value of grain)mean+=value; mean/=length;
  let max=0.0001; for(let i=0;i<length;i++){grain[i]-=mean;max=Math.max(max,Math.abs(grain[i]));}
  for(let i=0;i<length;i++)grain[i]=grain[i]/max*0.85;
  return grain;
}

export class BeatEngine {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.bpm = 120;
    this.state = 'idle';
    this.samples = Array.from({length:6},()=>[]);
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
      this.master.gain.value = 0.7;
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value=-14; compressor.knee.value=8; compressor.ratio.value=8;
      compressor.attack.value=0.003; compressor.release.value=0.14;
      this.master.connect(compressor); compressor.connect(context.destination);
      this.compressor=compressor;
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
    for(const name of ['input','analyser','captureNode','master','compressor']) {try{this[name]?.disconnect();}catch(_){}this[name]=null;}
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
    for(const timer of this.hitTimers)clearTimeout(timer);this.hitTimers.clear();
    for(const source of this.sources){try{source.stop();}catch(_){}try{source.disconnect();}catch(_){}}this.sources.clear();
  }
  _acceptSample(data) {
    const pcm=cleanPCM(data.pcm);
    const lane=chooseLane(pcm,data.sampleRate,this.samples.map(samples=>samples.length));
    const texture=prepareTexture(pcm,data.sampleRate,lane);
    const sample={id:++this.serial,lane,peaks:waveformPeaks(pcm),steps:[],duration:pcm.length/data.sampleRate,strength:Math.min(1,data.peak*2.5),createdAt:performance.now(),activeAt:this.origin+Math.ceil((this.context.currentTime+0.66-this.origin)/0.125)*0.125,buffer:this.context.createBuffer(1,texture.length,data.sampleRate)};
    sample.buffer.copyToChannel(texture,0);
    if(lane===0 || lane===2) {const grain=makeGrain(pcm,data.sampleRate);sample.grain=this.context.createBuffer(1,grain.length,data.sampleRate);sample.grain.copyToChannel(grain,0);}
    const samples=this.samples[lane];
    if(samples.length>=Math.min(3,this.preset.lanes[lane].length)) sample.evictedId=samples.shift().id;
    samples.push(sample);
    this._assignSteps(lane);
    this.callbacks.onCapture?.(sample);
  }
  _assignSteps(lane) {
    const samples=this.samples[lane];
    for(const sample of samples)sample.steps=[];
    this.preset.lanes[lane].forEach((step,index)=>{if(samples.length)samples[index%samples.length].steps.push(step);});
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
          const velocity=lane===3 ? (step%4===0 ? 0.78 : step%2 ? 0.42 : 0.59) : lane===5 ? 0.57 : 0.9;
          this._play(sample,Math.max(now,time),velocity,step,loop);
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
    const source=context.createBufferSource();
    const gain=context.createGain();
    const filter=context.createBiquadFilter();
    let length,volume;
    if(lane===0 || lane===2) {
      source.buffer=sample.grain;source.loop=true;filter.type='lowpass';filter.Q.value=0.7;
      if(lane===0) {
        length=0.27;volume=0.81;filter.frequency.value=185;
        source.playbackRate.setValueAtTime(2.4,time);source.playbackRate.exponentialRampToValueAtTime(0.78,time+0.13);
      } else {
        length=this.preset.family==='trap' ? 0.52 : 0.33;volume=0.48;filter.frequency.value=230;
        const note=[0,0,-5,3][Math.floor(step/8)%4];
        const octave=loop%4===3 && step>=24 ? 1 : 0;
        source.playbackRate.value=2**((note+octave*12)/12);
      }
    } else {
      source.buffer=sample.buffer;
      const settings={1:[0.18,0.67,800,0.93,'highpass'],3:[0.058,0.46,3100,1.85,'highpass'],4:[0.23,0.38,2400,1.45,'highpass'],5:[0.115,0.46,1200,1.18,'bandpass']}[lane];
      [length,volume,filter.frequency.value,source.playbackRate.value,filter.type]=settings;
      filter.Q.value=lane===5 ? 0.65 : 0.6;
      length=Math.min(length,source.buffer.duration/source.playbackRate.value);
    }
    gain.gain.setValueAtTime(0,time);
    gain.gain.linearRampToValueAtTime(volume*velocity,time+0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001,time+Math.max(0.009,length));
    source.connect(filter);filter.connect(gain);gain.connect(this.master);
    this._trackSource(source);
    source.addEventListener('ended',()=>{filter.disconnect();gain.disconnect();},{once:true});
    source.start(time);source.stop(time+length+0.025);
    // The actual recorded attack keeps the kick connected to the source sound.
    if(lane===0) {
      const attack=context.createBufferSource();attack.buffer=sample.buffer;
      const attackGain=context.createGain();attackGain.gain.setValueAtTime(velocity*0.12,time);attackGain.gain.exponentialRampToValueAtTime(0.0001,time+0.035);
      attack.connect(attackGain);attackGain.connect(this.master);this._trackSource(attack);
      attack.addEventListener('ended',()=>attackGain.disconnect(),{once:true});attack.start(time);attack.stop(time+0.04);
    }
    this.captureNode?.port.postMessage({type:'playback',time,generation:this.generation});
    const generation=this.generation;
    const delayMs=Math.max(0,(time-context.currentTime+(context.outputLatency || context.baseLatency || 0))*1000);
    const timer=setTimeout(()=>{this.hitTimers.delete(timer);if(generation===this.generation && this.state==='running')this.callbacks.onHit?.({lane,sampleId:sample.id,step,time,delayMs:0,velocity});},delayMs);
    this.hitTimers.add(timer);
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
    this.input?.disconnect();this.analyser?.disconnect();this.captureNode?.disconnect();this.master?.disconnect();this.compressor?.disconnect();
    if(this.captureNode)this.captureNode.port.onmessage=null;
    if(this.context){this.context.onstatechange=null;try{await this.context.close();}catch(_){}this.context=null;}
    this.samples=Array.from({length:6},()=>[]);
    this._setState('idle');
  }
}
