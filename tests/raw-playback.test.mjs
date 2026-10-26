import test from 'node:test';
import assert from 'node:assert/strict';
import { BeatEngine, GROOVE_PRESETS, fitPatternSteps } from '../dist/engine.js';
import { BPM, BEAT_SECONDS, STEP_SECONDS, LOOP_SECONDS, ROLE_NAMES, sound } from './audio-fixtures.mjs';

function makeContext() {
  const sources=[];
  const gains=[];
  function parameter(value) {
    return {
      value, events:[],
      setValueAtTime(next,time){this.events.push({kind:'set',value:next,time});this.value=next;},
      linearRampToValueAtTime(next,time){this.events.push({kind:'linear',value:next,time});this.value=next;},
      exponentialRampToValueAtTime(){throw new Error('Raw sample playback must not apply a decay envelope');}
    };
  }
  return {
    currentTime:1.9,state:'running',sources,gains,
    createBuffer(channels,length,sampleRate) {
      assert.equal(channels,1);
      const pcm=new Float32Array(length);
      return {length,sampleRate,duration:length/sampleRate,
        copyToChannel(input,channel){assert.equal(channel,0);pcm.set(input);},
        getChannelData(channel){assert.equal(channel,0);return pcm;}
      };
    },
    createBufferSource() {
      const source={buffer:null,loop:false,playbackRate:parameter(1),detune:parameter(0),starts:[],stops:[],connections:[],
        connect(node){this.connections.push(node);},disconnect(){},addEventListener(){},
        start(...args){this.starts.push(args);},stop(...args){this.stops.push(args);}
      };
      sources.push(source);return source;
    },
    createGain() {
      const gain={gain:parameter(1),connections:[],connect(node){this.connections.push(node);},disconnect(){}};
      gains.push(gain);return gain;
    },
    createBiquadFilter(){throw new Error('Raw sample playback must not create a filter');},
    createDynamicsCompressor(){throw new Error('Raw sample playback must not create a compressor');},
    createWaveShaper(){throw new Error('Raw sample playback must not distort recordings');},
    createOscillator(){throw new Error('Raw sample playback must not substitute a synthesizer');}
  };
}

test('all six roles retain the entire captured PCM without normalization, trimming or resynthesis',()=>{
  const rate=48000;
  for(let targetLane=0;targetLane<6;targetLane++){
    const input=sound(ROLE_NAMES[targetLane],rate,1.25);
    const original=input.slice();
    let accepted;
    const engine=new BeatEngine({onCapture:sample=>accepted=sample});
    engine.context=makeContext();engine.origin=0;
    engine._acceptSample({pcm:input,sampleRate:rate,peak:.5});
    assert.equal(accepted.lane,targetLane);
    assert.equal(accepted.duration,input.length/rate);
    assert.equal(accepted.buffer.duration,input.length/rate);
    assert.equal(accepted.buffer.sampleRate,rate);
    assert.deepEqual(accepted.buffer.getChannelData(0),original,`lane ${targetLane} preserves every captured sample`);
    assert.equal(accepted.grain,undefined,'roles must not receive tiny looped grains');
    assert.ok(accepted.steps.length>0);
    assert.ok(Number.isFinite(accepted.activeAt));
    assert.deepEqual(input,original,'captured PCM is not mutated in place');
  }
});

test('every role plays one complete recording at original pitch and speed with only click fades',()=>{
  for(let lane=0;lane<6;lane++){
    const engine=new BeatEngine();
    const context=makeContext();engine.context=context;engine.master={};engine.state='running';
    const buffer=context.createBuffer(1,72000,48000);
    buffer.copyToChannel(Float32Array.from({length:72000},(_,i)=>.3*Math.sin(i*.1)),0);
    const sample={id:lane+1,lane,buffer,duration:1.5,steps:[0]};
    try {
      engine._play(sample,2,.2,0,3);
      assert.equal(context.sources.length,1,'no layered attack or replacement voice');
      const source=context.sources[0];
      assert.equal(source.buffer,buffer,'the recorded buffer itself is the playback source');
      assert.equal(source.loop,false);
      assert.equal(source.playbackRate.value,1);
      assert.equal(source.detune.value,0);
      assert.ok(source.playbackRate.events.every(event=>event.value===1));
      assert.ok(source.detune.events.every(event=>event.value===0));
      assert.deepEqual(source.starts,[[2]],'no offset or shortened start duration');
      assert.ok(source.stops.every(([time])=>time>=2+buffer.duration),'the tail must not be truncated');
      assert.equal(context.gains.length,1,'one click-fade envelope only');
      const gain=context.gains[0];
      assert.equal(source.connections[0],gain);
      assert.equal(gain.connections[0],engine.master,'there is no intervening timbre-processing graph');
      const events=gain.gain.events;
      assert.ok(events.length>=4);
      assert.ok(events.every(event=>event.value===0||event.value===1),'no role-specific levels or decaying envelope');
      assert.ok(events.some(event=>event.value===1&&event.time<=2.004));
      assert.ok(events.some(event=>event.value===1&&event.time>=3.496),'full sustain remains until the final click fade');
      assert.ok(events.every(event=>event.time<=2.004||event.time>=3.496),'only the edges may alter the recording envelope');
    } finally {engine._stopTransport();}
  }
});

const onset=(step,swing,bpm=BPM)=>step*(60/bpm/4)+(step%2?(60/bpm/4)*swing:0);
function verifyCyclicFit(steps,duration,swing,bpm=BPM) {
  const sorted=[...steps].sort((a,b)=>a-b);
  assert.ok(sorted.length>0);
  assert.equal(new Set(sorted).size,sorted.length);
  for(let i=0;i<sorted.length;i++){
    const current=onset(sorted[i],swing,bpm);
    const next=onset(sorted[(i+1)%sorted.length],swing,bpm)+(i===sorted.length-1?32*(60/bpm/4):0);
    assert.ok(next-current+1e-9>=duration+.003,`clip ${duration}s must fit ${current} → ${next}, including wraparound`);
  }
}

test('long recordings fit original groove onsets without overlapping across the loop boundary',()=>{
  for(const preset of GROOVE_PRESETS){
    for(const pattern of preset.lanes){
      for(const duration of [.8,.9,1.2,1.55,1.8])for(const bpm of [90,110,140]){
        const steps=fitPatternSteps(pattern,duration,preset.swing,bpm);
        assert.ok(steps.every(step=>pattern.includes(step)),'roles retain positions from their rhythm preset');
        verifyCyclicFit(steps,duration,preset.swing,bpm);
        assert.deepEqual(fitPatternSteps(pattern,duration,preset.swing,bpm),steps,'spacing choices are deterministic');
      }
    }
  }
});

test('different-length supporting recordings keep nonempty, unique, fully playable lane assignments',()=>{
  for(const preset of GROOVE_PRESETS){
    for(let lane=0;lane<6;lane++){
      const engine=new BeatEngine();engine.preset=preset;
      engine.samples[lane]=[.8,1.2,1.8].map((duration,i)=>({id:i+1,duration,steps:[]}));
      engine._assignSteps(lane);
      const bank=engine.samples[lane];
      assert.ok(bank.length>0&&bank.length<=3);
      assert.ok(bank.every(sample=>sample.steps.length>0),'no invisible or inaudible bank entry');
      const hits=bank.flatMap(sample=>sample.steps.map(step=>({step,duration:sample.duration}))).sort((a,b)=>a.step-b.step);
      assert.equal(new Set(hits.map(hit=>hit.step)).size,hits.length);
      assert.ok(hits.every(hit=>preset.lanes[lane].includes(hit.step)));
      for(let i=0;i<hits.length;i++){
        const current=onset(hits[i].step,preset.swing);
        const next=onset(hits[(i+1)%hits.length].step,preset.swing)+(i===hits.length-1?LOOP_SECONDS:0);
        assert.ok(next-current+1e-9>=hits[i].duration+.003,'samples play to completion at their original speed');
      }
    }
  }
});

const QUARTER_STEPS=[0,4,8,12,16,20,24,28];
test('the very first recording anchors every quarter note regardless of its timbre or length',()=>{
  const rate=48000;
  for(const [lane,role] of ROLE_NAMES.entries()){
    const pcm=sound(role,rate,[.8,1.8,1.2][lane%3]);
    const engine=new BeatEngine();
    engine.context=makeContext();engine.origin=-17;
    const capturedAt=engine.context.currentTime;
    engine._acceptSample({pcm,sampleRate:rate,peak:.5});
    const first=engine.samples[lane][0];
    assert.ok(first,'the first sound belongs to its acoustically compatible role');
    assert.equal(first.isAnchor,true,'anchor identity belongs to the recording, not a fixed instrument lane');
    assert.equal(engine.anchorLane,lane);
    assert.deepEqual(first.steps,QUARTER_STEPS,'long samples must not thin the initial four-on-the-floor rhythm');
    assert.equal(first.duration,pcm.length/rate);
    assert.deepEqual(first.buffer.getChannelData(0),pcm,'the pulse still uses the complete unprocessed recording');
    assert.ok(first.activeAt>=capturedAt+.28&&first.activeAt<=capturedAt+.4,'the first pulse follows placement immediately instead of waiting for the existing bar');
    assert.ok(Math.abs(engine.origin-first.activeAt)<1e-9,'the first sound establishes beat one');
    assert.equal(engine.absoluteStep,0);
    assert.ok(engine.samples.every((bank,index)=>index===lane||bank.length===0));
  }
});

test('the first long recording retriggers every quarter beat at 110 BPM through two loop seams without truncation',()=>{
  const engine=new BeatEngine();
  const context=makeContext();context.currentTime=10;
  engine.context=context;engine.master={};engine.state='running';engine.origin=0;
  const pcm=sound('clap',48000,1.8);
  engine._acceptSample({pcm,sampleRate:48000,peak:.2});
  const first=engine.samples.flat().find(sample=>sample.isAnchor);
  assert.equal(first.lane,1,'this overlap regression must also cover an anchor outside lane zero');
  try {
    const end=first.activeAt+LOOP_SECONDS*2+.05;
    for(let time=10;time<end;time+=.025){context.currentTime=time;engine._schedule();}
    const sources=context.sources;
    assert.ok(sources.length>=17,'two complete loops retain all quarter-note onsets');
    for(let i=0;i<17;i++){
      assert.ok(Math.abs(sources[i].starts[0][0]-(first.activeAt+i*BEAT_SECONDS))<1e-8,`quarter-note onset ${i} must remain on the clock`);
      assert.ok(Math.abs(sources[i].stops[0][0]-sources[i].starts[0][0]-1.8)<1e-8,'each overlapping copy plays its full 1.8 seconds');
      assert.equal(sources[i].buffer,first.buffer);
      assert.equal(sources[i].playbackRate.value,1);
      assert.equal(sources[i].loop,false);
    }
    const maximumOverlap=Math.max(...sources.map(source=>{
      const time=source.starts[0][0]+.0001;
      return sources.filter(other=>other.starts[0][0]<=time&&other.stops[0][0]>time).length;
    }));
    assert.equal(maximumOverlap,4,'1.8-second pulse recordings overlap at most four times at 110 BPM');
  } finally {engine._stopTransport();}
});

test('later sounds cannot replace the initial quarter-note anchor, while reset allows a new first sound',()=>{
  const engine=new BeatEngine();
  engine.context=makeContext();engine.origin=0;
  const firstPCM=sound('clap',48000,1);
  engine._acceptSample({pcm:firstPCM,sampleRate:48000,peak:.2});
  const anchor=engine.samples.flat().find(sample=>sample.isAnchor);
  for(let i=0;i<18;i++){
    const pcm=sound(ROLE_NAMES[i%ROLE_NAMES.length]);
    engine._acceptSample({pcm,sampleRate:48000,peak:.25});
  }
  assert.equal(engine.samples[anchor.lane].length,1);
  assert.equal(engine.samples[anchor.lane][0],anchor,'the first voice remains the recognizable clock for the visit');
  assert.deepEqual(anchor.steps,QUARTER_STEPS);
  assert.deepEqual(anchor.buffer.getChannelData(0),firstPCM);
  assert.ok(engine.samples.every(bank=>bank.length>0),'acoustically distinct later recordings can fill all supporting roles');
  engine.context.state='suspended';
  engine.reset();
  const newPCM=sound('bass',48000,.8);
  engine._acceptSample({pcm:newPCM,sampleRate:48000,peak:.17});
  const replacement=engine.samples.flat().find(sample=>sample.isAnchor);
  assert.equal(replacement.lane,2,'reset allows the next anchor to use a different compatible role');
  assert.notEqual(replacement,anchor);
  assert.deepEqual(replacement.steps,QUARTER_STEPS);
  assert.deepEqual(replacement.buffer.getChannelData(0),newPCM);
});

test('six repeated captures fill every row without changing source PCM or the original pulse',()=>{
  for(const kind of ['phone-clap','desk-thud','percussion']) {
    const engine=new BeatEngine();
    engine.context=makeContext();
    const pcm=sound(kind);
    engine._acceptSample({pcm,sampleRate:48000,peak:.5});
    const anchor=engine.samples.flat().find(sample=>sample.isAnchor);
    for(let index=1;index<6;index++) {
      engine._acceptSample({pcm,sampleRate:48000,peak:.5});
      assert.equal(engine.samples.filter(bank=>bank.length).length,index+1,'each completed capture fills one empty row');
    }
    assert.ok(engine.samples.every(bank=>bank.length===1));
    assert.equal(engine.samples[anchor.lane][0],anchor);
    assert.deepEqual(anchor.steps,QUARTER_STEPS);
    assert.ok(engine.samples.flat().some(sample=>sample.classification.assignment==='fill'));
    for(const sample of engine.samples.flat()) {
      assert.deepEqual(sample.buffer.getChannelData(0),pcm,'fallback assignment uses the complete original microphone recording');
      assert.equal(sample.duration,pcm.length/48000);
      assert.ok(sample.steps.length>0,'every row owns audible onsets');
    }
  }
});

test('repeating an anchor-only timbre continues placement instead of silently discarding captures',()=>{
  const captured=[];
  const engine=new BeatEngine({onCapture:sample=>captured.push(sample)});
  engine.context=makeContext();
  const pcm=sound('percussion');
  engine._acceptSample({pcm,sampleRate:48000,peak:.5});
  for(let index=1;index<6;index++)assert.ok(engine._acceptSample({pcm,sampleRate:48000,peak:.5}));
  assert.equal(captured.length,6,'every completed capture produces a visible placement event');
  assert.equal(engine.samples.flat().length,6);
  assert.equal(engine.samples[5][0],captured[0]);
  assert.deepEqual(captured[0].steps,QUARTER_STEPS);
});

test('a better acoustic match replaces fallback recordings while preserving the anchor',()=>{
  const engine=new BeatEngine();
  engine.context=makeContext();
  const clap=sound('phone-clap');
  for(let index=0;index<6;index++)engine._acceptSample({pcm:clap,sampleRate:48000,peak:.5});
  const anchor=engine.samples[1][0];
  const fallbackKick=engine.samples[0][0];
  assert.equal(fallbackKick.classification.assignment,'fill');
  const desk=sound('desk-thud');
  const matched=engine._acceptSample({pcm:desk,sampleRate:48000,peak:.5});
  assert.equal(matched.lane,0,'a low impact improves the kick role once the instrument is complete');
  assert.equal(matched.classification.assignment,'matched');
  assert.deepEqual(engine.samples[0],[matched],'the better match removes the provisional recording from the lane');
  assert.ok(matched.evictedIds.includes(fallbackKick.id),'the visualization can discard the provisional recording');
  assert.deepEqual(matched.buffer.getChannelData(0),desk);
  assert.equal(engine.samples[1][0],anchor);
  assert.deepEqual(anchor.buffer.getChannelData(0),clap);
  assert.deepEqual(anchor.steps,QUARTER_STEPS);
  assert.ok(engine.samples.every(bank=>bank.length>0));
});
