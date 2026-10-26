import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MelodyEngine,generatePhrase,INSTRUMENTS,SCALES} from '../dist/melody.js';

function contextFixture({decode=false}={}) {
  const context={currentTime:0,outputLatency:.04,destination:{},gains:[],sources:[],buffers:[],decodes:0,maxDecodes:0};
  const parameter=(value=0)=>({value,events:[],
    setValueAtTime(value,time){this.value=value;this.events.push({type:'set',value,time});},
    linearRampToValueAtTime(value,time){this.value=value;this.events.push({type:'linear',value,time});},
    exponentialRampToValueAtTime(value,time){this.value=value;this.events.push({type:'exponential',value,time});},
    setTargetAtTime(value,time,constant){this.events.push({type:'target',value,time,constant});},
    cancelScheduledValues(time){this.events.push({type:'cancel',time});},
  });
  const node=(extra={})=>({connections:[],disconnected:false,
    connect(destination){this.connections.push(destination);},disconnect(){this.disconnected=true;},...extra});
  const source=kind=>{
    const result=node({kind,frequency:parameter(),detune:parameter(),playbackRate:parameter(1),starts:[],stops:[],
      start(time){this.starts.push(time);},stop(time){this.stops.push(time);}});
    context.sources.push(result);return result;
  };
  context.createGain=()=>{const result=node({gain:parameter(1)});context.gains.push(result);return result;};
  context.createOscillator=()=>source('oscillator');
  context.createBufferSource=()=>source('sample');
  context.createBiquadFilter=()=>node({frequency:parameter(),Q:parameter()});
  context.createBuffer=(channels,length,sampleRate)=>{
    const data=Array.from({length:channels},()=>new Float32Array(length));
    const result={numberOfChannels:channels,length,sampleRate,duration:length/sampleRate,
      copyToChannel(pcm,channel){data[channel].set(pcm);},getChannelData(channel){return data[channel];}};
    context.buffers.push(result);return result;
  };
  if(decode)context.decodeAudioData=async()=>{
    context.decodes++;context.maxDecodes=Math.max(context.maxDecodes,context.decodes);
    await new Promise(resolve=>setImmediate(resolve));
    context.decodes--;
    return {length:500,sampleRate:100,numberOfChannels:2,getChannelData:()=>new Float32Array(500).fill(.5)};
  };
  return context;
}

function timerFixture(t) {
  const pending=new Map();let id=0;
  t.mock.method(globalThis,'setTimeout',(callback,delay)=>{const key=++id;pending.set(key,{callback,delay});return key;});
  t.mock.method(globalThis,'clearTimeout',key=>pending.delete(key));
  return pending;
}

test('eight-bar phrases are deterministic, harmonically consistent and bounded across seeds and variations',()=>{
  for(let seed=0;seed<80;seed++){
    const opening=generatePhrase({seed});
    assert.deepEqual(opening,generatePhrase({seed}));
    for(let variant=0;variant<12;variant++){
      const phrase=generatePhrase({seed,variant});
      assert.equal(phrase.beats,32);
      assert.equal(phrase.rootMidi,opening.rootMidi,'key stays stable when the instrument changes');
      assert.equal(phrase.mode,opening.mode);
      assert.equal(phrase.notes.filter(n=>n.part==='chord').length,24);
      assert.ok(phrase.notes.filter(n=>n.part==='lead').length>=24);
      const ids=new Set();
      for(const note of phrase.notes){
        assert.ok(!ids.has(note.id));ids.add(note.id);
        assert.ok(note.start>=0&&note.start<32);
        assert.ok(note.duration>0&&note.start+note.duration<=32.00001);
        assert.ok(note.velocity>0&&note.velocity<=1);
        assert.ok(SCALES[phrase.mode].includes(((note.midi-phrase.rootMidi)%12+12)%12),`${note.midi} belongs to ${phrase.mode}`);
      }
      for(let bar=0;bar<8;bar++){
        const leads=phrase.notes.filter(n=>n.part==='lead'&&Math.floor(n.start/4)===bar);
        assert.ok(leads.length>=3&&leads.length<=5,'space for the recorded percussion');
      }
    }
  }
});

test('each session opens with a sampled keyboard and explores all twelve colors without repeating one',()=>{
  const melodies=new Set();
  for(let seed=0;seed<30;seed++){
    const variants=Array.from({length:12},(_,variant)=>generatePhrase({seed,variant}));
    assert.equal(INSTRUMENTS.find(i=>i.id===variants[0].instrument).kind,'sample');
    assert.equal(new Set(variants.map(p=>p.instrument)).size,12);
    assert.notDeepEqual(variants[0].notes,variants[1].notes);
    melodies.add(JSON.stringify(variants[0].notes.map(({midi,start})=>[midi,start])));
  }
  assert.ok(melodies.size>=25,'seeds offer distinct motifs and progressions');
  const phrase=generatePhrase({seed:12,rootMidi:69});
  assert.equal(phrase.rootMidi%12,9,'a confidently detected tonal bass can anchor the accompaniment key');
});

test('the shared lookahead clock schedules each note once at 110 BPM and changes color on an eight-bar boundary',()=>{
  const context=contextFixture(),states=[],played=[];
  const engine=new MelodyEngine(context,{onState:event=>states.push(event)});
  engine._play=(note,time,duration,instrument,cycle)=>played.push({note,time,duration,instrument,cycle});
  engine.start(2,{bpm:110,seed:14});
  engine.schedule(1.8);assert.equal(played.length,0);
  const beat=60/110,first=generatePhrase({seed:14});
  for(let until=2.01;until<2+32*beat;until+=.075){engine.schedule(until);engine.schedule(until);}
  engine.schedule(2+32*beat+.1);
  const firstNotes=played.filter(n=>n.cycle===0);
  assert.equal(firstNotes.length,first.notes.length);
  assert.equal(new Set(firstNotes.map(n=>n.note.id)).size,first.notes.length);
  for(const event of firstNotes){
    assert.ok(Math.abs(event.time-(2+event.note.start*beat))<1e-9);
    assert.ok(Math.abs(event.duration-event.note.duration*beat)<1e-9);
  }
  assert.equal(engine.getPhrase().variant,1);
  assert.notEqual(engine.getPhrase().instrument,first.instrument);
  assert.ok(states.some(state=>state.state==='playing'&&Math.abs(state.startTime-(2+32*beat))<1e-9));
  context.currentTime=25;
  const oldCount=played.length;engine.schedule(25.1);
  assert.ok(played.slice(oldCount).every(n=>n.time>=25),'background stalls do not burst stale notes');
  engine.destroy();
});

test('native fallback is ready without a decoder and callbacks occur at audible onset with bounded polyphony',async t=>{
  const timers=timerFixture(t),context=contextFixture(),events=[];
  const engine=new MelodyEngine(context,{onNote:event=>events.push(event)});
  await engine.prepare();assert.equal(engine.ready,true);
  engine.start(1,{seed:3});
  for(let index=0;index<15;index++)engine._play({id:index,midi:60+index,velocity:.9,part:'lead'},1,.5,'grand-piano',0);
  assert.equal(engine.voices.size,10);
  assert.equal(engine.output.gain.value,.2);
  assert.equal(events.length,0);
  assert.equal(timers.size,10);
  for(const timer of timers.values()){
    assert.equal(timer.delay,1040);
    timer.callback();
  }
  assert.equal(events.length,10);
  assert.ok(events.every(event=>event.instrument==='warm'&&event.delayMs===0&&event.time===1&&event.duration===.5));
  assert.ok(context.sources.every(source=>source.kind==='oscillator'));
  const envelopes=context.gains.filter(gain=>gain.connections[0]===engine.output);
  assert.ok(envelopes.every(gain=>gain.gain.events.filter(event=>event.type==='linear').every(event=>event.value<=.1)));
  engine.destroy();
});

test('stop/reset/destroy cancel queued visuals and audio voices and reset selects a fresh phrase',async t=>{
  const timers=timerFixture(t),context=contextFixture(),events=[];
  const engine=new MelodyEngine(context,{onNote:event=>events.push(event)});
  await engine.prepare();engine.start(1,{seed:24});engine.schedule(1.15);
  const stale=[...timers.values()].map(timer=>timer.callback);
  assert.ok(engine.voices.size>0);
  engine.reset(125);
  assert.equal(engine.voices.size,0);assert.equal(timers.size,0);assert.equal(engine.playing,false);
  assert.equal(engine.getPhrase(),null);assert.equal(engine.ready,true);assert.equal(engine.seed,125);
  assert.ok(context.sources.every(source=>source.stops.includes(undefined)&&source.disconnected));
  for(const callback of stale)callback();assert.equal(events.length,0,'old callbacks cannot leak into the new collection');
  engine.start(2);assert.equal(engine.getPhrase().seed,125);engine.schedule(2.1);
  engine.destroy();assert.equal(timers.size,0);assert.equal(engine.output.disconnected,true);
  engine.start(3);engine.schedule(4);assert.equal(engine.playing,false);
});

test('missing sample assets resolve to native keys instead of blocking melody completion',async t=>{
  const {MelodyEngine:FreshEngine}=await import('../dist/melody.js?failed-assets');
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{requests.push(String(url));throw new Error('offline');});
  const context=contextFixture({decode:true}),engine=new FreshEngine(context);
  await engine.prepare();await engine._backgroundLoad;
  assert.equal(engine.ready,true);assert.equal(requests.length,8,'failed banks stop after their first two files');
  engine.start(0,{seed:5});engine.schedule(.1);
  assert.ok(context.sources.some(source=>source.kind==='oscillator'));
  assert.equal(context.sources.filter(source=>source.kind==='sample').length,0);
  engine.destroy();
});

test('self-hosted sample loading limits decode concurrency and memory, then uses recorded keyboard sources',async t=>{
  const {MelodyEngine:FreshEngine}=await import('../dist/melody.js?loaded-assets');
  const requests=[];
  t.mock.method(globalThis,'fetch',async url=>{
    requests.push(String(url));return {ok:true,arrayBuffer:async()=>new ArrayBuffer(16)};
  });
  const context=contextFixture({decode:true}),engine=new FreshEngine(context);
  await engine.prepare();assert.equal(engine.ready,true);await engine._backgroundLoad;
  assert.equal(requests.length,16);
  assert.ok(requests.every(url=>url.includes('/dist/samples/')&&url.endsWith('.mp3')));
  assert.ok(context.maxDecodes<=2);
  assert.equal(context.buffers.length,16);
  assert.ok(context.buffers.every(buffer=>buffer.duration===3.2&&buffer.numberOfChannels===2));
  engine.start(0,{seed:5});engine.schedule(.1);
  assert.ok(context.sources.some(source=>source.kind==='sample'));
  assert.equal(context.sources.filter(source=>source.kind==='oscillator').length,0);
  assert.ok(context.sources.every(source=>source.buffer.duration===3.2&&source.playbackRate.value>0));
  engine.destroy();
});

test('a pending iOS decoder cannot hold readiness indefinitely or emit state after destruction',async t=>{
  const {MelodyEngine:FreshEngine}=await import('../dist/melody.js?pending-decoder');
  const timers=timerFixture(t),states=[];
  t.mock.method(globalThis,'fetch',async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(16)}));
  const context=contextFixture({decode:true});
  context.decodeAudioData=()=>new Promise(()=>{});
  const engine=new FreshEngine(context,{onState:state=>states.push(state)});
  const preparing=engine.prepare();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(engine.ready,false);
  const fallback=[...timers.values()].find(timer=>timer.delay===2500);
  assert.ok(fallback,'readiness is bounded independently of network/decode progress');
  fallback.callback();await preparing;
  assert.equal(engine.ready,true);
  engine.start(0,{seed:5});engine.schedule(.1);
  assert.ok(context.sources.some(source=>source.kind==='oscillator'));
  engine.destroy();

  const second=new FreshEngine(context,{onState:state=>states.push(state)});
  const pending=second.prepare();second.destroy();const count=states.length;
  await pending;
  assert.equal(states.length,count,'a destroyed loader cannot publish a late ready state');
  assert.equal(second.ready,false);
});

test('all sixteen bundled recordings match their credited source checksums and include license texts',async()=>{
  const base=new URL('../dist/samples/',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('SOURCES.json',base),'utf8'));
  assert.equal(manifest.files.length,16);
  let bytes=0;
  for(const file of manifest.files){
    const recording=await readFile(new URL(file.file,base));bytes+=recording.length;
    assert.equal(recording.length,file.bytes);
    assert.equal(createHash('sha256').update(recording).digest('hex'),file.sha256);
    assert.ok(file.originalUrl.startsWith('https://raw.githubusercontent.com/'));
  }
  assert.ok(bytes<2_600_000);
  const licenses=await readdir(new URL('licenses/',base));
  assert.ok(licenses.length>=2);
  const credits=await readFile(new URL('CREDITS.md',base),'utf8');
  assert.match(credits,/Alexander Holm/);assert.match(credits,/Versilian/);assert.match(credits,/CC BY 3.0/);assert.match(credits,/CC0 1.0/);
});
