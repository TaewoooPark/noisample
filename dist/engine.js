import { DEFAULT_BPM, FIRST_PULSE_STEPS, PLACEMENT_SECONDS, STARTER_GROOVE } from './patterns.js';
import { classifySample } from './analysis.js';
import { MelodyEngine } from './melody.js';
export { GROOVE_PRESETS } from './patterns.js';

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

export function chooseLane(pcm, sampleRate, occupiedCounts = [0,0,0,0,0,0], excludedLanes = []) {
  return classifySample(pcm, sampleRate, occupiedCounts, excludedLanes).lane;
}

// Keep complete recordings apart on the two-bar circle, including its seam.
// Trying every anchor keeps the largest deterministic subset of preset onsets.
export function fitPatternSteps(patternSteps, duration, swing = 0, bpm = DEFAULT_BPM) {
  const steps = [...new Set(patternSteps)].sort((a,b) => a-b);
  const gap = Math.max(0, duration) + 0.003;
  const stepSeconds = 60 / bpm / 4;
  const loopSeconds = stepSeconds * 32;
  if (!steps.length || gap > loopSeconds) return [];
  const onset = step => step * stepSeconds + (step % 2 ? swing * stepSeconds : 0);
  let best = [];
  for (let anchorIndex = 0; anchorIndex < steps.length; anchorIndex++) {
    const anchor = steps[anchorIndex];
    const selected = [anchor];
    let previous = 0;
    for (let offset = 1; offset < steps.length; offset++) {
      const step = steps[(anchorIndex + offset) % steps.length];
      const elapsed = (onset(step) - onset(anchor) + loopSeconds) % loopSeconds;
      if (elapsed - previous >= gap - 1e-9 && loopSeconds - elapsed >= gap - 1e-9) {
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
    this.bpm = DEFAULT_BPM;
    this.state = 'idle';
    this.samples = Array.from({length:6},()=>[]);
    this.anchorLane = null;
    this.anchorSampleId = null;
    this.laneStepPools = Array(6).fill(null);
    this.laneBusyUntil = Array(6).fill(0);
    this.preset = STARTER_GROOVE;
    this.context = null;
    this.stream = null;
    this.generation = 0;
    this.serial = 0;
    this.sources = new Set();
    this.hitTimers = new Set();
    this.tick = null;
    this._starting = null;
    this._destroyed = false;
    this._graphReady = false;
    this._audioReady = false;
    this._recovery = null;
    this._needsRebuild = false;
    this.melody = null;
    this._melodyReady = false;
    this._melodyStarted = false;
    this._melodySeed = undefined;
    this._onVisibility = () => {
      if (!this.context || this._destroyed) return;
      if(document.hidden) {
        // The OS permission sheet can transiently hide the page. Suspending
        // before the capture graph exists can strand the initial unlock.
        if (!this._graphReady) return;
        this._stopTransport();
        this._cancelRecovery();
        this._audioReady = false;
        this.context.suspend().catch(()=>{});
        if(this.state === 'running') this._setState('suspended');
      } else if(this.stream && this.stream.getAudioTracks().some(track=>track.readyState==='live')) {
        this._requestResume(this.context);
        if (this._graphReady) this._recoverContext(this.context);
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange',this._onVisibility);
  }
  _setState(state, error) {
    this.state = state;
    this.callbacks.onState?.(state,error);
  }
  _hasLiveMicrophone() {
    return !!this.stream?.getAudioTracks().some(track => track.readyState === 'live');
  }
  _requestResume(context, gesture = false) {
    if (!context || context !== this.context || context.state === 'closed') return;
    // Never await this promise: WebKit can leave it pending across the first
    // microphone permission sheet. Each new gesture must be able to try again.
    try { Promise.resolve(context.resume()).catch(() => {}); } catch (_) {}
    if (gesture && typeof context.createBufferSource === 'function' && typeof context.createBuffer === 'function') {
      try {
        const unlock = context.createBufferSource();
        unlock.buffer = context.createBuffer(1, 1, context.sampleRate || 44100);
        unlock.connect(context.destination);
        unlock.onended = () => { try { unlock.disconnect(); } catch (_) {} };
        unlock.start(); // One zero-valued frame opens the output route silently.
      } catch (_) {}
    }
  }
  _createContext(AudioContextClass) {
    const context = new AudioContextClass({latencyHint:'interactive'});
    this.context = context;
    this._graphReady = false;
    this._audioReady = false;
    this._needsRebuild = false;
    // Install this before the permission prompt can interrupt the audio route.
    context.onstatechange = () => {
      if (this._destroyed || context !== this.context) return;
      if (context.state === 'suspended' || context.state === 'interrupted') {
        this._audioReady = false;
        this._stopTransport();
        if (this._graphReady) {
          this._setState('suspended');
          if (!document.hidden) this._recoverContext(context);
        }
      } else if (context.state === 'running' && this._graphReady && !document.hidden) {
        this._recoverContext(context);
      } else if (context.state === 'closed' && this._graphReady) {
        this._stopTransport();
        this._cancelRecovery();
        this._audioReady = false;
        this._needsRebuild = true;
        this._setState('suspended');
      }
    };
    this._requestResume(context, true);
    return context;
  }
  start() {
    if (this._destroyed) return Promise.reject(new Error('This audio session has ended.'));
    // A second touch is useful even while permission/worklet setup is pending.
    // It must not get trapped behind the first unresolved resume promise.
    if (this.context) this._requestResume(this.context, true);
    if (this._starting) return this._starting;
    if (this.context && this._hasLiveMicrophone() && this._graphReady) {
      if (this.state === 'running' && this.context.state === 'running' && this._audioReady) return Promise.resolve(this);
      if (!this._needsRebuild && this.context.state !== 'closed') return this._recoverContext(this.context);
      // A failed bounded recovery may mean iOS left this particular context
      // unusable. A fresh gesture can rebuild it without a new permission prompt.
      const media = this._releaseSession(true);
      const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
      this._setState('requesting');
      const context = this._createContext(AudioContextClass);
      return this._launchInitialization(context, media);
    }
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone capture requires HTTPS and a browser with microphone support.');
      this._setState('error',error); return Promise.reject(error);
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) { const error=new Error('Web Audio is unavailable.');this._setState('error',error);return Promise.reject(error); }
    this._releaseSession();
    this._setState('requesting');
    const context = this._createContext(AudioContextClass);
    return this._launchInitialization(context);
  }
  _launchInitialization(context, media = null) {
    const pending = this._initialize(context, media).finally(() => {
      if (this._starting === pending) this._starting = null;
    });
    this._starting = pending;
    return pending;
  }
  _cancelRecovery() {
    const recovery = this._recovery;
    if (!recovery) return;
    clearTimeout(recovery.timer);
    this._recovery = null;
    recovery.resolve(this);
  }
  _recoverContext(context) {
    if (this._destroyed || context !== this.context || !this._graphReady) return Promise.resolve(this);
    if (this._audioReady && context.state === 'running' && !document.hidden) {
      this._needsRebuild = false;
      this._resumeTransport();
      this._cancelRecovery();
      return Promise.resolve(this);
    }
    if (this._recovery?.context === context) return this._recovery.promise;
    this._cancelRecovery();
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const recovery = {context, promise, resolve, timer:null, began:performance.now(), clock:context.currentTime, attempt:0};
    this._recovery = recovery;
    const check = () => {
      if (this._recovery !== recovery) return;
      if (this._destroyed || context !== this.context || document.hidden) { this._cancelRecovery(); return; }
      // State alone can say running while the iOS audio hardware is stalled.
      // Either advancing audio time or a worklet heartbeat confirms it is live.
      if (context.state === 'running' && (this._audioReady || context.currentTime > recovery.clock + 0.005)) {
        this._audioReady = true;
        this._needsRebuild = false;
        this._resumeTransport();
        this._cancelRecovery();
        return;
      }
      const elapsed = performance.now() - recovery.began;
      if (elapsed >= 1200) {
        this._needsRebuild = true;
        this._setState('suspended');
        this._cancelRecovery();
        return;
      }
      if ([0, 2, 5, 9].includes(recovery.attempt)) this._requestResume(context);
      recovery.attempt++;
      recovery.timer = setTimeout(check, 100);
    };
    check();
    return promise;
  }
  async _initialize(context, retainedMedia = null) {
    let media = retainedMedia;
    try {
      // Load the small processor while the user is answering the permission
      // prompt instead of adding another network wait after approval.
      const moduleReady = context.audioWorklet
        ? context.audioWorklet.addModule(new URL('./capture-worklet.js',import.meta.url))
        : Promise.reject(new Error('This browser does not support live audio processing.'));
      moduleReady.catch(() => {});
      if (!media) media = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:false,autoGainControl:false},video:false});
      if (this._destroyed || context !== this.context) { if(media !== this.stream) media.getTracks().forEach(track=>track.stop()); return this; }
      this.stream = media;
      this._requestResume(context);
      await moduleReady;
      if (this._destroyed || context !== this.context) { if(media !== this.stream) media.getTracks().forEach(track=>track.stop()); return this; }
      this.input = context.createMediaStreamSource(media);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.input.connect(this.analyser);
      this.captureNode = new AudioWorkletNode(context,'peak-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      this.input.connect(this.captureNode);
      this.captureNode.connect(context.destination); // Processor outputs silence.
      this.captureNode.port.onmessage = ({data}) => {
        if(this._destroyed || context !== this.context || data.generation !== this.generation) return;
        if(data.type === 'level') {
          this._audioReady = true;
          if (context.state === 'running' && !document.hidden) this._recoverContext(context);
          if (this.state === 'running') this.callbacks.onLevels?.(data);
        }
        if(data.type === 'capture' && this.state === 'running') this._acceptSample(data);
      };
      this.captureNode.port.postMessage({type:'reset',generation:this.generation});
      this.master = context.createGain();
      // Up to four full anchor tails and five other lanes can coincide. Fixed
      // attenuation leaves headroom without reshaping their recorded dynamics.
      this.master.gain.value = 0.085;
      this.master.connect(context.destination);
      this._graphReady = true;
      // Keyboard assets prepare independently: permission and raw capture never
      // wait for a download or decode. The six-role gate runs on this same clock.
      this._prepareMelody(context);
      // AudioBuffer data survives a context replacement, but its old context's
      // timestamps do not. Existing recordings are ready on the new clock.
      for (const bank of this.samples) for (const sample of bank) sample.activeAt = 0;
      for(const track of media.getAudioTracks()) {
        track.addEventListener('ended',()=>{if(!this._destroyed && context===this.context && media===this.stream){this._stopTransport();this._cancelRecovery();this._setState('error',new Error('Microphone access ended.'));}});
        track.addEventListener('mute',()=>{if(!this._destroyed && context===this.context && media===this.stream && this.state==='running'){this._stopTransport();this._audioReady=false;this._setState('suspended');}});
        track.addEventListener('unmute',()=>{if(!this._destroyed && context===this.context && media===this.stream && !document.hidden){this._requestResume(context);this._recoverContext(context);}});
      }
      this._requestResume(context);
      await this._recoverContext(context);
      return this;
    } catch(error) {
      if (context !== this.context || this._destroyed) {
        if (media && media !== this.stream) media.getTracks().forEach(track=>track.stop());
        return this;
      }
      this._releaseSession();
      this._setState(error.name==='NotAllowedError' || error.name==='PermissionDeniedError' ? 'denied' : 'error',error);
      throw error;
    }
  }
  _releaseSession(keepMicrophone = false) {
    this._cancelRecovery();
    this._stopTransport();
    this.melody?.destroy();
    this.melody = null;
    this._melodyReady = false;
    const context=this.context,stream=this.stream;
    this.context=null;
    if (!keepMicrophone) this.stream=null;
    this._graphReady=false;this._audioReady=false;this._needsRebuild=false;
    if(context)context.onstatechange=null;
    if(this.captureNode)this.captureNode.port.onmessage=null;
    for(const name of ['input','analyser','captureNode','master']) {try{this[name]?.disconnect();}catch(_){}this[name]=null;}
    if (!keepMicrophone) stream?.getTracks().forEach(track=>track.stop());
    if(context && context.state!=='closed') {try { Promise.resolve(context.close()).catch(()=>{}); } catch (_) {}}
    return keepMicrophone ? stream : null;
  }
  _resumeTransport(fromStart=false) {
    if(!this.context || this.context.state!=='running' || !this.master || !this._audioReady || this._destroyed) {return;}
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
    this.melody?.stop();
    this._melodyStarted = false;
    this.laneBusyUntil.fill(0);
    for(const timer of this.hitTimers)clearTimeout(timer);this.hitTimers.clear();
    for(const source of this.sources){try{source.stop();}catch(_){}try{source.disconnect();}catch(_){}}this.sources.clear();
  }
  _prepareMelody(context) {
    let melody;
    const current = () => !this._destroyed && context === this.context && this.melody === melody;
    melody = new MelodyEngine(context, {
      onState: status => {
        if (current()) this.callbacks.onMelodyState?.(typeof status === 'string' ? {state:status} : status);
      },
      onNote: note => {
        if (!current() || this.state !== 'running') return;
        const absolute = (note.time - this.origin) / (60 / this.bpm / 4);
        const step = ((absolute % 32) + 32) % 32;
        this.callbacks.onMelodyNote?.({...note,step});
      },
    });
    this.melody = melody;
    this._melodyReady = false;
    this._melodyStarted = false;
    if (this._melodySeed === undefined) this._melodySeed = melody.seed;
    const ready = () => {
      if (!current()) return;
      this._melodyReady = true;
      this._maybeStartMelody();
    };
    // prepare() has its own native-key fallback for unavailable sample assets.
    // Its completion is checked against the instance, including after rebuild.
    Promise.resolve(melody.prepare()).then(ready, ready);
  }
  _melodyRoot() {
    const bass = this.samples[2].at(-1)?.classification?.features;
    // A short noisy thud has no dependable pitch. Only align the keyboard to a
    // sustained, strongly tonal low recording; the recording stays untouched.
    if (!bass || bass.lowRatio < 0.6 || bass.flatness > 0.02 || bass.spectralEntropy > 0.35 ||
        bass.activeDuration < 0.4 || bass.sustainRatio < 0.38 || bass.pitchSpreadCents > 40 ||
        bass.dominantHz < 45 || bass.dominantHz > 250) return undefined;
    const midi = Math.round(69 + 12*Math.log2(bass.dominantHz/440));
    return 48 + ((midi % 12) + 12) % 12;
  }
  _maybeStartMelody() {
    if (this.state !== 'running' || !this.context || !this.melody || !this._melodyReady || this._melodyStarted ||
        !this.samples.every(bank => bank.length > 0) || !Number.isFinite(this.origin)) return false;
    const barSeconds = 4 * 60 / this.bpm;
    // The sixth recording must have landed before accompaniment enters. Start
    // on a full bar boundary even when its placement flight crosses this bar.
    const latestPlacement = Math.max(...this.samples.flat().map(sample => sample.activeAt || 0));
    const earliest = Math.max(this.context.currentTime + 0.11, latestPlacement);
    const startTime = this.origin + Math.max(0,Math.ceil((earliest-this.origin)/barSeconds))*barSeconds;
    this._melodyStarted = true;
    this.melody.start(startTime,{bpm:this.bpm,seed:this._melodySeed,rootMidi:this._melodyRoot()});
    return true;
  }
  _acceptSample(data) {
    // The browser's captured PCM is the playback material, unchanged. Analysis
    // decides a rhythmic role only; it never writes into the recording.
    const pcm=data.pcm;
    const firstCapture = this.anchorSampleId === null;
    const classification = classifySample(pcm,data.sampleRate,this.samples.map(samples=>samples.length),firstCapture ? [] : [this.anchorLane]);
    const lane = classification.lane;
    // A recording must suit its role. Repeating one sound does not force it
    // into unrelated empty lanes just to complete the instrument.
    if (lane === null) return null;
    if (firstCapture) {
      this.origin = this.context.currentTime + PLACEMENT_SECONDS;
      this.absoluteStep = 0;
      this.nextStep = 0;
    }
    const origin=Number.isFinite(this.origin) ? this.origin : this.context.currentTime;
    const stepSeconds = 60 / this.bpm / 4;
    const sample={id:++this.serial,lane,isAnchor:firstCapture,role:classification.role,classification,peaks:waveformPeaks(pcm),steps:[],duration:pcm.length/data.sampleRate,strength:Math.min(1,data.peak*2.5),createdAt:performance.now(),placementMs:PLACEMENT_SECONDS*1000,activeAt:firstCapture ? origin : origin+Math.ceil((this.context.currentTime+PLACEMENT_SECONDS-origin)/stepSeconds)*stepSeconds,buffer:this.context.createBuffer(1,pcm.length,data.sampleRate)};
    if (firstCapture) { this.anchorLane = lane; this.anchorSampleId = sample.id; }
    sample.buffer.copyToChannel(pcm,0);
    const samples=this.samples[lane];
    const evicted=[];
    samples.push(sample);
    while(samples.length>3)evicted.push(samples.shift().id);
    evicted.push(...this._assignSteps(lane));
    if(evicted.length){sample.evictedId=evicted[0];sample.evictedIds=evicted;}
    this.callbacks.onCapture?.(sample);
    this._maybeStartMelody();
    return sample;
  }
  _assignSteps(lane) {
    const samples=this.samples[lane];
    if(!samples.length)return [];
    const anchor = samples.find(sample => sample.isAnchor);
    if (anchor) {
      const evicted = samples.filter(sample => sample !== anchor).map(sample => sample.id);
      samples.splice(0,samples.length,anchor);
      anchor.steps = [...FIRST_PULSE_STEPS];
      this.laneStepPools[lane] = [...FIRST_PULSE_STEPS];
      return evicted;
    }
    const longest=Math.max(...samples.map(sample=>sample.duration));
    // A lane may thin as longer sounds arrive, but only removes old onsets.
    // This also keeps tails already scheduled on the previous plan safe.
    const pool=this.laneStepPools[lane] || this.preset.lanes[lane];
    const steps=fitPatternSteps(pool,longest,this.preset.swing,this.bpm);
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
    this._maybeStartMelody();
    if (this._melodyStarted) this.melody.schedule(now+0.11);
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
    if(!sample.isAnchor && time < this.laneBusyUntil[lane] - 1e-6)return false;
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
    this.anchorLane=null;
    this.anchorSampleId=null;
    this.melody?.reset();
    this._melodySeed=this.melody?.seed;
    this.laneStepPools=Array(6).fill(null);
    this.preset=STARTER_GROOVE;
    this.captureNode?.port.postMessage({type:'reset',generation:this.generation});
    this.callbacks.onLevels?.({rms:0,peak:0,db:-120,threshold:-34,capturing:false,generation:this.generation});
    if(this.context?.state==='running' && this.stream)this._resumeTransport(true);
    else if(this.stream)this._setState('suspended');
    else this._setState('idle');
  }
  async destroy() {
    this._destroyed=true;
    this.generation++;
    this._releaseSession();
    document.removeEventListener('visibilitychange',this._onVisibility);
    this.samples=Array.from({length:6},()=>[]);
    this._setState('idle');
  }
}
