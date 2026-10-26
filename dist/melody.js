// This accompaniment is generated independently of the six raw microphone lanes.
// The licensed keyboard recordings, provenance and licenses live in ./samples/.
export const INSTRUMENTS = Object.freeze([
  {id:'grand-piano',name:'Grand Piano',kind:'sample',notes:[[48,'C3'],[60,'C4'],[72,'C5'],[84,'C6']],release:.48},
  {id:'fm-piano',name:'FM Piano',kind:'sample',notes:[[48,'C3'],[60,'C4'],[72,'C5'],[84,'C6']],release:.38},
  {id:'marimba',name:'Marimba',kind:'sample',notes:[[48,'C3'],[65,'F4'],[72,'C5'],[79,'G5']],release:.3},
  {id:'vibraphone',name:'Vibraphone',kind:'sample',notes:[[60,'C4'],[67,'G4'],[74,'D5'],[81,'A5']],release:.68},
  {id:'felt',name:'Felt Keys',kind:'synth',wave:'sine',attack:.018,release:.42,cutoff:1400},
  {id:'glass',name:'Glass Keys',kind:'synth',wave:'sine',attack:.004,release:.62,cutoff:6500,fm:[2.01,1.2,.25]},
  {id:'pluck',name:'Plucked Keys',kind:'synth',wave:'triangle',attack:.003,release:.18,cutoff:3200,decay:.13},
  {id:'warm',name:'Warm Electric',kind:'synth',wave:'sine',attack:.008,release:.38,cutoff:2800,fm:[1,.6,.18]},
  {id:'bell',name:'Bell Keys',kind:'synth',wave:'sine',attack:.003,release:.7,cutoff:7600,fm:[3.01,1.8,.3]},
  {id:'hollow',name:'Hollow Keys',kind:'synth',wave:'square',attack:.012,release:.3,cutoff:1100},
  {id:'air',name:'Air Keys',kind:'synth',wave:'triangle',attack:.055,release:.6,cutoff:1800,detune:5},
  {id:'analog',name:'Analog Keys',kind:'synth',wave:'sawtooth',attack:.012,release:.25,cutoff:1700,detune:4},
]);

export const SCALES = Object.freeze({
  minor:[0,2,3,5,7,8,10], major:[0,2,4,5,7,9,11],
  dorian:[0,2,3,5,7,9,10], mixolydian:[0,2,4,5,7,9,10],
});
const PATHS = [[0,5,3,4],[0,3,5,4],[0,6,5,6],[0,2,3,4],[5,3,0,4],[0,3,0,4],[0,5,2,4],[0,1,4,0]];
const RHYTHMS = [[0,.75,1.5,2.5,3.25],[0,1,1.5,2.5,3.5],[.5,1.5,2,3],[0,.5,1.5,2.5,3],[0,1.5,2.25,3.25],[0,.5,1,2,3.5],[0,1,2.5,3],[0,.75,1.75,2.5]];
const CONTOURS = [[0,2,1,4,2],[2,1,0,2,4],[0,1,2,4,3],[4,2,1,2,0],[0,2,4,3,2],[2,4,3,1,0],[0,-1,1,2,0],[4,3,2,0,1]];
const decodedBanks = new Map();
const bankLoads = new Map();
const clamp = (n,lo,hi) => Math.max(lo,Math.min(hi,n));
const mod = (n,m) => ((n%m)+m)%m;
export function randomFor(seed) {
  let a=seed>>>0;
  return () => {a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};
}
function newSeed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return (Date.now() ^ Math.floor(Math.random()*0xffffffff))>>>0;
}
function instrumentOrder(seed) {
  const random=randomFor(seed^0x1857ba);
  const first=Math.floor(random()*4);
  const rest=INSTRUMENTS.map((_,index)=>index).filter(index=>index!==first);
  for(let i=rest.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[rest[i],rest[j]]=[rest[j],rest[i]];}
  return [first,...rest];
}
function degreeMidi(root,scale,degree) {
  return root+scale[mod(degree,scale.length)]+12*Math.floor(degree/scale.length);
}
function nearestPitch(candidates,target) {
  return candidates.reduce((best,pitch)=>Math.abs(pitch-target)<Math.abs(best-target)?pitch:best,candidates[0]);
}

// Separate deterministic streams keep the motif recognizable while each new
// eight-bar phrase changes its response, articulation and keyboard color.
export function generatePhrase({seed=1,variant=0,rootMidi,mode}={}) {
  seed=seed>>>0;variant=Math.max(0,Math.floor(variant));
  const character=randomFor(seed), touch=randomFor(seed^variant^0xabc12);
  mode=Object.hasOwn(SCALES,mode)?mode:Object.keys(SCALES)[Math.floor(character()*4)];
  const scale=SCALES[mode];
  const pitchClass=Number.isFinite(rootMidi)?mod(Math.round(rootMidi),12):[0,2,3,5,7,9,10][Math.floor(character()*7)];
  const root=48+pitchClass;
  const path=PATHS[Math.floor(character()*PATHS.length)];
  const rhythmIndex=Math.floor(character()*RHYTHMS.length);
  const contour=CONTOURS[Math.floor(character()*CONTOURS.length)];
  const octave=character()<.24?12:0;
  const notes=[];
  let lastLead=root+12;
  let lastVoicing=[root,root+scale[2],root+7];
  const add=(midi,start,duration,velocity,part)=>notes.push({
    id:`${variant}-${part}-${notes.length}`,midi:Math.round(clamp(midi,45,88)),start,
    duration:Math.max(.12,Math.min(duration,32-start)),velocity:clamp(velocity,.25,.94),part,
  });
  for(let bar=0;bar<8;bar++) {
    // Keep the same four-chord journey; the second pass answers the first.
    let degree=path[bar%4];
    if(variant%4===3&&bar===6)degree=3;
    if(bar===7&&variant%2===1)degree=0;
    const chordPcs=[0,2,4].map(n=>mod(degreeMidi(root,scale,degree+n),12));
    const candidates=[];
    for(let inversion=0;inversion<3;inversion++){
      const pcs=[...chordPcs.slice(inversion),...chordPcs.slice(0,inversion)];
      const voiced=[pcs[0]+48];
      for(let i=1;i<3;i++){let pitch=pcs[i]+48;while(pitch<=voiced[i-1])pitch+=12;voiced.push(pitch);}
      const average=voiced.reduce((a,b)=>a+b)/3;
      const shift=Math.round((57-average)/12)*12;
      candidates.push(voiced.map(p=>p+shift));
    }
    candidates.sort((a,b)=>a.reduce((sum,p,i)=>sum+Math.abs(p-lastVoicing[i]),0)-b.reduce((sum,p,i)=>sum+Math.abs(p-lastVoicing[i]),0));
    lastVoicing=candidates[0];
    // Quiet, voice-led chords leave room for the room's recorded rhythm.
    lastVoicing.forEach((pitch,index)=>add(pitch,bar*4+index*.025,2.75+(bar%2)*.4,.38+touch()*.09,'chord'));
    const response=bar>=4;
    const rhythm=RHYTHMS[(rhythmIndex+(response?variant%3:0))%RHYTHMS.length];
    const material=contour.map((n,index)=>n+(response&&index===contour.length-1?(variant%3)-1:0));
    for(let index=0;index<rhythm.length;index++){
      if(response&&index===1&&(variant+bar)%3===0)continue;
      const local=rhythm[index];
      const target=degreeMidi(root+12+octave,scale,degree+material[index%material.length]);
      const isAnchor=index===0||local===2||index===rhythm.length-1;
      const options=(isAnchor?chordPcs:scale.map(pc=>mod(root+pc,12)))
        .flatMap(pc=>[48,60,72,84].map(base=>base+pc)).filter(p=>p>=root+7&&p<=Math.min(88,root+28+octave));
      const pitch=nearestPitch(options,target*.65+lastLead*.35);
      const next=rhythm[index+1]??4;
      let duration=(next-local)*(.62+touch()*.23);
      if(bar===7&&index===rhythm.length-1)duration=4-local;
      add(pitch,bar*4+local,duration,.68+(index===0?.12:0)+touch()*.1,'lead');
      lastLead=pitch;
    }
  }
  // Never retrigger the same keyboard pitch while its previous note is held.
  const byPitch=new Map();
  for(const note of notes){const key=`${note.part}:${note.midi}`;if(!byPitch.has(key))byPitch.set(key,[]);byPitch.get(key).push(note);}
  for(const lane of byPitch.values()){
    lane.sort((a,b)=>a.start-b.start);
    for(let i=0;i<lane.length-1;i++)lane[i].duration=Math.min(lane[i].duration,Math.max(.12,lane[i+1].start-lane[i].start-.04));
  }
  const order=instrumentOrder(seed);
  const instrument=INSTRUMENTS[order[variant%order.length]].id;
  return {notes:notes.sort((a,b)=>a.start-b.start||a.midi-b.midi),beats:32,rootMidi:root,mode,instrument,variant,seed};
}

async function loadBank(context,instrument) {
  if(decodedBanks.has(instrument.id))return decodedBanks.get(instrument.id);
  if(bankLoads.has(instrument.id))return bankLoads.get(instrument.id);
  const promise=(async()=>{
    const bank=[];
    // Two downloads/decodes at a time bound mobile memory while permission and
    // microphone collection continue independently on their own audio graph.
    for(let index=0;index<instrument.notes.length;index+=2){
      const pair=await Promise.allSettled(instrument.notes.slice(index,index+2).map(async([midi,note])=>{
        const controller=new AbortController();
        const deadline=setTimeout(()=>controller.abort(),7500);
        let decoded;
        try{
          const response=await fetch(new URL(`./samples/${instrument.id}/${note}.mp3`,import.meta.url),{signal:controller.signal});
          if(!response.ok)throw new Error(`Keyboard sample ${instrument.id}/${note} could not load`);
          decoded=await context.decodeAudioData(await response.arrayBuffer());
        }finally{clearTimeout(deadline);}
        const length=Math.min(decoded.length,Math.ceil(decoded.sampleRate*3.2));
        const buffer=context.createBuffer(decoded.numberOfChannels,length,decoded.sampleRate);
        let peak=.0001;
        for(let channel=0;channel<decoded.numberOfChannels;channel++){
          const pcm=decoded.getChannelData(channel).subarray(0,length);
          buffer.copyToChannel(pcm,channel);
          for(const value of pcm)peak=Math.max(peak,Math.abs(value));
        }
        return {midi,buffer,peak};
      }));
      const failure=pair.find(result=>result.status==='rejected');
      if(failure)throw failure.reason;
      bank.push(...pair.map(result=>result.value));
    }
    decodedBanks.set(instrument.id,bank);
    return bank;
  })();
  bankLoads.set(instrument.id,promise);
  try{return await promise;}finally{bankLoads.delete(instrument.id);}
}

export class MelodyEngine {
  constructor(context,{onNote,onState}={}) {
    this.context=context;this.callbacks={onNote,onState};
    this.output=context.createGain();this.output.gain.value=.2;this.output.connect(context.destination);
    this.seed=newSeed();this.bpm=110;this.playing=false;this.ready=false;this.destroyed=false;
    this.voices=new Set();this.timers=new Set();this.generation=0;this.currentPhrase=null;this._prepared=null;this._phrases=new Map();
  }
  _state(state,extra={}) {
    this.callbacks.onState?.({state,seed:this.seed,instrument:this.currentPhrase?.instrument,...extra});
  }
  prepare() {
    if(this.destroyed)return Promise.resolve(this);
    if(this._prepared)return this._prepared;
    this._state('loading');
    this._prepared=(async()=>{
      if(typeof this.context.decodeAudioData==='function'&&typeof fetch==='function'){
        // Bank order favors this session's first keyboard without blocking on
        // later colors. Failed assets fall back to native Web Audio keys.
        const first=instrumentOrder(this.seed)[0];
        const instruments=[INSTRUMENTS[first],...INSTRUMENTS.slice(0,4).filter(i=>i.id!==INSTRUMENTS[first].id)];
        const firstBank=loadBank(this.context,instruments[0]).catch(()=>{});
        // Only the first color gates readiness. Other colors arrive during the
        // first phrase; the native voice is always available if a bank fails.
        this._backgroundLoad=(async()=>{
          await firstBank;
          for(const instrument of instruments.slice(1)){if(this.destroyed)break;try{await loadBank(this.context,instrument);}catch(_){}}
        })();
        // iOS can leave decodeAudioData pending during an interruption. A fetch
        // abort cannot cancel that decode, so readiness has its own deadline.
        let deadline;
        const fallback=new Promise(resolve=>{
          this._releaseReady=resolve;deadline=setTimeout(resolve,2500);
        });
        try{await Promise.race([firstBank,fallback]);}
        finally{clearTimeout(deadline);this._releaseReady=null;}
      }
      if(!this.destroyed){this.ready=true;this._state('ready');}
      return this;
    })();
    return this._prepared;
  }
  start(startTime,{bpm=110,seed=this.seed,rootMidi}={}) {
    if(this.destroyed)return this;
    this.stop();this.seed=seed>>>0;this.bpm=Number.isFinite(bpm)?clamp(bpm,40,220):110;
    this.rootMidi=Number.isFinite(rootMidi)?rootMidi:undefined;
    this.origin=Math.max(this.context.currentTime,Number.isFinite(startTime)?startTime:this.context.currentTime);
    this.scheduledUntil=this.origin;this.currentPhrase=generatePhrase({seed:this.seed,rootMidi:this.rootMidi});
    this._phrases.clear();this._phrases.set(0,this.currentPhrase);
    this.playing=true;this.output.gain.cancelScheduledValues(this.context.currentTime);
    this.output.gain.setValueAtTime(.2,this.context.currentTime);
    this._state('playing',{startTime:this.origin});
    return this;
  }
  getPhrase() { return this.currentPhrase; }
  schedule(untilTime) {
    if(!this.playing||this.destroyed)return;
    const now=this.context.currentTime;
    const from=Math.max(this.scheduledUntil,now);
    const until=Math.max(from,untilTime);
    const secondsPerBeat=60/this.bpm, phraseLength=32*secondsPerBeat;
    const first=Math.max(0,Math.floor((from-this.origin)/phraseLength));
    const last=Math.max(first,Math.floor((until-this.origin)/phraseLength));
    for(let cycle=first;cycle<=last;cycle++){
      if(!this._phrases.has(cycle))this._phrases.set(cycle,generatePhrase({seed:this.seed,variant:cycle,rootMidi:this.rootMidi}));
      const phrase=this._phrases.get(cycle);
      if(this.currentPhrase?.variant!==cycle){this.currentPhrase=phrase;this._state('playing',{startTime:this.origin+cycle*phraseLength});}
      for(const note of phrase.notes){
        const time=this.origin+cycle*phraseLength+note.start*secondsPerBeat;
        if(time>=from-1e-7&&time<until-1e-7)this._play(note,time,note.duration*secondsPerBeat,phrase.instrument,cycle);
      }
    }
    for(const cycle of this._phrases.keys())if(cycle<first)this._phrases.delete(cycle);
    this.scheduledUntil=until;
  }
  _play(note,time,length,instrumentId,cycle) {
    if([...this.voices].filter(voice=>voice.start<=time&&voice.end>time).length>=10)return;
    const context=this.context;
    let instrument=INSTRUMENTS.find(item=>item.id===instrumentId)||INSTRUMENTS[4];
    const bank=decodedBanks.get(instrument.id);
    if(instrument.kind==='sample'&&!bank)instrument=INSTRUMENTS[7];
    // Soft support uses the same keyboard as the lead, with smaller velocities.
    const envelope=context.createGain(),nodes=[envelope],sources=[];
    envelope.connect(this.output);
    const release=instrument.release;
    const end=time+Math.max(.04,length)+release;
    const attack=instrument.kind==='sample'?.004:instrument.attack;
    let normalization=1;
    if(instrument.kind==='sample'){
      const nearest=bank.reduce((a,b)=>Math.abs(b.midi-note.midi)<Math.abs(a.midi-note.midi)?b:a);
      const source=context.createBufferSource();source.buffer=nearest.buffer;
      source.playbackRate.value=2**((note.midi-nearest.midi)/12);source.connect(envelope);sources.push(source);
      normalization=1/Math.max(.0001,nearest.peak);
    }else{
      const filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=instrument.cutoff;filter.Q.value=.4;
      filter.connect(envelope);nodes.push(filter);
      const frequency=440*2**((note.midi-69)/12);
      const oscillator=context.createOscillator();oscillator.type=instrument.wave;oscillator.frequency.value=frequency;
      const count=instrument.detune?2:1;
      const balance=context.createGain();balance.gain.value=1/count;balance.connect(filter);nodes.push(balance);
      oscillator.connect(balance);sources.push(oscillator);
      if(instrument.detune){
        oscillator.detune.value=-instrument.detune;
        const other=context.createOscillator();other.type=instrument.wave;other.frequency.value=frequency;other.detune.value=instrument.detune;other.connect(balance);sources.push(other);
      }
      if(instrument.fm){
        const modulator=context.createOscillator(),depth=context.createGain();
        modulator.frequency.value=frequency*instrument.fm[0];depth.gain.setValueAtTime(frequency*instrument.fm[1],time);
        depth.gain.exponentialRampToValueAtTime(.001,time+instrument.fm[2]);modulator.connect(depth);depth.connect(oscillator.frequency);
        sources.push(modulator);nodes.push(depth);
      }
    }
    // Each voice's source is peak-normalized and limited to .1; ten voices and
    // the fixed .2 bus keep this separate accompaniment below .2 peak headroom.
    const level=.1*note.velocity*normalization;
    envelope.gain.setValueAtTime(0,time);envelope.gain.linearRampToValueAtTime(level,time+Math.min(attack,length*.3));
    if(instrument.decay)envelope.gain.setTargetAtTime(level*.28,time+attack,instrument.decay);
    envelope.gain.setTargetAtTime(.00001,time+length,Math.max(.015,release/5));
    envelope.gain.setValueAtTime(0,end);
    const voice={start:time,end,sources,nodes,cleaned:false};
    const clean=()=>{if(voice.cleaned)return;voice.cleaned=true;this.voices.delete(voice);for(const node of [...sources,...nodes])try{node.disconnect();}catch(_){}};
    voice.clean=clean;sources[0].onended=clean;this.voices.add(voice);
    for(const source of sources){source.start(time);source.stop(end+.01);}
    const generation=this.generation;
    const delay=Math.max(0,(time-context.currentTime+(context.outputLatency||context.baseLatency||0))*1000);
    const timer=setTimeout(()=>{
      this.timers.delete(timer);
      if(!this.playing||this.destroyed||generation!==this.generation)return;
      this.callbacks.onNote?.({id:`${generation}-${cycle}-${note.id}`,midi:note.midi,time,duration:length,velocity:note.velocity,instrument:instrument.id,part:note.part,delayMs:0});
    },delay);
    this.timers.add(timer);
  }
  stop() {
    this.playing=false;this.generation++;
    for(const timer of this.timers)clearTimeout(timer);this.timers.clear();
    for(const voice of this.voices){for(const source of voice.sources)try{source.stop();}catch(_){}voice.clean();}
    this.voices.clear();this._state('stopped');
  }
  reset(seed=newSeed()) {
    this.stop();this.seed=seed>>>0;this.currentPhrase=null;this.rootMidi=undefined;this._phrases.clear();
    this._state(this.ready?'ready':'loading');return this;
  }
  destroy() {
    if(this.destroyed)return;this.stop();this.destroyed=true;this.output.disconnect();
    this._releaseReady?.();
    this.callbacks={};
  }
}
